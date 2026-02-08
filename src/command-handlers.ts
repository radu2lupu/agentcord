import {
  EmbedBuilder,
  ChannelType,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
  type TextChannel,
  type Guild,
  type CategoryChannel,
} from 'discord.js';
import { readdirSync, statSync, createReadStream } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { config } from './config.ts';
import * as sessions from './session-manager.ts';
import * as projectMgr from './project-manager.ts';
import { listAgents, getAgent } from './agents.ts';
import { handleOutputStream } from './output-handler.ts';
import { executeShellCommand, listProcesses, killProcess } from './shell-handler.ts';
import {
  isUserAllowed,
  projectNameFromDir,
  formatUptime,
  formatLastActivity,
  truncate,
} from './utils.ts';

// Logging callback (set by bot.ts)
let logFn: (msg: string) => void = console.log;
export function setLogger(fn: (msg: string) => void): void {
  logFn = fn;
}

function log(msg: string): void {
  logFn(msg);
}

// Get or create project category + log channel
async function ensureProjectCategory(
  guild: Guild,
  projectName: string,
  directory: string,
): Promise<{ category: CategoryChannel; logChannel: TextChannel }> {
  let project = projectMgr.getProject(projectName);

  // Try to find existing category
  let category: CategoryChannel | undefined;
  if (project) {
    category = guild.channels.cache.get(project.categoryId) as CategoryChannel | undefined;
  }

  if (!category) {
    // Look by name
    category = guild.channels.cache.find(
      ch => ch.type === ChannelType.GuildCategory && ch.name === projectName,
    ) as CategoryChannel | undefined;
  }

  if (!category) {
    category = await guild.channels.create({
      name: projectName,
      type: ChannelType.GuildCategory,
    });
  }

  // Ensure project exists in store
  project = projectMgr.getOrCreateProject(projectName, directory, category.id);

  // Find or create log channel
  let logChannel: TextChannel | undefined;
  if (project.logChannelId) {
    logChannel = guild.channels.cache.get(project.logChannelId) as TextChannel | undefined;
  }
  if (!logChannel) {
    logChannel = category.children.cache.find(
      ch => ch.name === 'project-logs' && ch.type === ChannelType.GuildText,
    ) as TextChannel | undefined;
  }
  if (!logChannel) {
    logChannel = await guild.channels.create({
      name: 'project-logs',
      type: ChannelType.GuildText,
      parent: category.id,
    });
  }

  projectMgr.updateProjectCategory(projectName, category.id, logChannel.id);

  return { category, logChannel };
}

// /claude commands

export async function handleClaude(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isUserAllowed(interaction.user.id, config.allowedUsers, config.allowAllUsers)) {
    await interaction.reply({ content: 'You are not authorized to use this bot.', ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case 'new': return handleClaudeNew(interaction);
    case 'resume': return handleClaudeResume(interaction);
    case 'list': return handleClaudeList(interaction);
    case 'end': return handleClaudeEnd(interaction);
    case 'continue': return handleClaudeContinue(interaction);
    case 'stop': return handleClaudeStop(interaction);
    case 'output': return handleClaudeOutput(interaction);
    case 'attach': return handleClaudeAttach(interaction);
    case 'sync': return handleClaudeSync(interaction);
    case 'model': return handleClaudeModel(interaction);
    case 'verbose': return handleClaudeVerbose(interaction);
    case 'mode': return handleClaudeMode(interaction);
    default:
      await interaction.reply({ content: `Unknown subcommand: ${sub}`, ephemeral: true });
  }
}

async function handleClaudeNew(interaction: ChatInputCommandInteraction): Promise<void> {
  const name = interaction.options.getString('name', true);
  const directory = interaction.options.getString('directory') || config.defaultDirectory;

  await interaction.deferReply();

  let channel: TextChannel | undefined;

  try {
    const guild = interaction.guild!;
    const projectName = projectNameFromDir(directory);

    const { category } = await ensureProjectCategory(guild, projectName, directory);

    // Create session first (handles name deduplication)
    // Use a temp channel ID, we'll update it after creating the channel
    const session = await sessions.createSession(name, directory, 'pending', projectName);

    // Create Discord channel with the deduplicated session ID
    channel = await guild.channels.create({
      name: `claude-${session.id}`,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: `Claude session | Dir: ${directory}`,
    }) as TextChannel;

    // Link the real channel ID
    sessions.linkChannel(session.id, channel.id);

    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle(`Session Created: ${session.id}`)
      .addFields(
        { name: 'Channel', value: `#claude-${session.id}`, inline: true },
        { name: 'Directory', value: session.directory, inline: true },
        { name: 'Project', value: projectName, inline: true },
        { name: 'Terminal', value: `\`tmux attach -t ${session.tmuxName}\``, inline: false },
      );

    await interaction.editReply({ embeds: [embed] });
    log(`Session "${session.id}" created by ${interaction.user.tag} in ${directory}`);

    // Welcome message in the new channel
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x3498db)
          .setTitle('Claude Code Session')
          .setDescription('Type a message to send it to Claude. Use `/claude stop` to cancel generation.')
          .addFields(
            { name: 'Directory', value: `\`${session.directory}\``, inline: false },
            { name: 'Terminal Access', value: `\`tmux attach -t ${session.tmuxName}\``, inline: false },
          ),
      ],
    });
  } catch (err: unknown) {
    // Clean up on failure
    if (channel) {
      try { await channel.delete(); } catch { /* best effort */ }
    }
    await interaction.editReply(`Failed to create session: ${(err as Error).message}`);
  }
}

