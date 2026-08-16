export type Provider = 'github-copilot' | 'claude-code';
export type AgentKind = 'main' | 'subagent';
export type AgentPhase = 'starting' | 'thinking' | 'reading' | 'writing' | 'running' | 'searching' | 'waiting' | 'idle' | 'error' | 'done';
export type ToolStatus = 'reading' | 'writing' | 'running' | 'searching' | 'other';

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

export type ClientMessage =
  | { type: 'webviewReady' }
  | { type: 'installHooks' }
  | { type: 'focusAgent'; id?: string }
  | { type: 'closeAgent'; id?: string };

export type LegacyServerMessage =
  | { type: 'serverPort'; port: number }
  | { type: 'existingAgents'; agents: Array<{ id: string; name: string }> }
  | { type: 'agentCreated'; id: string; name: string }
  | { type: 'agentRemoved'; id: string }
  | { type: 'agentToolStart'; id: string; toolId: string; toolName: string; status: ToolStatus }
  | { type: 'agentToolDone'; id: string; toolId: string }
  | { type: 'agentStatus'; id: string; status: ToolStatus | 'waiting' | 'idle' }
  | { type: 'agentTokenUsage'; id: string; inputTokens: number; outputTokens: number };

export type ServerMessage = LegacyServerMessage | { type: 'agentSnapshot'; snapshot: BrokerSnapshot } | { type: 'brokerStatus'; connected: boolean };
