# Audit findings: w3-cli-remaining

- Subsystems: cli, test
- Features: slash-commands, chat-hooks, tool-renderers, path-completion, clipboard, open-file, agent-skill-registry, terminal-color-detection
- Files covered: 17
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [HIGH] correctness — cli/src/utils/clipboard.ts:174 — [POLY][LANG] Linux clipboard only tries xclip/xsel; Wayland and WSL unsupported, sync shell exec on render thread
- **Risk:** On Wayland-only desktops (GNOME/KDE default on modern Fedora/Ubuntu), xclip/xsel are often missing or cannot reach the Wayland clipboard. On WSL, process.platform is 'linux' so clip.exe is never tried. Both cases fall through to OSC 52, which many terminals (GNOME Terminal/VTE, Windows conhost) ignore, so the copy silently fails or shows a false 'Copied' message. execSync with a shell and no timeout also blocks the TUI event loop, and can hang if a clipboard tool waits on the display. Windows 'clip' reads stdin in the OEM/ANSI codepage, so non-ASCII text (CJK identifiers, accented comments) gets garbled.
- **Fix:** Best option (P7-T5): use a native clipboard binding (napi-rs arboard, which supports Wayland via wl-clipboard-rs, X11, macOS, and Windows with UTF-16) behind a lazy import. Keep the shell fallback, but order it by environment: WAYLAND_DISPLAY -> wl-copy; DISPLAY -> xclip/xsel; WSL (WSL_DISTRO_NAME or /proc/version contains microsoft) -> clip.exe, or powershell Set-Clipboard for UTF-8. Use async execFile (no shell) with a timeout. Add a matrix test that mocks the env detection.
- **Evidence:** clipboard.ts:174-181 has platform === 'linux' try execSync('xclip -selection clipboard') catch execSync('xsel --clipboard --input'). Line 183 has execSync('clip'). There is no WAYLAND_DISPLAY/WSL check and no timeout in opts (lines 166-169). copyTextToClipboard is async but only calls sync helpers (lines 102-117).

## [MEDIUM] security — cli/src/utils/open-file.ts:47 — [POLY][BEST] Editor launch substitutes an unescaped path into shell:true; terminal editors ($EDITOR=nvim/vim/emacs -nw) are spawned detached with no TTY
- **Risk:** replaceFilePlaceholder puts rawPath (not shellPath) into %f/{file}, and the command runs with spawn(shell:true). Paths with spaces, quotes, $() or ; break the command or run arbitrary shell. Agent source paths and validation-error paths come from repo content. Most users of vim, nvim, helix, emacs, or nano set EDITOR/VISUAL. Those are spawned detached with stdio 'ignore' while OpenTUI owns the terminal, so they either fail, fight the TUI for the tty, or never emit 'close', which hangs the await loop. There are also no JetBrains (idea/pycharm/goland via TERMINAL_EMULATOR=JetBrains-JediTerm) or line-number conventions, and GUI candidates only run when TERM_PROGRAM matches.
- **Fix:** Tokenize the editor value (shell-quote parse) and spawn argv without a shell, passing the path as its own argv element. Classify terminal editors (vi/vim/nvim/hx/nano/emacs without a GUI flag/micro/kak). For those, suspend the renderer, run with stdio 'inherit', then resume, or open in a new tmux/wezterm pane. Add JetBrains detection and a +line/--goto file:line mapping per editor. Add a timeout so a missing 'close' cannot hang the loop.
- **Evidence:** open-file.ts:17-25 replaceFilePlaceholder(command, filePath) uses the raw path. Line 47 calls replaceFilePlaceholder(value, rawPath). Lines 103-108 spawn(command, { shell: true, stdio: 'ignore', detached: true }). Lines 56-83 list only code/cursor/zed/subl/atom, gated on TERM_PROGRAM/env detection.

