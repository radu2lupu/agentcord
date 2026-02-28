import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

type ProviderStub = {
  supports: ReturnType<typeof vi.fn>;
  sendPrompt: ReturnType<typeof vi.fn>;
  continueSession: ReturnType<typeof vi.fn>;
};

const ensureProviderMock = vi.fn();

vi.mock('../src/providers/index.ts', () => ({
  ensureProvider: ensureProviderMock,
}));

vi.mock('../src/agents.ts', () => ({
  getAgent: () => undefined,
}));

vi.mock('../src/project-manager.ts', () => ({
  getPersonality: () => undefined,
}));

function makeProviderStub(): ProviderStub {
  return {
    supports: vi.fn().mockReturnValue(false),
    sendPrompt: vi.fn(),
    continueSession: vi.fn(),
  };
}

function setBaseEnv(): void {
  process.env.DISCORD_TOKEN = 'test-token';
  process.env.DISCORD_CLIENT_ID = '123456789012345678';
  process.env.ALLOW_ALL_USERS = 'true';
  process.env.ALLOWED_USERS = '';
  process.env.DEFAULT_DIRECTORY = process.cwd();
}

describe('session-manager', () => {
  const originalCwd = process.cwd();
  const envSnapshot = { ...process.env };
  let tmpCwd = '';

  beforeEach(() => {
    vi.resetModules();
    tmpCwd = mkdtempSync(join(tmpdir(), 'agentcord-session-test-'));
    process.chdir(tmpCwd);
    process.env = { ...envSnapshot };
    setBaseEnv();
    ensureProviderMock.mockReset();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = { ...envSnapshot };
    vi.clearAllMocks();
  });

  it('does not persist placeholder channels and only persists after linking', async () => {
    const provider = makeProviderStub();
    ensureProviderMock.mockResolvedValue(provider);
    const sessions = await import('../src/session-manager.ts');

    const session = await sessions.createSession('feature', tmpCwd, 'pending', 'project-x', 'codex');
    const storePath = join(tmpCwd, '.discord-friends', 'sessions.json');

    expect(existsSync(storePath)).toBe(false);
    expect(sessions.getSessionByChannel('pending')).toBeUndefined();

    await sessions.linkChannel(session.id, '12345');
    expect(sessions.getSessionByChannel('12345')?.id).toBe(session.id);

    const persisted = JSON.parse(readFileSync(storePath, 'utf-8'));
    expect(persisted).toHaveLength(1);
    expect(persisted[0].channelId).toBe('12345');
  });

  it('skips malformed persisted sessions (pending and duplicate channels) on load', async () => {
    const provider = makeProviderStub();
    ensureProviderMock.mockResolvedValue(provider);

    const storeDir = join(tmpCwd, '.discord-friends');
    const storePath = join(storeDir, 'sessions.json');
    mkdirSync(storeDir, { recursive: true });

    const now = Date.now();
    writeFileSync(storePath, JSON.stringify([
      {
        id: 'bad-pending',
        channelId: 'pending',
        directory: tmpCwd,
        projectName: 'proj',
        provider: 'codex',
        tmuxName: '',
        createdAt: now,
        lastActivity: now,
        messageCount: 0,
        totalCost: 0,
      },
      {
        id: 'good-1',
        channelId: 'chan-1',
        directory: tmpCwd,
        projectName: 'proj',
        provider: 'codex',
        tmuxName: '',
        createdAt: now,
        lastActivity: now,
        messageCount: 1,
        totalCost: 0,
      },
      {
        id: 'dup-chan',
        channelId: 'chan-1',
        directory: tmpCwd,
        projectName: 'proj',
        provider: 'codex',
        tmuxName: '',
        createdAt: now,
        lastActivity: now,
        messageCount: 2,
        totalCost: 1,
      },
    ], null, 2), 'utf-8');

    const sessions = await import('../src/session-manager.ts');
    await sessions.loadSessions();

    const all = sessions.getAllSessions();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('good-1');
    expect(sessions.getSessionByChannel('chan-1')?.id).toBe('good-1');

    const persisted = JSON.parse(readFileSync(storePath, 'utf-8'));
    expect(persisted).toHaveLength(1);
    expect(persisted[0].id).toBe('good-1');
  });

  it('applies codex policy defaults from env when not passed explicitly', async () => {
    process.env.CODEX_SANDBOX_MODE = 'danger-full-access';
    process.env.CODEX_APPROVAL_POLICY = 'never';
    process.env.CODEX_NETWORK_ACCESS_ENABLED = 'true';

    const provider = makeProviderStub();
    ensureProviderMock.mockResolvedValue(provider);
    const sessions = await import('../src/session-manager.ts');

    const session = await sessions.createSession('policy', tmpCwd, 'pending', 'project-x', 'codex');
    expect(session.sandboxMode).toBe('danger-full-access');
    expect(session.approvalPolicy).toBe('never');
    expect(session.networkAccessEnabled).toBe(true);
  });

  it('forwards session codex policy to provider sendPrompt', async () => {
    process.env.CODEX_SANDBOX_MODE = 'workspace-write';
    process.env.CODEX_APPROVAL_POLICY = 'on-request';
    process.env.CODEX_NETWORK_ACCESS_ENABLED = 'false';

    let seenOptions: any;
    const provider = makeProviderStub();
    provider.sendPrompt.mockImplementation(async function* (_prompt: unknown, options: unknown) {
      seenOptions = options;
      yield { type: 'session_init', providerSessionId: 'thread_1' };
      yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] };
    });
    ensureProviderMock.mockResolvedValue(provider);

    const sessions = await import('../src/session-manager.ts');
    const session = await sessions.createSession('prompt', tmpCwd, 'pending', 'project-x', 'codex');

    const events: any[] = [];
    for await (const event of sessions.sendPrompt(session.id, 'hello')) {
      events.push(event);
    }

    expect(events.some(e => e.type === 'session_init')).toBe(true);
    expect(events.some(e => e.type === 'result')).toBe(true);
    expect(seenOptions).toMatchObject({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      networkAccessEnabled: false,
    });
  });
});
