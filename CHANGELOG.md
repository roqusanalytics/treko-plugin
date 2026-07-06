# Changelog

All notable changes to **treko-plugin** (the Claude Code plugin: MCP wrapper,
skill, slash command, hook). Follows [Semantic Versioning](https://semver.org/).

Pairs with the [`treko`](https://github.com/roqusanalytics/treko) server/CLI —
see its `CHANGELOG.md` for endpoint-level changes.

## [1.21.0] — 2026-07-07

### Added
- **Automatic idle-push via an `asyncRewake` Stop hook — the smooth, zero-command flagship path,
  desktop included.** `hooks/watch-async.sh` runs in the **background** at each turn end (non-blocking,
  so the session idles normally and the user is never locked out), polls the queue **in-shell (zero
  tokens)**, and the moment the human points-and-commands it exits **code 2** — which `asyncRewake`
  turns into an **immediate wake of the idle session**, delivering the command. So a comment made
  minutes after the last turn just appears — no `/loop`, no command, no Channels flag. Works on
  desktop, CLI, cmux, and Codex. Bounded (~9 min window, re-armed each turn), single watcher per
  session (lockfile), and gated on the commander launcher being present so non-treko sessions spawn
  nothing. Requires Claude Code with `asyncRewake` hook support.

### Changed
- **The Stop hook is now the async watcher** (`watch-async.sh`, `asyncRewake: true`, `timeout: 570`),
  replacing the synchronous 45 s live-catch that briefly blocked the turn. `stop-inbox.sh` remains in
  the repo as the sync fallback but is no longer wired in.

## [1.20.0] — 2026-07-06

### Changed
- **`/treko:watch` now handles one `watch` cycle, designed for `/loop /treko:watch`.** Each run blocks
  (free) on the `watch` tool until the human points-and-commands, acts on it, then stops — and
  `/loop` re-invokes it so watching stays alive across comments made minutes apart. A model-driven
  self-loop proved unreliable (after acting on one comment the model ends its turn and stops calling
  `watch`), so the harness (`/loop`) now owns the repetition. No comment is lost — one sent between
  cycles is queued and returned by the next `watch`. Replaces the old poll-once `inbox` flow. Works on
  desktop, CLI, cmux, and Codex.

## [1.19.0] — 2026-07-06

### Added
- **`watch` tool — the universal flagship path (works everywhere, even Codex).** Blocks (in-process
  long-poll) until the human points-and-commands in the browser, then returns the command text **plus
  the pointed element's screenshot as an image block** — rendered inline exactly like the `screenshot`
  tool. Because it's a plain MCP tool call, it works in **every** runtime — desktop, CLI, cmux, and
  Codex — with no Channels, no hooks, no launch flags. The wait costs no tokens (the agent only spends
  a turn once a comment arrives). Call it in a loop to watch continuously. This is the answer to "why
  can treko push a screenshot to the screen but not a flagship comment?" — now it can, the same way.

### Changed
- **Channel push is now opt-in (`TREKO_CHANNEL=1`).** The SSE subscription made the server drain the
  session's queue and push it as a `notifications/claude/channel` event — but on a runtime not loaded
  as a channel (desktop, Codex, plain sessions) that event is dropped silently, which consumed the
  comment and starved the `watch` tool + Stop hook. The MCP now subscribes only when `TREKO_CHANNEL=1`
  (set it alongside `--channels`), so the universal paths stay reliable everywhere by default.

## [1.18.0] — 2026-07-06

### Added
- **Stop hook live-catch window — idle-push that also works on the desktop app.** When the human is
  actively in flagship mode (`window.__trekoCommander.isActive()`, i.e. inspect/pointing mode is on),
  the Stop hook keeps polling the inbox *in-shell* for a bounded window (`for` loop, default 9×5 s ≈
  45 s, under the 60 s hook timeout) so a comment made a few seconds later still lands live — no
  Channels flag needed, so it works on the desktop app where Channels can't be enabled. Empty polling
  is bash + `curl`, so it costs **zero tokens**; the agent only runs when a comment actually arrives.
  Gated on `isActive()` (which stays true across sends, since the overlay's `send()` doesn't
  deactivate), so **normal turns never hang** — commander off ⇒ the hook returns in ~0.1 s. Bounded
  three ways (the `for` limit, the hook timeout, and the window resetting each turn) so it can never
  loop forever. Tunable via `TREKO_CATCH_ITERS` / `TREKO_CATCH_SLEEP`.
- `hooks.json` Stop hook now sets `timeout: 60` so the catch window isn't cut short.

## [1.17.0] — 2026-07-06

### Added
- **Channel — real-time idle-push (research preview).** The MCP now declares the
  `experimental['claude/channel']` capability and holds an SSE subscription open to the treko server
  for its session. When the human points at something in the browser, the server pushes it down the
  stream and the MCP emits a `notifications/claude/channel` event — so the Point-and-Command comment
  appears in the session **instantly, even while the agent is idle**, no nudge needed. `instructions`
  tell the agent to show the comment + `Read` the screenshot before acting.
- To enable, start Claude Code with `--dangerously-load-development-channels plugin:treko@treko-marketplace`
  (custom channels aren't on the research-preview allowlist yet). Without it, the notification is dropped
  silently and the Stop hook remains the fallback — nothing breaks. Requires Claude Code ≥ 2.1.80 and
  treko server ≥ 1.20.0.

## [1.16.0] — 2026-07-06

### Changed
- **MCP adopts the session id from `CLAUDE_CODE_SESSION_ID` (env) first.** Claude Code sets this
  variable in the MCP server's environment for CLI, cmux *and* the desktop app, and it equals the
  canonical session id the Stop hook receives on stdin — so Point-and-Command routes to the exact
  session that owns the tab, across all launch methods (not just CLI). It's undocumented, so it's
  treated as best-effort: the resolution order is `TREKO_SESSION` → `CLAUDE_CODE_SESSION_ID` →
  parent `--session-id` → random `agent-*`. Hosts that set no session var (e.g. Codex) fall back to
  a random id and route by project dir (`cwd`) as before. Replaces the earlier parent-process-only
  approach, which missed the desktop app and cmux.

### Requires
- treko server ≥ 1.19.0.

## [1.15.0] — 2026-07-06

### Changed
- **Stop hook now surfaces each Point-and-Command visibly before acting.** The hook's
  `reason` instructs the agent to first render a visible block (`[gauta iš treko flagship]`
  with command / element / page) and `Read` the element screenshot inline, so the human who
  pointed in the browser *sees* the request arrive on the Claude Code screen — then the agent
  executes it. Previously the request was delivered into the agent's context but never rendered,
  so on desktop it looked like nothing happened. If the pointed element belongs to an external
  site (not the current project's code), the agent still shows it but reports instead of editing.

### Requires
- treko server ≥ 1.19.0.

## [1.14.0] — 2026-07-06

### Added
- **The MCP adopts the Claude session id.** On start it reads its parent process
  (`ps -o command= -p <ppid>` → `claude --session-id <uuid>`) and uses that uuid as its treko
  session, so the tab it drives and the Stop hook that drains commands both key off the same
  id. Falls back to a random `agent-*` id when there's no such parent (e.g. Codex). This is
  what makes precise per-session routing possible when 5+ sessions share one project.

### Changed
- **Stop hook routes by the Claude session id.** It now reads `session_id` (and `cwd`) from
  the hook's stdin JSON and polls `/inbox/poll {session, cwd, drain:true}` — so with many
  sessions in one project, each turn drains only the commands the human pointed at in *that*
  session's tab. `cwd` remains the fallback when the id is absent.

### Requires
- treko server ≥ 1.19.0.

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
