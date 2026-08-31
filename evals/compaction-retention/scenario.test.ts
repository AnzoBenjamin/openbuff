/**
 * Deterministic compaction retention eval (no LLM, no network, no disk I/O).
 *
 * Drives `agents/context-pruner.ts` directly — the same way
 * `agents/__tests__/context-pruner.test.ts` does — and measures how much of the
 * evidence a run needs to continue survives inside the pinned
 * `<knowledge_memory>` block, and how that scales with the model context window.
 *
 *  - S1 baseline    : 140k trigger / 100k target (scale 1.0) reference counts.
 *  - S2 small window: 8k-class BYOK window stays under the pinned-block ceiling
 *                     while never dropping Goal / Next Action.
 *  - S3 large window: ~1M-token window buys strictly deeper list retention.
 *  - S4 trailing     : long pasted diagnostic + short trailing instruction; the
 *                     trailing instruction survives (beginning-and-end goal).
 *  - S5 blocker      : open reviewer blocker + structured review receipt survive
 *                     a compaction pass with the receipt fingerprint intact.
 *
 * The metrics are the deliverable; the assertions are the regression floor.
 */
import { afterAll, describe, expect, test } from 'bun:test'

import contextPruner from '../../agents/context-pruner'

import type { AgentState } from '../../agents/types/agent-definition'
import type {
  JSONValue,
  Message,
  ToolMessage,
} from '../../agents/types/util-types'

/**
 * Estimated characters per token. This is the pruner's own estimation
 * heuristic (`CHARS_PER_TOKEN`), not one of its retention cap constants: the
 * eval needs it to report `blockTokens` in the same unit the pruner budgets in.
 */
const CHARS_PER_TOKEN = 3

const estimateTokens = (text: string): number =>
  Math.ceil(text.length / CHARS_PER_TOKEN)

// =============================================================================
// Seeded must-survive facts
// =============================================================================

const SEEDED_GOAL_HEAD =
  'GOAL_HEAD: measure pinned knowledge_memory retention across context windows.'
const SEEDED_TRAILING_INSTRUCTION =
  'TRAILING_INSTRUCTION: report retention metrics without editing the pruner.'
const SEEDED_INSPECTED_PATH =
  'packages/agent-runtime/src/util/context-pruning.ts'
const SEEDED_DECISION =
  'Decision: pin the knowledge_memory block verbatim instead of re-deriving it per pass.'
const SEEDED_BLOCKER =
  'BLOCKING: restore the deterministic edit guard in src/guard.ts before finalizing.'
const SEEDED_NEXT_ACTION =
  'Re-run the compaction retention suite and repair the failing retention floor.'
const SEEDED_RECEIPT_FINGERPRINT = 'f'.repeat(64)

/**
 * The pinned-block caps keep the newest entries (`slice(-cap)`), so every
 * must-survive fact is seeded last within its own section.
 */
const INSPECTED_PATHS = [
  ...Array.from(
    { length: 39 },
    (_, index) =>
      `packages/agent-runtime/src/retention/module-${index}/inspected-${index}.ts`,
  ),
  SEEDED_INSPECTED_PATH,
]
const DECISION_LINES = [
  ...Array.from(
    { length: 19 },
    (_, index) =>
      `Decision: keep retention rationale ${index} for depth measurement.`,
  ),
  SEEDED_DECISION,
]
const VALIDATION_COMMAND_COUNT = 20
const EDITED_PATHS = [
  'packages/agent-runtime/src/retention/edited-a.ts',
  'packages/agent-runtime/src/retention/edited-b.ts',
  'packages/agent-runtime/src/retention/edited-c.ts',
]

const MUST_SURVIVE_FACTS = [
  SEEDED_INSPECTED_PATH,
  SEEDED_DECISION,
  SEEDED_BLOCKER,
  SEEDED_NEXT_ACTION,
]

// =============================================================================
// Message factories (mirrors agents/__tests__/context-pruner.test.ts)
// =============================================================================

const createMessage = (
  role: 'user' | 'assistant',
  content: string,
): Message => ({
  role,
  content: [
    {
      type: 'text',
      text: content,
    },
  ],
})

const createToolCallMessage = (
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
): Message => ({
  role: 'assistant',
  content: [
    {
      type: 'tool-call',
      toolCallId,
      toolName,
      input,
    },
  ],
})

const createToolResultMessage = (
  toolCallId: string,
  toolName: string,
  value: JSONValue,
): ToolMessage => ({
  role: 'tool',
  toolCallId,
  toolName,
  content: [
    {
      type: 'json',
      value,
    },
  ],
})

