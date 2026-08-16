import './style.css';
import {
  addCharacter,
  createOffice,
  onToolDone,
  onToolStart,
  removeCharacter,
  resizeOffice,
  setIdle,
  setWaiting,
  startLoop,
} from './engine.js';
import type { Character } from './engine.js';
import type { AgentSnapshot, BrokerSnapshot, ClientMessage, ServerMessage } from './types.js';

declare const acquireVsCodeApi: () => { postMessage: (msg: ClientMessage) => void };
const vscode = acquireVsCodeApi();
function post(msg: ClientMessage): void { vscode.postMessage(msg); }

// ─── Bootstrap ───────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const app = document.getElementById('app')!;

  // Status bar
  const statusBar = document.createElement('div');
  statusBar.id = 'status-bar';
  statusBar.textContent = 'Connecting…';
  app.appendChild(statusBar);

  // Canvas wrapper — flex:1 goes here so canvas intrinsic size doesn't fight the layout
  const canvasWrap = document.createElement('div');
  canvasWrap.id = 'canvas-wrap';
  app.appendChild(canvasWrap);

  const canvas = document.createElement('canvas');
  canvas.id = 'office-canvas';
  canvasWrap.appendChild(canvas);

  // Empty-state overlay (shown when no agents; hidden otherwise)
  const emptyOverlay = document.createElement('div');
  emptyOverlay.id = 'empty-overlay';
  const emptyIcon = element('div', 'empty-icon', '👾');
  const emptyTitle = element('div', 'empty-title', 'No active agents');
  const emptySubtitle = element('div', 'empty-subtitle', 'Run an agent and it will appear here. Install the local hooks first.');
  const installButton = element('button', '', 'Install / Reinstall Hooks');
  installButton.id = 'install-hooks-btn';
  const emptyHint = element('div', 'empty-hint', 'Command Palette → Multi-Agent Pixel Office: Install GitHub Copilot and Claude Code Hooks');
  emptyOverlay.append(emptyIcon, emptyTitle, emptySubtitle, installButton, emptyHint);
  canvasWrap.appendChild(emptyOverlay);

  document.getElementById('install-hooks-btn')?.addEventListener('click', () => {
    post({ type: 'installHooks' });
  });

  // Bottom panel
  const bottomPanel = document.createElement('div');
  bottomPanel.id = 'bottom-panel';
  app.appendChild(bottomPanel);

  const agentsStrip = document.createElement('div');
  agentsStrip.id = 'agents-strip';
  bottomPanel.appendChild(agentsStrip);

  const inspector = document.createElement('div');
  inspector.id = 'inspector';
  inspector.style.display = 'none';
  bottomPanel.appendChild(inspector);

  // Agent modal — large overlay panel on canvas (right side)
  const agentModal = document.createElement('div');
  agentModal.id = 'agent-modal';
  agentModal.style.display = 'none';
  canvasWrap.appendChild(agentModal);

  const activityPanel = document.createElement('aside');
  activityPanel.id = 'agent-activity-panel';
  activityPanel.setAttribute('aria-label', 'Agent activity');
  canvasWrap.appendChild(activityPanel);

  let brokerConnected = false;
  let brokerSnapshot: BrokerSnapshot = { instanceId: '', revision: 0, generatedAt: 0, agents: [] };

  // Create office (sets up click handler)
  const office = createOffice(canvas);

  // ── Canvas responsive sizing via ResizeObserver ──────────────────────────
  // Initial size from wrapper (canvas itself has no intrinsic CSS size yet)
  const initialW = canvasWrap.offsetWidth || window.innerWidth;
  const initialH = canvasWrap.offsetHeight || Math.max(120, window.innerHeight - 80);
  resizeOffice(office, initialW, initialH);

  const ro = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) resizeOffice(office, width, height);
    }
  });
  ro.observe(canvasWrap);

  startLoop(office);

  function syncEmptyOverlay() {
    emptyOverlay.style.display = office.characters.size === 0 ? 'flex' : 'none';
  }
  syncEmptyOverlay();

  const closeModal = () => {
    agentModal.style.display = 'none';
    inspector.style.display = 'none';
    for (const c of office.characters.values()) c.selected = false;
    renderAgentsStrip(agentsStrip, office);
  };

  // ── Inspector / modal logic ──────────────────────────────────────────────
  office.onCharacterClick = (id: string) => {
    if (!id) { closeModal(); return; }
    const char = office.characters.get(id);
    if (!char) return;
    agentModal.style.display = 'flex';
    renderAgentModal(agentModal, char, closeModal);
    renderAgentsStrip(agentsStrip, office, id);
  };

  // ── Message handler ──────────────────────────────────────────────────────
  window.addEventListener('message', (event: MessageEvent<ServerMessage>) => {
    const msg = event.data;
    switch (msg.type) {
      case 'serverPort':
        statusBar.textContent = `Broker → 127.0.0.1:${msg.port}`;
        break;

      case 'brokerStatus':
        brokerConnected = msg.connected;
        statusBar.textContent = msg.connected ? 'Broker connected' : 'Broker reconnecting…';
        renderActivityPanel(activityPanel, brokerSnapshot, brokerConnected, (id) => {
          const char = office.characters.get(id);
          if (!char) return;
          for (const item of office.characters.values()) item.selected = item.id === id;
          agentModal.style.display = 'flex';
          renderAgentModal(agentModal, char, closeModal);
          renderAgentsStrip(agentsStrip, office, id);
        });
        break;

      case 'agentSnapshot':
        brokerSnapshot = msg.snapshot;
        renderActivityPanel(activityPanel, brokerSnapshot, brokerConnected, (id) => {
          const char = office.characters.get(id);
          if (!char) return;
          for (const item of office.characters.values()) item.selected = item.id === id;
          agentModal.style.display = 'flex';
          renderAgentModal(agentModal, char, closeModal);
          renderAgentsStrip(agentsStrip, office, id);
        });
        break;

      case 'existingAgents':
        for (const a of msg.agents) addCharacter(office, a.id, a.name);
        syncEmptyOverlay();
        renderAgentsStrip(agentsStrip, office);
        break;

      case 'agentCreated':
        addCharacter(office, msg.id, msg.name);
        syncEmptyOverlay();
        renderAgentsStrip(agentsStrip, office);
        break;

      case 'agentRemoved':
        removeCharacter(office, msg.id);
        syncEmptyOverlay();
        closeModal();
        renderAgentsStrip(agentsStrip, office);
        break;

      case 'agentToolStart': {
        onToolStart(office, msg.id, msg.toolId, msg.toolName, msg.status);
        const sel = selectedChar(office);
        if (sel?.id === msg.id && agentModal.style.display !== 'none') {
          renderAgentModal(agentModal, sel, closeModal);
        }
        renderAgentsStrip(agentsStrip, office, sel?.id);
        break;
      }

      case 'agentToolDone': {
        onToolDone(office, msg.id, msg.toolId);
        const sel = selectedChar(office);
        if (sel?.id === msg.id && agentModal.style.display !== 'none') {
          renderAgentModal(agentModal, sel, closeModal);
        }
        renderAgentsStrip(agentsStrip, office, sel?.id);
        break;
      }

      case 'agentStatus': {
        if (msg.status === 'waiting') setWaiting(office, msg.id);
        else if (msg.status === 'idle') setIdle(office, msg.id);
        const sel = selectedChar(office);
        if (sel?.id === msg.id && agentModal.style.display !== 'none') {
          renderAgentModal(agentModal, sel, closeModal);
        }
        renderAgentsStrip(agentsStrip, office, sel?.id);
        break;
      }

      case 'agentTokenUsage': {
        const c = office.characters.get(msg.id);
        if (c) { c.inputTokens = msg.inputTokens; c.outputTokens = msg.outputTokens; }
        const sel = selectedChar(office);
        if (sel?.id === msg.id && agentModal.style.display !== 'none') {
          renderAgentModal(agentModal, sel, closeModal);
        }
        break;
      }
    }
  });

  post({ type: 'webviewReady' });
});

