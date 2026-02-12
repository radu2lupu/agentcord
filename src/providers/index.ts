import { execFileSync } from 'node:child_process';
import type { Provider, ProviderName } from './types.ts';
import { ClaudeProvider } from './claude-provider.ts';

export type { Provider, ProviderName, ProviderEvent, ProviderSessionOptions, ContentBlock, ImageMediaType, TextBlock, ImageBlock, LocalImageBlock } from './types.ts';

const providers = new Map<ProviderName, Provider>();

// Claude is always available
providers.set('claude', new ClaudeProvider());

let codexLoaded = false;

// SDK package names for providers that need auto-install
const PROVIDER_PACKAGES: Partial<Record<ProviderName, string>> = {
  codex: '@openai/codex-sdk',
};

function isPackageInstalled(pkg: string): boolean {
  try {
    execFileSync('npm', ['ls', pkg, '--global', '--depth=0'], { stdio: 'pipe' });
    return true;
  } catch { /* not installed globally */ }
  try {
    execFileSync('npm', ['ls', pkg, '--depth=0'], { stdio: 'pipe' });
    return true;
  } catch { /* not installed locally either */ }
  return false;
}

function installPackageGlobally(pkg: string): void {
  console.log(`[providers] Auto-installing ${pkg} globally...`);
  execFileSync('npm', ['install', '-g', pkg], { stdio: 'inherit' });
  console.log(`[providers] ${pkg} installed successfully.`);
}

async function loadCodexProvider(): Promise<void> {
  const pkg = PROVIDER_PACKAGES.codex!;

  // Try loading first — may already be available
  try {
    const { CodexProvider } = await import('./codex-provider.ts');
    providers.set('codex', new CodexProvider());
    codexLoaded = true;
    return;
  } catch {
    // SDK not available — try to install it
  }

  // Auto-install if not present
  if (!isPackageInstalled(pkg)) {
    try {
      installPackageGlobally(pkg);
    } catch (err: unknown) {
      throw new Error(
        `Failed to auto-install ${pkg}: ${(err as Error).message}. Install manually: npm install -g ${pkg}`,
      );
    }
  }

  // Retry loading after install
  try {
    const { CodexProvider } = await import('./codex-provider.ts');
    providers.set('codex', new CodexProvider());
    codexLoaded = true;
  } catch (err: unknown) {
    throw new Error(
      `${pkg} is installed but failed to load: ${(err as Error).message}`,
    );
  }
}

export function getProvider(name: ProviderName): Provider {
  const provider = providers.get(name);
  if (provider) return provider;
  throw new Error(`Provider "${name}" not loaded. Call ensureProvider("${name}") first.`);
}

export async function ensureProvider(name: ProviderName): Promise<Provider> {
  if (providers.has(name)) return providers.get(name)!;

  if (name === 'codex' && !codexLoaded) {
    await loadCodexProvider();
    return providers.get('codex')!;
  }

  throw new Error(`Unknown provider: ${name}`);
}

export async function isProviderAvailable(name: ProviderName): Promise<boolean> {
  if (providers.has(name)) return true;
  if (name === 'codex') {
    try {
      await ensureProvider('codex');
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function listProviders(): ProviderName[] {
  return ['claude', 'codex'];
}
