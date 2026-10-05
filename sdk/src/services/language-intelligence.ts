import fs from 'node:fs/promises'
import path from 'node:path'

import {
  getLanguageCapability,
  getLanguageToolSpecs,
  SUPPORTED_LANGUAGE_IDS,
  type SupportedLanguageId,
} from '@codebuff/common/util/language-capabilities'

import {
  createLspMultiplexer,
  LspServerError,
  LspServerUnavailableError,
} from './lsp-multiplexer'
import { mapWithConcurrency } from '../tools/concurrency'
import { LRUCache } from '@codebuff/common/util/lru-cache'

import type { ChildProcess } from 'node:child_process'
import type { CodebuffToolOutput } from '../../../common/src/tools/list'
import type {
  LspChildHandle,
  LspLocation,
  LspMultiplexer,
  LspPosition,
} from './lsp-multiplexer'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type { JSONValue } from '@codebuff/common/types/json'

/**
 * P3-T2 (LI-01, Q2#5): language-intelligence service.
 *
 * Owns a lazily-built LSP multiplexer and converts the four read-only query
 * tools (go_to_definition / find_references / hover_type / workspace_symbol)
 * into structured results. Every failure mode that means "no language server
 * is present" degrades honestly into a typed `unavailable`/`errorMessage`
 * result rather than throwing, so the model can fall back to grep/index.
 *
 * The multiplexer is injectable so tests are hermetic (a fake multiplexer is
 * supplied and no language-server process is ever spawned).
 */

export type LanguageIntelligenceService = {
  goToDefinition(params: {
    path: string
    line: number
    character: number
  }): Promise<CodebuffToolOutput<'go_to_definition'>>
  findReferences(params: {
    path: string
    line: number
    character: number
  }): Promise<CodebuffToolOutput<'find_references'>>
  hoverType(params: {
    path: string
    line: number
    character: number
  }): Promise<CodebuffToolOutput<'hover_type'>>
  workspaceSymbol(params: {
    query: string
  }): Promise<CodebuffToolOutput<'workspace_symbol'>>
  /**
   * P3 audit fix (C): push committed file contents into any already-running
   * language server so post-edit LSP answers are not stale. Bounded (32 paths
   * per call), fail-open per path, and never throws. A no-op when the
   * service's multiplexer was never built (no language-intelligence tool ran
   * this run), so sync can never cold-start a server.
   *
   * `opts.closedPaths` (P3 audit fix): deleted paths are forwarded as a
   * didClose (syncFile close semantics) so a warm server drops its stale
   * open-document state for files that no longer exist. Same bounds and
   * fail-open-per-path contract as the sync loop; never reads the (deleted)
   * file from disk.
   */
  syncMutatedFiles(
    paths: string[],
    opts?: { closedPaths?: string[] },
  ): Promise<void>
  dispose(): Promise<void>
}

type UnavailableResult = {
  unavailable: { reason: string; languageId?: string }
}

function toUnavailable(error: LspServerUnavailableError): UnavailableResult {
  return {
    unavailable: {
      reason: error.reason,
      ...(error.languageId ? { languageId: error.languageId } : {}),
    },
  }
}

function toErrorMessage(error: LspServerError): { errorMessage: string } {
  return { errorMessage: `Language server error (${error.reason}): ${error.message}` }
}

function uriToPath(uri: string): string {
  if (uri.startsWith('file://')) {
    let rest = uri.slice('file://'.length)
    // Strip a leading slash before a drive letter (Windows: file:///C:/...).
    if (/^\/[A-Za-z]:\//.test(rest)) {
      rest = rest.slice(1)
    }
    try {
      return decodeURIComponent(rest)
    } catch {
      return rest
    }
  }
  return uri
}

function toStructuredLocation(location: LspLocation): {
  uri: string
  path: string
  range: LspLocation['range']
} {
  return { uri: location.uri, path: uriToPath(location.uri), range: location.range }
}

function toStructuredLocations(
  result: LspLocation | LspLocation[] | null,
): ReturnType<typeof toStructuredLocation>[] {
  if (result === null) return []
  const list = Array.isArray(result) ? result : [result]
  return list.map(toStructuredLocation)
}

/** Convert the human-friendly 1-based `line` to the 0-based LSP position. */
function toLspPosition(line: number, character: number): LspPosition {
  // Clamp: a 1-based caller can pass line 0 (loop boundary / off-by-one);
  // LSP rejects a negative line, so degrade to the first line instead.
  return { line: Math.max(0, line - 1), character }
}

/** Bounded work: cap files synced per syncMutatedFiles call. */
const MAX_SYNC_FILES_PER_CALL = 32

/**
 * Per-file read cap (perf: sync-mutated-files-unbounded-file-read): a single
 * large generated file committed in a mutation batch must not turn the
 * post-commit inline await into an unbounded read + LSP frame over stdio.
 * Files at or above the cap are skipped entirely — fail-open, the same
 * per-path contract as any other sync failure.
 */
export const MAX_SYNC_FILE_BYTES = 1024 * 1024