/** Canonical successful `read_files` results — the pruner only records reads it can prove. */
const createSuccessfulReadMessages = (paths: string[]): Message[] =>
  paths.flatMap((path, index) => [
    createToolCallMessage(`retention-read-${index}`, 'read_files', {
      paths: [path],
    }),
    createToolResultMessage(`retention-read-${index}`, 'read_files', {
      kind: 'read_files_result',
      version: 1,
      status: 'ok',
      summary: { requested: 1, ok: 1, partial: 0, failed: 0, uniquePaths: 1 },
      results: [
        {
          selector: 'file',
          requestIndex: 0,
          path,
          status: 'ok',
          content: 'export const value = 1',
          complete: true,
          template: false,
        },
      ],
    }),
  ])

const createValidationMessages = (count: number): Message[] =>
  Array.from({ length: count }, (_, index) => index).flatMap((index) => {
    const command = `bun test retention-suite-${index}`
    return [
      createToolCallMessage(`retention-cmd-${index}`, 'run_terminal_command', {
        command,
      }),
      createToolResultMessage(
        `retention-cmd-${index}`,
        'run_terminal_command',
        {
          exitCode: 0,
          command,
        },
      ),
    ]
  })

/**
 * Fully correlated committed mutation results, so the pruner persists both
 * `Edits Made` and `Post-Edit Anchors` (it rejects uncorrelated receipts).
 */
const createCommittedEditMessages = (paths: string[]): Message[] =>
  paths.flatMap((filePath, index) => {
    const operationId = `retention-edit-${index}`
    const receiptId = `${operationId}:receipt`
    const afterHash = `sha256:${`${index}`.padStart(64, 'a')}`
    const action: Record<string, JSONValue> = {
      actionId: `${operationId}:0`,
      index: 0,
      action: 'update',
      path: filePath,
      outcome: 'applied',
      beforeHash: `sha256:${`${index}`.padStart(64, 'b')}`,
      afterHash,
      editAnchor: {
        startLine: 1,
        endLine: 12,
        contentHash: afterHash,
        readCapability: `cap.v3.retention-anchor-${index}`,
      },
    }
    const result: Record<string, JSONValue> = {
      kind: 'file_mutation_result',
      version: 1,
      operationId,
      receiptId,
      outcome: 'applied',
      authorityTier: 'portable_path',
      actions: [action],
      errors: [],
      freshCapabilities: [],
      authorityReceipt: {
        kind: 'commit_receipt',
        version: 1,
        receiptId,
        operationId,
        callId: `${operationId}:call`,
        authorityTier: 'portable_path',
        status: 'committed',
        actions: [{ ...action, status: 'committed' }],
        finalHashes: { [filePath]: afterHash },
      },
    }
    return [
      createToolCallMessage(operationId, 'str_replace', {
        path: filePath,
        replacements: [],
      }),
      createToolResultMessage(operationId, 'str_replace', result),
    ]
  })

/** Structured reviewer output: BLOCKING verdict with an attested snapshot fingerprint. */
const createReviewReceiptMessages = (): Message[] => [
  createToolCallMessage('retention-review', 'spawn_agent_inline', {
    agent_type: 'code-reviewer',
  }),
  createToolResultMessage('retention-review', 'spawn_agent_inline', {
    schemaVersion: 3,
    family: 'reviewer',
    verdict: 'BLOCKING',
    snapshotFingerprint: SEEDED_RECEIPT_FINGERPRINT,
    reviewedFiles: [SEEDED_INSPECTED_PATH],
    coverage: 'covered',
    dimensions: { correctness: 'block' },
    findings: [
      {
        id: 'code-reviewer:correctness:edit-guard',
        severity: 'critical',
        dimension: 'correctness',
        summary: 'The deterministic edit guard was removed from src/guard.ts.',
        evidence: ['src/guard.ts no longer checks the commit receipt'],
        correction: 'Restore the guard before finalizing.',
      },
    ],
    requirementCoverage: [],
  }),
]

/**
 * One seeded history shared by every scenario: a tagged live goal, 40 proven
 * reads, 20 decision lines, 3 committed edits, 20 validation runs and an open
 * blocker. Every scenario's `contextTokenCount` is set well above its resolved
 * trigger so the pruner always compacts (RISK1).
 */
