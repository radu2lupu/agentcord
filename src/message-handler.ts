import type { Message, TextChannel } from 'discord.js';
import sharp from 'sharp';
import { config } from './config.ts';
import * as sessions from './session-manager.ts';
import { handleOutputStream } from './output-handler.ts';
import { isUserAllowed, isAbortError } from './utils.ts';
import type { ContentBlock, ImageMediaType } from './types.ts';

const SUPPORTED_IMAGE_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
]);
const TEXT_CONTENT_TYPES = new Set([
  'text/plain', 'text/markdown', 'text/csv', 'text/html', 'text/xml',
  'application/json', 'application/xml', 'application/javascript',
  'application/typescript', 'application/x-yaml',
]);
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.yaml', '.yml', '.xml', '.csv', '.html', '.css',
  '.js', '.ts', '.jsx', '.tsx', '.swift', '.py', '.rb', '.go', '.rs', '.java',
  '.kt', '.c', '.cpp', '.h', '.hpp', '.sh', '.bash', '.zsh', '.toml', '.ini',
  '.cfg', '.conf', '.env', '.log', '.sql', '.graphql', '.proto', '.diff', '.patch',
]);
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB
const MAX_TEXT_FILE_SIZE = 512 * 1024; // 512 KB
// Base64 adds ~33% overhead, so raw bytes limit is ~3.75 MB to stay under 5 MB base64
const MAX_RAW_BYTES = Math.floor((5 * 1024 * 1024) * 3 / 4);

const userLastMessage = new Map<string, number>();

async function resizeImageToFit(buf: Buffer): Promise<Buffer> {
  const meta = await sharp(buf).metadata();
  const width = meta.width || 1;
  const height = meta.height || 1;

  // Always convert to JPEG for reliable compression
  let scale = 1;
  for (let i = 0; i < 5; i++) {
    scale *= 0.7;
    const resized = await sharp(buf)
      .resize(Math.round(width * scale), Math.round(height * scale), { fit: 'inside' })
      .jpeg({ quality: 80 })
      .toBuffer();
    if (resized.length <= MAX_RAW_BYTES) return resized;
  }

  // Last resort: aggressive resize
  return sharp(buf)
    .resize(Math.round(width * scale * 0.5), Math.round(height * scale * 0.5), { fit: 'inside' })
    .jpeg({ quality: 60 })
    .toBuffer();
}

function isTextAttachment(contentType: string | null, filename: string | null): boolean {
  if (contentType && TEXT_CONTENT_TYPES.has(contentType.split(';')[0])) return true;
  if (filename) {
    const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
    if (TEXT_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

async function fetchTextFile(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download file: ${res.status}`);
  return res.text();
}

async function fetchImageAsBase64(url: string, mediaType: string): Promise<{ data: string; mediaType: ImageMediaType }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  if (buf.length > MAX_RAW_BYTES) {
    const resized = await resizeImageToFit(buf);
    return { data: resized.toString('base64'), mediaType: 'image/jpeg' };
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
    // Give a brief moment for the stream to wind down
    await new Promise(r => setTimeout(r, 200));
  }

  const text = message.content.trim();

  // Classify attachments: image, text, or skip (video/audio/etc.)
  const imageAttachments = message.attachments.filter(
    a => a.contentType && SUPPORTED_IMAGE_TYPES.has(a.contentType) && a.size <= MAX_IMAGE_SIZE,
  );
  const textAttachments = message.attachments.filter(
    a => !SUPPORTED_IMAGE_TYPES.has(a.contentType ?? '')
      && !(a.contentType?.startsWith('video/') || a.contentType?.startsWith('audio/'))
      && (isTextAttachment(a.contentType, a.name) || !a.contentType)
      && a.size <= MAX_TEXT_FILE_SIZE,
  );

  if (!text && imageAttachments.size === 0 && textAttachments.size === 0) return;

  try {
    const channel = message.channel as TextChannel;
    const hasAttachments = imageAttachments.size > 0 || textAttachments.size > 0;

    let prompt: string | ContentBlock[];
    if (!hasAttachments) {
      prompt = text;
    } else {
      const blocks: ContentBlock[] = [];

      // Fetch text files and prepend as text blocks
      const textResults = await Promise.allSettled(
        textAttachments.map(async a => ({
          name: a.name ?? 'file',
          content: await fetchTextFile(a.url),
        })),
      );
      for (const result of textResults) {
        if (result.status === 'fulfilled') {
          blocks.push({
            type: 'text',
            text: `<file name="${result.value.name}">\n${result.value.content}\n</file>`,
          });
        }
      }

      // Fetch images as base64
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

      // Add user text or a default prompt
      if (text) {
        blocks.push({ type: 'text', text });
      } else if (imageAttachments.size > 0 && textAttachments.size === 0) {
        blocks.push({ type: 'text', text: 'What is in this image?' });
      } else {
        blocks.push({ type: 'text', text: 'Here are the attached files.' });
      }

      prompt = blocks;
    }

    const stream = sessions.sendPrompt(session.id, prompt);
    await handleOutputStream(stream, channel, session.id, session.verbose, session.mode, session.provider);
  } catch (err: unknown) {
    if (isAbortError(err)) {
      return;
    }
    await message.reply({
      content: `Error: ${(err as Error).message || 'Unknown error'}`,
      allowedMentions: { repliedUser: false },
    });
  }
}
