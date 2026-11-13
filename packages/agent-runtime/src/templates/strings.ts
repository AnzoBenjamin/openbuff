import { KNOWLEDGE_FILE_NAMES_LOWERCASE } from '@codebuff/common/constants/knowledge'
import { frontendSection } from '@codebuff/common/constants/prompt-sections'
import { formatLanguageProfilePromptForFileTree } from '@codebuff/common/util/language-profiles'
import { formatEngineProfilePromptForFileTree } from '@codebuff/common/util/engine-profiles'
import {
  BROAD_AUDIT_FALLBACK_SECTIONS,
  FALLBACK_GUIDES,
  findMissingGuides,
  formatGuideFallbackSection,
} from '@codebuff/common/util/guides'
import {
  formatPatternsIndexPrompt,
  loadPatternsIndex,
} from '@codebuff/common/util/patterns'
import {
  formatRoutedKnowledgeSection,
  getKnowledgeBudgetChars,
  inferKnowledgeTaskType,
  loadRoutedKnowledgeContents,
  loadRouterTable,
} from '@codebuff/common/util/router'
import {
  dedupeInstructionContents,
  expandWithInstructionImports,
  selectAlwaysOnInstructionFiles,
} from '@codebuff/common/util/instruction-files'
import { escapeString } from '@codebuff/common/util/string'
import { z } from 'zod/v4'

import { getAgentTemplate } from './agent-registry'
import {
  buildFullSpawnableAgentsSpec,
  formatCompactAgentCatalogLine,
  formatGenericAgentInputContract,
  getModelVisibleSpawnableAgents,
} from './prompts'
import { PLACEHOLDER, placeholderValues } from './types'
import {
  getGitChangesPrompt,
  getProjectFileTreePrompt,
  getSystemInfoPrompt,
} from '../system-prompt/prompts'
import { applyMeasure } from '../util/context-budget'
import { parseUserMessage } from '../util/messages'

import type { AgentTemplate, PlaceholderValue } from './types'
import type { ResolveModelContextWindow } from './prompts'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ContextBudgetLedger } from '../util/context-budget'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'
import type {
  Message,
  UserMessage,
} from '@codebuff/common/types/messages/codebuff-message'
import type { TextPart } from '@codebuff/common/types/messages/content-part'
import type {
  AgentState,
  AgentTemplateType,
} from '@codebuff/common/types/session-state'
import type {
  CustomToolDefinitions,
  ProjectFileContext,
} from '@codebuff/common/util/file'
import { fileTreeHasFrontendFiles } from '@codebuff/common/util/file'

export function formatCurrentDate(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date)
}

