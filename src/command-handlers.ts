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
import * as pluginMgr from './plugin-manager.ts';
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
import type { ProviderName } from './types.ts';

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

// /session commands

export async function handleSession(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isUserAllowed(interaction.user.id, config.allowedUsers, config.allowAllUsers)) {
    await interaction.reply({ content: 'You are not authorized to use this bot.', ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case 'new': return handleSessionNew(interaction);
    case 'resume': return handleSessionResume(interaction);
    case 'list': return handleSessionList(interaction);
    case 'end': return handleSessionEnd(interaction);
    case 'continue': return handleSessionContinue(interaction);
    case 'stop': return handleSessionStop(interaction);
    case 'output': return handleSessionOutput(interaction);
    case 'attach': return handleSessionAttach(interaction);
    case 'sync': return handleSessionSync(interaction);
    case 'id': return handleSessionId(interaction);
    case 'model': return handleSessionModel(interaction);
    case 'verbose': return handleSessionVerbose(interaction);
    case 'mode': return handleSessionMode(interaction);
    default:
      await interaction.reply({ content: `Unknown subcommand: ${sub}`, ephemeral: true });
  }
}

const PROVIDER_LABELS: Record<ProviderName, string> = {
  claude: 'Claude Code',
  codex: 'OpenAI Codex',
};

const PROVIDER_COLORS: Record<ProviderName, number> = {
  claude: 0x3498db,
  codex: 0x10a37f,
};

async function handleSessionNew(interaction: ChatInputCommandInteraction): Promise<void> {
  const name = interaction.options.getString('name', true);
  const provider = (interaction.options.getString('provider') || 'claude') as ProviderName;
  let directory = interaction.options.getString('directory');

  // If no directory specified, check if we're inside a project category
  if (!directory) {
    const parentId = (interaction.channel as TextChannel | null)?.parentId;
    if (parentId) {
      const project = projectMgr.getProjectByCategoryId(parentId);
      if (project) directory = project.directory;
    }
    directory = directory || config.defaultDirectory;
  }

  await interaction.deferReply();

  let channel: TextChannel | undefined;

  try {
    const guild = interaction.guild!;
    const projectName = projectNameFromDir(directory);

    const { category } = await ensureProjectCategory(guild, projectName, directory);

    // Create session first (handles name deduplication)
    // Use a temp channel ID, we'll update it after creating the channel
    const session = await sessions.createSession(name, directory, 'pending', projectName, provider);

    // Create Discord channel with the deduplicated session ID
    channel = await guild.channels.create({
      name: `${provider}-${session.id}`,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: `${PROVIDER_LABELS[provider]} session | Dir: ${directory}`,
    }) as TextChannel;

    // Link the real channel ID
    sessions.linkChannel(session.id, channel.id);

    const fields = [
      { name: 'Channel', value: `#${provider}-${session.id}`, inline: true },
      { name: 'Provider', value: PROVIDER_LABELS[provider], inline: true },
      { name: 'Directory', value: session.directory, inline: true },
      { name: 'Project', value: projectName, inline: true },
    ];
    if (session.tmuxName) {
      fields.push({ name: 'Terminal', value: `\`tmux attach -t ${session.tmuxName}\``, inline: false });
    }

    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle(`Session Created: ${session.id}`)
      .addFields(fields);

    await interaction.editReply({ embeds: [embed] });
    log(`Session "${session.id}" (${provider}) created by ${interaction.user.tag} in ${directory}`);

    // Welcome message in the new channel
    const welcomeEmbed = new EmbedBuilder()
      .setColor(PROVIDER_COLORS[provider])
      .setTitle(`${PROVIDER_LABELS[provider]} Session`)
      .setDescription(`Type a message to send it to the AI. Use \`/session stop\` to cancel generation.`);
    const welcomeFields = [
      { name: 'Directory', value: `\`${session.directory}\``, inline: false },
    ];
    if (session.tmuxName) {
      welcomeFields.push({ name: 'Terminal Access', value: `\`tmux attach -t ${session.tmuxName}\``, inline: false });
    }
    welcomeEmbed.addFields(welcomeFields);

    await channel.send({ embeds: [welcomeEmbed] });
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

export async function handleSessionAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
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

async function handleSessionResume(interaction: ChatInputCommandInteraction): Promise<void> {
  const providerSessionId = interaction.options.getString('session-id', true);
  const name = interaction.options.getString('name', true);
  const provider = (interaction.options.getString('provider') || 'claude') as ProviderName;
  const directory = interaction.options.getString('directory') || config.defaultDirectory;

  // Only validate UUID format for Claude sessions
  if (provider === 'claude') {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(providerSessionId)) {
      await interaction.reply({
        content: 'Invalid session ID. Expected a UUID like `9815d35d-6508-476e-8c40-40effa4ffd6b`.',
        ephemeral: true,
      });
      return;
    }
  }

  await interaction.deferReply();

  let channel: TextChannel | undefined;

  try {
    const guild = interaction.guild!;
    const projectName = projectNameFromDir(directory);

    const { category } = await ensureProjectCategory(guild, projectName, directory);

    const session = await sessions.createSession(name, directory, 'pending', projectName, provider, providerSessionId);

    channel = await guild.channels.create({
      name: `${provider}-${session.id}`,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: `${PROVIDER_LABELS[provider]} session (resumed) | Dir: ${directory}`,
    }) as TextChannel;

    sessions.linkChannel(session.id, channel.id);

    const fields = [
      { name: 'Channel', value: `#${provider}-${session.id}`, inline: true },
      { name: 'Provider', value: PROVIDER_LABELS[provider], inline: true },
      { name: 'Directory', value: session.directory, inline: true },
      { name: 'Project', value: projectName, inline: true },
      { name: 'Provider Session', value: `\`${providerSessionId}\``, inline: false },
    ];
    if (session.tmuxName) {
      fields.push({ name: 'Terminal', value: `\`tmux attach -t ${session.tmuxName}\``, inline: false });
    }

    const embed = new EmbedBuilder()
      .setColor(0xe67e22)
      .setTitle(`Session Resumed: ${session.id}`)
      .addFields(fields);

    await interaction.editReply({ embeds: [embed] });
    log(`Session "${session.id}" (${provider}, resumed ${providerSessionId}) created by ${interaction.user.tag} in ${directory}`);

    const welcomeFields = [
      { name: 'Directory', value: `\`${session.directory}\``, inline: false },
      { name: 'Provider Session', value: `\`${providerSessionId}\``, inline: false },
    ];
    if (session.tmuxName) {
      welcomeFields.push({ name: 'Terminal Access', value: `\`tmux attach -t ${session.tmuxName}\``, inline: false });
    }

    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0xe67e22)
          .setTitle(`${PROVIDER_LABELS[provider]} Session (Resumed)`)
          .setDescription(
            `This session is linked to an existing ${PROVIDER_LABELS[provider]} conversation. ` +
            'Type a message to continue the conversation from Discord.'
          )
          .addFields(welcomeFields),
      ],
    });
  } catch (err: unknown) {
    if (channel) {
      try { await channel.delete(); } catch { /* best effort */ }
    }
    await interaction.editReply(`Failed to resume session: ${(err as Error).message}`);
  }
}

