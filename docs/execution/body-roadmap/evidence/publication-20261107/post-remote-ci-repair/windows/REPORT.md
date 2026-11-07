# Rust workflow Windows checkout and matrix condition repair

Changed only `.github/workflows/rust-workspace.yml`. Before mutation, B04's
frozen-validator digest observation found zero active file-binding calls, zero
accepted source-contract memberships and no frozen required-inventory entry
for this workflow. The exact independent scope report is retained at
`../independent-scope/active-bindings.json` (SHA
fa4f302c36614a3778fd97a3b5509806541f5141b7907e71c01fe9aaac71f16f).

GitHub run 42317166029's raw Windows checkout log records twelve `Filename too
long` errors for repository evidence paths. Its unmodified copy and the full
workflow before-image are retained here. No frozen evidence path was renamed,
removed or rewritten to work around checkout.

The Windows matrix leg now runs `git config --global core.longpaths true`
before actions/checkout. `if: runner.os == 'Windows'` scopes the step to that
runner. Its explicit `working-directory: ${{ runner.temp }}` overrides the
job's `rust` default because checkout has not created the workspace yet.

The matrix declares boolean runs-tests/runs-smoke flags. Cargo test and smoke
steps now use those boolean values directly, replacing string-'true'
comparisons that skipped the selected target steps. Tests select linux-gnu,
Windows MSVC and Intel Darwin; smoke selects linux-gnu and Intel Darwin. The
two cross-target legs remain unselected for execution.

Pinned Bun 1.3.5 parses both YAML versions. Bounded controls verify Windows
condition, order, pre-checkout working directory, flag types and selected legs.
Reversing exactly the preparation step and two conditions reproduces the
entire original parsed workflow: five-target roster, host build/test job,
toolchains, cross-linkers, build commands and upload behavior are unchanged.
Scoped git diff whitespace verification also passes. Original command argv,
replacement environments, source-before/after hashes and logs are recorded.

Final workflow SHA:
0b971a487ab44dd0df8e2080d7ab6ab8bfd4f248918655fa9f9803e2f76095f3.

These checks run on Linux and prove YAML/condition/order structure only. They
do not execute Windows checkout, Rust targets, cargo tests or smoke commands.
The real GitHub rerun must verify checkout and the newly enabled test/smoke
steps. No rust source, other workflow, staging, commit, push or ledger edit was
performed by this repair owner.
