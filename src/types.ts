import type { ProviderName, CodexSandboxMode, CodexApprovalPolicy } from './providers/types.ts';

// Re-export content block types from providers (used by message-handler, etc.)
export type {
  ContentBlock,
  ImageMediaType,
  TextBlock,
  ImageBlock,
  LocalImageBlock,
  ProviderName,
  CodexSandboxMode,
  CodexApprovalPolicy,
} from './providers/types.ts';

export interface McpServer {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface Project {
  name: string;
  directory: string;
  categoryId: string;
  logChannelId?: string;
  personality?: string;
  skills: Record<string, string>;
  mcpServers: McpServer[];
}

export interface Session {
  id: string;
  channelId: string;
  directory: string;
  projectName: string;
  provider: ProviderName;
  tmuxName: string;
  providerSessionId?: string;
  model?: string;
  sandboxMode?: CodexSandboxMode;
  approvalPolicy?: CodexApprovalPolicy;
  networkAccessEnabled?: boolean;
  agentPersona?: string;
  verbose: boolean;
  mode: SessionMode;
  isGenerating: boolean;
  createdAt: number;
  lastActivity: number;
  messageCount: number;
  totalCost: number;
}

export interface SessionPersistData {
  id: string;
  channelId: string;
  directory: string;
  projectName: string;
  provider?: ProviderName;
  tmuxName: string;
  providerSessionId?: string;
  model?: string;
  sandboxMode?: CodexSandboxMode;
  approvalPolicy?: CodexApprovalPolicy;
  networkAccessEnabled?: boolean;
  agentPersona?: string;
  verbose?: boolean;
  mode?: SessionMode;
  createdAt: number;
  lastActivity: number;
  messageCount: number;
  totalCost: number;
}

export type SessionMode = 'auto' | 'plan' | 'normal';

export interface AgentPersona {
  name: string;
  description: string;
  systemPrompt: string;
  emoji: string;
}

export interface ShellProcess {
  pid: number;
  command: string;
  startedAt: number;
  process: import('node:child_process').ChildProcess;
}

export interface Config {
  token: string;
  clientId: string;
  guildId: string | null;
  allowedUsers: string[];
  allowAllUsers: boolean;
  allowedPaths: string[];
  defaultDirectory: string;
  messageRetentionDays: number | null;
  rateLimitMs: number;
  codexSandboxMode?: CodexSandboxMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  codexNetworkAccessEnabled?: boolean;
}

export interface ExpandableContent {
  content: string;
  createdAt: number;
}
