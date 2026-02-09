import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './persistence.ts';
import type { Project, McpServer } from './types.ts';

const projectStore = new Store<Record<string, Project>>('projects.json');

let projects: Record<string, Project> = {};

export async function loadProjects(): Promise<void> {
  projects = (await projectStore.read()) || {};
}

async function saveProjects(): Promise<void> {
  await projectStore.write(projects);
}

export function getProject(name: string): Project | undefined {
  return projects[name];
}

export function getAllProjects(): Record<string, Project> {
  return { ...projects };
}

export function getProjectByCategoryId(categoryId: string): Project | undefined {
  return Object.values(projects).find(p => p.categoryId === categoryId);
}

export function getOrCreateProject(name: string, directory: string, categoryId: string): Project {
  if (!projects[name]) {
    projects[name] = {
      name,
      directory,
      categoryId,
      skills: {},
      mcpServers: [],
    };
    saveProjects();
  }
  return projects[name];
}

export function updateProjectCategory(name: string, categoryId: string, logChannelId?: string): void {
  const project = projects[name];
  if (project) {
    project.categoryId = categoryId;
    if (logChannelId) project.logChannelId = logChannelId;
    saveProjects();
  }
}

// Personality

export function setPersonality(projectName: string, prompt: string): boolean {
  const project = projects[projectName];
  if (!project) return false;
  project.personality = prompt;
  saveProjects();
  return true;
}

export function getPersonality(projectName: string): string | undefined {
  return projects[projectName]?.personality;
}

export function clearPersonality(projectName: string): boolean {
  const project = projects[projectName];
  if (!project) return false;
  delete project.personality;
  saveProjects();
  return true;
}

// Skills

export function addSkill(projectName: string, name: string, prompt: string): boolean {
  const project = projects[projectName];
  if (!project) return false;
  project.skills[name] = prompt;
  saveProjects();
  return true;
}

export function removeSkill(projectName: string, name: string): boolean {
  const project = projects[projectName];
  if (!project || !project.skills[name]) return false;
  delete project.skills[name];
  saveProjects();
  return true;
}

export function getSkills(projectName: string): Record<string, string> {
  return projects[projectName]?.skills || {};
}

export function executeSkill(projectName: string, skillName: string, input?: string): string | null {
  const project = projects[projectName];
  if (!project) return null;
  const template = project.skills[skillName];
  if (!template) return null;
  return input ? template.replace(/\{input\}/g, input) : template.replace(/\{input\}/g, '');
}

// MCP Servers

export async function addMcpServer(projectDir: string, projectName: string, server: McpServer): Promise<boolean> {
  const project = projects[projectName];
  if (!project) return false;

  // Update in-memory
  const existing = project.mcpServers.findIndex(s => s.name === server.name);
  if (existing >= 0) {
    project.mcpServers[existing] = server;
  } else {
    project.mcpServers.push(server);
  }
  await saveProjects();

  // Write to project's .mcp.json so Claude Code picks it up natively
  await writeMcpJson(projectDir, project.mcpServers);
  return true;
}

export async function removeMcpServer(projectDir: string, projectName: string, name: string): Promise<boolean> {
  const project = projects[projectName];
  if (!project) return false;

  const idx = project.mcpServers.findIndex(s => s.name === name);
  if (idx < 0) return false;

  project.mcpServers.splice(idx, 1);
  await saveProjects();
  await writeMcpJson(projectDir, project.mcpServers);
  return true;
}

export function listMcpServers(projectName: string): McpServer[] {
  return projects[projectName]?.mcpServers || [];
}

async function writeMcpJson(projectDir: string, servers: McpServer[]): Promise<void> {
  const mcpPath = join(projectDir, '.mcp.json');

  // Read existing .mcp.json if it exists (preserve non-bot entries)
  let mcpConfig: Record<string, unknown> = {};
  try {
    if (existsSync(mcpPath)) {
      const existing = await readFile(mcpPath, 'utf-8');
      mcpConfig = JSON.parse(existing);
    }
  } catch {
    // Start fresh
  }

  // Build mcpServers section
  const mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> = {};
  for (const server of servers) {
    mcpServers[server.name] = {
      command: server.command,
      ...(server.args?.length ? { args: server.args } : {}),
      ...(server.env ? { env: server.env } : {}),
    };
  }

  mcpConfig.mcpServers = mcpServers;
  await writeFile(mcpPath, JSON.stringify(mcpConfig, null, 2), 'utf-8');
}
