import fs from 'node:fs/promises'
import path from 'node:path'

import {
  getLanguageCapability,
  getLanguageToolSpecs,
  SUPPORTED_LANGUAGE_IDS,
  type SupportedLanguageId,
} from '@codebuff/common/util/language-capabilities'
import { resolveProjectPathForFileSystemRead } from '@codebuff/common/util/project-path-containment'

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
  LspTextEdit,
  LspWorkspaceEditChanges,
} from './lsp-multiplexer'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
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
   * P4-T2 (rename_symbol): prepareRename-then-rename through the language
   * server. The 1-based `line` is shifted to the 0-based LSP position HERE
   * and exactly once — the multiplexer consumes 0-based positions verbatim.
   * Returns the per-file spliced contents; the apply/dispatch sibling owns
   * mapping them onto the mutation broker (this layer never builds
   * `applied`/`results`). A position the server refuses to rename, or a
   * server error, degrades to the same structured unavailable/errorMessage
   * results as the read-only queries.
   */
  renameSymbol(params: {
    path: string
    line: number
    character: number
    new_name: string
  }): Promise<Array<{ type: 'json'; value: RenameCodeActionResult }>>
  /**
   * P4-T2 (code_action, v1): `source.organizeImports` only. Any other kind
   * is an honest typed unavailable, not a silent no-op. Same splice-on-disk
   * contract as renameSymbol.
   */
  codeAction(params: {
    path: string
    line: number
    character: number
    kind: string
  }): Promise<Array<{ type: 'json'; value: RenameCodeActionResult }>>
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

/** P4-T2: the only code-action kind v1 accepts. */
const ORGANIZE_IMPORTS_KIND = 'source.organizeImports'

/**
 * P4-T2: the SERVICE-level result shape for renameCodeAction. Deliberately
 * NOT the tools' outputSchema — the apply/dispatch sibling owns mapping
 * `changedFiles` onto the mutation broker (and building `applied`/`results`
 * there), so this layer returns only spliced per-file contents or the honest
 * unavailable/errorMessage degradations.
 */
export type RenameCodeActionResult =
  | {
      changedFiles: Array<{ path: string; newContent: string }>
      /** Present when SOME files failed but at least one spliced. */
      errorMessage?: string
    }
  | UnavailableResult
  | { errorMessage: string }

/**
 * A WorkspaceEdit lookup (uri → lineStarts) for the raw on-disk text; the
 * 0-based offset of every position starts from this table, so reverse-order
 * splicing works purely on offsets of the LIMITED raw text.
 */
function buildLineStartOffsets(text: string): number[] {
  const lineStarts = [0]
  let index = text.indexOf('\n')
  while (index !== -1) {
    lineStarts.push(index + 1)
    index = text.indexOf('\n', index + 1)
  }
  return lineStarts
}

/**
 * The 0-based offset of an edit range start/end inside the raw on-disk text.
 * `undefined` means the position is out of bounds of the ACTUAL document —
 * the caller must fail the file honestly instead of clamping (a clamped
 * splice would silently corrupt neighboring content).
 */
function toOffsetInRangeText(
  text: string,
  lineStarts: number[],
  position: LspPosition,
): number | undefined {
  const lineStart = lineStarts[position.line]
  if (lineStart === undefined) {
    return undefined
  }
  const nextLineStart = lineStarts[position.line + 1]
  // The character must stay within ITS OWN line's content (the text between
  // this line start and the next line's '\n'); a character that overshoots
  // is a server/client disagreement about the document, not a splice input.
  const lineEnd = nextLineStart === undefined ? text.length : nextLineStart - 1
  const offset = lineStart + position.character
  if (offset > lineEnd) {
    return undefined
  }
  return offset
}