export async function formatPrompt(
  params: {
    prompt: string
    fileContext: ProjectFileContext
    agentState: AgentState
    tools: readonly string[]
    spawnableAgents: AgentTemplateType[]
    agentTemplates: Record<string, AgentTemplate>
    intitialAgentPrompt?: string
    additionalToolDefinitions: () => Promise<
      ProjectFileContext['customToolDefinitions']
    >
    logger: Logger
    ledger?: ContextBudgetLedger
  } & ParamsExcluding<
    typeof getAgentTemplate,
    'agentId' | 'localAgentTemplates'
  >,
): Promise<string> {
  const {
    fileContext,
    agentState,
    tools: _tools,
    spawnableAgents: _spawnableAgents,
    agentTemplates,
    intitialAgentPrompt,
    additionalToolDefinitions: _additionalToolDefinitions,
    logger,
    ledger,
  } = params
  let { prompt } = params

  const { messageHistory } = agentState
  function isUserInputMessage(message: Message): message is UserMessage & {
    content: [TextPart, ...any[]]
  } {
    return (
      message.role === 'user' &&
      message.content[0].type === 'text' &&
      parseUserMessage(message.content[0].text) !== undefined
    )
  }
  const lastUserMessage = messageHistory.findLast(isUserInputMessage)
  const lastUserInput = lastUserMessage
    ? parseUserMessage(lastUserMessage.content[0].text)
    : undefined

  const agentTemplate = agentState.agentType
    ? await getAgentTemplate({
        ...params,
        agentId: agentState.agentType,
        localAgentTemplates: agentTemplates,
      })
    : null

  // T1.4d embedder guide fallback. base2's pointers name agents/guides/*.md
  // paths that read_files resolves against the EMBEDDER's workspace root, and no
  // publish pipeline ships those guides, so outside this repo the pointer read
  // fails and the relocated section is lost. Detection has to live here
  // (filesystem-capable, keyed on the caller's projectRoot) because the authored
  // prompt is frozen into cli/src/agents/bundled-agents.generated.ts at CLI
  // build time, inside this worktree, where every guide exists. Every provider
  // returns '' in-repo so the resolved prompt stays byte-identical to today.
  //
  // Probed lazily and at most once per formatted prompt: the providers below run
  // only for the placeholders the prompt actually contains, and they share this
  // single filesystem sweep.
  let missingGuidesCache: string[] | undefined
  const missingGuides = (): string[] =>
    (missingGuidesCache ??= findMissingGuides(fileContext.projectRoot))
  // One recovered body per placeholder, so a mode that deliberately omits a
  // pointer (plan mode omits git-discipline) cannot get that body back through
  // recovery. base2 concatenates the placeholders with no separator, so each
  // non-empty block carries its own trailing blank line; an absent guide's block
  // collapses to '' and leaves no seam behind.
  //
  // A recovered body is the largest block this path adds (tens of KB), so record
  // what is actually inserted in the shared ledger the way
  // getProjectFileTreePrompt and getGitChangesPrompt do; a collapsed block
  // records nothing.
  const guideFallback = (guide: string, body?: string): string => {
    const block = formatGuideFallbackSection({
      missing: missingGuides(),
      guide,
      body,
    })
    if (block === '') return ''
    const inserted = `${block}\n\n`
    if (ledger) {
      applyMeasure(ledger, {
        category: 'systemPrompt',
        label: `guide-fallback:${guide}`,
        content: inserted,
      })
    }
    return inserted
  }

  // N08 instruction files. Ancestor and project-root files (and their
  // `@path` imports) are always on; nested ones arrive as messages when the
  // agent touches their directory (run-agent-step). Contexts without load
  // records keep the legacy root-file rendering. Each rendered file is
  // recorded in the ledger as `instruction:<path>` so /context can list it.
  const alwaysOnInstructionEntries = (): Array<readonly [string, string]> => {
    const keys =
      selectAlwaysOnInstructionFiles(fileContext) ??
      Object.keys(fileContext.knowledgeFiles).filter((filePath) =>
        KNOWLEDGE_FILE_NAMES_LOWERCASE.includes(filePath.toLowerCase()),
      )
    return keys
      .filter((key) =>
        Object.prototype.hasOwnProperty.call(fileContext.knowledgeFiles, key),
      )
      .map((key) => [key, fileContext.knowledgeFiles[key]] as const)
  }
  const userInstructionEntries = (): Array<readonly [string, string]> =>
    Object.entries(fileContext.userKnowledgeFiles ?? {})
  const recordInstructionFile = (key: string, content: string) => {
    if (!ledger) return
    applyMeasure(ledger, {
      category: 'knowledge',
      label: `instruction:${key}`,
      content,
    })
  }
  const renderInstructionBlocks = (
    entries: ReadonlyArray<readonly [string, string]>,
    alreadyRenderedContents: Set<string> = new Set(),
  ): string =>
    dedupeInstructionContents(entries)
      .filter(([, content]) => !alreadyRenderedContents.has(content))
      .map(([key, content]) => {
        const block = `\`\`\`${key}\n${content}\n\`\`\``
        recordInstructionFile(key, block)
        return block
      })
      .join('\n\n')

  const toInject: Record<PlaceholderValue, () => string | Promise<string>> = {
    [PLACEHOLDER.AGENT_NAME]: () =>
      agentTemplate ? agentTemplate.displayName || 'Unknown Agent' : 'Buffy',
    // NOTE(P2-T1): CURRENT_DATE is non-persisted prompt content, intentionally NOT
    // clock-injected. If prompt-identical replay is later required, thread Clock here.
    [PLACEHOLDER.CURRENT_DATE]: () => formatCurrentDate(new Date()),
    [PLACEHOLDER.FILE_TREE_PROMPT_SMALL]: () =>
      getProjectFileTreePrompt({
        fileContext,
        fileTreeTokenBudget: 1_750,
        mode: 'agent',
        logger,
        ledger,
      }),
    [PLACEHOLDER.FRONTEND_SECTION]: () =>
      fileTreeHasFrontendFiles(fileContext.fileTree) ? frontendSection : '',
    [PLACEHOLDER.LANGUAGE_PROFILE]: () =>
      formatLanguageProfilePromptForFileTree(fileContext.fileTree, {
        taskText: lastUserInput ?? intitialAgentPrompt ?? '',
        maxProfiles: 3,
      }) + formatEngineProfilePromptForFileTree(fileContext.fileTree),
    [PLACEHOLDER.FILE_TREE_PROMPT]: () =>
      getProjectFileTreePrompt({
        fileContext,
        fileTreeTokenBudget: 10_000,
        mode: 'agent',
        logger,
        ledger,
      }),
    [PLACEHOLDER.FILE_TREE_PROMPT_LARGE]: () =>
      getProjectFileTreePrompt({
        fileContext,
        fileTreeTokenBudget: 190_000,
        mode: 'search',
        logger,
        ledger,
      }),
    [PLACEHOLDER.GIT_CHANGES_PROMPT]: () =>
      getGitChangesPrompt(fileContext, ledger),
    [PLACEHOLDER.REMAINING_STEPS]: () =>
      agentState.stepsRemaining < 0 ? 'unlimited' : `${agentState.stepsRemaining}`,
    [PLACEHOLDER.PROJECT_ROOT]: () => fileContext.projectRoot,
    [PLACEHOLDER.SYSTEM_INFO_PROMPT]: () =>
      getSystemInfoPrompt(fileContext, ledger),
    [PLACEHOLDER.USER_CWD]: () => fileContext.cwd,
    [PLACEHOLDER.USER_INPUT_PROMPT]: () => escapeString(lastUserInput ?? ''),
    [PLACEHOLDER.INITIAL_AGENT_PROMPT]: () =>
      escapeString(intitialAgentPrompt ?? ''),
    [PLACEHOLDER.KNOWLEDGE_FILES_CONTENTS]: () =>
      renderInstructionBlocks([
        ...alwaysOnInstructionEntries(),
        ...userInstructionEntries(),
      ]),
    [PLACEHOLDER.ROUTED_KNOWLEDGE_FILES]: () => {
      // P0.11 task-routed knowledge loader. When `<projectRoot>/ROUTER.md`
      // has an entry for the current agent, render the files that entry
      // lists (with their `@path` imports) inside the task budget. Every
      // other instruction file in effect (ancestor and project-root files
      // plus their imports) follows in full, then the user files, so each
      // file reaches the prompt exactly once (N08: base2 used to render the
      // root and user files twice through KNOWLEDGE_FILES_CONTENTS as well).
      const routerTable = loadRouterTable(fileContext.projectRoot, logger)
      const taskType = inferKnowledgeTaskType(lastUserInput)
      const routeKey = agentTemplate?.id
        ? [`${agentTemplate.id}:${taskType}`, agentTemplate.id].find((key) =>
            Object.prototype.hasOwnProperty.call(routerTable, key),
          )
        : undefined
      const blocks: string[] = []
      const rendered = new Set<string>()
      const renderedContents = new Set<string>()
      if (routeKey) {
        const routedFiles = routerTable[routeKey]
        const routedContents = loadRoutedKnowledgeContents({
          projectRoot: fileContext.projectRoot,
          files: routedFiles,
          knowledgeFiles: fileContext.knowledgeFiles,
          logger,
        })
        const withImports = expandWithInstructionImports(
          fileContext,
          routedFiles,
        )
        for (const key of withImports) {
          if (
            !(key in routedContents) &&
            Object.prototype.hasOwnProperty.call(fileContext.knowledgeFiles, key)
          ) {
            routedContents[key] = fileContext.knowledgeFiles[key]
          }
        }
        const routedEntries = dedupeInstructionContents(
          withImports
            .filter((key) => key in routedContents)
            .map((key) => [key, routedContents[key]] as const),
        )
        const projectSection = formatRoutedKnowledgeSection({
          files: routedEntries.map(([key]) => key),
          knowledgeFiles: Object.fromEntries(routedEntries),
          maxChars: getKnowledgeBudgetChars(taskType),
        })
        if (projectSection) {
          blocks.push(projectSection)
          for (const [key, content] of routedEntries) {
            rendered.add(key)
            renderedContents.add(content)
            recordInstructionFile(key, content)
          }
        }
      }
      const rest = renderInstructionBlocks(
        [...alwaysOnInstructionEntries(), ...userInstructionEntries()].filter(
          ([key]) => !rendered.has(key),
        ),
        renderedContents,
      )
      if (rest) blocks.push(rest)
      return blocks.join('\n\n')
    },
    [PLACEHOLDER.PATTERNS_INDEX]: () => {
      // P1.14 patterns library. Renders a compact catalog of available
      // pattern guides from `agents/patterns/INDEX.md`. Individual pattern
      // files are NOT loaded here — agents `read_files` the specific pattern
      // on demand when a task matches. Returns '' when the index is absent
      // or empty so the placeholder collapses cleanly.
      const index = loadPatternsIndex(fileContext.projectRoot, logger)
      return formatPatternsIndexPrompt({ index })
    },
    [PLACEHOLDER.ON_DEMAND_GUIDE_FALLBACK_CODE_CRAFTSMANSHIP]: () =>
      guideFallback(FALLBACK_GUIDES.codeCraftsmanship),
    [PLACEHOLDER.ON_DEMAND_GUIDE_FALLBACK_PRE_REVIEW_SELF_CHECK]: () =>
      guideFallback(FALLBACK_GUIDES.preReviewSelfCheck),
    [PLACEHOLDER.ON_DEMAND_GUIDE_FALLBACK_GIT_DISCIPLINE]: () =>
      guideFallback(FALLBACK_GUIDES.gitDiscipline),
    [PLACEHOLDER.ON_DEMAND_GUIDE_FALLBACK_SECURITY_REVIEW]: () =>
      guideFallback(FALLBACK_GUIDES.securityReview),
    [PLACEHOLDER.ON_DEMAND_GUIDE_FALLBACK_SPECIALIST_ROUTING]: () =>
      guideFallback(FALLBACK_GUIDES.specialistRouting),
    // The broad-audit body is clause-parameterized: base2 emits the
    // implementation-clause placeholder on the implementation/execute-plan
    // surfaces and the plan-clause one in plan mode, so the recovered body can
    // never contradict the finalize clause that surface's pointer emitted.
    [PLACEHOLDER.ON_DEMAND_GUIDE_FALLBACK_BROAD_AUDIT]: () =>
      guideFallback(
        FALLBACK_GUIDES.broadAudit,
        BROAD_AUDIT_FALLBACK_SECTIONS[
          'proceed to implementation or the answer'
        ],
      ),
    [PLACEHOLDER.ON_DEMAND_GUIDE_FALLBACK_BROAD_AUDIT_PLAN]: () =>
      guideFallback(
        FALLBACK_GUIDES.broadAudit,
        BROAD_AUDIT_FALLBACK_SECTIONS[
          'translate the findings into the durable plan packet below'
        ],
      ),
  }

  for (const varName of placeholderValues) {
    // Skip providers for placeholders that are absent from the prompt.
    // Besides avoiding wasted work (e.g. building unused file trees), this
    // keeps the shared ledger honest: providers record a ledger line when
    // they run, so running a provider whose block is never inserted would
    // inflate totalTokens/byCategory with tokens that never reach the model.
    if (!prompt.includes(varName)) continue
    const valueProvider = toInject[varName] ?? (() => '')
    const value = await valueProvider()
    prompt = prompt.replaceAll(varName, value)
  }
  return prompt
}
type StringField = 'systemPrompt' | 'instructionsPrompt' | 'stepPrompt'