// ─── UI helpers ──────────────────────────────────────────────────────────────

function renderAgentsStrip(
  container: HTMLElement,
  office: ReturnType<typeof createOffice>,
  selectedId?: string,
): void {
  container.replaceChildren();
  if (office.characters.size === 0) {
    container.appendChild(element('span', 'agents-empty', 'No agents running'));
    return;
  }
  for (const c of office.characters.values()) {
    const chip = document.createElement('div');
    chip.className = 'agent-chip' + (c.id === selectedId ? ' selected' : '');
    const dot = element('div', `agent-chip-dot ${c.activity}`);
    const name = element('span', 'agent-chip-name', c.name);
    name.title = c.id;
    chip.append(dot, name);
    chip.addEventListener('click', () => {
      for (const ch of office.characters.values()) ch.selected = false;
      c.selected = true;
      const modal = document.getElementById('agent-modal') as HTMLElement;
      const closeModalFn = () => {
        modal.style.display = 'none';
        for (const ch of office.characters.values()) ch.selected = false;
        renderAgentsStrip(container, office);
      };
      if (modal) {
        modal.style.display = 'flex';
        renderAgentModal(modal, c, closeModalFn);
      }
      renderAgentsStrip(container, office, c.id);
    });
    container.appendChild(chip);
  }
}

