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

const BASE_URL = process.env.TREKO_URL || "http://localhost:3456";
const START_TIMEOUT_MS = Number(process.env.TREKO_START_TIMEOUT_MS || 45_000);
const LOG_DIR = join(tmpdir(), "treko-plugin");
const LOG_FILE = join(LOG_DIR, "server.log");

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
  description: "Tab selector: numeric index ('0'), URL/title partial match ('github'), or iframe domain. Defaults to '0' (first tab) if omitted.",
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
    description: "Map a page: headings, navigation, clickable elements with CSS selectors, forms, landmarks, overlays, captchas. Primary exploration tool — call this before clicking/filling so you know what selectors exist.",
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
    description: "Navigate to URL or move through history (back/forward).",
    inputSchema: {
      type: "object",
      properties: {
        tab,
        url: { type: "string" },
        back: { type: "boolean" },
        forward: { type: "boolean" },
        waitMs: { type: "number" },
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
    description: "Detect and interact with captchas on the page. action: 'detect'|'click'|'solve'.",
    inputSchema: {
      type: "object",
      properties: {
        tab,
        action: { type: "string", description: "detect | click | solve" },
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
  { name: "treko", version: "1.1.0" },
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
    if (!TABLESS.has(tool.name) && (args.tab === undefined || args.tab === null || args.tab === "")) {
      args.tab = "0";
    }
    const result = await tool.handler(args);
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

const transport = new StdioServerTransport();
await server.connect(transport);
log(`connected. baseUrl=${BASE_URL} logDir=${LOG_DIR}`);
