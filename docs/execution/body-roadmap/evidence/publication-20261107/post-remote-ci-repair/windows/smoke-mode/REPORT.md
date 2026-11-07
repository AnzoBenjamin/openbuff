# Executable smoke-script supplement

Root explicitly extended the preceding workflow-only scope for the executable
bit of `rust/scripts/smoke-test-sidecar.sh`. B04 confirmed before mutation:
zero active accepted bindings, zero accepted source-contract membership and
absence from frozen inventory. The independent scope is retained at
`../../independent-review/smoke-mode-scope/scope.json`, SHA
8fdea3ce0346cbc04d27d63badf90880964cd93ce51d89aaba91655669393295.

The Git mode change is 100644 → 100755. Actual restored worktree permissions
were 0600 and are now 0755. Script bytes remain exactly 1,711 bytes with SHA
3928fef2828a7ab4434431c7fee7ccf82afba0a2d43891e3867982b88cdcb96f.
Workflow SHA remains
0b971a487ab44dd0df8e2080d7ab6ab8bfd4f248918655fa9f9803e2f76095f3.
No script source text, Rust source or workflow edit was made. No stage,
commit, push or acceptance/ledger promotion was performed. Root's staging
must record 100755; the index remains unchanged until that step.

The local binary existed. To establish current-source provenance, the runner
used the exact installed Rust 1.87.0 cargo/rustc binaries with replacement
environment, empty owned HOME, explicit offline cached Cargo home, --offline
and --locked. The host workspace build passed without dependency/toolchain
installation or source changes. Native binary SHA is
4ca44c15aa884cd4f936d9ddd35ecbd89d24fd99df9be5b8481dc06a3ccaaacd.
All declared Rust source/manifest/lock/script/workflow hashes stayed stable.

Actual bounded Linux controls:

- rustc reports 1.87.0, host x86_64-unknown-linux-gnu.
- Current-source workspace build exits 0.
- Binary version exits 0 with the nonempty protocol/crate version line.
- Unknown role exits 1 as required.
- Existing exec-placeholder expectation fails: exec exits 1, not 2, with
  `{"error":"EOF reading handshake line","ok":false}` on stdout.
- Direct executable smoke script starts successfully and passes its first two
  checks, then exits 1: `smoke: 'exec' exited 1, expected 2`.

This exposes an obsolete smoke expectation after the mode fix: current Rust
source implements Exec via exec::run, while the unchanged script still treats
it as an unimplemented role. The role's initialized workload was not invoked;
stdin was /dev/null. Root received the failure and a proposed separate change
to probe a still-unimplemented role. Script text changes remain outside this
mode-only supplement unless root separately authorizes them. Raw failing
receipts and outputs are preserved with no passing-credit substitution.

This is local Linux build/ordinary CLI evidence only. No Windows execution,
release-target smoke or downstream native acceptance is claimed. Every earlier
workflow seal remains unchanged; this supplement is separate.
