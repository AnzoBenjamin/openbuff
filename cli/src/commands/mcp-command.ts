import { IndexManager } from '@codebuff/indexer'
import {
  createConfiguredEmbedder,
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
  const signal = deps?.signal

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
  // implementation acquires the ProjectMemoryV2Provider lease (released once
  // when the server's signal aborts, or held for process lifetime on stdio)
  // and any failure degrades to no `memory` key — memory_search then answers
  // its honest disabled payload instead of crashing the read-only server.
  let memory: McpMemorySession | undefined
  try {
    const acquired =
      deps?.makeMemory !== undefined
        ? await deps.makeMemory(projectRoot)
        : await defaultMakeMemory(projectRoot, writeStderr, signal)
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

  return runMcpImpl({
    client,
    sessionData: {
      projectRoot,
      ...(index ? { index } : {}),
      ...(memory ? { memory } : {}),
    },
    mutations,
    signal,
  })
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
  signal: AbortSignal | undefined,
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
  if (signal !== undefined) {
    // Release the lease exactly once when the MCP server's lifetime ends.
    const release = () => void result.release()
    if (signal.aborted) release()
    else signal.addEventListener('abort', release, { once: true })
  } else {
    // No signal: the stdio MCP server runs to process exit, so the lease is
    // intentionally held for process lifetime — the process teardown is the
    // release point, and the provider's release is idempotent per process.
  }
  return { repository: result.repository, projectId: result.projectId }
}
