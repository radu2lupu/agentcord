import {
  SlashCommandBuilder,
  REST,
  Routes,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import { config } from './config.ts';

export function getCommandDefinitions(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const session = new SlashCommandBuilder()
    .setName('session')
    .setDescription('Manage AI coding sessions')
    .addSubcommand(sub =>
      sub.setName('new')
        .setDescription('Create a new coding session')
        .addStringOption(opt =>
          opt.setName('name').setDescription('Session name').setRequired(true))
        .addStringOption(opt =>
          opt.setName('provider').setDescription('AI provider')
            .addChoices(
              { name: 'Claude Code', value: 'claude' },
              { name: 'OpenAI Codex', value: 'codex' },
            ))
        .addStringOption(opt =>
          opt.setName('directory').setDescription('Working directory (default: configured default)')))
    .addSubcommand(sub =>
      sub.setName('resume')
        .setDescription('Resume an existing session from terminal')
        .addStringOption(opt =>
          opt.setName('session-id').setDescription('Provider session ID').setRequired(true).setAutocomplete(true))
        .addStringOption(opt =>
          opt.setName('name').setDescription('Name for the Discord channel').setRequired(true))
        .addStringOption(opt =>
          opt.setName('provider').setDescription('AI provider')
            .addChoices(
              { name: 'Claude Code', value: 'claude' },
              { name: 'OpenAI Codex', value: 'codex' },
            ))
        .addStringOption(opt =>
          opt.setName('directory').setDescription('Working directory (default: configured default)')))
    .addSubcommand(sub =>
      sub.setName('list').setDescription('List active sessions'))
    .addSubcommand(sub =>
      sub.setName('end').setDescription('End the session in this channel'))
    .addSubcommand(sub =>
      sub.setName('continue').setDescription('Continue the last conversation'))
    .addSubcommand(sub =>
      sub.setName('stop').setDescription('Stop current generation'))
    .addSubcommand(sub =>
      sub.setName('output')
        .setDescription('Show recent conversation output')
        .addIntegerOption(opt =>
          opt.setName('lines').setDescription('Number of lines (default 50)').setMinValue(1).setMaxValue(500)))
    .addSubcommand(sub =>
      sub.setName('attach').setDescription('Show tmux attach command for terminal access'))
    .addSubcommand(sub =>
      sub.setName('sync').setDescription('Reconnect orphaned tmux sessions'))
    .addSubcommand(sub =>
      sub.setName('model')
        .setDescription('Change the model for this session')
        .addStringOption(opt =>
          opt.setName('model').setDescription('Model name (e.g. claude-sonnet-4-5-20250929, gpt-5.3-codex)').setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('id').setDescription('Show the provider session ID for this channel'))
    .addSubcommand(sub =>
      sub.setName('verbose').setDescription('Toggle showing tool calls and results in this session'))
    .addSubcommand(sub =>
      sub.setName('mode')
        .setDescription('Set session mode (auto/plan/normal)')
        .addStringOption(opt =>
          opt.setName('mode').setDescription('Session mode').setRequired(true)
            .addChoices(
              { name: 'Auto \u2014 full autonomy', value: 'auto' },
              { name: 'Plan \u2014 plan before executing', value: 'plan' },
              { name: 'Normal \u2014 ask before destructive ops', value: 'normal' },
            )));

  const shell = new SlashCommandBuilder()
    .setName('shell')
    .setDescription('Run shell commands in the session directory')
    .addSubcommand(sub =>
      sub.setName('run')
        .setDescription('Execute a shell command')
        .addStringOption(opt =>
          opt.setName('command').setDescription('Command to run').setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('processes').setDescription('List running processes'))
    .addSubcommand(sub =>
      sub.setName('kill')
        .setDescription('Kill a running process')
        .addIntegerOption(opt =>
          opt.setName('pid').setDescription('Process ID to kill').setRequired(true)));

  const agent = new SlashCommandBuilder()
    .setName('agent')
    .setDescription('Manage agent personas')
    .addSubcommand(sub =>
      sub.setName('use')
        .setDescription('Switch to an agent persona')
        .addStringOption(opt =>
          opt.setName('persona')
            .setDescription('Agent persona name')
            .setRequired(true)
            .addChoices(
              { name: 'Code Reviewer', value: 'code-reviewer' },
              { name: 'Architect', value: 'architect' },
              { name: 'Debugger', value: 'debugger' },
              { name: 'Security Analyst', value: 'security' },
              { name: 'Performance Engineer', value: 'performance' },
              { name: 'DevOps Engineer', value: 'devops' },
              { name: 'General', value: 'general' },
            )))
    .addSubcommand(sub =>
      sub.setName('list').setDescription('List available agent personas'))
    .addSubcommand(sub =>
      sub.setName('clear').setDescription('Clear agent persona'));

  const project = new SlashCommandBuilder()
    .setName('project')
    .setDescription('Configure project settings')
    .addSubcommand(sub =>
      sub.setName('personality')
        .setDescription('Set a custom personality for this project')
        .addStringOption(opt =>
          opt.setName('prompt').setDescription('System prompt for the project').setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('personality-show').setDescription('Show the current project personality'))
    .addSubcommand(sub =>
      sub.setName('personality-clear').setDescription('Clear the project personality'))
    .addSubcommand(sub =>
      sub.setName('skill-add')
        .setDescription('Add a skill (prompt template) to this project')
        .addStringOption(opt =>
          opt.setName('name').setDescription('Skill name').setRequired(true))
        .addStringOption(opt =>
          opt.setName('prompt').setDescription('Prompt template (use {input} for placeholder)').setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('skill-remove')
        .setDescription('Remove a skill')
        .addStringOption(opt =>
          opt.setName('name').setDescription('Skill name').setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('skill-list').setDescription('List all skills for this project'))
    .addSubcommand(sub =>
      sub.setName('skill-run')
        .setDescription('Execute a skill')
        .addStringOption(opt =>
          opt.setName('name').setDescription('Skill name').setRequired(true))
        .addStringOption(opt =>
          opt.setName('input').setDescription('Input to pass to the skill template')))
    .addSubcommand(sub =>
      sub.setName('mcp-add')
        .setDescription('Add an MCP server to this project')
        .addStringOption(opt =>
          opt.setName('name').setDescription('Server name').setRequired(true))
        .addStringOption(opt =>
          opt.setName('command').setDescription('Command to run (e.g. npx my-mcp-server)').setRequired(true))
        .addStringOption(opt =>
          opt.setName('args').setDescription('Arguments (comma-separated)')))
    .addSubcommand(sub =>
      sub.setName('mcp-remove')
        .setDescription('Remove an MCP server')
        .addStringOption(opt =>
          opt.setName('name').setDescription('Server name').setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('mcp-list').setDescription('List configured MCP servers'))
    .addSubcommand(sub =>
      sub.setName('info').setDescription('Show project configuration'));

  const plugin = new SlashCommandBuilder()
    .setName('plugin')
    .setDescription('Manage Claude Code plugins')
    .addSubcommand(sub =>
      sub.setName('browse')
        .setDescription('Browse available plugins from marketplaces')
        .addStringOption(opt =>
          opt.setName('search').setDescription('Filter by name or keyword')))
    .addSubcommand(sub =>
      sub.setName('install')
        .setDescription('Install a plugin')
        .addStringOption(opt =>
          opt.setName('plugin').setDescription('Plugin name (e.g. feature-dev@claude-plugins-official)').setRequired(true).setAutocomplete(true))
        .addStringOption(opt =>
          opt.setName('scope').setDescription('Installation scope (default: user)')
            .addChoices(
              { name: 'User \u2014 available everywhere', value: 'user' },
              { name: 'Project \u2014 this project only', value: 'project' },
              { name: 'Local \u2014 this directory only', value: 'local' },
            )))
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Uninstall a plugin')
        .addStringOption(opt =>
          opt.setName('plugin').setDescription('Plugin ID').setRequired(true).setAutocomplete(true))
        .addStringOption(opt =>
          opt.setName('scope').setDescription('Scope to uninstall from (default: user)')
            .addChoices(
              { name: 'User', value: 'user' },
              { name: 'Project', value: 'project' },
              { name: 'Local', value: 'local' },
            )))
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('List installed plugins'))
    .addSubcommand(sub =>
      sub.setName('info')
        .setDescription('Show detailed info for a plugin')
        .addStringOption(opt =>
          opt.setName('plugin').setDescription('Plugin name or ID').setRequired(true).setAutocomplete(true)))
    .addSubcommand(sub =>
      sub.setName('enable')
        .setDescription('Enable a disabled plugin')
        .addStringOption(opt =>
          opt.setName('plugin').setDescription('Plugin ID').setRequired(true).setAutocomplete(true))
        .addStringOption(opt =>
          opt.setName('scope').setDescription('Scope (default: user)')
            .addChoices(
              { name: 'User', value: 'user' },
              { name: 'Project', value: 'project' },
              { name: 'Local', value: 'local' },
            )))
    .addSubcommand(sub =>
      sub.setName('disable')
        .setDescription('Disable a plugin')
        .addStringOption(opt =>
          opt.setName('plugin').setDescription('Plugin ID').setRequired(true).setAutocomplete(true))
        .addStringOption(opt =>
          opt.setName('scope').setDescription('Scope (default: user)')
            .addChoices(
              { name: 'User', value: 'user' },
              { name: 'Project', value: 'project' },
              { name: 'Local', value: 'local' },
            )))
    .addSubcommand(sub =>
      sub.setName('update')
        .setDescription('Update a plugin to latest version')
        .addStringOption(opt =>
          opt.setName('plugin').setDescription('Plugin ID').setRequired(true).setAutocomplete(true))
        .addStringOption(opt =>
          opt.setName('scope').setDescription('Scope (default: user)')
            .addChoices(
              { name: 'User', value: 'user' },
              { name: 'Project', value: 'project' },
              { name: 'Local', value: 'local' },
            )))
    .addSubcommand(sub =>
      sub.setName('marketplace-add')
        .setDescription('Add a plugin marketplace')
        .addStringOption(opt =>
          opt.setName('source').setDescription('GitHub repo (owner/repo) or git URL').setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('marketplace-remove')
        .setDescription('Remove a marketplace')
        .addStringOption(opt =>
          opt.setName('name').setDescription('Marketplace name').setRequired(true).setAutocomplete(true)))
    .addSubcommand(sub =>
      sub.setName('marketplace-list')
        .setDescription('List registered marketplaces'))
    .addSubcommand(sub =>
      sub.setName('marketplace-update')
        .setDescription('Update marketplace catalogs')
        .addStringOption(opt =>
          opt.setName('name').setDescription('Specific marketplace (or all if omitted)').setAutocomplete(true)));

  return [
    session.toJSON(),
    shell.toJSON(),
    agent.toJSON(),
    project.toJSON(),
    plugin.toJSON(),
  ];
}

export async function registerCommands(): Promise<void> {
  const rest = new REST().setToken(config.token);
  const commands = getCommandDefinitions();

  try {
    if (config.guildId) {
      await rest.put(
        Routes.applicationGuildCommands(config.clientId, config.guildId),
        { body: commands },
      );
      console.log(`Registered ${commands.length} guild commands`);
    } else {
      await rest.put(
        Routes.applicationCommands(config.clientId),
        { body: commands },
      );
      console.log(`Registered ${commands.length} global commands (may take ~1hr to propagate)`);
    }
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
}
