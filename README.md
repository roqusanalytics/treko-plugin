# surfagent-plugin

Claude Code plugin that wraps [Surfagent](https://github.com/roqusanalytics/surfagent) — real-Chrome browser automation via Chrome DevTools Protocol — as native MCP tools.

## What you get

- **14 MCP tools** (`mcp__surfagent__*`): `health`, `tabs`, `recon`, `read`, `click`, `fill`, `scroll`, `navigate`, `eval`, `dismiss`, `focus`, `captcha`, `dispatch`, `type`.
- **Skill** `surfagent` — tells Claude when and how to use the tools.
- **Slash command** `/surfagent:surf <url>` — quick navigate + recon.
- **SessionStart hook** — warns on session start if the Surfagent server is not running.

## Prerequisites

```bash
npm install -g surfagent
surfagent start              # launches Chrome in debug mode + API server on :3456
```

Node.js 18+ is required (the MCP server uses the built-in `fetch`).

## Install MCP dependencies

```bash
cd surfagent-plugin/mcp-server
npm install
```

## Load the plugin

**Option A — local dev:**
```bash
claude --plugin-dir /path/to/surfagent-plugin
```

**Option B — install as user plugin:** copy or symlink into `~/.claude/plugins/` and restart Claude Code.

Then run `/reload-plugins` to pick up changes.

## Configuration

Override the Surfagent URL by editing `.mcp.json` → `mcpServers.surfagent.env.SURFAGENT_URL`.

## Structure

```
surfagent-plugin/
├── .claude-plugin/plugin.json   # manifest
├── .mcp.json                    # registers MCP server
├── mcp-server/                  # Node.js MCP wrapper over HTTP
│   ├── index.js
│   └── package.json
├── skills/surfagent/SKILL.md    # usage guidance
├── commands/surf.md             # /surfagent:surf slash command
├── hooks/hooks.json             # SessionStart health check
└── README.md
```
