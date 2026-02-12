import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  type TextChannel,
} from 'discord.js';
import { config } from './config.ts';
import * as sessions from './session-manager.ts';
import {
  handleOutputStream,
  getExpandableContent,
  makeModeButtons,
  setPendingAnswer,
  getPendingAnswers,
  clearPendingAnswers,
  getQuestionCount,
} from './output-handler.ts';
import { isUserAllowed, truncate } from './utils.ts';

export async function handleButton(interaction: ButtonInteraction): Promise<void> {
  if (!isUserAllowed(interaction.user.id, config.allowedUsers, config.allowAllUsers)) {
    await interaction.reply({ content: 'Not authorized.', ephemeral: true });
    return;
  }

  const customId = interaction.customId;

  // Stop button
  if (customId.startsWith('stop:')) {
    const sessionId = customId.slice(5);
    const stopped = sessions.abortSession(sessionId);
    await interaction.reply({
      content: stopped ? 'Generation stopped.' : 'Session was not generating.',
      ephemeral: true,
    });
    return;
  }

  // Continue button
  if (customId.startsWith('continue:')) {
    const sessionId = customId.slice(9);
    const session = sessions.getSession(sessionId);
    if (!session) {
      await interaction.reply({ content: 'Session not found.', ephemeral: true });
      return;
    }
    if (session.isGenerating) {
      await interaction.reply({ content: 'Session is already generating.', ephemeral: true });
      return;
    }

    await interaction.deferReply();
    try {
      const channel = interaction.channel as TextChannel;
      const stream = sessions.continueSession(sessionId);
      await interaction.editReply('Continuing...');
      await handleOutputStream(stream, channel, sessionId, session.verbose, session.mode, session.provider);
    } catch (err: unknown) {
      await interaction.editReply(`Error: ${(err as Error).message}`);
    }
    return;
  }

  // Expand button
  if (customId.startsWith('expand:')) {
    const contentId = customId.slice(7);
    const content = getExpandableContent(contentId);
    if (!content) {
      await interaction.reply({ content: 'Content expired.', ephemeral: true });
      return;
    }
    // Discord max message is 2000 chars
    const display = truncate(content, 1950);
    await interaction.reply({ content: `\`\`\`\n${display}\n\`\`\``, ephemeral: true });
    return;
  }

  // Option buttons (numbered choices)
  if (customId.startsWith('option:')) {
    const parts = customId.split(':');
    const sessionId = parts[1];
    const optionIndex = parseInt(parts[2], 10);

    const session = sessions.getSession(sessionId);
    if (!session) {
      await interaction.reply({ content: 'Session not found.', ephemeral: true });
      return;
    }

    // Send the option number as input
    const optionText = `${optionIndex + 1}`;
    await interaction.deferReply();
    try {
      const channel = interaction.channel as TextChannel;
      const stream = sessions.sendPrompt(sessionId, optionText);
      await interaction.editReply(`Selected option ${optionIndex + 1}`);
      await handleOutputStream(stream, channel, sessionId, session.verbose, session.mode, session.provider);
    } catch (err: unknown) {
      await interaction.editReply(`Error: ${(err as Error).message}`);
    }
    return;
  }

  // Multi-question: collect an answer without submitting
  if (customId.startsWith('pick:')) {
    const parts = customId.split(':');
    const sessionId = parts[1];
    const questionIndex = parseInt(parts[2], 10);
    const answer = parts.slice(3).join(':');

    const session = sessions.getSession(sessionId);
    if (!session) {
      await interaction.reply({ content: 'Session not found.', ephemeral: true });
      return;
    }

    setPendingAnswer(sessionId, questionIndex, answer);

    const totalQuestions = getQuestionCount(sessionId);
    const pending = getPendingAnswers(sessionId);
    const answeredCount = pending?.size || 0;

    // Update the original message to highlight the selected option
    try {
      const original = interaction.message;
      const updatedComponents = original.components.map((row: any) => {
        const firstComponent = row.components?.[0];
        if (!firstComponent?.customId?.startsWith('pick:')) return row;
        // Check if this row belongs to the current question
        const rowQi = parseInt(firstComponent.customId.split(':')[2], 10);
        if (rowQi !== questionIndex) return row;

        const newRow = new ActionRowBuilder<ButtonBuilder>();
        for (const btn of row.components) {
          const btnAnswer = btn.customId.split(':').slice(3).join(':');
          const isSelected = btnAnswer === answer;
          newRow.addComponents(
            new ButtonBuilder()
              .setCustomId(btn.customId)
              .setLabel(btn.label)
              .setStyle(isSelected ? ButtonStyle.Success : ButtonStyle.Secondary),
          );
        }
        return newRow;
      });
      await original.edit({ components: updatedComponents as any });
    } catch { /* message may be deleted */ }

    await interaction.reply({
      content: `Selected for Q${questionIndex + 1}: **${truncate(answer, 100)}** (${answeredCount}/${totalQuestions} answered)`,
      ephemeral: true,
    });
    return;
  }

  // Multi-question: submit all collected answers
  if (customId.startsWith('submit-answers:')) {
    const sessionId = customId.slice(15);

    const session = sessions.getSession(sessionId);
    if (!session) {
      await interaction.reply({ content: 'Session not found.', ephemeral: true });
      return;
    }

    const totalQuestions = getQuestionCount(sessionId);
    const pending = getPendingAnswers(sessionId);

    if (!pending || pending.size === 0) {
      await interaction.reply({ content: 'No answers selected yet. Pick an answer for each question first.', ephemeral: true });
      return;
    }

    // Build a formatted answer string
    const answerLines: string[] = [];
    for (let i = 0; i < totalQuestions; i++) {
      const ans = pending.get(i);
      answerLines.push(`Q${i + 1}: ${ans || '(no answer)'}`);
    }
    const combined = answerLines.join('\n');

    clearPendingAnswers(sessionId);

    await interaction.deferReply();
    try {
      const channel = interaction.channel as TextChannel;
      const stream = sessions.sendPrompt(sessionId, combined);
      await interaction.editReply(`Submitted answers:\n${combined}`);
      await handleOutputStream(stream, channel, sessionId, session.verbose, session.mode, session.provider);
    } catch (err: unknown) {
      await interaction.editReply(`Error: ${(err as Error).message}`);
    }
    return;
  }

  // AskUserQuestion answer buttons (single question — immediate submit)
  if (customId.startsWith('answer:')) {
    const parts = customId.split(':');
    const sessionId = parts[1];
    // Format: answer:sessionId:questionIndex:label (questionIndex is numeric)
    const hasQuestionIndex = /^\d+$/.test(parts[2]);
    const answer = hasQuestionIndex ? parts.slice(3).join(':') : parts.slice(2).join(':');

    const session = sessions.getSession(sessionId);
    if (!session) {
      await interaction.reply({ content: 'Session not found.', ephemeral: true });
      return;
    }

    await interaction.deferReply();
    try {
      const channel = interaction.channel as TextChannel;
      const stream = sessions.sendPrompt(sessionId, answer);
      await interaction.editReply(`Answered: **${truncate(answer, 100)}**`);
      await handleOutputStream(stream, channel, sessionId, session.verbose, session.mode, session.provider);
    } catch (err: unknown) {
      await interaction.editReply(`Error: ${(err as Error).message}`);
    }
    return;
  }

  // Confirm buttons (yes/no)
  if (customId.startsWith('confirm:')) {
    const parts = customId.split(':');
    const sessionId = parts[1];
    const answer = parts[2]; // 'yes' or 'no'

    const session = sessions.getSession(sessionId);
    if (!session) {
      await interaction.reply({ content: 'Session not found.', ephemeral: true });
      return;
    }

    await interaction.deferReply();
    try {
      const channel = interaction.channel as TextChannel;
      const stream = sessions.sendPrompt(sessionId, answer);
      await interaction.editReply(`Answered: ${answer}`);
      await handleOutputStream(stream, channel, sessionId, session.verbose, session.mode, session.provider);
    } catch (err: unknown) {
      await interaction.editReply(`Error: ${(err as Error).message}`);
    }
    return;
  }

  // Mode switch buttons
  if (customId.startsWith('mode:')) {
    const parts = customId.split(':');
    const sessionId = parts[1];
    const newMode = parts[2] as 'auto' | 'plan' | 'normal';

    const session = sessions.getSession(sessionId);
    if (!session) {
      await interaction.reply({ content: 'Session not found.', ephemeral: true });
      return;
    }

    sessions.setMode(sessionId, newMode);

    const labels: Record<string, string> = {
      auto: '\u26A1 Auto — full autonomy',
      plan: '\uD83D\uDCCB Plan — plans before changes',
      normal: '\uD83D\uDEE1\uFE0F Normal — asks before destructive ops',
    };

    await interaction.reply({
      content: `Mode switched to **${labels[newMode]}**`,
      ephemeral: true,
    });

    // Update the original message's mode buttons
    try {
      const original = interaction.message;
      const updatedComponents = original.components.map((row: any) => {
        const first = row.components?.[0];
        if (first?.customId?.startsWith('mode:')) {
          return makeModeButtons(sessionId, newMode);
        }
        return row;
      });
      await original.edit({ components: updatedComponents as any });
    } catch { /* message may be deleted */ }

    return;
  }

  await interaction.reply({ content: 'Unknown button.', ephemeral: true });
}

