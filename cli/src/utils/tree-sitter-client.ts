import { existsSync, mkdtempSync, statSync } from 'fs'
import { createRequire } from 'module'
import os from 'os'
import path from 'path'

import {
  addDefaultParsers,
  TreeSitterClient,
  type FiletypeParserOptions,
} from '@opentui/core'

import { logger } from './logger'

/**
 * Lazily-created shared TreeSitterClient used by the native <markdown> and
 * code renderables (Stage 2 of the OpenTUI 0.5 migration).
 *
 * API verified against the installed @opentui/core 0.5.12:
 * - node_modules/@opentui/core/lib/tree-sitter/types.d.ts:
 *   TreeSitterClientOptions = { dataPath: string; workerPath?: string | URL;
 *   initTimeout?: number }.
 * - node_modules/@opentui/core/lib/tree-sitter/client.d.ts: TreeSitterClient
 *   constructor(options, internalOptions?) plus the module-level
 *   addDefaultParsers(parsers: FiletypeParserOptions[]) where
 *   FiletypeParserOptions = { filetype, aliases?, queries: { highlights },
 *   wasm }. Per the migration plan's source audit the constructor auto-starts
 *   its worker synchronously, so the instance is memoized (no promise).
 * - workerPath is intentionally omitted: TreeSitterClient resolves the worker
 *   itself from the "@opentui/core/parser.worker" package export
 *   (node_modules/@opentui/core/parser.worker.js, verified present).
 * - addDefaultParsers is module-level and global; the `parsersRegistered`
 *   guard below keeps repeated getSharedTreeSitterClient() calls from
 *   double-registering parsers (which could stack worker-side state).
 *
 * Parser assets: only filetypes whose grammar wasm AND highlights query are
 * actually shipped inside node_modules/@opentui/core/assets are registered;
 * anything missing (e.g. python, which has no asset directory in 0.5.12) is
 * skipped instead of guessing a path. Highlight queries are OpenTUI's own
 * shipped highlights.scm files (tree-sitter capture-name style, verified on
 * disk) — our repo's packages/code-map *-tags.scm files are TAGS queries for
 * code indexing and are deliberately not fed in as highlights.
 */
interface ParserAssetDescriptor {
  filetype: string
  aliases?: readonly string[]
  wasm: string
  highlights: readonly string[]
  injections?: readonly string[]
  injectionMapping?: FiletypeParserOptions['injectionMapping']
}

// Mirrors OpenTUI's own shipped default parser descriptors
// (node_modules/@opentui/core/node-assets.js embeds
// src/lib/tree-sitter/default-parsers.ts), restricted to the filetypes we
// render inside chat code fences.
const DEFAULT_PARSER_DESCRIPTORS: readonly ParserAssetDescriptor[] = [
  {
    filetype: 'javascript',
    aliases: ['javascriptreact'],
    wasm: 'assets/javascript/tree-sitter-javascript.wasm',
    highlights: ['assets/javascript/highlights.scm'],
  },
  {
    // tsx fences resolve to the "typescriptreact" filetype (see the markdown
    // injection infoStringMap below); there is no separate tsx wasm in the
    // @opentui/core assets, so the alias covers it.
    filetype: 'typescript',
    aliases: ['typescriptreact'],
    wasm: 'assets/typescript/tree-sitter-typescript.wasm',
    highlights: ['assets/typescript/highlights.scm'],
  },
  {
    filetype: 'markdown',
    wasm: 'assets/markdown/tree-sitter-markdown.wasm',
    highlights: ['assets/markdown/highlights.scm'],
    injections: ['assets/markdown/injections.scm'],
    injectionMapping: {
      nodeTypes: {
        inline: 'markdown_inline',
        pipe_table_cell: 'markdown_inline',
      },
      infoStringMap: {
        javascript: 'javascript',
        js: 'javascript',
        jsx: 'javascriptreact',
        javascriptreact: 'javascriptreact',
        typescript: 'typescript',
        ts: 'typescript',
        tsx: 'typescriptreact',
        typescriptreact: 'typescriptreact',
        markdown: 'markdown',
        md: 'markdown',
      },
    },
  },
  {
    // The markdown injection mapping routes inline content to this filetype,
    // so registering it is what makes emphasis/links/code spans styled.
    filetype: 'markdown_inline',
    wasm: 'assets/markdown_inline/tree-sitter-markdown_inline.wasm',
    highlights: ['assets/markdown_inline/highlights.scm'],
  },
]

let sharedClient: TreeSitterClient | null = null
let clientCreationFailed = false
let parsersRegistered = false

/**
 * TEST-ONLY: reset the singleton state (shared client, cached creation
 * failure, parser-registration flag). bun's `--isolate` REUSES worker
 * processes across test files, so a suite that constructed a real client
 * (or cached a creation failure) would otherwise leak that state into a
 * later suite's assertions in the same worker. Production behavior is
 * unchanged when the seam is never called.
 */
export function resetTreeSitterClientStateForTests(): void {
  sharedClient = null
  clientCreationFailed = false
  parsersRegistered = false
}

/**
 * Resolve the @opentui/core package root so the shipped grammar wasm and
 * highlights query files can be addressed by absolute path. Throws are
 * caught by callers; nothing here runs at import time.
 */
