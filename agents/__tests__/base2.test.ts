import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { afterAll, describe, expect, test } from 'bun:test'

import { createBaseDeep } from '../base2/base-deep'
import { createBase2 } from '../base2/base2'
import { normalizeGateFilePath } from '../base2/gate-paths'
import type { Base2ActiveWorkState } from '../base2/gate-state'

const TEST_TMP_ROOT = join(process.cwd(), '.base2-test-scratch')
mkdirSync(TEST_TMP_ROOT, { recursive: true })

afterAll(() => {
  rmSync(TEST_TMP_ROOT, { recursive: true, force: true })
})

function makeProjectTempDir(prefix: string): string {
  return mkdtempSync(join(TEST_TMP_ROOT, prefix))
}

/**
 * Build a canonical file_mutation_result receipt (the real production
 * edit-artifact shape) for `path`. The mid-turn git-status sweep only absorbs
 * a newly-dirty file into the pending gate set when it is already in the live
 * changedFiles set (populated from canonical edit artifacts), so simulated
 * edits must feed this shape rather than a bare `{ file }`.
 */
function editReceipt(path: string) {
  return {
    kind: 'file_mutation_result',
    version: 1,
    operationId: `op-${path}`,
    receiptId: `receipt-${path}`,
    outcome: 'applied',
    authorityTier: 'conditional_commit',
    actions: [
      {
        actionId: `action-${path}`,
        index: 0,
        action: 'update',
        path,
        outcome: 'applied',
        beforeHash: 'before',
        afterHash: 'after',
      },
    ],
    authorityReceipt: {
      operationId: `op-${path}`,
      receiptId: `receipt-${path}`,
      actions: [{ actionId: `action-${path}` }],
    },
    errors: [],
    freshCapabilities: [],
  }
}

function buildContentMarker(absolutePath: string): string {
  const data = readFileSync(absolutePath)
  const hash = createHash('sha256').update(data).digest('hex')
  return `sha256:${hash}:${data.length}`
}

function parseGateStateBlock(text: string):
  | {
      gate: string
      status: string
      details: string
      repairRound?: number
      maxRepairRounds?: number
    }
  | undefined {
  const match = text.match(/<gate-state>([\s\S]*?)<\/gate-state>/)
  if (!match) return undefined
  try {
    const parsed = JSON.parse(match[1]) as Record<string, unknown>
    return {
      gate: String(parsed.gate ?? ''),
      status: String(parsed.status ?? ''),
      details: String(parsed.details ?? ''),
      ...(typeof parsed.repairRound === 'number'
        ? { repairRound: parsed.repairRound }
        : {}),
      ...(typeof parsed.maxRepairRounds === 'number'
        ? { maxRepairRounds: parsed.maxRepairRounds }
        : {}),
    }
  } catch {
    return undefined
  }
}

function buildFingerprint(
  entries: Array<{ file: string; statusLine?: string; contentMarker: string }>,
  validationSummary: string,
): string {
  // Mirror the runtime's content-only fingerprint (files-v4). The volatile
  // git status line is intentionally excluded so commits don't invalidate it.
  const sorted = entries
    .map((entry) => ({
      ...entry,
      file: normalizeGateFilePath(entry.file),
    }))
    .sort((a, b) => a.file.localeCompare(b.file))
  const parts = sorted.map(
    (entry) => `${entry.file}\t${entry.contentMarker}`,
  )
  const details = `files-v4\n${parts.join('\n')}\n--\n${validationSummary}`
  return `v3:${createHash('sha256').update(details).digest('hex')}`
}

function attestedReviewerResult(
  reviewCall: any,
  verdict: 'LOOKS_GOOD' | 'NON_BLOCKING' | 'BLOCKING' = 'LOOKS_GOOD',
  findings: string[] = [],
  coverage: 'covered' | 'missing' | 'n/a' = 'covered',
) {
  const prompt = String(reviewCall?.input?.agents?.[0]?.prompt ?? '')
  const fingerprint =
    prompt.match(/Snapshot fingerprint \(echo exactly\): ([^\n]+)/)?.[1] ?? ''
  const files =
    prompt
      .match(/(?:Gate-scope|Pending) changed files: ([^\n]+)/)?.[1]
      ?.split(',')
      .map((file: string) => file.trim())
      .filter((file: string) => file && file !== '(unknown)') ?? []
  return {
    toolResult: [
      {
        type: 'json',
        value: [
          {
            schemaVersion: 1,
            verdict,
            snapshotFingerprint: fingerprint,
            reviewedFiles: files,
            findings,
            coverage,
            dimensions: {
              correctness: 'pass',
              security: 'pass',
              tests: 'pass',
              apiCompatibility: 'pass',
              performance: 'pass',
            },
            requirementCoverage: [],
          },
        ],
      },
    ],
  }
}

function repairSpawnReport(params: {
  receiptId: string
  status: string
  changedFiles: Array<{ path: string }>
  findingsAddressed: string[]
  requestedValidation?: string[]
  value?: Record<string, unknown>
}) {
  const agentReceipt = {
    schemaVersion: 1,
    receiptId: params.receiptId,
    status: params.status,
    changedFiles: params.changedFiles,
    findingsAddressed: params.findingsAddressed,
    requestedValidation: params.requestedValidation ?? [],
  }
  return {
    toolResult: [
      {
        type: 'json',
        value: [
          {
            agentId: 'repair-agent-1',
            agentName: 'Repair Editor',
            agentType: 'repair-editor',
            value: params.value ?? {},
            agentReceipt,
          },
        ],
      },
    ],
  }
}

function completedRepairReceipt(findingIds: string[], files: string[]) {
  return repairSpawnReport({
    receiptId: 'repair-receipt',
    status: 'completed',
    changedFiles: files.map((path) => ({ path })),
    findingsAddressed: findingIds,
    value: {
      status: 'completed',
      changedFiles: files.map((path) => ({ path })),
      findingsAddressed: findingIds,
    },
  })
}

/** Repair made real file mutations but receipt is blocked/incomplete findings. */
function progressOnlyRepairReceipt(files: string[]) {
  return repairSpawnReport({
    receiptId: 'repair-progress-only',
    status: 'blocked',
    changedFiles: files.map((path) => ({ path })),
    findingsAddressed: [],
    value: {
      status: 'blocked',
      changedFiles: files.map((path) => ({ path })),
      findingsAddressed: [],
    },
  })
}

function buildDurablePassAgentState(tmpFile: string, fingerprint: string) {
  const gateFile = normalizeGateFilePath(tmpFile)
  return {
    agentId: 'base2-custom',
    base2ActiveWork: {
      changedFiles: [gateFile],
      touchedFiles: [gateFile],
      pendingGateFiles: [gateFile],
      currentPhase: 'awaiting_validation',
      latestWorkSummary: '',
      openReviewerBlockers: [],
      lastValidationSummary: 'No configured file-change hooks ran.',
      nextRequiredAction: '',
      lastPinnedStateMessage: '',
      gatePassedFiles: [gateFile],
      gatePassedPendingFiles: [gateFile],
      gatePassedReviewerVerdict: 'LOOKS_GOOD',
      gatePassedValidationSummary: 'No configured file-change hooks ran.',
      gatePassedFingerprint: fingerprint,
      gatePassedFileMarkers: {},
    },
  }
}

type ParseGitStatusLine = (line: string) => string

function extractInlineFunctionSource(
  source: string,
  functionName: string,
): string {
  const declarationStart = source.indexOf(`function ${functionName}(`)
  if (declarationStart < 0) {
    throw new Error(`Unable to find inline ${functionName} declaration`)
  }

  const bodyStart = source.indexOf('{', declarationStart)
  if (bodyStart < 0) {
    throw new Error(`Unable to find inline ${functionName} body`)
  }

  let depth = 0
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index]
    if (character === '{') depth += 1
    if (character === '}') depth -= 1
    if (depth === 0) {
      return source.slice(declarationStart, index + 1)
    }
  }

  throw new Error(`Unable to find end of inline ${functionName} declaration`)
}

// parseGitStatusLine lives inside the serialized handleSteps generator, so it
// cannot be exported as a module symbol. Extracting its source tests the actual
// inline implementation reconstructed by the runtime.
function loadInlineParseGitStatusLine(): ParseGitStatusLine {
  const base2Source = readFileSync(
    new URL('../base2/base2.ts', import.meta.url),
    'utf8',
  )
  const helperSource = extractInlineFunctionSource(
    base2Source,
    'parseGitStatusLine',
  ).replace(
    'function parseGitStatusLine(line: string): string',
    'function parseGitStatusLine(line)',
  )
  const buildHelper = new Function(
    `"use strict";\n${helperSource}\nreturn parseGitStatusLine`,
  ) as () => ParseGitStatusLine

  return buildHelper()
}

describe('base2 inline parseGitStatusLine', () => {
  const parseGitStatusLine = loadInlineParseGitStatusLine()

  test('drops untracked-directory entries (trailing slash) so they never become gate files', () => {
    // Regression: an untracked directory pseudo-entry (e.g. from an agent
    // session directory) previously became a pending gate file, so the
    // reviewer was asked to attest to a directory and the gate failed with
    // `unreadable:not-a-file`, triggering a spurious one-time reviewer retry.
    expect(parseGitStatusLine('?? .agents/sessions/foo/')).toBe('')
    expect(parseGitStatusLine('?? dir/')).toBe('')
    expect(parseGitStatusLine('R  old/ -> new/')).toBe('')
  })

  test('keeps regular file entries and rename handling', () => {
    expect(parseGitStatusLine(' M src/a.ts')).toBe('src/a.ts')
    expect(parseGitStatusLine('?? src/new.ts')).toBe('src/new.ts')
    expect(parseGitStatusLine('R  old.ts -> new.ts')).toBe('new.ts')
    expect(parseGitStatusLine('## main')).toBe('')
  })
})

describe('base2 validation/reviewer coordination prompts', () => {
  test('declares the automatically spawned context pruner for derived agents', () => {
    const executePlan = createBase2('default', { executePlan: true })

    expect(executePlan.spawnableAgents).toContain('context-pruner')
  })

  test('requires joining parallel validation and review before finalizing', () => {
    const base2 = createBase2('default')

    expect(base2.systemPrompt).toContain('Validation/review join discipline')
    expect(base2.systemPrompt).toContain(
      'Do not treat parallel reviewer approval as final approval until validation has completed',
    )
    expect(base2.systemPrompt).toContain(
      'validation failure/timeout blocks completion even if review looks good',
    )
    expect(base2.systemPrompt).toContain(
      'Omit top-level `timeout_seconds` for editor and other productive subagents',
    )
    expect(base2.systemPrompt).toContain(
      'omitted and `-1` mean no wall-clock deadline',
    )
    expect(base2.instructionsPrompt).toContain('compact implementation brief')
    expect(base2.instructionsPrompt).toContain('pass it as the editor prompt')
    expect(base2.instructionsPrompt).toContain(
      'The editor does not inherit parent conversation history',
    )
    expect(base2.instructionsPrompt).not.toContain(
      'expected validation, and key risks',
    )
    expect(base2.systemPrompt).toContain('product, Openbuff')
    expect(base2.systemPrompt).not.toContain('product, Codebuff')
    // gateAwarenessSection: runtime-owned hooks → automated reviewer (not the
    // older "runtime automatically runs configured validation hooks…" phrasing).
    expect(base2.systemPrompt).toContain(
      'the runtime-owned path is: configured file-change hooks',
    )
    expect(base2.systemPrompt).toContain('run_file_change_hooks')
    expect(base2.systemPrompt).toContain('automated code-reviewer')
    expect(base2.systemPrompt).toContain('finalization allowed when green')
    expect(base2.systemPrompt).not.toContain(
      '- Spawn a code-reviewer to review the changes after you have implemented the changes.',
    )
    expect(base2.instructionsPrompt).not.toContain(
      'Spawn a code-reviewer to review the changes after you have implemented changes',
    )
    expect(base2.stepPrompt).toContain('independently detect changed files')
    expect(base2.stepPrompt).toContain('implementation-only prompt')
    expect(base2.stepPrompt).toContain(
      'The editor does not inherit parent conversation history',
    )
    expect(base2.stepPrompt).toContain('Do not put validation commands')
    expect(base2.stepPrompt).toContain('parent-only orchestration tasks')
    expect(base2.stepPrompt).toContain(
      'Do not manually spawn code-reviewer for the same edited file set',
    )
    expect(base2.systemPrompt).toContain(
      'Manual code-reviewer use is for pre-edit/advisory review',
    )
    expect(base2.systemPrompt).toContain('Prefer dedicated harness tools')
    expect(base2.systemPrompt).toContain('Validation is dependency-neutral')
    expect(base2.systemPrompt).toContain(
      'Its absence from the root toolset is expected',
    )
    expect(base2.systemPrompt).toContain(
      'Do not delegate work merely to gain access to set_output',
    )
    expect(base2.systemPrompt).toContain(
      'Post-edit reviewer-family specialists are routed automatically',
    )
    expect(base2.systemPrompt).toContain(
      'Do not manually re-spawn them after edits, after compaction',
    )
    expect(base2.systemPrompt).toContain(
      'Repository status is injected automatically by the runtime',
    )
    expect(base2.systemPrompt).toContain(
      'instead of loading the full initial diff into every request',
    )
    expect(base2.systemPrompt).not.toContain('Initial Git Changes')
    expect(base2.spawnableAgentToolMode).toBe('generic')
    expect(base2.toolNames).not.toContain('git_status')
    expect(base2.toolNames).toContain('get_change_review_bundle')
    expect(base2.toolNames).not.toContain('run_file_change_hooks')
    expect(base2.toolNames).toContain('inspect_codebase_structure')
    expect(base2.programmaticToolNames).toEqual(
      expect.arrayContaining([
        'git_status',
        'run_file_change_hooks',
        'inspect_codebase_structure',
      ]),
    )
    expect(base2.systemPrompt).toContain('Atomic edit recovery')
    expect(base2.systemPrompt).toContain('do not peel off remembered edits')
    expect(base2.systemPrompt).toContain(
      'treat that exact finding as the controlling next action',
    )
    expect(base2.systemPrompt).toContain(
      'Copy or paraphrase the specific blocker into your todos/progress state',
    )
    expect(base2.systemPrompt).toContain('do not run another review')
    expect(base2.systemPrompt).toContain('Repeated reviewer blocker loop')
    expect(base2.systemPrompt).toContain('the exact blocker-resolution summary')
    expect(base2.instructionsPrompt).toContain(
      'do not substitute basher for git status or file discovery',
    )
    expect(base2.toolNames).toContain('suggest_followups')
    expect(base2.instructionsPrompt).toContain('suggest_followups')
    expect(base2.stepPrompt).toContain('suggest_followups')
    expect(base2.instructionsPrompt).toContain(
      'after the automated validation/reviewer gate has passed',
    )
    expect(base2.instructionsPrompt).toContain(
      'if the suggest_followups tool is available',
    )
    expect(base2.instructionsPrompt).toContain(
      'If suggest_followups is unavailable, still provide the final summary/end normally',
    )
    expect(base2.stepPrompt).toContain('if that tool is available')
    expect(base2.stepPrompt).toContain(
      'If suggest_followups is unavailable, do not let that block the final summary/end',
    )
  })

  test('plan mode requires all durable artifacts for non-trivial plans', () => {
    const base2 = createBase2('default', { planOnly: true })

    expect(base2.instructionsPrompt).toContain(
      'For non-trivial plans, create all four durable artifacts by default',
    )
    expect(base2.instructionsPrompt).toContain(
      'Normal users should not need to explicitly ask for STATUS or LESSONS artifacts',
    )
    expect(base2.stepPrompt).toContain(
      'Preserve short-answer behavior for simple questions',
    )
    expect(base2.stepPrompt).toContain(
      'create or substantially rewrite the four durable plan artifacts',
    )
    expect(base2.stepPrompt).toContain(
      'do not treat STATUS.md or LESSONS.md as optional/as-needed',
    )
  })

  test('base2 exposes update_plan_status alongside create_plan', () => {
    const base2 = createBase2('default')
    expect(base2.toolNames).toContain('create_plan')
    expect(base2.toolNames).toContain('update_plan_status')

    const planBase2 = createBase2('default', { planOnly: true })
    expect(planBase2.toolNames).toContain('update_plan_status')
  })

  test('plan mode exposes broad read-only analysis agents without mutation agents', () => {
    const planBase2 = createBase2('default', { planOnly: true })
    const spawnable = planBase2.spawnableAgents ?? []

    for (const agent of [
      'basher',
      'browser-use',
      'debugger',
      'general-agent',
    ]) {
      expect(spawnable).toContain(agent)
    }
    for (const agent of [
      'dependency-manager',
      'editor',
      'repair-editor',
      'git-committer',
      'doc-writer',
      'test-writer',
      'tmux-cli',
    ]) {
      expect(spawnable).not.toContain(agent)
    }
    expect(planBase2.toolNames).toContain('check_background_agent')
    expect(planBase2.toolNames).toContain('inspect_codebase_structure')
    expect(planBase2.toolNames).not.toContain('edit_transaction')
    expect(planBase2.toolNames).not.toContain('run_file_change_hooks')
    expect(planBase2.toolNames).not.toContain('git_status')
    expect(planBase2.programmaticConfig).toMatchObject({ planOnly: true })
  })

  test('plan mode allows repeated bounded analysis waves', () => {
    const planBase2 = createBase2('default', { planOnly: true })

    expect(planBase2.systemPrompt).toContain('at most **8** agents')
    expect(planBase2.systemPrompt).toContain(
      'split into multiple bounded waves',
    )
    expect(planBase2.instructionsPrompt).toContain(
      'as many analysis subagents as the work requires',
    )
    expect(planBase2.stepPrompt).toContain(
      'Use bounded waves of analysis subagents until coverage is complete',
    )
    expect(planBase2.systemPrompt).not.toContain('at most one bounded batch')
    expect(planBase2.systemPrompt).toContain('Dependency planning')
    expect(planBase2.systemPrompt).toContain('Live visual analysis')
    expect(planBase2.systemPrompt).not.toContain(
      'start any long-running dev server',
    )
    expect(planBase2.systemPrompt).not.toContain('spawn `dependency-manager`')
  })

  test('plan mode prompts explain incremental update_plan_status semantics', () => {
    const base2 = createBase2('default', { planOnly: true })

    expect(base2.instructionsPrompt).toContain('update_plan_status')
    expect(base2.instructionsPrompt).toContain(
      'incremental STATUS.md and LESSONS.md updates',
    )
    expect(base2.instructionsPrompt).toContain(
      'Do not use the write_todos tool in plan mode',
    )
    expect(base2.instructionsPrompt).toContain(
      'create_plan for SPEC.md and PLAN.md',
    )

    expect(base2.stepPrompt).toContain('update_plan_status')
    expect(base2.stepPrompt).toContain(
      'prefer update_plan_status for incremental STATUS.md and LESSONS.md updates',
    )
    expect(base2.stepPrompt).toContain(
      'Do not use the write_todos tool in plan mode',
    )
  })
})

describe('base-deep prompt naming and tool guidance', () => {
  test('uses Openbuff naming and current tool preferences', () => {
    const baseDeep = createBaseDeep()

    expect(baseDeep.systemPrompt).toContain('product, Openbuff')
    expect(baseDeep.systemPrompt).not.toContain('product, Codebuff')
    expect(baseDeep.systemPrompt).not.toContain(
      'directory-lister, glob-matcher',
    )
    expect(baseDeep.systemPrompt).not.toContain(
      'Prefer apply_patch for existing-file edits',
    )
    expect(baseDeep.systemPrompt).toContain(
      'edit_transaction with the narrowest edit type',
    )
    expect(baseDeep.instructionsPrompt).not.toContain(
      'Prefer apply_patch for edits',
    )
    expect(baseDeep.instructionsPrompt).toContain('through edit_transaction')
    expect(baseDeep.instructionsPrompt).toContain(
      'user-visible completion summary',
    )
    expect(baseDeep.instructionsPrompt).toContain('before suggesting followups')
    expect(baseDeep.toolNames).toEqual(
      expect.arrayContaining([
        'read_outline',
        'list_directory',
        'glob',
        'edit_transaction',
      ]),
    )
    expect(baseDeep.toolNames).not.toContain('str_replace')
    expect(baseDeep.toolNames).not.toContain('replace_range')
    expect(baseDeep.toolNames).not.toContain('rewrite_symbol')
    expect(baseDeep.toolNames).not.toContain('write_file')
    expect(baseDeep.toolNames).not.toContain('propose_str_replace')
    expect(baseDeep.programmaticToolNames).toContain('git_status')
  })
})

