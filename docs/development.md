# Development Guide

As a Bring Your Own Key (BYOK), local-first fork, developing Openbuff is highly streamlined. Since there is no required hosted backend or remote credit system, most development tasks center around the CLI and SDK running locally on your machine with your own configured LLM keys.

## Getting Started (CLI & SDK Development)

New to Openbuff? See [Getting Started](./getting-started.md) for end-user CLI setup (install and provider configuration). This guide covers contributing and development setup.

To develop the CLI locally, you do not need to run a web server or database. Simply configure your local providers and run the CLI developer task directly:

1. **Install Dependencies:**

   ```bash
   bun install
   ```

2. **Configure Your API Keys:**
   Set up your preferred OpenAI-compatible or Anthropic-compatible provider keys in your shell:

   ```bash
   export OPENAI_API_KEY="your-api-key"
   # Or for Anthropic/Claude and other providers:
   # export ANTHROPIC_API_KEY="your-key"
   # export OPENROUTER_API_KEY="your-key"
   ```

3. **Start the CLI in Development Mode:**
   ```bash
   bun start-cli
   ```
   This will boot the terminal UI (TUI) client in your current terminal session, pointing to the local monorepo source.

## Optional Local Integration Services

Openbuff no longer requires a hosted web app, billing system, or BigQuery pipeline for CLI/SDK development. The remaining service helpers are only for local integration dependencies that retained packages may need during development.

1. **Start Services:**

   ```bash
   bun up
   ```

2. **Check Status / Stop Services:**

   ```bash
   bun ps    # Check running services
   bun down  # Stop local services
   ```

3. **Logs:**
   Log outputs are written to `debug/console/`.

## Package Management

- Always use `bun` for package management: `bun install`, `bun add <pkg>`, `bun run ...` (avoid `npm` or `yarn` inside the workspace to keep lockfiles consistent).

## Running Tests

To run the local test suite:

```bash
cd cli
bun test
```

For comprehensive E2E terminal testing (which requires `tmux`):

- See [`cli/src/__tests__/README.md`](../cli/src/__tests__/README.md) for detailed instructions on E2E test runs.

## CI-local / pre-push checks

Before opening a PR or pushing, run the early GitHub CI gates locally:

```bash
bun run check:ci-local
```

This regenerates tool definitions (and fails if the tracked generated files drift from git HEAD — staged changes included), then runs `guard:memory-drift` and `guard:sync-agent-config`. Regenerating may mutate the working tree when schemas drift — review and commit those files if needed. It also runs the full `agents` and `common` test suites, so runtime-only regressions (such as TDZ errors that typecheck miss) are caught before you push.

### Dependency provenance

Every declared third-party dependency is reconciled against a checked-in record of its upstream identity — both exact pins (a version starting with a digit) and caret/tilde/`>=`/`*` ranges, whose release is read back from `bun.lock`:

```bash
bun --cwd=scripts run guard:dependency-provenance
```

The guard asserts, for each reconciled release, that the release has a record entry, that `bun.lock` has an entry for it, that the `sha512` recorded in `bun.lock` equals the integrity in the record, that the record names the canonical registry tarball, that the record's `source` is the origin those tarball URLs are derived from (`REGISTRY_ORIGIN`), and that the recorded upstream license is on the explicit Apache-2.0-compatible SPDX allowlist (`LICENSE_ALLOWLIST`). `UNKNOWN` — what a refresh records when the registry publishes no license — and any non-allowlisted identifier (copyleft, source-available, compound expressions) fail the gate, so review the license before adding such a dependency. A release whose upstream `license` field is not a bare SPDX identifier can only pass through an explicit `LICENSE_EXEMPTIONS` entry keyed by `name@version` with its justification inline, so the decision is visible in the diff and a version bump re-opens the review instead of inheriting the approval. The recorded-origin assertion is what keeps the record and the lockfile from being reconciled as if they came from the public registry when both were produced by a mirror: `--refresh` refuses to run when `npm_config_registry` names an origin other than `REGISTRY_ORIGIN`. It also fails when a record entry outlives the dependency that motivated it, and when a declared range has no `bun.lock` resolution at all. Exact pins remain the fail-closed default; the lockfile-resolved half is what covers the highest-risk runtime dependencies (`@modelcontextprotocol/sdk`, `ai`, `ws`, `micromatch`, `gray-matter`) and separate resolutions of one package (root `ignore@6.0.2` alongside the sdk's exact `ignore@7.0.5`), each of which is recorded and reconciled individually. The check reads only files in the repository — `package.json` manifests, `bun.lock`, and `scripts/dependency-provenance.json` — so it needs no network access and behaves identically in CI, in `check:ci-local`, and behind the pre-push hook.

