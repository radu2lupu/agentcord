import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  Provider, ProviderEvent, ProviderSessionOptions, ContentBlock,
} from './types.ts';

// Lazy-loaded SDK constructor — populated on first use
let Codex: any;

async function loadSdk(): Promise<void> {
  if (Codex) return;
  const mod = await import('@openai/codex-sdk');
  Codex = mod.Codex;
}

// AGENTS.md sentinel for persona injection
const SENTINEL_START = '<!-- agentcord-persona-start -->';
const SENTINEL_END = '<!-- agentcord-persona-end -->';

function injectAgentsMd(directory: string, parts: string[]): string | null {
  if (parts.length === 0) return null;

  const agentsPath = join(directory, 'AGENTS.md');
  const injected = `${SENTINEL_START}\n${parts.join('\n\n')}\n${SENTINEL_END}`;

  let original: string | null = null;
  if (existsSync(agentsPath)) {
    original = readFileSync(agentsPath, 'utf-8');
    // Remove any existing sentinel block before re-injecting
    const cleaned = original
      .replace(new RegExp(`${escapeRegex(SENTINEL_START)}[\\s\\S]*?${escapeRegex(SENTINEL_END)}\\n?`), '');
    writeFileSync(agentsPath, cleaned + '\n' + injected + '\n', 'utf-8');
  } else {
    writeFileSync(agentsPath, injected + '\n', 'utf-8');
  }

  return original;
}

function restoreAgentsMd(directory: string, original: string | null): void {
  const agentsPath = join(directory, 'AGENTS.md');
  if (original === null) {
    // We created the file — remove it
    try { unlinkSync(agentsPath); } catch { /* may already be deleted */ }
  } else if (original !== undefined) {
    writeFileSync(agentsPath, original, 'utf-8');
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function writeImagesToTemp(blocks: ContentBlock[]): { textParts: string[]; localImages: Array<{ type: 'local_image'; path: string }> } {
  const textParts: string[] = [];
  const localImages: Array<{ type: 'local_image'; path: string }> = [];

  for (const block of blocks) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'image') {
      // Write base64 to a temp file
      const dir = mkdtempSync(join(tmpdir(), 'agentcord-img-'));
      const ext = block.source.media_type.split('/')[1] || 'png';
      const filePath = join(dir, `image.${ext}`);
      writeFileSync(filePath, Buffer.from(block.source.data, 'base64'));
      localImages.push({ type: 'local_image', path: filePath });
    } else if (block.type === 'local_image') {
      localImages.push(block);
    }
  }

  return { textParts, localImages };
}

export class CodexProvider implements Provider {
  readonly name = 'codex' as const;

  supports(feature: string): boolean {
    return [
      'command_execution', 'file_changes', 'reasoning',
      'todo_list', 'continue',
    ].includes(feature);
  }

  async *sendPrompt(
    prompt: string | ContentBlock[],
    options: ProviderSessionOptions,
  ): AsyncGenerator<ProviderEvent> {
    await loadSdk();

    // Build the input for Codex
    let input: string | Array<{ type: string; text?: string; path?: string }>;
    if (typeof prompt === 'string') {
      input = prompt;
    } else {
      const { textParts, localImages } = writeImagesToTemp(prompt);
      const inputParts: Array<{ type: string; text?: string; path?: string }> = [];
      for (const img of localImages) {
        inputParts.push({ type: 'local_image', path: img.path });
      }
      if (textParts.length > 0) {
        inputParts.push({ type: 'text', text: textParts.join('\n') });
      }
      input = inputParts.length === 1 && inputParts[0].type === 'text'
        ? inputParts[0].text!
        : inputParts;
    }

    // Inject system prompt parts into AGENTS.md
    let originalAgents: string | null = null;
    try {
      originalAgents = injectAgentsMd(options.directory, options.systemPromptParts);

      const codex = new Codex();

      const threadOptions: Record<string, any> = {
        workingDirectory: options.directory,
        skipGitRepoCheck: true,
      };
      if (options.model) threadOptions.model = options.model;
      if (options.sandboxMode) threadOptions.sandboxMode = options.sandboxMode;
      if (options.approvalPolicy) threadOptions.approvalPolicy = options.approvalPolicy;
      if (options.networkAccessEnabled !== undefined) {
        threadOptions.networkAccessEnabled = options.networkAccessEnabled;
      }

      const thread = options.providerSessionId
        ? codex.resumeThread(options.providerSessionId, threadOptions)
        : codex.startThread(threadOptions);

      const { events } = await thread.runStreamed(input);

      yield* this.translateEvents(events, options.abortController);
    } finally {
      restoreAgentsMd(options.directory, originalAgents);
    }
  }

