# treko-plugin

Claude Code plugin that wraps [Treko](https://github.com/roqusanalytics/treko) — real-Chrome browser automation via Chrome DevTools Protocol — as native MCP tools.

## What you get

- **16 MCP tools** (`mcp__treko__*`): `health`, `tabs`, `recon`, `read`, `click`, `fill`, `upload`, `screenshot`, `scroll`, `navigate`, `eval`, `dismiss`, `focus`, `captcha`, `dispatch`, `type`.
- **Skill** `treko` — tells Claude when and how to use the tools.
- **Slash command** `/treko:surf <url>` — quick navigate + recon.
- **SessionStart hook** — warns on session start if the Treko server is not running.

## Prerequisites

```bash
git clone https://github.com/roqusanalytics/treko && cd treko && bun install && bun link
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

## Which logins does the robot have?

Only the sites the user granted: `treko cookies list` shows them, `treko cookies grant <domain>`
adds one (treko >= 2.2.0). Without a grant a site simply shows its login page — the agent should
ask the user to grant it or log in by hand in the treko window, never type a password.

## Configuration

Override the Treko URL by editing `.mcp.json` → `mcpServers.treko.env.TREKO_URL`.

## Releasing

**Bump the version in BOTH manifests — they are read by different consumers:**

| File | Read by | Symptom if stale |
|---|---|---|
| `.claude-plugin/plugin.json` | the installed plugin itself | plugin reports the wrong version |
| `.claude-plugin/marketplace.json` | `claude plugin update` / `autoUpdate` | **updates never arrive** — the marketplace keeps offering the old version, so fixes stay unshipped even after they land on `main` |

```bash
# keep both in sync, then add a CHANGELOG entry
sed -i '' 's/"version": "1.21.2"/"version": "1.21.3"/' .claude-plugin/plugin.json
sed -i '' 's/"version": "1.21.2"/"version": "1.21.3"/' .claude-plugin/marketplace.json
```

Verify before pushing:

```bash
grep '"version"' .claude-plugin/plugin.json .claude-plugin/marketplace.json
```

Both lines must show the same number. `marketplace.json` sat at `1.4.0` while `plugin.json`
had advanced to `1.21.x`, which silently blocked every marketplace update in between.

Server-side changes (endpoints, tab/session behaviour) live in the separate
[`treko`](https://github.com/roqusanalytics/treko) repo and carry their own version —
note the minimum required server version in the plugin's `CHANGELOG.md` when a hook or the
MCP wrapper depends on a new endpoint or request flag.

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
├── commands/watch.md            # /treko:watch slash command
├── hooks/
│   ├── hooks.json               # SessionStart (API health) + Stop (async watcher)
│   ├── watch-async.sh           # asyncRewake Point-and-Command watcher
│   └── stop-inbox.sh            # Stop-hook inbox drain (live-catch window)
└── README.md
```