export async function handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!isUserAllowed(interaction.user.id, config.allowedUsers, config.allowAllUsers)) {
    await interaction.reply({ content: 'Not authorized.', ephemeral: true });
    return;
  }

  const customId = interaction.customId;

  // Multi-question: collect a select menu answer without submitting
  if (customId.startsWith('pick-select:')) {
    // Format: pick-select:sessionId:questionIndex
    const parts = customId.split(':');
    const sessionId = parts[1];
    const questionIndex = parseInt(parts[2], 10);
    const selected = interaction.values[0];

    const session = sessions.getSession(sessionId);
    if (!session) {
      await interaction.reply({ content: 'Session not found.', ephemeral: true });
      return;
    }

    setPendingAnswer(sessionId, questionIndex, selected);

    const totalQuestions = getQuestionCount(sessionId);
    const pending = getPendingAnswers(sessionId);
    const answeredCount = pending?.size || 0;

    // Update the original message's select menu placeholder to show selection
    try {
      const original = interaction.message;
      const updatedComponents = original.components.map((row: any) => {
        const comp = row.components?.[0];
        if (comp?.customId !== customId) return row;
        // Rebuild the select menu with updated placeholder
        const menu = new StringSelectMenuBuilder()
          .setCustomId(customId)
          .setPlaceholder(`Selected: ${selected.slice(0, 80)}`);
        for (const opt of comp.options) {
          menu.addOptions({
            label: opt.label,
            description: opt.description || undefined,
            value: opt.value,
            default: opt.value === selected,
          });
        }
        return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
      });
      await original.edit({ components: updatedComponents as any });
    } catch { /* message may be deleted */ }

    await interaction.reply({
      content: `Selected for Q${questionIndex + 1}: **${truncate(selected, 100)}** (${answeredCount}/${totalQuestions} answered)`,
      ephemeral: true,
    });
    return;
  }

  if (customId.startsWith('answer-select:')) {
    // Format: answer-select:sessionId or answer-select:sessionId:questionIndex
    const afterPrefix = customId.slice(14);
    const sessionId = afterPrefix.includes(':') ? afterPrefix.split(':')[0] : afterPrefix;
    const selected = interaction.values[0];

    const session = sessions.getSession(sessionId);
    if (!session) {
      await interaction.reply({ content: 'Session not found.', ephemeral: true });
      return;
    }

    await interaction.deferReply();
    try {
      const channel = interaction.channel as TextChannel;
      const stream = sessions.sendPrompt(sessionId, selected);
      await interaction.editReply(`Answered: **${truncate(selected, 100)}**`);
      await handleOutputStream(stream, channel, sessionId, session.verbose, session.mode, session.provider);
    } catch (err: unknown) {
      await interaction.editReply(`Error: ${(err as Error).message}`);
    }
    return;
  }

  if (customId.startsWith('select:')) {
    const sessionId = customId.slice(7);
    const selected = interaction.values[0];

    const session = sessions.getSession(sessionId);
    if (!session) {
      await interaction.reply({ content: 'Session not found.', ephemeral: true });
      return;
    }

    await interaction.deferReply();
    try {
      const channel = interaction.channel as TextChannel;
      const stream = sessions.sendPrompt(sessionId, selected);
      await interaction.editReply(`Selected: ${truncate(selected, 100)}`);
      await handleOutputStream(stream, channel, sessionId, session.verbose, session.mode, session.provider);
    } catch (err: unknown) {
      await interaction.editReply(`Error: ${(err as Error).message}`);
    }
    return;
  }

  await interaction.reply({ content: 'Unknown selection.', ephemeral: true });
}
