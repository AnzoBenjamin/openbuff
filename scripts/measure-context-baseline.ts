/**
 * Milestone 0 — Context Budget Baseline Measurement (production-faithful)
 *
 * Measures the per-component token cost of the orchestrator's fixed per-turn
 * baseline using real SDK discovery and prompt builders.
 *
 * Production notes (base2 default):
 * - File tree uses FILE_TREE_PROMPT_SMALL (1_750 tok budget), not 10k.
 *   Agent-mode trees are path-only biased (preferPathOnly); LARGE (190k)
 *   remains for search agents with symbol-rich trees.
 * - progressivePromptDisclosure defaults on (M2); authored surface off vs on is
 *   still reported for disclosure savings (comparison only).
 * - Proactive query_index / git_status are first-turn injections, not fixed.
 *
 * Soft phase targets (≤32k / ≤28k / ≤30k / stretch 25k) are advisory only.
 *
 * Usage: bun run scripts/measure-context-baseline.ts
 */

import { countTokens, countTokensJson } from '../packages/agent-runtime/src/util/token-counter'
import {
  getProjectFileTreePrompt,
  getSystemInfoPrompt,
  getGitChangesPrompt,
  knowledgeFilesPrompt,
} from '../packages/agent-runtime/src/system-prompt/prompts'
import { createBase2 } from '../agents/base2/base2'
import { initialSessionState } from '../sdk/src/run-state'
import { DEFAULT_MAX_CONTEXT_TOKENS } from '../packages/agent-runtime/src/util/context-pruning'
import { KNOWLEDGE_FILE_NAMES_LOWERCASE } from '../common/src/constants/knowledge'
import { toolParams } from '../common/src/tools/list'
import type { ToolName } from '../common/src/tools/constants'
import z from 'zod/v4'

import type { ProjectFileContext } from '@codebuff/common/util/file'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { QueryIndexResult } from '../packages/indexer/src/types'

/** Soft phase targets from context-baseline-25k SPEC (advisory; do not fail the script). */
const PHASE1_FIXED_TARGET = 32_000
const PHASE2_FIXED_TARGET = 28_000
const PROGRAM_FIXED_TARGET = 30_000
const STRETCH_FIXED_TARGET = 25_000

/** Production FILE_TREE_PROMPT_SMALL budget in templates/strings.ts. */
const FILE_TREE_SMALL_BUDGET = 1_750
/** Comparison / non-default orchestrator tree budget. */
const FILE_TREE_FULL_BUDGET = 10_000

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

interface Measurement {
  component: string
  tokens: number
  note?: string
  /** Automatic per-turn injection (proactive retrieval, git_status). */
  isInjection?: boolean
  /** Raw systemPrompt template with unreplaced placeholders. */
  isRawTemplate?: boolean
  /** Shown for comparison only; excluded from production fixed sum. */
  isComparisonOnly?: boolean
  /** Contributes to production-faithful default fixed baseline. */
  isProductionFixed?: boolean
}

function authoredSurface(agent: ReturnType<typeof createBase2>): string {
  return [
    (agent.systemPrompt as string | undefined) ?? '',
    (agent.instructionsPrompt as string | undefined) ?? '',
    (agent.stepPrompt as string | undefined) ?? '',
  ].join('\n')
}

/**
 * Renders the per-turn knowledge-file contents block. Mirrors the production
 * PLACEHOLDER.KNOWLEDGE_FILES_CONTENTS provider in
 * packages/agent-runtime/src/templates/strings.ts (the source of truth — that
 * builder is a closure inside formatPrompt and is not exported): root-level
 * knowledgeFiles (filtered via KNOWLEDGE_FILE_NAMES_LOWERCASE) merged with all
 * userKnowledgeFiles, each trimmed and wrapped in a ```path\ncontent\n```
 * block, joined with '\n\n'.
 */
function buildKnowledgeFilesContents(fileContext: ProjectFileContext): string {
  return Object.entries({
    ...Object.fromEntries(
      Object.entries(fileContext.knowledgeFiles)
        .filter(([filePath]) => {
          const lowerPath = filePath.toLowerCase()
          // Root-level knowledge files only (knowledge.md, AGENTS.md, CLAUDE.md)
          return KNOWLEDGE_FILE_NAMES_LOWERCASE.includes(lowerPath)
        })
        .map(([path, content]) => [path, content.trim()]),
    ),
    ...fileContext.userKnowledgeFiles,
  })
    .map(([path, content]) => {
      return `\`\`\`${path}\n${content.trim()}\n\`\`\``
    })
    .join('\n\n')
}

