import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const envPath = resolve(process.cwd(), '.env');

if (!existsSync(envPath)) {
  console.log('\x1b[33mNo .env file found in the current directory.\x1b[0m');
  console.log('Run \x1b[36magentcord setup\x1b[0m to configure.\n');
  process.exit(1);
}

const { startBot } = await import('./bot.ts');

console.log('agentcord starting...');
startBot().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
