# Lessons — polyglot-roadmap-v2

## dependency-manager `bun --filter` failure — root cause + verified workaround (2026-09-27)

Verified on bun 1.3.14 (non-mutating repro commands against this repo):

- **`bun add --filter` does not exist on 1.3.x.** `add/remove/update --filter` shipped in bun 1.4.0 (oven-sh/bun PR #38333, closing #14719/#27897/#28402). Any `bun --filter <ws> add <pkg>` shape — what the dependency-manager constructs — can never work on 1.3.x. Worse, on some 1.2/1.3 versions that shape **silently installs into the root manifest** instead of failing (#16982 bun 1.2.1, #21733 bun 1.2.19) — a hard failure is the lucky outcome.
- **The space form of the flag is broken for `run` too:** `bun --filter <name> run <script>` fails `error: No packages matched the filter` even for valid workspaces with existing scripts, while `bun --filter='<name>' run <script>` (equals form) and `bun run --filter <name> <script>` (flag after subcommand) both succeed. Bare directory-name filters (`sdk`, `common`) never match; only full package names (`@openbuff/sdk`, `@codebuff/common`) do.
- **Verified working dependency invocation from the repo root:** `bun add --cwd sdk <pkg>` — `--cwd` is documented in `bun add --help` on 1.3.14, and re-adding an existing dependency (`bun add --cwd sdk @agentclientprotocol/sdk@^1.5.0`) was idempotent: zero `sdk/package.json`/`bun.lock` drift. `cd <workspace> && bun add <pkg>` is Bun's official monorepo guidance and also works.
- **Rule for future dependency mutations in this repo:** route approved dependency changes through `bun add --cwd <workspace-dir> <pkg>` (or cd-into-workspace) via explicit user authorization; pass `--cwd <dir>` in prose prompts is useless to dependency-manager since it constructs its own command — prefer basher + explicit user approval until the tool supports a cwd-based invocation or bun is upgraded to >= 1.4. Verify idempotence with `git status --porcelain` on the manifest+lockfile.
