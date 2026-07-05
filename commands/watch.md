---
description: Watch the treko Point-and-Command inbox and execute the commands the human pointed at (run via /loop for live watching)
---

Pick up and execute the Point-and-Command requests the human made by pointing at elements
in the treko Chrome window. This is the "activation" side of the flagship: the command the
human typed on an element routes back to THIS session (your project) and you act on it.

Steps:

1. Call `mcp__treko__inbox` — it drains **this session's** queue (the commands the human
   pointed at on this session's own tab). The response is `{ items, count, project }`.
2. If `count` is 0: say "📭 Point-and-Command inbox tuščias — laukiu, kol parodysi elementą
   naršyklėje." and stop this iteration (nothing to do).
3. Check `project.cwd` — the repo the human is pointing at. If it does **not** match the
   project you are working in, do NOT edit code; report the mismatch and stop (the command
   belongs to a different session/project).
4. For each item `{ command, selector, element, url, rect }`:
   a. It refers to a real element (`element`, `selector`) on the page at `url`. To see exactly
      what the human means, use `mcp__treko__navigate` to `url` then `mcp__treko__screenshot`
      (or `mcp__treko__recon`/`read` scoped to `selector`).
   b. Locate the component/file in THIS repo that renders that element — search by its visible
      text, label, or a stable part of the selector.
   c. Implement `command` as a real code change. Then verify (build/lint, and a treko
      screenshot of the element if it is a visual change).
   d. Briefly report: what the human asked, which file(s) you changed, how you verified.
5. If you handled one or more commands, end with a short summary.

Live watching: run `/loop 8s /treko:watch` — treko's corner launcher must be active in the
tab (the human clicks the 🎯 button, points at an element, types, Enter). Each loop tick you
pick up new commands and act on them, all inside this session with full project context.
