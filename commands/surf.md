---
description: Open a URL in the user's real Chrome via Surfagent and recon it
---

Use the `surfagent` skill. Steps:

1. Call `mcp__surfagent__health` to confirm the server is up. If it fails, tell the user to run `surfagent start` and stop.
2. Call `mcp__surfagent__navigate` with `url: "$ARGUMENTS"`.
3. Call `mcp__surfagent__dismiss` to clear cookie banners.
4. Call `mcp__surfagent__recon` and summarize the page: title, main headings, primary nav, and top 5 interactive elements with their selectors.

Target URL: $ARGUMENTS
