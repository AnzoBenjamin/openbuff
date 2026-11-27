import { IndexManager } from '@codebuff/indexer'
import {
  createConfiguredEmbedder,
  createConfiguredDirectHostExecution,
  createNodeFileSystem,
  loadProviderConfigSync,
  runMcp,
} from '@openbuff/sdk'

import { getProjectRoot } from '../project-files'
import { getProjectMemoryV2Provider } from '../services/memory-v2/provider'
import { logger } from '../utils/logger'

import type { EmbedFn, McpServerClient, McpSessionData } from '@openbuff/sdk'

/**
 * The parsed `openbuff mcp` selection (mirrors `ParsedArgs.mcp`). The server
 * is read-only by default; receipt-backed edits (`apply_edits`) stay opt-in
 * behind `--mutations`, which the parse layer surfaces here and
 * `runMcpCommand` forwards to `runMcp`. (`memory_search` is read-only and
 * always listed; it degrades to its honest disabled payload when the memory
 * store is unavailable.)
 */
export type McpCommandArgs = { mutations?: boolean }

/**
 * The SDK's Memory V2 seam for `memory_search` (`McpSessionData['memory']`):
 * the lexical-only repository surface plus the store's bound projectId.
 * Derived structurally from `McpSessionData` so this file depends only on
 * the SDK's published declaration surface.
 */
type McpMemorySession = NonNullable<McpSessionData['memory']>

type ConfiguredExecutionResult = Awaited<
  ReturnType<typeof createConfiguredDirectHostExecution>
>
type ConfiguredExecutionOwner = Extract<
  ConfiguredExecutionResult,
  { ok: true }
>['value']
type DirectOperationResult = ReturnType<
  ConfiguredExecutionOwner['hostServices']['directOperation']
>

/** Only the owner operations consumed by this command belong to its DI seam. */
type McpExecutionOwner = Pick<ConfiguredExecutionOwner, 'executionContext'> & {
  hostServices: {
    directOperation(
      options: NonNullable<
        Parameters<
          ConfiguredExecutionOwner['hostServices']['directOperation']
        >[0]
      >,
    ):
      | Exclude<DirectOperationResult, { ok: true }>
      | {
          ok: true
          value: Pick<
            Extract<DirectOperationResult, { ok: true }>['value'],
            'executionContext'
          >
        }
  }
  close(): Promise<
    readonly Pick<
      Awaited<ReturnType<ConfiguredExecutionOwner['close']>>[number],
      'status'
    >[]
  >
}

/**
 * Fully-injectable seams for `runMcpCommand`. Every dependency defaults to
 * the real CLI/SDK implementation, so production callers pass nothing and
 * tests inject hermetic stubs (never touching a real index or stdio).
 */
export type RunMcpDeps = {
  runMcpImpl?: typeof runMcp
  makeClient?: (projectRoot: string) => McpServerClient
  makeIndex?: (projectRoot: string) => IndexManager | undefined
  makeMemory?: (projectRoot: string) => Promise<McpMemorySession | null>
  makeExecution?: (
    options: Parameters<typeof createConfiguredDirectHostExecution>[0],
  ) => Promise<
    | Exclude<ConfiguredExecutionResult, { ok: true }>
    | { ok: true; value: McpExecutionOwner }
  >
  projectRoot?: string
  writeStderr?: (line: string) => void
  signal?: AbortSignal
}

/**
 * The `openbuff mcp` entry the CLI dispatches BEFORE the TUI (mirrors
 * `runAcpServeCommand`): it builds the session data (project root + the real
 * indexer) and the cap-guarded client, then starts the MCP server over stdio
 * and returns its `{ close }`.
 *
 * stdout is the MCP protocol wire, so EVERY human-readable line goes to
 * stderr via `writeStderr` — nothing is ever written to stdout here.
 */
