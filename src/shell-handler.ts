import { spawn, type ChildProcess } from 'node:child_process';
import type { TextChannel } from 'discord.js';
import type { ShellProcess } from './types.ts';
import { truncate } from './utils.ts';

const runningProcesses = new Map<number, ShellProcess>();
let pidCounter = 0;

const TIMEOUT_MS = 60_000;
const EDIT_DEBOUNCE = 500;

export async function executeShellCommand(
  command: string,
  cwd: string,
  channel: TextChannel,
): Promise<void> {
  const pid = ++pidCounter;
  const child = spawn('bash', ['-c', command], {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const shellProcess: ShellProcess = {
    pid,
    command,
    startedAt: Date.now(),
    process: child,
  };
  runningProcesses.set(pid, shellProcess);

  let output = '';
  let message = await channel.send(`\`\`\`\n$ ${command}\n\`\`\``);
  let lastEdit = Date.now();
  let editTimer: ReturnType<typeof setTimeout> | null = null;

  const updateMessage = async () => {
    const display = truncate(output, 1900);
    try {
      await message.edit(`\`\`\`\n$ ${command}\n${display}\n\`\`\``);
    } catch { /* message deleted */ }
    lastEdit = Date.now();
  };

  const scheduleEdit = () => {
    if (editTimer) return;
    const delay = Math.max(0, EDIT_DEBOUNCE - (Date.now() - lastEdit));
    editTimer = setTimeout(async () => {
      editTimer = null;
      await updateMessage();
    }, delay);
  };

  const onData = (chunk: Buffer) => {
    output += chunk.toString();
    scheduleEdit();
  };

  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  // Timeout
  const timeout = setTimeout(() => {
    child.kill('SIGTERM');
    output += '\n[Timed out after 60s]';
  }, TIMEOUT_MS);

  return new Promise<void>(resolve => {
    child.on('close', async (code) => {
      clearTimeout(timeout);
      if (editTimer) clearTimeout(editTimer);
      runningProcesses.delete(pid);

      output += `\n[Exit code: ${code ?? 'killed'}]`;
      await updateMessage();
      resolve();
    });
  });
}

export function listProcesses(): ShellProcess[] {
  return Array.from(runningProcesses.values());
}

export function killProcess(pid: number): boolean {
  const proc = runningProcesses.get(pid);
  if (!proc) return false;
  proc.process.kill('SIGTERM');
  runningProcesses.delete(pid);
  return true;
}