// Discover local Claude Code sessions for autocomplete

interface LocalSession {
  id: string;
  project: string;
  mtime: number;
  firstMessage: string;
}

function discoverLocalSessions(): LocalSession[] {
  const claudeDir = join(homedir(), '.claude', 'projects');
  const results: LocalSession[] = [];

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(claudeDir);
  } catch {
    return [];
  }

  for (const projDir of projectDirs) {
    const projPath = join(claudeDir, projDir);
    let files: string[];
    try {
      files = readdirSync(projPath);
    } catch {
      continue;
    }

    // Decode project path: -Users-foo-bar → /Users/foo/bar → basename
    const decoded = projDir.replace(/^-/, '/').replace(/-/g, '/');
    const project = basename(decoded);

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const sessionId = file.replace('.jsonl', '');
      // Validate UUID format
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) continue;

      try {
        const mtime = statSync(join(projPath, file)).mtimeMs;
        results.push({ id: sessionId, project, mtime, firstMessage: '' });
      } catch {
        continue;
      }
    }
  }

  // Sort by most recent first
  results.sort((a, b) => b.mtime - a.mtime);
  return results;
}

async function getFirstUserMessage(sessionId: string): Promise<string> {
  const claudeDir = join(homedir(), '.claude', 'projects');
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(claudeDir);
  } catch {
    return '';
  }

  for (const projDir of projectDirs) {
    const filePath = join(claudeDir, projDir, `${sessionId}.jsonl`);
    try {
      statSync(filePath);
    } catch {
      continue;
    }

    return new Promise(resolve => {
      const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
      let found = false;
      rl.on('line', line => {
        if (found) return;
        try {
          const obj = JSON.parse(line);
          if (obj.type !== 'user') return;
          const content = obj.message?.content;
          if (typeof content === 'string' && content) {
            found = true;
            rl.close();
            resolve(content.slice(0, 80));
          } else if (Array.isArray(content)) {
            for (const c of content) {
              if (c?.text) {
                found = true;
                rl.close();
                resolve(String(c.text).slice(0, 80));
                return;
              }
            }
          }
        } catch { /* skip malformed lines */ }
      });
      rl.on('close', () => { if (!found) resolve(''); });
      rl.on('error', () => resolve(''));
    });
  }
  return '';
}

function formatTimeAgo(mtime: number): string {
  const ago = Date.now() - mtime;
  if (ago < 3600_000) return `${Math.floor(ago / 60_000)}m ago`;
  if (ago < 86400_000) return `${Math.floor(ago / 3600_000)}h ago`;
  return `${Math.floor(ago / 86400_000)}d ago`;
}

