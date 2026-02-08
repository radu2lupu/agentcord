import { resolve } from 'node:path';
import { homedir } from 'node:os';

export function sanitizeSessionName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

export function formatUptime(startTime: number): string {
  const ms = Date.now() - startTime;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

export function formatLastActivity(timestamp: number): string {
  const ms = Date.now() - timestamp;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

export function isPathAllowed(targetPath: string, allowedPaths: string[]): boolean {
  if (allowedPaths.length === 0) return true;
  const resolved = resolve(targetPath);
  return allowedPaths.some(allowed => {
    const resolvedAllowed = resolve(allowed.startsWith('~') ? allowed.replace('~', homedir()) : allowed);
    return resolved === resolvedAllowed || resolved.startsWith(resolvedAllowed + '/');
  });
}

export function resolvePath(dir: string): string {
  const expanded = dir.startsWith('~') ? dir.replace('~', homedir()) : dir;
  return resolve(expanded);
}

export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

export function splitMessage(text: string, maxLen: number = 1900): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt === -1 || splitAt < maxLen / 2) {
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }

  return chunks;
}

export function isUserAllowed(userId: string, allowedUsers: string[], allowAll: boolean): boolean {
  if (allowAll) return true;
  return allowedUsers.includes(userId);
}

export function projectNameFromDir(directory: string): string {
  const resolved = resolvePath(directory);
  const basename = resolved.split('/').pop() || 'unknown';
  return sanitizeSessionName(basename);
}

export function detectNumberedOptions(text: string): string[] | null {
  const lines = text.trim().split('\n');
  const options: string[] = [];
  const optionRegex = /^\s*(\d+)[.)]\s+(.+)$/;

  for (const line of lines) {
    const match = line.match(optionRegex);
    if (match) {
      options.push(match[2].trim());
    }
  }

  return options.length >= 2 ? options : null;
}

export function detectYesNoPrompt(text: string): boolean {
  const lower = text.toLowerCase();
  return /\b(y\/n|yes\/no|confirm|proceed)\b/.test(lower) ||
    /\?\s*$/.test(text.trim()) && /\b(should|would you|do you want|shall)\b/.test(lower);
}
