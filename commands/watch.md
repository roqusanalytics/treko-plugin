---
description: Live-watch treko flagship — continuously wait for Point-and-Command comments and execute them (universal — works on desktop, CLI, cmux, and Codex)
---

Enter a **persistent live watch loop** for treko Point-and-Command. You wait for the human to
point at an element in the browser and type a command, then you execute it — continuously, so a
comment made at ANY time (right now, or 5 / 30 minutes from now) is caught. This works in every
runtime because it is a plain tool call — no Channels, no hooks, no launch flags.

**The loop — repeat until the user interrupts (do NOT stop on your own):**

1. Call `mcp__treko__watch`. It BLOCKS until the human points-and-commands, then returns the
   command(s) plus the pointed element's screenshot as an image (it renders inline automatically).
   While it waits it costs no tokens, so idling here is free.

2. **If it returned a command:**
   - The element screenshot is already shown above — glance at it. Then show the human one visible
     line so they see it arrived: `📩 Gauta iš treko flagship: "<command>" — <element> (<url>)`.
   - If the element belongs to **THIS project's app**: find the component/file that renders it
     (search by its visible text, label, or a stable part of the `selector`), implement `command`
     as a real code change, and verify (build/lint, plus a treko screenshot if it's visual).
   - If it belongs to an **external site** (not this project's code): show it and report — do NOT
     edit code.
   - Briefly report what you did.

3. **If it returned "nothing yet"** (it timed out with no comment): just continue — nothing to do.

4. **ALWAYS call `mcp__treko__watch` again.** Never end the loop yourself. Keep watching so the next
   comment — whenever it comes — is caught. Stop only when the user interrupts or tells you to stop.

Notes:
- The human must have flagship active: the 🎯 launcher on the tab, clicked into inspect mode
  (button turns green, "Aktyvu • rodyk elementą").
- **No comment is ever lost**: one made in the gap between two `watch` calls is queued and the next
  `watch` returns it immediately — so re-calling promptly gives continuous coverage.
- You do **not** need `/loop` — `watch` blocks and you re-call it yourself. (`timeoutMs` defaults to
  90 s; pass a smaller value on runtimes with short tool timeouts, then just call again.)