export async function handleClaudeAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused();
  const localSessions = discoverLocalSessions();

  // Filter by typed text
  const filtered = focused
    ? localSessions.filter(s =>
        s.id.includes(focused.toLowerCase()) || s.project.toLowerCase().includes(focused.toLowerCase()))
    : localSessions;

  // Discord allows max 25 choices — get first messages for top results
  const top = filtered.slice(0, 25);
  const choices = await Promise.all(
    top.map(async s => {
      const firstMsg = await getFirstUserMessage(s.id);
      const timeAgo = formatTimeAgo(s.mtime);
      const label = firstMsg
        ? `${s.project} (${timeAgo}) — ${firstMsg}`
        : `${s.project} (${timeAgo})`;
      return { name: label.slice(0, 100), value: s.id };
    }),
  );

  await interaction.respond(choices);
}

async function handleClaudeResume(interaction: ChatInputCommandInteraction): Promise<void> {
  const claudeSessionId = interaction.options.getString('session-id', true);
  const name = interaction.options.getString('name', true);
  const directory = interaction.options.getString('directory') || config.defaultDirectory;

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(claudeSessionId)) {
    await interaction.reply({
      content: 'Invalid session ID. Expected a UUID like `9815d35d-6508-476e-8c40-40effa4ffd6b`.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  let channel: TextChannel | undefined;

  try {
    const guild = interaction.guild!;
    const projectName = projectNameFromDir(directory);

    const { category } = await ensureProjectCategory(guild, projectName, directory);

    const session = await sessions.createSession(name, directory, 'pending', projectName, claudeSessionId);

    channel = await guild.channels.create({
      name: `claude-${session.id}`,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: `Claude session (resumed) | Dir: ${directory}`,
    }) as TextChannel;

    sessions.linkChannel(session.id, channel.id);

    const embed = new EmbedBuilder()
      .setColor(0xe67e22)
      .setTitle(`Session Resumed: ${session.id}`)
      .addFields(
        { name: 'Channel', value: `#claude-${session.id}`, inline: true },
        { name: 'Directory', value: session.directory, inline: true },
        { name: 'Project', value: projectName, inline: true },
        { name: 'Claude Session', value: `\`${claudeSessionId}\``, inline: false },
        { name: 'Terminal', value: `\`tmux attach -t ${session.tmuxName}\``, inline: false },
      );

    await interaction.editReply({ embeds: [embed] });
    log(`Session "${session.id}" (resumed ${claudeSessionId}) created by ${interaction.user.tag} in ${directory}`);

    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0xe67e22)
          .setTitle('Claude Code Session (Resumed)')
          .setDescription(
            'This session is linked to an existing Claude Code conversation. ' +
            'Type a message to continue the conversation from Discord.'
          )
          .addFields(
            { name: 'Directory', value: `\`${session.directory}\``, inline: false },
            { name: 'Claude Session', value: `\`${claudeSessionId}\``, inline: false },
            { name: 'Terminal Access', value: `\`tmux attach -t ${session.tmuxName}\``, inline: false },
          ),
      ],
    });
  } catch (err: unknown) {
    if (channel) {
      try { await channel.delete(); } catch { /* best effort */ }
    }
    await interaction.editReply(`Failed to resume session: ${(err as Error).message}`);
  }
}

async function handleClaudeList(interaction: ChatInputCommandInteraction): Promise<void> {
  const allSessions = sessions.getAllSessions();

  if (allSessions.length === 0) {
    await interaction.reply({ content: 'No active sessions.', ephemeral: true });
    return;
  }

  // Group by project
  const grouped = new Map<string, typeof allSessions>();
  for (const s of allSessions) {
    const arr = grouped.get(s.projectName) || [];
    arr.push(s);
    grouped.set(s.projectName, arr);
  }

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`Active Sessions (${allSessions.length})`);

  for (const [project, projectSessions] of grouped) {
    const lines = projectSessions.map(s => {
      const status = s.isGenerating ? '🟢 generating' : '⚪ idle';
      const modeEmoji = { auto: '\u26A1', plan: '\uD83D\uDCCB', normal: '\uD83D\uDEE1\uFE0F' }[s.mode] || '\u26A1';
      return `**${s.id}** — ${status} ${modeEmoji} ${s.mode} | ${formatUptime(s.createdAt)} uptime | ${s.messageCount} msgs | $${s.totalCost.toFixed(4)} | ${formatLastActivity(s.lastActivity)}`;
    });
    embed.addFields({ name: `📁 ${project}`, value: lines.join('\n') });
  }

  await interaction.reply({ embeds: [embed] });
}