export async function runMcpCommand(
  args: McpCommandArgs,
  deps?: RunMcpDeps,
): Promise<{ close: () => Promise<void> }> {
  const mutations = args.mutations === true
  // Resolve getProjectRoot() lazily here (after initializeApp has run in
  // index.tsx), never at module load; tests that inject projectRoot never call it.
  const projectRoot = deps?.projectRoot ?? getProjectRoot()
  const runMcpImpl = deps?.runMcpImpl ?? runMcp
  const writeStderr =
    deps?.writeStderr ?? ((line: string) => process.stderr.write(line + '\n'))
  const completion = new AbortController()
  const signal = deps?.signal
    ? AbortSignal.any([deps.signal, completion.signal])
    : completion.signal
  const execution = await (
    deps?.makeExecution ?? createConfiguredDirectHostExecution
  )({
    cwd: projectRoot,
    projectRoot,
    signal,
  })
  if (!execution.ok) {
    completion.abort(new Error('MCP execution setup refused'))
    throw Object.assign(new Error(execution.cause), {
      executionRefusal: execution,
      cleanup: execution.cleanup,
    })
  }
  const owner = execution.value
  let releaseMemory: (() => Promise<void>) | undefined
  let ownerClosing: Promise<void> | undefined
  function closeOwner(): Promise<void> {
    if (ownerClosing) return ownerClosing
    ownerClosing = Promise.resolve().then(async () => {
      signal.removeEventListener('abort', requestClose)
      const results = await Promise.allSettled([
        Promise.resolve().then(() => owner.close()),
        Promise.resolve().then(() => releaseMemory?.()),
      ])
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      )
      const hostCleanup = results[0]
      if (
        hostCleanup?.status === 'fulfilled' &&
        hostCleanup.value?.some(
          (observation) => observation.status !== 'complete',
        )
      ) {
        errors.push(
          Object.assign(new Error('MCP process cleanup remains unconfirmed'), {
            cleanup: hostCleanup.value,
          }),
        )
      }
      if (errors.length)
        throw new AggregateError(errors, 'MCP owner cleanup failed')
    })
    completion.abort(new Error('MCP server lifetime completed'))
    return ownerClosing
  }
  let server: Awaited<ReturnType<typeof runMcp>> | undefined
  let starting: Promise<Awaited<ReturnType<typeof runMcp>>> | undefined
  let closing: Promise<void> | undefined
  function close(): Promise<void> {
    if (closing) return closing
    closing = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(async () => {
          const liveServer = starting
            ? await starting.catch(() => undefined)
            : server
          await liveServer?.close()
        }),
        closeOwner(),
      ])
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      )
      if (errors.length)
        throw new AggregateError(errors, 'MCP command cleanup failed')
    })
    return closing
  }
  function requestClose() {
    void close().catch((error) => {
      try {
        writeStderr(
          'openbuff mcp: cleanup failed (' +
            (error instanceof Error ? error.message : String(error)) +
            ')',
        )
      } catch {}
    })
  }

  try {
    if (signal.aborted) throw new Error('MCP command cancelled during setup')

    const client =
      deps?.makeClient?.(projectRoot) ??
      ({ fileSystem: createNodeFileSystem(), logger } satisfies McpServerClient)

    const index =
      deps?.makeIndex !== undefined
        ? deps.makeIndex(projectRoot)
        : defaultMakeIndex(projectRoot)

    // Human line to STDERR only — stdout is the MCP protocol wire.
    writeStderr(
      'openbuff mcp: MCP server over stdio (' +
        (mutations ? 'read+write (apply_edits armed)' : 'read-only') +
        '; ' +
        (index
          ? 'query_index enabled'
          : 'query_index disabled by openbuff.json indexing.enabled=false') +
        ')',
    )

    // The `memory` session seam is wired through `makeMemory` above: the real
    // implementation acquires the ProjectMemoryV2Provider lease, joined once
    // when the server's owned lifetime ends. Any failure degrades to no
    // `memory` key — memory_search then answers
    // its honest disabled payload instead of crashing the read-only server.
    let memory: McpMemorySession | undefined
    try {
      const acquired =
        deps?.makeMemory !== undefined
          ? await deps.makeMemory(projectRoot)
          : await defaultMakeMemory(projectRoot, writeStderr, (release) => {
              releaseMemory = release
            })
      if (acquired !== null) memory = acquired
    } catch (error) {
      // A memory provider failure must never crash the read-only MCP command
      // path: fail open to the honest disabled payload.
      memory = undefined
      writeStderr(
        'openbuff mcp: memory_search disabled (memory provider failed: ' +
          (error instanceof Error ? error.message : String(error)) +
          ')',
      )
    }

    if (signal.aborted) throw new Error('MCP command cancelled during setup')
    signal.addEventListener('abort', requestClose, { once: true })
    starting = runMcpImpl({
      client,
      sessionData: {
        projectRoot,
        ...(index ? { index } : {}),
        ...(memory ? { memory } : {}),
      },
      mutations,
      signal,
      executionContext: owner.executionContext,
      executionContextForRequest: (requestSignal) => {
        const operation = owner.hostServices.directOperation({
          signal: requestSignal,
        })
        return operation.ok
          ? { ok: true, value: operation.value.executionContext }
          : operation
      },
      onClose: closeOwner,
    })
    server = await starting
    if (signal.aborted || closing) await close()
    return { close }
  } catch (error) {
    try {
      await close()
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'MCP command startup and cleanup failed',
      )
    }
    throw error
  }
}

/**
 * Builds the real indexer for the project, mirroring the CLI's query_index
 * override wiring (cli/src/utils/codebuff-client.ts): openbuff.json's
 * `indexing` block plus a configured semantic embedder when enabled. Returns
 * undefined when indexing is disabled so query_index answers honestly.
 */
function defaultMakeIndex(projectRoot: string): IndexManager | undefined {
  const indexingConfig = loadProviderConfigSync().config.indexing
  if (indexingConfig.enabled === false) return undefined
  const embedder: EmbedFn | undefined =
    indexingConfig.semantic?.enabled && indexingConfig.semantic?.model
      ? (createConfiguredEmbedder(indexingConfig.semantic.model) ?? undefined)
      : undefined
  return IndexManager.getInstance(projectRoot, indexingConfig, embedder)
}

/**
 * Acquires the project's Memory V2 session from the process-singleton
 * ProjectMemoryV2Provider. Returns null when memory is unavailable (the
 * `memory_search` tool then answers its honest disabled payload) and reports
 * the degradation via `writeStderr`; the caller's guard turns any provider
 * throw into the same fail-open degradation.
 *
 * The provider opens the memory sqlite eagerly, so this runs only in
 * production — tests always inject a `makeMemory` stub instead.
 */
async function defaultMakeMemory(
  projectRoot: string,
  writeStderr: (line: string) => void,
  retainRelease: (release: () => Promise<void>) => void,
): Promise<McpMemorySession | null> {
  const result = await getProjectMemoryV2Provider(projectRoot)
  if (result.status !== 'available') {
    writeStderr(
      'openbuff mcp: memory_search disabled (memory unavailable: ' +
        result.degradation +
        ')',
    )
    return null
  }
  retainRelease(async () => {
    await result.release()
  })
  return { repository: result.repository, projectId: result.projectId }
}
