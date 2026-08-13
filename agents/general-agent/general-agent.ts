import { buildArray } from '@codebuff/common/util/array'
import { containsStructuralAuditReceipt } from '@codebuff/common/util/audit-receipt'

import { publisher } from '../constants'

import type { SecretAgentDefinition } from '../types/secret-agent-definition'

export const createGeneralAgent = (options: {
  model: 'gpt-5' | 'opus'
}): Omit<SecretAgentDefinition, 'id'> => {
  const { model } = options
  const isGpt5 = model === 'gpt-5'

  return {
    publisher,
    ...(isGpt5 && {
      reasoningOptions: {
        effort: 'high' as const,
      },
    }),
    displayName: isGpt5 ? 'Deep Reasoning General Agent' : 'General Agent',
    spawnerPrompt: isGpt5
      ? 'A general-purpose, deep-thinking (and slow) agent that can be used to solve a wide range of problems. Use this to help you solve a specific problem that requires extended reasoning. This agent has no context on the conversation history so it cannot see files you have read or previous discussion. Instead, you must provide all the relevant context via the prompt or filePaths for this agent to work well.'
      : 'A general-purpose capable agent that can be used to solve a wide range of problems. Use this to help you solve any problem. This agent has no context on the conversation history so it cannot see files you have read or previous discussion. Instead, you must provide all the relevant context via the prompt or filePaths for this agent to work well.',
    inputSchema: {
      prompt: {
        type: 'string',
        description: 'The problem you are trying to solve',
      },
      params: {
        type: 'object',
        properties: {
          filePaths: {
            type: 'array',
            items: {
              type: 'string',
              description: 'The path to a file',
            },
            description:
              'Concrete file paths to read before thinking. Directory paths are accepted for compatibility and routed through read_subtree, but directoryPaths is preferred.',
          },
          directoryPaths: {
            type: 'array',
            items: {
              type: 'string',
              description: 'The path to a directory',
            },
            description:
              'Directory paths to inventory with read_subtree before analysis. Read the relevant files discovered inside them before completing.',
          },
          sessionSlug: {
            type: 'string',
            description:
              'Durable audit session slug. When present with shardId, persist findings with write_audit_findings.',
          },
          shardId: {
            type: 'string',
            description:
              'Unique audit shard id used for the findings artifact filename.',
          },
          snapshotId: {
            type: 'string',
            description:
              'Exact structural snapshot id to bind into the audit shard receipt. Required whenever sessionSlug and shardId are present: when it is absent or blank, the shard stays unbound-by-snapshot and must fail closed, with write_audit_findings rejected.',
          },
        },
      },
    },
    outputMode: 'last_message',
    spawnableAgents: buildArray(
      'researcher-web',
      'researcher-docs',
      !isGpt5 && 'file-picker',
      'code-searcher',
      'context-pruner',
    ),
    toolNames: [
      'spawn_agents',
      'query_index',
      'read_files',
      'read_subtree',
      'code_search',
      'task_completed',
      'write_audit_findings',
    ],
    filesystemScope: {
      read: ['**/*'],
      write: ['.agents/sessions/*/findings/*.md'],
    },
    programmaticToolNames: ['spawn_agent_inline'],

    instructionsPrompt: buildArray(
      `Use the spawn_agents tool to spawn agents to help you complete the user request.`,
      `For broad codebase questions or tasks where relevant files are not already obvious, call query_index early yourself to get indexed file candidates, then verify the best candidates with read_files/read_subtree and/or spawn file-picker/code-searcher agents as needed. Use query_index mode: 'explain' when you need ranking rationale, mode: 'neighbors' to expand around a known file, mode: 'path' to connect two known files, and mode: 'commands' to find package scripts, CI workflows, task runners, and validation docs. Do not rely on query_index alone for correctness.`,
      !isGpt5 &&
        `If indexed evidence leaves explicit coverage gaps, spawn bounded parallel waves of non-overlapping file-picker/code-searcher/researcher tasks. Join each wave before deciding whether more coverage is needed; do not restart the same discovery through multiple agent layers.`,
      `File-picker and code-searcher are discovery-only helpers. Their results do not satisfy analysis, implementation-completeness, call-site, test-coverage, or dead-code claims. Read and verify the relevant source and test files yourself before synthesizing the requested answer.`,
      `For ripgrep-style content search, prefer direct \`code_search\` for single-pattern work (pattern/flags/cwd/maxResults). Spawn code-searcher only for multi-query batch search, and pass required \`params.searchQueries\` (an array of { pattern } objects, e.g. { "params": { "searchQueries": [{ "pattern": "createUser", "flags": "-g *.ts" }] } }); put it in \`params\`, not only in the prose prompt.`,
      `When params.sessionSlug and params.shardId are provided, this is a durable audit shard. params.snapshotId must be the exact inspect_codebase_structure snapshot; copy it into write_audit_findings.snapshotId. If params.snapshotId is absent or blank, the shard is unbound-by-snapshot and fails closed: do not call write_audit_findings (its snapshot-bound structural receipt cannot satisfy the completion gate); instead analyze the assigned files and return your findings inline. Analyze the assigned files, call write_audit_findings exactly once with structured findings and full subsystem/feature/file/domain coverage, then return only its compact artifact receipt, including structuralReceipt. Do not repeat findings in your final response.`,
      `Do not stop after announcing a tool call or delegating discovery. In the same final response that contains the requested answer or compact audit receipt, call task_completed. Never call task_completed while required reads, synthesis, coverage, or audit artifact persistence remain unfinished.`,
    ).join('\n'),

    handleSteps: function* ({
      prompt,
      params,
      agentState: initialAgentState,
    }: any) {
      const filePaths = params?.filePaths as string[] | undefined
      const directoryPaths = params?.directoryPaths as string[] | undefined

      function isLikelyFilePath(value: string): boolean {
        const basename =
          value.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? ''
        if (!basename) return false
        if (
          /^(?:README|LICENSE|LICENCE|COPYING|NOTICE|Dockerfile|Containerfile|Makefile|Procfile)(?:\..*)?$/i.test(
            basename,
          )
        ) {
          return true
        }
        return !basename.startsWith('.') && basename.includes('.')
      }

      const requestedPaths = [...new Set(filePaths ?? [])]
      const concreteFiles = requestedPaths.filter(isLikelyFilePath)
      const discoveredDirectories = [
        ...new Set([
          ...(directoryPaths ?? []),
          ...requestedPaths.filter((value) => !isLikelyFilePath(value)),
        ]),
      ]

      if (discoveredDirectories.length > 0) {
        yield {
          toolName: 'read_subtree',
          input: { paths: discoveredDirectories, maxTokens: 10_000 },
        }
      }
      if (concreteFiles.length > 0) {
        yield {
          toolName: 'read_files',
          input: { paths: concreteFiles },
        }
      } else if (
        discoveredDirectories.length === 0 &&
        shouldProactivelyQueryIndex(prompt)
      ) {
        yield {
          toolName: 'query_index',
          input: {
            query: prompt,
            limit: 20,
          },
        }
      }

      let latestAgentStateForPruner = initialAgentState as
        | {
            contextTokenCount?: number
            contextWindowTokens?: number
            messageHistory?: unknown[]
          }
        | undefined
      let auditCompletionRetries = 0
      while (true) {
        const tokenCount = latestAgentStateForPruner?.contextTokenCount ?? 0
        const windowTokens = latestAgentStateForPruner?.contextWindowTokens
        const msgLen = Array.isArray(latestAgentStateForPruner?.messageHistory)
          ? latestAgentStateForPruner.messageHistory.length
          : 0
        const shouldRunPruner =
          tokenCount > 100_000 ||
          msgLen > 30 ||
          (typeof windowTokens === 'number' &&
            windowTokens > 0 &&
            tokenCount > windowTokens * 0.65)
        if (shouldRunPruner) {
          yield {
            toolName: 'spawn_agent_inline',
            input: {
              agent_type: 'context-pruner',
              params: params ?? {},
            },
            includeToolCall: false,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- secret-only tool; see comment above
          } as any
        }

        const stepResult = yield 'STEP' as unknown as {
          stepsComplete: boolean
          hitStepCap?: boolean
          agentState?: {
            messageHistory?: unknown[]
            contextTokenCount?: number
            contextWindowTokens?: number
          }
        }
        if (stepResult?.agentState) {
          latestAgentStateForPruner =
            stepResult.agentState as typeof latestAgentStateForPruner
        }
        if ((stepResult as { hitStepCap?: boolean }).hitStepCap) break
        if (!stepResult.stepsComplete) continue

        const sessionSlug =
          typeof params?.sessionSlug === 'string'
            ? params.sessionSlug.trim()
            : ''
        const shardId =
          typeof params?.shardId === 'string' ? params.shardId.trim() : ''
        const snapshotId =
          typeof params?.snapshotId === 'string'
            ? params.snapshotId.trim()
            : ''
        const expectedSnapshotId = snapshotId
        const auditRequested = Boolean(sessionSlug && shardId && snapshotId)
        if (
          auditRequested &&
          !containsStructuralAuditReceipt(
            stepResult.agentState?.messageHistory,
            expectedSnapshotId,
          ) &&
          auditCompletionRetries < 2
        ) {
          auditCompletionRetries++
          yield {
            toolName: 'add_message',
            input: {
              role: 'user',
              content:
                '<system>Audit completion was rejected: no successful write_audit_findings result with a structuralReceipt is present. Finish the assigned source/test verification, call write_audit_findings with the exact sessionSlug, shardId, snapshotId, files, subsystem/feature coverage, and domains, then return its compact receipt and call task_completed in the same response.</system>',
            },
            includeToolCall: false,
          }
          continue
        }
        break
      }

      function shouldProactivelyQueryIndex(value: unknown): value is string {
        if (typeof value !== 'string') return false
        const text = value.trim()
        if (text.length < 12) return false
        if (/^(hi|hello|hey|thanks|thank you|ok|okay)$/i.test(text))
          return false
        return /\b(code|file|files|repo|repository|project|codebase|workspace|module|package|function|class|component|hook|api|schema|config|test|tests|implement|fix|debug|refactor)\b/i.test(
          text,
        )
      }
    },
  }
}

const definition: SecretAgentDefinition = {
  ...createGeneralAgent({ model: 'opus' }),
  id: 'general-agent',
}

export default definition
