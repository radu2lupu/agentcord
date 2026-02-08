const command = process.argv[2];

switch (command) {
  case 'setup': {
    const { runSetup } = await import('./setup.ts');
    await runSetup();
    break;
  }
  case 'start':
  case undefined: {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');

    const envPath = resolve(process.cwd(), '.env');
    if (!existsSync(envPath)) {
      console.log('\x1b[33mNo .env file found in the current directory.\x1b[0m');
      console.log('Run \x1b[36magentcord setup\x1b[0m to configure.\n');
      process.exit(1);
    }

    const { startBot } = await import('./bot.ts');
    console.log('agentcord starting...');
    await startBot();
    break;
  }
  case 'daemon': {
    const { handleDaemon } = await import('./daemon.ts');
    await handleDaemon(process.argv[3]);
    break;
  }
  case 'help':
  case '--help':
  case '-h': {
    console.log(`
  \x1b[1magentcord\x1b[0m — Discord bot for managing Claude Code sessions

  \x1b[1mUsage:\x1b[0m
    agentcord              Start the bot
    agentcord setup        Interactive configuration wizard
    agentcord daemon       Manage background service (install/uninstall/status)
    agentcord help         Show this help message

  \x1b[1mQuick start:\x1b[0m
    1. agentcord setup     Configure Discord app, token, permissions
    2. agentcord           Start the bot
    3. /claude new <name> <dir>  Create a session in Discord

  \x1b[2mhttps://github.com/radu2lupu/agentcord\x1b[0m
`);
    break;
  }
  default:
    console.error(`Unknown command: ${command}`);
    console.error('Run \x1b[36magentcord help\x1b[0m for usage.');
    process.exit(1);
}
