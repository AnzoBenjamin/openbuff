import { IndexManager } from '@codebuff/indexer'
import { AskUserBridge } from '@codebuff/common/utils/ask-user-bridge'
import {
  OpenbuffClient,
  loadProviderConfigSync,
  createConfiguredEmbedder,
} from '@openbuff/sdk'

import { getRgPath } from '../native/ripgrep'
import { getProjectRoot } from '../project-files'
import {
  getProjectMemoryV2Provider,
  resetProjectMemoryV2Provider,
} from '../services/memory-v2/provider'
import { getCliEnv, getMemoryAuthoritySelection, getSystemProcessEnv } from './env'
import { logger } from './logger'

import type { ClientToolCall } from '@codebuff/common/tools/list'
import type { JSONObject } from '@codebuff/common/types/json'
import type { MemoryV2ClientConfig, OpenbuffClientOptions, RunOptions, RunState } from '@openbuff/sdk'
import type { MemoryV2ProviderResult } from '../services/memory-v2/provider'

export function memoryV2ClientConfigFromProvider(
  result: MemoryV2ProviderResult,
): MemoryV2ClientConfig | undefined {
  if (result.status === 'available') {
    return {
      repository: result.repository,
      projectId: result.projectId,
      authority: result.effectiveAuthority,
      mode: result.effectiveAuthority === 'sqlite-v2-opt-in' ? 'inject' : 'shadow',
      capture: 'safe',
    }
  }
  if (result.effectiveAuthority === 'sqlite-v2-opt-in' && result.projectId) {
    return {
      projectId: result.projectId,
      authority: 'sqlite-v2-opt-in',
      mode: 'inject',
      capture: 'safe',
    }
  }
  return undefined
}

export class ManagedOpenbuffClient extends OpenbuffClient {
  private activeRuns = 0
  private retired = false
  private released = false

  constructor(
    options: OpenbuffClientOptions,
    private readonly releaseLease?: () => Promise<void>,
    private readonly runDelegate?: (options: RunOptions & OpenbuffClientOptions) => Promise<RunState>,
  ) {
    super(options)
  }

  override async run(options: RunOptions & OpenbuffClientOptions): Promise<RunState> {
    if (this.retired) throw new Error('This client has been retired.')
    this.activeRuns++
    try {
      return this.runDelegate ? await this.runDelegate(options) : await super.run(options)
    } finally {
      this.activeRuns--
      await this.maybeRelease()
    }
  }

  async retire(): Promise<void> {
    this.retired = true
    await this.maybeRelease()
  }

  private async maybeRelease(): Promise<void> {
    if (!this.retired || this.activeRuns !== 0 || this.released || !this.releaseLease) return
    this.released = true
    await this.releaseLease()
  }
}

// Singleton instance of the SDK's OpenbuffClient for reuse within the CLI
let clientInstance: ManagedOpenbuffClient | null = null
let clientPromise: Promise<OpenbuffClient> | null = null
let clientGeneration = 0

/**
 * Recursively removes undefined values from an object to ensure clean JSON serialization.
 * This prevents issues with APIs that don't accept explicit undefined values.
 */
function removeUndefinedValues<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj
  }
  if (Array.isArray(obj)) {
    return obj.map(removeUndefinedValues) as T
  }
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      if (value !== undefined) {
        result[key] = removeUndefinedValues(value)
      }
    }
    return result as T
  }
  return obj
}

/**
 * Reset the API client singleton so it picks up new settings
 * on the next call to getCodebuffClient().
 */
export async function resetCodebuffClient(): Promise<void> {
  clientGeneration++
  const oldClient = clientInstance
  clientInstance = null
  clientPromise = null
  await oldClient?.retire()
  await resetProjectMemoryV2Provider()
}

