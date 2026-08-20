---
description: Open a URL in the user's real Chrome via Treko and recon it
---

Use the `treko` skill. Steps:

1. Call `mcp__treko__navigate` with `url: "$ARGUMENTS"` — the wrapper auto-starts the server
   and Chrome on the first call, so there is nothing to pre-check. If it returns a structured
   error, follow the fix it names.
2. Call `mcp__treko__dismiss` to clear cookie banners.
3. Call `mcp__treko__recon` and summarize the page: title, main headings, primary nav, and top 5 interactive elements with their selectors.

Target URL: $ARGUMENTS
