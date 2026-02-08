import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  type TextChannel,
  type Message,
} from 'discord.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { splitMessage, truncate, detectNumberedOptions, detectYesNoPrompt } from './utils.ts';
import type { ExpandableContent } from './types.ts';

// In-memory store for expandable content (with TTL cleanup)
const expandableStore = new Map<string, ExpandableContent>();
let expandCounter = 0;

// Clean up expired expandable content every 5 minutes
setInterval(() => {
  const now = Date.now();
  const TTL = 10 * 60 * 1000; // 10 minutes
  for (const [key, val] of expandableStore) {
    if (now - val.createdAt > TTL) expandableStore.delete(key);
  }
}, 5 * 60 * 1000);

export function getExpandableContent(id: string): string | undefined {
  return expandableStore.get(id)?.content;
}

function storeExpandable(content: string): string {
  const id = `exp_${++expandCounter}`;
  expandableStore.set(id, { content, createdAt: Date.now() });
  return id;
}

function makeStopButton(sessionId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`stop:${sessionId}`)
      .setLabel('Stop')
      .setStyle(ButtonStyle.Danger),
  );
}

function makeCompletionButtons(sessionId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`continue:${sessionId}`)
      .setLabel('Continue')
      .setStyle(ButtonStyle.Primary),
  );
}

function makeOptionButtons(sessionId: string, options: string[]): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const maxOptions = Math.min(options.length, 10);

  for (let i = 0; i < maxOptions; i += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    const chunk = options.slice(i, i + 5);
    for (let j = 0; j < chunk.length; j++) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`option:${sessionId}:${i + j}`)
          .setLabel(truncate(chunk[j], 80))
          .setStyle(ButtonStyle.Secondary),
      );
    }
    rows.push(row);
  }

  return rows;
}

