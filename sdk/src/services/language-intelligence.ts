import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MAX_FILE_CHANGES_PER_TRANSACTION,
  MAX_TRANSACTION_FILE_BYTES,
  MAX_TRANSACTION_PREPARED_BYTES,
} from '@codebuff/common/actions'
import { captureTextDocument } from '@codebuff/common/util/byte-text'

import {
  getLanguageCapability,
  getLanguageToolSpecs,
  SUPPORTED_LANGUAGE_IDS,
  type SupportedLanguageId,
} from '@codebuff/common/util/language-capabilities'
import { resolveProjectPathForFileSystemRead, type HostReadPolicy } from '@codebuff/common/util/project-path-containment'

import {
  createLspMultiplexer,
  LspServerError,
  LspServerUnavailableError,
  LspExecutionError,
  type LspResourceFactory,
  type LspRequestContext,
} from './lsp-multiplexer'
import { observeNodeChild } from './toolchain-execution'
import { spliceSemanticText, type SemanticEditAnnotation } from './semantic-workspace-text'
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
  LspVersionedWorkspaceIntent,
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

/**
 * CONSTRUCTED-ONLY (factory creatable, not object-implementable):
 * `LanguageIntelligenceService` is produced exclusively by
 * `createLanguageIntelligence` below; the fact that it builds an object with
 * exactly this shape is an implementation detail, not an implementability
 * contract. See the constructed-only / consumer-migration note on the
 * exported `LspMultiplexer` type in lsp-multiplexer.ts — this interface is
 * documented the same way.
 *
 * Consumer migration note (this release): the interface GAINED a required
 * `extractSymbol` method (the extract_symbol tool's service seam). This is
 * BREAKING for any external consumer that structurally implements or
 * mock-builds this interface from a partial object literal — their literal
 * no longer satisfies the type until it also supplies `extractSymbol`.
 * Consumers that only call the factory (or spread a factory-created object)
 * are unaffected.
 */
export type LanguageIntelligenceService = {
  goToDefinition(params: {
    path: string
    line: number
    character: number
  }, executionContext?: LspRequestContext): Promise<CodebuffToolOutput<'go_to_definition'>>
  findReferences(params: {
    path: string
    line: number
    character: number
  }, executionContext?: LspRequestContext): Promise<CodebuffToolOutput<'find_references'>>
  hoverType(params: {
    path: string
    line: number
    character: number
  }, executionContext?: LspRequestContext): Promise<CodebuffToolOutput<'hover_type'>>
  workspaceSymbol(params: {
    query: string
  }, executionContext?: LspRequestContext): Promise<CodebuffToolOutput<'workspace_symbol'>>
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
  }, executionContext?: LspRequestContext): Promise<Array<{ type: 'json'; value: RenameCodeActionResult }>>
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
  }, executionContext?: LspRequestContext): Promise<Array<{ type: 'json'; value: RenameCodeActionResult }>>
  /**
   * P4-T2 (extract_symbol): extract the symbol at a file position into a NEW
   * file. The destination gate is fail-closed: a server that offers only an
   * in-place refactor (no created file in its workspace edit) is an honest
   * unavailable, never a silent in-place edit under a to-new-file tool name.
   * `destination_path` is published verbatim — the server's created uri only
   * supplies bytes, never the destination path. Same splice-on-disk contract
   * as renameSymbol/codeAction.
   *
   * `symbol_name` is ADVISORY-ONLY in v1: it is accepted for forward
   * compatibility and NOT forwarded to the server — no LSP seam exposes a
   * name parameter on this path, so the server always picks its own name for
   * the extracted symbol (the published extract_symbol tool schema
   * documents the field the same way).
   */
  extractSymbol(params: {
    path: string
    line: number
    character: number
    destination_path: string
    symbol_name: string
  }, executionContext?: LspRequestContext): Promise<Array<{ type: 'json'; value: RenameCodeActionResult }>>
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
    executionContext?: LspRequestContext,
  ): Promise<void>
  dispose(): Promise<void>
}

type UnavailableResult = {
  unavailable: {
    reason: string
    languageId?: string
    status?: 'unavailable' | 'not_installed'
    nextStep?: string
    command?: string
    install?: string
  }
}

const FALLBACK_NEXT_STEP =
  'Use code_search or query_index for this lookup instead.'

