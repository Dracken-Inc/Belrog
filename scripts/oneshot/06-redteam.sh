#!/usr/bin/env bash
# ONE-SHOT H3 — RED-TEAM: prove the test suite can actually fail.
# Green proves nothing until the suite has been seen red.
# Sabotages the STALL MATH (decision logic), never the verdict gate.
set -eu
BELROG_REPO="${BELROG_REPO:-/home/henlafon/belrog-src}"
F="$BELROG_REPO/src/services/h3OneShotWatch.js"
T="$BELROG_REPO/src/services/h3OneShot.test.mjs"
cp "$F" "$F.bak"
trap 'mv "$F.bak" "$F"; echo "--- restored ---"; git -C "$BELROG_REPO" diff --stat -- src/services/h3OneShotWatch.js | tail -1' EXIT

echo "=== SUITE GREEN (control) ==="
node --test "$T" 2>/dev/null | grep -E "^ℹ (pass|fail)"

echo
echo "=== SABOTAGE: stall detection always false ==="
python3 - "$F" <<'EOF'
import sys, re
p = sys.argv[1]
s = open(p).read()
s2 = s.replace("const stalled = !final", "const stalled = false && !final")
assert s2 != s, "sabotage pattern not found — harness broken, fix this script!"
open(p, 'w').write(s2)
EOF
node --test "$T" 2>/dev/null | grep -E "^ℹ (pass|fail)"
echo "(expect >=1 FAIL above — the stall tests MUST go red; if green, the suite is blind)"

echo
echo "=== SABOTAGE 2: resumeDecision ignores missing clips ==="
python3 - "$F" <<'EOF'
import sys
p = sys.argv[1]
s = open(p).read()
s2 = s.replace("if (progress.missing.length === 0) return { action: 'stitch-only' }",
               "if (progress.missing.length >= 0) return { action: 'none' }")
assert s2 != s, "sabotage pattern not found — harness broken!"
open(p, 'w').write(s2)
EOF
node --test "$T" 2>/dev/null | grep -E "^ℹ (pass|fail)"
echo "(expect FAIL — resume decision tests must go red)"
