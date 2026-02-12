import {
  AttachmentBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  type TextChannel,
  type Message,
} from 'discord.js';
import { existsSync } from 'node:fs';
import type { ProviderEvent, ProviderName } from './providers/types.ts';
import { resetProviderSession } from './session-manager.ts';
import { splitMessage, truncate, detectNumberedOptions, detectYesNoPrompt } from './utils.ts';
import type { ExpandableContent } from './types.ts';
import {
  renderCommandExecutionEmbed,
  renderFileChangesEmbed,
  renderReasoningEmbed,
  renderCodexTodoListEmbed,
} from './codex-renderer.ts';

// Abort detection — the SDK throws various errors on user cancellation
const ABORT_PATTERNS = ['abort', 'cancel', 'interrupt', 'killed', 'signal'];

function isAbortLike(err: unknown): boolean {
  if ((err as Error).name === 'AbortError') return true;
  const msg = ((err as Error).message || '').toLowerCase();
  return ABORT_PATTERNS.some(p => msg.includes(p));
}

function isAbortError(errors: string[]): boolean {
  return errors.some(e => ABORT_PATTERNS.some(p => e.toLowerCase().includes(p)));
}

// In-memory store for expandable content (with TTL cleanup)
const expandableStore = new Map<string, ExpandableContent>();
let expandCounter = 0;

// Pending answers for multi-question AskUserQuestion (sessionId → questionIndex → answer)
const pendingAnswersStore = new Map<string, Map<number, string>>();
// Total question count per session for multi-question flows
const questionCountStore = new Map<string, number>();

export function setPendingAnswer(sessionId: string, questionIndex: number, answer: string): void {
  if (!pendingAnswersStore.has(sessionId)) {
    pendingAnswersStore.set(sessionId, new Map());
  }
  pendingAnswersStore.get(sessionId)!.set(questionIndex, answer);
}

export function getPendingAnswers(sessionId: string): Map<number, string> | undefined {
  return pendingAnswersStore.get(sessionId);
}

export function clearPendingAnswers(sessionId: string): void {
  pendingAnswersStore.delete(sessionId);
  questionCountStore.delete(sessionId);
}

export function getQuestionCount(sessionId: string): number {
  return questionCountStore.get(sessionId) || 0;
}

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

export function makeModeButtons(sessionId: string, currentMode: string): ActionRowBuilder<ButtonBuilder> {
  const modes = [
    { id: 'auto', label: '\u26A1 Auto' },
    { id: 'plan', label: '\uD83D\uDCCB Plan' },
    { id: 'normal', label: '\uD83D\uDEE1\uFE0F Normal' },
  ];

  const row = new ActionRowBuilder<ButtonBuilder>();
  for (const m of modes) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`mode:${sessionId}:${m.id}`)
        .setLabel(m.label)
        .setStyle(m.id === currentMode ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(m.id === currentMode),
    );
  }
  return row;
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

