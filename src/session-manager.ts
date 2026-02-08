import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { Store } from './persistence.ts';
import { getAgent } from './agents.ts';
import { getPersonality } from './project-manager.ts';
import { sanitizeSessionName, resolvePath, isPathAllowed } from './utils.ts';
import type { Session, SessionPersistData } from './types.ts';
import { config } from './config.ts';

const SESSION_PREFIX = 'claude-';
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
    const exists = await tmuxSessionExists(s.tmuxName);
    sessions.set(s.id, {
      ...s,
      verbose: s.verbose ?? false,
      isGenerating: false,
    });
    channelToSession.set(s.channelId, s.id);

    // If tmux session is gone, recreate it
    if (!exists) {
      try {
        await tmux('new-session', '-d', '-s', s.tmuxName, '-c', s.directory);
      } catch {
        console.warn(`Could not recreate tmux session ${s.tmuxName}`);
      }
    }
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
      tmuxName: s.tmuxName,
      claudeSessionId: s.claudeSessionId,
      model: s.model,
      agentPersona: s.agentPersona,
      verbose: s.verbose || undefined,
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
  claudeSessionId?: string,
): Promise<Session> {
  const resolvedDir = resolvePath(directory);

  if (!isPathAllowed(resolvedDir, config.allowedPaths)) {
    throw new Error(`Directory not in allowed paths: ${resolvedDir}`);
  }
  if (!existsSync(resolvedDir)) {
    throw new Error(`Directory does not exist: ${resolvedDir}`);
  }

  // Auto-deduplicate: append -2, -3, etc. if name is taken
  let id = sanitizeSessionName(name);
  let tmuxName = `${SESSION_PREFIX}${id}`;
  let suffix = 1;
  while (sessions.has(id) || await tmuxSessionExists(tmuxName)) {
    suffix++;
    id = sanitizeSessionName(`${name}-${suffix}`);
    tmuxName = `${SESSION_PREFIX}${id}`;
  }

  // Create tmux session with a shell in the directory
  await tmux('new-session', '-d', '-s', tmuxName, '-c', resolvedDir);

  const session: Session = {
    id,
    channelId,
    directory: resolvedDir,
    projectName,
    tmuxName,
    claudeSessionId,
    verbose: false,
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

  // Kill tmux
  try {
    await tmux('kill-session', '-t', session.tmuxName);
  } catch {
    // Already dead
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

export function setAgentPersona(sessionId: string, persona: string | undefined): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.agentPersona = persona;
    saveSessions();
  }
}

// Build system prompt from project personality + agent persona

function buildSystemPrompt(session: Session): string | { type: 'preset'; preset: 'claude_code'; append?: string } {
  const parts: string[] = [];

  const personality = getPersonality(session.projectName);
  if (personality) parts.push(personality);

  if (session.agentPersona) {
    const agent = getAgent(session.agentPersona);
    if (agent?.systemPrompt) parts.push(agent.systemPrompt);
  }

  // Use Claude Code's default system prompt and append our customizations
  if (parts.length > 0) {
    return { type: 'preset', preset: 'claude_code', append: parts.join('\n\n') };
  }
  return { type: 'preset', preset: 'claude_code' };
}

// Claude Code SDK interaction

export async function* sendPrompt(
  sessionId: string,
  prompt: string,
): AsyncGenerator<SDKMessage> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" not found`);
  if (session.isGenerating) throw new Error('Session is already generating');

  const controller = new AbortController();
  (session as any)._controller = controller;
  session.isGenerating = true;
  session.lastActivity = Date.now();

  const systemPrompt = buildSystemPrompt(session);

  try {
    const stream = query({
      prompt,
      options: {
        cwd: session.directory,
        resume: session.claudeSessionId,
        abortController: controller,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        model: session.model,
        systemPrompt: systemPrompt,
        includePartialMessages: true,
        settingSources: ['user', 'project', 'local'],
      },
    });

    for await (const message of stream) {
      // Capture session ID from init message
      if (message.type === 'system' && 'subtype' in message && message.subtype === 'init') {
        session.claudeSessionId = message.session_id;
        await saveSessions();
      }

      // Track cost from result
      if (message.type === 'result') {
        if ('total_cost_usd' in message) {
          session.totalCost += message.total_cost_usd;
        }
      }

      yield message;
    }

    session.messageCount++;
  } catch (err: unknown) {
    if ((err as Error).name === 'AbortError') {
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
): AsyncGenerator<SDKMessage> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" not found`);
  if (session.isGenerating) throw new Error('Session is already generating');

  const controller = new AbortController();
  (session as any)._controller = controller;
  session.isGenerating = true;
  session.lastActivity = Date.now();

  const systemPrompt = buildSystemPrompt(session);

  try {
    const stream = query({
      prompt: '',
      options: {
        cwd: session.directory,
        continue: true,
        resume: session.claudeSessionId,
        abortController: controller,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        model: session.model,
        systemPrompt: systemPrompt,
        includePartialMessages: true,
        settingSources: ['user', 'project', 'local'],
      },
    });

    for await (const message of stream) {
      if (message.type === 'system' && 'subtype' in message && message.subtype === 'init') {
        session.claudeSessionId = message.session_id;
        await saveSessions();
      }
      if (message.type === 'result' && 'total_cost_usd' in message) {
        session.totalCost += message.total_cost_usd;
      }
      yield message;
    }

    session.messageCount++;
  } catch (err: unknown) {
    if ((err as Error).name === 'AbortError') {
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
    return true;
  }
  return false;
}

// Tmux info for /claude attach

export function getAttachInfo(sessionId: string): { command: string; sessionId?: string } | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  return {
    command: `tmux attach -t ${session.tmuxName}`,
    sessionId: session.claudeSessionId,
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
