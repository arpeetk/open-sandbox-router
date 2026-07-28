#!/usr/bin/env bash
# Real end-to-end test of the `osr` CLI in --local mode against LIVE Modal and Vercel.
# Every command below spawns the actual built binary (packages/cli/bin/osr.mjs) as a
# subprocess — this is not a library-level test, it's exactly what a user typing `osr`
# at a terminal would experience.
#
# Requires: `pnpm cli:install` already run, and credentials available via .env.local
# (OSR_MODAL_REAL=1 / OSR_VERCEL_REAL=1 + the usual BYOK vars — see .env.example) or via
# ~/.modal.toml for Modal. Every sandbox this script creates is destroyed before exit,
# including on failure (`trap ... EXIT`).
#
# Usage: ./examples/cli-e2e-live.sh

set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0
FAIL=0
CREATED_IDS=()

green() { printf '\033[32m%s\033[0m\n' "$1"; }
red()   { printf '\033[31m%s\033[0m\n' "$1"; }

check() {
  local desc="$1" pattern="$2" output="$3"
  if echo "$output" | grep -qE "$pattern"; then
    green "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    red "  FAIL: $desc"
    red "    expected to match: $pattern"
    red "    got: $(echo "$output" | head -3)"
    FAIL=$((FAIL + 1))
  fi
}

cleanup() {
  echo
  echo "--- cleanup: destroying every sandbox this run created ---"
  for id in "${CREATED_IDS[@]:-}"; do
    [ -n "$id" ] && osr --local rm "$id" >/dev/null 2>&1 && echo "  destroyed $id"
  done
}
trap cleanup EXIT

echo "=== osr --local providers: modal + vercel must be live (no [SIMULATED] tag) ==="
OUT=$(osr --local providers)
echo "$OUT"
if echo "$OUT" | grep "^modal" | grep -q SIMULATED; then red "  FAIL: modal is still simulated — check OSR_MODAL_REAL/credentials"; FAIL=$((FAIL+1)); else green "  PASS: modal is live"; PASS=$((PASS+1)); fi
if echo "$OUT" | grep "^vercel" | grep -q SIMULATED; then red "  FAIL: vercel is still simulated — check OSR_VERCEL_REAL/credentials"; FAIL=$((FAIL+1)); else green "  PASS: vercel is live"; PASS=$((PASS+1)); fi

echo
echo "=== osr --local plan: routing decision, no provisioning ==="
OUT=$(osr --local plan --require filesystem --strategy cost)
check "plan returns candidates" '"candidates"' "$OUT"

# ---------------------------------------------------------------------------
echo
echo "############ MODAL ############"

echo "--- create (pin:modal) ---"
OUT=$(osr --local create --template python-3.12 --require filesystem --strategy pin:modal)
echo "$OUT"
check "created on modal, not simulated" 'created sbx_.* on modal \(caps' "$OUT"
MID=$(echo "$OUT" | grep -oE 'sbx_[a-z0-9]+' | head -1)
CREATED_IDS+=("$MID")

echo "--- exec with a --flag (needs -- so it isn't parsed as an osr flag) ---"
OUT=$(osr --local exec "$MID" -- python --version)
echo "$OUT"
check "python version printed" 'Python 3' "$OUT"

echo "--- exec with a real --flag (needs --) ---"
OUT=$(osr --local exec "$MID" -- python -c "print(21*2)")
echo "$OUT"
check "computed 42" '^42$' "$OUT"

echo "--- pause (Modal has no pause primitive -> CapabilityUnsupported) ---"
OUT=$(osr --local pause "$MID" 2>&1)
echo "$OUT"
check "pause correctly unsupported on modal" 'CapabilityUnsupported|does not support pause' "$OUT"

echo "--- snapshot ---"
OUT=$(osr --local snapshot "$MID")
echo "$OUT"
check "snapshot ref printed" '^modal:' "$OUT"
SNAP=$(echo "$OUT" | head -1)

echo "--- restore from snapshot (into a NEW sandbox) ---"
OUT=$(osr --local create --from-snapshot "$SNAP" --require filesystem)
echo "$OUT"
check "restored on modal" 'created sbx_.* on modal' "$OUT"
RESTORED_MID=$(echo "$OUT" | grep -oE 'sbx_[a-z0-9]+' | head -1)
CREATED_IDS+=("$RESTORED_MID")
if [ "$RESTORED_MID" = "$MID" ]; then red "  FAIL: restore returned the SAME sandbox id"; FAIL=$((FAIL+1)); else green "  PASS: restore created a genuinely new sandbox"; PASS=$((PASS+1)); fi

