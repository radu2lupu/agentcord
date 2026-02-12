import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  Provider, ProviderEvent, ProviderSessionOptions, ContentBlock,
} from './types.ts';

const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);

function extractImagePath(toolName: string, toolInput: string): string | null {
  try {
    const data = JSON.parse(toolInput);
    if (toolName === 'Write' || toolName === 'Read') {
      const filePath: string = data.file_path;
      if (filePath && IMAGE_EXTENSIONS.has(filePath.slice(filePath.lastIndexOf('.')).toLowerCase())) {
        return filePath;
      }
    }
  } catch { /* incomplete or invalid JSON */ }
  return null;
}

function buildClaudeSystemPrompt(
  parts: string[],
): string | { type: 'preset'; preset: 'claude_code'; append?: string } {
  if (parts.length > 0) {
    return { type: 'preset', preset: 'claude_code', append: parts.join('\n\n') };
  }
  return { type: 'preset', preset: 'claude_code' };
}

export class ClaudeProvider implements Provider {
  readonly name = 'claude' as const;

  supports(feature: string): boolean {
    return [
      'tmux', 'resume_from_terminal', 'plugins',
      'ask_user_question', 'mode_switching', 'continue',
    ].includes(feature);
  }

  async *sendPrompt(
    prompt: string | ContentBlock[],
    options: ProviderSessionOptions,
  ): AsyncGenerator<ProviderEvent> {
    const systemPrompt = buildClaudeSystemPrompt(options.systemPromptParts);

    function buildQueryPrompt(): string | AsyncIterable<any> {
      if (typeof prompt === 'string') return prompt;
      // Filter out LocalImageBlock (not supported by Claude directly)
      const claudeBlocks = (prompt as ContentBlock[]).filter(b => b.type !== 'local_image');
      const userMessage = {
        type: 'user' as const,
        message: { role: 'user' as const, content: claudeBlocks },
        parent_tool_use_id: null,
        session_id: '',
      };
      return (async function* () { yield userMessage; })();
    }

    let retried = false;
    let resumeId = options.providerSessionId;

    while (true) {
      let failed = false;
      const stream = query({
        prompt: buildQueryPrompt(),
        options: {
          cwd: options.directory,
          resume: resumeId,
          abortController: options.abortController,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          model: options.model,
          systemPrompt,
          includePartialMessages: true,
          settingSources: ['user', 'project', 'local'],
        },
      });

      yield* this.translateStream(stream, resumeId, retried, (f, r) => {
        failed = f;
        retried = r;
      });

      // If the stream signalled a retry, the outer values were mutated via callback
      if (failed && !retried) {
        retried = true;
        resumeId = undefined;
        // Signal session ID reset
        yield { type: 'session_init', providerSessionId: '' };
        continue;
      }
      break;
    }
  }

  async *continueSession(
    options: ProviderSessionOptions,
  ): AsyncGenerator<ProviderEvent> {
    const systemPrompt = buildClaudeSystemPrompt(options.systemPromptParts);

    let retried = false;
    let resumeId = options.providerSessionId;

    while (true) {
      let failed = false;
      const stream = query({
        prompt: '',
        options: {
          cwd: options.directory,
          ...(resumeId ? { continue: true, resume: resumeId } : {}),
          abortController: options.abortController,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          model: options.model,
          systemPrompt,
          includePartialMessages: true,
          settingSources: ['user', 'project', 'local'],
        },
      });

      yield* this.translateStream(stream, resumeId, retried, (f, r) => {
        failed = f;
        retried = r;
      });

      if (failed && !retried) {
        retried = true;
        resumeId = undefined;
        yield { type: 'session_init', providerSessionId: '' };
        continue;
      }
      break;
    }
  }

  private async *translateStream(
    stream: AsyncGenerator<SDKMessage>,
    resumeId: string | undefined,
    alreadyRetried: boolean,
    setRetry: (failed: boolean, retried: boolean) => void,
  ): AsyncGenerator<ProviderEvent> {
    let currentToolName: string | null = null;
    let currentToolInput = '';

    for await (const message of stream) {
      // Capture session ID from init message
      if (message.type === 'system' && 'subtype' in message && message.subtype === 'init') {
        yield { type: 'session_init', providerSessionId: (message as any).session_id };
      }

      if (message.type === 'stream_event') {
        const event = (message as any).event;

        if (event?.type === 'content_block_start') {
          if (event.content_block?.type === 'tool_use') {
            currentToolName = event.content_block.name || 'tool';
            currentToolInput = '';
          }
        }

        if (event?.type === 'content_block_delta') {
          if (event.delta?.type === 'text_delta' && event.delta.text) {
            yield { type: 'text_delta', text: event.delta.text };
          }
          if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
            currentToolInput += event.delta.partial_json;
          }
        }

        if (event?.type === 'content_block_stop') {
          if (currentToolName) {
            // AskUserQuestion → special event
            if (currentToolName === 'AskUserQuestion') {
              yield { type: 'ask_user', questionsJson: currentToolInput };
            }
            // Task tools → task event
            else if (TASK_TOOLS.has(currentToolName)) {
              yield { type: 'task', action: currentToolName, dataJson: currentToolInput };
            }
            // All other tools → tool_start
            else {
              yield { type: 'tool_start', toolName: currentToolName, toolInput: currentToolInput };
            }

            // Check if an image file was written/read
            const imagePath = extractImagePath(currentToolName, currentToolInput);
            if (imagePath) {
              yield { type: 'image_file', filePath: imagePath };
            }

            currentToolName = null;
            currentToolInput = '';
          }
        }
      }

      // Tool results (user messages containing tool_result blocks)
      if (message.type === 'user') {
        const content = (message as any).message?.content;
        let resultText = '';
        let toolName = '';
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result' && block.content) {
              if (typeof block.content === 'string') {
                resultText += block.content;
              } else if (Array.isArray(block.content)) {
                for (const sub of block.content) {
                  if (sub.type === 'text') resultText += sub.text;
                }
              }
            }
          }
        }
        if (resultText) {
          yield { type: 'tool_result', toolName, result: resultText };
        }
      }

      // Result message
      if (message.type === 'result') {
        const r = message as any;

        // Detect failure that should trigger retry
        if (r.subtype !== 'success' && !alreadyRetried && resumeId) {
          setRetry(true, false);
          break;
        }

        yield {
          type: 'result',
          success: r.subtype === 'success',
          costUsd: r.total_cost_usd ?? 0,
          durationMs: r.duration_ms ?? 0,
          numTurns: r.num_turns ?? 0,
          errors: r.errors ?? [],
        };
      }
    }
  }
}