function renderAgentModal(container: HTMLElement, char: Character, onClose: () => void): void {
  const dur = Math.round((Date.now() - char.sessionStartedAt) / 1000);
  const durStr = dur < 60 ? `${dur}s` : `${Math.floor(dur / 60)}m ${dur % 60}s`;

  container.replaceChildren();
  const header = element('div', 'modal-header');
  const titleRow = element('div', 'modal-title-row');
  const close = element('button', 'modal-close', '✕') as HTMLButtonElement;
  close.type = 'button';
  titleRow.append(element('div', `modal-dot ${char.activity}`), element('span', 'modal-name', char.name), close);
  header.append(titleRow, element('div', 'modal-status', actLabel(char.activity)));

  const stats = element('div', 'modal-stats');
  for (const [label, value] of [
    ['Uptime', durStr],
    ['Input', fmt(char.inputTokens)],
    ['Output', fmt(char.outputTokens)],
    ['Tools', String(char.toolHistory.length)],
  ]) {
    const card = element('div', 'modal-stat-card');
    card.append(element('span', 'modal-stat-label', label), element('span', 'modal-stat-val', value));
    stats.append(card);
  }

  const active = element('div', 'modal-active-tools');
  if (!char.activeTools.size) active.append(element('span', 'modal-empty', '—'));
  for (const tool of char.activeTools.values()) active.append(element('div', `modal-tool ${tool.status}`, `${statusIcon(tool.status)} ${tool.name}`));

  const history = element('div', 'modal-history');
  if (!char.toolHistory.length) history.append(element('div', 'modal-empty', 'No tools yet'));
  for (const entry of char.toolHistory) {
    const row = element('div', 'modal-hist-entry');
    const toolName = element('span', 'modal-hist-name', entry.toolName);
    toolName.title = entry.toolName;
    row.append(
      element('span', 'modal-hist-icon', statusIcon(entry.status)),
      toolName,
      element('span', entry.finishedAt ? 'modal-hist-dur' : 'modal-hist-dur modal-running', entry.finishedAt ? `${entry.finishedAt - entry.startedAt}ms` : '…'),
      element('span', 'modal-hist-ago', fmtAgo(entry.startedAt)),
    );
    history.append(row);
  }

  container.append(
    header,
    stats,
    element('div', 'modal-section-title', 'Active'),
    active,
    element('div', 'modal-section-title', 'History'),
    history,
  );

  close.addEventListener('click', (e) => {
    e.stopPropagation();
    onClose();
  });
}

