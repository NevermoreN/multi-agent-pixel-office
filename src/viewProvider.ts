import * as vscode from 'vscode';
import type { BrokerClient } from './brokerClient.js';
import type { AgentSnapshot, BrokerSnapshot, ClientMessage, ServerMessage, ToolStatus } from './types.js';

export class PixelOfficeViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private visibleSnapshot: BrokerSnapshot = { instanceId: '', revision: 0, generatedAt: 0, agents: [] };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly broker: BrokerClient,
    private readonly brokerPort: number,
  ) {
    this.visibleSnapshot = broker.getSnapshot();
    broker.on('snapshot', (snapshot: BrokerSnapshot) => this.applySnapshot(snapshot));
    broker.on('connection', (connected: boolean) => this.post({ type: 'brokerStatus', connected }));
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    };
    webviewView.webview.html = this.buildHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg: ClientMessage) => this.handleClientMessage(msg));
  }

  private handleClientMessage(msg: ClientMessage): void {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'webviewReady':
        this.replaySnapshot(this.broker.getSnapshot());
        this.post({ type: 'serverPort', port: this.brokerPort });
        this.post({ type: 'brokerStatus', connected: this.broker.isConnected() });
        break;
      case 'installHooks':
        void vscode.commands.executeCommand('multiAgentPixelOffice.installHooks');
        break;
    }
  }

  private applySnapshot(next: BrokerSnapshot): void {
    if (!this.view) {
      this.visibleSnapshot = next;
      return;
    }
    const previous = new Map(this.visibleSnapshot.agents.map((agent) => [agent.id, agent]));
    const current = new Map(next.agents.map((agent) => [agent.id, agent]));

    for (const id of previous.keys()) {
      if (!current.has(id)) this.post({ type: 'agentRemoved', id });
    }
    for (const agent of next.agents) {
      let before = previous.get(agent.id);
      if (!before) {
        this.post({ type: 'agentCreated', id: agent.id, name: agent.name });
      } else if (before.name !== agent.name) {
        this.post({ type: 'agentRemoved', id: agent.id });
        this.post({ type: 'agentCreated', id: agent.id, name: agent.name });
        before = undefined;
      }
      this.syncAgent(before, agent);
    }
    this.visibleSnapshot = next;
    this.post({ type: 'agentSnapshot', snapshot: next });
  }

  private replaySnapshot(snapshot: BrokerSnapshot): void {
    this.visibleSnapshot = snapshot;
    this.post({ type: 'existingAgents', agents: snapshot.agents.map((agent) => ({ id: agent.id, name: agent.name })) });
    for (const agent of snapshot.agents) this.syncAgent(undefined, agent);
    this.post({ type: 'agentSnapshot', snapshot });
  }

  private syncAgent(before: AgentSnapshot | undefined, after: AgentSnapshot): void {
    const oldTools = new Map((before?.activeTools ?? []).map((tool) => [tool.id, tool]));
    const newTools = new Map(after.activeTools.map((tool) => [tool.id, tool]));

    for (const toolId of oldTools.keys()) {
      if (!newTools.has(toolId)) this.post({ type: 'agentToolDone', id: after.id, toolId });
    }
    for (const tool of after.activeTools) {
      const old = oldTools.get(tool.id);
      if (!old || old.name !== tool.name || old.status !== tool.status) {
        if (old) this.post({ type: 'agentToolDone', id: after.id, toolId: tool.id });
        this.post({ type: 'agentToolStart', id: after.id, toolId: tool.id, toolName: tool.name, status: tool.status });
      }
    }

    if (after.phase === 'waiting') this.post({ type: 'agentStatus', id: after.id, status: 'waiting' });
    else if (!after.activeTools.length) this.post({ type: 'agentStatus', id: after.id, status: 'idle' });
    else this.post({ type: 'agentStatus', id: after.id, status: phaseToStatus(after.phase) });

    if (typeof after.inputTokens === 'number' || typeof after.outputTokens === 'number') {
      this.post({
        type: 'agentTokenUsage',
        id: after.id,
        inputTokens: after.inputTokens ?? 0,
        outputTokens: after.outputTokens ?? 0,
      });
    }
  }

  private post(msg: ServerMessage): void {
    void this.view?.webview.postMessage(msg);
  }

  private buildHtml(webview: vscode.Webview): string {
    const mainScript = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'main.js'));
    const mainStyle = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'main.css'));
    const assetsBaseUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'assets')).toString();
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};" />
  <link rel="stylesheet" href="${mainStyle}" />
  <title>Multi-Agent Pixel Office</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}">window.ASSETS_BASE_URI = ${JSON.stringify(assetsBaseUri)};</script>
  <script nonce="${nonce}" src="${mainScript}"></script>
</body>
</html>`;
  }
}

function phaseToStatus(phase: AgentSnapshot['phase']): ToolStatus {
  if (phase === 'reading' || phase === 'writing' || phase === 'running' || phase === 'searching') return phase;
  return 'other';
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
