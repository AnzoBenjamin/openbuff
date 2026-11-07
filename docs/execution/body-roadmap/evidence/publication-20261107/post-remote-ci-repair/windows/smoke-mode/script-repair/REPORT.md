# Corrected smoke placeholder probe

Root separately authorized the smallest smoke script text repair after the
mode-only supplement exposed the existing exec-placeholder failure. Only
`rust/scripts/smoke-test-sidecar.sh` changed. It now probes `daemon`, which is
still explicitly unimplemented, for exit 2 and the structured not_implemented
category. Version and unknown-role controls remain intact. The nearby comment
explains that exec now requires the implemented JSON-RPC initialize handshake;
no exec payload execution was added. Mode remains 0755.

The original mode-only script, its failed exec/direct-smoke controls and every
preceding seal remain unchanged as history. New source SHA:
4e14f7277fff234942723c0c22399b8f66bf24b098c1797d6eb3341524f0ee81.
Workflow SHA remains
0b971a487ab44dd0df8e2080d7ab6ab8bfd4f248918655fa9f9803e2f76095f3.
Rust runtime source, manifests, lockfile and toolchain inputs remain identical
to the successful pinned 1.87.0 offline/locked host build. The binary hash
4ca44c15aa884cd4f936d9ddd35ecbd89d24fd99df9be5b8481dc06a3ccaaacd
also matches that receipt. No cargo build or test was repeated.

Actual Linux checks pass: bash syntax exits 0; daemon exits 2 with exact parsed
JSON `{"ok":false,"role":"daemon","error":"not_implemented"}`; direct
execution of the corrected script exits 0 and reports version, unknown-role,
placeholder and overall smoke success. Every command records stable original
source maps, exact argv/cwd, replacement environment, /dev/null stdin and
stdout/stderr logs. The host source/build evidence is explicitly bound.

The first whitespace command used cwd rust with a repository-relative
`rust/scripts/...` path, so that successful exit was mis-scoped and receives
no whitespace credit. Its original runner/receipt/map/log are preserved.
`git-diff-check-corrected.json` runs from the repository root with the actual
modified path and passes; no product check was substituted or overwritten.

B04 already confirmed this script has no active accepted/inventory binding.
No shared typecheck rerun, Rust runtime/workflow change, staging, commit, push
or acceptance/ledger promotion was performed. This is local Linux ordinary
CLI/placeholder assurance only: real GitHub target execution remains required,
and no Windows/Darwin or downstream native acceptance is claimed. B04 owns
the separate final supplemental review; root owns publication.