describe('base-deep gate lifecycle parity with base2', () => {
  test('inherits handleSteps and exposes the gate tools + repair editor', () => {
    const baseDeep = createBaseDeep()

    // base-deep inherits the full validation/reviewer gate lifecycle by
    // composing createBase2. handleSteps is a function reference (not
    // re-serialized), so its gate-state closures are preserved.
    expect(baseDeep.handleSteps).toBeDefined()
    expect(typeof baseDeep.handleSteps).toBe('function')

    // Mutating/control gate tools remain generator-only. The read-only review
    // bundle is also model-visible so the orchestrator can recover a fresh
    // snapshot after compaction without hitting a tool-availability error.
    expect(baseDeep.programmaticToolNames).toEqual(
      expect.arrayContaining(['run_file_change_hooks', 'git_status']),
    )
    expect(baseDeep.toolNames).toEqual(
      expect.arrayContaining([
        'create_plan',
        'update_plan_status',
        'get_change_review_bundle',
      ]),
    )

    // editor is required for the gate repair loop (spawned on validation
    // failure). code-reviewer runs the reviewer half of the gate.
    expect(baseDeep.spawnableAgents).toEqual(
      expect.arrayContaining(['editor', 'code-reviewer']),
    )
  })

  test('handleSteps runs the same validation gate sequence as base2', () => {
    const baseDeep = createBaseDeep()
    // 'base-deep' is not in the fast-skip allowlist (only 'base2-fast' and
    // 'base2-fast-no-validation' skip), so both validation and reviewer
    // gates run — same as base2 default.
    const agentState = { agentId: 'base-deep' }
    const gen = baseDeep.handleSteps!({
      agentState,
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    // Pre-step: git_status to detect existing changes.
    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    // spawn_agent_inline context-pruner before the first STEP.
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect(gen.next().value).toBe('STEP')
    // After the step produces a file change: git_status → run_file_change_hooks.
    const afterStep = gen.next({
      stepsComplete: true,
      toolResult: [{ type: 'json', value: editReceipt('src/a.ts') }],
    } as any)
    expect(afterStep.value).toMatchObject({ toolName: 'git_status' })
    const afterGit = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any)
    expect(afterGit.value).toMatchObject({ toolName: 'run_file_change_hooks' })
    // Gate-state tracks the pending file for the validation/reviewer gate.
    expect((agentState as any).base2ActiveWork).toMatchObject({
      changedFiles: ['src/a.ts'],
      touchedFiles: ['src/a.ts'],
      pendingGateFiles: ['src/a.ts'],
    })
  })
})

describe('base2 conversational fast path', () => {
  test('answers a fresh greeting without injecting git status or running gates', () => {
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2' }
    const generator = base2.handleSteps!({
      agentState,
      prompt: 'Hello.',
      params: {},
    } as any)

    expect(generator.next().value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect(generator.next({ toolResult: [] } as any).value).toBe('STEP')
    expect(
      generator.next({ stepsComplete: true, toolResult: [] } as any).done,
    ).toBe(true)
  })
})

describe('base2 proactive index lookup', () => {
  test('proactive query_index fires only for code-intent prompts', () => {
    const firstYield = (prompt: string) => {
      const base2 = createBase2('default')
      const gen = base2.handleSteps!({
        agentState: { agentId: 'base2-classify' },
        prompt,
        params: {},
        config: base2.programmaticConfig,
      } as any)
      return gen.next().value as any
    }

    // A code-intent prompt with no concrete file path triggers a proactive
    // query_index (mode: 'search') as the very first step.
    expect(
      firstYield('Refactor the authentication module code.'),
    ).toMatchObject({ toolName: 'query_index', input: { mode: 'search' } })

    // A prompt naming a concrete file path already identifies the relevant
    // file, so proactive retrieval is skipped and the turn starts at git_status.
    expect(firstYield('Update src/app.ts with the new export')).toMatchObject({
      toolName: 'git_status',
    })

    // Too-short prompts skip proactive retrieval.
    expect(firstYield('fix it')).toMatchObject({ toolName: 'git_status' })

    // Continuation prompts skip proactive retrieval.
    expect(
      firstYield('continue working on the previous task'),
    ).toMatchObject({ toolName: 'git_status' })
  })

  test('starts codebase-oriented prompts with query_index', () => {
    const base2 = createBase2('default')
    const generator = base2.handleSteps!({
      prompt: 'Where is authentication configured in this codebase?',
      params: {},
    } as any)

    expect(generator.next().value).toEqual({
      toolName: 'query_index',
      input: {
        query: 'Where is authentication configured in this codebase?',
        limit: 14,
        mode: 'search',
      },
    })
  })

  test('uses explained wider retrieval for broad cross-subsystem audits', () => {
    const base2 = createBase2('default')
    const generator = base2.handleSteps!({
      prompt:
        'Audit context and indexing across the SDK, runtime, CLI, and tests for feature gaps',
      params: {},
    } as any)

    expect(generator.next().value).toEqual({
      toolName: 'inspect_codebase_structure',
      input: {},
    })
    expect(generator.next().value).toEqual({
      toolName: 'list_directory',
      input: { path: '.' },
    })
    expect(generator.next().value).toMatchObject({
      toolName: 'add_message',
      input: {
        content: expect.stringContaining('Production breadth guard'),
      },
    })
    expect(generator.next().value).toMatchObject({
      toolName: 'query_index',
      input: { mode: 'explain', limit: 30 },
    })
  })

  test('does not restart proactive discovery for a continuity-only prompt', () => {
    const base2 = createBase2('default')
    const generator = base2.handleSteps!({
      prompt: 'Continue with the existing implementation',
      params: {},
    } as any)

    expect(generator.next().value).toMatchObject({ toolName: 'git_status' })
  })

  test('does not query_index for generic chat prompts', () => {
    const base2 = createBase2('default')
    const generator = base2.handleSteps!({
      prompt: 'How are you doing today?',
      params: {},
    } as any)

    expect(generator.next().value).toMatchObject({
      toolName: 'git_status',
      input: {},
    })
  })

  test('does not run proactive discovery when the prompt names explicit file paths', () => {
    const base2 = createBase2('default')
    const generator = base2.handleSteps!({
      prompt:
        'Fix the abort handler in sdk/src/tools/code-search.ts and update its test',
      params: {},
    } as any)

    expect(generator.next().value).toMatchObject({ toolName: 'git_status' })
  })
})

describe('base2 verification and reviewer gates', () => {
  test('serialized handleSteps does not depend on createBase2 closure variables', () => {
    const base2 = createBase2('default')
    const serializedHandleSteps = new Function(
      `return (${base2.handleSteps!.toString()})`,
    )() as NonNullable<typeof base2.handleSteps>
    const gen = serializedHandleSteps({
      agentState: { agentId: 'base2' },
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [{ type: 'json', value: editReceipt('src/a.ts') }],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'run_file_change_hooks' })
  })

  test('failed verification hooks reopen the turn so failures get fixed', () => {
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Make the requested change now please',
      params: {},
      config: base2.programmaticConfig,
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect(gen.next().value).toBe('STEP')
    const afterStep = gen.next({
      stepsComplete: true,
      toolResult: [{ type: 'json', value: editReceipt('src/a.ts') }],
    } as any)
    expect(afterStep.value).toMatchObject({ toolName: 'git_status' })
    const afterGit = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any)
    expect(afterGit.value).toMatchObject({ toolName: 'run_file_change_hooks' })

    const afterHooks = gen.next({
      toolResult: [
        {
          type: 'json',
          value: [{ hookName: 'typecheck', exitCode: 1, stderr: 'TS2322' }],
        },
      ],
    } as any)
    expect(afterHooks.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    const text = (afterHooks.value as any).input.content as string
    expect(text).toContain('Verification gate')
    const hookFailGate = parseGateStateBlock(text)
    expect(hookFailGate).toMatchObject({
      gate: 'validation',
      status: 'failed',
    })
    expect(hookFailGate!.details).toContain('validation-hook-failures')
    expect((agentState as any).base2ActiveWork).toMatchObject({
      changedFiles: ['src/a.ts'],
      touchedFiles: ['src/a.ts'],
      pendingGateFiles: ['src/a.ts'],
      nextRequiredAction:
        'Fix the blocking validation hook failures before doing anything else.',
    })
  })

  test('passing verification hooks trigger code review before completion for non-allowlisted default ids', () => {
    const tmpDir = makeProjectTempDir('base2-passing-hooks-review-')
    try {
      const base2 = createBase2('default')
      expect(base2.spawnableAgents).toContain('code-reviewer')
      const tmpFile = join(tmpDir, 'a.ts')
      const gateFile = normalizeGateFilePath(tmpFile)
      writeFileSync(tmpFile, 'export const value = 1\n')
      const agentState = { agentId: 'base2-custom' }
      const gen = base2.handleSteps!({
        agentState,
        prompt: 'Make the requested change now please',
        params: {},
        config: base2.programmaticConfig,
      } as any)

      expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
      expect(
        gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
          .value,
      ).toMatchObject({ toolName: 'spawn_agent_inline' })
      expect(gen.next().value).toBe('STEP')
      const afterStep = gen.next({
        stepsComplete: true,
        toolResult: [{ type: 'json', value: editReceipt(gateFile) }],
      } as any)
      expect(afterStep.value).toMatchObject({ toolName: 'git_status' })
      const afterGit = gen.next({
        toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
      } as any)
      expect(afterGit.value).toMatchObject({ toolName: 'run_file_change_hooks' })
      const afterHooks = gen.next({
        toolResult: [
          {
            type: 'json',
            value: [
              {
                validationStatus: 'hooks_skipped',
                message:
                  'Configured file-change hooks were skipped because none matched the changed files.',
                configuredHookCount: 1,
                changedFiles: [gateFile],
              },
            ],
          },
        ],
      } as any)
      expect(afterHooks.value).toMatchObject({ toolName: 'git_status' })
      const reviewCall = gen.next({
        toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
      } as any)
      expect(reviewCall.value).toMatchObject({
        toolName: 'spawn_agents',
        input: { agents: [{ agent_type: 'code-reviewer' }] },
      })
      expect((agentState as any).base2ActiveWork.lastValidationSummary).toBe(
        'REDUCED_ASSURANCE: Configured file-change hooks were skipped because none matched the changed files.',
      )
      const afterReview = gen.next(
        attestedReviewerResult(reviewCall.value) as any,
      )
      expect(afterReview.value).toMatchObject({ toolName: 'git_status' })
      const gatePassed = gen.next({
        toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
      } as any)
      expect(gatePassed.value).toMatchObject({
        toolName: 'add_message',
        input: { role: 'user' },
      })
      expect((gatePassed.value as any).input.content).toMatch(
        /reviewer gate passed with LOOKS_GOOD/i,
      )
      const passGate = parseGateStateBlock(
        (gatePassed.value as any).input.content as string,
      )
      expect(passGate).toMatchObject({
        gate: 'validation/reviewer',
        status: 'passed',
      })
      expect(passGate!.details).toContain('LOOKS_GOOD')
      expect((agentState as any).base2ActiveWork).toMatchObject({
        changedFiles: [gateFile],
        touchedFiles: [gateFile],
        pendingGateFiles: [],
        currentPhase: 'final_response_allowed',
        openReviewerBlockers: [],
        nextRequiredAction: '',
      })
      expect(gen.next().value).toMatchObject({
        toolName: 'git_status',
        input: { include_diff: true },
      })
      expect(
        gen.next({
          toolResult: [
            { type: 'json', value: { status: ` M ${gateFile}`, diff: 'diff' } },
          ],
        } as any).value,
      ).toMatchObject({ toolName: 'spawn_agent_inline' })
      const maybePinnedState = gen.next().value
      if (maybePinnedState !== 'STEP') {
        expect(maybePinnedState).toMatchObject({
          toolName: 'add_message',
          input: { role: 'user' },
        })
        expect(gen.next().value).toBe('STEP')
      }
      expect(
        gen.next({ stepsComplete: true, toolResult: [] } as any).value,
      ).toMatchObject({ toolName: 'git_status' })
      const done = gen.next({
        toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
      } as any)
      expect(done.done).toBe(true)

      const followupGen = base2.handleSteps!({
        agentState,
        prompt: 'Thanks, finish up.',
        params: {},
      } as any)
      expect(followupGen.next().value).toMatchObject({ toolName: 'git_status' })
      expect(
        followupGen.next({
          toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
        } as any).value,
      ).toMatchObject({ toolName: 'spawn_agent_inline' })
      const followupStep = followupGen.next()
      expect(followupStep.value).toBe('STEP')
      expect(
        followupGen.next({ stepsComplete: true, toolResult: [] } as any).value,
      ).toMatchObject({ toolName: 'git_status' })
      const followupDone = followupGen.next({
        toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
      } as any)
      expect(followupDone.done).toBe(true)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('absolute and relative paths share durable gate-passed state after review', () => {
    const tmpDir = makeProjectTempDir('base2-abs-rel-')
    try {
      const base2 = createBase2('default')
      const agentState = { agentId: 'base2-custom' }
      const tmpFile = join(tmpDir, 'a.ts')
      const gateFile = normalizeGateFilePath(tmpFile)
      writeFileSync(tmpFile, 'export const value = 1\n')
      const gen = base2.handleSteps!({
        agentState,
        prompt: 'Make the requested change now please',
        params: {},
      } as any)

      expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
      expect(
        gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
          .value,
      ).toMatchObject({ toolName: 'spawn_agent_inline' })
      expect(gen.next().value).toBe('STEP')
      expect(
        gen.next({
          stepsComplete: true,
          toolResult: [
            { type: 'json', value: editReceipt(`file://${tmpFile}`) },
          ],
        } as any).value,
      ).toMatchObject({ toolName: 'git_status' })
      expect(
        gen.next({
          toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
        } as any).value,
      ).toMatchObject({
        toolName: 'run_file_change_hooks',
        input: { files: [gateFile] },
      })
      const afterHooks = gen.next({
        toolResult: [{ type: 'json', value: [] }],
      } as any)
      expect(afterHooks.value).toMatchObject({ toolName: 'git_status' })
      const reviewCall = gen.next({
        toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
      } as any).value
      expect(reviewCall).toMatchObject({ toolName: 'spawn_agents' })
      expect(
        gen.next(attestedReviewerResult(reviewCall) as any).value,
      ).toMatchObject({ toolName: 'git_status' })
      expect(
        gen.next({
          toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
        } as any).value,
      ).toMatchObject({ toolName: 'add_message' })
      expect((agentState as any).base2ActiveWork).toMatchObject({
        changedFiles: [gateFile],
        touchedFiles: [gateFile],
        pendingGateFiles: [],
        gatePassedFiles: [gateFile],
        currentPhase: 'final_response_allowed',
      })

      expect(gen.next().value).toMatchObject({
        toolName: 'git_status',
        input: { include_diff: true },
      })
      expect(
        gen.next({
          toolResult: [
            { type: 'json', value: { status: ` M ${gateFile}`, diff: 'diff' } },
          ],
        } as any).value,
      ).toMatchObject({ toolName: 'spawn_agent_inline' })
      expect(gen.next().value).toBe('STEP')
      expect(
        gen.next({ stepsComplete: true, toolResult: [] } as any).value,
      ).toMatchObject({ toolName: 'git_status' })
      const done = gen.next({
        toolResult: [{ type: 'json', value: { status: ` M ${tmpFile}` } }],
      } as any)

      expect(done.done).toBe(true)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('structured reviewer approval allows finalization', () => {
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2-custom' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [{ type: 'json', value: editReceipt('src/a.ts') }],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'run_file_change_hooks' })
    const postValidationStatus = gen.next({
      toolResult: [{ type: 'json', value: [] }],
    } as any).value
    expect(postValidationStatus).toMatchObject({ toolName: 'git_status' })
    const reviewCall = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any).value
    expect(reviewCall).toMatchObject({ toolName: 'spawn_agents' })
    const finalPreCreditStatus = gen.next(
      attestedReviewerResult(reviewCall) as any,
    ).value
    expect(finalPreCreditStatus).toMatchObject({ toolName: 'git_status' })
    const gatePassed = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any)

    expect(gatePassed.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect((gatePassed.value as any).input.content.toLowerCase()).toContain(
      'reviewer gate passed with looks_good',
    )
    expect((agentState as any).base2ActiveWork).toMatchObject({
      pendingGateFiles: [],
      currentPhase: 'final_response_allowed',
      openReviewerBlockers: [],
      nextRequiredAction: '',
    })
  })

  test('structured reviewer response records durable pass state', () => {
    const tmpDir = makeProjectTempDir('base2-durable-pass-')
    try {
      const base2 = createBase2('default')
      const tmpFile = join(tmpDir, 'a.ts')
      const gateFile = normalizeGateFilePath(tmpFile)
      writeFileSync(tmpFile, 'export const value = 1\n')
      const agentState = { agentId: 'base2-custom' }
      const gen = base2.handleSteps!({
        agentState,
        prompt: 'Make the requested change now please',
        params: {},
      } as any)

      expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
      expect(
        gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
          .value,
      ).toMatchObject({ toolName: 'spawn_agent_inline' })
      expect(gen.next().value).toBe('STEP')
      expect(
        gen.next({
          stepsComplete: true,
          toolResult: [{ type: 'json', value: editReceipt(gateFile) }],
        } as any).value,
      ).toMatchObject({ toolName: 'git_status' })
      expect(
        gen.next({
          toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
        } as any).value,
      ).toMatchObject({ toolName: 'run_file_change_hooks' })
      const postValidationStatus = gen.next({
        toolResult: [{ type: 'json', value: [] }],
      } as any).value
      expect(postValidationStatus).toMatchObject({ toolName: 'git_status' })
      const reviewCall = gen.next({
        toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
      } as any).value
      expect(reviewCall).toMatchObject({ toolName: 'spawn_agents' })
      const finalPreCreditStatus = gen.next(
        attestedReviewerResult(reviewCall) as any,
      ).value
      expect(finalPreCreditStatus).toMatchObject({ toolName: 'git_status' })
      const gatePassed = gen.next({
        toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
      } as any)

      expect(gatePassed.value).toMatchObject({ toolName: 'add_message' })
      expect((gatePassed.value as any).input.content).toMatch(
        /reviewer gate passed with LOOKS_GOOD/i,
      )
      expect((agentState as any).base2ActiveWork).toMatchObject({
        pendingGateFiles: [],
        gatePassedFiles: [gateFile],
        gatePassedPendingFiles: [gateFile],
        gatePassedReviewerVerdict: 'LOOKS_GOOD',
        gatePassedValidationSummary: 'No configured file-change hooks ran.',
        currentPhase: 'final_response_allowed',
      })
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('durable gate pass does not reuse when no fingerprint is recorded (fail closed)', () => {
    const base2 = createBase2('default')
    // Older serialized state without `gatePassedFingerprint`. The harness must
    // fail closed and re-run validation/review instead of reusing the pass
    // purely on file-set match, because a same-path content change between
    // turns would otherwise silently bypass the gate.
    const agentState = {
      agentId: 'base2-custom',
      base2ActiveWork: {
        changedFiles: ['src/a.ts'],
        touchedFiles: ['src/a.ts'],
        pendingGateFiles: ['src/a.ts'],
        currentPhase: 'awaiting_validation',
        latestWorkSummary: '',
        openReviewerBlockers: [],
        lastValidationSummary: 'No configured file-change hooks ran.',
        nextRequiredAction: '',
        lastPinnedStateMessage: '',
        gatePassedFiles: ['src/a.ts'],
        gatePassedPendingFiles: ['src/a.ts'],
        gatePassedReviewerVerdict: 'LOOKS_GOOD',
        gatePassedValidationSummary: 'No configured file-change hooks ran.',
      },
    }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Finish the previous response.',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    const maybePinnedState = gen.next().value
    if (maybePinnedState !== 'STEP') {
      expect(maybePinnedState).toMatchObject({ toolName: 'add_message' })
      expect(gen.next().value).toBe('STEP')
    }
    expect(
      gen.next({ stepsComplete: true, toolResult: [] } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const next = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any)

    // No fingerprint -> no durable reuse -> validation hooks rerun.
    expect(next.value).toMatchObject({
      toolName: 'run_file_change_hooks',
      input: { files: ['src/a.ts'] },
    })
  })

  test('reuses prior passed conversation gate-state for unchanged pending files', () => {
    const base2 = createBase2('default')
    const tmpDir = makeProjectTempDir('base2-conversation-pass-')
    try {
      const fileA = join(tmpDir, 'a.ts')
      const fileB = join(tmpDir, 'b.ts')
      const gateFileA = normalizeGateFilePath(fileA)
      const gateFileB = normalizeGateFilePath(fileB)
      writeFileSync(fileA, 'export const a = 1\n')
      writeFileSync(fileB, 'export const b = 2\n')
      const validationSummary =
        'Configured file-change hooks passed: typecheck.'
      const fingerprint = buildFingerprint(
        [
          {
            file: gateFileA,
            statusLine: ` M ${fileA}`,
            contentMarker: buildContentMarker(fileA),
          },
          {
            file: gateFileB,
            statusLine: ` M ${fileB}`,
            contentMarker: buildContentMarker(fileB),
          },
        ],
        validationSummary,
      )
      const passedGateState = `<gate-state>{"gate":"validation/reviewer","status":"passed","details":"reviewer verdict LOOKS_GOOD; validation hooks ran; pending files: ${fileA}, ${fileB}; completed"}</gate-state>`
      const agentState = {
        agentId: 'base2-custom',
        messageHistory: [
          {
            role: 'user',
            content: `Manual/runtime gate passed. ${passedGateState}`,
          },
        ],
        base2ActiveWork: {
          changedFiles: [gateFileA, gateFileB],
          touchedFiles: [gateFileA, gateFileB],
          pendingGateFiles: [gateFileA, gateFileB],
          currentPhase: 'awaiting_validation',
          latestWorkSummary: 'Pending gate already passed manually.',
          openReviewerBlockers: [],
          lastValidationSummary: validationSummary,
          nextRequiredAction: '',
          lastPinnedStateMessage: '',
          gatePassedPendingFiles: [gateFileA, gateFileB],
          gatePassedReviewerVerdict: 'LOOKS_GOOD',
          gatePassedValidationSummary: validationSummary,
          gatePassedFingerprint: fingerprint,
        },
      }
      const gen = base2.handleSteps!({
        agentState,
        prompt: 'Finish the previous response.',
        params: {},
      } as any)

      expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
      expect(
        gen.next({
          toolResult: [
            {
              type: 'json',
              value: { status: ` M ${fileA}\n M ${fileB}` },
            },
          ],
        } as any).value,
      ).toMatchObject({ toolName: 'spawn_agent_inline' })
      const maybePinnedState = gen.next().value
      if (maybePinnedState !== 'STEP') {
        expect(maybePinnedState).toMatchObject({ toolName: 'add_message' })
        expect(gen.next().value).toBe('STEP')
      }
      expect(
        gen.next({ stepsComplete: true, toolResult: [], agentState } as any)
          .value,
      ).toMatchObject({ toolName: 'git_status' })
      const reused = gen.next({
        toolResult: [
          {
            type: 'json',
            value: { status: ` M ${fileA}\n M ${fileB}` },
          },
        ],
      } as any)

      expect(reused.value).toMatchObject({
        toolName: 'add_message',
        input: { role: 'user' },
      })
      const content = (reused.value as any).input.content as string
      expect(content).toContain(
        'Previous validation and reviewer gate already passed in this conversation',
      )
      expect(content).toContain('conversation gate-state reuse')
      expect(parseGateStateBlock(content)).toMatchObject({
        gate: 'validation/reviewer',
        status: 'passed',
      })
      expect((agentState as any).base2ActiveWork).toMatchObject({
        pendingGateFiles: [],
        openReviewerBlockers: [],
        nextRequiredAction: '',
        currentPhase: 'final_response_allowed',
        gatePassedFiles: [gateFileA, gateFileB],
        gatePassedPendingFiles: [gateFileA, gateFileB],
        gatePassedReviewerVerdict: 'LOOKS_GOOD',
      })
      expect((agentState as any).canSuggestFollowups).toBe(true)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('does not reuse prior conversation gate-state when local file content changed', () => {
    const base2 = createBase2('default')
    const tmpDir = makeProjectTempDir('base2-stale-conversation-pass-')
    try {
      const tmpFile = join(tmpDir, 'a.ts')
      const gateFile = normalizeGateFilePath(tmpFile)
      writeFileSync(tmpFile, 'export const value = 1\n')
      const validationSummary =
        'Configured file-change hooks passed: typecheck.'
      const fingerprint = buildFingerprint(
        [
          {
            file: gateFile,
            statusLine: ` M ${tmpFile}`,
            contentMarker: buildContentMarker(tmpFile),
          },
        ],
        validationSummary,
      )
      writeFileSync(tmpFile, 'export const value = 2\n')
      const passedGateState = `<gate-state>{"gate":"validation/reviewer","status":"passed","details":"reviewer verdict LOOKS_GOOD; validation hooks ran; pending files: ${tmpFile}; completed"}</gate-state>`
      const agentState = {
        agentId: 'base2-custom',
        messageHistory: [{ role: 'user', content: passedGateState }],
        base2ActiveWork: {
          changedFiles: [gateFile],
          touchedFiles: [gateFile],
          pendingGateFiles: [gateFile],
          currentPhase: 'awaiting_validation',
          latestWorkSummary: 'Pending gate previously passed.',
          openReviewerBlockers: [],
          lastValidationSummary: validationSummary,
          nextRequiredAction: '',
          lastPinnedStateMessage: '',
          gatePassedPendingFiles: [gateFile],
          gatePassedReviewerVerdict: 'LOOKS_GOOD',
          gatePassedValidationSummary: validationSummary,
          gatePassedFingerprint: fingerprint,
        },
      }
      const gen = base2.handleSteps!({
        agentState,
        prompt: 'Finish the previous response.',
        params: {},
      } as any)

      expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
      expect(
        gen.next({
          toolResult: [{ type: 'json', value: { status: ` M ${tmpFile}` } }],
        } as any).value,
      ).toMatchObject({ toolName: 'spawn_agent_inline' })
      const maybePinnedState = gen.next().value
      if (maybePinnedState !== 'STEP') {
        expect(maybePinnedState).toMatchObject({ toolName: 'add_message' })
        expect(gen.next().value).toBe('STEP')
      }
      expect(
        gen.next({ stepsComplete: true, toolResult: [], agentState } as any)
          .value,
      ).toMatchObject({ toolName: 'git_status' })
      const next = gen.next({
        toolResult: [{ type: 'json', value: { status: ` M ${tmpFile}` } }],
      } as any)

      expect(next.value).toMatchObject({
        toolName: 'run_file_change_hooks',
        input: { files: [gateFile] },
      })
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('reuses prior gate pass after a commit clears the status line (content unchanged)', () => {
    // Regression: the gate fingerprint must be content-only (files-v4), not
    // include the volatile git status line. A commit clears the status line
    // but leaves file bytes identical; the fingerprint must still match so
    // the reviewer is NOT re-run on unchanged content.
    const base2 = createBase2('default')
    const tmpDir = makeProjectTempDir('base2-commit-reuse-')
    try {
      const tmpFile = join(tmpDir, 'a.ts')
      const gateFile = normalizeGateFilePath(tmpFile)
      writeFileSync(tmpFile, 'export const value = 1\n')
      const validationSummary =
        'Configured file-change hooks passed: typecheck.'
      // Fingerprint built with the content marker only (status line excluded).
      const fingerprint = buildFingerprint(
        [{ file: gateFile, contentMarker: buildContentMarker(tmpFile) }],
        validationSummary,
      )
      const passedGateState = `<gate-state>{"gate":"validation/reviewer","status":"passed","details":"reviewer verdict LOOKS_GOOD; validation hooks ran; pending files: ${tmpFile}; completed"}</gate-state>`
      const agentState = {
        agentId: 'base2-custom',
        messageHistory: [{ role: 'user', content: passedGateState }],
        base2ActiveWork: {
          changedFiles: [gateFile],
          touchedFiles: [gateFile],
          pendingGateFiles: [gateFile],
          currentPhase: 'awaiting_validation',
          latestWorkSummary: 'Pending gate previously passed.',
          openReviewerBlockers: [],
          lastValidationSummary: validationSummary,
          nextRequiredAction: '',
          lastPinnedStateMessage: '',
          gatePassedPendingFiles: [gateFile],
          gatePassedReviewerVerdict: 'LOOKS_GOOD',
          gatePassedValidationSummary: validationSummary,
          gatePassedFingerprint: fingerprint,
          gatePassedFileMarkers: { [gateFile]: buildContentMarker(tmpFile) },
        },
      }
      const gen = base2.handleSteps!({
        agentState,
        prompt: 'Finish the previous response.',
        params: {},
      } as any)

      expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
      expect(
        gen.next({
          toolResult: [
            { type: 'json', value: { status: ` M ${tmpFile}` } },
          ],
        } as any).value,
      ).toMatchObject({ toolName: 'spawn_agent_inline' })
      const maybePinnedState = gen.next().value
      if (maybePinnedState !== 'STEP') {
        expect(maybePinnedState).toMatchObject({ toolName: 'add_message' })
        expect(gen.next().value).toBe('STEP')
      }
      expect(
        gen.next({ stepsComplete: true, toolResult: [], agentState } as any)
          .value,
      ).toMatchObject({ toolName: 'git_status' })
      // Simulate a commit: git status is now clean (empty), but file content is
      // unchanged. The content-only fingerprint still matches, so the gate
      // short-circuits directly to a conversation-gate-state reuse instead of
      // re-running the file-change hooks or the reviewer on unchanged content.
      const reused = gen.next({
        toolResult: [{ type: 'json', value: { status: '' } }],
      } as any)
      expect(reused.value).toMatchObject({
        toolName: 'add_message',
        input: { role: 'user' },
      })
      const content = (reused.value as any).input.content as string
      expect(content).toContain(
        'Previous validation and reviewer gate already passed in this conversation with LOOKS_GOOD for pending files:',
      )
      expect(content).toContain(gateFile)
      expect((agentState as any).base2ActiveWork).toMatchObject({
        pendingGateFiles: [],
        currentPhase: 'final_response_allowed',
      })
      expect((agentState as any).canSuggestFollowups).toBe(true)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('does not reuse prior conversation gate-state after later file-changing messages', () => {
    const base2 = createBase2('default')
    const passedGateState =
      '<gate-state>{"gate":"validation/reviewer","status":"passed","details":"reviewer verdict LOOKS_GOOD; pending files: src/a.ts"}</gate-state>'
    const agentState = {
      agentId: 'base2-custom',
      messageHistory: [
        { role: 'user', content: passedGateState },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolName: 'str_replace',
              input: { path: 'src/a.ts', replacements: [] },
            },
          ],
        },
      ],
      base2ActiveWork: {
        changedFiles: ['src/a.ts'],
        touchedFiles: ['src/a.ts'],
        pendingGateFiles: ['src/a.ts'],
        currentPhase: 'awaiting_validation',
        latestWorkSummary: '',
        openReviewerBlockers: [],
        lastValidationSummary: 'No configured file-change hooks ran.',
        nextRequiredAction: '',
        lastPinnedStateMessage: '',
      },
    }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Finish the previous response.',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    const maybePinnedState = gen.next().value
    if (maybePinnedState !== 'STEP') {
      expect(maybePinnedState).toMatchObject({ toolName: 'add_message' })
      expect(gen.next().value).toBe('STEP')
    }
    expect(
      gen.next({ stepsComplete: true, toolResult: [], agentState } as any)
        .value,
    ).toMatchObject({ toolName: 'git_status' })
    const next = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any)

    expect(next.value).toMatchObject({
      toolName: 'run_file_change_hooks',
      input: { files: ['src/a.ts'] },
    })
  })

  test('hitStepCap breaks out instead of falling through to the validation/reviewer gate', () => {
    // Regression: when an explicit fixed cap (stepsRemaining === 0) fires, the LLM
    // step returns shouldEndTurn=true. Before the hitStepCap flag was threaded
    // through, base2 fell through to the gate (since `if (!stepsComplete)
    // continue` didn't trigger for stepsComplete=true). The gate would re-yield
    // STEP, which would re-trigger the step-cap (stepsRemaining still 0),
    // causing an infinite loop between the step-cap guard and the reviewer.
    // With hitStepCap, base2 breaks out immediately and finalizes.
    const base2 = createBase2('default')
    const agentState = {
      agentId: 'base2-custom',
      base2ActiveWork: {
        changedFiles: ['src/a.ts'],
        touchedFiles: ['src/a.ts'],
        pendingGateFiles: ['src/a.ts'],
        currentPhase: 'awaiting_validation',
        latestWorkSummary: '',
        openReviewerBlockers: [],
        lastValidationSummary: 'No configured file-change hooks ran.',
        nextRequiredAction: '',
        lastPinnedStateMessage: '',
      },
    }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Continue working',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    const maybePinnedState = gen.next().value
    if (maybePinnedState !== 'STEP') {
      expect(maybePinnedState).toMatchObject({ toolName: 'add_message' })
      expect(gen.next().value).toBe('STEP')
    }

    // The LLM step hit the step-cap: shouldEndTurn=true AND hitStepCap=true.
    const stepResult = gen.next({
      stepsComplete: true,
      hitStepCap: true,
      toolResult: [{ type: 'json', value: editReceipt('src/a.ts') }],
    } as any)

    // The generator must break out (return done) rather than yield the
    // git_status tool call that precedes the gate. If it fell through to the
    // gate, this would be a git_status yield instead of done.
    expect(stepResult.done).toBe(true)
    expect((agentState as any).base2ActiveWork.currentPhase).toBe('blocked')
    expect((agentState as any).base2ActiveWork.nextRequiredAction).toContain(
      'Step cap reached',
    )
    expect((agentState as any).base2ActiveWork.pendingGateFiles).toEqual([
      'src/a.ts',
    ])
    expect((agentState as any).canSuggestFollowups).toBe(false)
  })

  test('allows suggest_followups on a clean analysis turn with no edits or pending gate work', () => {
    // Regression: a pure analysis/question turn (no edits this turn, empty
    // pending gate set, clean working tree, idle phase) must not be blocked
    // from calling suggest_followups. There is nothing to validate or commit,
    // so the gate should treat the turn as open.
    const base2 = createBase2('default')
    const agentState: Record<string, unknown> = { agentId: 'base2' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Can you confirm whether those earlier reports still hold',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    // Clean working tree at turn start.
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: '' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    // Idle, clean turn produces no pinned-state message, so the next yield is
    // STEP and suggest_followups is already permitted.
    expect(gen.next().value).toBe('STEP')
    expect((agentState as any).canSuggestFollowups).toBe(true)
  })

  test('still blocks suggest_followups when the working tree is dirty at turn start', () => {
    // Guard for the analysis-turn allowance: a turn that makes no edits *this
    // turn* but starts with an unvalidated dirty working tree must not be
    // treated as clean analysis. initialGitStatusFiles being non-empty keeps
    // the gate closed so pre-existing changes still require validation/review.
    const base2 = createBase2('default')
    const agentState: Record<string, unknown> = { agentId: 'base2' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Can you confirm whether those earlier reports still hold',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/foo.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    const maybePinnedState = gen.next().value
    if (maybePinnedState !== 'STEP') {
      expect(maybePinnedState).toMatchObject({ toolName: 'add_message' })
      expect(gen.next().value).toBe('STEP')
    }
    expect((agentState as any).canSuggestFollowups).toBe(false)
  })

  test('publishes uncommittedUnvalidatedFiles: agent-touched dirty files not covered by a gate pass', () => {
    // The git-committer commit guard in the tool executor relies on base2
    // publishing the set of working-tree files that are dirty, touched by this
    // agent, and NOT covered by a green gate pass. A turn can start with an
    // already-gate-passed file A plus a never-validated agent-touched dirty
    // file B; only B must appear in the published set so the executor can
    // refuse to stage B while allowing A. Dirty files the agent never touched
    // (e.g. left dirty by another agent or process sharing the codebase) must
    // NOT be published, so unrelated work no longer blocks commits.
    const base2 = createBase2('default')
    const tmpDir = makeProjectTempDir('base2-unvalidated-files-')
    try {
      const tmpFile = join(tmpDir, 'a.ts')
      const gateFile = normalizeGateFilePath(tmpFile)
      writeFileSync(tmpFile, 'export const value = 1\n')
      const agentState: Record<string, unknown> = {
        agentId: 'base2',
        base2ActiveWork: {
          changedFiles: [gateFile, 'src/b.ts'],
          touchedFiles: [gateFile, 'src/b.ts'],
          pendingGateFiles: [],
          currentPhase: 'final_response_allowed',
          latestWorkSummary: '',
          openReviewerBlockers: [],
          lastValidationSummary: 'Configured file-change hooks passed: typecheck.',
          nextRequiredAction: '',
          lastPinnedStateMessage: '',
          gatePassedFiles: [gateFile],
          gatePassedFileMarkers: { [gateFile]: buildContentMarker(tmpFile) },
        },
      }
      const gen = base2.handleSteps!({
        agentState,
        prompt: 'Finish the previous response.',
        params: {},
      } as any)

      expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
      // Working tree is dirty on the gate-passed file A, the never-validated
      // agent-touched file B, and the never-touched file C.
      expect(
        gen.next({
          toolResult: [
            {
              type: 'json',
              value: { status: ` M ${gateFile}\n M src/b.ts\n M src/c.ts` },
            },
          ],
        } as any).value,
      ).toMatchObject({ toolName: 'spawn_agent_inline' })
      const maybePinnedState = gen.next().value
      if (maybePinnedState !== 'STEP') {
        expect(maybePinnedState).toMatchObject({ toolName: 'add_message' })
        expect(gen.next().value).toBe('STEP')
      }

      // Only the never-validated agent-touched dirty file B is published; the
      // gate-passed file A and the untouched file C are excluded.
      expect((agentState as any).uncommittedUnvalidatedFiles).toEqual(['src/b.ts'])
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })


  test('historical changed files alone do not trigger stale validation or review', () => {
    const base2 = createBase2('default')
    const agentState = {
      agentId: 'base2',
      base2ActiveWork: {
        changedFiles: ['src/old.ts'],
        touchedFiles: ['src/old.ts'],
        pendingGateFiles: [],
        latestWorkSummary: 'Previous completed work touched: src/old.ts',
        openReviewerBlockers: [],
        lastValidationSummary:
          'Configured file-change hooks passed: typecheck.',
        nextRequiredAction: '',
        lastPinnedStateMessage: '',
      },
    }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Finish the previous response.',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/old.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({ stepsComplete: true, toolResult: [] } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const finalGate = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/old.ts' } }],
    } as any)
    expect(finalGate.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect((finalGate.value as any).input.content).toContain(
      'No edited files were detected.',
    )
    expect(gen.next().value).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({ stepsComplete: true, toolResult: [] } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const done = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/old.ts' } }],
    } as any)
    expect(done.done).toBe(true)
  })

  test('historical changed files gate only newly detected edits', () => {
    const base2 = createBase2('default')
    const agentState = {
      agentId: 'base2',
      base2ActiveWork: {
        changedFiles: ['src/old.ts'],
        touchedFiles: ['src/old.ts'],
        pendingGateFiles: [],
        latestWorkSummary: '',
        openReviewerBlockers: [],
        lastValidationSummary: '',
        nextRequiredAction: '',
        lastPinnedStateMessage: '',
      },
    }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/old.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [{ type: 'json', value: editReceipt('src/new.ts') }],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const afterGit = gen.next({
      toolResult: [
        { type: 'json', value: { status: ' M src/old.ts\n M src/new.ts' } },
      ],
    } as any)
    expect(afterGit.value).toMatchObject({
      toolName: 'run_file_change_hooks',
      input: { files: ['src/old.ts', 'src/new.ts'] },
    })
  })

  test('ignores non-edit tool results with file fields when detecting changes', () => {
    const base2 = createBase2('default')
    const gen = base2.handleSteps!({
      agentState: { agentId: 'base2' },
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [
          {
            type: 'json',
            value: {
              file: 'src/read-only.ts',
              errorMessage: 'read_files failed',
            },
          },
        ],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const finalGate = gen.next({
      toolResult: [{ type: 'json', value: { status: '' } }],
    } as any)
    expect(finalGate.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect((finalGate.value as any).input.content).toContain(
      'No edited files were detected.',
    )
    expect(gen.next().value).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({ stepsComplete: true, toolResult: [] } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const done = gen.next({
      toolResult: [{ type: 'json', value: { status: '' } }],
    } as any)

    expect(done.done).toBe(true)
  })

  test('ignores unverified legacy edit results with a file and success flag', () => {
    const base2 = createBase2('default')
    const gen = base2.handleSteps!({
      agentState: { agentId: 'base2' },
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [
          {
            type: 'json',
            value: {
              file: 'src/direct-edit.ts',
              success: true,
              message: 'String replace applied successfully.',
            },
          },
        ],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const afterGit = gen.next({
      toolResult: [{ type: 'json', value: { status: '' } }],
    } as any)

    expect(afterGit.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect((afterGit.value as any).input.content).toContain(
      'No edited files were detected.',
    )
  })

  test('ignores unverified editor changedFiles summaries without mutation receipts', () => {
    const base2 = createBase2('default')
    const gen = base2.handleSteps!({
      agentState: { agentId: 'base2' },
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [
          {
            type: 'json',
            value: { output: { changedFiles: ['src/from-editor.ts'] } },
          },
        ],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const afterGit = gen.next({
      toolResult: [{ type: 'json', value: { status: '' } }],
    } as any)

    expect(afterGit.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect((afterGit.value as any).input.content).toContain(
      'No edited files were detected.',
    )
  })

  test('direct edit tool calls in message history trigger gates when git status was already dirty', () => {
    const base2 = createBase2('default')
    const initialMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'existing context' }],
    }
    const gen = base2.handleSteps!({
      agentState: { agentId: 'base2', messageHistory: [initialMessage] },
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [
          { type: 'json', value: { status: ' M src/already-dirty.ts' } },
        ],
      } as any).value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    const messageHistory = [
      initialMessage,
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tool-call-1',
            toolName: 'str_replace',
            input: {
              path: 'src/already-dirty.ts',
              replacements: [{ oldString: 'before', newString: 'after' }],
            },
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'tool-call-1',
        toolName: 'str_replace',
        content: [
          {
            type: 'json',
            value: {
              file: 'src/already-dirty.ts',
              message: 'String replace applied successfully.',
            },
          },
        ],
      },
    ]
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [],
        agentState: { messageHistory },
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const afterGit = gen.next({
      toolResult: [
        { type: 'json', value: { status: ' M src/already-dirty.ts' } },
      ],
    } as any)

    expect(afterGit.value).toMatchObject({
      toolName: 'run_file_change_hooks',
      input: { files: ['src/already-dirty.ts'] },
    })
    const afterHooks = gen.next({
      toolResult: [{ type: 'json', value: [] }],
    } as any)
    expect(afterHooks.value).toMatchObject({ toolName: 'git_status' })
    const reviewCall = gen.next({
      toolResult: [
        { type: 'json', value: { status: ' M src/already-dirty.ts' } },
      ],
    } as any).value
    expect(reviewCall).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'code-reviewer' }] },
    })
    const finalPreCreditStatus = gen.next(
      attestedReviewerResult(reviewCall) as any,
    )
    expect(finalPreCreditStatus.value).toMatchObject({ toolName: 'git_status' })
    const gatePassed = gen.next({
      toolResult: [
        { type: 'json', value: { status: ' M src/already-dirty.ts' } },
      ],
    } as any)
    expect(gatePassed.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect(gen.next().value).toMatchObject({
      toolName: 'git_status',
      input: { include_diff: true },
    })
    expect(
      gen.next({
        toolResult: [
          {
            type: 'json',
            value: { status: ' M src/already-dirty.ts', diff: 'diff' },
          },
        ],
      } as any).value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    const maybePinnedState = gen.next().value
    if (maybePinnedState !== 'STEP') {
      expect(maybePinnedState).toMatchObject({
        toolName: 'add_message',
        input: { role: 'user' },
      })
      expect(gen.next().value).toBe('STEP')
    }
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [],
        agentState: { messageHistory },
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const done = gen.next({
      toolResult: [
        { type: 'json', value: { status: ' M src/already-dirty.ts' } },
      ],
    } as any)
    expect(done.done).toBe(true)
  })

  test('apply_patch calls in message history trigger gates when git status was already dirty', () => {
    const base2 = createBase2('default')
    const initialMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'existing context' }],
    }
    const gen = base2.handleSteps!({
      agentState: { agentId: 'base2', messageHistory: [initialMessage] },
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [
          { type: 'json', value: { status: ' M src/already-dirty.ts' } },
        ],
      } as any).value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    const messageHistory = [
      initialMessage,
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tool-call-1',
            toolName: 'apply_patch',
            input: {
              operation: {
                type: 'update_file',
                path: 'src/already-dirty.ts',
                diff: '@@\n-before\n+after\n',
              },
            },
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'tool-call-1',
        toolName: 'apply_patch',
        content: [
          {
            type: 'json',
            value: {
              message: 'Patch applied successfully.',
              applied: [{ file: 'src/already-dirty.ts', action: 'update' }],
            },
          },
        ],
      },
    ]
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [],
        agentState: { messageHistory },
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const afterGit = gen.next({
      toolResult: [
        { type: 'json', value: { status: ' M src/already-dirty.ts' } },
      ],
    } as any)

    expect(afterGit.value).toMatchObject({
      toolName: 'run_file_change_hooks',
      input: { files: ['src/already-dirty.ts'] },
    })
  })

  test('apply_smart_patch calls in message history trigger gates when git status was already dirty', () => {
    const base2 = createBase2('default')
    const initialMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'existing context' }],
    }
    const gen = base2.handleSteps!({
      agentState: { agentId: 'base2', messageHistory: [initialMessage] },
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [
          { type: 'json', value: { status: ' M src/already-dirty.ts' } },
        ],
      } as any).value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    const messageHistory = [
      initialMessage,
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tool-call-1',
            toolName: 'apply_smart_patch',
            input: {
              path: 'src/already-dirty.ts',
              patch: '@@\n-before\n+after\n',
            },
          },
        ],
      },
    ]
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [],
        agentState: { messageHistory },
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const afterGit = gen.next({
      toolResult: [
        { type: 'json', value: { status: ' M src/already-dirty.ts' } },
      ],
    } as any)

    expect(afterGit.value).toMatchObject({
      toolName: 'run_file_change_hooks',
      input: { files: ['src/already-dirty.ts'] },
    })
  })

  test('prior write_todos state in message history is pinned before the next step', () => {
    const base2 = createBase2('default')
    const agentState = {
      agentId: 'base2',
      messageHistory: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'todos-1',
              toolName: 'write_todos',
              input: {
                todos: [
                  { content: 'Gather context', status: 'completed' },
                  {
                    content: 'Implement durable workflow progress',
                    status: 'in_progress',
                  },
                  { content: 'Add focused tests', status: 'pending' },
                ],
              },
            },
          ],
        },
        {
          role: 'tool',
          toolCallId: 'todos-1',
          toolName: 'write_todos',
          content: [{ type: 'json', value: { success: true } }],
        },
      ],
    }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Continue the implementation.',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    const pinned = gen.next()

    expect(pinned.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    const text = (pinned.value as any).input.content as string
    expect(text).toContain(
      'Workflow todo progress (authoritative resumable state):',
    )
    expect(text).toContain('Completed 1/3.')
    expect(text).toContain(
      'Next workflow action: Implement durable workflow progress',
    )
    expect(text).toContain('do not restart earlier completed workflow steps')
    expect(text).toContain(
      'Mark this item complete with write_todos once it is actually completed',
    )
    expect(text).not.toContain(
      'Mark this item complete with write_todos before advancing',
    )
    expect(text).not.toContain(
      'Next required action: Implement durable workflow progress',
    )
    expect(
      (agentState as any).base2ActiveWork.workflowTodoProgress,
    ).toMatchObject({
      completedCount: 1,
      totalCount: 3,
      nextWorkflowAction: 'Implement durable workflow progress',
    })
    expect(gen.next().value).toBe('STEP')
  })

  test('write_todos after a step advances pinned workflow action without restarting completed work', () => {
    const base2 = createBase2('default')
    const initialMessageHistory = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'todos-1',
            toolName: 'write_todos',
            input: {
              todos: [
                { content: 'Gather context', status: 'completed' },
                {
                  content: 'Implement durable workflow progress',
                  status: 'in_progress',
                },
                { content: 'Add focused tests', status: 'pending' },
              ],
            },
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'todos-1',
        toolName: 'write_todos',
        content: [{ type: 'json', value: { success: true } }],
      },
    ]
    const updatedMessageHistory = [
      ...initialMessageHistory,
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'todos-2',
            toolName: 'write_todos',
            input: {
              todos: [
                { content: 'Gather context', status: 'completed' },
                {
                  content: 'Implement durable workflow progress',
                  status: 'completed',
                },
                { content: 'Add focused tests', status: 'in_progress' },
              ],
            },
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'todos-2',
        toolName: 'write_todos',
        content: [{ type: 'json', value: { success: true } }],
      },
    ]
    const agentState = {
      agentId: 'base2',
      messageHistory: initialMessageHistory,
    }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Continue the implementation.',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    const initialPinned = gen.next()
    expect((initialPinned.value as any).input.content).toContain(
      'Next workflow action: Implement durable workflow progress',
    )
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: false,
        toolResult: [],
        agentState: { messageHistory: updatedMessageHistory },
      } as any).value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    const advancedPinned = gen.next()

    expect(advancedPinned.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    const text = (advancedPinned.value as any).input.content as string
    expect(text).toContain('Completed 2/3.')
    expect(text).toContain('Next workflow action: Add focused tests')
    expect(text).toContain('do not restart earlier completed workflow steps')
    expect(text).not.toContain(
      'Next workflow action: Implement durable workflow progress',
    )
    expect(
      (agentState as any).base2ActiveWork.workflowTodoProgress,
    ).toMatchObject({
      completedCount: 2,
      totalCount: 3,
      nextWorkflowAction: 'Add focused tests',
    })
    expect(gen.next().value).toBe('STEP')
  })

  test('direct edit_transaction calls collect all edited paths from message history', () => {
    const base2 = createBase2('default')
    const gen = base2.handleSteps!({
      agentState: { agentId: 'base2', messageHistory: [] },
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [],
        agentState: {
          messageHistory: [
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool-call',
                  toolCallId: 'tool-call-1',
                  toolName: 'edit_transaction',
                  input: {
                    edits: [
                      {
                        type: 'str_replace',
                        path: 'src/one.ts',
                        replacements: [],
                      },
                      {
                        type: 'str_replace',
                        path: 'src/two.ts',
                        replacements: [],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const afterGit = gen.next({
      toolResult: [
        { type: 'json', value: { status: ' M src/one.ts\n M src/two.ts' } },
      ],
    } as any)

    expect(afterGit.value).toMatchObject({
      toolName: 'run_file_change_hooks',
      input: { files: ['src/one.ts', 'src/two.ts'] },
    })
  })

  test('does not treat nested edit-shaped data in non-tool-call messages as direct edits', () => {
    const base2 = createBase2('default')
    const gen = base2.handleSteps!({
      agentState: { agentId: 'base2', messageHistory: [] },
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [],
        agentState: {
          messageHistory: [
            {
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    toolName: 'str_replace',
                    input: { path: 'src/not-edited.ts' },
                  }),
                },
              ],
            },
            {
              role: 'tool',
              toolCallId: 'tool-call-1',
              toolName: 'read_files',
              content: [
                {
                  type: 'json',
                  value: {
                    toolName: 'str_replace',
                    input: { path: 'src/not-edited.ts' },
                  },
                },
              ],
            },
          ],
        },
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const finalGate = gen.next({
      toolResult: [{ type: 'json', value: { status: '' } }],
    } as any)
    expect(finalGate.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect((finalGate.value as any).input.content).toContain(
      'No edited files were detected.',
    )
    expect(gen.next().value).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({ stepsComplete: true, toolResult: [] } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const done = gen.next({
      toolResult: [{ type: 'json', value: { status: '' } }],
    } as any)

    expect(done.done).toBe(true)
  })

  test('fast/no-validation mode skips file-change hooks and reviewer after edits', () => {
    const base2 = createBase2('fast')
    expect(base2.spawnableAgents).toContain('code-reviewer')
    const agentState = { agentId: 'base2-fast' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [{ type: 'json', value: editReceipt('src/a.ts') }],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const skipDiagnostic = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any)

    // Disabled-gate fast path now surfaces a visible skip diagnostic with
    // a parseable gate-state block before terminating the generator.
    expect(skipDiagnostic.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    const skipText = (skipDiagnostic.value as any).input.content as string
    expect(skipText).toContain('validation-and-reviewer-gates-disabled')
    const skipGate = parseGateStateBlock(skipText)
    expect(skipGate).toMatchObject({
      gate: 'validation/reviewer',
      status: 'skipped',
    })
    expect(skipGate!.details).toContain(
      'validation-and-reviewer-gates-disabled',
    )

    const done = gen.next()
    expect(done.done).toBe(true)
    expect((agentState as any).base2ActiveWork).toMatchObject({
      changedFiles: ['src/a.ts'],
      pendingGateFiles: ['src/a.ts'],
      lastReviewerGateSkipReason: 'validation-and-reviewer-gates-disabled',
    })
  })

  test('custom hasNoValidation option skips file-change hooks and reviewer after edits', () => {
    const base2 = createBase2('default', { hasNoValidation: true })
    const agentState = { agentId: 'base2-custom-no-validation' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Make the requested change now please',
      params: {},
      config: base2.programmaticConfig,
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [{ type: 'json', value: editReceipt('src/a.ts') }],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const skipDiagnostic = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any)

    expect(skipDiagnostic.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    const skipText = (skipDiagnostic.value as any).input.content as string
    expect(skipText).toContain('validation-and-reviewer-gates-disabled')
    const skipGate = parseGateStateBlock(skipText)
    expect(skipGate).toMatchObject({
      gate: 'validation/reviewer',
      status: 'skipped',
    })
    expect(skipGate!.details).toContain(
      'validation-and-reviewer-gates-disabled',
    )

    const done = gen.next()
    expect(done.done).toBe(true)
    expect((agentState as any).base2ActiveWork).toMatchObject({
      changedFiles: ['src/a.ts'],
      pendingGateFiles: ['src/a.ts'],
      lastReviewerGateSkipReason: 'validation-and-reviewer-gates-disabled',
    })
  })

  test('awaiting validation with changed files but no pending gate files blocks as unsafe', () => {
    const base2 = createBase2('default')
    const agentState = {
      agentId: 'base2',
      base2ActiveWork: {
        changedFiles: ['src/a.ts'],
        touchedFiles: ['src/a.ts'],
        pendingGateFiles: [],
        currentPhase: 'awaiting_validation',
        latestWorkSummary: '',
        openReviewerBlockers: [],
        lastValidationSummary: '',
        nextRequiredAction: '',
        lastPinnedStateMessage: '',
      },
    }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Finish the previous response.',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    const maybePinned = gen.next().value
    if (maybePinned !== 'STEP') {
      expect(maybePinned).toMatchObject({ toolName: 'add_message' })
      expect((maybePinned as any).input.content).toContain(
        'Current phase: awaiting_validation',
      )
      expect(gen.next().value).toBe('STEP')
    }
    expect(
      gen.next({ stepsComplete: true, toolResult: [] } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const blocked = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any)

    expect(blocked.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    const text = (blocked.value as any).input.content as string
    expect(text).toContain('cannot safely continue')
    expect(text).toContain('edits-detected-without-pending-gate-files')
    expect(text).not.toContain('No edited files were detected.')
    const unsafeGate = parseGateStateBlock(text)
    expect(unsafeGate).toMatchObject({
      gate: 'validation/reviewer',
      status: 'failed',
    })
    expect(unsafeGate!.details).toContain(
      'edits-detected-without-pending-gate-files',
    )
    expect((agentState as any).base2ActiveWork).toMatchObject({
      changedFiles: ['src/a.ts'],
      pendingGateFiles: [],
      currentPhase: 'blocked',
      lastReviewerGateSkipReason: 'edits-detected-without-pending-gate-files',
      nextRequiredAction:
        'Unsafe reviewer gate state: edits were detected without pending gate files. Re-read the edited files/status, make a minimal follow-up edit if needed to restore pending gate files, then finish so validation/review can run safely.',
    })
  })

  test('legacy unresolved reviewer blockers seed pending gate files', () => {
    const base2 = createBase2('default')
    const agentState = {
      agentId: 'base2',
      base2ActiveWork: {
        changedFiles: ['src/legacy.ts'],
        touchedFiles: ['src/legacy.ts'],
        latestWorkSummary:
          'Reviewer feedback is open for pending files: src/legacy.ts',
        openReviewerBlockers: ['BLOCKING: Fix the legacy blocker.'],
        lastValidationSummary: 'No configured file-change hooks ran.',
        nextRequiredAction:
          'Resolve the reviewer feedback below before any unrelated work, final response, or another review.',
        lastPinnedStateMessage: '',
      },
    }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Continue fixing reviewer feedback.',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/legacy.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    const pinned = gen.next()
    expect(pinned.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    const text = (pinned.value as any).input.content as string
    expect(text).toContain('BLOCKING: Fix the legacy blocker.')
    expect(text).toContain(
      'Pending validation/reviewer gate files: src/legacy.ts',
    )
    expect((agentState as any).base2ActiveWork).toMatchObject({
      pendingGateFiles: ['src/legacy.ts'],
      currentPhase: 'blocked',
    })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({ stepsComplete: true, toolResult: [] } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const afterGit = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/legacy.ts' } }],
    } as any)
    expect(afterGit.value).toMatchObject({
      toolName: 'run_file_change_hooks',
      input: { files: ['src/legacy.ts'] },
    })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: [] }] } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/legacy.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'spawn_agents' })
  })

  test('pinned gate-status line reports validation hooks ran=yes when lastValidationSummary is set', () => {
    const base2 = createBase2('default')
    const agentState = {
      agentId: 'base2',
      base2ActiveWork: {
        changedFiles: ['src/a.ts'],
        touchedFiles: ['src/a.ts'],
        pendingGateFiles: ['src/a.ts'],
        currentPhase: 'awaiting_validation',
        latestWorkSummary: '',
        openReviewerBlockers: [],
        lastValidationSummary: 'typecheck passed for src/a.ts',
        nextRequiredAction: '',
        lastPinnedStateMessage: '',
      },
    }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Finish the previous response.',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    const pinned = gen.next()
    expect(pinned.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    const text = (pinned.value as any).input.content as string
    // New durable gate-status line: emitted right after the Current phase line.
    expect(text).toContain('Gate status: phase=awaiting_validation')
    expect(text).toContain('validation hooks ran=yes')
    expect(text).toContain('do not infer progress or predict when it will pass')
  })

  test('pinned gate-status line reports validation hooks ran=no when lastValidationSummary is empty', () => {
    const base2 = createBase2('default')
    const agentState = {
      agentId: 'base2',
      base2ActiveWork: {
        changedFiles: ['src/a.ts'],
        touchedFiles: ['src/a.ts'],
        pendingGateFiles: ['src/a.ts'],
        currentPhase: 'awaiting_validation',
        latestWorkSummary: '',
        openReviewerBlockers: [],
        lastValidationSummary: '',
        nextRequiredAction: '',
        lastPinnedStateMessage: '',
      },
    }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Finish the previous response.',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    const pinned = gen.next()
    expect(pinned.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    const text = (pinned.value as any).input.content as string
    expect(text).toContain('Gate status: phase=awaiting_validation')
    expect(text).toContain('validation hooks ran=no')
    expect(text).toContain('do not infer progress or predict when it will pass')
  })

  test('pinned active-work message renders Gate progress line when gateProgressLine is set', () => {
    const base2 = createBase2('default')
    const agentState = {
      agentId: 'base2',
      base2ActiveWork: {
        changedFiles: ['src/a.ts'],
        touchedFiles: ['src/a.ts'],
        pendingGateFiles: ['src/a.ts'],
        currentPhase: 'awaiting_validation',
        latestWorkSummary: '',
        openReviewerBlockers: [],
        lastValidationSummary: 'typecheck passed for src/a.ts',
        nextRequiredAction: '',
        lastPinnedStateMessage: '',
        gateProgressLine: 'gate: validation passed; reviewer code-reviewer running',
      },
    }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Finish the previous response.',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    const pinned = gen.next()
    expect(pinned.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    const text = (pinned.value as any).input.content as string
    expect(text).toContain(
      'Gate progress: gate: validation passed; reviewer code-reviewer running',
    )
  })

  test('pinned active-work message omits Gate progress line when gateProgressLine is empty', () => {
    const base2 = createBase2('default')
    const agentState = {
      agentId: 'base2',
      base2ActiveWork: {
        changedFiles: ['src/a.ts'],
        touchedFiles: ['src/a.ts'],
        pendingGateFiles: ['src/a.ts'],
        currentPhase: 'awaiting_validation',
        latestWorkSummary: '',
        openReviewerBlockers: [],
        lastValidationSummary: 'typecheck passed for src/a.ts',
        nextRequiredAction: '',
        lastPinnedStateMessage: '',
        gateProgressLine: '',
      },
    }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Finish the previous response.',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    const pinned = gen.next()
    expect(pinned.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    const text = (pinned.value as any).input.content as string
    // Sanity: unresolved gate work is present so the pinned message is emitted.
    expect(text).toContain('Gate status: phase=awaiting_validation')
    expect(text).not.toContain('Gate progress:')
  })

  test('gate-state type round-trips gateProgressLine through JSON and is optional on older state', () => {
    const state: Base2ActiveWorkState = {
      pendingGateFiles: ['src/a.ts'],
      gatePassedFiles: [],
      gatePassedPendingFiles: [],
      gatePassedReviewerVerdict: '',
      gatePassedValidationSummary: '',
      gatePassedFingerprint: '',
      lastReviewerGateSkipReason: '',
      touchedFiles: ['src/a.ts'],
      changedFiles: ['src/a.ts'],
      currentPhase: 'awaiting_validation',
      latestWorkSummary: '',
      openReviewerBlockers: [],
      lastValidationSummary: '',
      nextRequiredAction: '',
      lastPinnedStateMessage: '',
      gateProgressLine: 'gate: reviewer verdict LOOKS_GOOD; finalizing',
    }
    const roundTripped = JSON.parse(
      JSON.stringify(state),
    ) as Base2ActiveWorkState
    expect(roundTripped.gateProgressLine).toBe(
      'gate: reviewer verdict LOOKS_GOOD; finalizing',
    )

    // Older serialized state lacks the field entirely; it stays optional/absent.
    const olderState: Base2ActiveWorkState = {
      pendingGateFiles: ['src/a.ts'],
      gatePassedFiles: [],
      gatePassedPendingFiles: [],
      gatePassedReviewerVerdict: '',
      gatePassedValidationSummary: '',
      gatePassedFingerprint: '',
      lastReviewerGateSkipReason: '',
      touchedFiles: ['src/a.ts'],
      changedFiles: ['src/a.ts'],
      currentPhase: 'awaiting_validation',
      latestWorkSummary: '',
      openReviewerBlockers: [],
      lastValidationSummary: '',
      nextRequiredAction: '',
      lastPinnedStateMessage: '',
    }
    const olderRoundTripped = JSON.parse(
      JSON.stringify(olderState),
    ) as Base2ActiveWorkState
    expect(olderRoundTripped.gateProgressLine).toBeUndefined()
  })

  test('reviewer feedback is pinned as active work before the next step', () => {
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [{ type: 'json', value: editReceipt('src/a.ts') }],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'run_file_change_hooks' })
    const postValidationStatus = gen.next({
      toolResult: [{ type: 'json', value: [] }],
    } as any).value
    expect(postValidationStatus).toMatchObject({ toolName: 'git_status' })
    const reviewCall = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any).value
    expect(reviewCall).toMatchObject({ toolName: 'spawn_agents' })
    expect(
      gen.next(
        attestedReviewerResult(reviewCall, 'BLOCKING', [
          'Fix the edge case.',
        ]) as any,
      ).value,
    ).toMatchObject({ toolName: 'add_message' })

    expect((agentState as any).base2ActiveWork).toMatchObject({
      changedFiles: ['src/a.ts'],
      touchedFiles: ['src/a.ts'],
      pendingGateFiles: ['src/a.ts'],
      openReviewerBlockers: ['BLOCKING: Fix the edge case.'],
      lastValidationSummary: 'No configured file-change hooks ran.',
      nextRequiredAction:
        'Resolve the reviewer feedback below before any unrelated work, final response, or another review.',
    })

    expect(gen.next().value).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'repair-editor' }] },
    })
    const findingIds = (
      agentState as any
    ).base2ActiveWork.openReviewerFindings.map((finding: any) => finding.id)
    expect(
      gen.next(completedRepairReceipt(findingIds, ['src/a.ts']) as any).value,
    ).toMatchObject({
      toolName: 'git_status',
    })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'run_file_change_hooks' })
    expect(
      gen.next({
        toolResult: [
          { type: 'json', value: [{ hookName: 'typecheck', exitCode: 0, stdout: 'ok' }] },
        ],
      } as any).value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    const pinned = gen.next()
    expect(pinned.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    const text = (pinned.value as any).input.content as string
    expect(text).toContain(
      'Harness pinned active-work state (controlling state',
    )
    expect(text).toContain('Current phase: awaiting_review')
    expect(text).toContain('BLOCKING: Fix the edge case.')
    expect(text).toContain('Pending validation/reviewer gate files: src/a.ts')
    // The inline-validation flow emits a real summary of the hooks that just
    // ran (here a passing typecheck), not the legacy 'No configured hooks'
    // placeholder. Assert the stable marker rather than the exact hook text.
    expect(text).toContain('Last validation summary:')
    expect(text).not.toContain('Historical changed files: src/a.ts')
    expect(text).not.toContain('Historical touched files: src/a.ts')
    expect(gen.next().value).toBe('STEP')
  })

  // All-coverage blocker sets must not co-spawn repair-editor.
  test('all-coverage reviewer findings route exclusively to test-writer', () => {
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [{ type: 'json', value: editReceipt('src/a.ts') }],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'run_file_change_hooks' })
    const postValidationStatus = gen.next({
      toolResult: [{ type: 'json', value: [] }],
    } as any).value
    expect(postValidationStatus).toMatchObject({ toolName: 'git_status' })
    const reviewCall = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any).value
    expect(reviewCall).toMatchObject({ toolName: 'spawn_agents' })
    // coverage: 'missing' with empty findings produces only the synthetic
    // all-coverage blocker classified by isTestCoverageReviewerFinding.
    const afterReview = gen.next(
      attestedReviewerResult(reviewCall, 'NON_BLOCKING', [], 'missing') as any,
    )
    expect(afterReview.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect((afterReview.value as any).input.content).toContain('test-writer')
    expect((afterReview.value as any).input.content).not.toContain(
      'to repair-editor',
    )

    const repairSpawn = gen.next().value as any
    expect(repairSpawn).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'test-writer' }] },
    })
    expect(repairSpawn.input.agents).toHaveLength(1)
    expect(repairSpawn.input.agents[0].agent_type).not.toBe('repair-editor')
    expect((agentState as any).base2ActiveWork.nextRequiredAction).toContain(
      'Test-writer must add coverage',
    )
  })

  test('mixed coverage and code findings keep repair-editor only', () => {
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [{ type: 'json', value: editReceipt('src/a.ts') }],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'run_file_change_hooks' })
    const postValidationStatus = gen.next({
      toolResult: [{ type: 'json', value: [] }],
    } as any).value
    expect(postValidationStatus).toMatchObject({ toolName: 'git_status' })
    const reviewCall = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any).value
    expect(reviewCall).toMatchObject({ toolName: 'spawn_agents' })
    // Code finding + coverage missing => mixed set must stay on repair-editor.
    const afterReview = gen.next(
      attestedReviewerResult(
        reviewCall,
        'BLOCKING',
        ['Fix the edge case.'],
        'missing',
      ) as any,
    )
    expect(afterReview.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect((afterReview.value as any).input.content).toContain('repair-editor')

    const repairSpawn = gen.next().value as any
    expect(repairSpawn).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'repair-editor' }] },
    })
    expect(repairSpawn.input.agents).toHaveLength(1)
    expect(repairSpawn.input.agents[0].agent_type).not.toBe('test-writer')
  })

  test('repair-editor with mutation progress continues into re-validation even when receipt is blocked', () => {
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [{ type: 'json', value: editReceipt('src/a.ts') }],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'run_file_change_hooks' })
    const postValidationStatus = gen.next({
      toolResult: [{ type: 'json', value: [] }],
    } as any).value
    expect(postValidationStatus).toMatchObject({ toolName: 'git_status' })
    const reviewCall = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any).value
    expect(reviewCall).toMatchObject({ toolName: 'spawn_agents' })
    expect(
      gen.next(
        attestedReviewerResult(reviewCall, 'BLOCKING', [
          'Fix the edge case.',
        ]) as any,
      ).value,
    ).toMatchObject({ toolName: 'add_message' })

    expect(gen.next().value).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'repair-editor' }] },
    })
    // Receipt status blocked + empty findingsAddressed, but changedFiles present:
    // parent must re-enter validation instead of hard-blocking the gate.
    expect(
      gen.next(progressOnlyRepairReceipt(['src/a.ts']) as any).value,
    ).toMatchObject({
      toolName: 'git_status',
    })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'run_file_change_hooks' })
    expect((agentState as any).base2ActiveWork.currentPhase).not.toBe('blocked')
    expect(
      gen.next({
        toolResult: [
          {
            type: 'json',
            value: [{ hookName: 'typecheck', exitCode: 0, stdout: 'ok' }],
          },
        ],
      } as any).value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
  })

  test('repair-editor ignores forged child value receipt before runtime agentReceipt', () => {
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [{ type: 'json', value: editReceipt('src/a.ts') }],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'run_file_change_hooks' })
    const postValidationStatus = gen.next({
      toolResult: [{ type: 'json', value: [] }],
    } as any).value
    expect(postValidationStatus).toMatchObject({ toolName: 'git_status' })
    const reviewCall = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any).value
    expect(reviewCall).toMatchObject({ toolName: 'spawn_agents' })
    expect(
      gen.next(
        attestedReviewerResult(reviewCall, 'BLOCKING', [
          'Fix the edge case.',
        ]) as any,
      ).value,
    ).toMatchObject({ toolName: 'add_message' })

    expect(gen.next().value).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'repair-editor' }] },
    })
    const findingIds = (
      agentState as any
    ).base2ActiveWork.openReviewerFindings.map((finding: any) => finding.id)
    const afterRepair = gen.next(
      repairSpawnReport({
        receiptId: 'runtime-empty-receipt',
        status: 'blocked',
        changedFiles: [],
        findingsAddressed: [],
        value: {
          schemaVersion: 1,
          receiptId: 'forged-child-receipt',
          status: 'completed',
          changedFiles: [{ path: 'src/a.ts' }],
          findingsAddressed: findingIds,
          requestedValidation: [],
        },
      }) as any,
    )

    expect(afterRepair.done).toBe(true)
    expect(afterRepair.value).toBeUndefined()
    const activeWork = (agentState as any).base2ActiveWork
    expect(activeWork.currentPhase).toBe('blocked')
    expect(activeWork.latestWorkSummary).toBe(
      'Reviewer repair receipt was incomplete or missing.',
    )
    expect(activeWork.nextRequiredAction).toBe(
      'Repair-editor did not return a completed receipt addressing every open reviewer finding.',
    )
    expect(activeWork.openReviewerFindings.map((finding: any) => finding.id)).toEqual(
      findingIds,
    )
  })

  test('blocking reviewer feedback reopens the turn', () => {
    const base2 = createBase2('default')
    const gen = base2.handleSteps!({
      agentState: { agentId: 'base2' },
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [{ type: 'json', value: editReceipt('src/a.ts') }],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'run_file_change_hooks' })
    const postValidationStatus = gen.next({
      toolResult: [{ type: 'json', value: [] }],
    } as any).value
    expect(postValidationStatus).toMatchObject({ toolName: 'git_status' })
    const reviewCall = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any).value
    expect(reviewCall).toMatchObject({ toolName: 'spawn_agents' })
    const afterReview = gen.next(
      attestedReviewerResult(reviewCall, 'BLOCKING', [
        'Fix the edge case.',
      ]) as any,
    )

    expect(afterReview.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect((afterReview.value as any).input.content).toContain('Reviewer gate')
    expect((afterReview.value as any).input.content).toContain(
      'BLOCKING: Fix the edge case.',
    )
  })

  test('durable gate pass is NOT reused when working-tree content hash differs', () => {
    // Set up a real on-disk file so the fingerprint can encode a stable
    // content hash. The recorded fingerprint pretends the file previously
    // hashed to a different content marker; the harness must rebuild the
    // fingerprint from the current file bytes and detect the mismatch.
    const tmpDir = makeProjectTempDir('base2-gate-mismatch-')
    const tmpFile = join(tmpDir, 'a.ts')
    try {
      writeFileSync(tmpFile, 'export const x = 1\n')
      const statusLine = ` M ${tmpFile}`
      const stalePreviousFingerprint = buildFingerprint(
        [
          {
            file: tmpFile,
            statusLine,
            // Pretend the file used to hash differently. Real current content
            // hash will be computed by the harness against the live bytes.
            contentMarker:
              'sha256:0000000000000000000000000000000000000000000000000000000000000000:1',
          },
        ],
        'No configured file-change hooks ran.',
      )

      const base2 = createBase2('default')
      const agentState = buildDurablePassAgentState(
        tmpFile,
        stalePreviousFingerprint,
      )
      const gen = base2.handleSteps!({
        agentState,
        prompt: 'Finish the previous response.',
        params: {},
      } as any)

      expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
      expect(
        gen.next({
          toolResult: [{ type: 'json', value: { status: statusLine } }],
        } as any).value,
      ).toMatchObject({ toolName: 'spawn_agent_inline' })
      const maybePinnedState = gen.next().value
      if (maybePinnedState !== 'STEP') {
        expect(maybePinnedState).toMatchObject({ toolName: 'add_message' })
        expect(gen.next().value).toBe('STEP')
      }
      expect(
        gen.next({ stepsComplete: true, toolResult: [] } as any).value,
      ).toMatchObject({ toolName: 'git_status' })
      const next = gen.next({
        toolResult: [{ type: 'json', value: { status: statusLine } }],
      } as any)

      // Content hash differs from the stored marker -> no durable reuse.
      expect(next.value).toMatchObject({
        toolName: 'run_file_change_hooks',
        input: { files: [normalizeGateFilePath(tmpFile)] },
      })
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('durable gate pass IS reused when working-tree content hash matches', () => {
    const tmpDir = makeProjectTempDir('base2-gate-reuse-')
    const tmpFile = join(tmpDir, 'a.ts')
    try {
      writeFileSync(tmpFile, 'export const x = 1\n')
      const statusLine = ` M ${tmpFile}`
      const fingerprint = buildFingerprint(
        [
          {
            file: tmpFile,
            statusLine,
            contentMarker: buildContentMarker(tmpFile),
          },
        ],
        'No configured file-change hooks ran.',
      )

      const base2 = createBase2('default')
      const agentState = buildDurablePassAgentState(tmpFile, fingerprint)
      agentState.base2ActiveWork.gatePassedFileMarkers = {
        [normalizeGateFilePath(tmpFile)]: buildContentMarker(tmpFile),
      }
      const gen = base2.handleSteps!({
        agentState,
        prompt: 'Finish the previous response.',
        params: {},
      } as any)

      expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
      expect(
        gen.next({
          toolResult: [{ type: 'json', value: { status: statusLine } }],
        } as any).value,
      ).toMatchObject({ toolName: 'spawn_agent_inline' })
      const maybePinnedState = gen.next().value
      if (maybePinnedState !== 'STEP') {
        expect(maybePinnedState).toMatchObject({ toolName: 'add_message' })
        expect(gen.next().value).toBe('STEP')
      }
      expect(
        gen.next({ stepsComplete: true, toolResult: [] } as any).value,
      ).toMatchObject({ toolName: 'git_status' })
      const gatePassed = gen.next({
        toolResult: [{ type: 'json', value: { status: statusLine } }],
      } as any)

      // Same fingerprint (including content hash) -> durable reuse fires.
      expect(gatePassed.value).toMatchObject({ toolName: 'add_message' })
      const reuseText = (gatePassed.value as any).input.content as string
      expect(reuseText).toContain(
        'Previous validation and reviewer gate already passed with LOOKS_GOOD',
      )
      const reuseGate = parseGateStateBlock(reuseText)
      expect(reuseGate).toMatchObject({
        gate: 'validation/reviewer',
        status: 'passed',
      })
      expect(reuseGate!.details).toContain('durable')
      expect(reuseGate!.details).toContain('LOOKS_GOOD')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('durable gate pass is invalidated when same-path file content changes between turns', () => {
    const tmpDir = makeProjectTempDir('base2-gate-content-change-')
    const tmpFile = join(tmpDir, 'a.ts')
    try {
      writeFileSync(tmpFile, 'export const x = 1\n')
      const statusLine = ` M ${tmpFile}`
      const originalFingerprint = buildFingerprint(
        [
          {
            file: tmpFile,
            statusLine,
            contentMarker: buildContentMarker(tmpFile),
          },
        ],
        'No configured file-change hooks ran.',
      )
      // Same path, but content changed after the gate passed. The git status
      // line stays the same so a status-line-only fingerprint would still
      // match — only the content hash detects this drift.
      writeFileSync(tmpFile, 'export const x = 2\n')

      const base2 = createBase2('default')
      const agentState = buildDurablePassAgentState(
        tmpFile,
        originalFingerprint,
      )
      const gen = base2.handleSteps!({
        agentState,
        prompt: 'Finish the previous response.',
        params: {},
      } as any)

      expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
      expect(
        gen.next({
          toolResult: [{ type: 'json', value: { status: statusLine } }],
        } as any).value,
      ).toMatchObject({ toolName: 'spawn_agent_inline' })
      const maybePinnedState = gen.next().value
      if (maybePinnedState !== 'STEP') {
        expect(maybePinnedState).toMatchObject({ toolName: 'add_message' })
        expect(gen.next().value).toBe('STEP')
      }
      expect(
        gen.next({ stepsComplete: true, toolResult: [] } as any).value,
      ).toMatchObject({ toolName: 'git_status' })
      const next = gen.next({
        toolResult: [{ type: 'json', value: { status: statusLine } }],
      } as any)

      // Content changed -> fingerprint differs -> validation reruns.
      expect(next.value).toMatchObject({
        toolName: 'run_file_change_hooks',
        input: { files: [normalizeGateFilePath(tmpFile)] },
      })
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('durable gate pass is NOT reused when previously-hashed file is now missing', () => {
    const tmpDir = makeProjectTempDir('base2-gate-missing-')
    const tmpFile = join(tmpDir, 'a.ts')
    try {
      writeFileSync(tmpFile, 'export const x = 1\n')
      const statusLine = ` M ${tmpFile}`
      const originalFingerprint = buildFingerprint(
        [
          {
            file: tmpFile,
            statusLine,
            contentMarker: buildContentMarker(tmpFile),
          },
        ],
        'No configured file-change hooks ran.',
      )
      // Delete the file before the next turn. The harness must treat the
      // resulting `missing` marker as a mismatch and rerun the gate rather
      // than silently reusing the prior pass.
      rmSync(tmpFile, { force: true })

      const base2 = createBase2('default')
      const agentState = buildDurablePassAgentState(
        tmpFile,
        originalFingerprint,
      )
      const gen = base2.handleSteps!({
        agentState,
        prompt: 'Finish the previous response.',
        params: {},
      } as any)

      expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
      expect(
        gen.next({
          toolResult: [{ type: 'json', value: { status: statusLine } }],
        } as any).value,
      ).toMatchObject({ toolName: 'spawn_agent_inline' })
      const maybePinnedState = gen.next().value
      if (maybePinnedState !== 'STEP') {
        expect(maybePinnedState).toMatchObject({ toolName: 'add_message' })
        expect(gen.next().value).toBe('STEP')
      }
      expect(
        gen.next({ stepsComplete: true, toolResult: [] } as any).value,
      ).toMatchObject({ toolName: 'git_status' })
      const next = gen.next({
        toolResult: [{ type: 'json', value: { status: statusLine } }],
      } as any)

      // Missing-now file -> fingerprint mismatches recorded content hash.
      expect(next.value).toMatchObject({
        toolName: 'run_file_change_hooks',
        input: { files: [normalizeGateFilePath(tmpFile)] },
      })
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('snapshot-bound blocking security-review output remains blocked and invokes repair', () => {
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Update sdk/src/policy/terminal-command-policy.ts.',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [
          {
            type: 'json',
            value: editReceipt('sdk/src/policy/terminal-command-policy.ts'),
          },
        ],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const securityReview = gen.next({
      toolResult: [
        {
          type: 'json',
          value: { status: ' M sdk/src/policy/terminal-command-policy.ts' },
        },
      ],
    } as any)
    expect(securityReview.value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'security-reviewer' },
    })
    const prompt = (securityReview.value as any).input.prompt as string
    const snapshotFingerprint = prompt.split('Snapshot fingerprint: ')[1].split('\n')[0]
    const blockerMessage = gen.next({
      toolResult: [
        {
          type: 'json',
          value: {
            schemaVersion: 1,
            verdict: 'BLOCKING',
            snapshotFingerprint,
            reviewedFiles: ['sdk/src/policy/terminal-command-policy.ts'],
            findings: [
              {
                id: 'security-reviewer:containment:fixture-path',
                summary: 'Reject nested fixture paths.',
              },
            ],
            coverage: 'covered',
            dimensions: { security: 'block' },
            requirementCoverage: [],
          },
        },
      ],
    } as any)

    expect(blockerMessage.value).toMatchObject({ toolName: 'add_message' })
    expect((agentState as any).base2ActiveWork).toMatchObject({
      currentPhase: 'repair_loop',
      openReviewerBlockers: [
        'BLOCKING: [security-reviewer:containment:fixture-path] Reject nested fixture paths.',
        'BLOCKING: security review dimension failed',
      ],
      securityReviewGateDone: false,
      preEditSecurityReviewDone: false,
      requiredReviewerRevalidation: 'security-reviewer',
    })
    expect((agentState as any).base2ActiveWork.openReviewerFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'security-reviewer:containment:fixture-path',
          status: 'open',
          snapshotFingerprint,
        }),
      ]),
    )
    expect(gen.next().value).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'repair-editor' }] },
    })
  })

  test('security repair revalidates with security-reviewer before finalization', () => {
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Update sdk/src/policy/terminal-command-policy.ts.',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [
          {
            type: 'json',
            value: editReceipt('sdk/src/policy/terminal-command-policy.ts'),
          },
        ],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const securityReview = gen.next({
      toolResult: [
        {
          type: 'json',
          value: { status: ' M sdk/src/policy/terminal-command-policy.ts' },
        },
      ],
    } as any)
    expect(securityReview.value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'security-reviewer' },
    })
    const securityPrompt = (securityReview.value as any).input.prompt as string
    const snapshotFingerprint = securityPrompt
      .split('Snapshot fingerprint: ')[1]
      .split('\n')[0]
    const blockerMessage = gen.next({
      toolResult: [
        {
          type: 'json',
          value: {
            schemaVersion: 1,
            verdict: 'BLOCKING',
            snapshotFingerprint,
            reviewedFiles: ['sdk/src/policy/terminal-command-policy.ts'],
            findings: [
              {
                id: 'security-reviewer:containment:fixture-path',
                summary: 'Reject nested fixture paths.',
              },
            ],
            coverage: 'covered',
            dimensions: { security: 'block' },
            requirementCoverage: [],
          },
        },
      ],
    } as any)
    expect(blockerMessage.value).toMatchObject({ toolName: 'add_message' })
    expect(gen.next().value).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'repair-editor' }] },
    })

    const findingIds = (
      agentState as any
    ).base2ActiveWork.openReviewerFindings.map((finding: any) => finding.id)
    expect(
      gen.next(
        completedRepairReceipt(findingIds, [
          'sdk/src/policy/terminal-command-policy.ts',
        ]) as any,
      ).value,
    ).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    const maybePinnedState = gen.next().value
    if (maybePinnedState !== 'STEP') {
      expect(maybePinnedState).toMatchObject({ toolName: 'add_message' })
      expect(gen.next().value).toBe('STEP')
    }
    expect(
      gen.next({ stepsComplete: true, toolResult: [] } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    // Aux-ownership routing: the security repair set
    // requiredReviewerRevalidation='security-reviewer' (family 'security') and
    // reset securityReviewGateDone, so on loop re-entry the SECURITY AUX BLOCK
    // re-fires (spawning security-reviewer inline with params) rather than the
    // final code-reviewer.
    const revalidationReview = gen.next({
      toolResult: [
        {
          type: 'json',
          value: { status: ' M sdk/src/policy/terminal-command-policy.ts' },
        },
      ],
    } as any)
    expect(revalidationReview.value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'security-reviewer' },
    })
    const revalidationPrompt = (revalidationReview.value as any).input
      .prompt as string
    const revalidationFingerprint = revalidationPrompt
      .split('Snapshot fingerprint: ')[1]
      .split('\n')[0]
    // A passing snapshot-bound security review clears the security-family
    // marker (requiredReviewerRevalidation -> undefined) and marks the gate
    // done, so the loop can proceed to validation and the final code-reviewer.
    const afterSecurityPass = gen.next({
      toolResult: [
        {
          type: 'json',
          value: {
            schemaVersion: 1,
            verdict: 'LOOKS_GOOD',
            snapshotFingerprint: revalidationFingerprint,
            reviewedFiles: ['sdk/src/policy/terminal-command-policy.ts'],
            findings: [],
            coverage: 'covered',
            dimensions: {
              inputBoundaries: 'pass',
              authorization: 'pass',
              secretHandling: 'pass',
              resourceSafety: 'pass',
              failureMode: 'pass',
            },
            requirementCoverage: [],
          },
        },
      ],
    } as any)
    expect(afterSecurityPass.value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    const maybePinnedStateAfterSecurity = gen.next().value
    if (maybePinnedStateAfterSecurity !== 'STEP') {
      expect(maybePinnedStateAfterSecurity).toMatchObject({
        toolName: 'add_message',
      })
      expect(gen.next().value).toBe('STEP')
    }
    expect(
      gen.next({ stepsComplete: true, toolResult: [] } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [
          {
            type: 'json',
            value: { status: ' M sdk/src/policy/terminal-command-policy.ts' },
          },
        ],
      } as any).value,
    ).toMatchObject({ toolName: 'run_file_change_hooks' })
    const postValidationStatus = gen.next({
      toolResult: [
        {
          type: 'json',
          value: [{ hookName: 'typecheck', exitCode: 0, stdout: 'ok' }],
        },
      ],
    } as any)
    expect(postValidationStatus.value).toMatchObject({ toolName: 'git_status' })
    const finalReview = gen.next({
      toolResult: [
        {
          type: 'json',
          value: { status: ' M sdk/src/policy/terminal-command-policy.ts' },
        },
      ],
    } as any)

    // The FINAL reviewer block only spawns code-reviewer now (security review
    // was owned by the aux block above).
    expect(finalReview.value).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'code-reviewer' }] },
    })
    const finalPreCreditStatus = gen.next(
      attestedReviewerResult(finalReview.value) as any,
    )
    expect(finalPreCreditStatus.value).toMatchObject({ toolName: 'git_status' })
    const gatePassed = gen.next({
      toolResult: [
        {
          type: 'json',
          value: { status: ' M sdk/src/policy/terminal-command-policy.ts' },
        },
      ],
    } as any)
    expect(gatePassed.value).toMatchObject({ toolName: 'add_message' })
    expect((gatePassed.value as any).input.content).toMatch(
      /reviewer gate passed with LOOKS_GOOD/i,
    )
    // Aux-ownership terminal state: the security-family marker was cleared by
    // the aux block, NOT left as 'security-reviewer'.
    expect((agentState as any).base2ActiveWork).toMatchObject({
      currentPhase: 'final_response_allowed',
      requiredReviewerRevalidation: undefined,
    })
  })

  test('malformed snapshot-bound security-review output blocks without inventing repair findings', () => {
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Update sdk/src/policy/terminal-command-policy.ts.',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [
          {
            type: 'json',
            value: editReceipt('sdk/src/policy/terminal-command-policy.ts'),
          },
        ],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const securityReview = gen.next({
      toolResult: [
        {
          type: 'json',
          value: { status: ' M sdk/src/policy/terminal-command-policy.ts' },
        },
      ],
    } as any)
    expect(securityReview.value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'security-reviewer' },
    })

    const blocked = gen.next({ toolResult: [{ type: 'json', value: {} }] } as any)
    expect(blocked.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect((blocked.value as any).input.content).toContain(
      'fresh matching snapshot-bound security review',
    )
    expect((agentState as any).base2ActiveWork).toMatchObject({
      currentPhase: 'blocked',
      pendingGateFiles: ['sdk/src/policy/terminal-command-policy.ts'],
      securityReviewGateDone: false,
      preEditSecurityReviewDone: false,
      nextRequiredAction:
        'Obtain a fresh matching snapshot-bound security review before validation or finalization can continue.',
    })
    expect((agentState as any).base2ActiveWork.openReviewerFindings).toEqual([])
    expect(gen.next().done).toBe(true)
  })

  test('structured BLOCKING reviewer JSON output reopens the turn', () => {
    const base2 = createBase2('default')
    const gen = base2.handleSteps!({
      agentState: { agentId: 'base2' },
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [{ type: 'json', value: editReceipt('src/a.ts') }],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'run_file_change_hooks' })
    const postValidationStatus = gen.next({
      toolResult: [{ type: 'json', value: [] }],
    } as any).value
    expect(postValidationStatus).toMatchObject({ toolName: 'git_status' })
    const reviewCall = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any).value
    expect(reviewCall).toMatchObject({ toolName: 'spawn_agents' })
    const afterReview = gen.next(
      attestedReviewerResult(reviewCall, 'BLOCKING', [
        'Fix the structured edge case.',
      ]) as any,
    )

    expect(afterReview.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    const text = (afterReview.value as any).input.content as string
    expect(text).toContain('Reviewer gate')
    expect(text).toContain('BLOCKING: Fix the structured edge case.')
  })
  test('structured LOOKS_GOOD reviewer JSON output finalizes', () => {
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2-custom' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [{ type: 'json', value: editReceipt('src/a.ts') }],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'run_file_change_hooks' })
    const postValidationStatus = gen.next({
      toolResult: [{ type: 'json', value: [] }],
    } as any).value
    expect(postValidationStatus).toMatchObject({ toolName: 'git_status' })
    const reviewCall = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any).value
    expect(reviewCall).toMatchObject({ toolName: 'spawn_agents' })
    const finalPreCreditStatus = gen.next(
      attestedReviewerResult(reviewCall) as any,
    )
    expect(finalPreCreditStatus.value).toMatchObject({ toolName: 'git_status' })
    const gatePassed = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any)

    expect(gatePassed.value).toMatchObject({ toolName: 'add_message' })
    expect((gatePassed.value as any).input.content.toLowerCase()).toContain(
      'reviewer gate passed with looks_good',
    )
    expect((agentState as any).base2ActiveWork).toMatchObject({
      currentPhase: 'final_response_allowed',
      gatePassedReviewerVerdict: 'LOOKS_GOOD',
    })
  })

  test('rejects non-1 attestation schema versions before finalization', () => {
    for (const schemaVersion of [0, 2, 1.5]) {
      const base2 = createBase2('default')
      const agentState = { agentId: 'base2-custom' }
      const gen = base2.handleSteps!({
        agentState,
        prompt: 'Make the requested change now please',
        params: {},
      } as any)

      expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
      expect(
        gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
          .value,
      ).toMatchObject({ toolName: 'spawn_agent_inline' })
      expect(gen.next().value).toBe('STEP')
      expect(
        gen.next({
          stepsComplete: true,
          toolResult: [{ type: 'json', value: editReceipt('src/a.ts') }],
        } as any).value,
      ).toMatchObject({ toolName: 'git_status' })
      expect(
        gen.next({
          toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
        } as any).value,
      ).toMatchObject({ toolName: 'run_file_change_hooks' })
      const postValidationStatus = gen.next({
        toolResult: [{ type: 'json', value: [] }],
      } as any).value as any
      expect(postValidationStatus).toMatchObject({ toolName: 'git_status' })
      const reviewCall = gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value as any
      const invalid = attestedReviewerResult(reviewCall) as any
      invalid.toolResult[0].value[0].schemaVersion = schemaVersion

      expect(gen.next(invalid).value).toMatchObject({
        toolName: 'spawn_agents',
        input: { agents: [{ agent_type: 'code-reviewer' }] },
      })
      expect((agentState as any).base2ActiveWork).toMatchObject({
        currentPhase: 'awaiting_review',
        pendingGateFiles: ['src/a.ts'],
        reviewerProtocolRetryCount: 1,
      })
      expect((agentState as any).base2ActiveWork.currentPhase).not.toBe(
        'final_response_allowed',
      )
    }
  })

  test('reviewer attestation errors retry the reviewer once without spawning repair-editor', () => {
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2-custom' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [{ type: 'json', value: editReceipt('src/a.ts') }],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'run_file_change_hooks' })
    const postValidationStatus = gen.next({
      toolResult: [{ type: 'json', value: [] }],
    } as any).value as any
    expect(postValidationStatus).toMatchObject({ toolName: 'git_status' })
    const reviewCall = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any).value as any
    expect(reviewCall).toMatchObject({ toolName: 'spawn_agents' })
    const reviewPrompt = reviewCall.input.agents[0].prompt as string
    const snapshotFingerprint = reviewPrompt
      .split('Snapshot fingerprint (echo exactly): ')[1]
      .split('\n')[0]

    const retryCall = gen.next({
      toolResult: [
        {
          type: 'json',
          value: [
            {
              schemaVersion: 1,
              verdict: 'LOOKS_GOOD',
              snapshotFingerprint: 'v2',
              reviewedFiles: ['src/tests/a.ts'],
              findings: [],
              coverage: 'covered',
              dimensions: {},
              requirementCoverage: [],
            },
          ],
        },
      ],
    } as any).value as any
    expect(retryCall).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'code-reviewer' }] },
    })
    expect(retryCall.input.agents[0].prompt).toContain(
      'failed the reviewer protocol contract',
    )
    expect(retryCall.input.agents[0].prompt).toContain(
      'do not ask repair-editor to change source code',
    )

    const finalPreCreditStatus = gen.next({
      toolResult: [
        {
          type: 'json',
          value: [
            {
              schemaVersion: 1,
              verdict: 'LOOKS_GOOD',
              snapshotFingerprint,
              reviewedFiles: ['./src/a.ts'],
              findings: [],
              coverage: 'covered',
              dimensions: {},
              requirementCoverage: [],
            },
          ],
        },
      ],
    } as any)
    expect(finalPreCreditStatus.value).toMatchObject({ toolName: 'git_status' })
    const gatePassed = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any)
    expect(gatePassed.value).toMatchObject({ toolName: 'add_message' })
    expect((gatePassed.value as any).input.content).toContain(
      'Reviewer gate passed with LOOKS_GOOD',
    )
    expect((agentState as any).base2ActiveWork).toMatchObject({
      currentPhase: 'final_response_allowed',
      reviewerProtocolRetryCount: 0,
    })
  })

  test('repeated reviewer attestation errors stop after the bounded retry', () => {
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2-custom' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [{ type: 'json', value: editReceipt('src/a.ts') }],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'run_file_change_hooks' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: [] }] } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'spawn_agents' })

    const invalidAttestation = {
      toolResult: [
        {
          type: 'json',
          value: [
            {
              schemaVersion: 1,
              verdict: 'LOOKS_GOOD',
              snapshotFingerprint: 'wrong',
              reviewedFiles: [],
              findings: [],
              coverage: 'covered',
              dimensions: {},
              requirementCoverage: [],
            },
          ],
        },
      ],
    }
    expect(gen.next(invalidAttestation as any).value).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'code-reviewer' }] },
    })
    const stopped = gen.next(invalidAttestation as any)
    expect(stopped.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect((stopped.value as any).input.content).toContain(
      'failed snapshot/file attestation twice',
    )
    expect((agentState as any).base2ActiveWork).toMatchObject({
      currentPhase: 'blocked',
      pendingGateFiles: ['src/a.ts'],
      reviewerProtocolRetryCount: 1,
      lastReviewerGateSkipReason: 'reviewer-protocol-attestation-failed',
      openReviewerFindings: [],
      nextRequiredAction:
        'Obtain a fresh matching structured review before finalization can continue.',
    })
    expect((agentState as any).base2ActiveWork.openReviewerBlockers).toEqual(
      expect.arrayContaining([
        'BLOCKING: code-reviewer failed snapshot/file attestation twice.',
      ]),
    )
    expect((agentState as any).base2ActiveWork.gatePassedFiles).not.toContain(
      'src/a.ts',
    )
    expect((agentState as any).canSuggestFollowups).toBe(false)
    expect(gen.next().done).toBe(true)
  })

  test('reviewer prompt maps gate test coverage to the changed test file in the same snapshot', () => {
    // Regression: the reviewer used to emit BLOCKING "requirement uncertain:
    // Gate behavior changes are covered by mapped tests in the changed test
    // file" even when the changed *.test.ts file was part of the same reviewed
    // snapshot, because its prompt never said that in-snapshot test files
    // satisfy the coverage requirement. The prompt must now state that
    // contract explicitly so mapped tests in the changed test file clear the
    // requirement instead of blocking the gate.
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2-custom' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [{ type: 'json', value: editReceipt('src/a.ts') }],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'run_file_change_hooks' })
    const postValidationStatus = gen.next({
      toolResult: [{ type: 'json', value: [] }],
    } as any).value as any
    expect(postValidationStatus).toMatchObject({ toolName: 'git_status' })
    const reviewCall = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any).value as any
    expect(reviewCall).toMatchObject({ toolName: 'spawn_agents' })
    const reviewPrompt = reviewCall.input.agents[0].prompt as string
    expect(reviewPrompt).toContain(
      'list every pending changed file in reviewedFiles (including tests)',
    )
    expect(reviewPrompt).toContain(
      'Changed tests are first-class review targets and may also be cited as coverage evidence.',
    )
    expect(reviewPrompt).not.toContain('not part of the reviewed fingerprint')
  })

  test('reviewer attestation citing the changed test file clears the gate test-coverage requirement', () => {
    // Gate behavior changes in base2.ts are covered by mapped tests in
    // agents/__tests__/base2.test.ts, which is itself part of the reviewed
    // pending file set. A reviewer that attests the test-coverage requirement
    // as satisfied with the changed test file as evidence must finalize the
    // gate — it must not degrade to BLOCKING "requirement uncertain".
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2-custom' }
    const gen = base2.handleSteps!({
      agentState,
      prompt:
        'Change base2 gate behavior and add mapped tests in the changed test file',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'query_index' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: [] }] } as any).value,
    ).toMatchObject({ toolName: 'add_message' })
    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [
          { type: 'json', value: editReceipt('agents/base2/base2.ts') },
          {
            type: 'json',
            value: editReceipt('agents/__tests__/base2.test.ts'),
          },
        ],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [
          {
            type: 'json',
            value: {
              status:
                ' M agents/base2/base2.ts\n M agents/__tests__/base2.test.ts',
            },
          },
        ],
      } as any).value,
    ).toMatchObject({ toolName: 'inspect_environment' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: {} }] } as any).value,
    ).toMatchObject({ toolName: 'get_affected_tests' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: {} }] } as any).value,
    ).toMatchObject({ toolName: 'get_build_targets' })
    const testWriterCall = gen.next({
      toolResult: [{ type: 'json', value: {} }],
    } as any).value as any
    expect(testWriterCall).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'test-writer' },
    })
    // After a valid receipt the gate runs a basher validation command for
    // the writer's test group before proceeding to run_file_change_hooks.
    const testWriterReceipt = {
      schemaVersion: 1,
      receiptId: 'tw-receipt',
      status: 'completed',
      changedFiles: [{ path: 'agents/__tests__/base2.test.ts' }],
      findingsAddressed: [],
      requestedValidation: [],
      completionKind: 'changed',
      evidence: ['agents/__tests__/base2.test.ts covers the gate behavior change.'],
    }
    const basherValidation = gen.next({
      toolResult: [
        {
          type: 'json',
          value: {
            result: testWriterReceipt,
            agentReceipt: testWriterReceipt,
          },
        },
      ],
    } as any).value as any
    expect(basherValidation).toMatchObject({ toolName: 'spawn_agents' })
    // After the basher validation passes, the aux-gate section continues the
    // outer loop (yielding STEP), then re-enters and reaches
    // run_file_change_hooks. Drain through STEP and intermediate yields.
    const dirtyStatus =
      ' M agents/base2/base2.ts\n M agents/__tests__/base2.test.ts'
    let hookStep = gen.next({
      toolResult: [{ type: 'json', value: [] }],
    } as any).value as any
    let hookGuard = 0
    while (
      hookStep &&
      hookStep.toolName !== 'run_file_change_hooks' &&
      hookGuard++ < 20
    ) {
      if (hookStep === 'STEP') {
        hookStep = gen.next({
          stepsComplete: true,
          toolResult: [{ type: 'json', value: {} }],
        } as any).value as any
      } else {
        const toolResult =
          hookStep.toolName === 'git_status'
            ? { status: dirtyStatus }
            : {}
        hookStep = gen.next({
          toolResult: [{ type: 'json', value: toolResult }],
        } as any).value as any
      }
    }
    expect(hookStep).toMatchObject({ toolName: 'run_file_change_hooks' })
    const postValidationStatus = gen.next({
      toolResult: [{ type: 'json', value: [] }],
    } as any).value as any
    expect(postValidationStatus).toMatchObject({ toolName: 'git_status' })
    const reviewCall = gen.next({
      toolResult: [{ type: 'json', value: { status: dirtyStatus } }],
    } as any).value as any
    expect(reviewCall).toMatchObject({ toolName: 'spawn_agents' })
    const reviewPrompt = reviewCall.input.agents[0].prompt as string
    const snapshotFingerprint = reviewPrompt
      .split('Snapshot fingerprint (echo exactly): ')[1]
      .split('\n')[0]
    const finalPreCreditStatus = gen.next({
      toolResult: [
        {
          type: 'json',
          value: [
            {
              schemaVersion: 1,
              verdict: 'LOOKS_GOOD',
              snapshotFingerprint,
              reviewedFiles: [
                'agents/base2/base2.ts',
                'agents/__tests__/base2.test.ts',
              ],
              findings: [],
              coverage: 'covered',
              dimensions: { correctness: 'pass', tests: 'pass' },
              requirementCoverage: [
                {
                  requirement:
                    'Gate behavior changes are covered by mapped tests in the changed test file',
                  status: 'satisfied',
                  evidence: [
                    'agents/__tests__/base2.test.ts covers the gate behavior change.',
                  ],
                },
              ],
            },
          ],
        },
      ],
    } as any)
    expect(finalPreCreditStatus.value).toMatchObject({ toolName: 'git_status' })
    const gatePassed = gen.next({
      toolResult: [{ type: 'json', value: { status: dirtyStatus } }],
    } as any)

    expect(gatePassed.value).toMatchObject({ toolName: 'add_message' })
    const passText = (gatePassed.value as any).input.content as string
    expect(passText).toContain('Reviewer gate passed with LOOKS_GOOD')
    expect(passText).not.toContain('requirement uncertain')
    expect((agentState as any).base2ActiveWork).toMatchObject({
      currentPhase: 'final_response_allowed',
      pendingGateFiles: [],
      openReviewerBlockers: [],
      gatePassedReviewerVerdict: 'LOOKS_GOOD',
    })
  })

  test('structured NON_BLOCKING reviewer JSON output finalizes', () => {
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2-custom' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [{ type: 'json', value: editReceipt('src/a.ts') }],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'run_file_change_hooks' })
    const postValidationStatus = gen.next({
      toolResult: [{ type: 'json', value: [] }],
    } as any).value as any
    expect(postValidationStatus).toMatchObject({ toolName: 'git_status' })
    const reviewCall = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any).value as any
    expect(reviewCall).toMatchObject({ toolName: 'spawn_agents' })
    const reviewPrompt = reviewCall.input.agents[0].prompt as string
    const snapshotFingerprint = reviewPrompt
      .split('Snapshot fingerprint (echo exactly): ')[1]
      .split('\n')[0]
    expect(snapshotFingerprint).toMatch(/^v3:[0-9a-f]{64}$/)
    expect(reviewPrompt).toContain(
      'Snapshot details (read for file membership; do not echo):',
    )
    const finalPreCreditStatus = gen.next({
      toolResult: [
        {
          type: 'json',
          value: [
            {
              schemaVersion: 1,
              verdict: 'NON_BLOCKING',
              snapshotFingerprint,
              reviewedFiles: ['src/a.ts'],
              coverage: 'covered',
              dimensions: { correctness: 'pass' },
              findings: [
                {
                  id: 'code-reviewer:correctness:minor-style',
                  summary: 'Minor style suggestion.',
                  severity: 'low',
                  dimension: 'correctness',
                  evidence: ['src/a.ts uses the expected behavior.'],
                  correction: 'Optional naming cleanup.',
                },
              ],
              requirementCoverage: [
                {
                  requirement: 'Requested behavior',
                  status: 'satisfied',
                  evidence: ['src/a.ts'],
                },
              ],
            },
          ],
        },
      ],
    } as any)
    expect(finalPreCreditStatus.value).toMatchObject({ toolName: 'git_status' })
    const gatePassed = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any)

    expect(gatePassed.value).toMatchObject({ toolName: 'add_message' })
    expect((gatePassed.value as any).input.content).toContain(
      'Reviewer gate passed with NON_BLOCKING',
    )
    expect((agentState as any).base2ActiveWork).toMatchObject({
      currentPhase: 'final_response_allowed',
      gatePassedReviewerVerdict: 'NON_BLOCKING',
    })
    expect((agentState as any).base2ActiveWork.reviewReceipts).toEqual([
      expect.objectContaining({
        reviewer: 'code-reviewer',
        verdict: 'NON_BLOCKING',
        snapshotFingerprint,
        reviewedFiles: ['src/a.ts'],
        findings: [
          expect.objectContaining({
            id: 'code-reviewer:correctness:minor-style',
            evidence: ['src/a.ts uses the expected behavior.'],
          }),
        ],
        requirementCoverage: [
          expect.objectContaining({
            requirement: 'Requested behavior',
            evidence: ['src/a.ts'],
          }),
        ],
      }),
    ])
  })

  test('bounds durable review receipts by total serialized size', () => {
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2-custom' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [{ type: 'json', value: editReceipt('src/a.ts') }],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'run_file_change_hooks' })
    const postValidationStatus = gen.next({
      toolResult: [{ type: 'json', value: [] }],
    } as any).value as any
    expect(postValidationStatus).toMatchObject({ toolName: 'git_status' })
    const reviewCall = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any).value as any
    expect(reviewCall).toMatchObject({ toolName: 'spawn_agents' })
    const snapshotFingerprint = (reviewCall.input.agents[0].prompt as string)
      .split('Snapshot fingerprint (echo exactly): ')[1]
      .split('\n')[0]
    const longText = 'receipt detail '.repeat(300)

    const finalPreCreditStatus = gen.next({
      toolResult: [
        {
          type: 'json',
          value: [
            {
              schemaVersion: 1,
              verdict: 'NON_BLOCKING',
              snapshotFingerprint,
              reviewedFiles: ['src/a.ts'],
              coverage: 'covered',
              dimensions: { correctness: 'pass' },
              findings: Array.from({ length: 20 }, (_, index) => ({
                id: `code-reviewer:correctness:finding-${index}`,
                summary: longText,
                severity: 'low',
                dimension: 'correctness',
                evidence: Array.from({ length: 8 }, () => longText),
                correction: longText,
              })),
              requirementCoverage: Array.from({ length: 100 }, (_, index) => ({
                requirement: `Requirement ${index}: ${longText}`,
                status: 'satisfied',
                evidence: Array.from({ length: 8 }, () => longText),
              })),
            },
          ],
        },
      ],
    } as any)
    expect(finalPreCreditStatus.value).toMatchObject({ toolName: 'git_status' })
    const gatePassed = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any)

    expect(gatePassed.value).toMatchObject({ toolName: 'add_message' })
    const receipt = (agentState as any).base2ActiveWork.reviewReceipts[0]
    expect(JSON.stringify(receipt).length).toBeLessThanOrEqual(4_000)
    expect(receipt).toMatchObject({
      findingCount: 20,
      requirementCoverageCount: 100,
      receiptTruncated: true,
    })
  })

  test('execute-plan prompts use injected artifacts without repeated unchanged reads', () => {
    const base2 = createBase2('default', { executePlan: true })

    expect(base2.instructionsPrompt).toContain(
      'artifact contents already provided in the conversation as the initial authoritative context',
    )
    expect(base2.instructionsPrompt).toContain(
      'read artifacts directly only when their contents are missing, truncated, stale, or have changed',
    )
    expect(base2.stepPrompt).toContain(
      'Use any artifact contents already present in the conversation as the initial source of truth',
    )
    expect(base2.stepPrompt).toContain(
      'read artifacts directly only when contents are missing, truncated, stale, or have changed',
    )
    expect(base2.stepPrompt).toContain(
      'Do not repeatedly re-read unchanged artifacts or source files after confirming the next item',
    )
    expect(base2.stepPrompt).toContain(
      'you may edit project source files to complete planned tasks',
    )
    expect(base2.stepPrompt).not.toContain(
      'Read STATUS.md and PLAN.md before acting',
    )
    for (const tool of ['edit_transaction', 'run_terminal_command'] as const) {
      expect(base2.toolNames).toContain(tool)
    }
    for (const tool of [
      'str_replace',
      'write_file',
      'apply_patch',
      'replace_range',
      'rewrite_symbol',
    ] as const) {
      expect(base2.toolNames).not.toContain(tool)
    }
    expect(base2.toolNames).not.toContain('propose_str_replace')
    expect(base2.toolNames).not.toContain('apply_proposal')
  })

  test('editor handoff guidance includes the standardized envelope fields', () => {
    const base2 = createBase2('default')
    for (const field of [
      'Requirements:',
      'Target files:',
      'Constraints/non-goals:',
      'Patterns:',
      'Risks:',
    ]) {
      expect(base2.instructionsPrompt).toContain(field)
    }
    // Step prompt should also use the envelope field names so the editor can
    // scan them as a checklist.
    for (const field of [
      'Requirements',
      'Target files',
      'Constraints/non-goals',
      'Patterns',
      'Risks',
    ]) {
      expect(base2.stepPrompt).toContain(field)
    }
  })

  test('non-blocking reviewer feedback allows finalization without controlling active work', () => {
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [{ type: 'json', value: editReceipt('src/a.ts') }],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'run_file_change_hooks' })
    const postValidationStatus = gen.next({
      toolResult: [{ type: 'json', value: [] }],
    } as any).value
    expect(postValidationStatus).toMatchObject({ toolName: 'git_status' })
    const reviewCall = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any).value
    expect(reviewCall).toMatchObject({ toolName: 'spawn_agents' })
    const finalPreCreditStatus = gen.next(
      attestedReviewerResult(reviewCall, 'NON_BLOCKING', [
        'Improve naming.',
      ]) as any,
    )
    expect(finalPreCreditStatus.value).toMatchObject({ toolName: 'git_status' })
    const afterReview = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any)

    expect(afterReview.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect((afterReview.value as any).input.content).toContain(
      'Reviewer gate passed with NON_BLOCKING',
    )
    expect((afterReview.value as any).input.content).not.toContain(
      'passed with LOOKS_GOOD',
    )
    expect((agentState as any).base2ActiveWork).toMatchObject({
      currentPhase: 'final_response_allowed',
      pendingGateFiles: [],
      openReviewerBlockers: [],
      nextRequiredAction: '',
    })
  })
})

