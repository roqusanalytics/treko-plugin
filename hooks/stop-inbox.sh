#!/usr/bin/env bash
# Treko Point-and-Command — Stop hook (with a bounded live-catch window).
#
# Fires when the agent finishes a turn. It always drains any commands already queued for THIS
# session and delivers them (visible render + screenshot, then act).
#
# NEW — live-catch window: if the human is actively in flagship mode (commander overlay on this
# session's tab) and nothing is queued yet, the hook keeps polling in-shell for a short window
# (a bounded `for` loop) so a comment made a few seconds later still lands live — even on the
# desktop app, where Channels (the real push path) can't be enabled. The polling happens in bash,
# so an empty wait costs ZERO tokens; the agent only runs when a comment actually arrives.
#
# Bounded three ways so it never loops forever: the `for` limit (below), Claude Code's hook
# timeout, and the window resetting on every new turn. If commander is OFF, it returns
# immediately — normal work never hangs.
#
# Routes precisely by the Claude session_id from stdin (the MCP adopts the same id); cwd is the
# fallback. Exits 0 (turn stops normally) if treko is down or nothing is queued.

INPUT=$(cat 2>/dev/null)
URL="${TREKO_URL:-http://localhost:3456}"

# Tunables (kept well under the 60s hook timeout).
LOOP_MAX="${TREKO_CATCH_ITERS:-9}"     # iterations
LOOP_SLEEP="${TREKO_CATCH_SLEEP:-5}"   # seconds between polls  -> 9*5 = ~45s window

read -r SID DIR <<EOF
$(printf '%s' "$INPUT" | python3 -c 'import sys,json
try: d=json.load(sys.stdin)
except Exception: d={}
print((d.get("session_id") or "-"), (d.get("cwd") or ""))' 2>/dev/null)
EOF
[ "$SID" = "-" ] && SID=""
[ -z "$DIR" ] && DIR="${CLAUDE_PROJECT_DIR:-$PWD}"

# Poll once; if commands are queued, print the block JSON (delivery) and signal success.
poll_and_maybe_deliver() {
  local resp out
  resp=$(curl -sf --max-time 4 -X POST "$URL/inbox/poll" \
    -H 'Content-Type: application/json' \
    -d "{\"session\":\"$SID\",\"cwd\":\"$DIR\",\"drain\":true}" 2>/dev/null) || return 1
  out=$(TREKO_INBOX_JSON="$resp" python3 -c '
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
    "Point-and-Command: %d nauja(-os) uzklausa(-os) is treko narsykles.\n\n"
    "PRIVALOMA — PIRMAS tavo veiksmas turi buti MATOMAS vartotojui ekrane (jis siuncia is narsykles ir turi vizualiai matyti, kad atejo):\n"
    "1) Parodyk trumpa matoma bloka: antraste [gauta is treko flagship] ir kiekvienos uzklausos komanda, elementas, puslapis.\n"
    "2) Kiekvienam screenshot failui iskviesk Read su to failo keliu — kad elemento nuotrauka pasirodytu INLINE ekrane.\n"
    "TIK PO TO (kai vartotojas matomai gavo) vykdyk kiekviena komanda SIAME projekte — naudok selektoriu/URL, kad rastum ir pataisytum tinkama vieta kode.\n"
    "(Jei elementas yra is isorines svetaines, kuri nera sio projekto kodas — vis tiek matomai parodyk, bet komandos nevykdyk, o pasakyk vartotojui.)\n\n"
    "%s"
    % (len(items), "\n".join(lines))
)
print(json.dumps({"decision": "block", "reason": reason}))
' 2>/dev/null)
  if [ -n "$out" ]; then printf '%s' "$out"; return 0; fi
  return 1
}

# 1) Immediate drain — deliver anything already waiting.
poll_and_maybe_deliver && exit 0

# 2) Gate the live-catch window on flagship being ACTIVELY engaged (inspect mode on), so normal
#    turns never hang. The overlay object persists (self-heals), so we check isActive(), not mere
#    existence — true only while the human is in pointing mode, i.e. about to send a comment.
CMDR=$(curl -sf --max-time 3 -X POST "$URL/eval" \
  -H 'Content-Type: application/json' \
  -d "{\"session\":\"$SID\",\"expression\":\"!!(window.__trekoCommander && window.__trekoCommander.isActive && window.__trekoCommander.isActive())\"}" 2>/dev/null \
  | python3 -c 'import sys,json
try: print("true" if json.load(sys.stdin).get("result") else "false")
except Exception: print("false")' 2>/dev/null)
[ "$CMDR" = "true" ] || exit 0   # not actively pointing -> no hang, stop normally

# 3) Bounded live-catch loop (for). Polling is in-shell -> empty waits cost no tokens.
for _i in $(seq 1 "$LOOP_MAX"); do
  sleep "$LOOP_SLEEP"
  poll_and_maybe_deliver && exit 0
done
exit 0   # window elapsed with nothing new -> let the turn stop (idle)