/**
 * Bounded per-path sync-version map (perf: sync-versions-map-unbounded):
 * syncMutatedFiles runs at most MAX_SYNC_FILES_PER_CALL paths per call, so 64
 * entries comfortably covers the working set of any single sync window while
 * the map itself can never exceed this bound over a long-lived session.
 */
const MAX_SYNC_VERSIONS = 64

/**
 * Bounded parallel window for the per-path disk read + LSP sync round-trip:
 * the committed-mutation path awaits syncMutatedFiles inline, so a serial
 * loop would add up to 32 sequential round-trips of latency to every
 * mutation batch that commits source files. Small enough to keep language
 * server load capped.
 */
const SYNC_CONCURRENCY = 4

/** Resolve a path to its registered language via the registry's extensions. */
function languageIdForPath(filePath: string): SupportedLanguageId | undefined {
  const extension = path.extname(filePath).toLowerCase()
  if (!extension) return undefined
  for (const id of SUPPORTED_LANGUAGE_IDS) {
    if (
      (getLanguageCapability(id).extensions as readonly string[]).includes(
        extension,
      )
    ) {
      return id
    }
  }
  return undefined
}

/** Whether the language registers a launchable language-server tool spec. */
function hasLanguageServerSpec(languageId: SupportedLanguageId): boolean {
  return getLanguageToolSpecs(languageId).some(
    (spec) => spec.role === 'languageServer',
  )
}

/**
 * Adapt a spawned node `ChildProcess` to the structural `LspChildHandle`
 * surface the multiplexer drives. Language servers communicate over stdio,
 * so a child spawned without piped stdin/stdout is a spawn failure.
 */
function toLspChildHandle(child: ChildProcess): LspChildHandle {
  const { stdin, stdout } = child
  if (!stdin || !stdout) {
    throw new LspServerError('Spawned LSP server process has no stdio pipes.', {
      reason: 'spawn-failed',
    })
  }
  return {
    pid: child.pid,
    stdin,
    stdout,
    on: (event, listener) => {
      child.on(event, listener)
    },
    kill: (signal) => {
      child.kill(signal as NodeJS.Signals)
    },
  }
}

export type LanguageIntelligenceOptions = {
  cwd: string
  /** Required to lazily build the real multiplexer; unused when `multiplexer` is injected. */
  spawn?: CodebuffSpawn
  /** Inject a pre-built multiplexer so tests stay hermetic (no server spawned). */
  multiplexer?: LspMultiplexer
}

