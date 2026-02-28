import 'dotenv/config';
import type { Config } from './types.ts';
import type { CodexApprovalPolicy, CodexSandboxMode } from './providers/types.ts';

function getEnvOrExit(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`ERROR: ${name} environment variable is required`);
    console.error('Set it in your .env file or export it before running');
    process.exit(1);
  }
  return value;
}

const CODEX_SANDBOX_MODES = new Set<CodexSandboxMode>([
  'read-only',
  'workspace-write',
  'danger-full-access',
]);
const CODEX_APPROVAL_POLICIES = new Set<CodexApprovalPolicy>([
  'never',
  'on-request',
  'on-failure',
  'untrusted',
]);

function parseCodexSandboxMode(value: string | undefined): CodexSandboxMode | undefined {
  if (!value) return undefined;
  if (CODEX_SANDBOX_MODES.has(value as CodexSandboxMode)) {
    return value as CodexSandboxMode;
  }
  console.error(
    `ERROR: Invalid CODEX_SANDBOX_MODE "${value}". Expected one of: ${Array.from(CODEX_SANDBOX_MODES).join(', ')}`,
  );
  process.exit(1);
}

function parseCodexApprovalPolicy(value: string | undefined): CodexApprovalPolicy | undefined {
  if (!value) return undefined;
  if (CODEX_APPROVAL_POLICIES.has(value as CodexApprovalPolicy)) {
    return value as CodexApprovalPolicy;
  }
  console.error(
    `ERROR: Invalid CODEX_APPROVAL_POLICY "${value}". Expected one of: ${Array.from(CODEX_APPROVAL_POLICIES).join(', ')}`,
  );
  process.exit(1);
}

function parseBoolean(name: string, value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  console.error(`ERROR: Invalid ${name} "${value}". Expected "true" or "false".`);
  process.exit(1);
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
  codexSandboxMode: parseCodexSandboxMode(process.env.CODEX_SANDBOX_MODE),
  codexApprovalPolicy: parseCodexApprovalPolicy(process.env.CODEX_APPROVAL_POLICY),
  codexNetworkAccessEnabled: parseBoolean('CODEX_NETWORK_ACCESS_ENABLED', process.env.CODEX_NETWORK_ACCESS_ENABLED),
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

if (config.codexSandboxMode || config.codexApprovalPolicy || config.codexNetworkAccessEnabled !== undefined) {
  const bits: string[] = [];
  if (config.codexSandboxMode) bits.push(`sandbox=${config.codexSandboxMode}`);
  if (config.codexApprovalPolicy) bits.push(`approval=${config.codexApprovalPolicy}`);
  if (config.codexNetworkAccessEnabled !== undefined) bits.push(`network=${config.codexNetworkAccessEnabled}`);
  console.log(`Codex defaults: ${bits.join(', ')}`);
}