/** Drop edits that carry an identical range AND replacement text (per file). */
function dedupePerFileEdits(edits: LspTextEdit[]): LspTextEdit[] {
  const seen = new Set<string>()
  const unique: LspTextEdit[] = []
  for (const edit of edits) {
    const key = `${edit.range.start.line}:${edit.range.start.character}:${edit.range.end.line}:${edit.range.end.character}:${edit.newText}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(edit)
  }
  return unique
}

/**
 * Node fs/promises fallback for callers (tests, spawner-less direct
 * dispatch) that inject no host filesystem. Tagged `hostProcessView` because
 * these reads really do observe the host process's disk.
 */
const NODE_PROMISES_FS: CodebuffFileSystem = Object.freeze(
  Object.create(fs, {
    hostProcessView: { value: true, enumerable: true },
  }),
)

/**
 * The filesystem/read seam every splice and sync read goes through. The
 * splice source is THIS filesystem — the same one the mutation broker
 * commits to for injected/virtual-fs hosts — and every server-supplied or
 * sync path is resolved through the run's read-containment boundary before
 * it is opened.
 */
type FileReadContext = {
  fs: CodebuffFileSystem
  cwd: string
}

/**
 * Resolve a server-(or sync)-supplied path through the read-containment
 * resolver so a path outside the project and the configured external read
 * roots is refused BEFORE any filesystem read happens. Returns `null` when
 * the caller must refuse and never open the path.
 */
async function resolveSplicePath(
  projectPath: string,
  { fs, cwd }: FileReadContext,
): Promise<string | null> {
  const contained = await resolveProjectPathForFileSystemRead(
    cwd,
    projectPath,
    fs,
  )
  return contained?.fullPath ?? null
}

/**
 * P4-T2: apply ONE normalized per-URI edit list to the CURRENT bytes of the
 * run's filesystem — never a stale copy, and never raw host disk when a
 * virtual-fs host injected its own filesystem — and return the spliced
 * content. Dedupe per file, convert the 0-based LSP ranges to offsets ONCE
 * against a shared index of the raw text, then apply in a single
 * reverse-document-order pass (descending start offset), so each splice
 * never shifts a later one. An overlap, an out-of-bounds range, or a
 * server-supplied uri outside the project / the configured read roots fails
 * THAT file with an errorMessage here (recorded per file upstream, never
 * thrown for the whole call).
 */
async function applyFileEditsFromDisk(
  uri: string,
  edits: LspTextEdit[],
  readContext: FileReadContext,
): Promise<{ path: string; newContent: string } | { path: string; errorMessage: string }> {
  const filePath = uriToPath(uri)
  const containedPath = await resolveSplicePath(filePath, readContext)
  if (!containedPath) {
    return {
      path: filePath,
      errorMessage: 'path is outside the project and the configured read roots',
    }
  }
  let text: string
  try {
    text = await readContext.fs.readFile(containedPath, 'utf8')
  } catch {
    return { path: filePath, errorMessage: 'file could not be read from disk' }
  }
  const lineStarts = buildLineStartOffsets(text)
  const positioned: Array<{
    startOffset: number
    endOffset: number
    newText: string
  }> = []
  for (const edit of dedupePerFileEdits(edits)) {
    const startOffset = toOffsetInRangeText(text, lineStarts, edit.range.start)
    const endOffset = toOffsetInRangeText(text, lineStarts, edit.range.end)
    if (startOffset === undefined || endOffset === undefined) {
      return {
        path: filePath,
        errorMessage: 'edit range is out of bounds of the current document',
      }
    }
    positioned.push({ startOffset, endOffset, newText: edit.newText })
  }
  // Reverse document order: after this sort, positioned[index] has the next-
  // applied (larger) start and positioned[index + 1] the smaller one, so a
  // pair overlaps iff the smaller-start range's END reaches into the larger-
  // start range (e.g. two edits occupying the same span). A zero-width
  // adjacency (end exactly AT the next start) is legal and NOT an overlap.
  positioned.sort((a, b) => b.startOffset - a.startOffset)
  for (let index = 0; index < positioned.length - 1; index++) {
    const current = positioned[index]
    const previous = positioned[index + 1]
    if (previous.endOffset > current.startOffset) {
      return {
        path: filePath,
        errorMessage: `edits overlap in the current document: the edit ending at offset ${previous.endOffset} reaches into the edit starting at offset ${current.startOffset}`,
      }
    }
  }
  let spliced = text
  for (const { startOffset, endOffset, newText } of positioned) {
    spliced = spliced.slice(0, startOffset) + newText + spliced.slice(endOffset)
  }
  return { path: filePath, newContent: spliced }
}

/**
 * P4-T2: apply a whole normalized changesByUri to disk and aggregate into
 * the service result shape. Per-file failures are recorded per file (an
 * overlapping file does not fail its peers) and summarized in a top-level
 * errorMessage only when they exist — the whole call never throws for one
 * bad file.
 */
async function applyChangesByUriFromDisk(
  changesByUri: LspWorkspaceEditChanges,
  verb: string,
  readContext: FileReadContext,
): Promise<RenameCodeActionResult> {
  const spliced = await Promise.all(
    Object.entries(changesByUri)
      // A uri with no edits contributes nothing: reading its disk bytes just
      // to echo them back as a "changed" file would make the apply sibling
      // hash-gate a file the language server never actually edited.
      .filter(([, edits]) => edits.length > 0)
      .map(([uri, edits]) =>
        applyFileEditsFromDisk(uri, edits, readContext),
      ),
  )
  const changedFiles: Array<{ path: string; newContent: string }> = []
  const failures: string[] = []
  for (const outcome of spliced) {
    if ('newContent' in outcome) {
      changedFiles.push(outcome)
    } else {
      failures.push(`${outcome.path}: ${outcome.errorMessage}`)
    }
  }
  if (changedFiles.length === 0) {
    return {
      errorMessage:
        failures.length > 0
          ? `could not ${verb}: ${failures.join('; ')}`
          : `could not ${verb}: the language server returned no applicable edits`,
    }
  }
  return {
    changedFiles,
    ...(failures.length > 0 ? { errorMessage: failures.join('; ') } : {}),
  }
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
  /**
   * Host filesystem for every splice/sync read (audit fix: raw node disk
   * bypass). run() injects this run's resolved CodebuffFileSystem, so a
   * virtual-fs host (fsSource, hydration) splices the same bytes the
   * mutation broker commits. Omitted means node fs/promises (tagged
   * hostProcessView) — the spawner-less/test path.
   */
  fs?: CodebuffFileSystem
}

export function createLanguageIntelligence(
  options: LanguageIntelligenceOptions,
): LanguageIntelligenceService {
  // Every splice/sync read goes through this filesystem: a host-injected
  // adapter serves virtual-fs workflows, and raw node disk is only the
  // fallback for callers with no filesystem to inject.
  const readContext: FileReadContext = {
    fs: options.fs ?? NODE_PROMISES_FS,
    cwd: options.cwd,
  }
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

    async renameSymbol(params) {
      const result = await runQuery(async (mux) => {
        const filePath = path.resolve(options.cwd, params.path)
        const position = toLspPosition(params.line, params.character)
        // Gate on a real prepareRename response first: a server that answers
        // null (not an identifier, out of range, or a server without rename
        // support) must surface as an honest unavailable, never a blind
        // splice.
        const prepared = await mux.prepareRenameParams({ filePath, position })
        if (prepared === null) {
          throw new LspServerUnavailableError(
            'the language server reports this position is not renameable.',
            { reason: 'position is not renameable' },
          )
        }
        return {
          changesByUri: await mux.rename({
            filePath,
            position,
            newName: params.new_name,
          }),
        }
      })
      if ('unavailable' in result || 'errorMessage' in result) {
        return [{ type: 'json', value: result }]
      }
      return [
        {
          type: 'json',
          value: await applyChangesByUriFromDisk(
            result.changesByUri,
            'rename the symbol',
            readContext,
          ),
        },
      ]
    },

    async codeAction(params) {
      const result = await runQuery(async (mux) => {
        // v1 gate: anything but organize imports is an honest unavailable so
        // the model never mistakes an unsupported kind for a completed edit.
        if (params.kind !== ORGANIZE_IMPORTS_KIND) {
          throw new LspServerUnavailableError(
            `code action kind '${params.kind}' is not supported (v1 organizes imports only).`,
            { reason: 'unsupported action kind (v1 organizes imports only)' },
          )
        }
        const filePath = path.resolve(options.cwd, params.path)
        const position = toLspPosition(params.line, params.character)
        const actions = await mux.codeAction({
          filePath,
          position,
          only: [ORGANIZE_IMPORTS_KIND],
        })
        // First edit-carrying action wins; command-only actions are skipped
        // upstream (never resolved via textDocument/codeAction round-trips).
        const winner = actions.find(
          (action) => Object.keys(action.changesByUri).length > 0,
        )
        if (!winner) {
          throw new LspServerUnavailableError(
            'the language server offered no organize-imports action with edits.',
            { reason: 'no organize-imports action available' },
          )
        }
        return { changesByUri: winner.changesByUri }
      })
      if ('unavailable' in result || 'errorMessage' in result) {
        return [{ type: 'json', value: result }]
      }
      return [
        {
          type: 'json',
          value: await applyChangesByUriFromDisk(
            result.changesByUri,
            'organize imports in',
            readContext,
          ),
        },
      ]
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
            // Containment BEFORE any read: a path outside the project and
            // the configured read roots is skipped, fail-open like every
            // other per-path sync failure, and never opened at all.
            const containedPath = await resolveSplicePath(
              projectPath,
              readContext,
            )
            if (!containedPath) return
            const info = await readContext.fs.stat(containedPath)
            if (info.size > MAX_SYNC_FILE_BYTES) return
            // Read current bytes through the run's filesystem — never a
            // cached copy — so the server sees exactly what the mutation
            // committed.
            const text = await readContext.fs.readFile(containedPath, 'utf8')
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
