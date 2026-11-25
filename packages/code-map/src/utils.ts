import * as path from 'path'
import { fileURLToPath } from 'node:url'

declare const __dirname: string | undefined

/**
 * Return the directory of this module, used to resolve on-disk assets
 * (tree-sitter `.scm` queries and `.wasm` grammars) relative to the package
 * instead of the process cwd.
 *
 * The caller supplies its static `import.meta.url` for ESM. In CJS bundles,
 * the lexical `__dirname` is used directly; no dynamically-compiled function
 * or process cwd is needed.
 *
 * If no module URL is supplied, the legacy `require.resolve` fallback tries
 * the source package entry. It may be unavailable to strict ESM consumers, in
 * which case callers retain their existing cwd fallback and fail-open behavior.
 */
export function getDirnameDynamically(moduleUrl?: string): string | undefined {
  if (moduleUrl) {
    try {
      return path.dirname(fileURLToPath(moduleUrl))
    } catch {
      // Continue through the legacy runtime probes below.
    }
  }

  if (typeof __dirname === 'string') return __dirname
  // Legacy fallback for callers that do not supply a module URL.
  try {
    return path.dirname(require.resolve('@codebuff/code-map'))
  } catch {
    return undefined
  }
}
