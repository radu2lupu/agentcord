export type ProviderName = 'claude' | 'codex';
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexApprovalPolicy = 'never' | 'on-request' | 'on-failure' | 'untrusted';

// ── Content blocks (provider-agnostic) ──────────────────────────

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export type TextBlock = { type: 'text'; text: string };
export type ImageBlock = {
  type: 'image';
  source: { type: 'base64'; media_type: ImageMediaType; data: string };
};
export type LocalImageBlock = { type: 'local_image'; path: string };
export type ContentBlock = TextBlock | ImageBlock | LocalImageBlock;

// ── Provider Events (the unified stream protocol) ───────────────

export type ProviderEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; toolName: string; toolInput: string }
  | { type: 'tool_result'; toolName: string; result: string; isError?: boolean }
  | { type: 'ask_user'; questionsJson: string }
  | { type: 'task'; action: string; dataJson: string }
  | { type: 'image_file'; filePath: string }
  | { type: 'command_execution'; command: string; output: string; exitCode: number | null; status: string }
  | { type: 'file_change'; changes: Array<{ filePath: string; changeKind: 'add' | 'update' | 'delete' }> }
  | { type: 'reasoning'; text: string }
  | { type: 'todo_list'; items: Array<{ text: string; completed: boolean }> }
  | { type: 'session_init'; providerSessionId: string }
  | { type: 'result'; success: boolean; costUsd: number; durationMs: number; numTurns: number; errors: string[] }
  | { type: 'error'; message: string };

// ── Provider Interface ──────────────────────────────────────────

export interface ProviderSessionOptions {
  directory: string;
  providerSessionId?: string;
  model?: string;
  sandboxMode?: CodexSandboxMode;
  approvalPolicy?: CodexApprovalPolicy;
  networkAccessEnabled?: boolean;
  systemPromptParts: string[];
  abortController: AbortController;
}

export interface Provider {
  readonly name: ProviderName;

  sendPrompt(
    prompt: string | ContentBlock[],
    options: ProviderSessionOptions,
  ): AsyncGenerator<ProviderEvent>;

  continueSession(
    options: ProviderSessionOptions,
  ): AsyncGenerator<ProviderEvent>;

  supports(feature: string): boolean;
}
