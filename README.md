# treko-plugin

Claude Code plugin that wraps [Treko](https://github.com/roqusanalytics/treko) — real-Chrome browser automation via Chrome DevTools Protocol — as native MCP tools.

## What you get

- **14 MCP tools** (`mcp__treko__*`): `health`, `tabs`, `recon`, `read`, `click`, `fill`, `scroll`, `navigate`, `eval`, `dismiss`, `focus`, `captcha`, `dispatch`, `type`.
- **Skill** `treko` — tells Claude when and how to use the tools.
- **Slash command** `/treko:surf <url>` — quick navigate + recon.
- **SessionStart hook** — warns on session start if the Treko server is not running.

## Prerequisites

```bash
bun install -g treko
treko start              # launches Chrome in debug mode + API server on :3456
```

Node.js 18+ is required (the MCP server uses the built-in `fetch`).

## Install MCP dependencies

```bash
cd treko-plugin/mcp-server
npm install
```

## Load the plugin

**Option A — local dev:**
```bash
claude --plugin-dir /path/to/treko-plugin
```

**Option B — install as user plugin:** copy or symlink into `~/.claude/plugins/` and restart Claude Code.

Then run `/reload-plugins` to pick up changes.

## Configuration

Override the Treko URL by editing `.mcp.json` → `mcpServers.treko.env.TREKO_URL`.

## Structure

```
treko-plugin/
├── .claude-plugin/plugin.json   # manifest
├── .mcp.json                    # registers MCP server
├── mcp-server/                  # Node.js MCP wrapper over HTTP
│   ├── index.js
│   └── package.json
├── skills/treko/SKILL.md    # usage guidance
├── commands/surf.md             # /treko:surf slash command
├── hooks/hooks.json             # SessionStart health check
└── README.md
```
