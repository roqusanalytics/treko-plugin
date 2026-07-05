---
name: treko
description: Use when you need to browse, scrape, or automate real Chrome (with the user's logged-in sessions/cookies) — navigate URLs, click, fill forms, extract content, run JS, dismiss cookie banners, solve captchas. Prefer over Playwright MCP when the task requires the user's real browser state.
---

# Treko — Real Chrome Automation

Treko controls the user's actual Chrome instance via CDP, so authenticated sessions, cookies, and extensions are available. All tools are exposed as `mcp__treko__*`.

## Auto-start behavior

**Do not ask the user to start the server.** Before every tool call the wrapper automatically:
1. Pings `http://localhost:3456/health`.
2. If not responding, spawns `treko start` in the background and waits up to 45s for it to become healthy.
3. If the CLI is missing or startup fails, returns a structured error with the exact fix.

The first tool call in a cold session may take 5–15s while Chrome launches. Subsequent calls are instant.

## Recommended workflow

1. **`navigate`** — open the target URL (or `recon` with `url:` to combine).
2. **`dismiss`** — clear cookie banners / modals before interacting.
3. **`recon`** — map the page: real selectors, forms, overlays, captchas.
4. **`click` / `fill` / `scroll`** — act on selectors from recon. Never guess.
5. **`read`** — extract content, optionally scoped by `selector`.
6. **`eval`** — fallback for anything structured endpoints don't cover.

Skip 2–3 for trivial tasks (e.g. reading a known static page).

## Visual tools — `screenshot` and `upload`

**`screenshot`** returns the page as an actual image you can SEE. Reach for it on your own
judgement whenever text (`recon`/`read`) is not enough:
- A Cloudflare bot wall (`navigate` returns `botChallenge` with `autoResolved:false`, or `recon` reports a `cloudflare` captcha) — screenshot, read the checkbox pixel, then `captcha {action:"turnstile", x, y}`. Only surface to the user for hard image/"select squares" challenges.
- Canvas / chart / map / image-based UI where DOM text says nothing useful.
- An action didn't behave as expected and you need to *see* the current state to diagnose.
- Final visual verification after a flow (confirm a form submitted, a dialog closed).
Optional `output:"/abs/path.png"` also saves the PNG to disk (debug logs). Don't screenshot
reflexively — prefer `recon`/`read` for text; screenshot is for the visual cases above.

**`upload`** attaches local files to an `<input type="file">` via CDP — works even on hidden
(`display:none`) inputs. Use for any file-upload step. Absolute paths:
`upload { tab, selector, files: ["/abs/a.pdf", "/abs/b.pdf"] }`.

## Parallel agents — automatic tab isolation

When multiple agents run at once, each one's MCP process gets a unique `session` id that
the wrapper attaches to every call. The server gives each session its **own dedicated tab**
(created on first use) — so parallel agents never fight over tab `"0"` or close each other's
tabs. This is automatic; you don't manage it. Notes:
- Your calls default to *your* session's tab. Pass an explicit `tab` only to target a specific
  one (e.g. an OAuth popup found via `tabs`).
- `tabs` shows each tab's owning `session`; `GET /sessions` lists active sessions.
- Set `TREKO_SESSION` (env) to a fixed value to deliberately share one tab across processes.
- Idle session tabs are auto-closed after ~30 min; they're also released when the agent exits.

## Tab targeting

Every tool except `health` and `tabs` accepts a `tab` parameter and **defaults to `"0"`** (first tab) if omitted. Resolution order:
- Numeric index: `"0"`, `"1"`, …
- URL or title partial match: `"github"`, `"gmail"`
- Iframe domain fallback

Use `tabs` first when multiple are open to pick the right one.

## Error handling — what to do

| Error text contains | Meaning | Action |
|---|---|---|
| `CLI not found` | Treko npm package missing | Tell the user to run `bun install -g treko` |
| `did not become healthy ... within` | Server started but never became ready | Suggest checking `/tmp/treko-plugin/server.log`; common causes: Chrome missing, port 3456 taken, permission prompt |
| `Cannot reach Treko` | Network / socket error to localhost | Call `health` once; if still failing, server likely crashed — retry triggers auto-restart |
| `HTTP 400: Provide "tab" and one of ...` | Missing required param | Check the tool's schema and supply the missing field |
| `Element not found` | `click` selector didn't match | Re-`recon` — DOM may have changed after navigation |
| Cloudflare "Verify you are human" checkbox (embedded widget) | Turnstile interactive challenge | Call `captcha` with `action: "turnstile"` — it auto-detects and clicks the checkbox with a real mouse gesture. Then `read`/`screenshot` to confirm "Success". |
| Full-page "Just a moment…" / "Performing security verification" interstitial (delfi.lt, skelbiu.lt, autoplius.lt) | Cloudflare managed interstitial — checkbox is in a dynamically-named cross-origin iframe selectors can't reach | `screenshot` the page → read the checkbox's **center pixel coords** off the image → `captcha { action: "turnstile", x, y }`. At dpr=1 image pixels = viewport coords. `read` page title to confirm it changed from "Just a moment…". |
| Image / Arkose / "select all squares" captcha | Hard visual captcha | Stop and surface to the user — do NOT try to auto-solve |

## Point-and-Command (human points, you act)

A corner 🎯 launcher auto-appears on every tab. The human clicks it, points at any element,
types an instruction, and hits Enter — that command is queued **for this session's tab**.
Because your MCP process registers its project (cwd) on start, commands route back to the
session that owns the project the human pointed at.

- **Receive:** call `inbox` — it drains *your* session's queue and returns
  `{ items:[{command, selector, element, url, rect}], count, project:{cwd, title} }`.
  If `project.cwd` isn't the repo you're in, don't edit — it belongs to another session.
- **Act:** for each item, optionally `navigate` to `url` + `screenshot`/`recon` the `selector`
  to see what they mean, find the file that renders it, make the change, verify.
- **Live watch:** the `/treko:watch` command does exactly this; run `/loop 8s /treko:watch`
  so you pick up and execute commands continuously while the human points at things. Claude
  Code is turn-based, so this loop is what makes it feel "live" — there is no inbound push.

## Common patterns

**Login flow**: `navigate` → `dismiss` → `recon` → `fill` (with `submit: true`).

**Cloudflare bot wall (the common case — delfi.lt, skelbiu.lt, autoplius.lt)**: you usually
don't do anything special — **`navigate` auto-detects and tries to clear it for you**. Always
read the `botChallenge` field on the navigate result:
1. `botChallenge` absent or `autoResolved:true` → you're on the real page, continue.
2. `autoResolved:false` → follow `botChallenge.hint`. The reliable manual path: `screenshot` →
   look at the image, read the "Verify you are human" checkbox **center pixel** → `captcha
   { action:"turnstile", x, y }` (at dpr=1 image px = viewport px) → `read` the title to confirm
   it changed off "Just a moment…" / "Tikriname jūsų naršyklę".
3. If it's an image / "select all squares" challenge, **surface to the user** — don't guess.

Why the manual step exists: on full-page interstitials the visible checkbox sits in a closed
shadow DOM that selectors can't reach, so only the screenshot+coords path is reliable. For
**embedded** Turnstile widgets, plain `captcha { action:"turnstile" }` (no coords) auto-detects
and clicks. treko drives a real, non-headless Chrome, so a real mouse click passes it (synthetic
clicks don't), and a passed wall sets a clearance cookie so the site loads directly next time.

**Framework-heavy sites (React/Vue)**: if `click`/`fill` don't register, use `dispatch` with `event: "input"` or `event: "change"` and `reactDebug: true` to inspect handlers.

**Research task**: `navigate` to source → `dismiss` → `read` (full or scoped by selector) → repeat across URLs. Prefer `read` over `recon` when you just need text content.

**Scraping with pagination**: loop `read` → `click` next → `read`, checking `navigated` flag in `click` response.

## When NOT to use Treko

- If `mcp__playwright__*` is available and you don't need the user's real session — Playwright is isolated and safer.
- For one-off HTTP fetches of public pages — use `WebFetch` instead.
- For authenticated APIs already covered by a dedicated MCP server (Gmail, Airtable, etc.) — use that.
