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
              'Exact structural snapshot id to bind into the audit shard receipt. When it is absent or blank the findings artifact is still written, but the result carries no snapshot-bound structuralReceipt, so the shard cannot claim snapshot-bound coverage.',
          },
        },
      },
    },
    outputMode: 'structured_output',
    outputSchema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description:
            'The requested answer, or for an audit shard the compact write_audit_findings receipt summary. This is the field the parent agent reads, so put the substance here rather than in prose outside the tool call.',
        },
        artifacts: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Project-relative paths this agent persisted (e.g. the findings artifact path).',
        },
        coveredSubsystems: { type: 'array', items: { type: 'string' } },
        coveredFeatures: { type: 'array', items: { type: 'string' } },
        unresolved: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Anything the shard could not verify, so the parent does not assume coverage.',
        },
        harvestedFromFallback: {
          type: 'boolean',
          description:
            'Set by the runtime fallback when the answer had to be harvested from assistant text instead of an explicit set_output call.',
        },
        noHarvestedAnswer: {
          type: 'boolean',
          description:
            'Set by the runtime fallback when the harvest recovered no answer text at all, so summary is only a placeholder. It marks the run as answerless, which is why such a harvest never stands in for an explicit completion.',
        },
        error: {
          type: 'string',
          description:
            'Set by the runtime fallback when the agent state already recorded a step error, so the failure reaches the parent alongside the harvested summary instead of being swallowed.',
        },
      },
      required: ['summary'],
    },
    spawnableAgents: buildArray(
      'researcher-web',
      'researcher-docs',
      !isGpt5 && 'file-picker',
      'context-pruner',
    ),
    toolNames: [
      'spawn_agents',
      'query_index',
      'read_files',
      'read_subtree',
      'read_outline',
      'glob',
      'list_directory',
      'code_search',
      'task_completed',
      'write_audit_findings',
      'set_output',
    ],
    filesystemScope: {
      read: ['**/*'],
      write: ['.agents/sessions/*/findings/*.md'],
    },
    programmaticToolNames: ['spawn_agent_inline'],

    instructionsPrompt: buildArray(
      `Use the spawn_agents tool to spawn agents to help you complete the user request.`,
      `For broad codebase questions or tasks where relevant files are not already obvious, call query_index early yourself to get indexed file candidates, then verify the best candidates with read_files/read_subtree and/or spawn file-picker agents as needed. Use query_index mode: 'explain' when you need ranking rationale, mode: 'neighbors' to expand around a known file, mode: 'path' to connect two known files, and mode: 'commands' to find package scripts, CI workflows, task runners, and validation docs. Do not rely on query_index alone for correctness. Use \`glob\` to find files by path pattern, \`list_directory\` to inspect a directory's entries, and \`read_outline\` to get a file's structure before a full read.`,
      !isGpt5 &&
        `If indexed evidence leaves explicit coverage gaps, spawn bounded parallel waves of non-overlapping file-picker/researcher tasks. Join each wave before deciding whether more coverage is needed; do not restart the same discovery through multiple agent layers.`,
      `File-picker is a discovery-only helper. Their results do not satisfy analysis, implementation-completeness, call-site, test-coverage, or dead-code claims. Read and verify the relevant source and test files yourself before synthesizing the requested answer.`,
      `For ripgrep-style content search, call \`code_search\` directly (pattern/flags/cwd/maxResults). For several patterns, issue one \`code_search\` call per pattern rather than delegating the search.`,
      `When params.sessionSlug and params.shardId are provided, this is a durable audit shard: analyze the assigned files and call write_audit_findings exactly once with structured findings and full subsystem/feature/file/domain coverage. That is required with or without params.snapshotId. When params.snapshotId is present it is the exact inspect_codebase_structure snapshot; copy it into write_audit_findings.snapshotId verbatim, which is what yields the snapshot-bound structuralReceipt the parent's coverage check consumes. When params.snapshotId is absent or blank, still write the artifact: the result then carries no structuralReceipt, so say so explicitly in your summary instead of claiming snapshot-bound coverage. If the write is rejected because the artifact already exists, distinguish the two collisions. When the rejection result carries the already-persisted marker together with the compact artifact receipt, the artifact on disk is byte-identical to this call's rendered findings, so this call's findings are the persisted ones: treat it as an idempotent success, report that existing artifact path in your summary, and do NOT write a second artifact under a suffixed shard id. When the rejection instead says the existing artifact's contents are not this call's findings, nothing from this call is persisted, so persist these findings under a distinct shard id to obtain a composable coverage receipt. Return only its compact artifact receipt and do not repeat findings in your final response.`,
      `Finish by calling set_output with summary (plus artifacts, coveredSubsystems, coveredFeatures, and unresolved when they apply). The parent agent reads your structured output rather than your prose, and prose outside the tool call may be compacted away, so put the substance of the answer or the compact audit receipt in summary.`,
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
      }

      let latestAgentStateForPruner = initialAgentState as
        | {
            contextTokenCount?: number
            contextWindowTokens?: number
            messageHistory?: unknown[]
          }
        | undefined
      let auditCompletionRetries = 0
      let didRunPrunerOnce = false
      // Local closures: this generator is serialized for sandbox execution, so
      // they must not reference module-level bindings; the runtime notice tag
      // literals are inlined here for the same reason.
      const harvestedAnswerText = (messageHistory: unknown): string => {
        if (!Array.isArray(messageHistory)) return ''
        // Mirrors getLastAssistantTurnMessages: from the last assistant
        // message, walk backwards while messages stay assistant so the whole
        // trailing assistant turn is harvested, not only its last message.
        let turnEnd = -1
        for (let index = messageHistory.length - 1; index >= 0; index--) {
          const message = messageHistory[index] as
            | { role?: unknown }
            | undefined
          if (message && message.role === 'assistant') {
            turnEnd = index
            break
          }
        }
        if (turnEnd < 0) return ''
        let turnStart = turnEnd
        while (turnStart > 0) {
          const previous = messageHistory[turnStart - 1] as
            | { role?: unknown }
            | undefined
          if (!previous || previous.role !== 'assistant') break
          turnStart--
        }
        const messageTexts: string[] = []
        for (let index = turnStart; index <= turnEnd; index++) {
          const message = messageHistory[index] as
            | { content?: unknown; tags?: unknown }
            | undefined
          if (!message) continue
          // A runtime terminal notice (step cap, tool-call error) is never the
          // model's answer, so it must never be reported as one.
          const tags = Array.isArray(message.tags)
            ? (message.tags as unknown[])
            : []
          if (
            tags.includes('STEP_CAP_REACHED') ||
            tags.includes('TOOL_CALL_ERROR')
          ) {
            continue
          }
          const content = message.content
          const text = Array.isArray(content)
            ? content
                .filter(
                  (part) =>
                    part &&
                    part.type === 'text' &&
                    typeof part.text === 'string',
                )
                .map((part) => part.text)
                .join('')
            : typeof content === 'string'
              ? content
              : ''
          if (text) messageTexts.push(text)
        }
        return messageTexts
          .join('\n')
          .replace(/<think>[\s\S]*?<\/think>/g, '')
          .replace(/<think>[\s\S]*$/, '')
          .trim()
      }
      // structured_output: the parent reads the structured output, so every
      // exit must report something non-empty rather than leaving value: null.
      // The placeholder below is NOT an answer, so both exits pair it with an
      // explicit noHarvestedAnswer marker: the runtime credits a harvest as
      // explicit completion only when it recovered real answer text.
      const harvestedSummary = (
        harvestedText: string,
        atStepCap: boolean,
      ): string =>
        harvestedText ||
        (atStepCap
          ? 'No answer text was produced before this agent hit its step cap, so there is no harvested final answer to report.'
          : 'No answer text was produced before this agent finished, so there is no harvested final answer to report.')
      // The output is only a real answer when it carries a non-empty string
      // summary, which is this agent's one required output field. Anything else
      // — undefined, a non-object, or the `{ ...output, error }` object the
      // programmatic-step failure path stamps after a handleSteps tool error —
      // would reach the parent with no answer at all, so it is harvested.
      const needsHarvestedAnswer = (output: unknown): boolean => {
        if (!output || typeof output !== 'object' || Array.isArray(output)) {
          return true
        }
        const summary = (output as { summary?: unknown }).summary
        return typeof summary !== 'string' || summary.trim() === ''
      }
      // Harvesting over an error-only output must not swallow the failure, so
      // the recorded error is carried into the emitted set_output.
      const recordedOutputError = (output: unknown): string => {
        if (!output || typeof output !== 'object' || Array.isArray(output)) {
          return ''
        }
        const error = (output as { error?: unknown }).error
        return typeof error === 'string' && error.trim() ? error : ''
      }
      while (true) {
        const tokenCount = latestAgentStateForPruner?.contextTokenCount ?? 0
        const windowTokens = latestAgentStateForPruner?.contextWindowTokens
        const msgLen = Array.isArray(latestAgentStateForPruner?.messageHistory)
          ? latestAgentStateForPruner.messageHistory.length
          : 0
        const shouldRunPruner =
          !didRunPrunerOnce ||
          tokenCount > 100_000 ||
          msgLen > 30 ||
          (typeof windowTokens === 'number' &&
            windowTokens > 0 &&
            tokenCount > windowTokens * 0.65)
        if (shouldRunPruner) {
          didRunPrunerOnce = true
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
            output?: unknown
            contextTokenCount?: number
            contextWindowTokens?: number
          }
        }
        if (stepResult?.agentState) {
          latestAgentStateForPruner =
            stepResult.agentState as typeof latestAgentStateForPruner
        }
        if ((stepResult as { hitStepCap?: boolean }).hitStepCap) {
          // An answer written only as assistant text, or an output that only
          // records a step error, would reach the parent without a summary, so
          // harvest it before giving up. An explicit set_output that carries a
          // real summary is never overwritten.
          const cappedOutput = stepResult.agentState?.output
          if (needsHarvestedAnswer(cappedOutput)) {
            const harvestedText = harvestedAnswerText(
              stepResult.agentState?.messageHistory,
            )
            const recordedError = recordedOutputError(cappedOutput)
            yield {
              toolName: 'set_output',
              input: {
                summary: harvestedSummary(harvestedText, true),
                harvestedFromFallback: true,
                // Nothing was recovered, so the summary is only a placeholder:
                // mark the run answerless instead of letting the harvest stand
                // in for the explicit completion that never happened.
                ...(harvestedText ? {} : { noHarvestedAnswer: true }),
                ...(recordedError ? { error: recordedError } : {}),
              },
              includeToolCall: false,
            }
          }
          break
        }
        if (!stepResult.stepsComplete) continue

        const sessionSlug =
          typeof params?.sessionSlug === 'string'
            ? params.sessionSlug.trim()
            : ''
        const shardId =
          typeof params?.shardId === 'string' ? params.shardId.trim() : ''
        const snapshotId =
          typeof params?.snapshotId === 'string' ? params.snapshotId.trim() : ''
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
        // Same harvest on the ordinary exit: a text-only answer, or an output
        // that only records a step error, must still reach the parent as
        // structured output with a usable summary.
        const completedOutput = stepResult.agentState?.output
        if (needsHarvestedAnswer(completedOutput)) {
          const harvestedText = harvestedAnswerText(
            stepResult.agentState?.messageHistory,
          )
          const recordedError = recordedOutputError(completedOutput)
          yield {
            toolName: 'set_output',
            input: {
              summary: harvestedSummary(harvestedText, false),
              harvestedFromFallback: true,
              // Same answerless marker on the ordinary exit: an agent that
              // finished without producing any answer text is a retryable
              // partial for the parent, not a completed run.
              ...(harvestedText ? {} : { noHarvestedAnswer: true }),
              ...(recordedError ? { error: recordedError } : {}),
            },
            includeToolCall: false,
          }
        }
        break
      }
    },
  }
}

const definition: SecretAgentDefinition = {
  ...createGeneralAgent({ model: 'opus' }),
  id: 'general-agent',
}

export default definition
