import type {
  ButtonInteraction,
  StringSelectMenuInteraction,
  TextChannel,
} from 'discord.js';
import { config } from './config.ts';
import * as sessions from './session-manager.ts';
import { handleOutputStream, getExpandableContent, makeModeButtons } from './output-handler.ts';
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
      await handleOutputStream(stream, channel, sessionId, session.verbose, session.mode);
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
      await handleOutputStream(stream, channel, sessionId, session.verbose, session.mode);
    } catch (err: unknown) {
      await interaction.editReply(`Error: ${(err as Error).message}`);
    }
    return;
  }

  // AskUserQuestion answer buttons
  if (customId.startsWith('answer:')) {
    const parts = customId.split(':');
    const sessionId = parts[1];
    const answer = parts.slice(2).join(':'); // label may contain colons

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
      await handleOutputStream(stream, channel, sessionId, session.verbose, session.mode);
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
      await handleOutputStream(stream, channel, sessionId, session.verbose, session.mode);
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

  if (customId.startsWith('answer-select:')) {
    const sessionId = customId.slice(14);
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
      await handleOutputStream(stream, channel, sessionId, session.verbose, session.mode);
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
      await handleOutputStream(stream, channel, sessionId, session.verbose, session.mode);
    } catch (err: unknown) {
      await interaction.editReply(`Error: ${(err as Error).message}`);
    }
    return;
  }

  await interaction.reply({ content: 'Unknown selection.', ephemeral: true });
}
