---
description: Watch treko flagship for ONE Point-and-Command cycle and execute it — run via `/loop /treko:watch` for reliable continuous watching (universal: desktop, CLI, cmux, Codex)
---

Handle **one** treko Point-and-Command watch cycle: wait for the human to point at an element in
the browser and type a command, then execute it. Run this via **`/loop /treko:watch`** so the harness
re-invokes it after every cycle — that gives reliable continuous watching that survives across
comments (a self-driven loop is not reliable: after acting on one comment the model tends to end its
turn, so a comment sent minutes later is missed). Works in every runtime — desktop, CLI, cmux, Codex —
it's just a tool call.

Do exactly this, once:

1. Call `mcp__treko__watch` (optionally `{ "timeoutMs": 60000 }`). It BLOCKS — free, no tokens — until
   the human points-and-commands, then returns the command(s) plus the pointed element's screenshot
   as an image (rendered inline automatically). If it returns **"nothing yet"** (timed out with no
   comment), just say so briefly and stop — `/loop` will call again.

2. If it returned a command, for each item `{ command, element, selector, url }`:
   - The element screenshot is already shown above — glance at it. Show the human one visible line so
     they see it arrived: `📩 Gauta iš treko flagship: "<command>" — <element> (<url>)`.
   - If the element belongs to **THIS project's app**: find the component/file that renders it (search
     by its visible text, label, or a stable part of the `selector`), implement `command` as a real
     code change, and verify (build/lint, plus a treko screenshot if it's visual).
   - If it belongs to an **external site** (not this project's code): show it and report — do NOT edit.
   - Briefly report what you did, then stop (let `/loop` start the next cycle).

Notes:
- **Continuous watching = `/loop /treko:watch`.** Running `/treko:watch` alone handles a single comment
  and stops; only `/loop` keeps it alive across comments made minutes apart.
- The human must have flagship active: the 🎯 launcher on the tab, clicked into inspect mode (green
  "Aktyvu • rodyk elementą").
- **No comment is lost**: one sent while you were busy or between cycles stays queued and the next
  `watch` returns it immediately.