describe('base2 gate-passed credit ledger (Option A)', () => {
  test('records a content marker for every file credited on a passing gate', () => {
    const base2 = createBase2('default')
    const tmpDir = makeProjectTempDir('base2-credit-marker-')
    const tmpFile = join(tmpDir, 'a.ts')
    const gateFile = normalizeGateFilePath(tmpFile)
    try {
      writeFileSync(tmpFile, 'export const value = 1\n')
      const agentState = { agentId: 'base2-custom' }
      const gen = base2.handleSteps!({
        agentState,
        prompt: 'Make the requested change now please',
        params: {},
      } as any)

      expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
      expect(
        gen.next({
          toolResult: [{ type: 'json', value: { status: '' } }],
        } as any).value,
      ).toMatchObject({ toolName: 'spawn_agent_inline' })
      expect(gen.next().value).toBe('STEP')
      expect(
        gen.next({
          stepsComplete: true,
          toolResult: [{ type: 'json', value: editReceipt(gateFile) }],
        } as any).value,
      ).toMatchObject({ toolName: 'git_status' })
      expect(
        gen.next({
          toolResult: [
            { type: 'json', value: { status: ` M ${gateFile}` } },
          ],
        } as any).value,
      ).toMatchObject({ toolName: 'run_file_change_hooks' })
      expect(
        gen.next({
          toolResult: [{ type: 'json', value: [] }],
        } as any).value,
      ).toMatchObject({ toolName: 'git_status' })
      const reviewCall = gen.next({
        toolResult: [
          { type: 'json', value: { status: ` M ${gateFile}` } },
        ],
      } as any).value
      expect(reviewCall).toMatchObject({ toolName: 'spawn_agents' })
      expect(
        gen.next(attestedReviewerResult(reviewCall) as any).value,
      ).toMatchObject({ toolName: 'git_status' })
      const gatePassed = gen.next({
        toolResult: [
          { type: 'json', value: { status: ` M ${gateFile}` } },
        ],
      } as any)

      expect(gatePassed.value).toMatchObject({ toolName: 'add_message' })
      const activeWork = (agentState as any).base2ActiveWork
      expect(activeWork.gatePassedFiles).toContain(gateFile)
      // Option A: crediting a file records its content marker so the per-file
      // eviction guard can detect later drift and reopen the gate.
      expect(activeWork.gatePassedFileMarkers).toBeDefined()
      expect(
        Object.prototype.hasOwnProperty.call(
          activeWork.gatePassedFileMarkers,
          gateFile,
        ),
      ).toBe(true)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('evicts a credited file whose content drifted and republishes it as unvalidated', () => {
    // A file credited into gatePassedFiles in an earlier turn must not stay
    // trusted if its bytes change afterward. The per-file eviction guard
    // compares the stored marker against the current content marker; on a
    // mismatch it drops the file from the ledger, reopens validation, and
    // republishes it in uncommittedUnvalidatedFiles so the commit guard blocks
    // staging it.
    const base2 = createBase2('default')
    const tmpDir = makeProjectTempDir('base2-credit-drift-')
    const tmpFile = join(tmpDir, 'a.ts')
    try {
      writeFileSync(tmpFile, 'export const value = 1\n')
      const gateFile = normalizeGateFilePath(tmpFile)
      const staleMarker =
        'sha256:0000000000000000000000000000000000000000000000000000000000000000:1'
      const agentState: Record<string, unknown> = {
        agentId: 'base2',
        base2ActiveWork: {
          changedFiles: [gateFile],
          touchedFiles: [gateFile],
          pendingGateFiles: [],
          currentPhase: 'final_response_allowed',
          latestWorkSummary: '',
          openReviewerBlockers: [],
          lastValidationSummary:
            'Configured file-change hooks passed: typecheck.',
          nextRequiredAction: '',
          lastPinnedStateMessage: '',
          gatePassedFiles: [gateFile],
          gatePassedFileMarkers: { [gateFile]: staleMarker },
        },
      }
      const gen = base2.handleSteps!({
        agentState,
        prompt: 'Finish the previous response.',
        params: {},
      } as any)

      expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
      expect(
        gen.next({
          toolResult: [{ type: 'json', value: { status: ` M ${tmpFile}` } }],
        } as any).value,
      ).toMatchObject({ toolName: 'spawn_agent_inline' })
      expect(gen.next().value).toMatchObject({ toolName: 'add_message' })
      expect(gen.next().value).toBe('STEP')

      expect((agentState as any).uncommittedUnvalidatedFiles).toEqual([
        gateFile,
      ])
      expect((agentState as any).base2ActiveWork.currentPhase).toBe(
        'awaiting_validation',
      )
      expect((agentState as any).base2ActiveWork.gatePassedFiles).toEqual([])
      expect((agentState as any).base2ActiveWork.pendingGateFiles).toEqual([
        gateFile,
      ])
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('fails closed and evicts a credited file that has no stored marker (legacy state)', () => {
    // Older serialized state predates gatePassedFileMarkers, so a credited
    // file may have no marker. A credited file with no stored marker is
    // treated as drifted (fail closed): it is evicted and republished rather
    // than granting an unattested commit.
    const base2 = createBase2('default')
    const tmpDir = makeProjectTempDir('base2-credit-legacy-')
    const tmpFile = join(tmpDir, 'a.ts')
    try {
      writeFileSync(tmpFile, 'export const value = 1\n')
      const gateFile = normalizeGateFilePath(tmpFile)
      const agentState: Record<string, unknown> = {
        agentId: 'base2',
        base2ActiveWork: {
          changedFiles: [gateFile],
          touchedFiles: [gateFile],
          pendingGateFiles: [],
          currentPhase: 'final_response_allowed',
          latestWorkSummary: '',
          openReviewerBlockers: [],
          lastValidationSummary:
            'Configured file-change hooks passed: typecheck.',
          nextRequiredAction: '',
          lastPinnedStateMessage: '',
          gatePassedFiles: [gateFile],
          // No gatePassedFileMarkers field at all (legacy serialized state).
        },
      }
      const gen = base2.handleSteps!({
        agentState,
        prompt: 'Finish the previous response.',
        params: {},
      } as any)

      expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
      expect(
        gen.next({
          toolResult: [{ type: 'json', value: { status: ` M ${tmpFile}` } }],
        } as any).value,
      ).toMatchObject({ toolName: 'spawn_agent_inline' })
      expect(gen.next().value).toMatchObject({ toolName: 'add_message' })
      expect(gen.next().value).toBe('STEP')

      expect((agentState as any).uncommittedUnvalidatedFiles).toEqual([
        gateFile,
      ])
      expect((agentState as any).base2ActiveWork.currentPhase).toBe(
        'awaiting_validation',
      )
      expect((agentState as any).base2ActiveWork.gatePassedFiles).toEqual([])
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('retains a credited file whose stored marker still matches current content', () => {
    // The eviction guard must not falsely evict a genuinely still-valid
    // credited file: when the stored marker equals the current content marker,
    // the file stays in gatePassedFiles and is NOT republished as unvalidated,
    // so a scoped commit that covers only it remains allowed.
    const base2 = createBase2('default')
    const tmpDir = makeProjectTempDir('base2-credit-retain-')
    const tmpFile = join(tmpDir, 'a.ts')
    try {
      writeFileSync(tmpFile, 'export const value = 1\n')
      const gateFile = normalizeGateFilePath(tmpFile)
      const agentState: Record<string, unknown> = {
        agentId: 'base2',
        base2ActiveWork: {
          changedFiles: [gateFile],
          touchedFiles: [gateFile],
          pendingGateFiles: [],
          currentPhase: 'final_response_allowed',
          latestWorkSummary: '',
          openReviewerBlockers: [],
          lastValidationSummary:
            'Configured file-change hooks passed: typecheck.',
          nextRequiredAction: '',
          lastPinnedStateMessage: '',
          gatePassedFiles: [gateFile],
          gatePassedFileMarkers: { [gateFile]: buildContentMarker(tmpFile) },
        },
      }
      const gen = base2.handleSteps!({
        agentState,
        prompt: 'Finish the previous response.',
        params: {},
      } as any)

      expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
      expect(
        gen.next({
          toolResult: [{ type: 'json', value: { status: ` M ${tmpFile}` } }],
        } as any).value,
      ).toMatchObject({ toolName: 'spawn_agent_inline' })
      // The retain path does not deterministically emit a pinned-state message.
      const maybePinnedState = gen.next().value
      if (maybePinnedState !== 'STEP') {
        expect(maybePinnedState).toMatchObject({ toolName: 'add_message' })
        expect(gen.next().value).toBe('STEP')
      }

      // Marker matches -> no eviction -> nothing republished as unvalidated.
      expect((agentState as any).uncommittedUnvalidatedFiles).toEqual([])
      expect((agentState as any).base2ActiveWork.gatePassedFiles).toEqual([
        gateFile,
      ])
      expect((agentState as any).base2ActiveWork.currentPhase).toBe(
        'final_response_allowed',
      )
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('gate-state type round-trips gatePassedFileMarkers through JSON and is optional on older state', () => {
    const state: Base2ActiveWorkState = {
      pendingGateFiles: ['src/a.ts'],
      gatePassedFiles: ['src/a.ts'],
      gatePassedFileMarkers: { 'src/a.ts': 'sha256:abc:10' },
      gatePassedPendingFiles: [],
      gatePassedReviewerVerdict: '',
      gatePassedValidationSummary: '',
      gatePassedFingerprint: '',
      lastReviewerGateSkipReason: '',
      touchedFiles: ['src/a.ts'],
      changedFiles: ['src/a.ts'],
      currentPhase: 'final_response_allowed',
      latestWorkSummary: '',
      openReviewerBlockers: [],
      lastValidationSummary: '',
      nextRequiredAction: '',
      lastPinnedStateMessage: '',
    }
    const roundTripped = JSON.parse(
      JSON.stringify(state),
    ) as Base2ActiveWorkState
    expect(roundTripped.gatePassedFileMarkers).toEqual({
      'src/a.ts': 'sha256:abc:10',
    })

    // Older serialized state lacks the field entirely; it stays optional.
    const olderState: Base2ActiveWorkState = {
      pendingGateFiles: ['src/a.ts'],
      gatePassedFiles: [],
      gatePassedPendingFiles: [],
      gatePassedReviewerVerdict: '',
      gatePassedValidationSummary: '',
      gatePassedFingerprint: '',
      lastReviewerGateSkipReason: '',
      touchedFiles: ['src/a.ts'],
      changedFiles: ['src/a.ts'],
      currentPhase: 'awaiting_validation',
      latestWorkSummary: '',
      openReviewerBlockers: [],
      lastValidationSummary: '',
      nextRequiredAction: '',
      lastPinnedStateMessage: '',
    }
    const olderRoundTripped = JSON.parse(
      JSON.stringify(olderState),
    ) as Base2ActiveWorkState
    expect(olderRoundTripped.gatePassedFileMarkers).toBeUndefined()
  })
})

describe('base2 validation-first reviewer snapshots', () => {
  test('validates before spawning the final reviewer', () => {
    const base2 = createBase2('default')
    const agentState = {
      agentId: 'base2-custom',
      base2ActiveWork: {},
    }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [{ type: 'json', value: editReceipt('src/a.ts') }],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const validation = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any)
    expect(validation.value).toMatchObject({ toolName: 'run_file_change_hooks' })

    const postValidationStatus = gen.next({
      toolResult: [{ type: 'json', value: [] }],
    } as any)
    expect(postValidationStatus.value).toMatchObject({ toolName: 'git_status' })
    const review = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any)
    expect(review.value).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'code-reviewer' }] },
    })
    expect((review.value as any).input.agents[0]).not.toHaveProperty('background')
  })
})

describe('base2 repair-loop gate-state telemetry (M6.4)', () => {
  test('repair-incomplete gate-state block surfaces repairRound and maxRepairRounds', () => {
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2-custom' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    // Pre-step git_status (no pre-existing changes).
    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')

    // Step completes with a canonical edit receipt so src/a.ts enters
    // changedFiles before the mid-turn git-status sweep; the post-step
    // git_status then reports the same pending change.
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [{ type: 'json', value: editReceipt('src/a.ts') }],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'run_file_change_hooks' })

    // Validation fails with a parseable (tsc-shaped) failure -> repair loop.
    const typecheckFailure = {
      type: 'json',
      value: [
        {
          hookName: 'typecheck',
          exitCode: 1,
          stderr: 'src/a.ts(1,1): error TS1234: type error',
        },
      ],
    }
    const repairSpawn = gen.next({
      toolResult: [typecheckFailure],
    } as any).value as any
    expect(repairSpawn).toMatchObject({ toolName: 'spawn_agents' })
    expect(
      repairSpawn.input.agents[0].handoff.permissions.readablePaths,
    ).toEqual(['src/a.ts', 'src/**/*'])
    expect(
      repairSpawn.input.agents[0].handoff.permissions.readablePaths,
    ).not.toContain('.env')
    expect(
      repairSpawn.input.agents[0].handoff.permissions.readablePaths,
    ).not.toEqual(expect.arrayContaining(['*', '**/*']))
    expect(
      repairSpawn.input.agents[0].handoff.permissions.writablePaths,
    ).toEqual(['src/a.ts'])
    // Repair editor ran; git_status after the repair editor.
    expect(
      gen.next(completedRepairReceipt(['VF-1'], ['src/a.ts']) as any).value,
    ).toMatchObject({
      toolName: 'git_status',
    })
    // Re-verify hooks run after the repair editor.
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'run_file_change_hooks' })

    // Re-verify still fails -> the repair-incomplete blocked path emits the
    // gate-state block carrying structured repair-loop progress.
    const blocked = gen.next({ toolResult: [typecheckFailure] } as any)
    expect((blocked.value as any).toolName).toBe('add_message')
    const content = (blocked.value as any).input.content as string
    const parsed = parseGateStateBlock(content)

    expect(parsed).toBeDefined()
    expect(parsed!.gate).toBe('validation')
    expect(parsed!.status).toBe('failed')
    expect(parsed!.repairRound).toBeGreaterThanOrEqual(1)
    expect(parsed!.repairRound).toBe(1)
    expect(parsed!.maxRepairRounds).toBe(3)
    expect(parsed!.details).toContain('repair-incomplete')
    expect(parsed!.details).toContain('round 1/3')
  })

  test('non-repair gate-state blocks omit repairRound/maxRepairRounds for backward compatibility', () => {
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2-custom' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({ stepsComplete: true, toolResult: [] } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    // No edits: validation hooks are skipped, the reviewer gate does not run,
    // and the finalization block stays the legacy {gate,status,details} shape.
    const finalized = gen.next({
      toolResult: [{ type: 'json', value: { status: '' } }],
    } as any)
    expect((finalized.value as any).toolName).toBe('add_message')
    const content = (finalized.value as any).input.content as string
    const parsed = parseGateStateBlock(content)

    expect(parsed).toBeDefined()
    expect(parsed!.gate).toBe('validation/reviewer')
    expect(parsed!.status).toBe('passed')
    expect(parsed!.repairRound).toBeUndefined()
    expect(parsed!.maxRepairRounds).toBeUndefined()
  })
})

describe('base2 test-writer aux-gate completion path', () => {
  test('a valid structured writer receipt sets testWriterGateDone and proceeds to validation', () => {
    // Regression for the _yieldseq.out infinite loop: when the test-writer
    // spawn returns a valid completed receipt with changedFiles and a
    // changed completionKind, the aux gate must mark testWriterGateDone and
    // proceed to the validation/reviewer gate instead of looping back through
    // the test-writer spawn forever.
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2-custom' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Add tests for the new gate behavior',
      params: {},
      config: base2.programmaticConfig,
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'query_index' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: [] }] } as any).value,
    ).toMatchObject({ toolName: 'add_message' })
    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [{ type: 'json', value: editReceipt('src/a.ts') }],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    // The prompt requires tests, so the test-writer aux gate fires before the
    // validation/reviewer gate. inspect_environment → get_affected_tests →
    // get_build_targets feed selectProjectAwareTestWriterTargets, which falls
    // back to selectTestWriterTargets when the environment results are empty.
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'inspect_environment' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: {} }] } as any).value,
    ).toMatchObject({ toolName: 'get_affected_tests' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: {} }] } as any).value,
    ).toMatchObject({ toolName: 'get_build_targets' })
    const testWriterSpawn = gen.next({
      toolResult: [{ type: 'json', value: {} }],
    } as any).value as any
    expect(testWriterSpawn).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'test-writer' },
    })
    // A valid completed receipt: status='completed', completionKind='changed',
    // changedFiles non-empty. The gate must mark testWriterGateDone and
    // proceed (no infinite loop).
    const testWriterReceipt = {
      schemaVersion: 1,
      receiptId: 'tw-receipt',
      status: 'completed',
      changedFiles: [{ path: 'src/a.test.ts' }],
      findingsAddressed: [],
      requestedValidation: [],
      completionKind: 'changed',
      evidence: ['src/a.test.ts covers the gate behavior change.'],
    }
    const validReceipt = gen.next({
      toolResult: [
        {
          type: 'json',
          value: {
            result: testWriterReceipt,
            agentReceipt: testWriterReceipt,
          },
        },
      ],
    } as any)
    // After a valid receipt the gate runs a basher validation command.
    // testWriterGateDone is only set after the basher validation passes.
    const basherValidation = validReceipt.value as any
    expect(basherValidation).toMatchObject({ toolName: 'spawn_agents' })
    gen.next({ toolResult: [{ type: 'json', value: [] }] } as any)
    expect(
      (agentState as any).base2ActiveWork.testWriterGateDone,
    ).toBe(true)
    // After the test-writer gate completes, the generator continues the loop
    // and reaches run_file_change_hooks (the final validation/reviewer gate).
    // It may yield a spawn_agents (basher validation command from the test
    // group) first; drain until we see a non-test-writer gate tool. The key
    // assertion is that testWriterGateDone is set, proving the gate did not
    // loop back to re-spawn the test-writer.
    let step = validReceipt.value as any
    let guard = 0
    while (
      step &&
      !(step.toolName === 'run_file_change_hooks' || step.toolName === 'git_status') &&
      guard++ < 10
    ) {
      step = gen.next({ toolResult: [{ type: 'json', value: {} }] } as any)
        .value as any
    }
    expect(step).toBeTruthy()
  })

  test('an incomplete/invalid writer receipt blocks and does not loop indefinitely', () => {
    // When the test-writer returns an empty or incomplete receipt (no
    // completionKind, no changedFiles, status not 'completed'), the gate must
    // block the turn instead of re-spawning the test-writer forever. The
    // _yieldseq.out trace showed the harness feeding empty {} results, which
    // caused testWriterCrash; the production gate must surface the blocked
    // state with testWriterGateDone still false.
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2-custom' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Add tests for the new gate behavior',
      params: {},
      config: base2.programmaticConfig,
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'query_index' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: [] }] } as any).value,
    ).toMatchObject({ toolName: 'add_message' })
    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [{ type: 'json', value: editReceipt('src/a.ts') }],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'inspect_environment' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: {} }] } as any).value,
    ).toMatchObject({ toolName: 'get_affected_tests' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: {} }] } as any).value,
    ).toMatchObject({ toolName: 'get_build_targets' })
    const testWriterSpawn = gen.next({
      toolResult: [{ type: 'json', value: {} }],
    } as any).value as any
    expect(testWriterSpawn).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'test-writer' },
    })
    // Invalid receipt: empty object with no schemaVersion/receiptId/status/
    // changedFiles/completionKind. The gate must mark testWriterGateDone with
    // reduced assurance and proceed, NOT re-spawn the test-writer forever.
    const afterInvalid = gen.next({
      toolResult: [{ type: 'json', value: {} }],
    } as any)
    expect(
      (agentState as any).base2ActiveWork.testWriterGateDone,
    ).toBe(true)
    expect(
      (agentState as any).base2ActiveWork.validationAssurance,
    ).toBe('reduced')
    // The gate must not re-spawn the test-writer; it proceeds past the aux
    // gate. The next yield may be another aux gate (e.g. doc-writer) but must
    // not be a test-writer re-spawn.
    const nextYield = afterInvalid.value as any
    if (nextYield?.toolName === 'spawn_agent_inline') {
      expect(nextYield.input.agent_type).not.toBe('test-writer')
    }
  })
})

