import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { ensureProvider, type ProviderEvent, type ProviderName, type ContentBlock } from './providers/index.ts';
import { Store } from './persistence.ts';
import { getAgent } from './agents.ts';
import { getPersonality } from './project-manager.ts';
import { sanitizeSessionName, resolvePath, isPathAllowed, isAbortError } from './utils.ts';
import type { Session, SessionPersistData, SessionMode } from './types.ts';
import { config } from './config.ts';

const SESSION_PREFIX = 'agentcord-';

const MODE_PROMPTS: Record<SessionMode, string> = {
  auto: '',
  plan: 'You MUST use EnterPlanMode at the start of every task. Present your plan for user approval before making any code changes. Do not write or edit files until the user approves the plan.',
  normal: 'Before performing destructive or significant operations (deleting files, running dangerous commands, making large refactors, writing to many files), use AskUserQuestion to confirm with the user first. Ask for explicit approval before proceeding with changes.',
};
const sessionStore = new Store<SessionPersistData[]>('sessions.json');

const sessions = new Map<string, Session>();
const channelToSession = new Map<string, string>();

// Async tmux helper — never blocks the event loop
function tmux(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { encoding: 'utf-8' }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

async function tmuxSessionExists(tmuxName: string): Promise<boolean> {
  try {
    await tmux('has-session', '-t', tmuxName);
    return true;
  } catch {
    return false;
  }
}

// Persistence

export async function loadSessions(): Promise<void> {
  const data = await sessionStore.read();
  if (!data) return;

  for (const s of data) {
    // Migration: handle old claudeSessionId field and missing provider
    const provider: ProviderName = s.provider ?? 'claude';
    const providerSessionId = s.providerSessionId ?? (s as any).claudeSessionId;

    // Only manage tmux for providers that use it
    if (provider === 'claude') {
      const exists = await tmuxSessionExists(s.tmuxName);
      if (!exists) {
        try {
          await tmux('new-session', '-d', '-s', s.tmuxName, '-c', s.directory);
        } catch {
          console.warn(`Could not recreate tmux session ${s.tmuxName}`);
        }
      }
    }

    sessions.set(s.id, {
      ...s,
      provider,
      providerSessionId,
      verbose: s.verbose ?? false,
      mode: s.mode ?? 'auto',
      isGenerating: false,
    });
    channelToSession.set(s.channelId, s.id);
  }

  console.log(`Restored ${sessions.size} session(s)`);
}

async function saveSessions(): Promise<void> {
  const data: SessionPersistData[] = [];
  for (const [, s] of sessions) {
    data.push({
      id: s.id,
      channelId: s.channelId,
      directory: s.directory,
      projectName: s.projectName,
      provider: s.provider,
      tmuxName: s.tmuxName,
      providerSessionId: s.providerSessionId,
      model: s.model,
      agentPersona: s.agentPersona,
      verbose: s.verbose || undefined,
      mode: s.mode !== 'auto' ? s.mode : undefined,
      createdAt: s.createdAt,
      lastActivity: s.lastActivity,
      messageCount: s.messageCount,
      totalCost: s.totalCost,
    });
  }
  await sessionStore.write(data);
}

// Session CRUD

export async function createSession(
  name: string,
  directory: string,
  channelId: string,
  projectName: string,
  provider: ProviderName = 'claude',
  providerSessionId?: string,
): Promise<Session> {
  const resolvedDir = resolvePath(directory);

  if (!isPathAllowed(resolvedDir, config.allowedPaths)) {
    throw new Error(`Directory not in allowed paths: ${resolvedDir}`);
  }
  if (!existsSync(resolvedDir)) {
    throw new Error(`Directory does not exist: ${resolvedDir}`);
  }

  // Validate the provider is available
  const providerInstance = await ensureProvider(provider);
  const usesTmux = providerInstance.supports('tmux');

  // Auto-deduplicate: append -2, -3, etc. if name is taken
  let id = sanitizeSessionName(name);
  let tmuxName = usesTmux ? `${SESSION_PREFIX}${id}` : '';
  let suffix = 1;
  while (sessions.has(id) || (usesTmux && await tmuxSessionExists(tmuxName))) {
    suffix++;
    id = sanitizeSessionName(`${name}-${suffix}`);
    if (usesTmux) tmuxName = `${SESSION_PREFIX}${id}`;
  }

  if (usesTmux) {
    await tmux('new-session', '-d', '-s', tmuxName, '-c', resolvedDir);
  }

  const session: Session = {
    id,
    channelId,
    directory: resolvedDir,
    projectName,
    provider,
    tmuxName,
    providerSessionId,
    verbose: false,
    mode: 'auto',
    isGenerating: false,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    messageCount: 0,
    totalCost: 0,
  };

  sessions.set(id, session);
  channelToSession.set(channelId, id);
  await saveSessions();

  return session;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function getSessionByChannel(channelId: string): Session | undefined {
  const id = channelToSession.get(channelId);
  return id ? sessions.get(id) : undefined;
}

export function getAllSessions(): Session[] {
  return Array.from(sessions.values());
}

export async function endSession(id: string): Promise<void> {
  const session = sessions.get(id);
  if (!session) throw new Error(`Session "${id}" not found`);

  // Abort if generating
  if (session.isGenerating && (session as any)._controller) {
    (session as any)._controller.abort();
  }

  // Kill tmux only if it was created
  if (session.tmuxName) {
    try {
      await tmux('kill-session', '-t', session.tmuxName);
    } catch {
      // Already dead
    }
  }

  channelToSession.delete(session.channelId);
  sessions.delete(id);
  await saveSessions();
}

export function linkChannel(sessionId: string, channelId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    channelToSession.delete(session.channelId);
    session.channelId = channelId;
    channelToSession.set(channelId, sessionId);
    saveSessions();
  }
}

export function unlinkChannel(channelId: string): void {
  const sessionId = channelToSession.get(channelId);
  if (sessionId) {
    channelToSession.delete(channelId);
    const session = sessions.get(sessionId);
    if (session) {
      sessions.delete(sessionId);
    }
    saveSessions();
  }
}

// Model management

export function setModel(sessionId: string, model: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.model = model;
    saveSessions();
  }
}

