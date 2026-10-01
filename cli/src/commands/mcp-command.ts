import { IndexManager } from '@codebuff/indexer'
import {
  createConfiguredEmbedder,
  createNodeFileSystem,
  loadProviderConfigSync,
  runMcp,
} from '@openbuff/sdk'

import { getProjectRoot } from '../project-files'
import { logger } from '../utils/logger'

import type { EmbedFn, McpServerClient } from '@openbuff/sdk'

/**
 * The parsed `openbuff mcp` selection (mirrors `ParsedArgs.mcp`): no flags
 * this wave — the server is read-only by default, and receipt-backed edits
 * plus memory search stay opt-in/OFF until the follow-up named in
 * sdk/src/mcp/server.ts arms them behind explicit flags.
 */
export type McpCommandArgs = Record<string, never>

/**
 * Fully-injectable seams for `runMcpCommand`. Every dependency defaults to
 * the real CLI/SDK implementation, so production callers pass nothing and
 * tests inject hermetic stubs (never touching a real index or stdio).
 */
export type RunMcpDeps = {
  runMcpImpl?: typeof runMcp
  makeClient?: (projectRoot: string) => McpServerClient
  makeIndex?: (projectRoot: string) => IndexManager | undefined
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
  void args
  // Resolve getProjectRoot() lazily here (after initializeApp has run in
  // index.tsx), never at module load; tests that inject projectRoot never call it.
  const projectRoot = deps?.projectRoot ?? getProjectRoot()
  const runMcpImpl = deps?.runMcpImpl ?? runMcp
  const writeStderr =
    deps?.writeStderr ?? ((line: string) => process.stderr.write(line + '\n'))

  const client =
    deps?.makeClient?.(projectRoot) ??
    ({ fileSystem: createNodeFileSystem(), logger } satisfies McpServerClient)

  const index =
    deps?.makeIndex !== undefined
      ? deps.makeIndex(projectRoot)
      : defaultMakeIndex(projectRoot)

  // Human line to STDERR only — stdout is the MCP protocol wire.
  writeStderr(
    'openbuff mcp: MCP server over stdio (read-only; ' +
      (index
        ? 'query_index enabled'
        : 'query_index disabled by openbuff.json indexing.enabled=false') +
      ')',
  )

  return runMcpImpl({
    client,
    sessionData: { projectRoot, ...(index ? { index } : {}) },
    signal: deps?.signal,
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
