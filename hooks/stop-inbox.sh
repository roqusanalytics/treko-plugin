#!/usr/bin/env bash
# Treko Point-and-Command — Stop hook.
#
# Fires when the agent finishes a turn (about to go idle). Pulls any commands the human
# pointed at in the browser into THIS session so the agent acts on them — no polling, no
# token cost, because this event happens anyway.
#
# Routes precisely by the Claude session_id (received on stdin): the MCP adopts that same
# id as its treko session, so with many sessions in one project each drains only its own
# commands. Falls back to the project dir (cwd) when the id isn't available.
#
# If treko isn't running, or nothing is queued, it exits 0 and the turn stops normally.

INPUT=$(cat 2>/dev/null)
URL="${TREKO_URL:-http://localhost:3456}"

read -r SID DIR <<EOF
$(printf '%s' "$INPUT" | python3 -c 'import sys,json
try: d=json.load(sys.stdin)
except Exception: d={}
print((d.get("session_id") or "-"), (d.get("cwd") or ""))' 2>/dev/null)
EOF
[ "$SID" = "-" ] && SID=""
[ -z "$DIR" ] && DIR="${CLAUDE_PROJECT_DIR:-$PWD}"

R=$(curl -sf --max-time 3 -X POST "$URL/inbox/poll" \
  -H 'Content-Type: application/json' \
  -d "{\"session\":\"$SID\",\"cwd\":\"$DIR\",\"drain\":true}" 2>/dev/null) || exit 0

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
    shot = it.get("screenshot")
    parts = [
        "- komanda: \"%s\"" % it.get("command", ""),
        "  elementas: %s" % it.get("element", ""),
        "  selektorius: %s" % it.get("selector", ""),
        "  puslapis: %s" % it.get("url", ""),
    ]
    if shot:
        parts.append("  screenshot (elementas + kontekstas): %s" % shot)
    lines.append("\n".join(parts))
reason = (
    "Point-and-Command: %d uzklausa(-os) is narsykles (zmogus parode elementa ir parase komanda). "
    "Perziurek screenshota (Read faila), kad pamatytum elementa, tada ivykdyk kiekviena komanda SIAME "
    "projekte - naudok selektoriu/URL, kad rastum ir pataisytum tinkama vieta kode:\n%s"
    % (len(items), "\n".join(lines))
)
print(json.dumps({"decision": "block", "reason": reason}))
'