const seedHistory = (
  options: { goalText?: string; includeReviewReceipt?: boolean } = {},
): Message[] => [
  {
    ...createMessage('user', options.goalText ?? SEEDED_GOAL_HEAD),
    tags: ['USER_PROMPT'],
  },
  ...createSuccessfulReadMessages(INSPECTED_PATHS),
  createMessage('assistant', DECISION_LINES.join('\n')),
  ...createCommittedEditMessages(EDITED_PATHS),
  ...createValidationMessages(VALIDATION_COMMAND_COUNT),
  createMessage('assistant', SEEDED_BLOCKER),
  ...(options.includeReviewReceipt ? createReviewReceiptMessages() : []),
]

// =============================================================================
// Harness: drive handleSteps and read the set_messages payload
// =============================================================================

interface ScenarioBudget {
  /** Reported context usage; must exceed the resolved trigger. */
  contextTokenCount: number
  contextWindowTokens?: number
  /**
   * Explicit budget injection. A window value alone does not pin the resolved
   * target (the pruner clamps via min/max target bounds), so scenarios that
   * need an exact scale factor inject the budget directly.
   */
  semanticBudget?: { triggerBudgetTokens: number; targetBudgetTokens: number }
  nextRequiredAction?: string
}

function createMockAgentState(
  messageHistory: Message[],
  contextTokenCount: number,
): AgentState {
  return {
    agentId: 'compaction-retention-eval',
    runId: 'compaction-retention-run',
    parentId: undefined,
    messageHistory,
    output: undefined,
    systemPrompt: '',
    toolDefinitions: {},
    contextTokenCount,
  }
}

const runHandleSteps = (messages: Message[], budget: ScenarioBudget): any[] => {
  const agentState = createMockAgentState(messages, budget.contextTokenCount)
  if (budget.contextWindowTokens !== undefined) {
    agentState.contextWindowTokens = budget.contextWindowTokens
  }
  agentState.base2ActiveWork = {
    nextRequiredAction: budget.nextRequiredAction ?? SEEDED_NEXT_ACTION,
  }
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }
  const generator = contextPruner.handleSteps!({
    agentState,
    logger,
    params: {
      ...(budget.semanticBudget
        ? { semanticBudget: budget.semanticBudget }
        : {}),
    },
  })
  const results: any[] = []
  let result = generator.next()
  while (!result.done) {
    if (typeof result.value === 'object') {
      results.push(result.value)
    }
    result = generator.next()
  }
  return results
}

// =============================================================================
// Section parsing (anchored on the exact header text and "  - " entry prefix)
// =============================================================================

const SECTION_HEADERS = {
  decisions: 'Decisions',
  filesInspected: 'Files Inspected',
  editsMade: 'Edits Made',
  validationResults: 'Validation Results',
  reviewReceipts: 'Review Receipts',
  postEditAnchors: 'Post-Edit Anchors',
  blockers: 'Blockers',
} as const

type SectionKey = keyof typeof SECTION_HEADERS

const extractKnowledgeMemoryBlock = (content: string): string =>
  content.match(/<knowledge_memory>[\s\S]*?<\/knowledge_memory>/)?.[0] ?? ''

/** Count `  - entry` lines under one section header, stopping at the next header. */
const countSectionEntries = (block: string, header: string): number => {
  const section = block.split(`${header}:\n`)[1] ?? ''
  let count = 0
  for (const line of section.split('\n')) {
    if (!line.startsWith('  - ')) break
    count += 1
  }
  return count
}

// =============================================================================
// Metrics
// =============================================================================

interface ScenarioMetrics {
  id: string
  claim: string
  recallRate: number
  missingFacts: string[]
  blockTokens: number
  summaryTokens: number
  historyTokens: number
  compressionRatio: number
  retainedEntryCounts: Record<SectionKey, number>
}

interface Measurement extends ScenarioMetrics {
  block: string
}

const metrics: ScenarioMetrics[] = []

function measureRetention(args: {
  id: string
  claim: string
  messages: Message[]
  budget: ScenarioBudget
  mustSurvive?: string[]
}): Measurement {
  const results = runHandleSteps(args.messages, args.budget)
  expect(results).toHaveLength(1)
  expect(results[0].toolName).toBe('set_messages')

  const summaryText: string = results[0].input.messages[0].content[0].text
  // RISK1: a history under the resolved trigger yields no summary at all, and
  // every metric below would silently measure an empty block.
  expect(summaryText).toContain('<conversation_summary>')
  const block = extractKnowledgeMemoryBlock(summaryText)
  expect(block).not.toBe('')

  const mustSurvive = args.mustSurvive ?? MUST_SURVIVE_FACTS
  const missingFacts = mustSurvive.filter((fact) => !block.includes(fact))
  const historyTokens = estimateTokens(JSON.stringify(args.messages))
  const summaryTokens = estimateTokens(summaryText)
  const retainedEntryCounts = Object.fromEntries(
    Object.entries(SECTION_HEADERS).map(([key, header]) => [
      key,
      countSectionEntries(block, header),
    ]),
  ) as Record<SectionKey, number>

  const recorded: ScenarioMetrics = {
    id: args.id,
    claim: args.claim,
    recallRate: (mustSurvive.length - missingFacts.length) / mustSurvive.length,
    missingFacts,
    blockTokens: estimateTokens(block),
    summaryTokens,
    historyTokens,
    compressionRatio: summaryTokens / historyTokens,
    retainedEntryCounts,
  }
  metrics.push(recorded)
  return { ...recorded, block }
}

