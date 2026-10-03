#!/usr/bin/env bash
# Smoke test for the `openbuff-native` multi-call sidecar binary (SPEC D49).
#
# Charter rule 2: every matrix leg that builds a binary must also smoke-test
# it. This script only exercises the OS-independent CLI contract (exit codes
# + stdout shape), so it is safe to run against any host-runnable build of
# the binary — it never executes role payloads (P5-T1 owns those).
#
# Usage: ./smoke-test-sidecar.sh <path-to-openbuff-native-binary>
set -euo pipefail

fail() {
  echo "smoke: $1" >&2
  exit 1
}

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <path-to-openbuff-native-binary>" >&2
  exit 64
fi

BIN="$1"
if [ ! -x "$BIN" ]; then
  fail "binary not found or not executable: $BIN"
fi

# 1. `version` must exit 0 with non-empty stdout (set -e turns a nonzero
#    exit into a script failure).
VERSION_OUT="$("$BIN" version)" || fail "'version' exited nonzero"
[ -n "$VERSION_OUT" ] || fail "'version' printed empty stdout"
echo "smoke: version ok: $VERSION_OUT"

# 2. An unknown role must exit exactly 1 (usage on stderr).
set +e
"$BIN" bogus-role >/dev/null 2>&1
UNKNOWN_STATUS=$?
set -e
[ "$UNKNOWN_STATUS" -eq 1 ] \
  || fail "'bogus-role' exited $UNKNOWN_STATUS, expected 1"
echo "smoke: unknown-role exit 1 ok"

# 3. A known role must exit exactly 2 with a structured not_implemented
#    JSON line on stdout (fail-loud placeholder until P5-T1+).
set +e
ROLE_OUT="$("$BIN" exec)"
ROLE_STATUS=$?
set -e
[ "$ROLE_STATUS" -eq 2 ] \
  || fail "'exec' exited $ROLE_STATUS, expected 2"
case "$ROLE_OUT" in
  *not_implemented*) ;;
  *) fail "'exec' stdout missing not_implemented marker: $ROLE_OUT" ;;
esac
echo "smoke: not_implemented exit 2 ok"

echo "smoke: all checks passed for $BIN"
