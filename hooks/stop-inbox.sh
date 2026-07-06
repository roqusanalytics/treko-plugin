#!/usr/bin/env bash
# Treko Point-and-Command — Stop hook.
#
# Fires when the agent finishes a turn (about to go idle). Pulls any commands the human
# pointed at in the browser into this session so the agent acts on them — with no polling
# and no token cost, because this event happens anyway. Resolves the queue by project dir
# (the hook only knows the cwd, not the random session id; the server maps cwd -> session).
#
# If treko isn't running, or nothing is queued, it exits 0 and the turn stops normally.

DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
URL="${TREKO_URL:-http://localhost:3456}"

R=$(curl -sf --max-time 2 -X POST "$URL/inbox/poll" \
  -H 'Content-Type: application/json' \
  -d "{\"cwd\":\"$DIR\",\"drain\":true}" 2>/dev/null) || exit 0

TREKO_INBOX_JSON="$R" python3 -c '
import os, json, sys
try:
    d = json.loads(os.environ.get("TREKO_INBOX_JSON", "") or "{}")
except Exception:
    sys.exit(0)
items = d.get("items", [])
if not items:
    sys.exit(0)
lines = []
for it in items:
    lines.append(
        "- komanda: \"%s\"\n  elementas: %s\n  selektorius: %s\n  puslapis: %s"
        % (it.get("command", ""), it.get("element", ""), it.get("selector", ""), it.get("url", ""))
    )
reason = (
    "Point-and-Command: %d uzklausa(-os) is narsykles (zmogus parode elementa ir parase komanda). "
    "Ivykdyk kiekviena SIAME projekte - naudok selektoriu/URL, kad rastum ir pataisytum tinkama vieta kode:\n%s"
    % (len(items), "\n".join(lines))
)
print(json.dumps({"decision": "block", "reason": reason}))
'