async function handleSessionList(interaction: ChatInputCommandInteraction): Promise<void> {
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
      const providerTag = `[${s.provider}]`;
      return `**${s.id}** ${providerTag} — ${status} ${modeEmoji} ${s.mode} | ${formatUptime(s.createdAt)} uptime | ${s.messageCount} msgs | $${s.totalCost.toFixed(4)} | ${formatLastActivity(s.lastActivity)}`;
    });
    embed.addFields({ name: `📁 ${project}`, value: lines.join('\n') });
  }

  await interaction.reply({ embeds: [embed] });
}

async function handleSessionEnd(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessions.getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No session in this channel.', ephemeral: true });
    return;
  }

  await interaction.deferReply();
  try {
    await sessions.endSession(session.id);
    log(`Session "${session.id}" ended by ${interaction.user.tag}`);
    await interaction.editReply(`Session "${session.id}" ended. Deleting channel...`);
    // Give a moment for the reply to be visible, then delete the channel
    setTimeout(async () => {
      try {
        await interaction.channel?.delete();
      } catch { /* channel may already be deleted or missing permissions */ }
    }, 2000);
  } catch (err: unknown) {
    await interaction.editReply(`Failed to end session: ${(err as Error).message}`);
  }
}

async function handleSessionContinue(interaction: ChatInputCommandInteraction): Promise<void> {
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
    await handleOutputStream(stream, channel, session.id, session.verbose, session.mode, session.provider);
  } catch (err: unknown) {
    await interaction.editReply(`Error: ${(err as Error).message}`);
  }
}