function measureTools(toolNames: string[]): {
  tokens: number
  count: number
} {
  const toolsForTokenCount = toolNames.flatMap((name) => {
    const def = (toolParams as Record<
      string,
      (typeof toolParams)[ToolName] | undefined
    >)[name]
    if (!def) return []
    let input_schema: unknown
    try {
      const schema = (def.providerInputSchema ?? def.inputSchema) as z.ZodType
      input_schema = z.toJSONSchema(schema, { io: 'input' })
    } catch {
      input_schema = { type: 'object', properties: {} }
    }
    return [
      {
        name,
        ...(def.description ? { description: def.description } : {}),
        ...(input_schema ? { input_schema } : {}),
      },
    ]
  })
  return {
    tokens: countTokensJson(toolsForTokenCount),
    count: toolsForTokenCount.length,
  }
}

function formatTargetLine(label: string, target: number, actual: number): string {
  const ok = actual <= target
  return `  ${label.padEnd(36)} ≤ ${target.toLocaleString().padStart(6)}  actual ${actual.toLocaleString().padStart(6)}  ${ok ? 'PASS' : 'OVER'} (advisory)`
}

async function main() {
  const measurements: Measurement[] = []
  let failedMeasurements = 0
  const cwd = process.cwd()

  console.log(
    '=== Context Budget Baseline Measurement (M0 production-faithful) ===',
  )
  console.log(`Project: ${cwd}`)
  console.log(`Date: ${new Date().toISOString()}`)
  console.log('')

  // 1. Build a real session state to get ProjectFileContext fields
  console.log('Building real project context via SDK discovery...')
  let fileContext: ProjectFileContext
  try {
    const sessionState = await initialSessionState({ cwd })
    fileContext = sessionState.fileContext
    console.log('  OK — project context built.')
  } catch (e) {
    console.error('  FAILED to build project context:', e)
    console.error('  Falling back to stub context.')
    failedMeasurements++
    const { getStubProjectFileContext } = await import(
      '@codebuff/common/util/file'
    )
    fileContext = getStubProjectFileContext()
  }

  // 2. base2 raw systemPrompt template (disclosure on = production default / M2)
  let base2Def: ReturnType<typeof createBase2> | undefined
  let rawTemplateTokens = 0
  try {
    base2Def = createBase2('default')
    const rawSystemPrompt = base2Def.systemPrompt ?? ''
    rawTemplateTokens = countTokens(rawSystemPrompt)
    measurements.push({
      component: 'base2 systemPrompt (raw template, disclosure on)',
      tokens: rawTemplateTokens,
      note: `${rawSystemPrompt.length} chars, unreplaced placeholders; createBase2 default`,
      isRawTemplate: true,
      isProductionFixed: true,
    })
  } catch (e) {
    failedMeasurements++
    measurements.push({
      component: 'base2 systemPrompt (raw template, disclosure on)',
      tokens: -1,
      note: `ERROR: ${e}`,
    })
  }

  // 2a. Authored surface off vs on (comparison for progressive prompt disclosure)
  try {
    const off = createBase2('default', { progressivePromptDisclosure: false })
    const on = createBase2('default', { progressivePromptDisclosure: true })
    const offTokens = countTokens(authoredSurface(off))
    const onTokens = countTokens(authoredSurface(on))
    const saved = offTokens - onTokens
    const reductionPct = offTokens > 0 ? (saved / offTokens) * 100 : 0
    measurements.push({
      component: 'Authored surface (system+instr+step, disclosure off)',
      tokens: offTokens,
      note: 'comparison; includes placeholder markers (not double-added to fixed)',
      isComparisonOnly: true,
    })
    measurements.push({
      component: 'Authored surface (system+instr+step, disclosure on)',
      tokens: onTokens,
      note: `saved ${saved.toLocaleString()} tok (${reductionPct.toFixed(1)}% vs off)`,
      isComparisonOnly: true,
    })
  } catch (e) {
    failedMeasurements++
    measurements.push({
      component: 'Authored surface disclosure off/on',
      tokens: -1,
      note: `ERROR: ${e}`,
      isComparisonOnly: true,
    })
  }

  // 2b. Tool definitions for base2 default tools (Anthropic-shaped).
  try {
    const toolNames = (base2Def?.toolNames ?? []) as string[]
    const { tokens, count } = measureTools(toolNames)
    measurements.push({
      component: 'Tool definitions (base2 default tools)',
      tokens,
      note: `${count} tools, Anthropic-shaped defs`,
      isProductionFixed: true,
    })
  } catch (e) {
    failedMeasurements++
    measurements.push({
      component: 'Tool definitions (base2 default tools)',
      tokens: -1,
      note: `ERROR: ${e}`,
    })
  }

  // 3a. File tree SMALL (production FILE_TREE_PROMPT_SMALL)
  try {
    const fileTreeSmall = getProjectFileTreePrompt({
      fileContext,
      fileTreeTokenBudget: FILE_TREE_SMALL_BUDGET,
      mode: 'agent',
      logger: noopLogger,
    })
    measurements.push({
      component: `File tree SMALL (production, ${FILE_TREE_SMALL_BUDGET} budget)`,
      tokens: countTokens(fileTreeSmall),
      note: `${fileTreeSmall.length} chars; FILE_TREE_PROMPT_SMALL`,
      isProductionFixed: true,
    })
  } catch (e) {
    failedMeasurements++
    measurements.push({
      component: 'File tree SMALL (production)',
      tokens: -1,
      note: `ERROR: ${e}`,
    })
  }

  // 3b. File tree FULL (comparison only — not production default)
  try {
    const fileTreeFull = getProjectFileTreePrompt({
      fileContext,
      fileTreeTokenBudget: FILE_TREE_FULL_BUDGET,
      mode: 'agent',
      logger: noopLogger,
    })
    measurements.push({
      component: `File tree FULL (${FILE_TREE_FULL_BUDGET} budget)`,
      tokens: countTokens(fileTreeFull),
      note: `${fileTreeFull.length} chars; comparison only`,
      isComparisonOnly: true,
    })
  } catch (e) {
    failedMeasurements++
    measurements.push({
      component: 'File tree FULL',
      tokens: -1,
      note: `ERROR: ${e}`,
      isComparisonOnly: true,
    })
  }

  // 4. Knowledge files contents (root-level)
  try {
    const knowledgeContents = buildKnowledgeFilesContents(fileContext)
    measurements.push({
      component: 'Knowledge files (root-level contents)',
      tokens: countTokens(knowledgeContents),
      note: `${Object.keys(fileContext.knowledgeFiles ?? {}).length} total knowledge files, ${knowledgeContents.length} chars rendered`,
      isProductionFixed: true,
    })
  } catch (e) {
    failedMeasurements++
    measurements.push({
      component: 'Knowledge files',
      tokens: -1,
      note: `ERROR: ${e}`,
    })
  }

  // 5. Knowledge files instruction prompt (static)
  measurements.push({
    component: 'Knowledge files instruction (static)',
    tokens: countTokens(knowledgeFilesPrompt),
    note: `${knowledgeFilesPrompt.length} chars`,
    isProductionFixed: true,
  })

  // 6. System info prompt
  try {
    const systemInfoPrompt = getSystemInfoPrompt(fileContext)
    measurements.push({
      component: 'System info prompt',
      tokens: countTokens(systemInfoPrompt),
      note: `${systemInfoPrompt.length} chars`,
      isProductionFixed: true,
    })
  } catch (e) {
    failedMeasurements++
    measurements.push({
      component: 'System info prompt',
      tokens: -1,
      note: `ERROR: ${e}`,
    })
  }

  // 7. Git changes prompt
  try {
    const gitChangesPrompt = getGitChangesPrompt(fileContext)
    measurements.push({
      component: 'Git changes prompt',
      tokens: gitChangesPrompt ? countTokens(gitChangesPrompt) : 0,
      note: gitChangesPrompt
        ? `${gitChangesPrompt.length} chars`
        : 'empty (clean tree)',
      isProductionFixed: true,
    })
  } catch (e) {
    failedMeasurements++
    measurements.push({
      component: 'Git changes prompt',
      tokens: -1,
      note: `ERROR: ${e}`,
    })
  }

  // 8. Representative proactive query_index result (injection)
  const queryIndexResults: QueryIndexResult[] = Array.from(
    { length: 24 },
    (_, i) => ({
      path: `packages/agent-runtime/src/module-${i}.ts`,
      score: 150 - i * 2,
      matchedOn: ['heading', 'concept', 'path', 'symbol'],
      indexedHash: 'a'.repeat(64),
      symbols: ['functionA', 'functionB', 'TypeC', 'constD', 'helperE'],
      headings: ['Section One', 'Section Two'],
      relatedFiles: [
        {
          path: `packages/agent-runtime/src/related-${i}.ts`,
          score: 3.3,
          reason: 'calls this file',
          via: 'functionA',
        },
      ],
      explanation: `Matched on heading, concept, path, symbol. Related files: related-${i}.ts (calls this file via functionA). Index age: 238s (fresh).`,
    }),
  )
  const representativeQueryIndexResult = JSON.stringify({
    kind: 'query_index_result',
    schemaVersion: 1,
    results: queryIndexResults,
    totalIndexed: 1794,
    indexAge: 237888,
    snapshot: {
      schemaVersion: 1,
      snapshotId: 'b'.repeat(64),
      indexVersion: '2',
      builtAt: 1785561897487,
    },
    status: {
      state: 'ready',
      ready: true,
      stale: false,
      refreshing: false,
      semantic: 'disabled',
      totalIndexed: 1794,
      indexAge: 237888,
      diagnostics: [],
      coverage: {
        truncated: false,
        maxFiles: 20000,
        skippedFiles: 0,
        skippedPrefixes: [],
        parser: {
          requestedFiles: 1591,
          parsedFiles: 1591,
          reusedFiles: 1588,
          freshParsedFiles: 3,
          parsedBytes: 92034,
          skippedFiles: 0,
          skippedKnownBytes: 0,
          skippedPrefixes: [],
          skippedLanguages: [],
          fileBudgetExceeded: false,
          byteBudgetExceeded: false,
          oversizedFiles: 0,
          maxFiles: 10000,
          maxFileBytes: 1000000,
          maxTotalBytes: 500000000,
          truncated: false,
        },
      },
      message: 'Index ready.',
    },
    message: 'Index ready. Found 24 indexed file result(s).',
  })
  measurements.push({
    component: 'Proactive query_index (representative, 24 results)',
    tokens: countTokens(representativeQueryIndexResult),
    note: 'scope=multi-file, mode=explain, limit=24',
    isInjection: true,
  })

  // 9. Representative git_status injection (compact)
  const representativeGitStatus = JSON.stringify({
    branch: 'fix/windows-binary-ci-smoke...origin/fix/windows-binary-ci-smoke',
    status: '?? .agents/sessions/context-baseline-25k/',
  })
  measurements.push({
    component: 'git_status injection (representative)',
    tokens: countTokens(representativeGitStatus),
    note: 'compact: branch + dirty paths only',
    isInjection: true,
  })

  // 10. Patterns index + language profile
  try {
    const { loadPatternsIndex, formatPatternsIndexPrompt } = await import(
      '@codebuff/common/util/patterns'
    )
    const index = loadPatternsIndex(cwd, noopLogger)
    const patternsPrompt = formatPatternsIndexPrompt({ index })
    measurements.push({
      component: 'Patterns index prompt',
      tokens: countTokens(patternsPrompt),
      note: `${patternsPrompt.length} chars`,
      isProductionFixed: true,
    })
  } catch (e) {
    failedMeasurements++
    measurements.push({
      component: 'Patterns index prompt',
      tokens: -1,
      note: `ERROR: ${e}`,
    })
  }

  try {
    const { formatLanguageProfilePromptForFileTree } = await import(
      '@codebuff/common/util/language-profiles'
    )
    const { formatEngineProfilePromptForFileTree } = await import(
      '@codebuff/common/util/engine-profiles'
    )
    const langProfile =
      formatLanguageProfilePromptForFileTree(fileContext.fileTree, {
        taskText: 'implement a feature',
        maxProfiles: 3,
      }) + formatEngineProfilePromptForFileTree(fileContext.fileTree)
    measurements.push({
      component: 'Language + engine profile prompt',
      tokens: countTokens(langProfile),
      note: `${langProfile.length} chars`,
      isProductionFixed: true,
    })
  } catch (e) {
    failedMeasurements++
    measurements.push({
      component: 'Language + engine profile',
      tokens: -1,
      note: `ERROR: ${e}`,
    })
  }

  // Print results
  console.log('')
  console.log('=== Per-Component Token Breakdown ===')
  console.log('')
  const validMeasurements = measurements.filter((m) => m.tokens >= 0)

  const productionFixed = validMeasurements
    .filter((m) => m.isProductionFixed)
    .reduce((sum, m) => sum + m.tokens, 0)
  const totalInjections = validMeasurements
    .filter((m) => m.isInjection)
    .reduce((sum, m) => sum + m.tokens, 0)

  const authoredOffLine = validMeasurements.find(
    (m) =>
      m.component === 'Authored surface (system+instr+step, disclosure off)',
  )
  const authoredOnLine = validMeasurements.find(
    (m) =>
      m.component === 'Authored surface (system+instr+step, disclosure on)',
  )

  // Disclosure-off fixed estimate: swap production raw template (disclosure on)
  // for an explicit disclosure-off raw systemPrompt.
  let productionFixedIfDisclosureOff: number | undefined
  try {
    const offDef = createBase2('default', {
      progressivePromptDisclosure: false,
    })
    const rawOff = countTokens(offDef.systemPrompt ?? '')
    productionFixedIfDisclosureOff =
      productionFixed - rawTemplateTokens + rawOff
  } catch {
    productionFixedIfDisclosureOff = undefined
  }

  const maxLabel = Math.max(...measurements.map((m) => m.component.length))
  for (const m of measurements) {
    const label = m.component.padEnd(maxLabel)
    const tokenStr =
      m.tokens >= 0 ? `${m.tokens.toLocaleString()}`.padStart(8) : '   ERROR'
    const tags: string[] = []
    if (m.isProductionFixed) tags.push('prod-fixed')
    if (m.isInjection) tags.push('injection')
    if (m.isComparisonOnly) tags.push('comparison')
    if (m.isRawTemplate) tags.push('raw-template')
    const tagStr = tags.length ? ` [${tags.join(',')}]` : ''
    const note = m.note ? `  (${m.note})` : ''
    console.log(`  ${label}  ${tokenStr} tok${tagStr}${note}`)
  }

  console.log('')
  console.log('--- Production-faithful summary ---')
  console.log(
    `  Default fixed (prod, disclosure on, SMALL tree, no proactive):   ${productionFixed.toLocaleString()} tokens`,
  )
  if (productionFixedIfDisclosureOff !== undefined) {
    console.log(
      `  Default fixed if disclosure off (est.):                          ${productionFixedIfDisclosureOff.toLocaleString()} tokens`,
    )
  }
  if (
    authoredOffLine &&
    authoredOnLine &&
    authoredOffLine.tokens >= 0 &&
    authoredOnLine.tokens >= 0
  ) {
    const saved = authoredOffLine.tokens - authoredOnLine.tokens
    const pct =
      authoredOffLine.tokens > 0 ? (saved / authoredOffLine.tokens) * 100 : 0
    console.log(
      `  Authored surface off → on:                                       ${authoredOffLine.tokens.toLocaleString()} → ${authoredOnLine.tokens.toLocaleString()} (saved ${saved.toLocaleString()}, ${pct.toFixed(1)}%)`,
    )
  }
  console.log(
    `  Automatic injections (rep. proactive + git):                     ${totalInjections.toLocaleString()} tokens`,
  )
  console.log(
    `  First-turn estimate (fixed + injections):                        ${(productionFixed + totalInjections).toLocaleString()} tokens`,
  )
  console.log(
    `  DEFAULT_MAX_CONTEXT_TOKENS:                                      ${DEFAULT_MAX_CONTEXT_TOKENS.toLocaleString()} tokens`,
  )
  console.log(
    `  Fixed as % of max:                                               ${((productionFixed / DEFAULT_MAX_CONTEXT_TOKENS) * 100).toFixed(1)}%`,
  )
  console.log('')
  console.log(
    '--- Soft phase targets (advisory; script does not fail on OVER) ---',
  )
  console.log(formatTargetLine('Phase-1 fixed', PHASE1_FIXED_TARGET, productionFixed))
  console.log(formatTargetLine('Phase-2 fixed', PHASE2_FIXED_TARGET, productionFixed))
  console.log(
    formatTargetLine('Program fixed (AC-F1)', PROGRAM_FIXED_TARGET, productionFixed),
  )
  console.log(formatTargetLine('Stretch fixed', STRETCH_FIXED_TARGET, productionFixed))
  console.log('')
  console.log(
    'Note: token counts use gpt-tokenizer with 1.35x Anthropic fudge factor.',
  )
  console.log(
    'Note: production fixed = raw system template + tools + SMALL tree + knowledge',
  )
  console.log(
    '      contents/instruction + system info + git + patterns + language profile.',
  )
  console.log(
    '      Placeholder markers in the raw template are tiny; inlined blocks replace them.',
  )
  console.log(
    'Note: 10k tree and authored-surface off/on rows are comparison-only.',
  )
  console.log('')

  if (failedMeasurements > 0) {
    console.log(`WARNING: ${failedMeasurements} component(s) failed to measure`)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('Fatal error:', e)
  process.exit(1)
})
