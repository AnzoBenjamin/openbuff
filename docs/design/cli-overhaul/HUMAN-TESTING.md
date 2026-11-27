# Human acceptance handoff

The technical checks are executable by the coding agent. The plan's five-developer study and actual terminal/screen-reader experience require real participants. No participants, timings or screen-reader results have been invented.

## Five-developer reader study

Recruit five developers, assign anonymous IDs P1–P5, and record terminal, version, font, operating system, theme, dimensions and input method. Give each the same brief orientation: the reader supports local Find, structural locations and Back; let them discover the controls. Use 80×24, then repeat the relevant tasks at 60×18. Do not reveal the failure location before starting the timer.

From the repository root, launch the actual production reader with fixed local fixtures:

```sh
NODE_ENV=development bun \
  --preload ./cli/scripts/preload-opentui.ts \
  cli/scripts/ui-study.tsx
```

This harness mounts the production reader with synthetic captured data and makes no provider call. It measures reader tasks; it does not replace a whole-App study of setup, drafts or decisions. For the full-App follow-up, use `./cli/bin/openbuff-acceptance-check` with a disposable project/configuration and record the normal queue/provider/session tasks separately.

Give participants these tasks, starting a separate timer for each:

1. Find the first validation failure and report its error code and affected file. Find the next failure, then return from Find without accidentally closing the reader.
2. Return to the fixture menu, open the captured changes, identify all changed files and inspect a hunk in each. Return to the menu.
3. Open the captured search matches, find match 251 and report its path and source line. Resize and verify that the location remains stable.

Record completion time, wrong actions, assistance, whether task completion was correct, and confidence on a 1–5 scale. Failures/timeouts stay in the denominator. The plan's main timing gate requires at least four of five developers to correctly find the failure within 20 seconds and inspect multiple files within 30 seconds after orientation. Compare timings, errors and confidence to a recorded baseline with the same tasks and data; without baseline observations, the comparative gate remains incomplete.

The original pre-overhaul human baseline was never recorded. A linear fixture file viewed with a pager can be a separately labeled comparator; it cannot be described as the original CLI baseline. Counterbalance task/comparator order to reduce learning effects and record assistance consistently.

Create a CSV with participant, task, dimensions, elapsed seconds, correct result, errors, assistance and confidence. Enter observed values. Empty cells remain unverified; do not use zero for missing timings.

Facilitator answer key, reveal after timing: first failure E_PARSE_17 at source line 9800, file src/parser.ts; next failure E_READER_04 at line 9850. Changed files are src/parser.ts, src/reader.ts and src/app.tsx, with four hunks each. Search match 251 is src/file251.ts at source line 260.

## Actual screen-reader/terminal baseline

Have a person who uses the chosen assistive setup record its exact versions and configuration. The development environment has no configured human screen-reader baseline; installed speech utilities are not proof of usable terminal reading. Possible combinations must be tested before being advertised as supported.

For the TUI, test:

1. Identify the reader title, content availability and source without relying on color.
2. Reach the first/next failure using the keyboard, hear enough context to identify it, and return to the prior view.
3. Identify focused controls, navigate the outline and inspect a table row; verify narrow resize does not trap focus or lose content.
4. Freeze streamed output, inspect retained evidence and verify updates do not continuously interrupt reading.
5. In the full CLI, keep an unsent draft while opening/closing a reader and queue. Verify Stop, Skip and Back can be distinguished and activated intentionally.

The linear reading route can be exercised independently:

```sh
bun --preload ./cli/scripts/preload-opentui.ts cli/scripts/ui-study.tsx --plain
```

This creates labeled, control-sequence-free UTF-8 files in a temporary directory whose path the command prints using the production export helper. Open them in the user's preferred accessible text reader. Verify headings/source/availability, exact error and location, tabs/combining/CJK text and Back to the CLI. Record whether the TUI itself is usable and whether linear export supplies a usable fallback as separate results. A passing export check does not establish TUI screen-reader compatibility or WCAG conformance.

Record assistive software/terminal versions, configuration, task observations, failures and recovery in a separate results file. The coding agent can then triage and repair concrete failures from the results.
