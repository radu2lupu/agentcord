import type { Message, TextChannel } from 'discord.js';
import sharp from 'sharp';
import { config } from './config.ts';
import * as sessions from './session-manager.ts';
import { handleOutputStream } from './output-handler.ts';
import { isUserAllowed } from './utils.ts';
import type { ContentBlock, ImageMediaType } from './types.ts';

const SUPPORTED_IMAGE_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
]);
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB
const MAX_BASE64_BYTES = 5 * 1024 * 1024; // 5 MB — Anthropic API limit

const userLastMessage = new Map<string, number>();

async function resizeImageToFit(buf: Buffer, mediaType: string): Promise<Buffer> {
  // Already under the limit
  if (buf.length <= MAX_BASE64_BYTES) return buf;

  const isJpeg = mediaType === 'image/jpeg';
  const format = isJpeg ? 'jpeg' as const : 'webp' as const;

  let img = sharp(buf);
  const meta = await img.metadata();
  const width = meta.width || 1;
  const height = meta.height || 1;

  // Iteratively shrink by 70% until under limit (max 5 attempts)
  let scale = 1;
  for (let i = 0; i < 5; i++) {
    scale *= 0.7;
    const resized = await sharp(buf)
      .resize(Math.round(width * scale), Math.round(height * scale), { fit: 'inside' })
      [format]({ quality: 80 })
      .toBuffer();
    if (resized.length <= MAX_BASE64_BYTES) return resized;
  }

  // Last resort: aggressive resize
  return sharp(buf)
    .resize(Math.round(width * scale * 0.5), Math.round(height * scale * 0.5), { fit: 'inside' })
    .jpeg({ quality: 60 })
    .toBuffer();
}

async function fetchImageAsBase64(url: string, mediaType: string): Promise<{ data: string; mediaType: ImageMediaType }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
  let buf = Buffer.from(await res.arrayBuffer());

  if (buf.length > MAX_BASE64_BYTES) {
    buf = await resizeImageToFit(buf, mediaType);
    // Resized images are jpeg or webp
    const newType = mediaType === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
    return { data: buf.toString('base64'), mediaType: newType as ImageMediaType };
  }

  return { data: buf.toString('base64'), mediaType: mediaType as ImageMediaType };
}

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

  const text = message.content.trim();

  // Extract image attachments
  const imageAttachments = message.attachments.filter(
    a => a.contentType && SUPPORTED_IMAGE_TYPES.has(a.contentType) && a.size <= MAX_IMAGE_SIZE,
  );

  if (!text && imageAttachments.size === 0) return;

  try {
    const channel = message.channel as TextChannel;

    let prompt: string | ContentBlock[];
    if (imageAttachments.size === 0) {
      prompt = text;
    } else {
      // Build content blocks with images + text
      const blocks: ContentBlock[] = [];

      const imageResults = await Promise.allSettled(
        imageAttachments.map(a => fetchImageAsBase64(a.url, a.contentType!)),
      );
      for (const result of imageResults) {
        if (result.status === 'fulfilled') {
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: result.value.mediaType,
              data: result.value.data,
            },
          });
        }
      }

      if (text) {
        blocks.push({ type: 'text', text });
      } else if (blocks.length > 0) {
        blocks.push({ type: 'text', text: 'What is in this image?' });
      }

      prompt = blocks;
    }

    const stream = sessions.sendPrompt(session.id, prompt);
    await handleOutputStream(stream, channel, session.id, session.verbose, session.mode);
  } catch (err: unknown) {
    await message.reply({
      content: `Error: ${(err as Error).message}`,
      allowedMentions: { repliedUser: false },
    });
  }
}