export async function getCodebuffClient(): Promise<OpenbuffClient> {
  if (clientInstance) return clientInstance
  if (clientPromise) return clientPromise

  const generation = clientGeneration
  const root = getProjectRoot()
  const create = async (): Promise<OpenbuffClient> => {
    // Set up ripgrep path for SDK to use
    const env = getCliEnv()
    if (env.CODEBUFF_IS_BINARY) {
      try {
        const rgPath = await getRgPath()
        // Note: We still set process.env here because SDK reads from it
        getSystemProcessEnv().CODEBUFF_RG_PATH = rgPath
      } catch (error) {
        logger.error(error, 'Failed to set up ripgrep binary for SDK')
      }
    }

    const authority = getMemoryAuthoritySelection(env.OPENBUFF_MEMORY_AUTHORITY)
    const providerResult = await getProjectMemoryV2Provider(root, authority)
    if (generation !== clientGeneration) {
      if (providerResult.status === 'available') await providerResult.release()
      return getCodebuffClient()
    }

    let client: ManagedOpenbuffClient
    try {
      const memoryV2 = memoryV2ClientConfigFromProvider(providerResult)
      client = new ManagedOpenbuffClient({
        cwd: root,
        logger,
        ...(memoryV2 ? { memoryV2 } : {}),
        overrideTools: {
          ask_user: async (input: ClientToolCall<'ask_user'>['input']) => {
            const askUserResponse = await AskUserBridge.request(
              'cli-override',
              input.questions,
            )
            const response = askUserResponse as {
              answers?: Array<{ questionIndex: number; selectedOption: string }>
              skipped?: boolean
            }
            return [
              {
                type: 'json',
                value: removeUndefinedValues(response),
              },
            ]
          },
          query_index: async (input: ClientToolCall<'query_index'>['input']) => {
          const projectRoot = getProjectRoot()
          const indexingConfig = loadProviderConfigSync().config.indexing
          if (indexingConfig.enabled === false) {
            return [
              {
                type: 'json',
                value: {
                  kind: 'query_index_result',
                  schemaVersion: 1,
                  results: [],
                  totalIndexed: 0,
                  indexAge: 0,
                  message:
                    'Codebase indexing is disabled in openbuff.json; fall back to read_subtree, glob, or code_search.',
                  status: {
                    state: 'disabled',
                    ready: false,
                    stale: false,
                    refreshing: false,
                    semantic: 'disabled',
                    totalIndexed: 0,
                    indexAge: 0,
                    diagnostics: [],
                    message: 'Indexing is disabled.',
                  },
                } as JSONObject,
              },
            ]
          }
          const embedder =
            indexingConfig.semantic?.enabled && indexingConfig.semantic?.model
              ? (createConfiguredEmbedder(indexingConfig.semantic.model) ?? undefined)
              : undefined
          const manager = IndexManager.getInstance(
            projectRoot,
            indexingConfig,
            embedder,
          )
          await manager.waitUntilReady(2_000)
          const result = await manager.queryBlended(input.query ?? '', {
            limit: input.limit,
            fileTypes: input.fileTypes,
            pathPrefixes: input.pathPrefixes,
            mode: input.mode,
            from: input.from,
            to: input.to,
          })
          const semanticNotice =
            indexingConfig.semantic?.enabled && !manager.isSemanticReady()
              ? ' Semantic indexing is enabled but unavailable (no routable embedding model or vectors not yet built); results are metadata-only.'
              : ''
          const results = result.results.map((item) => {
            const output: JSONObject = {
              path: item.path,
              score: item.score,
              matchedOn: item.matchedOn,
            }
            if (item.indexedHash) output.indexedHash = item.indexedHash
            if (item.symbols) output.symbols = item.symbols
            if (item.headings) output.headings = item.headings
            if (item.matchedSnippets) output.matchedSnippets = item.matchedSnippets
            if (item.relatedFiles) {
              output.relatedFiles = item.relatedFiles.map((related) => {
                const relatedOutput: JSONObject = {
                  path: related.path,
                  score: related.score,
                  reason: related.reason,
                }
                if (related.via) relatedOutput.via = related.via
                return relatedOutput
              })
            }
            if (item.explanation) output.explanation = item.explanation
            return output
          })
          const snapshot: JSONObject | undefined = result.snapshot
            ? {
                schemaVersion: result.snapshot.schemaVersion,
                snapshotId: result.snapshot.snapshotId,
                indexVersion: result.snapshot.indexVersion,
                builtAt: result.snapshot.builtAt,
                ...(result.snapshot.workspaceRevision !== undefined
                  ? { workspaceRevision: result.snapshot.workspaceRevision }
                  : {}),
              }
            : undefined
          return [
            {
              type: 'json',
              value: {
                kind: 'query_index_result',
                schemaVersion: 1,
                results,
                totalIndexed: result.totalIndexed,
                indexAge: result.indexAge,
                indexMutationEpoch: manager.indexMutationEpoch,
                ...(snapshot ? { snapshot } : {}),
                status: result.status as unknown as JSONObject,
                message: `${result.status.message} Found ${result.results.length} indexed file result(s).${semanticNotice}`,
              } as JSONObject,
            },
          ]
          },
        },
      }, providerResult.status === 'available' ? providerResult.release : undefined)
    } catch (error) {
      if (providerResult.status === 'available') await providerResult.release()
      throw error
    }
    if (generation === clientGeneration) {
      clientInstance = client
      return client
    }
    await client.retire()
    return getCodebuffClient()
  }

  clientPromise = create().finally(() => {
    if (generation === clientGeneration) clientPromise = null
  })
  return clientPromise
}
