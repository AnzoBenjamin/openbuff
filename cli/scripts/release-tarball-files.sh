#!/usr/bin/env bash
# Print the release tarball entries, one per line, relative to the bin dir.
# Shared by every "Create tarball" step in .github/workflows/cli-release-build.yml
# so the release list and local verification use the same code.
#
# Usage: release-tarball-files.sh <bin-dir> <binary-file> [--legacy-macos]
#
# Entries: the binary, every tree-sitter*.wasm, tree-sitter-manifest.json,
# every tree-sitter-queries/*.scm (N09: without them the index has no symbols,
# calls or imports), plus libopentui.dylib and rg on the legacy macOS lane.
# Fails when any required asset is missing.
set -euo pipefail

BIN_DIR="${1:?bin dir required}"
BINARY_FILE="${2:?binary file required}"
LEGACY_MACOS="${3:-}"

cd "$BIN_DIR"

fail() {
  echo "release-tarball-files: $*" >&2
  exit 1
}

[[ -f "$BINARY_FILE" ]] || fail "missing binary $BINARY_FILE"
echo "$BINARY_FILE"

shopt -s nullglob
wasm=(tree-sitter*.wasm)
((${#wasm[@]} > 0)) || fail "no tree-sitter*.wasm in $BIN_DIR"
printf '%s\n' "${wasm[@]}"

[[ -f tree-sitter-manifest.json ]] || fail "missing tree-sitter-manifest.json"
echo tree-sitter-manifest.json

queries=(tree-sitter-queries/*.scm)
((${#queries[@]} > 0)) || fail "no tree-sitter-queries/*.scm in $BIN_DIR"
printf '%s\n' "${queries[@]}"

if [[ "$LEGACY_MACOS" == "--legacy-macos" ]]; then
  for extra in libopentui.dylib rg; do
    [[ -f "$extra" ]] || fail "missing $extra"
    echo "$extra"
  done
fi
