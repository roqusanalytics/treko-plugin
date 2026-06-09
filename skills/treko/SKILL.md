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
- A captcha or visual challenge appears (`recon` reports `captchas[]`) — screenshot, then surface to the user.
- Canvas / chart / map / image-based UI where DOM text says nothing useful.
- An action didn't behave as expected and you need to *see* the current state to diagnose.
- Final visual verification after a flow (confirm a form submitted, a dialog closed).
Optional `output:"/abs/path.png"` also saves the PNG to disk (debug logs). Don't screenshot
reflexively — prefer `recon`/`read` for text; screenshot is for the visual cases above.

**`upload`** attaches local files to an `<input type="file">` via CDP — works even on hidden
(`display:none`) inputs. Use for any file-upload step. Absolute paths:
`upload { tab, selector, files: ["/abs/a.pdf", "/abs/b.pdf"] }`.

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
| `captchas[]` non-empty in `recon` | Page has a captcha | Stop and surface to the user — do NOT try to auto-solve |

## Common patterns

**Login flow**: `navigate` → `dismiss` → `recon` → `fill` (with `submit: true`).

**Framework-heavy sites (React/Vue)**: if `click`/`fill` don't register, use `dispatch` with `event: "input"` or `event: "change"` and `reactDebug: true` to inspect handlers.

**Research task**: `navigate` to source → `dismiss` → `read` (full or scoped by selector) → repeat across URLs. Prefer `read` over `recon` when you just need text content.

**Scraping with pagination**: loop `read` → `click` next → `read`, checking `navigated` flag in `click` response.

## When NOT to use Treko

- If `mcp__playwright__*` is available and you don't need the user's real session — Playwright is isolated and safer.
- For one-off HTTP fetches of public pages — use `WebFetch` instead.
- For authenticated APIs already covered by a dedicated MCP server (Gmail, Airtable, etc.) — use that.