/** Concrete next step per unavailable reason (N04: status + reason + next step). */
function unavailableNextStep(error: LspServerUnavailableError): string {
  switch (error.reason) {
    case 'not-installed':
      return error.install
        ? `Ask the user to install '${error.command ?? 'the language server'}' (${error.install}), then retry. Until then, ${FALLBACK_NEXT_STEP.charAt(0).toLowerCase()}${FALLBACK_NEXT_STEP.slice(1)}`
        : `Ask the user to install '${error.command ?? 'the language server'}' and put it on PATH. Until then, ${FALLBACK_NEXT_STEP.charAt(0).toLowerCase()}${FALLBACK_NEXT_STEP.slice(1)}`
    case 'unsupported-language':
    case 'no-server-spec':
    case 'tcp-transport':
      return `No supported language server for this file. ${FALLBACK_NEXT_STEP}`
    case 'workspace-symbol-unsupported':
      return `The running server does not support symbol search. ${FALLBACK_NEXT_STEP}`
    case 'position is not renameable':
    case 'unsupported action kind (v1 organizes imports only)':
    case 'no organize-imports action available':
    case 'no extract action available':
    case 'no new-file destination in the workspace edit':
      return 'The language server cannot perform this refactor here. Make the change with the edit tools instead.'
    default:
      return FALLBACK_NEXT_STEP
  }
}

function toUnavailable(error: LspServerUnavailableError): UnavailableResult {
  return {
    unavailable: {
      reason: error.reason,
      status: error.reason === 'not-installed' ? 'not_installed' : 'unavailable',
      nextStep: unavailableNextStep(error),
      ...(error.languageId ? { languageId: error.languageId } : {}),
      ...(error.command ? { command: error.command } : {}),
      ...(error.install ? { install: error.install } : {}),
    },
  }
}

/**
 * workspace_symbol never cold-starts a server, so "no warm server" is the
 * normal state at the start of a turn. It must not look like "no symbols"
 * (language-intel-02).
 */
const NO_WARM_SERVER_UNAVAILABLE: UnavailableResult = {
  unavailable: {
    reason: 'no-warm-server',
    status: 'unavailable',
    nextStep:
      'workspace_symbol only queries an already running language server. Call go_to_definition, hover_type or find_references on a file in the target language to start one, then retry; or use code_search / query_index to find the symbol by name.',
  },
}

