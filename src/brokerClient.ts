import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import * as http from 'node:http';
import type * as vscode from 'vscode';
import type { AgentSnapshot, BrokerSnapshot } from './types.js';

const REQUEST_TIMEOUT_MS = 5_000;
const RECONNECT_MAX_MS = 30_000;

interface BrokerLaunchOptions {
  brokerPath: string;
  pythonPath: string;
  tokenPath: string;
  env: NodeJS.ProcessEnv;
}

export class BrokerClient extends EventEmitter {
  private snapshot: BrokerSnapshot = { instanceId: '', revision: 0, generatedAt: 0, agents: [] };
  private request?: http.ClientRequest;
  private stopped = false;
  private reconnectMs = 1_000;
  private reconnectTimer?: NodeJS.Timeout;
  private connected = false;
  private lastSpawnAt = 0;

  constructor(
    private readonly port: number,
    private readonly channel: vscode.OutputChannel,
    private readonly launch: BrokerLaunchOptions,
  ) {
    super();
  }

  start(): void {
    this.stopped = false;
    void this.refresh().then(async (ready) => {
      if (!ready && this.ensureBroker()) {
        await delay(600);
        await this.refresh();
      }
    }).finally(() => this.connect());
  }

  stop(): void {
    this.stopped = true;
    this.request?.destroy();
    this.request = undefined;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.setConnected(false);
  }

  getSnapshot(): BrokerSnapshot {
    return {
      instanceId: this.snapshot.instanceId,
      revision: this.snapshot.revision,
      generatedAt: this.snapshot.generatedAt,
      agents: this.snapshot.agents.map(cloneAgent),
    };
  }

  isConnected(): boolean {
    return this.connected;
  }

  private async refresh(): Promise<boolean> {
    try {
      const token = readToken(this.launch.tokenPath);
      if (!token) throw new Error('broker token unavailable');
      const next = await getJson<BrokerSnapshot>(this.port, '/snapshot', token);
      if (!isSnapshot(next)) throw new Error('invalid snapshot');
      this.applySnapshot(next);
      return true;
    } catch (err) {
      this.channel.appendLine(`Broker snapshot unavailable: ${formatError(err)}`);
      return false;
    }
  }

  private ensureBroker(): boolean {
    const now = Date.now();
    if (now - this.lastSpawnAt < 30_000) return false;
    if (!existsSync(this.launch.brokerPath)) {
      this.channel.appendLine(`Broker script not found: ${this.launch.brokerPath}`);
      return false;
    }
    this.lastSpawnAt = now;
    try {
      const child = spawn(this.launch.pythonPath, [this.launch.brokerPath, '--port', String(this.port)], {
        detached: true,
        stdio: 'ignore',
        env: this.launch.env,
        windowsHide: true,
      });
      child.once('error', (error) => this.channel.appendLine(`Broker process error: ${formatError(error)}`));
      child.unref();
      this.channel.appendLine(`Started local broker candidate on port ${this.port}`);
      return true;
    } catch (err) {
      this.channel.appendLine(`Broker start failed: ${formatError(err)}`);
      return false;
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const token = readToken(this.launch.tokenPath);
    if (!token) {
      this.scheduleReconnect();
      return;
    }
    const req = http.get({
      host: '127.0.0.1',
      port: this.port,
      path: `/events?revision=${this.snapshot.revision}`,
      headers: { Accept: 'text/event-stream', 'X-Multi-Agent-Pixel-Office-Token': token },
    });
    this.request = req;

    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        req.destroy(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      this.reconnectMs = 1_000;
      this.setConnected(true);
      res.setEncoding('utf8');
      let buffer = '';
      res.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 2_000_000) {
          req.destroy(new Error('SSE frame too large'));
          return;
        }
        while (true) {
          const split = buffer.indexOf('\n\n');
          if (split < 0) break;
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          this.handleFrame(frame);
        }
      });
      res.on('end', () => this.scheduleReconnect());
      res.on('error', () => this.scheduleReconnect());
    });
    req.on('error', () => this.scheduleReconnect());
  }

  private handleFrame(frame: string): void {
    let event = 'message';
    const data: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length || event === 'ping') return;
    try {
      const payload = JSON.parse(data.join('\n')) as unknown;
      if (event === 'snapshot' && isSnapshot(payload)) {
        this.applySnapshot(payload);
        return;
      }
      if (event === 'revision' && isRevision(payload)) {
        if (payload.instanceId !== this.snapshot.instanceId) {
          this.applySnapshot(payload);
          return;
        }
        if (payload.revision <= this.snapshot.revision) return;
        if (payload.revision !== this.snapshot.revision + 1 || !Array.isArray(payload.agents)) {
          void this.refresh();
          return;
        }
        this.applySnapshot({ instanceId: payload.instanceId, revision: payload.revision, generatedAt: payload.generatedAt, agents: payload.agents });
      }
    } catch (err) {
      this.channel.appendLine(`Broker event ignored: ${formatError(err)}`);
    }
  }

  private applySnapshot(snapshot: BrokerSnapshot): void {
    const sameInstance = !this.snapshot.instanceId || snapshot.instanceId === this.snapshot.instanceId;
    if (sameInstance && snapshot.revision < this.snapshot.revision) return;
    this.snapshot = {
      instanceId: snapshot.instanceId,
      revision: snapshot.revision,
      generatedAt: snapshot.generatedAt,
      agents: snapshot.agents.map(cloneAgent),
    };
    this.emit('snapshot', this.getSnapshot());
  }

  private scheduleReconnect(): void {
    this.request?.destroy();
    this.request = undefined;
    this.setConnected(false);
    if (this.stopped || this.reconnectTimer) return;
    const reconnectDelay = this.reconnectMs;
    this.reconnectMs = Math.min(RECONNECT_MAX_MS, this.reconnectMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.refresh().then(async (ready) => {
        if (!ready && this.ensureBroker()) {
          await delay(600);
          await this.refresh();
        }
      }).finally(() => this.connect());
    }, reconnectDelay);
  }

  private setConnected(value: boolean): void {
    if (this.connected === value) return;
    this.connected = value;
    this.emit('connection', value);
  }
}

function getJson<T>(port: number, path: string, token: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1',
      port,
      path,
      headers: { Accept: 'application/json', 'X-Multi-Agent-Pixel-Office-Token': token },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 2_000_000) req.destroy(new Error('response too large'));
      });
      res.on('end', () => {
        try { resolve(JSON.parse(body) as T); }
        catch (err) { reject(err); }
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
  });
}

function readToken(path: string): string {
  try {
    const token = readFileSync(path, 'utf8').trim();
    return token.length >= 32 ? token : '';
  } catch {
    return '';
  }
}

function isSnapshot(value: unknown): value is BrokerSnapshot {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<BrokerSnapshot>;
  return typeof data.instanceId === 'string' && Number.isInteger(data.revision) && typeof data.generatedAt === 'number' && Array.isArray(data.agents) && data.agents.every(isAgent);
}

function isRevision(value: unknown): value is BrokerSnapshot {
  return isSnapshot(value);
}

function isAgent(value: unknown): value is AgentSnapshot {
  if (!value || typeof value !== 'object') return false;
  const a = value as Partial<AgentSnapshot>;
  return typeof a.id === 'string' && typeof a.name === 'string' && typeof a.sessionId === 'string' && typeof a.workspace === 'string' && Array.isArray(a.activeTools);
}

function cloneAgent(agent: AgentSnapshot): AgentSnapshot {
  return { ...agent, activeTools: agent.activeTools.map((tool) => ({ ...tool })) };
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
