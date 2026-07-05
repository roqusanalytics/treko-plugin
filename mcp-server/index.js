#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn, spawnSync } from "node:child_process";
import { openSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const BASE_URL = process.env.TREKO_URL || "http://localhost:3456";
const START_TIMEOUT_MS = Number(process.env.TREKO_START_TIMEOUT_MS || 45_000);
const LOG_DIR = join(tmpdir(), "treko-plugin");
const LOG_FILE = join(LOG_DIR, "server.log");

// Unique per agent process. Each parallel agent has its own MCP process, so this
// id isolates it to its own Chrome tab — no more cannibalizing tab "0". Override
// with TREKO_SESSION to share a tab across processes on purpose.
const SESSION_ID = process.env.TREKO_SESSION || `agent-${randomUUID().slice(0, 8)}`;

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
  { name: "treko", version: "1.8.0" },
  { capabilities: { tools: {} } }
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