describe('base2 COMMIT ANYWAY commit-scope bypass publisher', () => {
  test('authorizes the bypass at turn start for an exact standalone user COMMIT ANYWAY message', () => {
    // Publisher-parse coverage for updateCommitScopeBypassFromMessages: an
    // exact standalone user 'COMMIT ANYWAY' message authorizes the bypass
    // BEFORE the first STEP (turn-start recognition next to
    // updateWorkflowTodoProgressFromMessages), so a git-committer spawned in
    // the first step of the turn already sees the published flag, and the
    // bypass record captures the unvalidated dirty files at authorization
    // time.
    const base2 = createBase2('default')
    const agentState = {
      agentId: 'base2-custom',
      messageHistory: [
        { role: 'user', content: 'Please commit the pending changes.' },
        { role: 'assistant', content: 'The validation gate is still pending.' },
        { role: 'user', content: 'COMMIT ANYWAY' },
      ],
      uncommittedUnvalidatedFiles: ['src/b.ts'],
    }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'COMMIT ANYWAY',
      params: {},
      config: base2.programmaticConfig,
    } as any)

    // The first yield is the turn-start git_status; the bypass must already
    // be published by then (before any STEP completes).
    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect((agentState as any).commitScopeBypassAuthorized).toBe(true)
    expect((agentState as any).commitScopeBypassRecord).toMatchObject({
      reason: expect.stringContaining('COMMIT ANYWAY'),
      unvalidatedFiles: ['src/b.ts'],
    })
    expect(
      typeof (agentState as any).commitScopeBypassRecord.authorizedAt,
    ).toBe('string')
    expect(
      (agentState as any).commitScopeBypassRecord.authorizedAt.length,
    ).toBeGreaterThan(0)
  })

  test('recognizes a COMMIT ANYWAY message that arrives in the post-STEP message history', () => {
    // The post-STEP messageHistory branch still recognizes the phrase when it
    // appears in the message history returned by the step result.
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2-custom' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Commit the pending changes please',
      params: {},
      config: base2.programmaticConfig,
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect((agentState as any).commitScopeBypassAuthorized).toBeUndefined()
    // The step returns an updated message history containing the exact
    // standalone user authorization; the post-STEP branch publishes the bypass.
    gen.next({
      stepsComplete: false,
      toolResult: [],
      agentState: {
        messageHistory: [
          { role: 'user', content: 'Commit the pending changes please' },
          { role: 'user', content: 'COMMIT ANYWAY' },
        ],
      },
    } as any)
    expect((agentState as any).commitScopeBypassAuthorized).toBe(true)
    expect((agentState as any).commitScopeBypassRecord).toMatchObject({
      reason: expect.stringContaining('COMMIT ANYWAY'),
    })
  })

  test('does not authorize for substring prose or assistant/tool-role exact phrases', () => {
    // Negative publisher-parse cases: substring prose ('please commit anyway
    // now') and the exact phrase spoken by assistant/tool roles must NOT
    // authorize the security-sensitive commit-guard bypass.
    const negativeHistories: Array<Array<Record<string, unknown>>> = [
      [{ role: 'user', content: 'please commit anyway now' }],
      [{ role: 'assistant', content: 'COMMIT ANYWAY' }],
      [{ role: 'tool', content: 'COMMIT ANYWAY' }],
      [
        {
          role: 'user',
          content: [{ type: 'text', text: 'please commit anyway now' }],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'COMMIT ANYWAY' }],
        },
      ],
    ]
    for (const messageHistory of negativeHistories) {
      const base2 = createBase2('default')
      const agentState = { agentId: 'base2-custom', messageHistory }
      const gen = base2.handleSteps!({
        agentState,
        prompt: 'Commit the pending changes please',
        params: {},
        config: base2.programmaticConfig,
      } as any)

      // Turn start (first yield) must not have published the bypass...
      expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
      expect((agentState as any).commitScopeBypassAuthorized).toBeUndefined()
      expect((agentState as any).commitScopeBypassRecord).toBeUndefined()
      // ...and neither must the post-STEP messageHistory branch.
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
      gen.next() // STEP
      gen.next({
        stepsComplete: false,
        toolResult: [],
        agentState: { messageHistory },
      } as any)
      expect((agentState as any).commitScopeBypassAuthorized).toBeUndefined()
      expect((agentState as any).commitScopeBypassRecord).toBeUndefined()
    }
  })
})

