#!/usr/bin/env bash
# Treko flagship — async live watcher (asyncRewake Stop hook).
#
# Fires at every turn end and runs in the BACKGROUND (non-blocking — the session goes idle normally,
# the user is never locked out). It polls this session's Point-and-Command queue in-shell, which costs
# ZERO tokens. The moment the human points-and-commands in the browser, it prints the command and exits
# with code 2 — and `asyncRewake` makes Claude Code WAKE this session immediately, even while idle, and
# deliver the comment. So a comment made minutes after the last turn still lands, with no `/loop`, no
# command, no Channels flag. Works on desktop, CLI, cmux, and Codex.
#
# Bounded: it watches for ~9 min then exits quietly; each new turn re-arms it (a delivered comment ends
# in a turn, which re-arms). A lock keeps a single watcher per session (async hooks aren't de-duped).
# Gated on flagship being present (the commander launcher on this session's tab), so non-treko sessions
# spawn nothing.

INPUT=$(cat 2>/dev/null)
URL="${TREKO_URL:-http://localhost:3456}"
LOOP_MAX="${TREKO_WATCH_ITERS:-360}"      # 360 * 1.5s ≈ 9 min (under the 570s hook timeout)

read -r SID DIR <<EOF
$(printf '%s' "$INPUT" | python3 -c 'import sys,json
try: d=json.load(sys.stdin)
except Exception: d={}
print((d.get("session_id") or "-"), (d.get("cwd") or ""))' 2>/dev/null)
EOF
[ "$SID" = "-" ] && SID=""
[ -z "$DIR" ] && DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
[ -z "$SID" ] && SID="$DIR"

# Gate: only watch when flagship is available on this session's tab (launcher present). No treko -> nothing.
LAUNCHER=$(curl -sf --max-time 3 -X POST "$URL/eval" -H 'Content-Type: application/json' \
  -d "{\"session\":\"$SID\",\"expression\":\"!!document.getElementById('__treko_commander___btn')\"}" 2>/dev/null \
  | python3 -c 'import sys,json
try: print("true" if json.load(sys.stdin).get("result") else "false")
except Exception: print("false")' 2>/dev/null)
[ "$LAUNCHER" = "true" ] || exit 0

# One watcher per session.
mkdir -p /tmp/treko-plugin 2>/dev/null
LOCK="/tmp/treko-plugin/watch-$(printf '%s' "$SID" | tr -c 'a-zA-Z0-9._-' '_').lock"
if [ -f "$LOCK" ]; then
  OLDPID=$(cat "$LOCK" 2>/dev/null)
  if [ -n "$OLDPID" ] && kill -0 "$OLDPID" 2>/dev/null; then exit 0; fi   # a live watcher already owns this session
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

# Poll loop (in-shell = free). On a comment: print it (Claude sees it as a system reminder) and exit 2
# so asyncRewake wakes the session. On timeout: exit 0 (quiet; the next turn re-arms).
i=0
while [ "$i" -lt "$LOOP_MAX" ]; do
  R=$(curl -sf --max-time 4 -X POST "$URL/inbox/poll" -H 'Content-Type: application/json' \
    -d "{\"session\":\"$SID\",\"cwd\":\"$DIR\",\"drain\":true,\"shots\":true}" 2>/dev/null)
  OUT=$(TREKO_INBOX_JSON="$R" python3 -c '
import os, json, sys
try: d = json.loads(os.environ.get("TREKO_INBOX_JSON", "") or "{}")
except Exception: sys.exit(0)
items = d.get("items", [])
if not items: sys.exit(0)
lines = []
for it in items:
    parts = [
        "- komanda: \"%s\"" % it.get("command", ""),
        "  elementas: %s" % it.get("element", ""),
        "  selektorius: %s" % it.get("selector", ""),
        "  puslapis: %s" % it.get("url", ""),
    ]
    shot = it.get("screenshot")
    if shot: parts.append("  screenshot (elementas + kontekstas): %s" % shot)
    lines.append("\n".join(parts))
print(
    "Point-and-Command: %d nauja(-os) uzklausa(-os) is treko narsykles. "
    "PIRMA parodyk matoma bloka (antraste [gauta is treko flagship] + komanda/elementas/puslapis) ir "
    "`Read` screenshot faila, kad nuotrauka pasirodytu ekrane. TADA ivykdyk kiekviena komanda SIAME "
    "projekte (naudok selektoriu/URL). Jei elementas is isorines svetaines (ne sio projekto kodas) - "
    "parodyk ir pasakyk, bet nevykdyk.\n%s" % (len(items), "\n".join(lines))
)
' 2>/dev/null)
  if [ -n "$OUT" ]; then
    printf '%s\n' "$OUT"
    exit 2
  fi
  i=$((i + 1))
  sleep 1.5
done
exit 0