export function createLanguageIntelligence(
  options: LanguageIntelligenceOptions,
): LanguageIntelligenceService {
  let multiplexer: LspMultiplexer | undefined = options.multiplexer
  let built = options.multiplexer !== undefined
  // Per-path monotonically increasing document versions for syncMutatedFiles,
  // keyed by absolute path, so each didOpen/didChange advances its document.
  // Bounded LRU (perf: sync-versions-map-unbounded): the previous per-run Map
  // grew without bound over a long-lived session that commits many files; the
  // LRU keeps the most-recently-synced MAX_SYNC_VERSIONS paths. Evicting a
  // path's version only means its next sync re-opens the document at version 1
  // (didOpen vs didChange) — the server still receives the current on-disk
  // bytes, so no stale content can result.
  const syncVersions = new LRUCache<string, number>(MAX_SYNC_VERSIONS)

  function getMultiplexer(): LspMultiplexer {
    if (!built) {
      const spawn = options.spawn
      if (!spawn) {
        throw new LspServerError(
          'No LSP spawner configured and no multiplexer injected.',
          { reason: 'unavailable' },
        )
      }
      multiplexer = createLspMultiplexer({
        spawner: (spec): LspChildHandle => {
          const [command, ...args] = spec.argv
          return toLspChildHandle(spawn(command, args, { cwd: spec.cwd }))
        },
      })
      built = true
    }
    if (!multiplexer) {
      // Unreachable: `built` implies `multiplexer` is set. Fail closed.
      throw new LspServerError('LSP multiplexer was not initialized.', {
        reason: 'unavailable',
      })
    }
    return multiplexer
  }

  async function runQuery<T>(
    query: (mux: LspMultiplexer) => Promise<T>,
  ): Promise<T | UnavailableResult | { errorMessage: string }> {
    try {
      return await query(getMultiplexer())
    } catch (error) {
      if (error instanceof LspServerUnavailableError) {
        return toUnavailable(error)
      }
      if (error instanceof LspServerError) {
        return toErrorMessage(error)
      }
      throw error
    }
  }

  return {
    async goToDefinition(params) {
      const result = await runQuery((mux) =>
        mux.definition({
          filePath: path.resolve(options.cwd, params.path),
          position: toLspPosition(params.line, params.character),
        }),
      )
      if (result !== null && ('unavailable' in result || 'errorMessage' in result)) {
        return [{ type: 'json', value: result }]
      }
      return [{ type: 'json', value: { locations: toStructuredLocations(result) } }]
    },

    async findReferences(params) {
      const result = await runQuery((mux) =>
        mux.references({
          filePath: path.resolve(options.cwd, params.path),
          position: toLspPosition(params.line, params.character),
        }),
      )
      if (result !== null && ('unavailable' in result || 'errorMessage' in result)) {
        return [{ type: 'json', value: result }]
      }
      return [{ type: 'json', value: { locations: toStructuredLocations(result) } }]
    },

    async hoverType(params) {
      const result = await runQuery((mux) =>
        mux.hover({
          filePath: path.resolve(options.cwd, params.path),
          position: toLspPosition(params.line, params.character),
        }),
      )
      if (result !== null && ('unavailable' in result || 'errorMessage' in result)) {
        return [{ type: 'json', value: result }]
      }
      if (result === null) {
        return [{ type: 'json', value: {} }]
      }
      const hover = result as {
        contents: unknown
        range?: {
          start: { line: number; character: number }
          end: { line: number; character: number }
        }
      }
      return [
        {
          type: 'json',
          value: {
            hover: {
              // LSP hover contents (MarkupContent / MarkedString JSON) match
              // the schema's jsonValueSchema — narrow to JSONValue, not never.
              contents: hover.contents as JSONValue,
              ...(hover.range ? { range: hover.range } : {}),
            },
          },
        },
      ]
    },

    async workspaceSymbol(params) {
      const result = await runQuery((mux) => mux.workspaceSymbol(params.query))
      if (result !== null && ('unavailable' in result || 'errorMessage' in result)) {
        return [{ type: 'json', value: result }]
      }
      const symbols = (result ?? []).map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        location: toStructuredLocation(symbol.location),
        ...(symbol.containerName ? { containerName: symbol.containerName } : {}),
      }))
      return [{ type: 'json', value: { symbols } }]
    },

    async syncMutatedFiles(paths, opts) {
      // Sync is only meaningful for an already-built multiplexer: building one
      // here would cold-start language servers just to push updates, which the
      // sync seam must never do. Paths whose extension maps to no registered
      // language, or to a language with no server spec, are skipped.
      const activeMultiplexer = built ? multiplexer : undefined
      if (!activeMultiplexer) return
      // Bounded parallelism instead of a serial per-path await: the committed
      // mutation path awaits this call inline, so a serial loop would add up
      // to 32 sequential disk reads + LSP round-trips of latency to every
      // mutation batch that commits source files. The bounded window keeps
      // language-server load capped; per-path versions stay monotonic because
      // each path is assigned exactly once.
      await mapWithConcurrency(
        paths.slice(0, MAX_SYNC_FILES_PER_CALL),
        SYNC_CONCURRENCY,
        async (projectPath) => {
          try {
            const languageId = languageIdForPath(projectPath)
            if (!languageId || !hasLanguageServerSpec(languageId)) return
            const filePath = path.resolve(options.cwd, projectPath)
            // Bound the per-file read BEFORE framing the text into
            // didOpen/didChange over stdio (perf:
            // sync-mutated-files-unbounded-file-read): the per-call file
            // count and fan-out are already bounded, so a single huge
            // generated file in a mutation batch is the only unbounded
            // dimension left.
            const info = await fs.stat(filePath)
            if (info.size > MAX_SYNC_FILE_BYTES) return
            // Read current bytes straight from disk — never a cached copy — so
            // the server sees exactly what the mutation committed.
            const text = await fs.readFile(filePath, 'utf8')
            const version = (syncVersions.get(filePath) ?? 0) + 1
            syncVersions.set(filePath, version)
            await activeMultiplexer.syncFile({ filePath, version, text })
          } catch {
            // Fail-open per path: a missing file or an unavailable server must
            // never fail the run that just committed the write.
          }
        },
      )
      // P3 audit fix: deleted paths are forwarded as a didClose so a warm
      // language server drops its stale open-document state for files that no
      // longer exist. Same bounds (per-call cap + concurrency window) and the
      // same fail-open-per-path contract as the sync loop above; a deleted
      // path is never read from disk, and a path the server never opened
      // degrades to a no-op close rather than an error.
      const closedPaths = opts?.closedPaths ?? []
      await mapWithConcurrency(
        closedPaths.slice(0, MAX_SYNC_FILES_PER_CALL),
        SYNC_CONCURRENCY,
        async (projectPath) => {
          try {
            const languageId = languageIdForPath(projectPath)
            if (!languageId || !hasLanguageServerSpec(languageId)) return
            const filePath = path.resolve(options.cwd, projectPath)
            // The multiplexer's close branch ignores text/version; bumping
            // keeps a later re-created file's didOpen version monotonic.
            await activeMultiplexer.syncFile({
              filePath,
              version: (syncVersions.get(filePath) ?? 0) + 1,
              text: '',
              close: true,
            })
          } catch {
            // Fail-open per path: a missing document or an unavailable server
            // must never fail the run that just committed the delete.
          }
        },
      )
    },

    async dispose() {
      if (multiplexer) {
        await multiplexer.dispose()
      }
    },
  }
}
