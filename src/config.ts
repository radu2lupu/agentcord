import 'dotenv/config';
import type { Config } from './types.ts';

function getEnvOrExit(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`ERROR: ${name} environment variable is required`);
    console.error('Set it in your .env file or export it before running');
    process.exit(1);
  }
  return value;
}

export const config: Config = {
  token: getEnvOrExit('DISCORD_TOKEN'),
  clientId: getEnvOrExit('DISCORD_CLIENT_ID'),
  guildId: process.env.DISCORD_GUILD_ID || null,
  allowedUsers: process.env.ALLOWED_USERS?.split(',').map(id => id.trim()).filter(Boolean) || [],
  allowAllUsers: process.env.ALLOW_ALL_USERS === 'true',
  allowedPaths: process.env.ALLOWED_PATHS?.split(',').map(p => p.trim()).filter(Boolean) || [],
  defaultDirectory: process.env.DEFAULT_DIRECTORY || process.cwd(),
  messageRetentionDays: process.env.MESSAGE_RETENTION_DAYS
    ? parseInt(process.env.MESSAGE_RETENTION_DAYS, 10)
    : null,
  rateLimitMs: process.env.RATE_LIMIT_MS
    ? parseInt(process.env.RATE_LIMIT_MS, 10)
    : 1000,
};

if (config.allowedUsers.length > 0) {
  console.log(`User whitelist: ${config.allowedUsers.length} user(s) allowed`);
} else if (config.allowAllUsers) {
  console.warn('WARNING: ALLOW_ALL_USERS=true — anyone in the guild can use this bot');
} else {
  console.error('ERROR: Set ALLOWED_USERS or ALLOW_ALL_USERS=true');
  process.exit(1);
}

if (config.allowedPaths.length > 0) {
  console.log(`Path restrictions: ${config.allowedPaths.join(', ')}`);
}

if (config.messageRetentionDays) {
  console.log(`Message retention: ${config.messageRetentionDays} day(s)`);
}