async function handleClaudeEnd(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessions.getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No session in this channel.', ephemeral: true });
    return;
  }

  await interaction.deferReply();
  try {
    await sessions.endSession(session.id);
    await interaction.editReply(`Session "${session.id}" ended. You can delete this channel.`);
    log(`Session "${session.id}" ended by ${interaction.user.tag}`);
  } catch (err: unknown) {
    await interaction.editReply(`Failed to end session: ${(err as Error).message}`);
  }
}

async function handleClaudeContinue(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessions.getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No session in this channel.', ephemeral: true });
    return;
  }
  if (session.isGenerating) {
    await interaction.reply({ content: 'Session is already generating.', ephemeral: true });
    return;
  }

  await interaction.deferReply();
  try {
    const channel = interaction.channel as TextChannel;
    const stream = sessions.continueSession(session.id);
    await interaction.editReply('Continuing...');
    await handleOutputStream(stream, channel, session.id, session.verbose, session.mode);
  } catch (err: unknown) {
    await interaction.editReply(`Error: ${(err as Error).message}`);
  }
}

async function handleClaudeStop(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessions.getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No session in this channel.', ephemeral: true });
    return;
  }

  const stopped = sessions.abortSession(session.id);
  await interaction.reply({
    content: stopped ? 'Generation stopped.' : 'Session was not generating.',
    ephemeral: true,
  });
}

async function handleClaudeOutput(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessions.getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No session in this channel.', ephemeral: true });
    return;
  }

  await interaction.reply({
    content: 'Conversation history is managed by the Claude Code SDK. Use `/claude attach` to view the full terminal history.',
    ephemeral: true,
  });
}

async function handleClaudeAttach(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessions.getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No session in this channel.', ephemeral: true });
    return;
  }

  const info = sessions.getAttachInfo(session.id);
  if (!info) {
    await interaction.reply({ content: 'Session not found.', ephemeral: true });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('Terminal Access')
    .addFields(
      { name: 'Attach to tmux', value: `\`\`\`\n${info.command}\n\`\`\`` },
    );

  if (info.sessionId) {
    embed.addFields({
      name: 'Resume Claude in terminal',
      value: `\`\`\`\ncd ${session.directory} && claude --resume ${info.sessionId}\n\`\`\``,
    });
  }

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleClaudeSync(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  const guild = interaction.guild!;
  const tmuxSessions = await sessions.listTmuxSessions();
  const currentSessions = sessions.getAllSessions();
  const currentIds = new Set(currentSessions.map(s => s.id));

  let synced = 0;
  for (const tmuxSession of tmuxSessions) {
    if (currentIds.has(tmuxSession.id)) continue;

    const projectName = projectNameFromDir(tmuxSession.directory);
    const { category } = await ensureProjectCategory(guild, projectName, tmuxSession.directory);

    const channel = await guild.channels.create({
      name: `claude-${tmuxSession.id}`,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: `Claude session (synced) | Dir: ${tmuxSession.directory}`,
    });

    await sessions.createSession(tmuxSession.id, tmuxSession.directory, channel.id, projectName);
    synced++;
  }

  await interaction.editReply(
    synced > 0
      ? `Synced ${synced} orphaned session(s).`
      : 'No orphaned sessions found.',
  );
}

async function handleClaudeModel(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessions.getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No session in this channel.', ephemeral: true });
    return;
  }

  const model = interaction.options.getString('model', true);
  sessions.setModel(session.id, model);
  await interaction.reply({ content: `Model set to \`${model}\` for this session.`, ephemeral: true });
}

async function handleClaudeVerbose(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessions.getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No session in this channel.', ephemeral: true });
    return;
  }

  const newValue = !session.verbose;
  sessions.setVerbose(session.id, newValue);
  await interaction.reply({
    content: newValue
      ? 'Verbose mode **enabled** — tool calls and results will be shown.'
      : 'Verbose mode **disabled** — tool calls and results are now hidden.',
    ephemeral: true,
  });
}

const MODE_LABELS: Record<string, string> = {
  auto: '\u26A1 Auto — full autonomy, no confirmations',
  plan: '\uD83D\uDCCB Plan — always plans before executing changes',
  normal: '\uD83D\uDEE1\uFE0F Normal — asks before destructive operations',
};

