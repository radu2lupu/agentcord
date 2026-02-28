import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const startThreadMock = vi.fn();
const resumeThreadMock = vi.fn();

function makeEvents(): AsyncGenerator<any> {
  return (async function* () {
    yield { type: 'thread.started', thread_id: 'thread_xyz' };
    yield { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } };
  })();
}

vi.mock('@openai/codex-sdk', () => ({
  Codex: class MockCodex {
    startThread(options: unknown) {
      return startThreadMock(options);
    }

    resumeThread(id: string, options: unknown) {
      return resumeThreadMock(id, options);
    }
  },
}));

describe('codex-provider', () => {
  beforeEach(() => {
    vi.resetModules();
    startThreadMock.mockReset();
    resumeThreadMock.mockReset();
    startThreadMock.mockReturnValue({
      runStreamed: vi.fn(async () => ({ events: makeEvents() })),
    });
    resumeThreadMock.mockReturnValue({
      runStreamed: vi.fn(async () => ({ events: makeEvents() })),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('passes sandbox/approval/network options to startThread', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentcord-codex-test-'));
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    const provider = new CodexProvider();

    const stream = provider.sendPrompt('hi', {
      directory: dir,
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      networkAccessEnabled: true,
      systemPromptParts: ['Use strict mode'],
      abortController: new AbortController(),
    });

    for await (const _event of stream) {
      // consume stream
    }

    expect(startThreadMock).toHaveBeenCalledTimes(1);
    expect(startThreadMock).toHaveBeenCalledWith(expect.objectContaining({
      workingDirectory: dir,
      skipGitRepoCheck: true,
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      networkAccessEnabled: true,
    }));
  });

  it('passes sandbox/approval/network options to resumeThread in continueSession', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentcord-codex-test-'));
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    const provider = new CodexProvider();

    const stream = provider.continueSession({
      directory: dir,
      providerSessionId: 'thread_abc',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      networkAccessEnabled: false,
      systemPromptParts: [],
      abortController: new AbortController(),
    });

    for await (const _event of stream) {
      // consume stream
    }

    expect(resumeThreadMock).toHaveBeenCalledTimes(1);
    expect(resumeThreadMock).toHaveBeenCalledWith(
      'thread_abc',
      expect.objectContaining({
        workingDirectory: dir,
        skipGitRepoCheck: true,
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
        networkAccessEnabled: false,
      }),
    );
  });
});