function shouldSuppressCommandExecution(command: string): boolean {
  const normalized = command.toLowerCase();
  return normalized.includes('total-recall');
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

  /** Discard accumulated text and delete the live message if one exists */
  async discard(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.flushing) {
      await new Promise(r => setTimeout(r, 50));
    }
    if (this.currentMessage) {
      try { await this.currentMessage.delete(); } catch { /* already deleted */ }
      this.currentMessage = null;
    }
    this.currentText = '';
    this.dirty = false;
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

// Task tool rendering helpers (for Claude's TaskCreate/TaskUpdate/TaskList/TaskGet)

const STATUS_EMOJI: Record<string, string> = {
  pending: '\u2B1C',       // white square
  in_progress: '\uD83D\uDD04', // arrows
  completed: '\u2705',     // check
  deleted: '\uD83D\uDDD1\uFE0F',  // wastebasket
};

function renderTaskToolEmbed(action: string, dataJson: string): EmbedBuilder | null {
  try {
    const data = JSON.parse(dataJson);

    if (action === 'TaskCreate') {
      const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle('\uD83D\uDCCB New Task')
        .setDescription(`**${data.subject || 'Untitled'}**`);
      if (data.description) {
        embed.addFields({ name: 'Details', value: truncate(data.description, 300) });
      }
      return embed;
    }

    if (action === 'TaskUpdate') {
      const emoji = STATUS_EMOJI[data.status] || '\uD83D\uDCCB';
      const parts: string[] = [];
      if (data.status) parts.push(`${emoji} **${data.status}**`);
      if (data.subject) parts.push(data.subject);
      return new EmbedBuilder()
        .setColor(data.status === 'completed' ? 0x2ecc71 : 0xf39c12)
        .setTitle(`Task #${data.taskId || '?'} Updated`)
        .setDescription(parts.join(' \u2014 ') || 'Updated');
    }

    return null;
  } catch {
    return null;
  }
}

function renderTaskListEmbed(resultText: string): EmbedBuilder | null {
  if (!resultText.trim()) return null;

  let formatted = resultText;
  for (const [status, emoji] of Object.entries(STATUS_EMOJI)) {
    formatted = formatted.replaceAll(status, `${emoji} ${status}`);
  }

  return new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('\uD83D\uDCCB Task Board')
    .setDescription(truncate(formatted, 4000));
}

function renderAskUserQuestion(
  questionsJson: string,
  sessionId: string,
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] } | null {
  try {
    const data = JSON.parse(questionsJson);
    const questions: Array<{
      question: string;
      header?: string;
      options?: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }> = data.questions;
    if (!questions?.length) return null;

    const isMulti = questions.length > 1;

    if (isMulti) {
      clearPendingAnswers(sessionId);
      questionCountStore.set(sessionId, questions.length);
    }

    const embeds: EmbedBuilder[] = [];
    const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

    const btnPrefix = isMulti ? 'pick' : 'answer';
    const selectPrefix = isMulti ? 'pick-select' : 'answer-select';

    for (let qi = 0; qi < questions.length; qi++) {
      const q = questions[qi];
      const embed = new EmbedBuilder()
        .setColor(0xf39c12)
        .setTitle(q.header || 'Question')
        .setDescription(q.question);

      if (q.options?.length) {
        if (q.options.length <= 4) {
          const row = new ActionRowBuilder<ButtonBuilder>();
          for (let i = 0; i < q.options.length; i++) {
            row.addComponents(
              new ButtonBuilder()
                .setCustomId(`${btnPrefix}:${sessionId}:${qi}:${q.options[i].label}`)
                .setLabel(q.options[i].label.slice(0, 80))
                .setStyle(i === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary),
            );
          }
          components.push(row);
        } else {
          const menu = new StringSelectMenuBuilder()
            .setCustomId(`${selectPrefix}:${sessionId}:${qi}`)
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

        const optionLines = q.options
          .map(o => o.description ? `**${o.label}** \u2014 ${o.description}` : `**${o.label}**`)
          .join('\n');
        embed.addFields({ name: 'Options', value: truncate(optionLines, 1000) });
      }

      embeds.push(embed);
    }

    if (isMulti) {
      components.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`submit-answers:${sessionId}`)
            .setLabel('Submit Answers')
            .setStyle(ButtonStyle.Success),
        ),
      );
    }

    return { embeds, components };
  } catch {
    return null;
  }
}