  async *continueSession(
    options: ProviderSessionOptions,
  ): AsyncGenerator<ProviderEvent> {
    await loadSdk();

    if (!options.providerSessionId) {
      yield { type: 'error', message: 'No session to continue — no previous thread ID.' };
      return;
    }

    let originalAgents: string | null = null;
    try {
      originalAgents = injectAgentsMd(options.directory, options.systemPromptParts);

      const codex = new Codex();
      const threadOptions: Record<string, any> = {
        workingDirectory: options.directory,
        skipGitRepoCheck: true,
      };
      if (options.model) threadOptions.model = options.model;
      if (options.sandboxMode) threadOptions.sandboxMode = options.sandboxMode;
      if (options.approvalPolicy) threadOptions.approvalPolicy = options.approvalPolicy;
      if (options.networkAccessEnabled !== undefined) {
        threadOptions.networkAccessEnabled = options.networkAccessEnabled;
      }
      const thread = codex.resumeThread(options.providerSessionId, threadOptions);
      const { events } = await thread.runStreamed('Continue from where you left off.');

      yield* this.translateEvents(events, options.abortController);
    } finally {
      restoreAgentsMd(options.directory, originalAgents);
    }
  }

  private async *translateEvents(
    events: AsyncIterable<any>,
    abortController: AbortController,
  ): AsyncGenerator<ProviderEvent> {
    // Track partial text for agent_message items to only yield deltas
    const messageText = new Map<string, string>();
    const startTime = Date.now();

    try {
      for await (const event of events) {
        // Check for abort
        if (abortController.signal.aborted) break;

        switch (event.type) {
          case 'thread.started':
            yield { type: 'session_init', providerSessionId: event.thread_id };
            break;

          case 'item.started':
          case 'item.updated': {
            const item = event.item;
            if (!item) break;

            if (item.type === 'agent_message') {
              const prev = messageText.get(item.id) || '';
              const text = item.text || '';
              if (text.length > prev.length) {
                yield { type: 'text_delta', text: text.slice(prev.length) };
                messageText.set(item.id, text);
              }
            }

            if (item.type === 'reasoning' && event.type === 'item.updated') {
              const text = item.summary || item.content || '';
              if (text) {
                yield { type: 'reasoning', text };
              }
            }
            break;
          }

          case 'item.completed': {
            const item = event.item;
            if (!item) break;

            switch (item.type) {
              case 'agent_message': {
                // Emit any remaining text delta
                const prev = messageText.get(item.id) || '';
                const text = item.text || '';
                if (text.length > prev.length) {
                  yield { type: 'text_delta', text: text.slice(prev.length) };
                }
                messageText.delete(item.id);
                break;
              }

              case 'command_execution':
                yield {
                  type: 'command_execution',
                  command: item.command || '',
                  output: item.output || '',
                  exitCode: item.exit_code ?? item.exitCode ?? null,
                  status: item.status || 'completed',
                };
                break;

              case 'file_change': {
                const changes = (item.changes || item.files || []).map((f: any) => ({
                  filePath: f.file_path || f.filePath || f.path || '',
                  changeKind: (f.change_kind || f.changeKind || f.action || 'update') as 'add' | 'update' | 'delete',
                }));
                if (changes.length > 0) {
                  yield { type: 'file_change', changes };
                }
                break;
              }

              case 'reasoning': {
                const text = item.summary || item.content || '';
                if (text) {
                  yield { type: 'reasoning', text };
                }
                break;
              }

              case 'todo_list': {
                const items = (item.items || item.todos || []).map((t: any) => ({
                  text: t.text || t.description || '',
                  completed: t.completed ?? t.done ?? false,
                }));
                if (items.length > 0) {
                  yield { type: 'todo_list', items };
                }
                break;
              }

              case 'mcp_tool_call':
                yield {
                  type: 'tool_start',
                  toolName: `${item.server}/${item.tool}`,
                  toolInput: JSON.stringify(item.arguments || item.input || {}),
                };
                if (item.status === 'completed' || item.status === 'failed') {
                  yield {
                    type: 'tool_result',
                    toolName: `${item.server}/${item.tool}`,
                    result: typeof item.output === 'string' ? item.output : JSON.stringify(item.output || ''),
                    isError: item.status === 'failed',
                  };
                }
                break;

              case 'error':
                yield { type: 'error', message: item.message || 'Unknown error' };
                break;
            }
            break;
          }

          case 'turn.completed': {
            const usage = event.usage;
            const inputTokens = usage?.input_tokens || 0;
            const outputTokens = usage?.output_tokens || 0;
            // Rough cost estimate based on typical Codex pricing
            const costUsd = (inputTokens * 2 + outputTokens * 8) / 1_000_000;

            yield {
              type: 'result',
              success: true,
              costUsd,
              durationMs: Date.now() - startTime,
              numTurns: 1,
              errors: [],
            };
            break;
          }

          case 'turn.failed':
            yield {
              type: 'result',
              success: false,
              costUsd: 0,
              durationMs: Date.now() - startTime,
              numTurns: 1,
              errors: [event.error || 'Turn failed'],
            };
            break;

          case 'error':
            yield { type: 'error', message: event.message || 'Unknown error' };
            break;
        }
      }
    } catch (err: unknown) {
      if (!abortController.signal.aborted) {
        yield { type: 'error', message: (err as Error).message || 'Codex stream error' };
      }
    }
  }
}
