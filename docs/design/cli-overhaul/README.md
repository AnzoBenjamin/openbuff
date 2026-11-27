# CLI UI/UX overhaul

The CLI uses outcome summaries, bounded inline previews and a focused reader for retained content. The reader provides local find, logical/source locations, outlines, row details and Back while preserving the conversation and draft. Setup, questions, queues, saved sessions, diagnostics and supporting command output use the same recovery and availability rules.

[Design contract](../../../DESIGN.md) · [Plan](PLAN.md) · [Acceptance record](ACCEPTANCE.json) · [Research](RESEARCH.md) · [Wireframes](WIREFRAMES.md) · [Human testing](HUMAN-TESTING.md).

[OpenTUI 0.8 refinement](REFINEMENT.md) records the latest dependency check,
human-readable result presentation, native light/dark previews and scoped validation.

The original audit covered 19 surface groups and 200 item IDs. The acceptance record preserves all 200 IDs and 516 reviewed subclauses: 139 have executed acceptance evidence, 374 have source support, and three retain a design, human or environment gap. Source support does not certify every exact scenario. Backend code was inspected for UI-facing contracts; this was not a general backend/security audit.

## Validation snapshot

Recorded 2026-11-05 using Bun 1.3.5:

| Check                                    | Result                                                  |
| ---------------------------------------- | ------------------------------------------------------- |
| Full CLI test schedule                   | 4,419 pass / 146 skip / 0 fail; 267 files               |
| Isolated development-React native checks | 148 pass / 0 skip / 0 fail; 36 files                    |
| CLI and SDK typechecks                   | Exit 0                                                  |
| CLI/SDK build and standalone OpenTUI     | Pass                                                    |
| Compiled help/version/answer validation  | Pass                                                    |
| Actual compiled CLI PTY navigation       | 14 phases pass, including draft return and 60×18 resize |
| Fixture matrices                         | 1,530 frames across reader/recovery/output cases        |

Full/native counts overlap and are not cumulative. Production React skips native cases; `test:native-ui` executes the discovered native suites in separate development runtimes. [Reference-machine performance](PERFORMANCE.json) records the measured reader budgets and scope. Historical captures, repeated receipts, raw logs and one-off implementation scripts were removed before committing; source regressions and useful validation tools remain.

With the supported Bun 1.4.4 runtime, run from the repository root:

```sh
bun run --cwd cli test
bun run --cwd cli test:native-ui
bun run --cwd cli typecheck
```

The native runner prints a temporary directory containing its logs and summary. Run `bun run typecheck` from `sdk/` too. Build from the repository root:

```sh
OPENBUFF_LOCAL_MODE=true bun cli/scripts/build-binary.ts openbuff-overhaul-check 1.0.0 --smoke-built-binary
./cli/bin/openbuff-overhaul-check --help
./cli/bin/openbuff-overhaul-check --version
./cli/bin/openbuff-overhaul-check --smoke-answer-validation
```

## Remaining acceptance

Exact source-supported scenarios still require certification. CHAT-14 supplies inspection-only recovery of malformed saved captures; authoritative resume remains strict, so automatic resumable per-row recovery needs a design decision. Independent final source review was unavailable because of subagent quota errors. The earlier design advice supported separate inspection without treating recovered UI rows as valid SDK history; it did not approve the final implementation.

Actual Alacritty/Kitty checks were approved but could not execute because automatic approval review repeatedly failed under high demand. Human task-time comparisons and supported terminal/screen-reader experience remain unverified. The [human testing protocol](HUMAN-TESTING.md) retains fixed local fixtures and the observation requirements. No participant results or accessibility certification are claimed.
