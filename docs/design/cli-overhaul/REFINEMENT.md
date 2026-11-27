# OpenTUI 0.8 UI refinement

The CLI now presents readable results and a quiet visual hierarchy: a compact
Openbuff wordmark and project path, neutral answer headings, sage focus and
actions, and fewer heavy frames. This refinement builds on the existing
OpenTUI upgrade and output-reader work in the workspace.

## Dependency and runtime

The registry reported **0.8.3** as the latest version of both `@opentui/core`
and `@opentui/react` on 2026-11-10. Both CLI dependencies and the installed
native package are pinned to that version. Bun **1.4.4** is the repository's
supported runtime; OpenTUI requires Bun >= 1.3.14 and React >= 19.2.

Renderer-owned syntax resources, native reading anchors, cleanup and binary
asset packaging retain the migration's compatibility fixes. The shared
parser now registers OpenTUI's dedicated TSX grammar instead of aliasing TSX
to plain TypeScript. JSX tags and attributes use the existing code palette.

## Presentation

- The launch screen uses a compact wordmark and clickable project path.
- Answer headings stay neutral. Markdown body text explicitly uses the
  theme's foreground, including the fallback; it no longer inherits white
  terminal text on light surfaces.
- The composer uses a restrained border and sage caret. Its highlighted
  character has an opaque foreground so it remains readable.
- Short collapsed tool summaries share the title row when the complete
  terminal-cell width fits. Long or multiline summaries retain wrapping.
- Agent receipts use **Review result** or **Agent result** titles and plain
  outcomes such as **Review passed**. Arrays, zero, false, null and empty
  results remain visible.
- Generic structured data uses bounded groups, readable field labels and
  numbered items. Explicit summaries/messages take priority over incidental
  version numbers. Preview limits are labeled and captured data stays in
  Inspect.
- Known MCP envelopes expose their text, structured data and named resources.
  Complete JSON objects and arrays embedded in text become readable groups;
  duplicates of structured content are omitted while distinct evidence stays
  visible. Protocol metadata and encoded media bytes stay in Inspect. Error
  and cancellation summaries remain visible.
- Saved sessions and review choices use compact, left-aligned headings and
  quiet list surfaces. Primary labels are distinct from secondary metadata.
  Review choices support pointer and keyboard activation.
- Reasoning availability and inspection share one row. Banner dismissal
  retains its width on narrow terminals; empty route lists show `0/0`.

## Native previews

These fixed local transcript scenarios use the real CLI output, Markdown and
composer components rendered by OpenTUI. PNGs preserve the captured characters
and colors on controlled light/dark backgrounds. They are component fixtures,
not a model-generated conversation or a terminal-emulator screenshot.

| Theme | 100 columns                              | 60 columns                              |
| ----- | ---------------------------------------- | --------------------------------------- |
| Dark  | [Preview](previews/native-dark-100.png)  | [Preview](previews/native-dark-60.png)  |
| Light | [Preview](previews/native-light-100.png) | [Preview](previews/native-light-60.png) |

## Validation

Use the supported runtime and repository test commands:

```sh
bun run --cwd cli test
bun run --cwd cli test:native-ui
bun run --cwd cli typecheck
bun run --cwd sdk typecheck
OPENBUFF_LOCAL_MODE=true bun cli/scripts/build-binary.ts openbuff-ui-check 1.0.0 --smoke-built-binary
```

Native fixture repairs now draw/flush a frame before asserting visible text
and derive mouse positions from rendered geometry. History-reload tests verify
that a new row stays reachable without displacing the focused prompt.

Executed on Bun 1.4.4. The broad schedules passed before the final MCP text
refinement; its affected pure/native suites and CLI typecheck were then rerun.

| Check                                                 | Result                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------- |
| Full CLI schedule, run alone                          | 4,588 pass / 154 skip / 0 fail; 275 files                     |
| Isolated development native UI                        | 159 pass / 0 skip / 0 fail; 37 files                          |
| Final MCP text projection, pure/native regressions    | 27 pass / 0 fail; 3 files                                     |
| CLI and SDK typechecks                                | Exit 0                                                        |
| Final CLI/SDK build and packaged OpenTUI native smoke | Pass                                                          |
| Final compiled help/version/answer validation         | Pass; version 1.0.0                                           |
| Native transcript previews                            | Light/dark at 100 and 60 columns; glyphs and colors inspected |
| Live tmux launch and help                             | 100×32 launch/help and 60×18 refined launch captured          |

Counts overlap and are not cumulative. Production React skips native UI cases;
the development runner executes them separately. A wall-clock text-layout
benchmark failed during a concurrent test run and passed with the full CLI
schedule running alone; its thresholds and implementation were preserved.
The compiled answer-validation worker passed outside the sandbox after its
local IPC was blocked inside it.

The light-theme regressions wait for real heading, paragraph and list text and
assert captured foreground colors, including expanded agent output. A scoped
independent review covered the output projections, menu focus, empty/failure
states, preview bounds, caret colors and narrow layouts.

The earlier overhaul's wider acceptance scope remains in [README.md](README.md)
and [HUMAN-TESTING.md](HUMAN-TESTING.md).