describe('base2 reviewer repair budget cap', () => {
  test('crossing MAX_REVIEWER_REPAIR_ROUNDS blocks with an exhaustion message', () => {
    // Seed reviewerRepairRoundCount at MAX_REVIEWER_REPAIR_ROUNDS (=3) so the
    // very next blocking reviewer result crosses the cap (3 -> 4 > 3). The
    // loop must yield the exhaustion add_message and break out (currentPhase
    // blocked) instead of spawning yet another repair round. Driving four
    // full rounds through the generator is infeasible in a unit test, so the
    // seed-count approach from the requirements is used.
    const base2 = createBase2('default')
    const agentState = {
      agentId: 'base2',
      base2ActiveWork: { reviewerRepairRoundCount: 3 },
    }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    const maybePinned = gen.next().value
    if (maybePinned !== 'STEP') {
      expect(maybePinned).toMatchObject({ toolName: 'add_message' })
      expect(gen.next().value).toBe('STEP')
    }
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [{ type: 'json', value: editReceipt('src/a.ts') }],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'run_file_change_hooks' })
    const postValidationStatus = gen.next({
      toolResult: [{ type: 'json', value: [] }],
    } as any).value
    expect(postValidationStatus).toMatchObject({ toolName: 'git_status' })
    const reviewCall = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any).value
    expect(reviewCall).toMatchObject({ toolName: 'spawn_agents' })
    const exhausted = gen.next(
      attestedReviewerResult(reviewCall, 'BLOCKING', [
        'Fix the persistent edge case.',
      ]) as any,
    )

    expect(exhausted.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect((exhausted.value as any).input.content).toContain(
      'automated repair budget exhausted',
    )
    expect((agentState as any).base2ActiveWork.currentPhase).toBe('blocked')
    expect(
      (agentState as any).base2ActiveWork.nextRequiredAction,
    ).toContain('repair budget exhausted')
    // The open findings are still surfaced verbatim for inspection.
    expect((agentState as any).base2ActiveWork.openReviewerBlockers).toEqual([
      'BLOCKING: Fix the persistent edge case.',
    ])
    // Exhaustion breaks out of the loop; it does not spawn another repair.
    expect(gen.next().done).toBe(true)
  })
})

