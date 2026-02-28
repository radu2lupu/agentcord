import {
  Client,
  GatewayIntentBits,
  ActivityType,
  InteractionType,
  ComponentType,
  type TextChannel,
  ChannelType,
  Collection,
} from 'discord.js';
import { config } from './config.ts';
import { registerCommands } from './commands.ts';
import { handleSession, handleSessionAutocomplete, handleShell, handleAgent, handleProject, handlePlugin, handlePluginAutocomplete, setLogger } from './command-handlers.ts';
import { handleMessage } from './message-handler.ts';
import { handleButton, handleSelectMenu } from './button-handler.ts';
import { loadSessions, getAllSessions, unlinkChannel } from './session-manager.ts';
import { loadProjects } from './project-manager.ts';

let client: Client;
let logChannel: TextChannel | null = null;
let logBuffer: string[] = [];
let logTimer: ReturnType<typeof setTimeout> | null = null;

function botLog(msg: string): void {
  const timestamp = new Date().toISOString().slice(11, 19);
  const formatted = `\`[${timestamp}]\` ${msg}`;
  console.log(`[${timestamp}] ${msg}`);

  logBuffer.push(formatted);
  if (!logTimer) {
    logTimer = setTimeout(flushLogs, 2000);
  }
}

async function flushLogs(): Promise<void> {
  logTimer = null;
  if (!logChannel || logBuffer.length === 0) return;

  const batch = logBuffer.splice(0, logBuffer.length).join('\n');
  try {
    await logChannel.send(batch);
  } catch {
    // Log channel may have been deleted
  }
}

function updatePresence(): void {
  const sessionCount = getAllSessions().length;
  const generating = getAllSessions().filter(s => s.isGenerating).length;

  if (sessionCount === 0) {
    client.user?.setPresence({
      status: 'idle',
      activities: [{ name: 'No active sessions', type: ActivityType.Custom }],
    });
  } else {
    const status = generating > 0 ? `${generating} generating` : `${sessionCount} sessions`;
    client.user?.setPresence({
      status: 'online',
      activities: [{ name: `${status}`, type: ActivityType.Watching }],
    });
  }
}

// Message retention cleanup
async function cleanupOldMessages(): Promise<void> {
  if (!config.messageRetentionDays) return;

  const cutoff = Date.now() - config.messageRetentionDays * 24 * 60 * 60 * 1000;

  for (const session of getAllSessions()) {
    try {
      const channel = client.channels.cache.get(session.channelId) as TextChannel | undefined;
      if (!channel) continue;

      const messages = await channel.messages.fetch({ limit: 100 });
      const old = messages.filter(m => m.createdTimestamp < cutoff);
      if (old.size > 0) {
        await channel.bulkDelete(old, true);
      }
    } catch {
      // Channel may not exist
    }
  }
}

export async function startBot(): Promise<void> {
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  setLogger(botLog);

  // Slash commands
  client.on('interactionCreate', async interaction => {
    try {
      if (interaction.type === InteractionType.ApplicationCommand && interaction.isChatInputCommand()) {
        switch (interaction.commandName) {
          case 'session': return await handleSession(interaction);
          case 'shell': return await handleShell(interaction);
          case 'agent': return await handleAgent(interaction);
          case 'project': return await handleProject(interaction);
          case 'plugin': return await handlePlugin(interaction);
        }
      }

      if (interaction.isAutocomplete()) {
        if (interaction.commandName === 'session') {
          return await handleSessionAutocomplete(interaction);
        }
        if (interaction.commandName === 'plugin') {
          return await handlePluginAutocomplete(interaction);
        }
      }

      if (interaction.isButton()) {
        return await handleButton(interaction);
      }

      if (interaction.isStringSelectMenu()) {
        return await handleSelectMenu(interaction);
      }
    } catch (err) {
      console.error('Interaction error:', err);
      try {
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: 'An error occurred.', ephemeral: true });
        }
      } catch { /* can't recover */ }
    }
  });

  // Channel messages
  client.on('messageCreate', handleMessage);

  // Channel deletion cleanup
  client.on('channelDelete', channel => {
    if (channel.type === ChannelType.GuildText) {
      void unlinkChannel(channel.id);
    }
  });

  // Ready
  client.once('ready', async () => {
    console.log(`Logged in as ${client.user?.tag}`);

    // Register commands
    await registerCommands();

    // Load persisted state
    await loadProjects();
    await loadSessions();

    // Set up log channel in the first guild
    const guild = client.guilds.cache.first();
    if (guild) {
      // Find existing bot-logs channel or note it doesn't exist
      logChannel = guild.channels.cache.find(
        ch => ch.name === 'bot-logs' && ch.type === ChannelType.GuildText,
      ) as TextChannel | undefined ?? null;

      if (!logChannel) {
        try {
          logChannel = await guild.channels.create({
            name: 'bot-logs',
            type: ChannelType.GuildText,
          });
        } catch {
          console.warn('Could not create #bot-logs channel');
        }
      }
    }

    botLog(`Bot online. ${getAllSessions().length} session(s) restored.`);
    updatePresence();

    // Presence update interval
    setInterval(updatePresence, 30_000);

    // Message cleanup
    if (config.messageRetentionDays) {
      await cleanupOldMessages();
      setInterval(cleanupOldMessages, 60 * 60 * 1000); // hourly
    }
  });

  // Graceful shutdown
  const shutdown = () => {
    botLog('Shutting down...');
    flushLogs();
    client.destroy();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await client.login(config.token);
}