## [MEDIUM] correctness — cli/src/commands/image.ts:13 — [POLY] /image splits args on whitespace, so paths with spaces cannot be attached
- **Risk:** macOS screenshots are named 'Screenshot YYYY-MM-DD at HH.MM.SS.png', and Windows user dirs often contain spaces ('C:\Users\Jane Doe\...'). /image with such a path attaches only the first token and sends the rest as the prompt text. Drag-and-drop into many terminals produces quoted or backslash-escaped paths, which are not unquoted either.
- **Fix:** Parse the first argument with shell-like quoting (quotes and backslash-escaped spaces). Otherwise, find the longest prefix of the args that exists on disk and has an image extension. Add tests for quoted, escaped, and Windows paths.
- **Evidence:** image.ts:13 const [imagePath, ...rest] = args.trim().split(/\s+/); line 19 return rest.join(' ').

## [MEDIUM] correctness — cli/src/hooks/use-path-tab-completion.ts:39 — [POLY] Path tab completion hardcodes '/' so Windows absolute paths and separators break
- **Risk:** Absolute-path detection only checks startsWith('/') or '~', so 'C:\' and 'D:/' go down the relative branch and get joined onto currentPath. getPathCompletion appends path.sep ('\' on Windows), but the hook checks completed.endsWith('/'), so on Windows directory navigation never triggers. The ~-to-home conversion also mixes separators. The project picker is a first-run surface for every Windows user.
- **Fix:** Use path.isAbsolute() (plus a win32 drive-letter regex), compare against path.sep or /[\\/]$/, and accept both separators in input on win32. Add win32 cases using path.win32 injection in use-path-tab-completion.test.ts.
- **Evidence:** use-path-tab-completion.ts:39 searchQuery.startsWith('/') || searchQuery.startsWith('~'); lines 44 and 64 check completed.endsWith('/'). path-completion.ts:32 checks expandedPath.endsWith(path.sep) and line 73 appends path.sep.

## [LOW] performance — cli/src/utils/path-completion.ts:51 — [BEST] Sync readdirSync plus a statSync per entry on every Tab keypress
- **Risk:** In large directories (node_modules, target/, .venv, vendor/, Pods, build/) every Tab blocks the render thread with N stat syscalls, which is especially slow on network or WSL /mnt/c filesystems.
- **Fix:** Use readdirSync(parentDir, { withFileTypes: true }) and Dirent.isDirectory() (stat only symlinks). Filter by prefix before any stat. Consider an async variant with a cap on entries.
- **Evidence:** path-completion.ts:51-63: items = readdirSync(parentDir); for each item: statSync(fullPath).isDirectory().

