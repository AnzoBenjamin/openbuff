/**
 * Milestone 0 — Context Budget Baseline Measurement
 *
 * Measures the per-component token cost of the orchestrator's fixed per-turn
 * baseline: system prompt template, file tree, knowledge files, system info,
 * git changes, plus representative automatic injections (proactive query_index,
 * git_status). Uses the real SDK discovery and prompt builders so numbers
 * reflect production assembly.
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

import type { ProjectFileContext } from '@codebuff/common/util/file'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { QueryIndexResult } from '../packages/indexer/src/types'

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
  isInjection?: boolean
  isRawTemplate?: boolean
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

async function main() {
  const measurements: Measurement[] = []
  let failedMeasurements = 0
  const cwd = process.cwd()

  console.log('=== Context Budget Baseline Measurement ===')
  console.log(`Project: ${cwd}`)
  console.log(`Date: ${new Date().toISOString()}`)
  console.log('')

  // 1. Build a real session state to get ProjectFileContext fields
  console.log('Building real project context via SDK discovery...')
  let fileContext: ProjectFileContext
  try {
    const sessionState = await initialSessionState({ cwd })
    // Extract the ProjectFileContext from the session state
    fileContext = sessionState.fileContext
    console.log('  OK — project context built.')
  } catch (e) {
    console.error('  FAILED to build project context:', e)
    console.error('  Falling back to stub context.')
    // Count as a failed measurement so a report built on stub data cannot exit 0.
    failedMeasurements++
    const { getStubProjectFileContext } = await import('@codebuff/common/util/file')
    fileContext = getStubProjectFileContext()
  }

  // 2. base2 systemPrompt template (raw, before placeholder replacement)
  try {
    const base2Def = createBase2('default')
    const rawSystemPrompt = base2Def.systemPrompt ?? ''
    const tokens = countTokens(rawSystemPrompt)
    measurements.push({
      component: 'base2 systemPrompt (raw template)',
      tokens,
      note: `${rawSystemPrompt.length} chars, includes placeholders`,
      isRawTemplate: true,
    })
  } catch (e) {
    failedMeasurements++
    measurements.push({ component: 'base2 systemPrompt', tokens: -1, note: `ERROR: ${e}` })
  }

  // 3. File tree prompt (agent mode, 10k budget — the orchestrator default)
  try {
    const fileTreePrompt = getProjectFileTreePrompt({
      fileContext,
      fileTreeTokenBudget: 10_000,
      mode: 'agent',
      logger: noopLogger,
    })
    measurements.push({
      component: 'File tree prompt (agent, 10k budget)',
      tokens: countTokens(fileTreePrompt),
      note: `${fileTreePrompt.length} chars`,
    })
  } catch (e) {
    failedMeasurements++
    measurements.push({ component: 'File tree prompt', tokens: -1, note: `ERROR: ${e}` })
  }

  // 4. Knowledge files contents (root-level only: knowledge.md, AGENTS.md, CLAUDE.md)
  // Rendered by buildKnowledgeFilesContents, which mirrors the production
  // PLACEHOLDER.KNOWLEDGE_FILES_CONTENTS provider in
  // packages/agent-runtime/src/templates/strings.ts (the source of truth):
  // root-filtered `knowledgeFiles` merged with all `userKnowledgeFiles`, each
  // trimmed and wrapped in a ```path\ncontent\n``` block, joined with '\n\n'.
  // Nested *.knowledge.md files are intentionally EXCLUDED from the per-turn
  // prompt, so they are correctly not counted here.
  try {
    const knowledgeContents = buildKnowledgeFilesContents(fileContext)
    measurements.push({
      component: 'Knowledge files (root-level contents)',
      tokens: countTokens(knowledgeContents),
      note: `${Object.keys(fileContext.knowledgeFiles ?? {}).length} total knowledge files, ${knowledgeContents.length} chars rendered`,
    })
  } catch (e) {
    failedMeasurements++
    measurements.push({ component: 'Knowledge files', tokens: -1, note: `ERROR: ${e}` })
  }

  // 5. Knowledge files instruction prompt (static)
  measurements.push({
    component: 'Knowledge files instruction (static)',
    tokens: countTokens(knowledgeFilesPrompt),
    note: `${knowledgeFilesPrompt.length} chars`,
  })

  // 6. System info prompt
  try {
    const systemInfoPrompt = getSystemInfoPrompt(fileContext)
    measurements.push({
      component: 'System info prompt',
      tokens: countTokens(systemInfoPrompt),
      note: `${systemInfoPrompt.length} chars`,
    })
  } catch (e) {
    failedMeasurements++
    measurements.push({ component: 'System info prompt', tokens: -1, note: `ERROR: ${e}` })
  }

  // 7. Git changes prompt
  try {
    const gitChangesPrompt = getGitChangesPrompt(fileContext)
    measurements.push({
      component: 'Git changes prompt',
      tokens: gitChangesPrompt ? countTokens(gitChangesPrompt) : 0,
      note: gitChangesPrompt ? `${gitChangesPrompt.length} chars` : 'empty (clean tree)',
    })
  } catch (e) {
    failedMeasurements++
    measurements.push({ component: 'Git changes prompt', tokens: -1, note: `ERROR: ${e}` })
  }

  // 8. Representative proactive query_index result
  // Measured from a real multi-file scope=explain result (24 results with
  // relatedFiles, explanations, status block). Typical size observed: ~10k tokens.
  // The results array is typed against the canonical QueryIndexResult type
  // (packages/indexer/src/types.ts), so element-schema drift fails at typecheck.
  // The surrounding envelope (kind/schemaVersion/totalIndexed/indexAge/snapshot/
  // status/message) is assembled inline by the query_index tool handler and
  // zod-validated in common/src/tools/params/tool/query-index.ts — it is not a
  // single exported type, so it stays an untyped plain object here.
  const queryIndexResults: QueryIndexResult[] = Array.from({ length: 24 }, (_, i) => ({
    path: `packages/agent-runtime/src/module-${i}.ts`,
    score: 150 - i * 2,
    matchedOn: ['heading', 'concept', 'path', 'symbol'],
    indexedHash: 'a'.repeat(64),
    symbols: ['functionA', 'functionB', 'TypeC', 'constD', 'helperE'],
    headings: ['Section One', 'Section Two'],
    relatedFiles: [
      { path: `packages/agent-runtime/src/related-${i}.ts`, score: 3.3, reason: 'calls this file', via: 'functionA' },
    ],
    explanation: `Matched on heading, concept, path, symbol. Related files: related-${i}.ts (calls this file via functionA). Index age: 238s (fresh).`,
  }))
  const representativeQueryIndexResult = JSON.stringify({
    kind: 'query_index_result',
    schemaVersion: 1,
    results: queryIndexResults,
    totalIndexed: 1794,
    indexAge: 237888,
    snapshot: { schemaVersion: 1, snapshotId: 'b'.repeat(64), indexVersion: '2', builtAt: 1785561897487 },
    status: {
      state: 'ready', ready: true, stale: false, refreshing: false, semantic: 'disabled',
      totalIndexed: 1794, indexAge: 237888, diagnostics: [],
      coverage: { truncated: false, maxFiles: 20000, skippedFiles: 0, skippedPrefixes: [], parser: { requestedFiles: 1591, parsedFiles: 1591, reusedFiles: 1588, freshParsedFiles: 3, parsedBytes: 92034, skippedFiles: 0, skippedKnownBytes: 0, skippedPrefixes: [], skippedLanguages: [], fileBudgetExceeded: false, byteBudgetExceeded: false, oversizedFiles: 0, maxFiles: 10000, maxFileBytes: 1000000, maxTotalBytes: 500000000, truncated: false } },
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
    status: '?? .agents/sessions/context-budget-architecture-2026-08/',
  })
  measurements.push({
    component: 'git_status injection (representative)',
    tokens: countTokens(representativeGitStatus),
    note: 'compact: branch + dirty paths only',
    isInjection: true,
  })

  // 10. Patterns index + language profile (static-ish)
  try {
    const { loadPatternsIndex, formatPatternsIndexPrompt } = await import('@codebuff/common/util/patterns')
    const index = loadPatternsIndex(cwd, noopLogger)
    const patternsPrompt = formatPatternsIndexPrompt({ index })
    measurements.push({
      component: 'Patterns index prompt',
      tokens: countTokens(patternsPrompt),
      note: `${patternsPrompt.length} chars`,
    })
  } catch (e) {
    failedMeasurements++
    measurements.push({ component: 'Patterns index prompt', tokens: -1, note: `ERROR: ${e}` })
  }

  try {
    const { formatLanguageProfilePromptForFileTree } = await import('@codebuff/common/util/language-profiles')
    const { formatEngineProfilePromptForFileTree } = await import('@codebuff/common/util/engine-profiles')
    const langProfile = formatLanguageProfilePromptForFileTree(fileContext.fileTree, {
      taskText: 'implement a feature',
      maxProfiles: 3,
    }) + formatEngineProfilePromptForFileTree(fileContext.fileTree)
    measurements.push({
      component: 'Language + engine profile prompt',
      tokens: countTokens(langProfile),
      note: `${langProfile.length} chars`,
    })
  } catch (e) {
    failedMeasurements++
    measurements.push({ component: 'Language + engine profile', tokens: -1, note: `ERROR: ${e}` })
  }

  // Print results
  console.log('')
  console.log('=== Per-Component Token Breakdown ===')
  console.log('')
  const validMeasurements = measurements.filter((m) => m.tokens >= 0)
  const totalFixed = validMeasurements
    .filter((m) => !m.isInjection)
    .reduce((sum, m) => sum + m.tokens, 0)
  const totalInjections = validMeasurements
    .filter((m) => m.isInjection)
    .reduce((sum, m) => sum + m.tokens, 0)

  const maxLabel = Math.max(...measurements.map((m) => m.component.length))
  for (const m of measurements) {
    const label = m.component.padEnd(maxLabel)
    const tokenStr = m.tokens >= 0 ? `${m.tokens.toLocaleString()}`.padStart(8) : '   ERROR'
    const note = m.note ? `  (${m.note})` : ''
    console.log(`  ${label}  ${tokenStr} tok${note}`)
  }

  console.log('')
  console.log('--- Summary ---')
  console.log(`  Fixed per-turn baseline (excl. injections):  ${totalFixed.toLocaleString()} tokens`)
  console.log(`  Automatic injections (per-turn):             ${totalInjections.toLocaleString()} tokens`)
  console.log(`  Total measured:                              ${(totalFixed + totalInjections).toLocaleString()} tokens`)
  console.log(`  DEFAULT_MAX_CONTEXT_TOKENS:                  ${DEFAULT_MAX_CONTEXT_TOKENS.toLocaleString()} tokens`)
  console.log(`  Baseline as % of max:                        ${(((totalFixed + totalInjections) / DEFAULT_MAX_CONTEXT_TOKENS) * 100).toFixed(1)}%`)
  console.log('')
  console.log('Note: token counts use gpt-tokenizer with 1.35x Anthropic fudge factor.')
  console.log('Note: the base2 systemPrompt is measured as the raw template; after placeholder')
  console.log('      replacement the assembled prompt is larger (file tree + knowledge + profiles')
  console.log('      are inlined). The true per-turn system cost is approximately:')
  const assembledEstimate = validMeasurements
    .filter((m) => !m.isInjection && !m.isRawTemplate)
    .reduce((sum, m) => sum + m.tokens, 0)
  const rawTemplate = measurements.find((m) => m.isRawTemplate)?.tokens ?? 0
  console.log(`      raw template (${rawTemplate.toLocaleString()}) + inlined components (${assembledEstimate.toLocaleString()}) = ${(rawTemplate + assembledEstimate).toLocaleString()} tokens`)
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