function toErrorMessage(error: LspServerError): { errorMessage: string; executionRefusal?: LspExecutionError['refusal'] } {
  return { errorMessage: `Language server error (${error.reason}): ${error.message}`,
    ...(error instanceof LspExecutionError ? { executionRefusal: error.refusal } : {}),
  }
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
export type StagedSemanticFile = {
  kind?: 'file'
  path: string
  newContent: string
  annotations?: SemanticEditAnnotation[]
  /** Raw hash of the spliced bytes, or absent basis for explicit creation. */
  expectedRawHash: string | null
}

type StagedResourceChange = {
  path: string
  expectedHash: string
  expectedRawHash: string
  annotations?: SemanticEditAnnotation[]
} & ({ kind: 'delete' } | { kind: 'move'; destinationPath: string })

export type RenameCodeActionResult =
  | {
      changedFiles: Array<StagedSemanticFile | StagedResourceChange>
      errorMessage?: string
    }
  | UnavailableResult
  | { errorMessage: string }

function stageVersionedIntent(
  intent: LspVersionedWorkspaceIntent,
  extract?: { source: string; destination: string },
): RenameCodeActionResult {
  if (intent.operations.length === 0) {
    return { errorMessage: 'The language server returned no applicable edits.' }
  }
  let changedFiles: Array<StagedSemanticFile | StagedResourceChange>
  try {
    changedFiles = intent.operations.map((operation) => {
      const path = fileURLToPath(operation.uri)
      const metadata = operation.annotations ? { annotations: operation.annotations } : {}
      if (operation.kind === 'file') {
        return { path, ...metadata, newContent: operation.newContent, expectedRawHash: operation.expectedRawHash }
      }
      const basis = { path, ...metadata, expectedRawHash: operation.expectedRawHash, expectedHash: operation.expectedHash }
      return operation.kind === 'move'
        ? { ...basis, kind: 'move', destinationPath: fileURLToPath(operation.destinationUri) }
        : { ...basis, kind: 'delete' }
    })
  } catch {
    return { errorMessage: 'The workspace edit contains an invalid local document URI.' }
  }
  if (extract) {
    const creations = changedFiles.filter((file) => file.expectedRawHash === null)
    if (creations.length !== 1 || creations[0]?.path !== extract.destination) {
      return { errorMessage: 'The extract edit must create exactly the requested destination; no files were changed.' }
    }
    if (changedFiles.some((file) => file.kind === 'delete' || file.kind === 'move') ||
        !changedFiles.some((file) => file.path === extract.source && file.expectedRawHash !== null)) {
      return { errorMessage: 'The extract edit must update its source without unrelated resource operations; no files were changed.' }
    }
  }
  return { changedFiles }
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
  readPolicy?: HostReadPolicy
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
  { fs, cwd, readPolicy }: FileReadContext,
): Promise<string | null> {
  const contained = await resolveProjectPathForFileSystemRead(
    cwd,
    projectPath,
    fs,
    readPolicy,
  )
  return contained?.fullPath ?? null
}

/** Prepare exact-byte file replacements without applying any of them. */
async function applyChangesByUriFromDisk(
  changesByUri: LspWorkspaceEditChanges,
  verb: string,
  { fs, cwd, readPolicy }: FileReadContext,
): Promise<RenameCodeActionResult> {
  const files = Object.entries(changesByUri)
  const refusal = (reason: string) => ({
    errorMessage: `could not ${verb}: ${reason}`,
  })
  if (
    files.length > MAX_FILE_CHANGES_PER_TRANSACTION ||
    files.some(([, edits]) => !Array.isArray(edits))
  ) {
    return refusal('invalid or oversized semantic file set')
  }
  const changedFiles: StagedSemanticFile[] = []
  const seenPaths = new Set<string>()
  let stagedBytes = 0
  for (const [uri, edits] of files) {
    if (edits.length === 0) continue
    let filePath: string
    try {
      if (!uri.startsWith('file:///')) throw new Error('not a local file URI')
      filePath = fileURLToPath(uri)
    } catch {
      return refusal('workspace edit target is not a local file URI')
    }
    try {
      const contained = await resolveProjectPathForFileSystemRead(
        cwd,
        filePath,
        fs,
        readPolicy,
      )
      if (contained?.scope !== 'project')
        return refusal(`${filePath}: path is outside the project workspace`)
      if (seenPaths.has(contained.realFullPath))
        return refusal(`${filePath}: duplicate canonical edit target`)
      seenPaths.add(contained.realFullPath)
      const stat = await fs.stat(contained.realFullPath)
      if (!stat.isFile() || stat.size > MAX_TRANSACTION_FILE_BYTES)
        return refusal(`${filePath}: unsupported or oversized edit basis`)
      const document = captureTextDocument(
        await fs.readFile(contained.realFullPath),
      )
      if (document.byteLength > MAX_TRANSACTION_FILE_BYTES)
        return refusal(
          `${filePath}: semantic edit basis exceeds the file limit`,
        )
      const newContent = spliceSemanticText(document.rawText, edits)
      stagedBytes += Buffer.byteLength(newContent) + document.byteLength
      if (stagedBytes > MAX_TRANSACTION_PREPARED_BYTES)
        return refusal('semantic edit exceeds the prepared byte limit')
      changedFiles.push({
        path: contained.realFullPath,
        newContent,
        expectedRawHash: document.rawHash,
      })
    } catch (error) {
      return refusal(
        `${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return changedFiles.length > 0
    ? { changedFiles }
    : refusal('the language server returned no applicable edits')
}

function applyCreatedFileEdits(
  destinationPath: string,
  edits: LspTextEdit[],
): StagedSemanticFile | { errorMessage: string } {
  try {
    return {
      path: destinationPath,
      newContent: spliceSemanticText('', edits),
      expectedRawHash: null,
    }
  } catch (error) {
    return {
      errorMessage: `${destinationPath}: ${error instanceof Error ? error.message : String(error)}`,
    }
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
  resourceFactory?: LspResourceFactory
  readPolicy?: HostReadPolicy
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
    readPolicy: options.readPolicy,
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
        resourceFactory: options.resourceFactory,
        spawner: (_spec, admitted): LspChildHandle => {
          const dispatched = admitted.launch.dispatchNow(admitted.permit, (input, observer) => {
            const child = spawn(input.executable, input.argv, {
              cwd: input.cwd, env: input.env, signal: input.resourceSignal,
              stdio: ['pipe', 'pipe', 'pipe'],
            })
            observeNodeChild(child, observer)
            return child
          })
          if (!dispatched.ok) throw new LspExecutionError(dispatched)
          return toLspChildHandle(dispatched.value.handle)
        },
        // P4-T2 (real-server seam): strict servers refuse document queries
        // for a file they never received via didOpen, so the service supplies
        // the containment-checked filesystem here. A refused path fails the
        // query with the same honest containment contract the splice path
        // already produces, instead of leaking real host-disk bytes.
        openFile: async ({ filePath }) => {
          const containedPath = await resolveSplicePath(filePath, readContext)
          if (!containedPath) {
            throw new LspServerError(
              'LSP document open refused: path is outside the project and the configured read roots.',
              { reason: 'unavailable' },
            )
          }
          try {
            return captureTextDocument(
              await readContext.fs.readFile(containedPath),
            ).rawText
          } catch (error) {
            throw new LspServerError(
              'LSP document open could not capture lossless text.',
              { reason: 'unavailable', cause: error },
            )
          }
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
    async goToDefinition(params, executionContext) {
      const result = await runQuery((mux) =>
        mux.definition({
          filePath: path.resolve(options.cwd, params.path),
          position: toLspPosition(params.line, params.character),
        }, executionContext),
      )
      if (result !== null && ('unavailable' in result || 'errorMessage' in result)) {
        return [{ type: 'json', value: result }]
      }
      return [{ type: 'json', value: { locations: toStructuredLocations(result) } }]
    },

    async findReferences(params, executionContext) {
      const result = await runQuery((mux) =>
        mux.references({
          filePath: path.resolve(options.cwd, params.path),
          position: toLspPosition(params.line, params.character),
        }, executionContext),
      )
      if (result !== null && ('unavailable' in result || 'errorMessage' in result)) {
        return [{ type: 'json', value: result }]
      }
      return [{ type: 'json', value: { locations: toStructuredLocations(result) } }]
    },

    async hoverType(params, executionContext) {
      const result = await runQuery((mux) =>
        mux.hover({
          filePath: path.resolve(options.cwd, params.path),
          position: toLspPosition(params.line, params.character),
        }, executionContext),
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

    async workspaceSymbol(params, executionContext) {
      const result = await runQuery((mux) => mux.workspaceSymbol(params.query, undefined, executionContext))
      if (result === null) {
        return [{ type: 'json', value: NO_WARM_SERVER_UNAVAILABLE }]
      }
      if ('unavailable' in result || 'errorMessage' in result) {
        return [{ type: 'json', value: result }]
      }
      const symbols = result.map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        location: toStructuredLocation(symbol.location),
        ...(symbol.containerName ? { containerName: symbol.containerName } : {}),
      }))
      return [{ type: 'json', value: { symbols } }]
    },

    async renameSymbol(params, executionContext) {
      const result = await runQuery(async (mux) => {
        const filePath = path.resolve(options.cwd, params.path)
        const position = toLspPosition(params.line, params.character)
        // Gate on a real prepareRename response first: a server that answers
        // null (not an identifier, out of range, or a server without rename
        // support) must surface as an honest unavailable, never a blind
        // splice.
        const prepared = await mux.prepareRenameParams({ filePath, position }, executionContext)
        if (prepared === null) {
          throw new LspServerUnavailableError(
            'the language server reports this position is not renameable.',
            { reason: 'position is not renameable' },
          )
        }
        const rename = { filePath, position, newName: params.new_name }
        return mux.renameIntent
          ? { intent: await mux.renameIntent(rename, executionContext) }
          : { changesByUri: await mux.rename(rename, executionContext) }
      })
      if ('unavailable' in result || 'errorMessage' in result) {
        return [{ type: 'json', value: result }]
      }
      if (result.intent) {
        // Never replace the captured basis with a post-response disk read.
        return [{ type: 'json', value: stageVersionedIntent(result.intent) }]
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

    async codeAction(params, executionContext) {
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
        if (mux.codeActionIntent) {
          return { intent: await mux.codeActionIntent({ filePath, position, purpose: 'organize-imports' }, executionContext) }
        }
        const actions = await mux.codeAction({
          filePath,
          position,
          only: [ORGANIZE_IMPORTS_KIND],
        }, executionContext)
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
      if (result.intent) {
        return [{ type: 'json', value: stageVersionedIntent(result.intent) }]
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

    async extractSymbol(params, executionContext) {
      const result = await runQuery(async (mux) => {
        const filePath = path.resolve(options.cwd, params.path)
        const position = toLspPosition(params.line, params.character)
        if (mux.codeActionIntent) {
          const intent = await mux.codeActionIntent({ filePath, position, purpose: 'extract' }, executionContext)
          return stageVersionedIntent(intent, { source: filePath, destination: path.resolve(options.cwd, params.destination_path) })
        }
        // Compatibility for injected legacy multiplexers only. The built-in
        // applicator never dispatches command-bearing code actions.
        // NO `only` filter: extract refactors are `refactor.extract.*` kinds
        // and the kind vocabulary is server-specific, so filtering here would
        // match nothing. Selection is heuristic and documented: prefer an
        // extract-titled action carrying edits or a command, then any
        // edit-carrying action, then any command-carrying action.
        const actions = await mux.codeAction({ filePath, position }, executionContext)
        const winner =
          actions.find(
            (action) =>
              /extract/i.test(action.title) &&
              (Object.keys(action.changesByUri).length > 0 || action.command),
          ) ??
          actions.find((action) => Object.keys(action.changesByUri).length > 0) ??
          actions.find((action) => action.command)
        if (!winner) {
          throw new LspServerUnavailableError(
            'the language server offered no extract refactor at this position.',
            { reason: 'no extract action available' },
          )
        }
        let changesByUri = winner.changesByUri
        let createdUris: string[] = []
        // Command-carrying actions are resolved through
        // workspace/executeCommand; its WorkspaceEdit reply is merged with any
        // edits the action itself carried (same uri concatenates the
        // action's edits first). A throwing executeCommand propagates as an
        // honest LspServerError like every other request seam.
        if (winner.command) {
          const commandEdit = await mux.executeCommand({
            filePath,
            command: winner.command.command,
            arguments: winner.command.arguments,
          }, executionContext)
          const merged: LspWorkspaceEditChanges = { ...changesByUri }
          for (const [uri, edits] of Object.entries(commandEdit.changesByUri)) {
            merged[uri] = [...(merged[uri] ?? []), ...edits]
          }
          changesByUri = merged
          createdUris = commandEdit.createdUris
        }
        // DESTINATION GATE (fail-closed): the server must CREATE the
        // destination file (documentChanges kind:'create'), exactly one,
        // other than the source. An in-place-only refactor must never land
        // under a to-new-file tool name, and v1 supports exactly one new
        // file — no guessing which created uri the caller meant.
        const created = createdUris.filter(
          (uri) => uriToPath(uri) !== filePath,
        )
        if (created.length === 0) {
          throw new LspServerUnavailableError(
            'the language server offered only an in-place refactor; extracting to a new file requires a server that creates the destination file.',
            { reason: 'no new-file destination in the workspace edit' },
          )
        }
        if (created.length !== 1) {
          throw new LspServerError(
            `the extract refactor created ${created.length} new files; v1 supports exactly one.`,
            { reason: 'protocol' },
          )
        }
        const createdUri = created[0]
        const createdEdits = changesByUri[createdUri] ?? []
        const sourceChanges: LspWorkspaceEditChanges = {}
        for (const [uri, edits] of Object.entries(changesByUri)) {
          if (uri === createdUri) continue
          sourceChanges[uri] = edits
        }
        const sourceEdits = Object.values(sourceChanges)
        if (sourceEdits.some((edits) => !Array.isArray(edits)))
          return { errorMessage: 'Invalid extract source edit set.' }
        const sourceResult = sourceEdits.some((edits) => edits.length > 0)
          ? await applyChangesByUriFromDisk(
              sourceChanges,
              'extract symbols from',
              readContext,
            )
          : { changedFiles: [] }
        if (!('changedFiles' in sourceResult)) return sourceResult
        // The caller owns destination_path, but the explicit create basis
        // is absence. A failed splice on either side discards the whole plan.
        const createdSplice = applyCreatedFileEdits(
          params.destination_path,
          createdEdits,
        )
        if ('errorMessage' in createdSplice) return createdSplice
        return { changedFiles: [...sourceResult.changedFiles, createdSplice] }
      })
      return [{ type: 'json', value: result }]
    },

    async syncMutatedFiles(paths, opts, executionContext) {
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
            const text = captureTextDocument(
              await readContext.fs.readFile(containedPath),
            ).rawText
            const version = (syncVersions.get(filePath) ?? 0) + 1
            syncVersions.set(filePath, version)
            await activeMultiplexer.syncFile({ filePath, version, text }, executionContext)
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
            }, executionContext)
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
