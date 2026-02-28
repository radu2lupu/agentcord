# agentcord

Run and manage AI coding agent sessions on your machine through Discord. Currently supports [Claude Code](https://docs.anthropic.com/en/docs/claude-code), with more agents coming soon.

Each session gets a Discord channel for chatting with the agent and a tmux session for direct terminal access. Sessions are organized by project — create multiple sessions in the same codebase, each with their own channel.

## Quick Start

```bash
npm install -g agentcord
mkdir my-bot && cd my-bot
agentcord setup
agentcord
```

The setup wizard walks you through creating a Discord app, configuring the bot token, and adding it to your server.

## Requirements

- **Node.js 22.6+** (uses native TypeScript execution)
- **tmux** (for terminal session access)
- **Claude Code** installed on the machine (`@anthropic-ai/claude-agent-sdk`)

## How It Works

```
Discord message → SDK query() → coding agent
                                      ↓
Discord embeds ← stream processing ← async iterator
```

**Hybrid architecture**: The agent SDK handles structured streaming for Discord interaction, while each session also gets a tmux session. You can `tmux attach` and run `claude --resume <session-id>` to take over the same conversation in your terminal.

**Project-based organization**:

```
Discord Server
  └── my-api (category)
  │    ├── #claude-fix-auth        ← session in ~/Dev/my-api
  │    ├── #claude-add-tests       ← another session, same project
  │    └── #project-logs
  └── frontend (category)
       ├── #claude-redesign        ← session in ~/Dev/frontend
       └── #project-logs
```

## Discord Commands

### Sessions

| Command | Description |
|---------|-------------|
| `/claude new <name> [directory]` | Create a session with a Discord channel + tmux session |
| `/claude list` | List active sessions grouped by project |
| `/claude end` | End the session in the current channel |
| `/claude continue` | Continue the conversation |
| `/claude stop` | Abort current generation |
| `/claude attach` | Show tmux attach command for terminal access |
| `/claude model <model>` | Change model for the session |
| `/claude verbose` | Toggle tool call/result visibility |
| `/claude sync` | Reconnect orphaned tmux sessions |

### Shell

| Command | Description |
|---------|-------------|
| `/shell run <command>` | Execute a command in the session directory |
| `/shell processes` | List running background processes |
| `/shell kill <pid>` | Kill a process |

### Agent Personas

| Command | Description |
|---------|-------------|
| `/agent use <persona>` | Switch persona (code-reviewer, architect, debugger, security, performance, devops) |
| `/agent list` | List available personas |
| `/agent clear` | Reset to default |

### Project Config

| Command | Description |
|---------|-------------|
| `/project personality <prompt>` | Set a custom system prompt for the project |
| `/project personality-show` | Show current personality |
| `/project personality-clear` | Remove personality |
| `/project skill-add <name> <prompt>` | Add a reusable prompt template (`{input}` placeholder) |
| `/project skill-run <name> [input]` | Execute a skill |
| `/project skill-list` | List skills |
| `/project mcp-add <name> <command>` | Register an MCP server (writes `.mcp.json`) |
| `/project mcp-list` | List MCP servers |
| `/project info` | Show project config summary |

## Features

- **Real-time streaming** — Agent responses stream into Discord with edit-in-place updates
- **Typing indicator** — Shows "Bot is typing..." while the agent is working
- **Message interruption** — Send a new message to automatically interrupt and redirect the agent
- **Interactive prompts** — Multi-choice questions render as Discord buttons
- **Task board** — Agent task lists display as visual embeds with status emojis
- **Tool output control** — Hidden by default, toggle with `/claude verbose`
- **Per-project customization** — System prompts, skills, and MCP servers scoped to projects
- **Agent personas** — Switch between specialized roles (code reviewer, architect, etc.)
- **Session persistence** — Sessions survive bot restarts
- **Terminal access** — `tmux attach` to any session for direct CLI use

## Configuration

The setup wizard (`agentcord setup`) creates a `.env` file. You can also edit it directly:

```env
# Required
DISCORD_TOKEN=your-bot-token
DISCORD_CLIENT_ID=your-client-id

# Optional
DISCORD_GUILD_ID=your-guild-id        # Instant command registration
ALLOWED_USERS=123456789,987654321      # Comma-separated user IDs
ALLOW_ALL_USERS=false                  # Or true to skip whitelist
ALLOWED_PATHS=/Users/me/Dev            # Restrict accessible directories
DEFAULT_DIRECTORY=/Users/me/Dev        # Default for new sessions
CODEX_SANDBOX_MODE=workspace-write     # read-only | workspace-write | danger-full-access
CODEX_APPROVAL_POLICY=on-request       # never | on-request | on-failure | untrusted
CODEX_NETWORK_ACCESS_ENABLED=true      # true | false
```

You can also override Codex policy per session when creating/resuming via:
- `/session new ... sandbox-mode:<mode> approval-policy:<policy> network-access:<bool>`
- `/session resume ... sandbox-mode:<mode> approval-policy:<policy> network-access:<bool>`

## Development

```bash
git clone https://github.com/radu2lupu/agentcord.git
cd agentcord
npm install
cp .env.example .env   # fill in your values
npm run dev            # start with --watch
```

## License

MIT