## [LOW] correctness — cli/src/hooks/use-suggestion-engine.ts:413 — [POLY][BEST] @-mention file ranking is purely lexical and length-based, with no manifest/entrypoint or recency signal
- **Risk:** Ranking uses prefix/substring/fuzzy plus 2x path length. In deep polyglot trees (Java src/main/java/com/..., Go internal/, Rust crates/*/src) the right file loses to shallow noise. Ranking has no git-tracked or recently-edited boost, and no special handling for ecosystem manifests (Cargo.toml, go.mod, pyproject.toml, pom.xml). Whether build dirs (target/, dist/, .venv, __pycache__) are excluded depends on the file tree source, which this shard did not verify.
- **Fix:** Add score terms for git-tracked/recently-modified files (from the existing git status) and for basename exact-match. Add a small light penalty for known generated dirs across ecosystems. Add ranking fixtures for non-JS trees to use-suggestion-engine tests.
- **Evidence:** use-suggestion-engine.ts:383-411 prefix(-1000)/filename(-500)/substring(-100)/fuzzy tiers; 416 lengthPenalty = filePath.length * 2; 442 sort by score only. Lines 294-297 getFileName splits on '/' only.

## [LOW] security — cli/src/utils/skill-registry.ts:29 — [BEST] Trust defaults differ: project skills default trusted, project agents default untrusted
- **Risk:** initializeSkillRegistry defaults trustProjectSkills to true, while initializeAgentRegistry defaults trustProjectAgents to false. The current index.tsx callers pass the flag explicitly, but any new caller (headless P1-T5, attach P1-T3) that omits it would load untrusted repo skills into prompts. Test resets also set agents trusted=true, the opposite of the production default.
- **Fix:** Default trustProjectSkills to false to match agents, or make the option required. Make __reset* restore the production default.
- **Evidence:** skill-registry.ts:13 projectSkillsTrusted = true and line 29 options?.trustProjectSkills ?? true. local-agent-registry.ts:44 projectAgentsTrusted = false, line 64 ?? false, and line 437 reset sets true. index.tsx:346-350 passes the flags explicitly.

## [LOW] correctness — cli/src/utils/git.ts:8 — [POLY] Diff stats and root detection are git-only; jj/hg/sapling users get no change indicator
- **Risk:** findGitRoot looks only for .git. Mercurial, Sapling, and non-colocated Jujutsu repos show no diff stats, and the /diff and /changes commands are described as git-only.
- **Fix:** Put a small VCS adapter behind getDiffStatsAsync (git, jj status, hg status -mard) detected by root markers (.jj, .hg, .sl). Otherwise, state the git-only scope clearly in the UI.
- **Evidence:** git.ts:8-21 existsSync(join(currentDir, '.git')); lines 88-98 execFile('git', ['status','--short','--porcelain']). slash-commands.ts:189-197 has diff/changes descriptions referencing git.

## [LOW] dependency-hygiene — cli/src/hooks/use-clipboard.ts:13 — [BEST] Duplicated preview formatter and needless createRequire for child_process
- **Risk:** formatDefaultClipboardMessage duplicates clipboard.ts getDefaultSuccessMessage, so the two can drift. clipboard.ts loads child_process through createRequire at call time instead of a static import, which hides the dependency from bundling and type checks.
- **Fix:** Export one formatter from clipboard.ts and reuse it. Replace createRequire with a static import (or the arboard binding per the HIGH finding).
- **Evidence:** use-clipboard.ts:13-20 and clipboard.ts:72-79 are identical. clipboard.ts:2,23 createRequire and line 164 require('child_process').

## [LOW] test-coverage — cli/src/components/tools/run-terminal-command.tsx:49 — [LANG] Terminal renderer concatenates stdout+stderr and has no structured test/lint output rendering for any ecosystem (P3-T2)
- **Risk:** stdout and stderr are joined with no separator or stream marking, and the output is shown as raw text truncated to 5 lines. Failures from cargo test, pytest, go test, and jest all show only their first lines, which are usually progress noise, not the failure summary. This is language-neutral, but not the best possible for P3-T2.
- **Fix:** Keep the streams separate (or interleave them with markers). Add pluggable summarizers keyed on the command prefix (cargo/go/pytest/mvn/gradle/dotnet/jest/vitest) that pull out the pass/fail counts and first failure. Show the tail rather than the head when the command fails.
- **Evidence:** run-terminal-command.tsx:49-51 output = (stdout + stderr).trimEnd(); line 134 maxVisibleLines={5}.

## Coverage receipt

### Subsystems
- cli
- test

### Features
- slash-commands
- chat-hooks
- tool-renderers
- path-completion
- clipboard
- open-file
- agent-skill-registry
- terminal-color-detection

### Files
- cli/src/utils/git.ts
- cli/src/utils/image-processor.ts
- cli/src/utils/clipboard.ts
- cli/src/utils/open-file.ts
- cli/src/utils/terminal-color-detection.ts
- cli/src/utils/skill-registry.ts
- cli/src/utils/local-agent-registry.ts
- cli/src/utils/path-completion.ts
- cli/src/data/slash-commands.ts
- test/setup-scm-loader.ts
- cli/src/commands/router-utils.ts
- cli/src/commands/image.ts
- cli/src/commands/context.ts
- cli/src/hooks/use-path-tab-completion.ts
- cli/src/hooks/use-clipboard.ts
- cli/src/hooks/use-suggestion-engine.ts
- cli/src/components/tools/run-terminal-command.tsx

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