function makeYesNoButtons(sessionId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm:${sessionId}:yes`)
      .setLabel('Yes')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`confirm:${sessionId}:no`)
      .setLabel('No')
      .setStyle(ButtonStyle.Danger),
  );
}

/**
 * Serialized message editor — ensures only one Discord API call is in-flight
 * at a time, preventing duplicate messages from race conditions.
 */
class MessageStreamer {
  private channel: TextChannel;
  private sessionId: string;
  private currentMessage: Message | null = null;
  private currentText = '';
  private dirty = false;
  private flushing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly INTERVAL = 400; // ms between edits

  constructor(channel: TextChannel, sessionId: string) {
    this.channel = channel;
    this.sessionId = sessionId;
  }

  append(text: string): void {
    this.currentText += text;
    this.dirty = true;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer || this.flushing) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.INTERVAL);
  }

  private async flush(): Promise<void> {
    if (this.flushing || !this.dirty) return;
    this.flushing = true;

    try {
      // Snapshot what we need to send
      const text = this.currentText;
      this.dirty = false;

      const chunks = splitMessage(text);
      const lastChunk = chunks[chunks.length - 1];

      // If text overflows into multiple chunks, finalize earlier ones
      if (chunks.length > 1 && this.currentMessage) {
        try {
          await this.currentMessage.edit({ content: chunks[0], components: [] });
        } catch { /* deleted */ }
        this.currentMessage = null;

        for (let i = 1; i < chunks.length - 1; i++) {
          await this.channel.send(chunks[i]);
        }
      }

      // Edit or create the live message with the last chunk
      if (this.currentMessage) {
        try {
          await this.currentMessage.edit({
            content: lastChunk,
            components: [makeStopButton(this.sessionId)],
          });
        } catch { /* deleted */ }
      } else {
        this.currentMessage = await this.channel.send({
          content: lastChunk,
          components: [makeStopButton(this.sessionId)],
        });
      }
    } finally {
      this.flushing = false;
      // If more text arrived while we were flushing, schedule again
      if (this.dirty) {
        this.scheduleFlush();
      }
    }
  }

  /** Flush remaining text and remove the stop button */
  async finalize(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // Wait for any in-flight flush to finish
    while (this.flushing) {
      await new Promise(r => setTimeout(r, 50));
    }

    // Do a final flush if there's pending text
    if (this.dirty) {
      this.dirty = false;
      const text = this.currentText;
      const chunks = splitMessage(text);
      const lastChunk = chunks[chunks.length - 1];

      if (chunks.length > 1 && this.currentMessage) {
        try {
          await this.currentMessage.edit({ content: chunks[0], components: [] });
        } catch { /* deleted */ }
        this.currentMessage = null;
        for (let i = 1; i < chunks.length - 1; i++) {
          await this.channel.send(chunks[i]);
        }
      }

      if (this.currentMessage) {
        try {
          await this.currentMessage.edit({ content: lastChunk, components: [] });
        } catch { /* deleted */ }
      } else if (lastChunk) {
        this.currentMessage = await this.channel.send({ content: lastChunk });
      }
    } else if (this.currentMessage) {
      // Just remove the stop button
      try {
        await this.currentMessage.edit({
          content: this.currentMessage.content || '',
          components: [],
        });
      } catch { /* deleted */ }
    }

    this.currentMessage = null;
    this.currentText = '';
  }

  getText(): string {
    return this.currentText;
  }

  destroy(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

// Tools that ask for user input — always shown regardless of verbose mode
const USER_FACING_TOOLS = new Set([
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
]);

// Task management tools — rendered as a visual board
const TASK_TOOLS = new Set([
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
]);

const STATUS_EMOJI: Record<string, string> = {
  pending: '\u2B1C',       // white square
  in_progress: '\uD83D\uDD04', // arrows
  completed: '\u2705',     // check
  deleted: '\uD83D\uDDD1\uFE0F',  // wastebasket
};

function renderAskUserQuestion(
  toolInput: string,
  sessionId: string,
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] } | null {
  try {
    const data = JSON.parse(toolInput);
    const questions: Array<{
      question: string;
      header?: string;
      options?: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }> = data.questions;
    if (!questions?.length) return null;

    const embeds: EmbedBuilder[] = [];
    const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

    for (const q of questions) {
      const embed = new EmbedBuilder()
        .setColor(0xf39c12)
        .setTitle(q.header || 'Question')
        .setDescription(q.question);

      if (q.options?.length) {
        // If 4 or fewer options, use buttons
        if (q.options.length <= 4) {
          const row = new ActionRowBuilder<ButtonBuilder>();
          for (let i = 0; i < q.options.length; i++) {
            row.addComponents(
              new ButtonBuilder()
                .setCustomId(`answer:${sessionId}:${q.options[i].label}`)
                .setLabel(q.options[i].label.slice(0, 80))
                .setStyle(i === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary),
            );
          }
          components.push(row);
        } else {
          // Use a select menu for more options
          const menu = new StringSelectMenuBuilder()
            .setCustomId(`answer-select:${sessionId}`)
            .setPlaceholder('Select an option...');
          for (const opt of q.options) {
            menu.addOptions({
              label: opt.label.slice(0, 100),
              description: opt.description?.slice(0, 100),
              value: opt.label,
            });
          }
          components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
        }

        // Add descriptions to the embed
        const optionLines = q.options
          .map(o => o.description ? `**${o.label}** — ${o.description}` : `**${o.label}**`)
          .join('\n');
        embed.addFields({ name: 'Options', value: truncate(optionLines, 1000) });
      }

      embeds.push(embed);
    }

    return { embeds, components };
  } catch {
    return null;
  }
}

function renderTaskToolEmbed(toolName: string, toolInput: string): EmbedBuilder | null {
  try {
    const data = JSON.parse(toolInput);

    if (toolName === 'TaskCreate') {
      const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle('\uD83D\uDCCB New Task')
        .setDescription(`**${data.subject || 'Untitled'}**`);
      if (data.description) {
        embed.addFields({ name: 'Details', value: truncate(data.description, 300) });
      }
      return embed;
    }

    if (toolName === 'TaskUpdate') {
      const emoji = STATUS_EMOJI[data.status] || '\uD83D\uDCCB';
      const parts: string[] = [];
      if (data.status) parts.push(`${emoji} **${data.status}**`);
      if (data.subject) parts.push(data.subject);
      return new EmbedBuilder()
        .setColor(data.status === 'completed' ? 0x2ecc71 : 0xf39c12)
        .setTitle(`Task #${data.taskId || '?'} Updated`)
        .setDescription(parts.join(' — ') || 'Updated');
    }

    return null;
  } catch {
    return null;
  }
}

