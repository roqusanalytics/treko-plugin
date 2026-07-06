# Changelog

All notable changes to **treko-plugin** (the Claude Code plugin: MCP wrapper,
skill, slash command, hook). Follows [Semantic Versioning](https://semver.org/).

Pairs with the [`treko`](https://github.com/roqusanalytics/treko) server/CLI —
see its `CHANGELOG.md` for endpoint-level changes.

## [1.13.0] — 2026-07-06

### Changed
- **Stop hook + `inbox` now include an element screenshot.** Each Point-and-Command item
  carries a `screenshot` path (a PNG of the pointed element + context). The Stop hook tells
  the agent to view it (Read the file) before acting, so it sees exactly what the human
  pointed at.

### Requires
- treko server ≥ 1.18.0.

## [1.12.0] — 2026-07-06

### Added
- **Stop hook — free, automatic Point-and-Command pickup.** `hooks/stop-inbox.sh` runs
  when the agent finishes a turn (an event that happens anyway, so zero polling and zero
  token cost). It drains this project's Point-and-Command queue (resolved by `cwd`) and, if
  the human pointed at anything, returns `{"decision":"block","reason":…}` so the agent
  keeps going and executes the commands — no `/loop`, no watcher, no re-prompt. Loop-safe
  (drains, so it stops when the queue is empty). Idle-only note: a command sent while the
  agent is fully idle is picked up on the next turn (there is no inbound push in Claude Code).

### Requires
- treko server ≥ 1.17.0 (adds `cwd`→session resolution for `/inbox/poll`).

## [1.11.0] — 2026-07-05

Point-and-Command becomes usable end-to-end.

### Added
- **Auto session registration** — on start, the MCP process registers its project (`cwd`)
  with treko (`TREKO_PROJECT_CWD` to override), so a command the human points at routes
  back to *this* session/project instead of leaking to another.
- **`/treko:watch` command** — polls this session's Point-and-Command inbox and executes
  the requests the human pointed at (navigate to the element, find the file, make the change,
  verify). Run `/loop 8s /treko:watch` for live watching — the practical "activation", since
  Claude Code is turn-based and has no inbound push.
- Skill documents the full flow (corner launcher → point → `inbox`/`watch` → act, with
  project routing).

### Requires
- treko server ≥ 1.15.0.

## [1.10.0] — 2026-07-05

### Changed
- **`commander` tool** now documents the auto-appearing corner launcher (the human can
  self-activate Point-and-Command from the bottom-right button — you rarely need to call
  the tool) and adds an `active` param to start straight in inspect mode.

### Requires
- treko server ≥ 1.14.0.

## [1.9.0] — 2026-07-05

### Added
- **`commander` tool** — toggle Point-and-Command inspect mode on a tab. The human points
  at any element in the treko Chrome window and types an instruction; it's queued for the agent.
- **`inbox` tool** — drain those commands (each ties a plain-language instruction to an exact
  element selector). Defaults to the agent's own session tab. Enable `commander`, ask the user
  to point, then poll `inbox`.

### Requires
- treko server ≥ 1.13.0.

## [1.8.0] — 2026-07-05

### Added
- **`act` tool** — run an ordered list of ops (navigate, waitfor, fill, click, read, …)
  in one call against the same tab, over one reused connection. Stops at the first
  failing step by default (`stopOnError:false` to run all). Ideal for known sequences
  like login flows — fewer round-trips and atomic.

### Requires
- treko server ≥ 1.12.0.

## [1.7.0] — 2026-07-05

### Added
- **`waitfor` tool** — block until a page condition holds (selector appears/disappears,
  text present, URL changed, or `readyState:complete`) instead of guessing sleeps.
- **`diagnostics` tool** — surface buffered JS console errors, failed network requests
  (4xx/5xx), and uncaught exceptions so the agent can diagnose SPA/API failures the DOM
  doesn't reveal. First call starts monitoring; call again after the action to read.

### Requires
- treko server ≥ 1.11.0 (adds the connection pool, `/waitfor`, `/diagnostics`, and
  session-tab reuse in `recon`).

## [1.6.0] — 2026-06-19

### Added
- **`navigate` auto-handles bot walls and reports them.** Its response now carries a
  `botChallenge` object; the tool description tells the agent to always check it — if
  `autoResolved:false`, follow `botChallenge.hint` (screenshot → checkbox pixel →
  `captcha {action:"turnstile", x, y}`) and never treat a "Just a moment…" title as the
  real page. New `solveChallenge` param (default true) to only-detect.
- **`recon` flags the Cloudflare wall** in `captchas[]` as
  `{type:"cloudflare", kind, checkbox, hint}`, so recon-first flows get the signal too.

### Requires
- treko server ≥ 1.10.0.

## [1.5.0] — 2026-06-19

### Added
- **`captcha` tool now takes `x` / `y`** for the `turnstile` action. Documents the
  reliable flow for full-page Cloudflare interstitials (delfi.lt, skelbiu.lt,
  autoplius.lt — "Just a moment…"): `screenshot` → read the checkbox's center pixel
  off the image → `captcha { action: "turnstile", x, y }`. The checkbox lives in a
  dynamically-named cross-origin iframe that selectors can't reach, so the visual
  screenshot-and-click path is what works. Omit `x,y` to auto-detect embedded widgets.

### Requires
- treko server ≥ 1.9.0.

## [1.4.0] — 2026-06-15

### Added
- **`indicator` MCP tool** — toggles the "agent is working" pixel-mosaic overlay
  that frames the viewport edges (auto-shown when treko navigates a tab). Use it to
  force the shimmer off/on, e.g. off before a clean screenshot.

### Requires
- treko server ≥ 1.7.0.

## [1.3.0] — 2026-06-15

### Added
- **Cloudflare Turnstile support** via the `captcha` tool's new `turnstile` action —
  clicks the "Verify you are human" checkbox with a real mouse gesture. Skill's
  error-handling table and patterns now route Turnstile to this action.

### Requires
- treko server ≥ 1.6.0.

## [1.2.0] — 2026-06-15

### Added
- **Per-agent tab isolation.** Each MCP process now generates a unique `session`
  id and attaches it to every tab-using call, so multiple parallel agents each get
  their own Chrome tab instead of cannibalizing tab `"0"`. Fully automatic.
  - The session tab is released when the agent process exits.
  - `TREKO_SESSION` env var pins a fixed session to deliberately share a tab.
  - Skill documents the behavior ("Parallel agents — automatic tab isolation").
- `tab` parameter now defaults to the agent's own session tab (was `"0"`).

### Requires
- treko server ≥ 1.5.0.

## [1.1.0] — 2026-06-09

### Added
- **`screenshot` MCP tool** — captures the page and returns it as a real
  `type: "image"` content block, so Claude can *see* the screen (captchas, canvas,
  visual diagnosis, post-action verification). Optional `output` saves a PNG.
- `CallTool` now special-cases image-returning tools to emit an image block.
- Skill "Visual tools" section guides *when* to screenshot vs use text recon/read.

### Requires
- treko server ≥ 1.4.0.

## [1.0.0] — 2026-06-05

Initial release of the treko Claude Code plugin.

### Added
- MCP wrapper exposing treko's browser-automation tools as `mcp__treko__*`
  (`health`, `tabs`, `recon`, `read`, `click`, `fill`, `scroll`, `navigate`,
  `eval`, `dismiss`, `focus`, `captcha`, `dispatch`, `type`).
- **`upload` MCP tool** — attaches local files to an `<input type="file">`,
  including hidden inputs (via CDP). Wraps the server's `/upload`.
- `treko` skill (when/how to use the tools), `/treko:surf` slash command, and a
  SessionStart hook that auto-starts the server.

### Requires
- treko server ≥ 1.3.0.

[1.2.0]: https://github.com/roqusanalytics/treko-plugin/releases/tag/v1.2.0
[1.1.0]: https://github.com/roqusanalytics/treko-plugin/releases/tag/v1.1.0
[1.0.0]: https://github.com/roqusanalytics/treko-plugin/releases/tag/v1.0.0