const getCorePackageRoot = (): string | null => {
  try {
    const require = createRequire(import.meta.url)
    // require.resolve goes through the package "." export, whose entry file
    // (index.bun.js / index.node.js) lives at the package root.
    return path.dirname(require.resolve('@opentui/core'))
  } catch (error) {
    logger.warn(
      { error },
      'Could not resolve @opentui/core package root; tree-sitter highlighting disabled',
    )
    return null
  }
}

export const buildDefaultParsers = (): FiletypeParserOptions[] => {
  const coreRoot = getCorePackageRoot()
  if (!coreRoot) {
    return []
  }

  const parsers: FiletypeParserOptions[] = []
  for (const descriptor of DEFAULT_PARSER_DESCRIPTORS) {
    const wasmPath = path.join(coreRoot, descriptor.wasm)
    const highlights = descriptor.highlights.map((query) =>
      path.join(coreRoot, query),
    )
    const injections = descriptor.injections?.map((query) =>
      path.join(coreRoot, query),
    )

    // Skip filetypes whose grammar wasm or highlights query is not shipped by
    // the installed @opentui/core rather than guessing a path.
    if (
      !existsSync(wasmPath) ||
      !highlights.every(existsSync) ||
      (injections !== undefined && !injections.every(existsSync))
    ) {
      logger.debug(
        { filetype: descriptor.filetype, wasmPath },
        'Skipping tree-sitter parser: assets missing from @opentui/core',
      )
      continue
    }

    parsers.push({
      filetype: descriptor.filetype,
      ...(descriptor.aliases ? { aliases: [...descriptor.aliases] } : {}),
      queries: {
        highlights,
        ...(injections ? { injections } : {}),
      },
      wasm: wasmPath,
      ...(descriptor.injectionMapping
        ? { injectionMapping: descriptor.injectionMapping }
        : {}),
    })
  }
  return parsers
}

/**
 * SEC: the tree-sitter cache directory is PER-USER. A single shared
 * /tmp/codebuff-tree-sitter is both predictable and symlinkable: another
 * local account could pre-create it (or swap grammar/query files into it)
 * and poison the WASM loads. The per-uid suffix isolates accounts, and a
 * pre-existing directory owned by a DIFFERENT uid is never trusted — the
 * call fails closed to a private mkdtemp dir for this run.
 *
 * Grammar/query files are content-addressed by the worker, so per-user
 * isolation does not change the cache-hit path: repeat runs by the same
 * user still reuse `<dataPath>/tree-sitter/{languages,queries}`.
 */
export const getTreeSitterDataPath = (): string => {
  const perUserPath = path.join(
    os.tmpdir(),
    `codebuff-tree-sitter-${getTreeSitterCacheUserSuffix()}`,
  )
  try {
    const stat = statSync(perUserPath, { throwIfNoEntry: false })
    if (
      stat !== undefined &&
      typeof process.getuid === 'function' &&
      stat.uid !== process.getuid()
    ) {
      logger.warn(
        { perUserPath },
        'tree-sitter cache directory is owned by another user; using a private temp dir for this run',
      )
      return mkdtempSync(
        path.join(os.tmpdir(), 'codebuff-tree-sitter-untrusted-'),
      )
    }
  } catch (error) {
    logger.warn(
      { error },
      'could not inspect the tree-sitter cache directory; using a private temp dir for this run',
    )
    return mkdtempSync(
      path.join(os.tmpdir(), 'codebuff-tree-sitter-untrusted-'),
    )
  }
  return perUserPath
}

/**
 * Per-user cache suffix: the numeric uid on POSIX; a sanitized username
 * where uid is unavailable (Windows). If neither can be resolved, degrade
 * to a pid-private dir (no cross-run cache reuse, but never shared).
 */
const getTreeSitterCacheUserSuffix = (): string => {
  try {
    const info = os.userInfo()
    if (typeof info.uid === 'number' && Number.isFinite(info.uid)) {
      return `u${info.uid}`
    }
    return `n${info.username.replace(/[^A-Za-z0-9_-]/g, '_')}`
  } catch {
    return `p${process.pid}`
  }
}

/**
 * Returns the process-wide TreeSitterClient, creating (and registering the
 * default parsers for) it on first use. Returns null when creation fails so
 * callers can degrade gracefully (MarkdownOptions.treeSitterClient is
 * optional); the failure is cached so a broken environment logs once instead
 * of on every render.
 */
export const getSharedTreeSitterClient = (): TreeSitterClient | null => {
  if (clientCreationFailed) {
    return null
  }
  if (sharedClient) {
    return sharedClient
  }

  try {
    if (!parsersRegistered) {
      const parsers = buildDefaultParsers()
      if (parsers.length > 0) {
        addDefaultParsers(parsers)
      }
      parsersRegistered = true
    }
    sharedClient = new TreeSitterClient({
      dataPath: getTreeSitterDataPath(),
      initTimeout: 10_000,
    })
  } catch (error) {
    clientCreationFailed = true
    logger.error(
      error,
      'Failed to create shared TreeSitterClient; markdown code fences will render without tree-sitter highlighting',
    )
    return null
  }

  return sharedClient
}
