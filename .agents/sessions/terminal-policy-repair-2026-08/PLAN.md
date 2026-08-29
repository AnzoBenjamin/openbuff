# PLAN — Terminal policy repair (RF-1..RF-6)

<!-- current-task: T1 -->

Single milestone: close all six reviewer findings, re-validate, pass a fresh reviewer pass.

## Tasks

- [ ] T1 — Inventory fail-open tmux detectors
  - Role: editor (read phase) or direct read
  - Read `sdk/src/tools/terminal-command-policy.ts` fresh and list every tmux-test detector that consumes `splitReadOnlyShellSegments(command)` with `segments?.some(...) ?? false` or equivalent: `hasUnsafeTmuxFileMutation`, `hasUnsafeTmuxSedInPlace`, `hasUnsafeTmuxExecutable`, `hasUnsafeTmuxGitCommand`, `hasUnsafeTmuxWriteRedirection`, `hasActiveTmuxCompoundShellSyntax`.
  - Acceptance: complete list of `?? false`/fail-open sites confirmed against live file, not memory.
  - Validate: code-search `segments\?\.` and `?? false` in terminal-command-policy.ts.

- [ ] T2 — Make tmux-test detectors fail closed (RF-1, RF-5)
  - Depends on: T1
  - For each detector identified in T1, change the unparseable path from `?? false` to `?? true` (undefined segments ⇒ treat composition as unsafe). Do not touch detectors that genuinely don't parse segments. Keep each function's name/signature.
  - Rationale to preserve in a brief comment: `splitReadOnlyShellSegments` returns undefined on background `&`, substitution, or empty segments; bash still executes those forms, so tmux-test must deny rather than skip the guard.
  - Acceptance: `touch workspace.txt;`, `tee workspace.txt;`, `rm -rf src &`, `touch x;;echo y`, `; touch x` all denied under `tmux-test`.
  - Validate: run policy test file (T5 gate) — no new fail-closed false-positives on the existing allow cases in `blocks tmux agents from direct workspace mutation` / `normalizes tmux executable quoting`.

- [ ] T3 — Align git-commit allow with `--message` (RF-3, RF-6)
  - Depends on: T2
  - Extend the git-commit commit-allow regex from `(?=.*-m(?:\s|$))` to also accept `--message` forms: `(?=.*(?:-m|--message)(?:\s|=|$))`. Keep placeholder-message rejection and non-amend guard unchanged.
  - Acceptance: `git commit --message "Fix the parser"` allowed (with real message); `git commit --message probe` still denied as placeholder; `--message="Fix"` allowed.
  - Validate: policy tests.

- [ ] T4 — Add failing-closed test cases (RF-2, RF-4, RF-6)
  - Depends on: T2, T3
  - In `sdk/src/__tests__/terminal-command-policy.test.ts` add:
    - a tmux-test test asserting `allowed === false` for trailing `;`, `;;`, leading `;`, and background `&` around `touch`/`tee`/`rm` mutators (e.g. `tmux run-shell 'touch /tmp/x;'` shape if fixtures are wrapped, per existing test idioms — mirror the style of `blocks tmux agents from direct workspace mutation`);
    - git-commit allow cases: `git commit --message "Fix the parser"`, `git commit --message="Fix the parser"` → allowed true; placeholder via `--message` → false.
  - Acceptance: new tests fail against the pre-T2/T3 code and pass after.
  - Validate: run policy test file.

- [ ] T5 — Validate
  - Depends on: T4
  - Run `bun test sdk/src/__tests__/terminal-command-policy.test.ts` (must be all-pass) and end turn so hooks (`bun run typecheck`, `cd sdk && bun run typecheck`) run.
  - Acceptance: 0 failures; hooks green.
  - Validate: basher output + gate hooks summary.

- [ ] T6 — Fresh reviewer pass (RF-1..RF-6)
  - Depends on: T5
  - End turn; harness runs the automated reviewer against the new snapshot. If any finding re-opens, do exactly one targeted repair for that finding ID and re-validate (no broad rewrites).
  - Acceptance: GATE: PASSED; all six RF records cleared.

## Execution notes (execute mode)

- Edit through `repair-editor` with the full handoff contract (schemaVersion, taskId, role='repair-editor', objective, requirements[] one per RF ID, acceptanceCriteria[] one per RF ID, context: [], nonGoals, findings[] with files + snapshotFingerprint, permissions{readablePaths, writablePaths, allowedTools}). A previous repair-editor spawn failed validation because only a prose prompt was sent — always include the structured `handoff` object and cite finding IDs (RF-1-4391b95f, RF-2-327c10c4, RF-3-fa741f2a, RF-4-7b925458, RF-5-e9fa653a, RF-6-7a8c09df). Use the full snapshot fingerprint from the harness state at execute time (prefix `v3:7fa30d019b80a…`).
- Sequential discipline: read fresh → one repair transaction → run policy tests → end turn. No parallel reviewer during repair.
- Preserve unrelated dirty work: `scripts/measure-context-baseline.ts`, `agents/base2/*`, `docs/*`, `.agents/sessions/context-baseline-25k/` are not ours — do not stage or edit them.

## Risks / open questions

- Fail-closed `?? true` could over-deny exotic-but-safe tmux commands whose segment parse returns undefined (e.g. `tmux new-session -d && tmux ls` — currently parsed, fine; substitution forms already denied by hasActiveCommandSubstitution). Existing tmux-test allow tests will surface any regression in T5.
- RF-3 is labeled "Optional consistency" by the reviewer, but it is open-BLOCKING in the gate, so it must be resolved (align or explicit intentional-deny test).