echo "--- named get-or-create (Modal: fromName fallback) ---"
OUT1=$(osr --local create --name osr-e2e-modal --template python-3.12 --require filesystem --strategy pin:modal)
ID1=$(echo "$OUT1" | grep -oE 'sbx_[a-z0-9]+' | head -1)
CREATED_IDS+=("$ID1")
OUT2=$(osr --local create --name osr-e2e-modal --template python-3.12 --require filesystem --strategy pin:modal)
ID2=$(echo "$OUT2" | grep -oE 'sbx_[a-z0-9]+' | head -1)
if [ "$ID1" = "$ID2" ]; then green "  PASS: named create reused the same sandbox ($ID1)"; PASS=$((PASS+1)); else red "  FAIL: named create returned different ids ($ID1 vs $ID2)"; FAIL=$((FAIL+1)); fi

echo "--- rm ---"
OUT=$(osr --local rm "$MID")
check "destroyed" "destroyed $MID" "$OUT"

# ---------------------------------------------------------------------------
echo
echo "############ VERCEL ############"

echo "--- create (pin:vercel) ---"
OUT=$(osr --local create --template node-20 --require filesystem --strategy pin:vercel)
echo "$OUT"
check "created on vercel, not simulated" 'created sbx_.* on vercel \(caps' "$OUT"
VID=$(echo "$OUT" | grep -oE 'sbx_[a-z0-9]+' | head -1)
CREATED_IDS+=("$VID")

echo "--- exec with a --flag (needs -- so it isn't parsed as an osr flag) ---"
OUT=$(osr --local exec "$VID" -- node --version)
echo "$OUT"
check "node version printed" 'v[0-9]+\.' "$OUT"

echo "--- pause (Vercel supports it) ---"
OUT=$(osr --local pause "$VID")
echo "$OUT"
check "paused" 'status: paused' "$OUT"

echo "--- resume ---"
OUT=$(osr --local resume "$VID")
echo "$OUT"
check "resumed" 'status: running' "$OUT"

echo "--- snapshot ---"
OUT=$(osr --local snapshot "$VID")
echo "$OUT"
check "snapshot ref printed" '^vercel:' "$OUT"
SNAP=$(echo "$OUT" | head -1)

echo "--- restore from snapshot (into a NEW sandbox) ---"
OUT=$(osr --local create --from-snapshot "$SNAP" --require filesystem)
echo "$OUT"
check "restored on vercel" 'created sbx_.* on vercel' "$OUT"
RESTORED_VID=$(echo "$OUT" | grep -oE 'sbx_[a-z0-9]+' | head -1)
CREATED_IDS+=("$RESTORED_VID")
if [ "$RESTORED_VID" = "$VID" ]; then red "  FAIL: restore returned the SAME sandbox id"; FAIL=$((FAIL+1)); else green "  PASS: restore created a genuinely new sandbox"; PASS=$((PASS+1)); fi

echo "--- named get-or-create (Vercel: getOrCreate) ---"
OUT1=$(osr --local create --name osr-e2e-vercel --template node-20 --require filesystem --strategy pin:vercel)
ID1=$(echo "$OUT1" | grep -oE 'sbx_[a-z0-9]+' | head -1)
CREATED_IDS+=("$ID1")
OUT2=$(osr --local create --name osr-e2e-vercel --template node-20 --require filesystem --strategy pin:vercel)
ID2=$(echo "$OUT2" | grep -oE 'sbx_[a-z0-9]+' | head -1)
if [ "$ID1" = "$ID2" ]; then green "  PASS: named create reused the same sandbox ($ID1)"; PASS=$((PASS+1)); else red "  FAIL: named create returned different ids ($ID1 vs $ID2)"; FAIL=$((FAIL+1)); fi

echo "--- ls shows both live sandboxes, no [SIMULATED] tag ---"
OUT=$(osr --local ls)
echo "$OUT"
if echo "$OUT" | grep -E "$VID|$ID1" | grep -q SIMULATED; then
  red "  FAIL: a real vercel sandbox is incorrectly tagged [SIMULATED]"; FAIL=$((FAIL+1))
else
  green "  PASS: real sandboxes are not tagged [SIMULATED]"; PASS=$((PASS+1))
fi

echo "--- rm ---"
OUT=$(osr --local rm "$VID")
check "destroyed" "destroyed $VID" "$OUT"

echo
echo "================================================================"
echo "  RESULTS: $PASS passed, $FAIL failed"
echo "================================================================"
[ "$FAIL" -eq 0 ]