/** Extract the pinned `Goal:` body, stopping at the next section header. */
const extractGoalSection = (block: string): string | undefined =>
  block.match(
    /Goal:\n {2}([\s\S]*?)\n(?:Decisions:|Files Inspected:|Edits Made:|Validation Results:|Review Receipts:|Post-Edit Anchors:|Blockers:|Next Action:|<\/knowledge_memory>)/,
  )?.[1]

// =============================================================================
// Scenarios
// =============================================================================

/** S1/S4/S5 baseline: no window and no explicit limit => 140k trigger / 100k target. */
const BASELINE_BUDGET: ScenarioBudget = { contextTokenCount: 200_000 }

describe('compaction retention scenario', () => {
  afterAll(() => {
    const header = [
      'scenario',
      'recall',
      'blockTok',
      'compress',
      'retainedEntries',
    ]
    const rows = metrics.map((metric) => [
      metric.id,
      metric.recallRate.toFixed(2),
      String(metric.blockTokens),
      metric.compressionRatio.toFixed(3),
      Object.entries(metric.retainedEntryCounts)
        .map(([key, value]) => `${key}=${value}`)
        .join(' '),
    ])
    const widths = header.map((cell, column) =>
      Math.max(cell.length, ...rows.map((row) => row[column].length)),
    )
    const renderRow = (cells: string[]): string =>
      cells.map((cell, column) => cell.padEnd(widths[column])).join('  ')
    console.log('\ncompaction retention metrics')
    console.log(renderRow(header))
    for (const row of rows) console.log(renderRow(row))
  })

  test('S1 baseline records reference retention counts at the 100k target', () => {
    const measurement = measureRetention({
      id: 'S1-baseline',
      claim: '140k trigger / 100k target retains the scale-1.0 baseline counts',
      messages: seedHistory(),
      budget: BASELINE_BUDGET,
    })

    expect(measurement.recallRate).toBe(1)
    expect(measurement.missingFacts).toEqual([])
    // scale = clamp(100_000 / 100_000, 0.5, 3.0) = 1.0
    expect(measurement.retainedEntryCounts.filesInspected).toBe(25) // round(25 * 1.0) = 25 of 40 seeded
    expect(measurement.retainedEntryCounts.decisions).toBe(12) // round(12 * 1.0) = 12 of 20 seeded
    expect(measurement.retainedEntryCounts.validationResults).toBe(12) // round(12 * 1.0) = 12 of 20 seeded
    expect(measurement.retainedEntryCounts.editsMade).toBe(3) // 3 seeded, under round(25 * 1.0) = 25
    expect(measurement.retainedEntryCounts.postEditAnchors).toBe(3) // 3 seeded, under round(16 * 1.0) = 16
    expect(measurement.retainedEntryCounts.blockers).toBe(1)
    // ceiling = max(1_500, floor(100_000 * 0.25)) = 25_000 estimated tokens
    expect(measurement.blockTokens).toBeLessThanOrEqual(25_000)
    expect(measurement.compressionRatio).toBeLessThan(1)
  })

  test('S2 small window bounds the pinned block but never drops the task contract', () => {
    // 8k-class BYOK window. The explicit budget pins the resolved target so the
    // scale factor is exact: clamp(2_500 / 100_000, 0.5, 3.0) = 0.5.
    const measurement = measureRetention({
      id: 'S2-small-window',
      claim:
        '8k-class window stays under the pinned-block ceiling and keeps Goal + Next Action',
      messages: seedHistory(),
      budget: {
        contextTokenCount: 20_000,
        contextWindowTokens: 8_000,
        semanticBudget: {
          triggerBudgetTokens: 2_800,
          targetBudgetTokens: 2_500,
        },
      },
    })

    // ceiling = max(1_500, floor(2_500 * 0.25) = 625) = 1_500 estimated tokens
    expect(measurement.blockTokens).toBeLessThanOrEqual(1_500)
    // The task contract is truncated toward its floor, never dropped.
    expect(measurement.block).toContain('Goal:')
    expect(measurement.block).toContain(SEEDED_GOAL_HEAD)
    expect(measurement.block).toContain('Next Action:')
    expect(measurement.block).toContain(SEEDED_NEXT_ACTION)
    // Regression floor only: deeper list evidence is legitimately evicted here.
    expect(measurement.recallRate).toBeGreaterThanOrEqual(0.5)
  })

  test('S3 large window buys strictly deeper list retention than the baseline', () => {
    const baseline = measureRetention({
      id: 'S3-baseline-reference',
      claim: 'baseline reference re-measured for the S3 comparison',
      messages: seedHistory(),
      budget: BASELINE_BUDGET,
    })
    // ~1M-token window. Explicit budget pins the target so the scale factor is
    // exact: clamp(350_000 / 100_000, 0.5, 3.0) = 3.0 (upper clamp).
    const large = measureRetention({
      id: 'S3-large-window',
      claim: '~1M-token window retains strictly more list entries than S1',
      messages: seedHistory(),
      budget: {
        contextTokenCount: 800_000,
        contextWindowTokens: 1_000_000,
        semanticBudget: {
          triggerBudgetTokens: 700_000,
          targetBudgetTokens: 350_000,
        },
      },
    })

    expect(large.recallRate).toBe(1)
    // Caps at scale 3.0 exceed the seeded volume, so every seeded entry is kept:
    // files min(40, round(25 * 3.0) = 75), decisions min(20, round(12 * 3.0) = 36).
    expect(large.retainedEntryCounts.filesInspected).toBe(40)
    expect(large.retainedEntryCounts.decisions).toBe(20)
    expect(large.retainedEntryCounts.validationResults).toBe(20)
    for (const section of [
      'filesInspected',
      'decisions',
      'validationResults',
    ] as const) {
      expect(large.retainedEntryCounts[section]).toBeGreaterThan(
        baseline.retainedEntryCounts[section],
      )
    }
    expect(large.blockTokens).toBeGreaterThan(baseline.blockTokens)
  })

  test('S4 trailing instruction after a long pasted diagnostic survives', () => {
    const goalText = [
      SEEDED_GOAL_HEAD,
      'pasted diagnostic line '.repeat(400),
      SEEDED_TRAILING_INSTRUCTION,
    ].join('\n')
    const measurement = measureRetention({
      id: 'S4-trailing-instruction',
      claim:
        'a trailing instruction after a long pasted diagnostic survives in the pinned Goal',
      messages: seedHistory({ goalText }),
      budget: BASELINE_BUDGET,
      mustSurvive: [...MUST_SURVIVE_FACTS, SEEDED_TRAILING_INSTRUCTION],
    })

    // Beginning-and-end preservation: the pinned goal keeps both ends of a
    // request far longer than its own cap, so the trailing instruction is not
    // lost behind the pasted diagnostic.
    const goal = extractGoalSection(measurement.block)
    expect(goal).toBeDefined()
    expect(goal!).toContain(SEEDED_GOAL_HEAD)
    expect(goal!).toContain(SEEDED_TRAILING_INSTRUCTION)
    // Goal cap at the 100k baseline target: round(2_400 * 1.0) = 2_400 chars,
    // against a ~9.7k-character request, so the middle is provably dropped.
    expect(goal!.length).toBeLessThanOrEqual(2_400)
    expect(goal!.length).toBeLessThan(goalText.length / 2)
    expect(measurement.recallRate).toBe(1)
  })

  test('S5 open blocker and structured review receipt survive a pass', () => {
    const measurement = measureRetention({
      id: 'S5-blocker-receipt',
      claim:
        'an open reviewer blocker and the review receipt fingerprint both survive',
      messages: seedHistory({ includeReviewReceipt: true }),
      budget: BASELINE_BUDGET,
      mustSurvive: [...MUST_SURVIVE_FACTS, SEEDED_RECEIPT_FINGERPRINT],
    })

    expect(measurement.recallRate).toBe(1)
    expect(measurement.block).toContain(SEEDED_BLOCKER)
    expect(measurement.block).toContain('Review Receipts:')
    expect(measurement.block).toContain(
      `snapshot=${SEEDED_RECEIPT_FINGERPRINT}`,
    )
    expect(
      measurement.retainedEntryCounts.reviewReceipts,
    ).toBeGreaterThanOrEqual(1)
    // The reviewer's BLOCKING finding is pinned alongside the seeded blocker.
    expect(measurement.retainedEntryCounts.blockers).toBeGreaterThanOrEqual(2)
  })
})
