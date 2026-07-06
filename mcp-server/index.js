#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn, spawnSync } from "node:child_process";
import { openSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";

const BASE_URL = process.env.TREKO_URL || "http://localhost:3456";
const START_TIMEOUT_MS = Number(process.env.TREKO_START_TIMEOUT_MS || 45_000);
const LOG_DIR = join(tmpdir(), "treko-plugin");
const LOG_FILE = join(LOG_DIR, "server.log");

// Unique per agent process. Each parallel agent has its own MCP process, so this
// id isolates it to its own Chrome tab — no more cannibalizing tab "0". Override
// with TREKO_SESSION to share a tab across processes on purpose.
//
// We adopt the Claude Code session id as this MCP's treko session, so a Point-and-Command
// routes back to THIS exact session even when many sessions share one project (the Stop hook
// gets the same session_id on stdin → precise match server-side). Priority:
//   1. TREKO_SESSION            — explicit override
//   2. CLAUDE_CODE_SESSION_ID   — Claude Code sets this in the MCP env for CLI, cmux AND the
//                                 desktop app; it equals the canonical session id. Undocumented,
//                                 so we treat it as best-effort and degrade gracefully below.
//   3. parent `--session-id`    — fallback for older/edge launches that expose it on the cmdline
//   4. random `agent-*`         — last resort (e.g. Codex sets no session var) → cwd routing
const CC_SESSION_RE = /^[0-9a-fA-F-]{36}$/;
let SESSION_ID = process.env.TREKO_SESSION
  || (process.env.CLAUDE_CODE_SESSION_ID && CC_SESSION_RE.test(process.env.CLAUDE_CODE_SESSION_ID)
      ? process.env.CLAUDE_CODE_SESSION_ID
      : null);
if (!SESSION_ID) {
  try {
    const out = spawnSync("ps", ["-o", "command=", "-p", String(process.ppid)], { encoding: "utf8" });
    const m = out.stdout && out.stdout.match(/--session-id[ =]([0-9a-fA-F-]{36})/);
    if (m) SESSION_ID = m[1];
  } catch { /* fall through to random */ }
}
if (!SESSION_ID) SESSION_ID = `agent-${randomUUID().slice(0, 8)}`;

// The project this Claude session is working in. Registered with treko so a
// Point-and-Command the human makes routes back to THIS session/project.
const PROJECT_CWD = process.env.TREKO_PROJECT_CWD || process.cwd();
let registered = false;
async function registerOnce() {
  if (registered) return;
  try {
    const res = await fetch(`${BASE_URL}/session/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: SESSION_ID, cwd: PROJECT_CWD, title: basename(PROJECT_CWD) }),
    });
    if (res.ok) registered = true;
  } catch { /* server not up yet — retry on next call */ }
}

let autoStartPromise = null;

function log(...args) {
  try { console.error("[treko-mcp]", ...args); } catch {}
}

async function checkHealth(timeoutMs = 2000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${BASE_URL}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    return data && data.status === "ok";
  } catch {
    return false;
  }
}

function trekoInstalled() {
  const r = spawnSync("which", ["treko"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim().length > 0;
}

function spawnServer() {
  mkdirSync(LOG_DIR, { recursive: true });
  const out = openSync(LOG_FILE, "a");
  const child = spawn("treko", ["start"], {
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.on("error", (e) => log("spawn error:", e.message));
  child.unref();
  log(`spawned treko start (pid=${child.pid}), logs: ${LOG_FILE}`);
  return child.pid;
}

async function ensureServer() {
  if (await checkHealth()) return { started: false };
  if (autoStartPromise) return autoStartPromise;

  autoStartPromise = (async () => {
    if (!trekoInstalled()) {
      throw new Error(
        "Treko CLI not found. Install it globally:\n  bun install -g treko\n" +
        "Then retry. (Expected on PATH: `treko`.)"
      );
    }

    const pid = spawnServer();
    const deadline = Date.now() + START_TIMEOUT_MS;
    let lastErr = "timeout";
    while (Date.now() < deadline) {
      if (await checkHealth(1500)) return { started: true, pid };
      await new Promise((r) => setTimeout(r, 800));
    }
    throw new Error(
      `Treko did not become healthy on ${BASE_URL} within ${START_TIMEOUT_MS}ms (${lastErr}). ` +
      `Check logs: ${LOG_FILE}. Common causes: Chrome not installed, port 3456 in use, permission prompt.`
    );
  })().finally(() => {
    setTimeout(() => { autoStartPromise = null; }, 1000);
  });

  return autoStartPromise;
}

async function call(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, opts);
  } catch (e) {
    throw new Error(`Cannot reach Treko at ${BASE_URL}${path}: ${e.message}`);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const detail = typeof data === "string" ? data : (data.error || JSON.stringify(data));
    throw new Error(`Treko ${method} ${path} returned HTTP ${res.status}: ${detail}`);
  }
  return data;
}

// watch — block until the human points-and-commands in the browser, then return the command(s)
// plus the pointed element's screenshot as an image. The wait is an in-process long-poll, so it
// costs no agent tokens; the agent only spends a turn once a comment actually arrives. Being a plain
// tool call, it works in EVERY runtime (desktop, CLI, cmux, Codex) — no Channels / hooks / flags.
async function watchForCommand(a) {
  const session = a.session || SESSION_ID;
  const timeoutMs = Math.max(5000, Math.min(a.timeoutMs || 90000, 300000));
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    let resp = null;
    try { resp = await call("POST", "/inbox/poll", { session, cwd: PROJECT_CWD, drain: true, shots: true }); }
    catch { /* transient; retry next tick */ }
    const items = resp && Array.isArray(resp.items) ? resp.items : [];
    if (items.length) {
      const note = "📩 Gauta is treko flagship. Screenshot rodomas virsuje. Ivykdyk kiekviena komanda SIAME projekte (naudok selektoriu/URL). Jei elementas is isorines svetaines (ne sio projekto kodas) — parodyk ir pasakyk, bet nevykdyk.";
      const meta = items.map((it) => ({ command: it.command, element: it.element, selector: it.selector, url: it.url, screenshot: it.screenshot }));
      const shot = items.map((it) => it.screenshot).find(Boolean);
      if (shot) {
        try {
          const data = readFileSync(shot).toString("base64");
          return { data, mimeType: "image/png", count: items.length, note, items: meta };
        } catch { /* file unreadable -> text only */ }
      }
      const lines = meta.map((m) => `- komanda: "${m.command || ""}"\n  elementas: ${m.element || ""}\n  selektorius: ${m.selector || ""}\n  puslapis: ${m.url || ""}`).join("\n");
      return `${note}\n\n${lines}`;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return "Kol kas nauju flagship komentaru nera. Iskviesk `watch` dar karta, kad testum stebeti. (Vartotojas turi aktyvuoti flagship/commander ant tab'o, pazymeti elementa ir parasyti komanda.)";
}

const tab = {
  type: "string",
  description: "Tab selector: numeric index ('0'), exact tab id, URL/title partial match ('github'), or iframe domain. If omitted, defaults to this agent's own isolated session tab (auto-created) — so parallel agents don't collide. Pass an explicit value only to target a specific tab (e.g. an OAuth popup from `tabs`).",
};

const TOOLS = [
  {
    name: "health",
    description: "Verify the Treko API is running and connected to Chrome. Auto-starts the server if not running. Returns status, cdpConnected, tabCount.",
    inputSchema: { type: "object", properties: {} },
    handler: () => call("GET", "/health"),
  },
  {
    name: "tabs",
    description: "List all open Chrome tabs (id, index, title, url).",
    inputSchema: { type: "object", properties: {} },
    handler: () => call("GET", "/tabs"),
  },
  {
    name: "recon",
    description: "Map a page: headings, navigation, clickable elements with CSS selectors, forms, landmarks, overlays, captchas. Primary exploration tool — call this before clicking/filling so you know what selectors exist. A Cloudflare bot wall shows up in `captchas[]` as `{type:'cloudflare', kind, checkbox, hint}` — follow the hint (screenshot → checkbox pixel → captcha turnstile) instead of trying to read the real page.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Optional URL to navigate to before scanning." },
        tab,
        keepTab: { type: "boolean", description: "Keep tab open after recon." },
        waitMs: { type: "number", description: "Milliseconds to wait after load before scanning." },
      },
    },
    handler: (a) => call("POST", "/recon", a),
  },
  {
    name: "read",
    description: "Extract readable content (title, sections, notifications, plain text, HTML) from full page or a specific selector.",
    inputSchema: {
      type: "object",
      properties: {
        tab,
        selector: { type: "string", description: "Optional CSS selector to scope extraction." },
      },
    },
    handler: (a) => call("POST", "/read", a),
  },
  {
    name: "click",
    description: "Click an element by CSS selector or visible text. Returns whether navigation occurred.",
    inputSchema: {
      type: "object",
      properties: {
        tab,
        selector: { type: "string", description: "CSS selector of element to click." },
        text: { type: "string", description: "Visible text to match instead of selector." },
        waitAfter: { type: "number", description: "Milliseconds to wait after click." },
      },
    },
    handler: (a) => call("POST", "/click", a),
  },
  {
    name: "fill",
    description: "Fill multiple form fields using real CDP keyboard input. Each field: { selector, value }. Optionally submit.",
    inputSchema: {
      type: "object",
      properties: {
        tab,
        fields: {
          type: "array",
          description: "Fields to fill.",
          items: {
            type: "object",
            properties: {
              selector: { type: "string" },
              value: { type: "string" },
            },
            required: ["selector", "value"],
          },
        },
        submit: { type: "boolean", description: "Submit the form after filling." },
      },
      required: ["fields"],
    },
    handler: (a) => call("POST", "/fill", a),
  },
  {
    name: "upload",
    description: "Attach local files to an <input type=\"file\"> via CDP. Works on hidden (display:none) inputs since no native OS picker is involved — the only reliable way to upload files. Provide absolute paths.",
    inputSchema: {
      type: "object",
      properties: {
        tab,
        selector: { type: "string", description: "CSS selector for the <input type=\"file\"> element (may be hidden)." },
        files: {
          type: "array",
          description: "Absolute file paths to attach.",
          items: { type: "string" },
        },
      },
      required: ["selector", "files"],
    },
    handler: (a) => call("POST", "/upload", a),
  },
  {
    name: "screenshot",
    description: "Capture a PNG screenshot of a tab and RETURN IT AS AN IMAGE so you can see the page. Use when text recon/read is not enough: captchas, canvas/visual elements, error diagnosis, or visual verification after an action. Optionally also save to an absolute file path.",
    returnsImage: true,
    inputSchema: {
      type: "object",
      properties: {
        tab,
        output: { type: "string", description: "Optional absolute path to also save the PNG to disk." },
      },
    },
    handler: (a) => call("POST", "/screenshot", a),
  },
  {
    name: "indicator",
    description: "Toggle the 'agent is working' overlay — a fine pixel-mosaic shimmer framing the viewport edges — on a tab. It auto-appears when treko navigates a tab; use this to force it on/off (e.g. off before a clean screenshot). pointer-events:none, never blocks the page.",
    inputSchema: {
      type: "object",
      properties: {
        tab,
        on: { type: "boolean", description: "true to show (default), false to hide." },
      },
    },
    handler: (a) => call("POST", "/indicator", a),
  },
  {
    name: "commander",
    description: "Point-and-Command. A corner launcher button ('🎯 Point & Command', bottom-right) auto-appears whenever treko navigates a tab, so the human can activate it themselves — you usually don't need to call this. Use it to force the overlay on/off, or pass active:true to start straight in inspect mode. When active, the human hovers any element (teal highlight + selector chip), clicks it, types an instruction, Enter — the command is queued; poll `inbox` to receive it. pointer-events are managed so the page is untouched until they act.",
    inputSchema: {
      type: "object",
      properties: {
        tab,
        on: { type: "boolean", description: "true to (re)inject the launcher (default), false to remove it entirely." },
        active: { type: "boolean", description: "Start straight in inspect mode instead of dormant (default false — just the launcher shows)." },
      },
    },
    handler: (a) => call("POST", "/commander", a),
  },
  {
    name: "inbox",
    description: "Drain the Point-and-Command queue for a tab — the commands the human pointed at and typed while `commander` was on. Returns { items:[{selector, element, command, url, rect, ts}], count }. Each item ties a plain-language instruction to an exact element selector, so you can act on precisely what the user meant. Defaults to your own session tab. Poll this after enabling commander.",
    inputSchema: {
      type: "object",
      properties: {
        tab,
        drain: { type: "boolean", description: "Clear the queue after reading (default true). false to peek." },
      },
    },
    handler: (a) => call("POST", "/inbox/poll", a),
  },
  {
    name: "watch",
    description: "WAIT for the next Point-and-Command the human makes in the browser, then RETURN it — the command text plus the pointed element's screenshot AS AN IMAGE (rendered inline, exactly like the `screenshot` tool). Blocks until a comment arrives or ~90 s, whichever first; returns immediately when one arrives. This is the universal flagship path: it's a plain tool call, so it works in EVERY runtime (desktop, CLI, cmux, even Codex) — no Channels, no hooks, no launch flags. Waiting costs no tokens. Call it again in a loop to keep watching. The human needs flagship (commander) active on a tab. When it returns a command, act on it in THIS project using the selector/URL; if it returns 'nothing yet', just call `watch` again.",
    inputSchema: {
      type: "object",
      properties: {
        timeoutMs: { type: "number", description: "Max time to block before returning 'nothing yet' (default 90000). Lower it (e.g. 45000) on runtimes with short tool timeouts; then just call watch again." },
      },
    },
    returnsImage: true,
    handler: (a) => watchForCommand(a),
  },
  {
    name: "act",
    description: "Run several treko ops in ONE call against the same tab (one reused connection) — faster and atomic for multi-step flows like login. steps is an ordered array of { op, ...params } where op is any of: navigate, waitfor, fill, click, read, scroll, type, eval, dispatch, screenshot, upload, recon, dismiss, captcha, diagnostics (same params as the standalone tool, minus tab). By default stops at the first failing step (a timed-out waitfor, a click that found nothing, etc.) and returns what ran; set stopOnError:false to run them all. Returns { results:[{op,ok,data|error}], completed, stoppedAt? }. Prefer this over many separate calls when the steps are a known sequence.",
    inputSchema: {
      type: "object",
      properties: {
        tab,
        steps: {
          type: "array",
          description: "Ordered ops, e.g. [{op:'navigate',url:'...'},{op:'waitfor',selector:'#email'},{op:'fill',fields:[...]},{op:'click',text:'Login'}].",
          items: { type: "object", properties: { op: { type: "string" } }, required: ["op"] },
        },
        stopOnError: { type: "boolean", description: "Stop at the first failing step (default true). false runs every step." },
      },
      required: ["steps"],
    },
    handler: (a) => call("POST", "/act", a),
  },
  {
    name: "waitfor",
    description: "Block until a page condition holds, then return immediately — instead of blind sleeps. Provide ONE of: selector (element exists AND visible), text (page contains substring), selector+gone:true (element disappeared), urlChange (current URL differs from the given value), readyState:true (document fully loaded). Returns {matched:true,waitedMs} or {matched:false,timedOut:true,waitedMs}. Use after navigate/click when the next element loads async.",
    inputSchema: {
      type: "object",
      properties: {
        tab,
        selector: { type: "string", description: "CSS selector to wait for (appear+visible, or disappear with gone:true)." },
        text: { type: "string", description: "Substring to wait for in the page text." },
        gone: { type: "boolean", description: "With selector: wait until it is GONE/hidden instead of present." },
        urlChange: { type: "string", description: "Wait until window.location.href differs from this value." },
        readyState: { type: "boolean", description: "Wait until document.readyState === 'complete'." },
        timeoutMs: { type: "number", description: "Max wait in ms (default 10000)." },
      },
    },
    handler: (a) => call("POST", "/waitfor", a),
  },
  {
    name: "diagnostics",
    description: "See what's going wrong on a page: buffered JS console errors/warnings, failed network requests (HTTP 4xx/5xx), and uncaught exceptions. Call it after an action misbehaves to diagnose SPA/API failures the DOM doesn't reveal. First call on a tab starts monitoring and returns empty (events accumulate from then on) — so call it, trigger the action, then call again. Set clear:true to drain the buffers.",
    inputSchema: {
      type: "object",
      properties: {
        tab,
        clear: { type: "boolean", description: "Drain the buffers after reading." },
      },
    },
    handler: (a) => call("POST", "/diagnostics", a),
  },
  {
    name: "scroll",
    description: "Scroll page and preview newly visible content. direction: 'up'|'down'|'top'|'bottom'.",
    inputSchema: {
      type: "object",
      properties: {
        tab,
        direction: { type: "string", enum: ["up", "down", "top", "bottom"] },
        amount: { type: "number", description: "Pixels to scroll (for up/down)." },
      },
    },
    handler: (a) => call("POST", "/scroll", a),
  },
  {
    name: "navigate",
    description: "Navigate to URL or move through history (back/forward). AUTO-HANDLES bot walls: if the page is a Cloudflare challenge ('Just a moment…' / 'Performing security verification' / 'Tikriname jūsų naršyklę'), treko detects it, waits for auto-pass, and real-clicks the checkbox if it can. The response then includes a `botChallenge` object — ALWAYS check it: if `autoResolved:true` you're through; if `autoResolved:false`, follow `botChallenge.hint` (usually: call `screenshot`, read the 'Verify you are human' checkbox center pixel, then `captcha {action:'turnstile', x, y}`). Don't treat a 'Just a moment…' title as the real page. Set solveChallenge:false to only detect.",
    inputSchema: {
      type: "object",
      properties: {
        tab,
        url: { type: "string" },
        back: { type: "boolean" },
        forward: { type: "boolean" },
        waitMs: { type: "number" },
        solveChallenge: { type: "boolean", description: "Auto-attempt to clear a detected Cloudflare bot wall (default true). Set false to only detect and report it." },
      },
    },
    handler: (a) => call("POST", "/navigate", a),
  },
  {
    name: "eval",
    description: "Execute arbitrary JavaScript in the tab context. Use for reading computed state, custom scraping, or triggering framework APIs.",
    inputSchema: {
      type: "object",
      properties: {
        tab,
        expression: { type: "string", description: "JavaScript expression to evaluate." },
      },
      required: ["expression"],
    },
    handler: (a) => call("POST", "/eval", a),
  },
  {
    name: "dismiss",
    description: "Auto-dismiss cookie banners, modal overlays, and GDPR prompts. Call before interacting with the page.",
    inputSchema: {
      type: "object",
      properties: { tab },
    },
    handler: (a) => call("POST", "/dismiss", a),
  },
  {
    name: "focus",
    description: "Bring a tab to the front in Chrome.",
    inputSchema: {
      type: "object",
      properties: { tab },
    },
    handler: (a) => call("POST", "/focus", a),
  },
  {
    name: "captcha",
    description: "Detect and interact with captchas. action 'turnstile' clicks a Cloudflare 'Verify you are human' checkbox with a REAL mouse gesture (the only thing that passes it). RELIABLE FLOW for full-page Cloudflare interstitials (delfi.lt, skelbiu.lt, autoplius.lt — 'Just a moment...' / 'Performing security verification'): the checkbox lives in a dynamically-named cross-origin iframe that selectors can't reach, so (1) call screenshot, (2) look at the image and read the checkbox's center pixel coordinates, (3) call captcha with action:'turnstile' and those x,y — at dpr=1 image pixels equal viewport coords. Omit x,y to let it auto-detect embedded widgets. 'detect' reports captchas on the page. Other actions (read/next/prev/submit/audio/restart) drive image/arkose challenges. Best-effort — Cloudflare may still escalate.",
    inputSchema: {
      type: "object",
      properties: {
        tab,
        action: { type: "string", description: "turnstile | detect | read | next | prev | submit | audio | restart" },
        x: { type: "number", description: "turnstile only: checkbox center X in viewport/screenshot pixels (read off a screenshot). Pass with y to click an exact point." },
        y: { type: "number", description: "turnstile only: checkbox center Y in viewport/screenshot pixels." },
      },
    },
    handler: (a) => call("POST", "/captcha", a),
  },
  {
    name: "dispatch",
    description: "Dispatch synthetic DOM events — use for React/Vue/Angular components that ignore plain click/input.",
    inputSchema: {
      type: "object",
      properties: {
        tab,
        selector: { type: "string" },
        event: { type: "string", description: "Event name (e.g. 'change', 'input', 'focus')." },
        bubbles: { type: "boolean" },
        cancelable: { type: "boolean" },
        detail: {},
        eventInit: { type: "object" },
        reactDebug: { type: "boolean" },
      },
      required: ["selector", "event"],
    },
    handler: (a) => call("POST", "/dispatch", a),
  },
  {
    name: "type",
    description: "Raw CDP keystrokes without clearing the field. Use for keyboard shortcuts or appending text. Supports special keys via 'keys'.",
    inputSchema: {
      type: "object",
      properties: {
        tab,
        keys: { type: "string", description: "String of keys to type (supports specials like 'Enter', 'Tab')." },
        submit: { type: "boolean" },
      },
      required: ["keys"],
    },
    handler: (a) => call("POST", "/type", a),
  },
];

const server = new Server(
  { name: "treko", version: "1.19.0" },
  {
    // `claude/channel` makes this MCP a Channel: it can push events straight into THIS
    // running session so a Point-and-Command comment appears on screen instantly, even
    // while the agent is idle (a Stop hook only fires at turn boundaries; a channel doesn't).
    capabilities: { tools: {}, experimental: { "claude/channel": {} } },
    instructions:
      "Point-and-Command events arrive as <channel source=\"treko\" command=\"...\" element=\"...\" selector=\"...\" url=\"...\" screenshot=\"...\">. " +
      "The human pointed at that element in the treko browser and wants it acted on. FIRST make it visible: show a short block ([gauta is treko flagship] + command/element/page) and `Read` the screenshot path so the element image renders inline. THEN act on the command in THIS project using the selector/URL. " +
      "If the element belongs to an external site (not this project's code), still show it but report instead of editing.",
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

const TABLESS = new Set(["health", "tabs"]);

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find((t) => t.name === req.params.name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${req.params.name}. Available: ${TOOLS.map(t => t.name).join(", ")}` }],
    };
  }

  const notices = [];
  try {
    const startInfo = await ensureServer();
    if (startInfo && startInfo.started) {
      notices.push(`ℹ️ Auto-started Treko server (pid=${startInfo.pid}). Chrome may open a new window.`);
    }
    await registerOnce();   // tie this session to its project so Point-and-Command routes back here
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Server unavailable: ${err.message}` }],
    };
  }

  try {
    const args = { ...(req.params.arguments || {}) };
    // Tag every tab-using call with this agent's session. The server resolves it to a
    // dedicated tab (creating one on first use), so parallel agents never share tab "0".
    // An explicit `tab` still wins (server honors it and just touches the session).
    if (!TABLESS.has(tool.name) && args.session === undefined) {
      args.session = SESSION_ID;
    }
    const result = await tool.handler(args);

    // Image-returning tools (screenshot): hand back an actual image block so Claude can SEE it.
    if (tool.returnsImage && result && typeof result === "object" && result.data) {
      const { data, mimeType, ...meta } = result;
      const metaText = JSON.stringify(meta, null, 2);
      const text = notices.length ? `${notices.join("\n")}\n\n${metaText}` : metaText;
      return {
        content: [
          { type: "image", data, mimeType: mimeType || "image/png" },
          { type: "text", text },
        ],
      };
    }

    const payload = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    const text = notices.length ? `${notices.join("\n")}\n\n${payload}` : payload;
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const hint = /not found|ECONN|fetch failed/i.test(err.message)
      ? "\n\nHint: the server may have crashed. Call `health` to re-check, or run `treko start` manually."
      : "";
    return {
      isError: true,
      content: [{ type: "text", text: `${err.message}${hint}` }],
    };
  }
});

process.on("uncaughtException", (err) => log("uncaught:", err));
process.on("unhandledRejection", (err) => log("unhandled:", err));

// Best-effort: when this agent process ends, release its tab so it doesn't linger.
// (The server also GCs idle session tabs after ~30 min as a backstop.)
let cleanedUp = false;
function releaseSession() {
  if (cleanedUp || process.env.TREKO_SESSION) return; // don't end a shared/explicit session
  cleanedUp = true;
  try {
    fetch(`${BASE_URL}/session/end`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: SESSION_ID }),
    }).catch(() => {});
  } catch {}
}
process.on("SIGTERM", () => { releaseSession(); process.exit(0); });
process.on("SIGINT", () => { releaseSession(); process.exit(0); });
process.on("beforeExit", releaseSession);

const transport = new StdioServerTransport();
await server.connect(transport);
log(`connected. baseUrl=${BASE_URL} session=${SESSION_ID} logDir=${LOG_DIR}`);

// Channel push — hold an SSE stream open to the treko server for THIS session. When the human
// points at something in the browser, the server pushes it here and we turn it into a
// `notifications/claude/channel` event so it lands in this session instantly, even while idle.
// Only active when Claude Code loaded this MCP as a channel (i.e. started with the channel flag);
// otherwise the notification is dropped silently and the Stop hook remains the fallback.
async function pushChannelEvent(item) {
  if (!item || !item.command) return;
  const meta = {};
  if (item.element) meta.element = String(item.element);
  if (item.selector) meta.selector = String(item.selector);
  if (item.url) meta.url = String(item.url);
  if (item.screenshot) meta.screenshot = String(item.screenshot);
  if (item.cid) meta.cid = String(item.cid);
  try {
    await server.notification({
      method: "notifications/claude/channel",
      params: { content: String(item.command), meta },
    });
    log(`channel push: ${String(item.command).slice(0, 60)}`);
  } catch (e) {
    log(`channel push failed: ${e?.message || e}`);
  }
}

async function subscribeChannel() {
  const url = `${BASE_URL}/channel/subscribe?session=${encodeURIComponent(SESSION_ID)}`;
  for (;;) {
    try {
      const resp = await fetch(url, { headers: { Accept: "text/event-stream" } });
      if (!resp.ok || !resp.body) throw new Error(`subscribe HTTP ${resp.status}`);
      log(`channel subscribed (session=${SESSION_ID})`);
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue; // ": connected" / ": hb" heartbeats
          const payload = dataLine.slice(5).trim();
          if (!payload) continue;
          try { await pushChannelEvent(JSON.parse(payload)); } catch { /* ignore malformed frame */ }
        }
      }
    } catch (e) {
      log(`channel stream lost: ${e?.message || e}; reconnecting in 2s`);
    }
    await new Promise((r) => setTimeout(r, 2000)); // reconnect backoff
  }
}

// Channel push is OPT-IN (set TREKO_CHANNEL=1 when you launch Claude Code with `--channels
// plugin:treko@...`). Reason: the SSE subscription makes the server sweep drain this session's queue
// and push it as a channel notification — but on a runtime that ISN'T loaded as a channel (the
// desktop app, Codex, or a plain session) that notification is dropped silently, which would consume
// the comment and starve the universal paths (`watch` tool + Stop hook). So by default we don't
// subscribe: `watch` and the Stop hook deliver everywhere, reliably. Enable this only alongside the
// channel flag, where the push is actually accepted.
if (process.env.TREKO_CHANNEL === "1") {
  subscribeChannel().catch((e) => log(`channel subscribe fatal: ${e?.message || e}`));
} else {
  log("channel push off (set TREKO_CHANNEL=1 with --channels to enable); watch tool + Stop hook active");
}