function renderTaskListEmbed(resultText: string): EmbedBuilder | null {
  if (!resultText.trim()) return null;

  // Replace status keywords with emojis for visual clarity
  let formatted = resultText;
  for (const [status, emoji] of Object.entries(STATUS_EMOJI)) {
    formatted = formatted.replaceAll(status, `${emoji} ${status}`);
  }

  return new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('\uD83D\uDCCB Task Board')
    .setDescription(truncate(formatted, 4000));
}

export async function handleOutputStream(
  stream: AsyncGenerator<SDKMessage>,
  channel: TextChannel,
  sessionId: string,
  verbose = false,
): Promise<void> {
  const streamer = new MessageStreamer(channel, sessionId);
  let currentToolName: string | null = null;
  let currentToolInput = '';
  let lastFinishedToolName: string | null = null;

  // Show "typing..." indicator while the agent is working
  channel.sendTyping().catch(() => {});
  const typingInterval = setInterval(() => {
    channel.sendTyping().catch(() => {});
  }, 8000);

  try {
    for await (const message of stream) {
      if (message.type === 'stream_event') {
        const event = (message as any).event;

        if (event?.type === 'content_block_start') {
          if (event.content_block?.type === 'tool_use') {
            await streamer.finalize();
            currentToolName = event.content_block.name || 'tool';
            currentToolInput = '';
          }
        }

        if (event?.type === 'content_block_delta') {
          if (event.delta?.type === 'text_delta' && event.delta.text) {
            streamer.append(event.delta.text);
          }
          if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
            currentToolInput += event.delta.partial_json;
          }
        }

        if (event?.type === 'content_block_stop') {
          if (currentToolName) {
            const isUserFacing = USER_FACING_TOOLS.has(currentToolName);
            const isTaskTool = TASK_TOOLS.has(currentToolName);
            const showTool = verbose || isUserFacing || isTaskTool;

            if (showTool) {
              // Task tools get a special visual render
              const taskEmbed = isTaskTool
                ? renderTaskToolEmbed(currentToolName, currentToolInput)
                : null;

              if (taskEmbed) {
                await channel.send({
                  embeds: [taskEmbed],
                  components: [makeStopButton(sessionId)],
                });
              } else if (currentToolName === 'AskUserQuestion') {
                const rendered = renderAskUserQuestion(currentToolInput, sessionId);
                if (rendered) {
                  rendered.components.push(makeStopButton(sessionId));
                  await channel.send({ embeds: rendered.embeds, components: rendered.components });
                }
              } else if (!isTaskTool) {
                // Regular tool or other user-facing tool — show raw JSON
                const toolInput = currentToolInput;
                const displayInput = toolInput.length > 1000
                  ? truncate(toolInput, 1000)
                  : toolInput;

                const embed = new EmbedBuilder()
                  .setColor(isUserFacing ? 0xf39c12 : 0x3498db)
                  .setTitle(isUserFacing
                    ? `Waiting for input: ${currentToolName}`
                    : `Tool: ${currentToolName}`)
                  .setDescription(`\`\`\`json\n${displayInput}\n\`\`\``);

                const components: ActionRowBuilder<ButtonBuilder>[] = [makeStopButton(sessionId)];

                if (toolInput.length > 1000) {
                  const contentId = storeExpandable(toolInput);
                  components.unshift(
                    new ActionRowBuilder<ButtonBuilder>().addComponents(
                      new ButtonBuilder()
                        .setCustomId(`expand:${contentId}`)
                        .setLabel('Show Full Input')
                        .setStyle(ButtonStyle.Secondary),
                    ),
                  );
                }

                await channel.send({ embeds: [embed], components });
              }
            }

            lastFinishedToolName = currentToolName;
            currentToolName = null;
            currentToolInput = '';
          }
        }
      }

      if (message.type === 'user') {
        const showResult = verbose || (lastFinishedToolName !== null && TASK_TOOLS.has(lastFinishedToolName));
        if (!showResult) continue;

        await streamer.finalize();

        const content = (message as any).message?.content;
        let resultText = '';
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
          // TaskList/TaskGet results get a visual board embed
          const isTaskResult = lastFinishedToolName !== null && TASK_TOOLS.has(lastFinishedToolName);
          if (isTaskResult && !verbose) {
            const boardEmbed = renderTaskListEmbed(resultText);
            if (boardEmbed) {
              await channel.send({
                embeds: [boardEmbed],
                components: [makeStopButton(sessionId)],
              });
            }
          } else {
            const displayResult = resultText.length > 1000
              ? truncate(resultText, 1000)
              : resultText;

            const embed = new EmbedBuilder()
              .setColor(0x1abc9c)
              .setTitle('Tool Result')
              .setDescription(`\`\`\`\n${displayResult}\n\`\`\``);

            const components: ActionRowBuilder<ButtonBuilder>[] = [makeStopButton(sessionId)];

            if (resultText.length > 1000) {
              const contentId = storeExpandable(resultText);
              components.unshift(
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                  new ButtonBuilder()
                    .setCustomId(`expand:${contentId}`)
                    .setLabel('Show Full Output')
                    .setStyle(ButtonStyle.Secondary),
                  ),
                );
            }

            await channel.send({ embeds: [embed], components });
          }
        }
      }

      if (message.type === 'result') {
        const lastText = streamer.getText();
        await streamer.finalize();

        const result = message as any;
        const isSuccess = result.subtype === 'success';
        const cost = result.total_cost_usd?.toFixed(4) || '0.0000';
        const duration = result.duration_ms
          ? `${(result.duration_ms / 1000).toFixed(1)}s`
          : 'unknown';
        const turns = result.num_turns || 0;

        const embed = new EmbedBuilder()
          .setColor(isSuccess ? 0x2ecc71 : 0xe74c3c)
          .setTitle(isSuccess ? 'Completed' : 'Error')
          .addFields(
            { name: 'Cost', value: `$${cost}`, inline: true },
            { name: 'Duration', value: duration, inline: true },
            { name: 'Turns', value: `${turns}`, inline: true },
          );

        if (result.session_id) {
          embed.setFooter({ text: `Session: ${result.session_id}` });
        }

        if (!isSuccess && result.errors?.length) {
          embed.setDescription(result.errors.join('\n'));
        }

        const components: (ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>)[] = [];

        const checkText = lastText || (result.result as string) || '';
        const options = detectNumberedOptions(checkText);
        if (options) {
          components.push(...makeOptionButtons(sessionId, options));
        } else if (detectYesNoPrompt(checkText)) {
          components.push(makeYesNoButtons(sessionId));
        }

        components.push(makeCompletionButtons(sessionId));

        await channel.send({ embeds: [embed], components });
      }
    }
  } catch (err: unknown) {
    await streamer.finalize();

    if ((err as Error).name !== 'AbortError') {
      const embed = new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle('Error')
        .setDescription(`\`\`\`\n${(err as Error).message}\n\`\`\``);
      await channel.send({ embeds: [embed] });
    }
  } finally {
    clearInterval(typingInterval);
    streamer.destroy();
  }
}
