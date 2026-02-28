import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from 'discord.js';

const createSessionMock = vi.fn();
const listTmuxSessionsMock = vi.fn();
const getAllSessionsMock = vi.fn();

const getOrCreateProjectMock = vi.fn();
const getProjectByCategoryIdMock = vi.fn();
const getProjectMock = vi.fn();
const updateProjectCategoryMock = vi.fn();

vi.mock('../src/session-manager.ts', () => ({
  createSession: createSessionMock,
  listTmuxSessions: listTmuxSessionsMock,
  getAllSessions: getAllSessionsMock,
  getSessionByChannel: vi.fn(),
  getSession: vi.fn(),
  sendPrompt: vi.fn(),
  continueSession: vi.fn(),
  endSession: vi.fn(),
  abortSession: vi.fn(),
  setModel: vi.fn(),
  setVerbose: vi.fn(),
  setMode: vi.fn(),
  getAttachInfo: vi.fn(),
  linkChannel: vi.fn(),
}));

vi.mock('../src/project-manager.ts', () => ({
  getOrCreateProject: getOrCreateProjectMock,
  getProjectByCategoryId: getProjectByCategoryIdMock,
  getProject: getProjectMock,
  updateProjectCategory: updateProjectCategoryMock,
  setPersonality: vi.fn(),
  getPersonality: vi.fn(),
  clearPersonality: vi.fn(),
  addSkill: vi.fn(),
  removeSkill: vi.fn(),
  getSkills: vi.fn(),
  executeSkill: vi.fn(),
  addMcpServer: vi.fn(),
  removeMcpServer: vi.fn(),
  listMcpServers: vi.fn(),
}));

vi.mock('../src/plugin-manager.ts', () => ({
  listAvailable: vi.fn(),
  installPlugin: vi.fn(),
  uninstallPlugin: vi.fn(),
  listInstalled: vi.fn(),
  getPluginDetail: vi.fn(),
  enablePlugin: vi.fn(),
  disablePlugin: vi.fn(),
  updatePlugin: vi.fn(),
  listMarketplaces: vi.fn(),
  addMarketplace: vi.fn(),
  removeMarketplace: vi.fn(),
  updateMarketplaces: vi.fn(),
}));

vi.mock('../src/agents.ts', () => ({
  listAgents: vi.fn(() => []),
  getAgent: vi.fn(),
}));

vi.mock('../src/output-handler.ts', () => ({
  handleOutputStream: vi.fn(),
}));

vi.mock('../src/shell-handler.ts', () => ({
  executeShellCommand: vi.fn(),
  listProcesses: vi.fn(() => []),
  killProcess: vi.fn(),
}));

describe('/session sync codex recovery', () => {
  const envSnapshot = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    createSessionMock.mockReset();
    listTmuxSessionsMock.mockReset();
    getAllSessionsMock.mockReset();
    getOrCreateProjectMock.mockReset();
    getProjectByCategoryIdMock.mockReset();
    getProjectMock.mockReset();
    updateProjectCategoryMock.mockReset();

    process.env = { ...envSnapshot };
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.DISCORD_CLIENT_ID = '123456789012345678';
    process.env.ALLOW_ALL_USERS = 'true';
    process.env.ALLOWED_USERS = '';
    process.env.DEFAULT_DIRECTORY = '/tmp/default-project';
  });

  afterEach(() => {
    process.env = { ...envSnapshot };
    vi.clearAllMocks();
  });

  it('recovers orphaned codex channels into in-memory sessions', async () => {
    getAllSessionsMock.mockReturnValue([]);
    listTmuxSessionsMock.mockResolvedValue([]);
    createSessionMock.mockResolvedValue({ id: 'fix-auth', channelId: 'chan-1' });

    const codexChannel = {
      id: 'chan-1',
      type: ChannelType.GuildText,
      name: 'codex-fix-auth',
      topic: 'OpenAI Codex session | Dir: /tmp/work-repo | Provider Session: thr_abc123',
      parentId: 'cat-1',
    };

    const guild = {
      channels: {
        cache: {
          values: () => [codexChannel][Symbol.iterator](),
        },
      },
    };

    const interaction = {
      user: { id: 'user-1' },
      options: {
        getSubcommand: () => 'sync',
      },
      guild,
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    const { handleSession } = await import('../src/command-handlers.ts');
    await handleSession(interaction as any);

    expect(createSessionMock).toHaveBeenCalledWith(
      'fix-auth',
      '/tmp/work-repo',
      'chan-1',
      'work-repo',
      'codex',
      'thr_abc123',
      { recoverExisting: true },
    );
    expect(getOrCreateProjectMock).toHaveBeenCalledWith('work-repo', '/tmp/work-repo', 'cat-1');
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('Synced 1 orphaned session(s)'));
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('(1 channel)'));
  });

  it('falls back to default directory when channel topic has no Dir metadata', async () => {
    getAllSessionsMock.mockReturnValue([]);
    listTmuxSessionsMock.mockResolvedValue([]);
    createSessionMock.mockResolvedValue({ id: 'orphan', channelId: 'chan-2' });

    const codexChannel = {
      id: 'chan-2',
      type: ChannelType.GuildText,
      name: 'codex-orphan',
      topic: 'OpenAI Codex session | Provider Session: thr_fallback',
      parentId: 'cat-2',
    };

    const guild = {
      channels: {
        cache: {
          values: () => [codexChannel][Symbol.iterator](),
        },
      },
    };

    const interaction = {
      user: { id: 'user-1' },
      options: {
        getSubcommand: () => 'sync',
      },
      guild,
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    const { handleSession } = await import('../src/command-handlers.ts');
    await handleSession(interaction as any);

    expect(createSessionMock).toHaveBeenCalledWith(
      'orphan',
      '/tmp/default-project',
      'chan-2',
      'default-project',
      'codex',
      'thr_fallback',
      { recoverExisting: true },
    );
    expect(getOrCreateProjectMock).toHaveBeenCalledWith('default-project', '/tmp/default-project', 'cat-2');
  });
});