async function handleSessionStop(interaction: ChatInputCommandInteraction): Promise<void> {
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

async function handleSessionOutput(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessions.getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No session in this channel.', ephemeral: true });
    return;
  }

  await interaction.reply({
    content: 'Conversation history is managed by the provider SDK. Use `/session attach` to view the full terminal history.',
    ephemeral: true,
  });
}

async function handleSessionAttach(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessions.getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No session in this channel.', ephemeral: true });
    return;
  }

  const info = sessions.getAttachInfo(session.id);
  if (!info) {
    await interaction.reply({
      content: `Terminal attach is not available for ${PROVIDER_LABELS[session.provider]} sessions.`,
      ephemeral: true,
    });
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

async function handleSessionSync(interaction: ChatInputCommandInteraction): Promise<void> {
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
      topic: `Claude Code session (synced) | Dir: ${tmuxSession.directory}`,
    });

    await sessions.createSession(tmuxSession.id, tmuxSession.directory, channel.id, projectName, 'claude');
    synced++;
  }

  await interaction.editReply(
    synced > 0
      ? `Synced ${synced} orphaned session(s).`
      : 'No orphaned sessions found.',
  );
}

async function handleSessionId(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessions.getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No session in this channel.', ephemeral: true });
    return;
  }

  const providerSessionId = session.providerSessionId;
  if (!providerSessionId) {
    await interaction.reply({
      content: 'No provider session ID yet. Send a message first to initialize the session.',
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content: `**Provider session ID** (${session.provider}):\n\`${providerSessionId}\``,
    ephemeral: true,
  });
}

async function handleSessionModel(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessions.getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No session in this channel.', ephemeral: true });
    return;
  }

  const model = interaction.options.getString('model', true);
  sessions.setModel(session.id, model);
  await interaction.reply({ content: `Model set to \`${model}\` for this session.`, ephemeral: true });
}

