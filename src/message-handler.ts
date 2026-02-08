import type { Message, TextChannel } from 'discord.js';
import { config } from './config.ts';
import * as sessions from './session-manager.ts';
import { handleOutputStream } from './output-handler.ts';
import { isUserAllowed } from './utils.ts';

const userLastMessage = new Map<string, number>();

export async function handleMessage(message: Message): Promise<void> {
  if (message.author.bot) return;

  // Only handle messages in session channels
  const session = sessions.getSessionByChannel(message.channelId);
  if (!session) return;

  // Auth check
  if (!isUserAllowed(message.author.id, config.allowedUsers, config.allowAllUsers)) {
    return;
  }

  // Rate limit
  const now = Date.now();
  const lastMsg = userLastMessage.get(message.author.id) || 0;
  if (now - lastMsg < config.rateLimitMs) {
    await message.react('⏳');
    return;
  }
  userLastMessage.set(message.author.id, now);

  // Interrupt current generation if active
  if (session.isGenerating) {
    sessions.abortSession(session.id);
    // Wait for the abort to finish (up to 5s)
    const deadline = Date.now() + 5000;
    while (session.isGenerating && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (session.isGenerating) {
      await message.reply({
        content: 'Could not interrupt the current generation. Try `/claude stop`.',
        allowedMentions: { repliedUser: false },
      });
      return;
    }
  }

  const content = message.content.trim();
  if (!content) return;

  try {
    const channel = message.channel as TextChannel;
    const stream = sessions.sendPrompt(session.id, content);
    await handleOutputStream(stream, channel, session.id, session.verbose, session.mode);
  } catch (err: unknown) {
    await message.reply({
      content: `Error: ${(err as Error).message}`,
      allowedMentions: { repliedUser: false },
    });
  }
}