function renderActivityPanel(
  panel: HTMLElement,
  snapshot: BrokerSnapshot,
  connected: boolean,
  onSelect: (id: string) => void,
): void {
  panel.replaceChildren();
  const header = element('header', 'agent-activity-header');
  header.append(
    element('strong', '', `Agent Activity (${snapshot.agents.length})`),
    element('span', connected ? 'broker-online' : 'broker-offline', connected ? 'Broker online' : 'Reconnecting'),
  );
  panel.append(header);

  if (!snapshot.agents.length) {
    panel.append(element('div', 'agent-activity-empty', 'No active Copilot or Claude agents'));
    return;
  }

  const agents = [...snapshot.agents].sort((a, b) => {
    if (a.workspace !== b.workspace) return a.workspace.localeCompare(b.workspace);
    if (a.kind !== b.kind) return a.kind === 'main' ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
  for (const agent of agents) panel.append(renderActivityAgent(agent, onSelect));
}

function renderActivityAgent(agent: AgentSnapshot, onSelect: (id: string) => void): HTMLElement {
  const row = element('button', `agent-activity-row${agent.kind === 'subagent' ? ' is-subagent' : ''}`) as HTMLButtonElement;
  row.type = 'button';
  row.addEventListener('click', () => onSelect(agent.id));

  const first = element('div', 'agent-activity-main');
  const badges = element('span', 'agent-badges');
  badges.append(
    element('span', `agent-badge ${agent.provider}`, agent.provider === 'claude-code' ? 'Claude' : 'Copilot'),
    element('span', `agent-badge ${agent.kind}`, agent.kind === 'subagent' ? 'Subagent' : 'Main'),
  );
  first.append(element('strong', '', agent.name), badges);

  const detail = [agent.activity || humanPhase(agent.phase), agent.target || agent.toolName || ''].filter(Boolean).join(' · ');
  const meta = [agent.workspace, agent.parentId ? `parent ${shortId(agent.parentId)}` : '', `updated ${relativeTime(agent.updatedAt)}`]
    .filter(Boolean)
    .join(' · ');
  row.append(first, element('div', 'agent-activity-text', detail), element('div', 'agent-activity-meta', meta));
  return row;
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function selectedChar(office: ReturnType<typeof createOffice>): Character | undefined {
  return [...office.characters.values()].find((c) => c.selected);
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n || 0);
}

function fmtAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function humanPhase(phase: AgentSnapshot['phase']): string {
  const labels: Record<AgentSnapshot['phase'], string> = {
    starting: 'Starting', thinking: 'Thinking', reading: 'Reading', writing: 'Writing', running: 'Running', searching: 'Searching',
    waiting: 'Waiting', idle: 'Idle', error: 'Error', done: 'Done',
  };
  return labels[phase];
}

function relativeTime(value: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Number(value || 0)) / 1000));
  if (seconds < 5) return 'now';
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

function shortId(value: string): string {
  return value.slice(-8);
}

function actLabel(a: string): string {
  const map: Record<string, string> = {
    typing: '⌨ Writing', reading: '📖 Reading', running: '⚙ Running',
    searching: '🔍 Searching', waiting: '⏳ Waiting', walking: '🚶 Walking', idle: '💤 Idle',
    gaming: '🎮 Gaming', watching_tv: '📺 Watching TV', coffee_break: '☕ Coffee Break',
  };
  return map[a] ?? a;
}

function statusIcon(s: string): string {
  const map: Record<string, string> = {
    reading: '📖', writing: '✏️', running: '⚙️', searching: '🔍', other: '🔧',
  };
  return map[s] ?? '🔧';
}
