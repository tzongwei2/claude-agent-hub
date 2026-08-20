export type AgentStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'waiting_for_user'
  | 'waiting_for_permission'
  | 'error'
  | 'stopped';

export interface Agent {
  id: string;
  name: string;
  description: string;
  emoji: string;
  accent: string;
  systemPrompt: string;
  agentKey: string;
  workingDirectory: string;
  model: string;
  permissionMode: string;
  createdAt: number;
  updatedAt: number;
}

export interface StatusSnapshot {
  agentId: string;
  status: AgentStatus;
  activity: string | null;
  claudeSessionId?: string | null;
  lastError?: string | null;
  pendingPermissions: HubEvent[];
}

export type EventKind =
  | 'user'
  | 'assistant'
  | 'tool_use'
  | 'tool_result'
  | 'permission'
  | 'system'
  | 'error'
  | 'result';

export interface HubEvent {
  id: number;
  ts: number;
  kind: EventKind;
  text?: string;
  level?: string;
  subagent?: boolean;
  /* tool_use */
  toolUseId?: string;
  name?: string;
  title?: string;
  detail?: string;
  input?: string;
  /* tool_result */
  isError?: boolean;
  summary?: string;
  /* permission */
  requestId?: string;
  toolName?: string;
  displayName?: string;
  status?: 'pending' | 'allowed' | 'denied' | 'expired';
  /* result */
  durationMs?: number | null;
  costUsd?: number | null;
  turns?: number | null;
  subtype?: string;
}

export const STATUS_META: Record<AgentStatus, { label: string; color: string }> = {
  idle: { label: 'Idle', color: 'var(--ok)' },
  starting: { label: 'Starting', color: 'var(--busy)' },
  running: { label: 'Running', color: 'var(--busy)' },
  waiting_for_user: { label: 'Waiting for you', color: 'var(--accent)' },
  waiting_for_permission: { label: 'Needs permission', color: 'var(--alert)' },
  error: { label: 'Error', color: 'var(--danger)' },
  stopped: { label: 'Stopped', color: 'var(--text-soft)' },
};

export interface RateLimitInfo {
  status: string;
  resetsAt?: number;
  rateLimitType?: string;
  overageStatus?: string;
  isUsingOverage?: boolean;
}

export interface UsageWindow {
  since: number;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  cost: number;
  turns: number;
  byAgent: { agentId: string; name: string; tokens: number; cost: number; turns: number }[];
  windowMs: number;
  windowType: string;
  resetsAt: number | null;
  rateLimit: RateLimitInfo | null;
}