export async function handleOutputStream(
  stream: AsyncGenerator<ProviderEvent>,
  channel: TextChannel,
  sessionId: string,
  verbose = false,
  mode = 'auto',
  _provider: ProviderName = 'claude',
): Promise<void> {
  const streamer = new MessageStreamer(channel, sessionId);
  let lastToolName: string | null = null;

  // Show "typing..." indicator while the agent is working
  channel.sendTyping().catch(() => {});
  const typingInterval = setInterval(() => {
    channel.sendTyping().catch(() => {});
  }, 8000);

  try {
    for await (const event of stream) {
      switch (event.type) {
        case 'text_delta': {
          streamer.append(event.text);
          break;
        }

        case 'ask_user': {
          // Discard any streamed text before the question (Claude streams partial text before tool)
          await streamer.discard();
          const rendered = renderAskUserQuestion(event.questionsJson, sessionId);
          if (rendered) {
            rendered.components.push(makeStopButton(sessionId));
            await channel.send({ embeds: rendered.embeds, components: rendered.components });
          }
          break;
        }

        case 'task': {
          await streamer.finalize();
          const isTaskResult = event.action === 'TaskList' || event.action === 'TaskGet';
          if (!isTaskResult) {
            const taskEmbed = renderTaskToolEmbed(event.action, event.dataJson);
            if (taskEmbed) {
              await channel.send({
                embeds: [taskEmbed],
                components: [makeStopButton(sessionId)],
              });
            }
          }
          lastToolName = event.action;
          break;
        }

        case 'tool_start': {
          await streamer.finalize();
          if (verbose) {
            const displayInput = event.toolInput.length > 1000
              ? truncate(event.toolInput, 1000)
              : event.toolInput;

            const embed = new EmbedBuilder()
              .setColor(0x3498db)
              .setTitle(`Tool: ${event.toolName}`)
              .setDescription(`\`\`\`json\n${displayInput}\n\`\`\``);

            const components: ActionRowBuilder<ButtonBuilder>[] = [makeStopButton(sessionId)];

            if (event.toolInput.length > 1000) {
              const contentId = storeExpandable(event.toolInput);
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
          lastToolName = event.toolName;
          break;
        }

        case 'tool_result': {
          const isTaskResult = lastToolName !== null &&
            (lastToolName === 'TaskList' || lastToolName === 'TaskGet');
          const showResult = verbose || isTaskResult;
          if (!showResult) break;

          await streamer.finalize();

          if (isTaskResult && !verbose) {
            const boardEmbed = renderTaskListEmbed(event.result);
            if (boardEmbed) {
              await channel.send({
                embeds: [boardEmbed],
                components: [makeStopButton(sessionId)],
              });
            }
          } else if (event.result) {
            const displayResult = event.result.length > 1000
              ? truncate(event.result, 1000)
              : event.result;

            const embed = new EmbedBuilder()
              .setColor(0x1abc9c)
              .setTitle('Tool Result')
              .setDescription(`\`\`\`\n${displayResult}\n\`\`\``);

            const components: ActionRowBuilder<ButtonBuilder>[] = [makeStopButton(sessionId)];

            if (event.result.length > 1000) {
              const contentId = storeExpandable(event.result);
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
          break;
        }

        case 'image_file': {
          if (existsSync(event.filePath)) {
            await streamer.finalize();
            const attachment = new AttachmentBuilder(event.filePath);
            await channel.send({ files: [attachment] });
          }
          break;
        }

        // ── Codex-specific events ──

        case 'command_execution': {
          if (shouldSuppressCommandExecution(event.command)) break;
          await streamer.finalize();
          const embed = renderCommandExecutionEmbed(event);
          await channel.send({
            embeds: [embed],
            components: [makeStopButton(sessionId)],
          });
          break;
        }

        case 'file_change': {
          await streamer.finalize();
          const embed = renderFileChangesEmbed(event);
          await channel.send({
            embeds: [embed],
            components: [makeStopButton(sessionId)],
          });
          break;
        }

        case 'reasoning': {
          if (verbose) {
            await streamer.finalize();
            const embed = renderReasoningEmbed(event);
            await channel.send({
              embeds: [embed],
              components: [makeStopButton(sessionId)],
            });
          }
          break;
        }

        case 'todo_list': {
          await streamer.finalize();
          const embed = renderCodexTodoListEmbed(event);
          await channel.send({
            embeds: [embed],
            components: [makeStopButton(sessionId)],
          });
          break;
        }

        // ── Shared events ──

        case 'result': {
          const lastText = streamer.getText();

          const cost = event.costUsd.toFixed(4);
          const duration = event.durationMs
            ? `${(event.durationMs / 1000).toFixed(1)}s`
            : 'unknown';
          const turns = event.numTurns || 0;
          const modeLabel = ({ auto: 'Auto', plan: 'Plan', normal: 'Normal' } as Record<string, string>)[mode] || 'Auto';

          const statusLine = event.success
            ? `-# $${cost} | ${duration} | ${turns} turns | ${modeLabel}`
            : `-# Error | $${cost} | ${duration} | ${turns} turns`;

          streamer.append(`\n${statusLine}`);

          if (!event.success && event.errors.length) {
            streamer.append(`\n\`\`\`\n${event.errors.join('\n')}\n\`\`\``);
          }

          // Auto-reset provider session on failure so next message starts fresh
          // But don't reset on user-initiated aborts — the session is still valid
          if (!event.success && !isAbortError(event.errors)) {
            resetProviderSession(sessionId);
            streamer.append('\n-# Session reset — next message will start a fresh provider session.');
          }

          await streamer.finalize();

          const components: (ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>)[] = [];

          const checkText = lastText || '';
          const options = detectNumberedOptions(checkText);
          if (options) {
            components.push(...makeOptionButtons(sessionId, options));
          } else if (detectYesNoPrompt(checkText)) {
            components.push(makeYesNoButtons(sessionId));
          }

          components.push(makeModeButtons(sessionId, mode));
          components.push(makeCompletionButtons(sessionId));

          await channel.send({ components });
          break;
        }

        case 'error': {
          await streamer.finalize();
          const embed = new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle('Error')
            .setDescription(`\`\`\`\n${event.message}\n\`\`\``);
          await channel.send({ embeds: [embed] });
          break;
        }

        case 'session_init': {
          // Handled by session-manager, no Discord output needed
          break;
        }
      }
    }
  } catch (err: unknown) {
    await streamer.finalize();

    const errMsg = (err as Error).message || '';
    if (!isAbortLike(err)) {
      resetProviderSession(sessionId);
      const embed = new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle('Error')
        .setDescription(`\`\`\`\n${errMsg}\n\`\`\`\n-# Session reset — next message will start a fresh provider session.`);
      await channel.send({ embeds: [embed] });
    }
  } finally {
    clearInterval(typingInterval);
    streamer.destroy();
  }
}
