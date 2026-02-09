import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PLUGINS_DIR = join(homedir(), '.claude', 'plugins');
const MARKETPLACES_DIR = join(PLUGINS_DIR, 'marketplaces');

// --- Types for CLI JSON output ---

export interface InstalledPlugin {
  id: string;
  version: string;
  scope: 'user' | 'project' | 'local';
  enabled: boolean;
  installPath: string;
  installedAt: string;
  lastUpdated: string;
  projectPath?: string;
}

export interface AvailablePlugin {
  pluginId: string;
  name: string;
  description: string;
  marketplaceName: string;
  version: string;
  source: string;
  installCount?: number;
}

export interface MarketplaceInfo {
  name: string;
  source: string;
  repo?: string;
  url?: string;
  installLocation: string;
}

export interface MarketplacePluginDetail {
  name: string;
  description: string;
  version?: string;
  author?: { name: string; email?: string };
  source: string | { source: string; url: string };
  category?: string;
  keywords?: string[];
  tags?: string[];
  homepage?: string;
  lspServers?: Record<string, unknown>;
  mcpServers?: Record<string, unknown>;
  strict?: boolean;
}

interface MarketplaceCatalog {
  name: string;
  description?: string;
  owner?: { name: string; email?: string };
  plugins: MarketplacePluginDetail[];
}

// --- CLI helper ---

function runClaude(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile('claude', args, {
      cwd: cwd || process.cwd(),
      timeout: 120_000,
      env: { ...process.env },
    }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        code: error ? ((error as NodeJS.ErrnoException).code as unknown as number ?? 1) : 0,
      });
    });
  });
}

// --- Cache ---

interface CacheEntry<T> { data: T; ts: number }
const CACHE_TTL_MS = 30_000;

let installedCache: CacheEntry<InstalledPlugin[]> | null = null;
let availableCache: CacheEntry<{ installed: InstalledPlugin[]; available: AvailablePlugin[] }> | null = null;
let marketplaceCache: CacheEntry<MarketplaceInfo[]> | null = null;

export function invalidateCache(): void {
  installedCache = null;
  availableCache = null;
  marketplaceCache = null;
}

// --- Installed plugins ---

export async function listInstalled(): Promise<InstalledPlugin[]> {
  if (installedCache && Date.now() - installedCache.ts < CACHE_TTL_MS) {
    return installedCache.data;
  }
  const result = await runClaude(['plugin', 'list', '--json']);
  if (result.code !== 0) throw new Error(`Failed to list plugins: ${result.stderr}`);
  const data: InstalledPlugin[] = JSON.parse(result.stdout);
  installedCache = { data, ts: Date.now() };
  return data;
}

// --- Available plugins ---

export async function listAvailable(): Promise<{ installed: InstalledPlugin[]; available: AvailablePlugin[] }> {
  if (availableCache && Date.now() - availableCache.ts < CACHE_TTL_MS) {
    return availableCache.data;
  }
  const result = await runClaude(['plugin', 'list', '--available', '--json']);
  if (result.code !== 0) throw new Error(`Failed to list available plugins: ${result.stderr}`);
  const data = JSON.parse(result.stdout);
  availableCache = { data, ts: Date.now() };
  return data;
}

// --- Install ---

export async function installPlugin(
  pluginId: string,
  scope: 'user' | 'project' | 'local',
  cwd?: string,
): Promise<string> {
  const result = await runClaude(['plugin', 'install', pluginId, '-s', scope], cwd);
  invalidateCache();
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || 'Install failed');
  return result.stdout.trim() || 'Plugin installed successfully.';
}

// --- Uninstall ---

export async function uninstallPlugin(
  pluginId: string,
  scope: 'user' | 'project' | 'local',
  cwd?: string,
): Promise<string> {
  const result = await runClaude(['plugin', 'uninstall', pluginId, '-s', scope], cwd);
  invalidateCache();
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || 'Uninstall failed');
  return result.stdout.trim() || 'Plugin uninstalled successfully.';
}

// --- Enable / Disable ---

export async function enablePlugin(
  pluginId: string,
  scope: 'user' | 'project' | 'local',
  cwd?: string,
): Promise<string> {
  const result = await runClaude(['plugin', 'enable', pluginId, '-s', scope], cwd);
  invalidateCache();
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || 'Enable failed');
  return result.stdout.trim() || 'Plugin enabled.';
}

export async function disablePlugin(
  pluginId: string,
  scope: 'user' | 'project' | 'local',
  cwd?: string,
): Promise<string> {
  const result = await runClaude(['plugin', 'disable', pluginId, '-s', scope], cwd);
  invalidateCache();
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || 'Disable failed');
  return result.stdout.trim() || 'Plugin disabled.';
}

// --- Update ---

export async function updatePlugin(
  pluginId: string,
  scope: 'user' | 'project' | 'local',
  cwd?: string,
): Promise<string> {
  const result = await runClaude(['plugin', 'update', pluginId, '-s', scope], cwd);
  invalidateCache();
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || 'Update failed');
  return result.stdout.trim() || 'Plugin updated.';
}

// --- Marketplace operations ---

export async function listMarketplaces(): Promise<MarketplaceInfo[]> {
  if (marketplaceCache && Date.now() - marketplaceCache.ts < CACHE_TTL_MS) {
    return marketplaceCache.data;
  }
  const result = await runClaude(['plugin', 'marketplace', 'list', '--json']);
  if (result.code !== 0) throw new Error(`Failed to list marketplaces: ${result.stderr}`);
  const data: MarketplaceInfo[] = JSON.parse(result.stdout);
  marketplaceCache = { data, ts: Date.now() };
  return data;
}

export async function addMarketplace(source: string): Promise<string> {
  const result = await runClaude(['plugin', 'marketplace', 'add', source]);
  invalidateCache();
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || 'Add marketplace failed');
  return result.stdout.trim() || 'Marketplace added.';
}

export async function removeMarketplace(name: string): Promise<string> {
  const result = await runClaude(['plugin', 'marketplace', 'remove', name]);
  invalidateCache();
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || 'Remove marketplace failed');
  return result.stdout.trim() || 'Marketplace removed.';
}

export async function updateMarketplaces(name?: string): Promise<string> {
  const args = ['plugin', 'marketplace', 'update'];
  if (name) args.push(name);
  const result = await runClaude(args);
  invalidateCache();
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || 'Update marketplace failed');
  return result.stdout.trim() || 'Marketplace(s) updated.';
}

// --- Plugin detail from marketplace.json ---

export async function getPluginDetail(pluginName: string, marketplaceName: string): Promise<MarketplacePluginDetail | null> {
  try {
    const marketplacePath = join(MARKETPLACES_DIR, marketplaceName, '.claude-plugin', 'marketplace.json');
    const raw = await readFile(marketplacePath, 'utf-8');
    const catalog: MarketplaceCatalog = JSON.parse(raw);
    return catalog.plugins.find(p => p.name === pluginName) || null;
  } catch {
    return null;
  }
}