export async function getAgentPrompt<T extends StringField>(
  params: {
    agentTemplate: AgentTemplate
    promptType: { type: T }
    fileContext: ProjectFileContext
    agentState: AgentState
    agentTemplates: Record<string, AgentTemplate>
    additionalToolDefinitions: () => Promise<CustomToolDefinitions>
    logger: Logger
    useParentTools?: boolean
    /** Injected by the runtime (BYOK routing). Absent for tests and non-BYOK
     * callers, in which case the catalog output stays byte-identical. */
    resolveModelContextWindow?: ResolveModelContextWindow
  } & ParamsExcluding<
    typeof formatPrompt,
    'prompt' | 'tools' | 'spawnableAgents'
  > &
    ParamsExcluding<
      typeof buildFullSpawnableAgentsSpec,
      'spawnableAgents' | 'agentTemplates'
    >,
): Promise<string | undefined> {
  const {
    agentTemplate,
    promptType,
    agentState,
    agentTemplates,
    additionalToolDefinitions: _additionalToolDefinitions,
    useParentTools,
  } = params

  const { toolNames, outputSchema, programmaticToolNames } = agentTemplate
  const spawnableAgents = getModelVisibleSpawnableAgents(
    agentTemplate.spawnableAgents,
  )
  const promptValue = agentTemplate[promptType.type]

  let prompt = await formatPrompt({
    ...params,
    prompt: promptValue,
    tools: toolNames,
    spawnableAgents,
  })

  let addendum = ''

  if (promptType.type === 'stepPrompt' && agentState.agentType && prompt) {
    // Put step prompt within a system_reminder tag so agent doesn't think the user just spoke again.
    prompt = `<system_reminder>${prompt}</system_reminder>`
  }

  // Add tool instructions, spawnable agents, and output schema prompts to instructionsPrompt
  if (promptType.type === 'instructionsPrompt' && agentState.agentType) {
    const isInheritedSubagentPrompt =
      agentTemplate.inheritParentSystemPrompt &&
      agentState.parentId !== undefined

    // Add subagent tools message when using parent's tools for prompt caching
    if (isInheritedSubagentPrompt) {
      addendum += `\n\nYou are a subagent that only has access to the following tools: ${toolNames.length > 0 ? toolNames.join(', ') : 'none'}. Previously referenced tools in the conversation may have only been available to the parent agent. Do not attempt to use any other tools besides these listed here. You will only get tool errors if you do.`

      // For subagents with inheritSystemPrompt, include full spawnable agents spec
      // since the parent's system prompt may not have these agents listed
      if (useParentTools && spawnableAgents.length > 0) {
        const spawnableAgentsSpec = await buildFullSpawnableAgentsSpec({
          ...params,
          spawnableAgents,
          agentTemplates,
        })
        addendum += `\n\n${spawnableAgentsSpec}`
      }
    } else if (spawnableAgents.length > 0) {
      // Keep a compact capability catalog regardless of whether agents are
      // exposed as direct native tools or routed through generic spawn_agents.
      const agentDescriptions = await Promise.all(
        spawnableAgents.map(async (agentType) => {
          const template = await getAgentTemplate({
            ...params,
            agentId: agentType,
            localAgentTemplates: agentTemplates,
          })
          const line = formatCompactAgentCatalogLine(
            agentType,
            template,
            params.resolveModelContextWindow?.({
              agentId: template?.id ?? agentType,
              model: template?.model,
            }),
          )
          return agentTemplate.spawnableAgentToolMode === 'generic' && template
            ? `${line}\n${formatGenericAgentInputContract(agentType, template)}`
            : line
        }),
      )
      addendum += `\n\nYou can spawn the following agents:\n\n${agentDescriptions.join('\n')}`
    }

    // Add output schema information if defined
    if (outputSchema) {
      addendum += '\n\n## Output Schema\n\n'
      const setOutputIsProgrammaticOnly =
        (programmaticToolNames ?? []).includes('set_output') &&
        !toolNames.includes('set_output')
      addendum += setOutputIsProgrammaticOnly
        ? 'The harvested plain-text result must match this schema. Do not call set_output just to publish. You may still pass fields either directly as top-level parameters or inside a `data` field if a tool is used — both are accepted. Pass native object values; never call JSON.stringify or put serialized JSON text inside `data`.\n\n'
        : 'When using the set_output tool, your output must conform to this schema. You may pass the fields either directly as top-level parameters or inside a `data` field — both are accepted. Pass native object values; never call JSON.stringify or put serialized JSON text inside `data`.\n\n'
      addendum += '```json\n'
      try {
        // Convert Zod schema to JSON schema for display
        const jsonSchema = z.toJSONSchema(outputSchema, {
          io: 'input',
        })
        delete jsonSchema['$schema'] // Remove the $schema field for cleaner display
        addendum += JSON.stringify(jsonSchema, null, 2)
      } catch {
        // Fallback to a simple description
        addendum += JSON.stringify(
          { type: 'object', description: 'Output schema validation enabled' },
          null,
          2,
        )
      }
      addendum += '\n```'
    }
  }

  const combinedPrompt = (prompt + addendum).trim()
  if (combinedPrompt === '') {
    return undefined
  }

  return combinedPrompt
}