async function handleSessionVerbose(interaction: ChatInputCommandInteraction): Promise<void> {
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

async function handleSessionMode(interaction: ChatInputCommandInteraction): Promise<void> {
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
        await handleOutputStream(stream, channel, session.id, session.verbose, session.mode, session.provider);
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

// /plugin commands

export async function handlePlugin(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isUserAllowed(interaction.user.id, config.allowedUsers, config.allowAllUsers)) {
    await interaction.reply({ content: 'You are not authorized.', ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case 'browse': return handlePluginBrowse(interaction);
    case 'install': return handlePluginInstall(interaction);
    case 'remove': return handlePluginRemove(interaction);
    case 'list': return handlePluginList(interaction);
    case 'info': return handlePluginInfo(interaction);
    case 'enable': return handlePluginEnable(interaction);
    case 'disable': return handlePluginDisable(interaction);
    case 'update': return handlePluginUpdate(interaction);
    case 'marketplace-add': return handleMarketplaceAdd(interaction);
    case 'marketplace-remove': return handleMarketplaceRemove(interaction);
    case 'marketplace-list': return handleMarketplaceList(interaction);
    case 'marketplace-update': return handleMarketplaceUpdate(interaction);
    default:
      await interaction.reply({ content: `Unknown subcommand: ${sub}`, ephemeral: true });
  }
}

function resolveScopeAndCwd(interaction: ChatInputCommandInteraction): {
  scope: 'user' | 'project' | 'local';
  cwd?: string;
  error?: string;
} {
  const scope = (interaction.options.getString('scope') || 'user') as 'user' | 'project' | 'local';
  if (scope === 'user') return { scope };

  const session = sessions.getSessionByChannel(interaction.channelId);
  if (!session) {
    return { scope, error: `Scope \`${scope}\` requires an active session. Run this from a session channel, or use \`user\` scope.` };
  }
  return { scope, cwd: session.directory };
}

async function handlePluginBrowse(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  try {
    const search = interaction.options.getString('search')?.toLowerCase();
    const { installed, available } = await pluginMgr.listAvailable();
    const installedIds = new Set(installed.map(p => p.id));

    let filtered = available;
    if (search) {
      filtered = available.filter(p =>
        p.name.toLowerCase().includes(search) ||
        p.description.toLowerCase().includes(search) ||
        p.marketplaceName.toLowerCase().includes(search));
    }

    filtered.sort((a, b) => (b.installCount ?? 0) - (a.installCount ?? 0));

    if (filtered.length === 0) {
      await interaction.editReply('No plugins found matching your search.');
      return;
    }

    const shown = filtered.slice(0, 15);
    const embed = new EmbedBuilder()
      .setColor(0x7c3aed)
      .setTitle('Available Plugins')
      .setDescription(`Showing ${shown.length} of ${filtered.length} plugins. Use \`/plugin install\` to install.`);

    for (const p of shown) {
      const status = installedIds.has(p.pluginId) ? ' \u2705' : '';
      const count = p.installCount ? ` | ${p.installCount.toLocaleString()} installs` : '';
      embed.addFields({
        name: `${p.name}${status}`,
        value: `${truncate(p.description, 150)}\n*${p.marketplaceName}*${count}`,
      });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (err: unknown) {
    await interaction.editReply(`Error: ${(err as Error).message}`);
  }
}

async function handlePluginInstall(interaction: ChatInputCommandInteraction): Promise<void> {
  const pluginId = interaction.options.getString('plugin', true);
  const { scope, cwd, error } = resolveScopeAndCwd(interaction);
  if (error) {
    await interaction.reply({ content: error, ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    const result = await pluginMgr.installPlugin(pluginId, scope, cwd);
    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('Plugin Installed')
      .setDescription(`**${pluginId}** installed with \`${scope}\` scope.`)
      .addFields({ name: 'Output', value: truncate(result, 1000) || 'Done.' });
    await interaction.editReply({ embeds: [embed] });
    log(`Plugin "${pluginId}" installed (scope=${scope}) by ${interaction.user.tag}`);
  } catch (err: unknown) {
    await interaction.editReply(`Failed to install: ${(err as Error).message}`);
  }
}

async function handlePluginRemove(interaction: ChatInputCommandInteraction): Promise<void> {
  const pluginId = interaction.options.getString('plugin', true);
  const { scope, cwd, error } = resolveScopeAndCwd(interaction);
  if (error) {
    await interaction.reply({ content: error, ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    const result = await pluginMgr.uninstallPlugin(pluginId, scope, cwd);
    await interaction.editReply(`Plugin **${pluginId}** removed.\n${truncate(result, 500)}`);
    log(`Plugin "${pluginId}" removed (scope=${scope}) by ${interaction.user.tag}`);
  } catch (err: unknown) {
    await interaction.editReply(`Failed to remove: ${(err as Error).message}`);
  }
}

async function handlePluginList(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  try {
    const plugins = await pluginMgr.listInstalled();
    if (plugins.length === 0) {
      await interaction.editReply('No plugins installed.');
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle(`Installed Plugins (${plugins.length})`);

    for (const p of plugins) {
      const icon = p.enabled ? '\u2705' : '\u274C';
      const scopeLabel = p.scope.charAt(0).toUpperCase() + p.scope.slice(1);
      const project = p.projectPath ? `\nProject: \`${p.projectPath}\`` : '';
      embed.addFields({
        name: `${icon} ${p.id}`,
        value: `v${p.version} | ${scopeLabel} scope${project}`,
      });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (err: unknown) {
    await interaction.editReply(`Error: ${(err as Error).message}`);
  }
}

async function handlePluginInfo(interaction: ChatInputCommandInteraction): Promise<void> {
  const pluginId = interaction.options.getString('plugin', true);
  await interaction.deferReply({ ephemeral: true });

  try {
    // Parse name@marketplace
    const parts = pluginId.split('@');
    const pluginName = parts[0];
    const marketplaceName = parts[1];

    // Check installed status
    const installed = await pluginMgr.listInstalled();
    const installedEntry = installed.find(p => p.id === pluginId);

    // Get detail from marketplace
    let detail: pluginMgr.MarketplacePluginDetail | null = null;
    if (marketplaceName) {
      detail = await pluginMgr.getPluginDetail(pluginName, marketplaceName);
    }

    const embed = new EmbedBuilder()
      .setColor(0xf39c12)
      .setTitle(`Plugin: ${pluginName}`);

    if (detail) {
      embed.setDescription(detail.description);
      if (detail.author) {
        embed.addFields({ name: 'Author', value: detail.author.name, inline: true });
      }
      if (detail.category) {
        embed.addFields({ name: 'Category', value: detail.category, inline: true });
      }
      if (detail.version) {
        embed.addFields({ name: 'Version', value: detail.version, inline: true });
      }
      if (detail.tags?.length) {
        embed.addFields({ name: 'Tags', value: detail.tags.join(', '), inline: false });
      }
      if (detail.homepage) {
        embed.addFields({ name: 'Homepage', value: detail.homepage, inline: false });
      }
      if (detail.lspServers) {
        embed.addFields({ name: 'LSP Servers', value: Object.keys(detail.lspServers).join(', '), inline: true });
      }
      if (detail.mcpServers) {
        embed.addFields({ name: 'MCP Servers', value: Object.keys(detail.mcpServers).join(', '), inline: true });
      }
    }

    if (installedEntry) {
      const icon = installedEntry.enabled ? '\u2705 Enabled' : '\u274C Disabled';
      embed.addFields(
        { name: 'Status', value: `${icon} | v${installedEntry.version}`, inline: true },
        { name: 'Scope', value: installedEntry.scope, inline: true },
        { name: 'Installed', value: new Date(installedEntry.installedAt).toLocaleDateString(), inline: true },
      );
    } else {
      embed.addFields({ name: 'Status', value: 'Not installed', inline: true });
    }

    if (marketplaceName) {
      embed.setFooter({ text: `Marketplace: ${marketplaceName}` });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (err: unknown) {
    await interaction.editReply(`Error: ${(err as Error).message}`);
  }
}

async function handlePluginEnable(interaction: ChatInputCommandInteraction): Promise<void> {
  const pluginId = interaction.options.getString('plugin', true);
  const { scope, cwd, error } = resolveScopeAndCwd(interaction);
  if (error) {
    await interaction.reply({ content: error, ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    await pluginMgr.enablePlugin(pluginId, scope, cwd);
    await interaction.editReply(`Plugin **${pluginId}** enabled (\`${scope}\` scope).`);
    log(`Plugin "${pluginId}" enabled (scope=${scope}) by ${interaction.user.tag}`);
  } catch (err: unknown) {
    await interaction.editReply(`Failed to enable: ${(err as Error).message}`);
  }
}

async function handlePluginDisable(interaction: ChatInputCommandInteraction): Promise<void> {
  const pluginId = interaction.options.getString('plugin', true);
  const { scope, cwd, error } = resolveScopeAndCwd(interaction);
  if (error) {
    await interaction.reply({ content: error, ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    await pluginMgr.disablePlugin(pluginId, scope, cwd);
    await interaction.editReply(`Plugin **${pluginId}** disabled (\`${scope}\` scope).`);
    log(`Plugin "${pluginId}" disabled (scope=${scope}) by ${interaction.user.tag}`);
  } catch (err: unknown) {
    await interaction.editReply(`Failed to disable: ${(err as Error).message}`);
  }
}

async function handlePluginUpdate(interaction: ChatInputCommandInteraction): Promise<void> {
  const pluginId = interaction.options.getString('plugin', true);
  const { scope, cwd, error } = resolveScopeAndCwd(interaction);
  if (error) {
    await interaction.reply({ content: error, ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    const result = await pluginMgr.updatePlugin(pluginId, scope, cwd);
    await interaction.editReply(`Plugin **${pluginId}** updated.\n${truncate(result, 500)}`);
    log(`Plugin "${pluginId}" updated (scope=${scope}) by ${interaction.user.tag}`);
  } catch (err: unknown) {
    await interaction.editReply(`Failed to update: ${(err as Error).message}`);
  }
}

async function handleMarketplaceAdd(interaction: ChatInputCommandInteraction): Promise<void> {
  const source = interaction.options.getString('source', true);
  await interaction.deferReply({ ephemeral: true });
  try {
    const result = await pluginMgr.addMarketplace(source);
    await interaction.editReply(`Marketplace added from \`${source}\`.\n${truncate(result, 500)}`);
    log(`Marketplace "${source}" added by ${interaction.user.tag}`);
  } catch (err: unknown) {
    await interaction.editReply(`Failed to add marketplace: ${(err as Error).message}`);
  }
}

async function handleMarketplaceRemove(interaction: ChatInputCommandInteraction): Promise<void> {
  const name = interaction.options.getString('name', true);
  await interaction.deferReply({ ephemeral: true });
  try {
    const result = await pluginMgr.removeMarketplace(name);
    await interaction.editReply(`Marketplace **${name}** removed.\n${truncate(result, 500)}`);
    log(`Marketplace "${name}" removed by ${interaction.user.tag}`);
  } catch (err: unknown) {
    await interaction.editReply(`Failed to remove marketplace: ${(err as Error).message}`);
  }
}

async function handleMarketplaceList(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  try {
    const marketplaces = await pluginMgr.listMarketplaces();
    if (marketplaces.length === 0) {
      await interaction.editReply('No marketplaces registered.');
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0x9b59b6)
      .setTitle(`Marketplaces (${marketplaces.length})`);

    for (const m of marketplaces) {
      const source = m.repo || m.url || m.source;
      embed.addFields({
        name: m.name,
        value: `Source: \`${source}\`\nPath: \`${m.installLocation}\``,
      });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (err: unknown) {
    await interaction.editReply(`Error: ${(err as Error).message}`);
  }
}

async function handleMarketplaceUpdate(interaction: ChatInputCommandInteraction): Promise<void> {
  const name = interaction.options.getString('name') || undefined;
  await interaction.deferReply({ ephemeral: true });
  try {
    const result = await pluginMgr.updateMarketplaces(name);
    await interaction.editReply(`Marketplace${name ? ` **${name}**` : 's'} updated.\n${truncate(result, 500)}`);
    log(`Marketplace${name ? ` "${name}"` : 's'} updated by ${interaction.user.tag}`);
  } catch (err: unknown) {
    await interaction.editReply(`Failed to update: ${(err as Error).message}`);
  }
}

// /plugin autocomplete

export async function handlePluginAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  const focused = interaction.options.getFocused().toLowerCase();

  try {
    if (sub === 'install' || (sub === 'info' && !focused.includes('@'))) {
      // Show available plugins from marketplaces
      const { available } = await pluginMgr.listAvailable();
      const filtered = focused
        ? available.filter(p =>
            p.name.toLowerCase().includes(focused) ||
            p.pluginId.toLowerCase().includes(focused) ||
            p.description.toLowerCase().includes(focused))
        : available;
      filtered.sort((a, b) => (b.installCount ?? 0) - (a.installCount ?? 0));
      const choices = filtered.slice(0, 25).map(p => ({
        name: `${p.name} (${p.marketplaceName})`.slice(0, 100),
        value: p.pluginId,
      }));
      await interaction.respond(choices);
    } else if (['remove', 'enable', 'disable', 'update', 'info'].includes(sub)) {
      // Show installed plugins
      const installed = await pluginMgr.listInstalled();
      const filtered = focused
        ? installed.filter(p => p.id.toLowerCase().includes(focused))
        : installed;
      const choices = filtered.slice(0, 25).map(p => ({
        name: `${p.id} (v${p.version}, ${p.scope})`.slice(0, 100),
        value: p.id,
      }));
      await interaction.respond(choices);
    } else if (sub === 'marketplace-remove' || sub === 'marketplace-update') {
      const marketplaces = await pluginMgr.listMarketplaces();
      const filtered = focused
        ? marketplaces.filter(m => m.name.toLowerCase().includes(focused))
        : marketplaces;
      const choices = filtered.slice(0, 25).map(m => ({
        name: m.name,
        value: m.name,
      }));
      await interaction.respond(choices);
    } else {
      await interaction.respond([]);
    }
  } catch {
    await interaction.respond([]);
  }
}