describe('base2 content-based reviewer finding correlation', () => {
  test('security-reviewer findings correlate to their record by content, not positional index', () => {
    // The security-reviewer blocking path builds openReviewerFindings from the
    // synthesized blocker strings. collectReviewerBlockers emits a blocker for
    // a plain string finding (which has NO finding record) alongside a blocker
    // for an object finding (which does), so the two arrays no longer line up
    // positionally. Positional records[index] correlation would attach the
    // object finding's id/text to the plain-string blocker; content-based
    // correlation must attach each record to the blocker whose text/id it
    // actually matches, and the record-less blocker must fall back to an
    // RF-... id with its own blocker text.
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Update sdk/src/policy/terminal-command-policy.ts.',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [
          {
            type: 'json',
            value: editReceipt('sdk/src/policy/terminal-command-policy.ts'),
          },
        ],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const securityReview = gen.next({
      toolResult: [
        {
          type: 'json',
          value: { status: ' M sdk/src/policy/terminal-command-policy.ts' },
        },
      ],
    } as any)
    expect(securityReview.value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'security-reviewer' },
    })
    const securityPrompt = (securityReview.value as any).input.prompt as string
    const snapshotFingerprint = securityPrompt
      .split('Snapshot fingerprint: ')[1]
      .split('\n')[0]
    const blockerMessage = gen.next({
      toolResult: [
        {
          type: 'json',
          value: {
            schemaVersion: 1,
            verdict: 'BLOCKING',
            snapshotFingerprint,
            reviewedFiles: ['sdk/src/policy/terminal-command-policy.ts'],
            // Order: a record-less string finding FIRST, then an object
            // finding with a record. Positional records[index] would misalign
            // the record onto the string blocker.
            findings: [
              'A synthesized-style finding with no id',
              {
                id: 'security-reviewer:containment:real',
                summary: 'Reject nested fixture paths.',
              },
            ],
            coverage: 'covered',
            dimensions: {},
            requirementCoverage: [],
          },
        },
      ],
    } as any)

    expect(blockerMessage.value).toMatchObject({ toolName: 'add_message' })
    const findings = (agentState as any).base2ActiveWork
      .openReviewerFindings as Array<{ id: string; text: string }>
    expect(findings).toHaveLength(2)
    // Record-less blocker falls back to an RF-... id and keeps its own text.
    expect(findings[0].id).toMatch(/^RF-/)
    expect(findings[0].text).toBe(
      'BLOCKING: A synthesized-style finding with no id',
    )
    // The object-finding blocker correlates by [id] to its real record.
    expect(findings[1].id).toBe('security-reviewer:containment:real')
    expect(findings[1].text).toBe('Reject nested fixture paths.')
  })
})