**What the offline check proves — and does not prove.** Both inputs are written by this repository's own workflow (`bun install` writes `bun.lock`; `--refresh` writes the record from the registry). The offline gate therefore proves that the record AGREES with the lockfile, not that either one matches upstream: a compromised or misconfigured registry mirror, or a refresh against a tampered lockfile, produces two files that agree. The independent anchor is the reviewed diff of `scripts/dependency-provenance.json` — CI fetches the BASE ref (the PR's base branch, or the pushed commit's parent) and diffs the record against it by name-status, so a record whose integrity changed on an already-approved dependency release fails the build instead of merging silently. The comparison needs that base ref: after CI's shallow checkout the working tree equals `HEAD`, so a plain `git diff HEAD` would always be empty and anchor nothing. One allowance: a pure ADDITION passes, because the PR that first lands the record is itself its review; once the record exists on the base branch, every modification or deletion fails the anchor. Treat such a change as a supply-chain-affecting change and review it against the registry before approving.

Deliberately **ungated** categories: `workspace:` specifiers (local packages), `file:`/`link:`/`portal:` paths, `patch:` specifiers, and git/URL specifiers. None of them names a registry release for `bun.lock` to have resolved, so they carry no upstream identity to reconcile. Internal workspace packages (`@codebuff/*`, `@openbuff/*`) are excluded for the same reason: they are not published.

When you add, bump, or remove a dependency, refresh the record from the registry:

```bash
bun run scripts/dependency-provenance-guard.ts --refresh
```

`--refresh` is the only path that touches the network, and it walks exactly the scope the offline gate reconciles (exact pins plus every range's `bun.lock`-resolved release), so a refreshed record is never narrower than what the gate demands. Review the resulting diff to `scripts/dependency-provenance.json` before committing it: it is the provenance evidence a reviewer uses to reconcile a dependency without registry access. Upstream deprecation fails the gate unless the release is listed in `DEPRECATION_EXCEPTIONS` with its justification inline.

### Type declaration co-declaration

Every runtime dependency of every workspace member must have its typings declared **in that same manifest** — the runtime package itself in `dependencies`, and `@types/<name>` in `devDependencies`:

```bash
bun --cwd=scripts run guard:types-declaration
```

The guard reads only workspace `package.json` files, so it is offline and deterministic like the provenance gate. It is manifest-driven and fail-closed: a runtime dependency with no typings declared in its own manifest is a violation, never a note, so a dropped `@types` sibling cannot pass green for any package. Where npm's `@types` convention does not apply (`bun`, whose module is published by `@types/bun`/`bun-types`), the package is recorded in `NO_TYPES_PACKAGE` in `scripts/types-declaration-guard.ts` with the package that supplies its declarations; those exemptions are printed on every run so they stay reviewable. The reason for the check is that `bun install` cannot catch a dropped `@types` sibling: the package keeps typechecking only while some other member happens to pull those typings in, and a pruned or isolated install (or a published declaration output) resolves none. Declaring typings in the member that owns the dependency — not relying on the workspace-root hoist — is what keeps that true.

#### Publishable packages

A package with `"private": false` (currently `@openbuff/sdk`) has a second contract: its `dependencies` block is the install graph consumers actually get. Every EXTERNAL package its shipped code imports must be declared there — `sdk/scripts/build.ts` reads that list to mark the bundle's externals, so an imported-but-undeclared package would ship a broken install graph. Workspace-internal `@codebuff/*` imports are intentionally NOT declared: only non-`@codebuff` dependencies are marked external, so those modules are bundled into `dist/` and never resolved from a consumer's `node_modules`. `sdk/package.json` records this in its `//dependencies` note. Typings the published declaration output references (e.g. `@types/lodash`) stay in that same manifest's `devDependencies`, not the root hoist — the `//devDependencies` note there records why.

Each step can be capped with `OPENBUFF_CI_LOCAL_STEP_TIMEOUT_MS` (milliseconds; unset or `0` disables the timeout) so a hung suite cannot block a pre-push hook forever. A clean Ctrl-C releases the lock automatically. After a crash, the stale `.openbuff/ci-local.lock` records the holder PID — verify with `ps -p <pid>` that nothing is still running, then delete the file. `.openbuff/` carries its own `.gitignore`, so lock files never show up in `git status`.

Optionally install a local pre-push hook (not committed; lives under `.git/hooks/`):

```bash
bun run install:pre-push
# overwrite a non-managed existing hook:
bun run install:pre-push -- --force
```

## Tree-sitter release assets

The compiled CLI and published SDK ship `tree-sitter.wasm`, every language
grammar declared by `packages/code-map/src/wasm-files.ts`, and a
`tree-sitter-manifest.json` containing SHA-256 hashes. Release wrappers verify
that manifest on startup and redownload the current release if an installed
asset is missing or corrupted. Compiled binaries also have a checksum-pinned
legacy-wrapper repair path for installations whose older npm wrapper preserved
the parser runtime but discarded language grammars.

When adding a language, update the canonical WASM manifest, provide a compatible
tag query, add a checksum-pinned repair source when neither dependency publishes
the grammar, and keep `all-language-wasm.test.ts` plus
`grammar-wasm-repair.test.ts` green. Builds fail when an advertised grammar
cannot be packaged or checksum-verified; missing grammars must not be treated as
optional.

## CLI Command References

Use the `openbuff` namespace for new commands and help text. Do not reintroduce `codebuff` command parsers.
