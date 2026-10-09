import * as path from 'path'

/**
 * Return the directory of this module, used to resolve on-disk assets
 * (tree-sitter `.scm` queries and `.wasm` grammars) relative to the package
 * instead of the process cwd.
 *
 * Strategy 1 — why the `new Function` indirection exists: the `__dirname`
 * identifier is only referenced inside a lazily-compiled function body, never
 * lexically in this ESM module. That keeps CJS and bundled builds (where
 * `__dirname` is a real binding visible to `new Function`) working, while
 * letting the ESM sources compile without a `__dirname` binding at all.
 *
 * Strategy 2 — why the `require.resolve` fallback is needed: under Bun, code
 * compiled via `new Function` can see NEITHER `__dirname` NOR `import.meta`
 * (probing `import.meta.url` from a `new Function` body throws "import.meta
 * is only valid inside modules."), so strategy 1 returns undefined under Bun.
 * The fallback resolves the package entry via
 * `require.resolve('@codebuff/code-map')`, which works from any cwd in the
 * hoisted monorepo and in npm installs, and returns its directory (the src/
 * dir in dev/monorepo layouts). A strict-ESM Node consumer has no `require`
 * at all; that ReferenceError is swallowed and undefined is returned,
 * preserving the callers' cwd fallback and fail-open behavior.
 */
export function getDirnameDynamically(): string | undefined {
  // Strategy 1: CJS/bundled builds where `__dirname` is a real binding.
  const dirname = new Function(
    `try { return __dirname; } catch (e) { return undefined; }`,
  )()
  if (typeof dirname === 'string') {
    return dirname
  }

  // Strategy 2: Bun and other runtimes where the dynamically-compiled body
  // cannot see `__dirname` or `import.meta` — resolve the package entry.
  try {
    return path.dirname(require.resolve('@codebuff/code-map'))
  } catch {
    return undefined
  }
}