async function handleClaudeMode(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessions.getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No session in this channel.', ephemeral: true });
    return;
  }

  const mode = interaction.options.getString('mode', true) as 'auto' | 'plan' | 'normal';
  sessions.setMode(session.id, mode);

  await interaction.reply({
    content: `Mode set to **${MODE_LABELS[mode]}**`,
    ephemeral: true,
  });
}

// /shell commands

export async function handleShell(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isUserAllowed(interaction.user.id, config.allowedUsers, config.allowAllUsers)) {
    await interaction.reply({ content: 'You are not authorized.', ephemeral: true });
    return;
  }

  const session = sessions.getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No session in this channel. Shell commands run in the session directory.', ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case 'run': {
      const command = interaction.options.getString('command', true);
      await interaction.deferReply();
      await interaction.editReply(`Running: \`${truncate(command, 100)}\``);
      await executeShellCommand(command, session.directory, interaction.channel as TextChannel);
      break;
    }
    case 'processes': {
      const procs = listProcesses();
      if (procs.length === 0) {
        await interaction.reply({ content: 'No running processes.', ephemeral: true });
      } else {
        const lines = procs.map(p =>
          `PID ${p.pid}: \`${truncate(p.command, 60)}\` (${formatUptime(p.startedAt)})`
        );
        await interaction.reply({ content: lines.join('\n'), ephemeral: true });
      }
      break;
    }
    case 'kill': {
      const pid = interaction.options.getInteger('pid', true);
      const killed = killProcess(pid);
      await interaction.reply({
        content: killed ? `Process ${pid} killed.` : `Process ${pid} not found.`,
        ephemeral: true,
      });
      break;
    }
  }
}

// /agent commands