// Agent persona management

export function setVerbose(sessionId: string, verbose: boolean): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.verbose = verbose;
    saveSessions();
  }
}

export function setMode(sessionId: string, mode: SessionMode): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.mode = mode;
    saveSessions();
  }
}

export function setAgentPersona(sessionId: string, persona: string | undefined): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.agentPersona = persona;
    saveSessions();
  }
}

// Build system prompt parts from project personality + agent persona + mode

function buildSystemPromptParts(session: Session): string[] {
  const parts: string[] = [];

  const personality = getPersonality(session.projectName);
  if (personality) parts.push(personality);

  if (session.agentPersona) {
    const agent = getAgent(session.agentPersona);
    if (agent?.systemPrompt) parts.push(agent.systemPrompt);
  }

  const modePrompt = MODE_PROMPTS[session.mode];
  if (modePrompt) parts.push(modePrompt);

  return parts;
}

export function resetProviderSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.providerSessionId = undefined;
    saveSessions();
  }
}

// Provider-delegated prompt sending

export async function* sendPrompt(
  sessionId: string,
  prompt: string | ContentBlock[],
): AsyncGenerator<ProviderEvent> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" not found`);
  if (session.isGenerating) throw new Error('Session is already generating');

  const controller = new AbortController();
  (session as any)._controller = controller;
  session.isGenerating = true;
  session.lastActivity = Date.now();

  const provider = await ensureProvider(session.provider);
  const systemPromptParts = buildSystemPromptParts(session);

  try {
    const stream = provider.sendPrompt(prompt, {
      directory: session.directory,
      providerSessionId: session.providerSessionId,
      model: session.model,
      systemPromptParts,
      abortController: controller,
    });

    for await (const event of stream) {
      // Capture provider session ID
      if (event.type === 'session_init') {
        session.providerSessionId = event.providerSessionId || undefined;
        await saveSessions();
      }
      // Track cost
      if (event.type === 'result') {
        session.totalCost += event.costUsd;
      }
      yield event;
    }

    session.messageCount++;
  } catch (err: unknown) {
    if (isAbortError(err)) {
      // User cancelled — that's fine
    } else {
      throw err;
    }
  } finally {
    session.isGenerating = false;
    session.lastActivity = Date.now();
    delete (session as any)._controller;
    await saveSessions();
  }
}

export async function* continueSession(
  sessionId: string,
): AsyncGenerator<ProviderEvent> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" not found`);
  if (session.isGenerating) throw new Error('Session is already generating');

  const controller = new AbortController();
  (session as any)._controller = controller;
  session.isGenerating = true;
  session.lastActivity = Date.now();

  const provider = await ensureProvider(session.provider);
  const systemPromptParts = buildSystemPromptParts(session);

  try {
    const stream = provider.continueSession({
      directory: session.directory,
      providerSessionId: session.providerSessionId,
      model: session.model,
      systemPromptParts,
      abortController: controller,
    });

    for await (const event of stream) {
      if (event.type === 'session_init') {
        session.providerSessionId = event.providerSessionId || undefined;
        await saveSessions();
      }
      if (event.type === 'result') {
        session.totalCost += event.costUsd;
      }
      yield event;
    }

    session.messageCount++;
  } catch (err: unknown) {
    if (isAbortError(err)) {
      // cancelled
    } else {
      throw err;
    }
  } finally {
    session.isGenerating = false;
    session.lastActivity = Date.now();
    delete (session as any)._controller;
    await saveSessions();
  }
}

export function abortSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  const controller = (session as any)._controller as AbortController | undefined;
  if (controller) {
    controller.abort();
  }
  // Force-clear generating state — the SDK may not throw AbortError reliably
  if (session.isGenerating) {
    session.isGenerating = false;
    delete (session as any)._controller;
    saveSessions();
    return true;
  }
  return !!controller;
}

// Tmux info for /session attach

export function getAttachInfo(sessionId: string): { command: string; sessionId?: string } | null {
  const session = sessions.get(sessionId);
  if (!session || !session.tmuxName) return null;
  return {
    command: `tmux attach -t ${session.tmuxName}`,
    sessionId: session.providerSessionId,
  };
}

// List tmux sessions for sync

export async function listTmuxSessions(): Promise<Array<{ id: string; tmuxName: string; directory: string }>> {
  try {
    const output = await tmux(
      'list-sessions', '-F', '#{session_name}|#{pane_current_path}',
    );
    return output
      .trim()
      .split('\n')
      .filter(line => line.startsWith(SESSION_PREFIX))
      .map(line => {
        const [name, path] = line.split('|');
        return {
          id: name.replace(SESSION_PREFIX, ''),
          tmuxName: name,
          directory: path || 'unknown',
        };
      });
  } catch {
    return [];
  }
}
