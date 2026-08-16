export type ToolStatus = 'reading' | 'writing' | 'running' | 'searching' | 'thinking' | 'other';

export interface ToolHistoryEntry {
  toolId: string;
  toolName: string;
  status: ToolStatus;
  startedAt: number;
  finishedAt?: number;
}

export type Provider = 'github-copilot' | 'claude-code';
export type AgentKind = 'main' | 'subagent';
export type AgentPhase = 'starting' | 'thinking' | 'reading' | 'writing' | 'running' | 'searching' | 'waiting' | 'idle' | 'error' | 'done';

export interface AgentTool {
  id: string;
  name: string;
  status: ToolStatus;
  target?: string;
  startedAt: number;
}

export interface AgentSnapshot {
  id: string;
  provider: Provider;
  kind: AgentKind;
  parentId?: string;
  sessionId: string;
  workspace: string;
  name: string;
  phase: AgentPhase;
  activity: string;
  toolName?: string;
  target?: string;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  activeTools: AgentTool[];
  inputTokens?: number;
  outputTokens?: number;
}

export interface BrokerSnapshot {
  instanceId: string;
  revision: number;
  generatedAt: number;
  agents: AgentSnapshot[];
}

export type ServerMessage =
  | { type: 'agentCreated'; id: string; name: string }
  | { type: 'agentRemoved'; id: string }
  | { type: 'existingAgents'; agents: Array<{ id: string; name: string }> }
  | { type: 'agentToolStart'; id: string; toolId: string; toolName: string; status: ToolStatus }
  | { type: 'agentToolDone'; id: string; toolId: string }
  | { type: 'agentStatus'; id: string; status: 'idle' | 'waiting' | 'active' }
  | { type: 'agentTokenUsage'; id: string; inputTokens: number; outputTokens: number }
  | { type: 'serverPort'; port: number }
  | { type: 'agentSnapshot'; snapshot: BrokerSnapshot }
  | { type: 'brokerStatus'; connected: boolean };

export type ClientMessage =
  | { type: 'webviewReady' }
  | { type: 'focusAgent'; id: string }
  | { type: 'closeAgent'; id: string }
  | { type: 'installHooks' };