export async function handleAgent(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isUserAllowed(interaction.user.id, config.allowedUsers, config.allowAllUsers)) {
    await interaction.reply({ content: 'You are not authorized.', ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case 'use': {
      const session = sessions.getSessionByChannel(interaction.channelId);
      if (!session) {
        await interaction.reply({ content: 'No session in this channel.', ephemeral: true });
        return;
      }
      const persona = interaction.options.getString('persona', true);
      const agent = getAgent(persona);
      if (!agent) {
        await interaction.reply({ content: `Unknown persona: ${persona}`, ephemeral: true });
        return;
      }
      sessions.setAgentPersona(session.id, persona === 'general' ? undefined : persona);
      await interaction.reply({
        content: persona === 'general'
          ? 'Agent persona cleared.'
          : `${agent.emoji} Agent set to **${agent.name}**: ${agent.description}`,
        ephemeral: true,
      });
      break;
    }
    case 'list': {
      const agents = listAgents();
      const embed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle('Agent Personas')
        .setDescription(agents.map(a => `${a.emoji} **${a.name}** — ${a.description}`).join('\n'));
      await interaction.reply({ embeds: [embed], ephemeral: true });
      break;
    }
    case 'clear': {
      const session = sessions.getSessionByChannel(interaction.channelId);
      if (!session) {
        await interaction.reply({ content: 'No session in this channel.', ephemeral: true });
        return;
      }
      sessions.setAgentPersona(session.id, undefined);
      await interaction.reply({ content: 'Agent persona cleared.', ephemeral: true });
      break;
    }
  }
}

// /project commands

export async function handleProject(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isUserAllowed(interaction.user.id, config.allowedUsers, config.allowAllUsers)) {
    await interaction.reply({ content: 'You are not authorized.', ephemeral: true });
    return;
  }

  const session = sessions.getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No session in this channel. Run this in a session channel.', ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();
  const projectName = session.projectName;

  switch (sub) {
    case 'personality': {
      const prompt = interaction.options.getString('prompt', true);
      projectMgr.setPersonality(projectName, prompt);
      await interaction.reply({ content: `Project personality set for **${projectName}**.`, ephemeral: true });
      log(`Project "${projectName}" personality set by ${interaction.user.tag}`);
      break;
    }
    case 'personality-show': {
      const personality = projectMgr.getPersonality(projectName);
      await interaction.reply({
        content: personality
          ? `**${projectName}** personality:\n\`\`\`\n${personality}\n\`\`\``
          : `No personality set for **${projectName}**.`,
        ephemeral: true,
      });
      break;
    }
    case 'personality-clear': {
      projectMgr.clearPersonality(projectName);
      await interaction.reply({ content: `Personality cleared for **${projectName}**.`, ephemeral: true });
      break;
    }
    case 'skill-add': {
      const name = interaction.options.getString('name', true);
      const prompt = interaction.options.getString('prompt', true);
      projectMgr.addSkill(projectName, name, prompt);
      await interaction.reply({ content: `Skill **${name}** added to **${projectName}**.`, ephemeral: true });
      break;
    }
    case 'skill-remove': {
      const name = interaction.options.getString('name', true);
      const removed = projectMgr.removeSkill(projectName, name);
      await interaction.reply({
        content: removed ? `Skill **${name}** removed.` : `Skill **${name}** not found.`,
        ephemeral: true,
      });
      break;
    }
    case 'skill-list': {
      const skills = projectMgr.getSkills(projectName);
      const entries = Object.entries(skills);
      if (entries.length === 0) {
        await interaction.reply({ content: `No skills configured for **${projectName}**.`, ephemeral: true });
      } else {
        const list = entries.map(([name, prompt]) => `**${name}**: ${truncate(prompt, 100)}`).join('\n');
        await interaction.reply({ content: `Skills for **${projectName}**:\n${list}`, ephemeral: true });
      }
      break;
    }
    case 'skill-run': {
      const name = interaction.options.getString('name', true);
      const input = interaction.options.getString('input') || undefined;
      const expanded = projectMgr.executeSkill(projectName, name, input);
      if (!expanded) {
        await interaction.reply({ content: `Skill **${name}** not found.`, ephemeral: true });
        return;
      }
      await interaction.deferReply();
      try {
        const channel = interaction.channel as TextChannel;
        await interaction.editReply(`Running skill **${name}**...`);
        const stream = sessions.sendPrompt(session.id, expanded);
        await handleOutputStream(stream, channel, session.id, session.verbose, session.mode);
      } catch (err: unknown) {
        await interaction.editReply(`Error: ${(err as Error).message}`);
      }
      break;
    }
    case 'mcp-add': {
      const name = interaction.options.getString('name', true);
      const command = interaction.options.getString('command', true);
      const argsStr = interaction.options.getString('args');
      const args = argsStr ? argsStr.split(',').map(a => a.trim()) : undefined;

      await projectMgr.addMcpServer(session.directory, projectName, { name, command, args });
      await interaction.reply({ content: `MCP server **${name}** added to **${projectName}**.`, ephemeral: true });
      log(`MCP server "${name}" added to project "${projectName}" by ${interaction.user.tag}`);
      break;
    }
    case 'mcp-remove': {
      const name = interaction.options.getString('name', true);
      const removed = await projectMgr.removeMcpServer(session.directory, projectName, name);
      await interaction.reply({
        content: removed ? `MCP server **${name}** removed.` : `MCP server **${name}** not found.`,
        ephemeral: true,
      });
      break;
    }
    case 'mcp-list': {
      const servers = projectMgr.listMcpServers(projectName);
      if (servers.length === 0) {
        await interaction.reply({ content: `No MCP servers configured for **${projectName}**.`, ephemeral: true });
      } else {
        const list = servers.map(s => {
          const args = s.args?.length ? ` ${s.args.join(' ')}` : '';
          return `**${s.name}**: \`${s.command}${args}\``;
        }).join('\n');
        await interaction.reply({ content: `MCP servers for **${projectName}**:\n${list}`, ephemeral: true });
      }
      break;
    }
    case 'info': {
      const project = projectMgr.getProject(projectName);
      if (!project) {
        await interaction.reply({ content: 'Project not found.', ephemeral: true });
        return;
      }

      const embed = new EmbedBuilder()
        .setColor(0xf39c12)
        .setTitle(`Project: ${projectName}`)
        .addFields(
          { name: 'Directory', value: `\`${project.directory}\``, inline: false },
          {
            name: 'Personality',
            value: project.personality ? truncate(project.personality, 200) : 'None',
            inline: false,
          },
          {
            name: 'Skills',
            value: Object.keys(project.skills).length > 0
              ? Object.keys(project.skills).join(', ')
              : 'None',
            inline: true,
          },
          {
            name: 'MCP Servers',
            value: project.mcpServers.length > 0
              ? project.mcpServers.map(s => s.name).join(', ')
              : 'None',
            inline: true,
          },
        );
      await interaction.reply({ embeds: [embed], ephemeral: true });
      break;
    }
  }
}
