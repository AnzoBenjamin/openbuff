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
import {
  createBase2,
  resolveMaxRepairRounds,
  resolveMaxReviewerRepairRounds,
  resolveMaxSpecialistRepairRounds,
} from '../base2/base2'
import { normalizeGateFilePath } from '../base2/gate-paths'
import type { Base2ActiveWorkState } from '../base2/gate-state'
import { resolveModelToolNames } from '../base2/tool-tiers'

const TEST_TMP_ROOT = join(process.cwd(), '.base2-test-scratch')
mkdirSync(TEST_TMP_ROOT, { recursive: true })

afterAll(() => {
  rmSync(TEST_TMP_ROOT, { recursive: true, force: true })
})

function makeProjectTempDir(prefix: string): string {
  return mkdtempSync(join(TEST_TMP_ROOT, prefix))
}

const LIST_JOBS_RESULT = {
  jobs: [],
  note: 'No action required unless you need this output.',
}

function feedJson(value: unknown) {
  return { toolResult: [{ type: 'json', value }] } as any
}

function finishStepWithToolResult(value: unknown) {
  return {
    stepsComplete: true,
    toolResult: [{ type: 'json', value }],
  } as any
}

function feedListJobs() {
  return feedJson(LIST_JOBS_RESULT)
}

/**
 * LOOKS_GOOD specialist receipt whose only requirementCoverage gaps are
 * parent-owned process duties. Includes rows parent-owned only via evidence
 * (requirement text alone is not a process cue) so call-site filters must
 * re-check structured requirementCoverage the same way finalization does.
 * Gate helpers must credit the specialist without spawning repair-editor.
 */
function looksGoodWithParentOwnedRequirements(
  agentType: string,
  snapshotFingerprint: string,
  files: string[],
) {
  return feedJson({
    agentType,
    value: {
      schemaVersion: 1,
      family: 'reviewer',
      verdict: 'LOOKS_GOOD',
      snapshotFingerprint,
      reviewedFiles: files,
      findings: [],
      coverage: 'covered',
      dimensions: {},
      requirementCoverage: [
        {
          requirement: 'Rewrite git commit messages',
          status: 'missing',
          evidence: ['parent only'],
        },
        {
          requirement: 'Run full validation gate',
          status: 'missing',
          evidence: ['parent only'],
        },
        {
          requirement: 'Commit and push',
          status: 'missing',
          evidence: ['parent only'],
        },
        {
          requirement: 'Confirm CI/CD is green',
          status: 'uncertain',
          evidence: ['parent only'],
        },
        // Parent-owned only via evidence; requirement text alone is in-scope.
        {
          requirement: 'Ship remaining workflow steps',
          status: 'missing',
          evidence: [
            'parent must run full validation gate after this specialist',
          ],
        },
      ],
    },
  })
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

type RepairEditorReadablePaths = (
  paths: string[],
  texts?: string[],
) => string[]

// repairEditorReadablePaths lives inside the serialized handleSteps generator.
// Reconstruct it with the normalizeGateFilePath + inferWorkspaceRootFromPath
// helpers it closes over so unit tests can assert package-root / cited-path
// expansions without driving a full gate lifecycle.
function loadInlineRepairEditorReadablePaths(): RepairEditorReadablePaths {
  const base2Source = readFileSync(
    new URL('../base2/base2.ts', import.meta.url),
    'utf8',
  )
  // handleSteps helpers are TypeScript; transpile before new Function (plain JS).
  const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' })
  const combinedTs = [
    extractInlineFunctionSource(base2Source, 'normalizeGateFilePath'),
    extractInlineFunctionSource(base2Source, 'inferWorkspaceRootFromPath'),
    extractInlineFunctionSource(base2Source, 'repairEditorReadablePaths'),
    'return repairEditorReadablePaths',
  ].join('\n')
  const combinedJs = transpiler.transformSync(combinedTs)
  const buildHelper = new Function(`"use strict";\n${combinedJs}`) as () => RepairEditorReadablePaths

  return buildHelper()
}

describe('base2 inline repairEditorReadablePaths', () => {
  const repairEditorReadablePaths = loadInlineRepairEditorReadablePaths()

  test('expands package roots for multi-segment paths without granting project-wide **/*', () => {
    const paths = repairEditorReadablePaths([
      'packages/agent-runtime/src/foo.ts',
    ])
    expect(paths).toEqual(
      expect.arrayContaining([
        'packages/agent-runtime/src/foo.ts',
        'packages/agent-runtime/src/**/*',
        'packages/agent-runtime/**/*',
      ]),
    )
    expect(paths).not.toEqual(expect.arrayContaining(['*', '**/*']))
  })

  test('extracts cited schema/context paths from finding text into READ scope', () => {
    // Finding files list only a packages/ path, but the finding text cites a
    // common/ schema file that the repair editor needs as read-only context.
    const paths = repairEditorReadablePaths(
      ['packages/agent-runtime/src/tools/edit.ts'],
      [
        'BLOCKING: import is out of date; see common/src/tools/params/tool/replace-range.ts for the schema.',
      ],
    )
    expect(paths).toEqual(
      expect.arrayContaining([
        'packages/agent-runtime/src/tools/edit.ts',
        'common/src/tools/params/tool/replace-range.ts',
      ]),
    )
    expect(
      paths.includes('common/**/*') ||
        paths.includes('common/src/tools/params/tool/**/*'),
    ).toBe(true)
    expect(paths).not.toEqual(expect.arrayContaining(['*', '**/*']))
  })

  test('skips URL-like tokens, node_modules, and .env paths from free-text extraction', () => {
    const paths = repairEditorReadablePaths(['src/a.ts'], [
      'See https://example.com/src/schema.ts and node_modules/pkg/index.ts and .env.local',
    ])
    expect(paths).toEqual(expect.arrayContaining(['src/a.ts', 'src/**/*']))
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false)
    expect(paths.some((p) => p.includes('.env'))).toBe(false)
    expect(paths).not.toContain('https://example.com/src/schema.ts')
    // Protocol is stripped by the path-like capture (match starts after `:`),
    // so host-looking first segments must also be rejected.
    expect(paths).not.toContain('example.com/src/schema.ts')
    expect(paths.some((p) => p.startsWith('example.com'))).toBe(false)
    expect(paths).not.toEqual(expect.arrayContaining(['*', '**/*']))
  })

  test('root-level files stay file + parent-dir only (no bare **/*)', () => {
    const paths = repairEditorReadablePaths(['README.md'])
    expect(paths).toEqual(['README.md'])
    expect(paths).not.toEqual(expect.arrayContaining(['*', '**/*']))
  })
})

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
    // specialistRoutingSection is relocated to a guide under default-on
    // disclosure; assert the relocation pointer in systemPrompt and keep the
    // verbatim-line contract on the explicit-off surface instead.
    expect(base2.systemPrompt).toContain('agents/guides/specialist-routing.md')
    const base2DisclosureOff = createBase2('default', {
      progressivePromptDisclosure: false,
    })
    expect(base2DisclosureOff.systemPrompt).toContain(
      'Post-edit reviewer-family specialists are routed automatically',
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
    // gateAwarenessSection: affirmative GATE PENDING/PASSED vocabulary and
    // local-check separation (not the older runtime-owned-path / tool-name
    // narration).
    expect(base2.systemPrompt).toContain('GATE: PENDING')
    expect(base2.systemPrompt).toContain('GATE: PASSED')
    expect(base2.systemPrompt).toContain('automated code-reviewer')
    expect(base2.systemPrompt).toContain('local checks')
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
      'Manual re-spawn of code-reviewer for the same pending set',
    )
    expect(base2.systemPrompt).toContain('Prefer dedicated harness tools')
    expect(base2.systemPrompt).toContain('Validation is dependency-neutral')
    expect(base2.systemPrompt).toContain(
      'Its absence from the root toolset is expected',
    )
    expect(base2.systemPrompt).toContain(
      'Do not delegate work merely to gain access to set_output',
    )
    // second specialistRoutingSection block in this test (there is a first
    // block under the parallel-join assertions above). Under default-on
    // disclosure these lines live in agents/guides/specialist-routing.md;
    // assert the guide pointer here and the verbatim text on the
    // explicit-off surface (base2DisclosureOff).
    expect(base2.systemPrompt).toContain(
      'agents/guides/specialist-routing.md',
    )
    expect(base2DisclosureOff.systemPrompt).toContain(
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
    // get_change_review_bundle and inspect_codebase_structure are audit-tier,
    // so both are absent from the CORE-only default surface.
    expect(base2.toolNames).not.toContain('get_change_review_bundle')
    expect(base2.toolNames).not.toContain('run_file_change_hooks')
    expect(base2.toolNames).not.toContain('inspect_codebase_structure')
    expect(base2.programmaticToolNames).toEqual(
      expect.arrayContaining([
        'git_status',
        'run_file_change_hooks',
        'inspect_codebase_structure',
      ]),
    )
    expect(base2.systemPrompt).toContain('Atomic edit recovery')
    expect(base2.systemPrompt).toContain('Edit contract')
    expect(base2.systemPrompt).toContain('recovery.paths')
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
    // create_plan/update_plan_status are implement-tier, so they are absent
    // from the CORE-only default (progressive) surface.
    expect(base2.toolNames).not.toContain('create_plan')
    expect(base2.toolNames).not.toContain('update_plan_status')

    const planBase2 = createBase2('default', { planOnly: true })
    expect(planBase2.toolNames).not.toContain('update_plan_status')

    // They become available only when the implement tier is unlocked.
    const implementSurface = resolveModelToolNames({
      mode: 'default',
      progressiveToolDisclosure: true,
      unlockedTiers: ['implement'],
    })
    expect(implementSurface).toContain('create_plan')
    expect(implementSurface).toContain('update_plan_status')
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
    // inspect_codebase_structure is audit-tier, so it is absent from the
    // CORE-only default plan surface.
    expect(planBase2.toolNames).not.toContain('inspect_codebase_structure')
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

  test('default mode defers the single completion summary until after the gate', () => {
    // The gate injects the post-gate finalization notice, so the pre-gate
    // prompts must not also demand a completion summary (which produced two
    // summaries per turn).
    const base2 = createBase2('default')

    expect(base2.instructionsPrompt).toContain(
      'Write exactly ONE user-visible completion summary per turn',
    )
    expect(base2.instructionsPrompt).not.toContain(
      'Inform the user that you have completed the task in one sentence',
    )
    expect(base2.instructionsPrompt).not.toContain(
      'until after you have written a user-visible completion summary',
    )
    expect(base2.stepPrompt).toContain(
      'Write your completion summary exactly once per turn',
    )
    expect(base2.stepPrompt).not.toContain(
      'After completing the user request, summarize your changes',
    )
  })

  test('fast mode keeps the original single-summary wording', () => {
    // Gate-disabled modes never get a post-gate finalization notice, so their
    // prompts must still ask for the summary directly.
    const base2 = createBase2('fast')

    expect(base2.instructionsPrompt).toContain(
      'Inform the user that you have completed the task in one sentence',
    )
    expect(base2.stepPrompt).toContain(
      'After completing the user request, summarize your changes',
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
      expect.arrayContaining(['read_outline', 'list_directory', 'glob']),
    )
    // edit_transaction is implement-tier, so it is absent from the CORE-only
    // default base-deep surface (unlocks only under the implement tier).
    expect(baseDeep.toolNames).not.toContain('edit_transaction')
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
      expect.arrayContaining([
        'spawn_agent_inline',
        'git_status',
        'run_file_change_hooks',
        'inspect_codebase_structure',
      ]),
    )
    // create_plan/update_plan_status are implement-tier and
    // get_change_review_bundle is audit-tier, so none appear in the CORE-only
    // default base-deep model surface.
    expect(baseDeep.toolNames).not.toContain('create_plan')
    expect(baseDeep.toolNames).not.toContain('update_plan_status')
    expect(baseDeep.toolNames).not.toContain('get_change_review_bundle')

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
    // Turn-start git_status is followed by the pushed list_jobs digest.
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({ toolName: 'list_jobs' })
    // spawn_agent_inline context-pruner before the first STEP.
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect(gen.next().value).toBe('STEP')
    // After the step produces a file change: git_status → list_jobs →
    // run_file_change_hooks.
    const afterStep = gen.next({
      stepsComplete: true,
      toolResult: [{ type: 'json', value: editReceipt('src/a.ts') }],
    } as any)
    expect(afterStep.value).toMatchObject({ toolName: 'git_status' })
    const afterGit = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any)
    expect(afterGit.value).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'run_file_change_hooks',
    })
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

  test('starts codebase-oriented Q&A prompts directly (no proactive query_index under M4)', () => {
    // M4 lean proactive inject: pure Q&A phrasing ("where is X configured")
    // carries no edit/audit/path phase keyword, so the proactive route is
    // skipped and the turn starts at git_status. The model reads and
    // answers the question directly instead of going through query_index.
    const base2 = createBase2('default')
    const generator = base2.handleSteps!({
      prompt: 'Where is authentication configured in this codebase?',
      params: {},
    } as any)

    expect(generator.next().value).toMatchObject({ toolName: 'git_status' })
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

  test('reuses the cached proactive retrieval result for an identical prompt at the same workspace revision', () => {
    const base2 = createBase2('default')
    const prompt = 'Refactor the authentication module code.'
    const agentState = {
      agentId: 'base2-classify',
      workspaceState: { revision: 7, snapshotId: 'snapshot-1' },
    }

    // First turn: cache miss -> live query_index, then the route note.
    const firstGen = base2.handleSteps!({
      agentState,
      prompt,
      params: {},
      config: base2.programmaticConfig,
    } as any)
    expect(firstGen.next().value).toMatchObject({ toolName: 'query_index' })
    const firstRouteNote = firstGen.next({
      toolResult: [{ type: 'json', value: [] }],
    } as any).value as any
    expect(firstRouteNote).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect(firstRouteNote.input.content).toContain('Proactive retrieval route')
    expect(firstRouteNote.input.content).not.toContain('cached')
    expect(firstGen.next().value).toMatchObject({ toolName: 'git_status' })

    // The live turn stored the opaque result in the per-session cache.
    expect((agentState as any).proactiveRetrievalCache).toMatchObject({
      workspaceRevision: 7,
    })
    expect(typeof (agentState as any).proactiveRetrievalCache.hash).toBe(
      'string',
    )

    // Second turn: same prompt + same revision -> cache hit. The generator
    // yields only the cached-result route note (no query_index), then moves
    // straight to git_status.
    const secondGen = base2.handleSteps!({
      agentState,
      prompt,
      params: {},
      config: base2.programmaticConfig,
    } as any)
    const cachedNote = secondGen.next().value as any
    expect(cachedNote).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect(cachedNote.input.content).toContain('cached result reused')
    expect(secondGen.next().value).toMatchObject({ toolName: 'git_status' })
  })

  test('re-runs query_index when the workspace revision changed', () => {
    const base2 = createBase2('default')
    const prompt = 'Refactor the authentication module code.'
    const agentState = {
      agentId: 'base2-classify',
      workspaceState: { revision: 3, snapshotId: 'snapshot-1' },
    }

    const firstGen = base2.handleSteps!({
      agentState,
      prompt,
      params: {},
      config: base2.programmaticConfig,
    } as any)
    expect(firstGen.next().value).toMatchObject({ toolName: 'query_index' })
    firstGen.next({ toolResult: [{ type: 'json', value: [] }] } as any)
    expect((agentState as any).proactiveRetrievalCache).toMatchObject({
      workspaceRevision: 3,
    })

    // Simulate advanceWorkspaceState bumping the revision between turns: the
    // stored entry no longer matches, so the live query_index runs again.
    ;(agentState as any).workspaceState = {
      revision: 4,
      snapshotId: 'snapshot-2',
    }
    const secondGen = base2.handleSteps!({
      agentState,
      prompt,
      params: {},
      config: base2.programmaticConfig,
    } as any)
    expect(secondGen.next().value).toMatchObject({ toolName: 'query_index' })
    secondGen.next({ toolResult: [{ type: 'json', value: [] }] } as any)
    expect((agentState as any).proactiveRetrievalCache).toMatchObject({
      workspaceRevision: 4,
    })
  })

  test('invalidates the cached proactive retrieval when messageHistory carries a newer indexMutationEpoch at the same workspace revision', () => {
    const base2 = createBase2('default')
    const prompt = 'Refactor the authentication module code.'
    const agentState = {
      agentId: 'base2-classify',
      workspaceState: { revision: 7, snapshotId: 'snapshot-1' },
    }

    // First turn: the live query_index reports indexMutationEpoch 1, which is
    // stored on the cache entry.
    const firstGen = base2.handleSteps!({
      agentState,
      prompt,
      params: {},
      config: base2.programmaticConfig,
    } as any)
    expect(firstGen.next().value).toMatchObject({ toolName: 'query_index' })
    firstGen.next({
      toolResult: [
        {
          type: 'json',
          value: {
            kind: 'query_index_result',
            results: [],
            indexMutationEpoch: 1,
          },
        },
      ],
    } as any)
    expect((agentState as any).proactiveRetrievalCache).toMatchObject({
      workspaceRevision: 7,
      indexMutationEpoch: 1,
    })

    // An external filesystem mutation (markPathsChanged) advanced the index
    // epoch WITHOUT bumping workspaceState.revision; the newer epoch is
    // observed on a prior query_index tool message in messageHistory.
    ;(agentState as any).messageHistory = [
      {
        role: 'tool',
        toolName: 'query_index',
        content: [
          {
            type: 'json',
            value: {
              kind: 'query_index_result',
              results: [],
              indexMutationEpoch: 2,
            },
          },
        ],
      },
    ]

    // Second turn: same prompt + same revision, but the newer epoch
    // invalidates the cache, so the live query_index runs again.
    const secondGen = base2.handleSteps!({
      agentState,
      prompt,
      params: {},
      config: base2.programmaticConfig,
    } as any)
    expect(secondGen.next().value).toMatchObject({ toolName: 'query_index' })
    expect((agentState as any).proactiveRetrievalCache).toBeUndefined()
    const secondRouteNote = secondGen.next({
      toolResult: [
        {
          type: 'json',
          value: {
            kind: 'query_index_result',
            results: [],
            indexMutationEpoch: 2,
          },
        },
      ],
    } as any).value as any
    expect(secondRouteNote).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect(secondRouteNote.input.content).toContain('Proactive retrieval route')
    expect(secondRouteNote.input.content).not.toContain('cached')
    expect((agentState as any).proactiveRetrievalCache).toMatchObject({
      workspaceRevision: 7,
      indexMutationEpoch: 2,
    })

    // Third turn: the messageHistory epoch now matches the cache entry, so the
    // cached route note is reused without a live query_index.
    const thirdGen = base2.handleSteps!({
      agentState,
      prompt,
      params: {},
      config: base2.programmaticConfig,
    } as any)
    const cachedNote = thirdGen.next().value as any
    expect(cachedNote).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect(cachedNote.input.content).toContain('cached result reused')
  })

  test('a different prompt at the same revision misses the cache', () => {
    const base2 = createBase2('default')
    const agentState = {
      agentId: 'base2-classify',
      workspaceState: { revision: 2, snapshotId: 'snapshot-1' },
    }

    const firstGen = base2.handleSteps!({
      agentState,
      prompt: 'Refactor the authentication module code.',
      params: {},
      config: base2.programmaticConfig,
    } as any)
    expect(firstGen.next().value).toMatchObject({ toolName: 'query_index' })
    firstGen.next({ toolResult: [{ type: 'json', value: [] }] } as any)
    expect((agentState as any).proactiveRetrievalCache).toBeDefined()

    // Same revision, but a different normalized query hashes differently.
    // (M4: the second prompt must still carry a strong intent phrase — an
    // audit verb like "verify" — so the proactive path fires at all.)
    const secondGen = base2.handleSteps!({
      agentState,
      prompt: 'Verify the repository structure before continuing',
      params: {},
      config: base2.programmaticConfig,
    } as any)
    expect(secondGen.next().value).toMatchObject({ toolName: 'query_index' })
  })

  test('generic words alone no longer trigger proactive retrieval', () => {
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

    // 'flow', 'index', and 'context' were removed from the code-intent
    // alternation, so a prompt whose only code-intent word is one of these
    // skips proactive retrieval and starts at git_status.
    expect(firstYield('tell me about the flow')).toMatchObject({
      toolName: 'git_status',
    })
    expect(firstYield('what is this context')).toMatchObject({
      toolName: 'git_status',
    })
    expect(firstYield('show me the index')).toMatchObject({
      toolName: 'git_status',
    })

    // Strong intent words still fire the proactive query_index.
    expect(
      firstYield('refactor the authentication module code'),
    ).toMatchObject({ toolName: 'query_index', input: { mode: 'search' } })
  })

  test('pure how/what question turns do not fire proactive retrieval (M4)', () => {
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

    // Pure Q&A prompts with no edit/audit/path phase keyword must not fire
    // proactive retrieval: they answer directly and only carry reading/
    // explanatory phrasing.
    expect(
      firstYield('How does the authentication module work in this codebase?'),
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      firstYield('What does this function do in the dependency layer?'),
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      firstYield('Explain the module loading order in this package'),
    ).toMatchObject({ toolName: 'git_status' })

    // Edit / fix / ritual verb prompts still fire on the unknown scope.
    expect(firstYield('Refactor the authentication module code')).toMatchObject(
      {
        toolName: 'query_index',
        input: { mode: 'search' },
      },
    )
  })

  test('command-discovery branch requires a literal command (M4)', () => {
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

    // A prompt that already names a literal command keeps the focused
    // commands branch (limit 12, commands mode).
    expect(
      firstYield('How do I run the bun test --watch script for this repo?'),
    ).toMatchObject({
      toolName: 'query_index',
      input: { mode: 'commands', limit: 12 },
    })

    // A bare command-ish verb phrase (no literal command token) must NOT
    // fire the focused commands branch. It still carries an audit/test verb,
    // so it falls through to the unknown-scoped search retrieval instead.
    expect(firstYield('run the tests and validate the fix')).toMatchObject({
      toolName: 'query_index',
      input: { mode: 'search', limit: 14 },
    })
    expect(firstYield('validate the schema before continuing')).toMatchObject({
      toolName: 'query_index',
      input: { mode: 'search', limit: 14 },
    })
  })

  test('proactive cache stores a compact query_index_result envelope (M4)', () => {
    const base2 = createBase2('default')
    const prompt = 'Refactor the authentication module code.'
    const agentState = {
      agentId: 'base2-classify',
      workspaceState: { revision: 5, snapshotId: 'snapshot-compact' },
    }

    const fatValue = {
      kind: 'query_index_result',
      status: 'ok',
      coverage: { matchedConcernCount: 4, totalConcernCount: 6, layers: [] },
      totalIndexed: 1287,
      snapshotId: 'snapshot-compact',
      indexMutationEpoch: 9,
      results: Array.from({ length: 12 }, (_, index) => ({
        path: `packages/sdk/src/module-${index}.ts`,
        score: 0.9 - index * 0.01,
        reason: `matched index ${index}`,
        kind: 'file',
        relatedFiles: [
          `packages/sdk/src/module-related-${index}-a.ts`,
          `packages/sdk/src/module-related-${index}-b.ts`,
        ],
        matchedSnippets: ['snippet-a', 'snippet-b'],
      })),
    }

    // First turn: live query_index, then the route note. Feed a fat
    // query_index_result; both the cached envelope and the injected route
    // note must carry the compact shape (no relatedFiles, capped results,
    // no status/coverage, indexMutationEpoch preserved for the epoch guard).
    const gen = base2.handleSteps!({
      agentState: agentState as any,
      prompt,
      params: {},
      config: base2.programmaticConfig,
    } as any)
    expect(gen.next().value).toMatchObject({ toolName: 'query_index' })
    const routeNote = gen.next({
      toolResult: [{ type: 'json', value: fatValue }],
    } as any).value as any
    expect(routeNote).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect(routeNote.input.content).toContain('Proactive retrieval route')
    expect(routeNote.input.content).not.toContain('cached')

    const cached = (agentState as any).proactiveRetrievalCache
    expect(cached).toMatchObject({ workspaceRevision: 5, indexMutationEpoch: 9 })

    // The cached result envelope is the compact form: a single json part whose
    // value drops relatedFiles/matchedSnippets/status/coverage, keeps at most
    // 8 results with only { path, score?, reason?, kind? } each, and preserves
    // kind + indexMutationEpoch + the scalar identifiers.
    expect(cached.result).toEqual({
      type: 'json',
      value: {
        kind: 'query_index_result',
        results: Array.from({ length: 8 }, (_, index) => ({
          path: `packages/sdk/src/module-${index}.ts`,
          score: 0.9 - index * 0.01,
          reason: `matched index ${index}`,
          kind: 'file',
        })),
        indexMutationEpoch: 9,
        totalIndexed: 1287,
        snapshotId: 'snapshot-compact',
      },
    })

    // The injected route note embeds the SAME compact form (not the fat
    // result): it appears verbatim, and the fat fields never surface.
    expect(routeNote.input.content).toContain(
      JSON.stringify(
        Array.from({ length: 8 }, (_, index) => ({
          path: `packages/sdk/src/module-${index}.ts`,
          score: 0.9 - index * 0.01,
          reason: `matched index ${index}`,
          kind: 'file',
        })),
      ),
    )
    expect(routeNote.input.content).not.toContain('relatedFiles')
    expect(routeNote.input.content).not.toContain('matchedSnippets')
    expect(routeNote.input.content).not.toContain('module-8')

    // The compact envelope still satisfies the epoch-guard: a newer epoch on a
    // prior query_index message invalidates, and a matching one reuses.
    ;(agentState as any).messageHistory = [
      {
        role: 'tool',
        toolName: 'query_index',
        content: [{ type: 'json', value: fatValue }],
      },
    ]
    const cachedGen = base2.handleSteps!({
      agentState: agentState as any,
      prompt,
      params: {},
      config: base2.programmaticConfig,
    } as any)
    const cachedNote = cachedGen.next().value as any
    expect(cachedNote).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect(cachedNote.input.content).toContain('cached result reused')
  })

  test('compact proactive envelope skips malformed early rows and still fills 8 usable paths (M4 RF-2)', () => {
    const base2 = createBase2('default')
    const prompt = 'Refactor the authentication module code.'
    const agentState = {
      agentId: 'base2-classify',
      workspaceState: { revision: 7, snapshotId: 'snapshot-malformed-cap' },
    }

    const malformedRows = [
      {},
      { path: '' },
      { score: 1 },
      { path: null },
      { path: undefined },
      { reason: 'no path' },
      { kind: 'file' },
      null,
    ]
    const validRows = Array.from({ length: 10 }, (_, index) => ({
      path: `packages/sdk/src/good-${index}.ts`,
      score: 0.95 - index * 0.01,
      reason: `matched good ${index}`,
      kind: 'file',
      relatedFiles: [
        `packages/sdk/src/good-related-${index}-a.ts`,
        `packages/sdk/src/good-related-${index}-b.ts`,
      ],
      matchedSnippets: ['snippet-a', 'snippet-b'],
    }))
    const fatValue = {
      kind: 'query_index_result',
      status: 'ok',
      coverage: { matchedConcernCount: 3, totalConcernCount: 5, layers: [] },
      totalIndexed: 2048,
      snapshotId: 'snapshot-malformed-cap',
      indexMutationEpoch: 11,
      results: [...malformedRows, ...validRows],
    }

    const gen = base2.handleSteps!({
      agentState: agentState as any,
      prompt,
      params: {},
      config: base2.programmaticConfig,
    } as any)
    expect(gen.next().value).toMatchObject({ toolName: 'query_index' })
    const routeNote = gen.next({
      toolResult: [{ type: 'json', value: fatValue }],
    } as any).value as any
    expect(routeNote).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect(routeNote.input.content).toContain('Proactive retrieval route')
    expect(routeNote.input.content).not.toContain('cached')

    const cached = (agentState as any).proactiveRetrievalCache
    expect(cached).toMatchObject({
      workspaceRevision: 7,
      indexMutationEpoch: 11,
    })

    // Malformed early rows are skipped; compact envelope fills the 8-path cap
    // from usable paths only (good-0..good-7), strips fat fields, keeps epoch.
    expect(cached.result).toEqual({
      type: 'json',
      value: {
        kind: 'query_index_result',
        results: Array.from({ length: 8 }, (_, index) => ({
          path: `packages/sdk/src/good-${index}.ts`,
          score: 0.95 - index * 0.01,
          reason: `matched good ${index}`,
          kind: 'file',
        })),
        indexMutationEpoch: 11,
        totalIndexed: 2048,
        snapshotId: 'snapshot-malformed-cap',
      },
    })

    expect(routeNote.input.content).toContain(
      JSON.stringify(
        Array.from({ length: 8 }, (_, index) => ({
          path: `packages/sdk/src/good-${index}.ts`,
          score: 0.95 - index * 0.01,
          reason: `matched good ${index}`,
          kind: 'file',
        })),
      ),
    )
    expect(routeNote.input.content).not.toContain('relatedFiles')
    expect(routeNote.input.content).not.toContain('matchedSnippets')
    expect(routeNote.input.content).not.toContain('good-8')
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'run_file_change_hooks',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
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
    expect(afterGit.value).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'run_file_change_hooks',
    })

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
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
      expect(gen.next().value).toBe('STEP')
      const afterStep = gen.next({
        stepsComplete: true,
        toolResult: [{ type: 'json', value: editReceipt(gateFile) }],
      } as any)
      expect(afterStep.value).toMatchObject({ toolName: 'git_status' })
      const afterGit = gen.next({
        toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
      } as any)
      expect(afterGit.value).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'run_file_change_hooks',
      })
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
      const doneJobs = gen.next({
        toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
      } as any)
      expect(doneJobs.value).toMatchObject({ toolName: 'list_jobs' })
      const done = gen.next(feedListJobs())
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
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(followupGen.next(feedListJobs()).value).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
      const followupStep = followupGen.next()
      expect(followupStep.value).toBe('STEP')
      expect(
        followupGen.next({ stepsComplete: true, toolResult: [] } as any).value,
      ).toMatchObject({ toolName: 'git_status' })
      const followupDoneJobs = followupGen.next({
        toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
      } as any)
      expect(followupDoneJobs.value).toMatchObject({ toolName: 'list_jobs' })
      const followupDone = followupGen.next(feedListJobs())
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
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
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
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
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
      const doneJobs = gen.next({
        toolResult: [{ type: 'json', value: { status: ` M ${tmpFile}` } }],
      } as any)
      expect(doneJobs.value).toMatchObject({ toolName: 'list_jobs' })
      const done = gen.next(feedListJobs())

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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'run_file_change_hooks',
    })
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
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
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
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'run_file_change_hooks',
      })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    const maybePinnedState = gen.next().value
    if (maybePinnedState !== 'STEP') {
      expect(maybePinnedState).toMatchObject({ toolName: 'add_message' })
      expect(gen.next().value).toBe('STEP')
    }
    expect(
      gen.next({ stepsComplete: true, toolResult: [] } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const nextJobs = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any)
    expect(nextJobs.value).toMatchObject({ toolName: 'list_jobs' })
    const next = gen.next(feedListJobs())

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
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
      const maybePinnedState = gen.next().value
      if (maybePinnedState !== 'STEP') {
        expect(maybePinnedState).toMatchObject({ toolName: 'add_message' })
        expect(gen.next().value).toBe('STEP')
      }
      expect(
        gen.next({ stepsComplete: true, toolResult: [], agentState } as any)
          .value,
      ).toMatchObject({ toolName: 'git_status' })
      const reusedJobs = gen.next({
        toolResult: [
          {
            type: 'json',
            value: { status: ` M ${fileA}\n M ${fileB}` },
          },
        ],
      } as any)
      expect(reusedJobs.value).toMatchObject({ toolName: 'list_jobs' })
      const reused = gen.next(feedListJobs())

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
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
      const maybePinnedState = gen.next().value
      if (maybePinnedState !== 'STEP') {
        expect(maybePinnedState).toMatchObject({ toolName: 'add_message' })
        expect(gen.next().value).toBe('STEP')
      }
      expect(
        gen.next({ stepsComplete: true, toolResult: [], agentState } as any)
          .value,
      ).toMatchObject({ toolName: 'git_status' })
      const nextJobs = gen.next({
        toolResult: [{ type: 'json', value: { status: ` M ${tmpFile}` } }],
      } as any)
      expect(nextJobs.value).toMatchObject({ toolName: 'list_jobs' })
      const next = gen.next(feedListJobs())

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
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
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
      const reusedJobs = gen.next({
        toolResult: [{ type: 'json', value: { status: '' } }],
      } as any)
      expect(reusedJobs.value).toMatchObject({ toolName: 'list_jobs' })
      const reused = gen.next(feedListJobs())
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    const maybePinnedState = gen.next().value
    if (maybePinnedState !== 'STEP') {
      expect(maybePinnedState).toMatchObject({ toolName: 'add_message' })
      expect(gen.next().value).toBe('STEP')
    }
    expect(
      gen.next({ stepsComplete: true, toolResult: [], agentState } as any)
        .value,
    ).toMatchObject({ toolName: 'git_status' })
    const nextJobs = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any)
    expect(nextJobs.value).toMatchObject({ toolName: 'list_jobs' })
    const next = gen.next(feedListJobs())

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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
      const maybePinnedState = gen.next().value
      if (maybePinnedState !== 'STEP') {
        expect(maybePinnedState).toMatchObject({ toolName: 'add_message' })
        expect(gen.next().value).toBe('STEP')
      }

      // Only the never-validated agent-touched dirty reviewable file B is
      // published; the gate-passed file A and the untouched file C are excluded.
      expect((agentState as any).uncommittedUnvalidatedFiles).toEqual(['src/b.ts'])
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('P3: non-reviewable dirty task files are not published in uncommittedUnvalidatedFiles', () => {
    // Session/plan/docs artifacts must not block git-committer via the
    // unvalidated list; only reviewable dirty B is published.
    const base2 = createBase2('default')
    const tmpDir = makeProjectTempDir('base2-p3-nonreviewable-')
    try {
      const tmpFile = join(tmpDir, 'a.ts')
      const gateFile = normalizeGateFilePath(tmpFile)
      writeFileSync(tmpFile, 'export const value = 1\n')
      const agentState: Record<string, unknown> = {
        agentId: 'base2',
        base2ActiveWork: {
          changedFiles: [
            gateFile,
            'src/b.ts',
            'notes.md',
            '.agents/sessions/x/STATE.json',
          ],
          touchedFiles: [
            gateFile,
            'src/b.ts',
            'notes.md',
            '.agents/sessions/x/STATE.json',
          ],
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
          toolResult: [
            {
              type: 'json',
              value: {
                status: ` M ${gateFile}\n M src/b.ts\n M notes.md\n M .agents/sessions/x/STATE.json`,
              },
            },
          ],
        } as any).value,
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
      const maybePinnedState = gen.next().value
      if (maybePinnedState !== 'STEP') {
        expect(maybePinnedState).toMatchObject({ toolName: 'add_message' })
        const pinText = (maybePinnedState as any).input.content as string
        expect(pinText).toMatch(/non-reviewable dirty/i)
        expect(gen.next().value).toBe('STEP')
      }

      expect((agentState as any).uncommittedUnvalidatedFiles).toEqual([
        'src/b.ts',
      ])
      expect((agentState as any).uncommittedUnvalidatedFiles).not.toContain(
        'notes.md',
      )
      expect((agentState as any).uncommittedUnvalidatedFiles).not.toContain(
        '.agents/sessions/x/STATE.json',
      )
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('P0: unreviewed dirty reviewable task files re-arm a durable pass at turn start', () => {
    // Durable pass covers only A; touched/changed include A+B; turn-start dirty
    // on A+B without new edits this turn must reopen the gate for B.
    const base2 = createBase2('default')
    const tmpDir = makeProjectTempDir('base2-p0-rearm-')
    try {
      const fileA = join(tmpDir, 'a.ts')
      const gateFileA = normalizeGateFilePath(fileA)
      writeFileSync(fileA, 'export const a = 1\n')
      const validationSummary = 'No configured file-change hooks ran.'
      const fingerprint = buildFingerprint(
        [
          {
            file: gateFileA,
            contentMarker: buildContentMarker(fileA),
          },
        ],
        validationSummary,
      )
      const agentState = {
        agentId: 'base2-custom',
        base2ActiveWork: {
          changedFiles: [gateFileA, 'src/b.ts'],
          touchedFiles: [gateFileA, 'src/b.ts'],
          pendingGateFiles: [],
          currentPhase: 'final_response_allowed',
          latestWorkSummary: '',
          openReviewerBlockers: [],
          lastValidationSummary: validationSummary,
          nextRequiredAction: '',
          lastPinnedStateMessage: '',
          gatePassedFiles: [gateFileA],
          gatePassedPendingFiles: [gateFileA],
          gatePassedReviewerVerdict: 'LOOKS_GOOD',
          gatePassedValidationSummary: validationSummary,
          gatePassedFingerprint: fingerprint,
          gatePassedFileMarkers: {
            [gateFileA]: buildContentMarker(fileA),
          },
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
              value: { status: ` M ${fileA}\n M src/b.ts` },
            },
          ],
        } as any).value,
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
      const pinned = gen.next()
      expect(pinned.value).toMatchObject({
        toolName: 'add_message',
        input: { role: 'user' },
      })
      const pinText = (pinned.value as any).input.content as string
      expect(pinText).toMatch(/unreviewed dirty reviewable|dirty reviewable/i)
      expect(gen.next().value).toBe('STEP')

      expect((agentState as any).base2ActiveWork.currentPhase).toBe(
        'awaiting_validation',
      )
      expect((agentState as any).base2ActiveWork.pendingGateFiles).toEqual(
        expect.arrayContaining(['src/b.ts']),
      )
      expect((agentState as any).canSuggestFollowups).toBe(false)
      expect(
        (agentState as any).base2ActiveWork.latestWorkSummary,
      ).toMatch(/Unreviewed dirty reviewable files reopened the gate/)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('P0 negative: concurrent dirty non-task file does not re-arm a durable pass', () => {
    // Dirty only untouched concurrent C + durable A must not re-arm solely for C.
    const base2 = createBase2('default')
    const tmpDir = makeProjectTempDir('base2-p0-negative-')
    try {
      const fileA = join(tmpDir, 'a.ts')
      const gateFileA = normalizeGateFilePath(fileA)
      writeFileSync(fileA, 'export const a = 1\n')
      const validationSummary = 'No configured file-change hooks ran.'
      const fingerprint = buildFingerprint(
        [{ file: gateFileA, contentMarker: buildContentMarker(fileA) }],
        validationSummary,
      )
      const agentState = {
        agentId: 'base2-custom',
        base2ActiveWork: {
          changedFiles: [gateFileA],
          touchedFiles: [gateFileA],
          pendingGateFiles: [],
          currentPhase: 'final_response_allowed',
          latestWorkSummary: '',
          openReviewerBlockers: [],
          lastValidationSummary: validationSummary,
          nextRequiredAction: '',
          lastPinnedStateMessage: '',
          gatePassedFiles: [gateFileA],
          gatePassedPendingFiles: [gateFileA],
          gatePassedReviewerVerdict: 'LOOKS_GOOD',
          gatePassedValidationSummary: validationSummary,
          gatePassedFingerprint: fingerprint,
          gatePassedFileMarkers: {
            [gateFileA]: buildContentMarker(fileA),
          },
        },
      }
      const gen = base2.handleSteps!({
        agentState,
        prompt: 'Can you confirm whether those earlier reports still hold',
        params: {},
      } as any)

      expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
      // Dirty concurrent C only (A is gate-passed and may also appear dirty).
      expect(
        gen.next({
          toolResult: [
            {
              type: 'json',
              value: { status: ` M ${fileA}\n M src/c.ts` },
            },
          ],
        } as any).value,
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
      const maybePinned = gen.next().value
      if (maybePinned !== 'STEP') {
        expect(maybePinned).toMatchObject({ toolName: 'add_message' })
        expect(gen.next().value).toBe('STEP')
      }

      expect((agentState as any).base2ActiveWork.currentPhase).toBe(
        'final_response_allowed',
      )
      expect((agentState as any).base2ActiveWork.pendingGateFiles).toEqual([])
      expect((agentState as any).canSuggestFollowups).toBe(true)
      expect((agentState as any).uncommittedUnvalidatedFiles).toEqual([])
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('credited dirty task file does not re-expand gate scope after LOOKS_GOOD', () => {
    // Regression: after a green pass, file A may stay dirty+gatePassed while
    // finalization is open. deriveGateScopeFiles must exclude A so durable
    // reuse / conversation reuse is not broken by gateScopeFiles widening
    // beyond pendingGateFiles, and the reviewer is not re-spawned solely for A.
    const base2 = createBase2('default')
    const tmpDir = makeProjectTempDir('base2-credited-dirty-scope-')
    try {
      const fileA = join(tmpDir, 'a.ts')
      const gateFileA = normalizeGateFilePath(fileA)
      writeFileSync(fileA, 'export const a = 1\n')
      const validationSummary = 'No configured file-change hooks ran.'
      const fingerprint = buildFingerprint(
        [{ file: gateFileA, contentMarker: buildContentMarker(fileA) }],
        validationSummary,
      )
      const agentState = {
        agentId: 'base2-custom',
        base2ActiveWork: {
          changedFiles: [gateFileA],
          touchedFiles: [gateFileA],
          pendingGateFiles: [],
          currentPhase: 'final_response_allowed',
          latestWorkSummary: '',
          openReviewerBlockers: [],
          lastValidationSummary: validationSummary,
          nextRequiredAction: '',
          lastPinnedStateMessage: '',
          gatePassedFiles: [gateFileA],
          gatePassedPendingFiles: [gateFileA],
          gatePassedReviewerVerdict: 'LOOKS_GOOD',
          gatePassedValidationSummary: validationSummary,
          gatePassedFingerprint: fingerprint,
          gatePassedFileMarkers: {
            [gateFileA]: buildContentMarker(fileA),
          },
        },
      }
      const gen = base2.handleSteps!({
        agentState,
        prompt: 'Finish the previous response.',
        params: {},
      } as any)

      expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
      // A is still dirty but already credited; no unreviewed dirty B.
      expect(
        gen.next({
          toolResult: [
            {
              type: 'json',
              value: { status: ` M ${fileA}` },
            },
          ],
        } as any).value,
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
      const maybePinned = gen.next().value
      if (maybePinned !== 'STEP') {
        expect(maybePinned).toMatchObject({ toolName: 'add_message' })
        expect(gen.next().value).toBe('STEP')
      }

      // Finalization stays open; credited dirty A must not re-arm the gate.
      expect((agentState as any).base2ActiveWork.currentPhase).toBe(
        'final_response_allowed',
      )
      expect((agentState as any).base2ActiveWork.pendingGateFiles).toEqual([])
      expect((agentState as any).base2ActiveWork.gatePassedFiles).toEqual([
        gateFileA,
      ])
      expect((agentState as any).canSuggestFollowups).toBe(true)

      // Complete the step with no new edits: must not spawn reviewer solely for
      // credited dirty A (no run_file_change_hooks / spawn_agents reviewer).
      const afterStep = gen.next({
        stepsComplete: true,
        toolResult: [],
      } as any)
      expect(afterStep.value).toMatchObject({ toolName: 'git_status' })
      const afterGit = gen.next({
        toolResult: [
          {
            type: 'json',
            value: { status: ` M ${fileA}` },
          },
        ],
      } as any)
      expect(afterGit.value).toMatchObject({ toolName: 'list_jobs' })
      const done = gen.next(feedListJobs())
      // Generator finishes or continues without re-running validation/reviewer
      // for already-credited dirty A alone.
      if (!done.done) {
        const nextTool = (done.value as any)?.toolName
        expect(nextTool).not.toBe('run_file_change_hooks')
        if (nextTool === 'spawn_agents') {
          const agents = (done.value as any)?.input?.agents ?? []
          expect(
            agents.some(
              (a: { agent_type?: string }) => a.agent_type === 'code-reviewer',
            ),
          ).toBe(false)
        }
      }
      expect((agentState as any).base2ActiveWork.currentPhase).toBe(
        'final_response_allowed',
      )
      expect((agentState as any).base2ActiveWork.pendingGateFiles).toEqual([])
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('P1: agentReceipt changedFiles enter pendingGateFiles without file_mutation_result', () => {
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(gen.next().value).toBe('STEP')
    const agentReceipt = {
      schemaVersion: 1,
      receiptId: 'editor-batch-receipt',
      status: 'completed',
      changedFiles: [{ path: 'src/one.ts' }, { path: 'src/two.ts' }],
      findingsAddressed: [],
      requestedValidation: [],
    }
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [
          {
            type: 'json',
            value: {
              agentId: 'editor-1',
              agentName: 'Editor',
              agentType: 'editor',
              value: {},
              agentReceipt,
            },
          },
        ],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect((agentState as any).base2ActiveWork.pendingGateFiles).toEqual(
      expect.arrayContaining(['src/one.ts', 'src/two.ts']),
    )
    expect((agentState as any).base2ActiveWork.currentPhase).toBe(
      'awaiting_validation',
    )
  })

  test('historical changed files alone do not trigger stale validation or review', () => {
    // Concurrent dirty outside the task ledger must not re-arm; historical
    // changedFiles alone with non-task dirty finalize as no edits. Task-related
    // dirty reviewable paths are covered by the P0 tests.
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
        toolResult: [{ type: 'json', value: { status: ' M src/other.ts' } }],
      } as any).value,
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({ stepsComplete: true, toolResult: [] } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const finalGateJobs = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/other.ts' } }],
    } as any)
    expect(finalGateJobs.value).toMatchObject({ toolName: 'list_jobs' })
    const finalGate = gen.next(feedListJobs())
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
    const doneJobs = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/other.ts' } }],
    } as any)
    expect(doneJobs.value).toMatchObject({ toolName: 'list_jobs' })
    const done = gen.next(feedListJobs())
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    expect(afterGit.value).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    const finalGateJobs = gen.next({
      toolResult: [{ type: 'json', value: { status: '' } }],
    } as any)
    expect(finalGateJobs.value).toMatchObject({ toolName: 'list_jobs' })
    const finalGate = gen.next(feedListJobs())
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
    const doneJobs = gen.next({
      toolResult: [{ type: 'json', value: { status: '' } }],
    } as any)
    expect(doneJobs.value).toMatchObject({ toolName: 'list_jobs' })
    const done = gen.next(feedListJobs())

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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    const afterGitJobs = gen.next({
      toolResult: [{ type: 'json', value: { status: '' } }],
    } as any)
    expect(afterGitJobs.value).toMatchObject({ toolName: 'list_jobs' })
    const afterGit = gen.next(feedListJobs())

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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    const afterGitJobs = gen.next({
      toolResult: [{ type: 'json', value: { status: '' } }],
    } as any)
    expect(afterGitJobs.value).toMatchObject({ toolName: 'list_jobs' })
    const afterGit = gen.next(feedListJobs())

    expect(afterGit.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect((afterGit.value as any).input.content).toContain(
      'No edited files were detected.',
    )
  })

  test('direct edit tool calls in message history trigger gates when git status was already dirty', () => {
    // Use a real on-disk file so creditGatePassedFiles can store an attestable
    // content marker. A virtual path cannot be credited; P0 would re-arm on the
    // next loop and the generator would not finish.
    const base2 = createBase2('default')
    const tmpDir = makeProjectTempDir('base2-direct-edit-dirty-')
    try {
      const dirtyFile = join(tmpDir, 'already-dirty.ts')
      const gateFile = normalizeGateFilePath(dirtyFile)
      writeFileSync(dirtyFile, 'export const before = 1\n')
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
            { type: 'json', value: { status: ` M ${gateFile}` } },
          ],
        } as any).value,
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
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
                path: gateFile,
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
                file: gateFile,
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
        toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
      } as any)

      expect(afterGit.value).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
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
      expect(reviewCall).toMatchObject({
        toolName: 'spawn_agents',
        input: { agents: [{ agent_type: 'code-reviewer' }] },
      })
      const finalPreCreditStatus = gen.next(
        attestedReviewerResult(reviewCall) as any,
      )
      expect(finalPreCreditStatus.value).toMatchObject({
        toolName: 'git_status',
      })
      const gatePassed = gen.next({
        toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
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
              value: { status: ` M ${gateFile}`, diff: 'diff' },
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
      const doneJobs = gen.next({
        toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
      } as any)
      expect(doneJobs.value).toMatchObject({ toolName: 'list_jobs' })
      const done = gen.next(feedListJobs())
      expect(done.done).toBe(true)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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

    expect(afterGit.value).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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

    expect(afterGit.value).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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

    expect(afterGit.value).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    const finalGateJobs = gen.next({
      toolResult: [{ type: 'json', value: { status: '' } }],
    } as any)
    expect(finalGateJobs.value).toMatchObject({ toolName: 'list_jobs' })
    const finalGate = gen.next(feedListJobs())
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
    const doneJobs = gen.next({
      toolResult: [{ type: 'json', value: { status: '' } }],
    } as any)
    expect(doneJobs.value).toMatchObject({ toolName: 'list_jobs' })
    const done = gen.next(feedListJobs())

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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [{ type: 'json', value: editReceipt('src/a.ts') }],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const skipJobs = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any)
    expect(skipJobs.value).toMatchObject({ toolName: 'list_jobs' })
    const skipDiagnostic = gen.next(feedListJobs())

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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [{ type: 'json', value: editReceipt('src/a.ts') }],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const skipJobs = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any)
    expect(skipJobs.value).toMatchObject({ toolName: 'list_jobs' })
    const skipDiagnostic = gen.next(feedListJobs())

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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    const blockedJobs = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any)
    expect(blockedJobs.value).toMatchObject({ toolName: 'list_jobs' })
    const blocked = gen.next(feedListJobs())

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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    expect(afterGit.value).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
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

  test('pinned gate-status line reports hooks summary present=yes when lastValidationSummary is set', () => {
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    const pinned = gen.next()
    expect(pinned.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    const text = (pinned.value as any).input.content as string
    // Affirmative GATE: PENDING block: emitted right after the Current phase line.
    expect(text).toContain('GATE: PENDING')
    expect(text).toContain('phase: awaiting_validation')
    expect(text).toContain('hooks summary present: yes')
    expect(text).toContain('local checks (basher/typecheck) are not the gate')
  })

  test('pinned gate-status line reports hooks summary present=no when lastValidationSummary is empty', () => {
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    const pinned = gen.next()
    expect(pinned.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    const text = (pinned.value as any).input.content as string
    expect(text).toContain('GATE: PENDING')
    expect(text).toContain('phase: awaiting_validation')
    expect(text).toContain('hooks summary present: no')
    expect(text).toContain('local checks (basher/typecheck) are not the gate')
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    const pinned = gen.next()
    expect(pinned.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    const text = (pinned.value as any).input.content as string
    // Sanity: unresolved gate work is present so the pinned message is emitted.
    expect(text).toContain('GATE: PENDING')
    expect(text).toContain('phase: awaiting_validation')
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

  // Uses a real project-scoped scratch file whose bytes genuinely change
  // across the simulated repair. The live reviewer-repair no-progress guard
  // compares the pre- and post-repair gate snapshot fingerprints, both derived
  // from on-disk bytes of the pending gate files, so a synthetic path would
  // hash to the same unreadable sentinel twice and block the repair round.
  test('reviewer feedback is pinned as active work before the next step', () => {
    const tmpDir = makeProjectTempDir('base2-reviewer-pinned-')
    try {
      const tmpFile = join(tmpDir, 'a.ts')
      const gateFile = normalizeGateFilePath(tmpFile)
      writeFileSync(tmpFile, 'export const value = 1\n')
      const base2 = createBase2('default')
      const agentState = { agentId: 'base2' }
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
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
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
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'run_file_change_hooks',
      })
      const postValidationStatus = gen.next({
        toolResult: [{ type: 'json', value: [] }],
      } as any).value
      expect(postValidationStatus).toMatchObject({ toolName: 'git_status' })
      const reviewCall = gen.next({
        toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
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
        changedFiles: [gateFile],
        touchedFiles: [gateFile],
        pendingGateFiles: [gateFile],
        openReviewerBlockers: ['BLOCKING: Fix the edge case.'],
        lastValidationSummary: 'No configured file-change hooks ran.',
        nextRequiredAction:
          'Resolve the reviewer feedback below before any unrelated work, final response, or another review.',
      })

      // This yield is where the runtime captures the pre-repair snapshot
      // fingerprint, so the repair's byte change must land after it.
      expect(gen.next().value).toMatchObject({
        toolName: 'spawn_agents',
        input: { agents: [{ agent_type: 'repair-editor' }] },
      })
      const findingIds = (
        agentState as any
      ).base2ActiveWork.openReviewerFindings.map((finding: any) => finding.id)
      writeFileSync(tmpFile, 'export const value = 2 // repaired\n')
      expect(
        gen.next(completedRepairReceipt(findingIds, [gateFile]) as any).value,
      ).toMatchObject({
        toolName: 'git_status',
      })
      expect(
        gen.next({
          toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
        } as any).value,
      ).toMatchObject({ toolName: 'run_file_change_hooks' })
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
      expect(text).toContain(
        `Pending validation/reviewer gate files: ${gateFile}`,
      )
      // The inline-validation flow emits a real summary of the hooks that just
      // ran (here a passing typecheck), not the legacy 'No configured hooks'
      // placeholder. Assert the stable marker rather than the exact hook text.
      expect(text).toContain('Last validation summary:')
      expect(text).not.toContain(`Historical changed files: ${gateFile}`)
      expect(text).not.toContain(`Historical touched files: ${gateFile}`)
      expect(gen.next().value).toBe('STEP')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'run_file_change_hooks',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'run_file_change_hooks',
    })
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
    const tmpDir = makeProjectTempDir('base2-repair-progress-')
    try {
      const tmpFile = join(tmpDir, 'a.ts')
      const gateFile = normalizeGateFilePath(tmpFile)
      writeFileSync(tmpFile, 'export const value = 1\n')
      const base2 = createBase2('default')
      const agentState = { agentId: 'base2' }
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
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
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
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'run_file_change_hooks',
      })
      const postValidationStatus = gen.next({
        toolResult: [{ type: 'json', value: [] }],
      } as any).value
      expect(postValidationStatus).toMatchObject({ toolName: 'git_status' })
      const reviewCall = gen.next({
        toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
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
      // The scratch file's bytes really change so the no-progress guard stays
      // quiet and the mutation-progress path is what's under test here.
      writeFileSync(tmpFile, 'export const value = 2 // partial repair\n')
      expect(
        gen.next(progressOnlyRepairReceipt([gateFile]) as any).value,
      ).toMatchObject({
        toolName: 'git_status',
      })
      expect(
        gen.next({
          toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
        } as any).value,
      ).toMatchObject({ toolName: 'run_file_change_hooks' })
      expect((agentState as any).base2ActiveWork.currentPhase).not.toBe(
        'blocked',
      )
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
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // Counterpart of the two tests above: a repair that reports success but
  // leaves every pending gate file byte-identical must fail closed instead of
  // re-entering validation and re-review forever.
  test('reviewer repair that changes no bytes trips the no-progress guard', () => {
    const tmpDir = makeProjectTempDir('base2-repair-no-progress-')
    try {
      const tmpFile = join(tmpDir, 'a.ts')
      const gateFile = normalizeGateFilePath(tmpFile)
      writeFileSync(tmpFile, 'export const value = 1\n')
      const base2 = createBase2('default')
      const agentState = { agentId: 'base2' }
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
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
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
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'run_file_change_hooks',
      })
      const postValidationStatus = gen.next({
        toolResult: [{ type: 'json', value: [] }],
      } as any).value
      expect(postValidationStatus).toMatchObject({ toolName: 'git_status' })
      const reviewCall = gen.next({
        toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
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
      // No writeFileSync here: the repair claims completion for every open
      // finding but the scratch file's bytes are untouched.
      expect(
        gen.next(completedRepairReceipt(findingIds, [gateFile]) as any).value,
      ).toMatchObject({
        toolName: 'git_status',
      })
      const afterGuard = gen.next({
        toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
      } as any)
      // The guard breaks out of the gate loop, so re-validation must not run.
      expect((afterGuard.value as any)?.toolName).not.toBe(
        'run_file_change_hooks',
      )
      const activeWork = (agentState as any).base2ActiveWork
      expect(activeWork.currentPhase).toBe('blocked')
      expect(activeWork.lastReviewerGateSkipReason).toBe(
        'reviewer-repair-no-progress',
      )
      expect(activeWork.nextRequiredAction).toContain(
        'no snapshot-visible progress',
      )
      expect((agentState as any).canSuggestFollowups).toBe(false)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'run_file_change_hooks',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'run_file_change_hooks',
    })
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
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
      const maybePinnedState = gen.next().value
      if (maybePinnedState !== 'STEP') {
        expect(maybePinnedState).toMatchObject({ toolName: 'add_message' })
        expect(gen.next().value).toBe('STEP')
      }
      expect(
        gen.next({ stepsComplete: true, toolResult: [] } as any).value,
      ).toMatchObject({ toolName: 'git_status' })
      const nextJobs = gen.next({
        toolResult: [{ type: 'json', value: { status: statusLine } }],
      } as any)
      expect(nextJobs.value).toMatchObject({ toolName: 'list_jobs' })
      const next = gen.next(feedListJobs())

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
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
      const maybePinnedState = gen.next().value
      if (maybePinnedState !== 'STEP') {
        expect(maybePinnedState).toMatchObject({ toolName: 'add_message' })
        expect(gen.next().value).toBe('STEP')
      }
      expect(
        gen.next({ stepsComplete: true, toolResult: [] } as any).value,
      ).toMatchObject({ toolName: 'git_status' })
      const gatePassedJobs = gen.next({
        toolResult: [{ type: 'json', value: { status: statusLine } }],
      } as any)
      expect(gatePassedJobs.value).toMatchObject({ toolName: 'list_jobs' })
      const gatePassed = gen.next(feedListJobs())

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
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
      const maybePinnedState = gen.next().value
      if (maybePinnedState !== 'STEP') {
        expect(maybePinnedState).toMatchObject({ toolName: 'add_message' })
        expect(gen.next().value).toBe('STEP')
      }
      expect(
        gen.next({ stepsComplete: true, toolResult: [] } as any).value,
      ).toMatchObject({ toolName: 'git_status' })
      const nextJobs = gen.next({
        toolResult: [{ type: 'json', value: { status: statusLine } }],
      } as any)
      expect(nextJobs.value).toMatchObject({ toolName: 'list_jobs' })
      const next = gen.next(feedListJobs())

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
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
      const maybePinnedState = gen.next().value
      if (maybePinnedState !== 'STEP') {
        expect(maybePinnedState).toMatchObject({ toolName: 'add_message' })
        expect(gen.next().value).toBe('STEP')
      }
      expect(
        gen.next({ stepsComplete: true, toolResult: [] } as any).value,
      ).toMatchObject({ toolName: 'git_status' })
      const nextJobs = gen.next({
        toolResult: [{ type: 'json', value: { status: statusLine } }],
      } as any)
      expect(nextJobs.value).toMatchObject({ toolName: 'list_jobs' })
      const next = gen.next(feedListJobs())

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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    const securityReviewJobs = gen.next({
      toolResult: [
        {
          type: 'json',
          value: { status: ' M sdk/src/policy/terminal-command-policy.ts' },
        },
      ],
    } as any)
    expect(securityReviewJobs.value).toMatchObject({ toolName: 'list_jobs' })
    const securityReview = gen.next(feedListJobs())
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    const securityReviewJobs = gen.next({
      toolResult: [
        {
          type: 'json',
          value: { status: ' M sdk/src/policy/terminal-command-policy.ts' },
        },
      ],
    } as any)
    expect(securityReviewJobs.value).toMatchObject({ toolName: 'list_jobs' })
    const securityReview = gen.next(feedListJobs())
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
    const revalidationReviewJobs = gen.next({
      toolResult: [
        {
          type: 'json',
          value: { status: ' M sdk/src/policy/terminal-command-policy.ts' },
        },
      ],
    } as any)
    expect(revalidationReviewJobs.value).toMatchObject({ toolName: 'list_jobs' })
    const revalidationReview = gen.next(feedListJobs())
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'run_file_change_hooks',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    const securityReviewJobs = gen.next({
      toolResult: [
        {
          type: 'json',
          value: { status: ' M sdk/src/policy/terminal-command-policy.ts' },
        },
      ],
    } as any)
    expect(securityReviewJobs.value).toMatchObject({ toolName: 'list_jobs' })
    const securityReview = gen.next(feedListJobs())
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'run_file_change_hooks',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'run_file_change_hooks',
    })
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
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
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
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'run_file_change_hooks',
      })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'run_file_change_hooks',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'run_file_change_hooks',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'run_file_change_hooks',
    })
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
    // The reviewer is instructed to read large files via bounded read_files
    // windows (not whole-file reads) so its accumulated read context stays
    // bounded, while still attesting to every pending file.
    expect(reviewPrompt).toContain(
      'Read large files via read_files windows (bounded block reads)',
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'inspect_environment',
    })
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

  test('structured NON_BLOCKING reviewer JSON output does not finalize and enters repair', () => {
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'run_file_change_hooks',
    })
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
    const afterReview = gen.next({
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

    expect(afterReview.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect((afterReview.value as any).input.content).toContain(
      'NON_BLOCKING: [code-reviewer:correctness:minor-style] Minor style suggestion.',
    )
    expect((afterReview.value as any).input.content).toContain('repair-editor')
    expect((agentState as any).base2ActiveWork).toMatchObject({
      openReviewerBlockers: [
        'NON_BLOCKING: [code-reviewer:correctness:minor-style] Minor style suggestion.',
      ],
      pendingGateFiles: ['src/a.ts'],
    })
    expect((agentState as any).base2ActiveWork.currentPhase).not.toBe(
      'final_response_allowed',
    )
    expect((agentState as any).base2ActiveWork.gatePassedReviewerVerdict).not.toBe(
      'NON_BLOCKING',
    )
    const repairSpawn = gen.next().value as any
    expect(repairSpawn).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'repair-editor' }] },
    })
  })

  // Drives the base2 handleSteps generator through one full reviewer cycle:
  // edit -> validation -> code-reviewer -> (first) reviewer result. Returns the
  // generator plus the reviewer spawn call so tests can feed follow-up results.
  // Uses a real project-scoped scratch file whose bytes genuinely change across
  // the simulated repair: the reviewer-repair no-progress guard compares the
  // pre- and post-repair gate snapshot fingerprints, both derived from on-disk
  // bytes of the pending gate files (a virtual path hashes to the same
  // unreadable sentinel twice and the guard would fire).
  function driveToFirstReview() {
    const tmpDir = makeProjectTempDir('base2-condoned-review-')
    const tmpFile = join(tmpDir, 'a.ts')
    const gateFile = normalizeGateFilePath(tmpFile)
    writeFileSync(tmpFile, 'export const value = 1\n')
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'run_file_change_hooks',
    })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: [] }] } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const reviewCall = gen.next({
      toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
    } as any).value as any
    expect(reviewCall).toMatchObject({ toolName: 'spawn_agents' })
    return { gen, agentState, reviewCall, tmpDir, tmpFile, gateFile }
  }

  // Feeds the first NON_BLOCKING reviewer result and the repair-editor
  // completion receipt, landing on the second (re-review) spawn_agents call.
  // Mirrors the yield sequence of the BLOCKING repair/re-review test above:
  // after the repair receipt the generator yields git_status ->
  // run_file_change_hooks -> spawn_agent_inline (the re-review code-reviewer)
  // -> add_message (pinned active-work, phase awaiting_review) -> STEP, then
  // the next loop iteration drives git_status -> list_jobs ->
  // run_file_change_hooks -> git_status -> spawn_agents (the second review).
  function driveThroughRepairToSecondReview(
    gen: any,
    agentState: any,
    reviewCall: any,
    tmpFile: string,
    gateFile: string,
    findingSummary: string,
  ) {
    const firstReview = attestedReviewerResult(reviewCall, 'NON_BLOCKING', [
      findingSummary,
    ])
    const afterFirst = gen.next(firstReview as any)
    expect(afterFirst.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    const repairSpawn = gen.next().value as any
    expect(repairSpawn).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'repair-editor' }] },
    })
    // The gate mints RF-<n>-<hash> finding ids via buildReviewerFindingId; read
    // them from state (do NOT reuse the reviewer-output id) and make the
    // repair's byte change real so the no-progress fingerprint guard passes.
    const findingIds = (agentState as any).base2ActiveWork.openReviewerFindings.map(
      (finding: any) => finding.id,
    )
    writeFileSync(tmpFile, 'export const value = 2 // repaired\n')
    expect(
      gen.next(completedRepairReceipt(findingIds, [gateFile]) as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
      } as any).value,
    ).toMatchObject({ toolName: 'run_file_change_hooks' })
    // Re-validation passes (a real hook summary, not an empty result).
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
    // The re-validation continuation pins the awaiting_review active-work state.
    const pinned = gen.next().value as any
    expect(pinned).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect(gen.next().value).toBe('STEP')
    // Next loop iteration: no new edits this round -> drive the gate again until
    // the second code-reviewer spawn_agents call.
    expect(
      gen.next({ stepsComplete: true, toolResult: [] } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
      } as any).value,
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'run_file_change_hooks',
    })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: [] }] } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const secondReviewCall = gen.next({
      toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
    } as any).value as any
    expect(secondReviewCall).toMatchObject({ toolName: 'spawn_agents' })
    return secondReviewCall
  }

  test('same NON_BLOCKING finding text after repair-editor addressed it finalizes instead of looping', () => {
    const findingText = 'Minor style suggestion.'
    const { gen, agentState, reviewCall, tmpDir, tmpFile, gateFile } =
      driveToFirstReview()
    try {
      const secondReviewCall = driveThroughRepairToSecondReview(
        gen,
        agentState,
        reviewCall,
        tmpFile,
        gateFile,
        findingText,
      )
      // After the repair receipt, the finding text is recorded as condoned.
      expect(
        (agentState as any).base2ActiveWork.condonedFindingTexts,
      ).toContain(findingText)
      // Second reviewer pass returns the SAME finding text (stale re-derivation).
      const secondReview = attestedReviewerResult(
        secondReviewCall,
        'NON_BLOCKING',
        [findingText],
      )
      const afterSecond = gen.next(secondReview as any)
      // The condoned filter suppressed every blocker, so the gate must NOT
      // re-enter the repair loop; the condoned pass credits the review as
      // LOOKS_GOOD and finalization proceeds.
      const active = (agentState as any).base2ActiveWork
      expect(active.currentPhase).not.toBe('repair_loop')
      expect(active.currentPhase).not.toBe('blocked')
      expect(active.openReviewerBlockers ?? []).not.toContain(
        `NON_BLOCKING: ${findingText}`,
      )
      // Drive the finalization: git_status -> gate-passed add_message. No
      // repair-editor spawn may appear.
      expect(afterSecond.value).toMatchObject({ toolName: 'git_status' })
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
      expect(
        (agentState as any).base2ActiveWork.currentPhase,
      ).toBe('final_response_allowed')
      expect(
        (agentState as any).base2ActiveWork.openReviewerBlockers,
      ).toEqual([])
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('genuinely NEW finding on re-review still blocks and spawns repair-editor', () => {
    const findingText = 'Minor style suggestion.'
    const newFindingText = 'Missing auth check.'
    const { gen, agentState, reviewCall, tmpDir, tmpFile, gateFile } =
      driveToFirstReview()
    try {
      const secondReviewCall = driveThroughRepairToSecondReview(
        gen,
        agentState,
        reviewCall,
        tmpFile,
        gateFile,
        findingText,
      )
      // Second reviewer pass returns a DIFFERENT finding (not condoned).
      const secondReview = attestedReviewerResult(
        secondReviewCall,
        'NON_BLOCKING',
        [newFindingText],
      )
      const afterSecond = gen.next(secondReview as any)
      expect(afterSecond.value).toMatchObject({
        toolName: 'add_message',
        input: { role: 'user' },
      })
      expect((afterSecond.value as any).input.content).toContain(
        `NON_BLOCKING: ${newFindingText}`,
      )
      const active = (agentState as any).base2ActiveWork
      expect(active.openReviewerBlockers).toContain(
        `NON_BLOCKING: ${newFindingText}`,
      )
      const repairSpawn = gen.next().value as any
      expect(repairSpawn).toMatchObject({
        toolName: 'spawn_agents',
        input: { agents: [{ agent_type: 'repair-editor' }] },
      })
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('parent-owned requirementCoverage gap is still filtered alongside condoned texts', () => {
    const { gen, agentState, reviewCall, tmpDir, gateFile } =
      driveToFirstReview()
    try {
      // Reviewer returns only a parent-owned requirementCoverage gap (commit
      // and push), which must be filtered out by isParentOwnedRequirementBlocker
      // and must NOT produce a blocker or a repair spawn.
      const prompt = String(reviewCall?.input?.agents?.[0]?.prompt ?? '')
      const fingerprint =
        prompt.match(/Snapshot fingerprint \(echo exactly\): ([^\n]+)/)?.[1] ??
        ''
      const review = {
        toolResult: [
          {
            type: 'json',
            value: [
              {
                schemaVersion: 1,
                verdict: 'NON_BLOCKING',
                snapshotFingerprint: fingerprint,
                reviewedFiles: [gateFile],
                findings: [],
                coverage: 'covered',
                dimensions: { correctness: 'pass' },
                requirementCoverage: [
                  {
                    requirement: 'commit and push',
                    status: 'missing',
                    evidence: [],
                  },
                ],
              },
            ],
          },
        ],
      }
      const afterReview = gen.next(review as any)
      const active = (agentState as any).base2ActiveWork
      // The parent-owned requirementCoverage gap (commit and push) is filtered
      // out by isParentOwnedRequirementBlocker, so it is NOT elevated as a
      // blocker. The only blocker present is the synthetic NON_BLOCKING
      // empty-findings placeholder from collectReviewerBlockers, which is
      // expected because the reviewer returned NON_BLOCKING with zero findings.
      const blockers = (active.openReviewerBlockers ?? []) as string[]
      // The parent-owned requirementCoverage gap (commit and push) is filtered
      // out by isParentOwnedRequirementBlocker, and because the reviewer
      // returned NON_BLOCKING with zero findings, no synthetic placeholder is
      // elevated either. The blockers list is empty.
      expect(
        blockers.some((blocker: string) =>
          /BLOCKING:\s*requirement\s+missing:\s*commit and push/i.test(blocker),
        ),
      ).toBe(false)
      expect(blockers).toHaveLength(0)
      // The parent-owned filter removed the only gap, so no repair-editor
      // spawn follows. The NON_BLOCKING verdict itself is not a finalization
      // credit (LOOKS_GOOD only), so the gate continues the reviewer loop
      // rather than finalizing; this test only asserts the parent-owned
      // requirement gap never became a blocker or a repair spawn.
      const nextYield = afterReview.value as any
      const isRepairSpawn =
        nextYield &&
        typeof nextYield === 'object' &&
        nextYield.toolName === 'spawn_agents' &&
        nextYield.input?.agents?.[0]?.agent_type === 'repair-editor'
      expect(isRepairSpawn).toBe(false)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'run_file_change_hooks',
    })
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
              verdict: 'LOOKS_GOOD',
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
    // edit_transaction and run_terminal_command are implement-tier, so they are
    // absent from the CORE-only default surface (unlock only under implement).
    for (const tool of ['edit_transaction', 'run_terminal_command'] as const) {
      expect(base2.toolNames).not.toContain(tool)
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

  test('non-blocking reviewer feedback with findings does not finalize and enters repair', () => {
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'run_file_change_hooks',
    })
    const postValidationStatus = gen.next({
      toolResult: [{ type: 'json', value: [] }],
    } as any).value
    expect(postValidationStatus).toMatchObject({ toolName: 'git_status' })
    const reviewCall = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any).value
    expect(reviewCall).toMatchObject({ toolName: 'spawn_agents' })
    const afterReview = gen.next(
      attestedReviewerResult(reviewCall, 'NON_BLOCKING', [
        'Improve naming.',
      ]) as any,
    )

    expect(afterReview.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect((afterReview.value as any).input.content).toContain(
      'NON_BLOCKING: Improve naming.',
    )
    expect((afterReview.value as any).input.content).not.toContain(
      'Reviewer gate passed with NON_BLOCKING',
    )
    expect((agentState as any).base2ActiveWork).toMatchObject({
      openReviewerBlockers: ['NON_BLOCKING: Improve naming.'],
      pendingGateFiles: ['src/a.ts'],
    })
    expect((agentState as any).base2ActiveWork.currentPhase).not.toBe(
      'final_response_allowed',
    )
    const repairSpawn = gen.next().value as any
    expect(repairSpawn).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'repair-editor' }] },
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
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
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
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'run_file_change_hooks',
      })
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
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
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
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
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
      ).toMatchObject({ toolName: 'list_jobs' })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({
        stepsComplete: true,
        toolResult: [{ type: 'json', value: editReceipt('src/a.ts') }],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const validationJobs = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any)
    expect(validationJobs.value).toMatchObject({ toolName: 'list_jobs' })
    const validation = gen.next(feedListJobs())
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'run_file_change_hooks',
    })

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
    // Package root for src/a.ts is `src`, so file + parent-dir + package-root
    // collapse to the same readable set (order-independent).
    expect(
      repairSpawn.input.agents[0].handoff.permissions.readablePaths,
    ).toEqual(expect.arrayContaining(['src/a.ts', 'src/**/*']))
    expect(
      new Set(
        repairSpawn.input.agents[0].handoff.permissions.readablePaths as string[],
      ),
    ).toEqual(new Set(['src/a.ts', 'src/**/*']))
    expect(
      repairSpawn.input.agents[0].handoff.permissions.readablePaths,
    ).not.toContain('.env')
    expect(
      repairSpawn.input.agents[0].handoff.permissions.readablePaths,
    ).not.toEqual(expect.arrayContaining(['*', '**/*']))
    expect(
      repairSpawn.input.agents[0].handoff.permissions.allowedTools,
    ).toEqual(
      expect.arrayContaining([
        'read_files',
        'read_outline',
        'read_subtree',
        'edit_transaction',
      ]),
    )
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
    // Default repair budget is unlimited: maxRepairRounds is omitted from the
    // gate-state payload when Infinity would otherwise serialize poorly.
    expect(parsed!.maxRepairRounds).toBeUndefined()
    expect(parsed!.details).toContain('repair-incomplete')
    expect(parsed!.details).toContain('round 1')
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({ stepsComplete: true, toolResult: [] } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    // No edits: validation hooks are skipped, the reviewer gate does not run,
    // and the finalization block stays the legacy {gate,status,details} shape.
    const finalizedJobs = gen.next({
      toolResult: [{ type: 'json', value: { status: '' } }],
    } as any)
    expect(finalizedJobs.value).toMatchObject({ toolName: 'list_jobs' })
    const finalized = gen.next(feedListJobs())
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'inspect_environment',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'inspect_environment',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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

describe('resolveMaxReviewerRepairRounds', () => {
  test('defaults to unlimited (null) when undefined', () => {
    expect(resolveMaxReviewerRepairRounds(undefined)).toBe(null)
  })

  test('accepts a finite option number', () => {
    expect(resolveMaxReviewerRepairRounds(10)).toBe(10)
  })

  test('invalid values fall back to unlimited (null)', () => {
    expect(resolveMaxReviewerRepairRounds(0)).toBe(null)
    expect(resolveMaxReviewerRepairRounds(-1)).toBe(null)
    expect(resolveMaxReviewerRepairRounds('abc')).toBe(null)
    expect(resolveMaxReviewerRepairRounds(Number.NaN)).toBe(null)
  })

  test('caps at 20', () => {
    expect(resolveMaxReviewerRepairRounds(999)).toBe(20)
  })
})

describe('resolveMaxRepairRounds', () => {
  test('defaults to unlimited (null) when undefined', () => {
    expect(resolveMaxRepairRounds(undefined)).toBe(null)
  })

  test('accepts a finite option number', () => {
    expect(resolveMaxRepairRounds(10)).toBe(10)
  })

  test('invalid values fall back to unlimited (null)', () => {
    expect(resolveMaxRepairRounds(0)).toBe(null)
    expect(resolveMaxRepairRounds(-1)).toBe(null)
    expect(resolveMaxRepairRounds('abc')).toBe(null)
    expect(resolveMaxRepairRounds(Number.NaN)).toBe(null)
  })

  test('caps at 20', () => {
    expect(resolveMaxRepairRounds(999)).toBe(20)
  })
})

describe('resolveMaxSpecialistRepairRounds', () => {
  test('defaults to unlimited (null) when undefined', () => {
    expect(resolveMaxSpecialistRepairRounds(undefined)).toBe(null)
  })

  test('accepts a finite option number', () => {
    expect(resolveMaxSpecialistRepairRounds(10)).toBe(10)
  })

  test('invalid values fall back to unlimited (null)', () => {
    expect(resolveMaxSpecialistRepairRounds(0)).toBe(null)
    expect(resolveMaxSpecialistRepairRounds(-1)).toBe(null)
    expect(resolveMaxSpecialistRepairRounds('abc')).toBe(null)
    expect(resolveMaxSpecialistRepairRounds(Number.NaN)).toBe(null)
  })

  test('caps at 20', () => {
    expect(resolveMaxSpecialistRepairRounds(999)).toBe(20)
  })
})

describe('createBase2 maxReviewerRepairRounds option/env', () => {
  test('option is stored on programmaticConfig', () => {
    const base2 = createBase2('default', { maxReviewerRepairRounds: 10 })
    expect(base2.programmaticConfig).toMatchObject({
      maxReviewerRepairRounds: 10,
    })
  })

  test('env string is used when option is omitted', () => {
    const previous = process.env.OPENBUFF_MAX_REVIEWER_REPAIR_ROUNDS
    try {
      process.env.OPENBUFF_MAX_REVIEWER_REPAIR_ROUNDS = '8'
      const base2 = createBase2('default')
      expect(base2.programmaticConfig).toMatchObject({
        maxReviewerRepairRounds: 8,
      })
    } finally {
      if (previous === undefined) {
        delete process.env.OPENBUFF_MAX_REVIEWER_REPAIR_ROUNDS
      } else {
        process.env.OPENBUFF_MAX_REVIEWER_REPAIR_ROUNDS = previous
      }
    }
  })

  test('option wins over env', () => {
    const previous = process.env.OPENBUFF_MAX_REVIEWER_REPAIR_ROUNDS
    try {
      process.env.OPENBUFF_MAX_REVIEWER_REPAIR_ROUNDS = '8'
      const base2 = createBase2('default', { maxReviewerRepairRounds: 4 })
      expect(base2.programmaticConfig).toMatchObject({
        maxReviewerRepairRounds: 4,
      })
    } finally {
      if (previous === undefined) {
        delete process.env.OPENBUFF_MAX_REVIEWER_REPAIR_ROUNDS
      } else {
        process.env.OPENBUFF_MAX_REVIEWER_REPAIR_ROUNDS = previous
      }
    }
  })

  test('createBase2({ maxReviewerRepairRounds: 2 }) exhausts when count is seeded at 2', () => {
    const base2 = createBase2('default', { maxReviewerRepairRounds: 2 })
    expect(base2.programmaticConfig).toMatchObject({
      maxReviewerRepairRounds: 2,
    })
    const agentState = {
      agentId: 'base2',
      base2ActiveWork: { reviewerRepairRoundCount: 2 },
    }
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'run_file_change_hooks',
    })
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
    expect(gen.next().done).toBe(true)
  })
})

describe('createBase2 maxRepairRounds option/env', () => {
  test('option is stored on programmaticConfig', () => {
    const base2 = createBase2('default', { maxRepairRounds: 5 })
    expect(base2.programmaticConfig).toMatchObject({
      maxRepairRounds: 5,
    })
  })

  test('env string is used when option is omitted', () => {
    const previous = process.env.OPENBUFF_MAX_REPAIR_ROUNDS
    try {
      process.env.OPENBUFF_MAX_REPAIR_ROUNDS = '7'
      const base2 = createBase2('default')
      expect(base2.programmaticConfig).toMatchObject({
        maxRepairRounds: 7,
      })
    } finally {
      if (previous === undefined) {
        delete process.env.OPENBUFF_MAX_REPAIR_ROUNDS
      } else {
        process.env.OPENBUFF_MAX_REPAIR_ROUNDS = previous
      }
    }
  })

  test('option wins over env', () => {
    const previous = process.env.OPENBUFF_MAX_REPAIR_ROUNDS
    try {
      process.env.OPENBUFF_MAX_REPAIR_ROUNDS = '7'
      const base2 = createBase2('default', { maxRepairRounds: 2 })
      expect(base2.programmaticConfig).toMatchObject({
        maxRepairRounds: 2,
      })
    } finally {
      if (previous === undefined) {
        delete process.env.OPENBUFF_MAX_REPAIR_ROUNDS
      } else {
        process.env.OPENBUFF_MAX_REPAIR_ROUNDS = previous
      }
    }
  })

  test('default createBase2 stores unlimited (null) repair budgets on programmaticConfig', () => {
    const base2 = createBase2('default')
    expect(base2.programmaticConfig).toMatchObject({
      maxRepairRounds: null,
      maxReviewerRepairRounds: null,
      maxSpecialistRepairRounds: null,
    })
  })
})

describe('createBase2 maxSpecialistRepairRounds option/env', () => {
  test('option is stored on programmaticConfig', () => {
    const base2 = createBase2('default', { maxSpecialistRepairRounds: 5 })
    expect(base2.programmaticConfig).toMatchObject({
      maxSpecialistRepairRounds: 5,
    })
  })

  test('env string is used when option is omitted', () => {
    const previous = process.env.OPENBUFF_MAX_SPECIALIST_REPAIR_ROUNDS
    try {
      process.env.OPENBUFF_MAX_SPECIALIST_REPAIR_ROUNDS = '7'
      const base2 = createBase2('default')
      expect(base2.programmaticConfig).toMatchObject({
        maxSpecialistRepairRounds: 7,
      })
    } finally {
      if (previous === undefined) {
        delete process.env.OPENBUFF_MAX_SPECIALIST_REPAIR_ROUNDS
      } else {
        process.env.OPENBUFF_MAX_SPECIALIST_REPAIR_ROUNDS = previous
      }
    }
  })

  test('option wins over env', () => {
    const previous = process.env.OPENBUFF_MAX_SPECIALIST_REPAIR_ROUNDS
    try {
      process.env.OPENBUFF_MAX_SPECIALIST_REPAIR_ROUNDS = '7'
      const base2 = createBase2('default', { maxSpecialistRepairRounds: 2 })
      expect(base2.programmaticConfig).toMatchObject({
        maxSpecialistRepairRounds: 2,
      })
    } finally {
      if (previous === undefined) {
        delete process.env.OPENBUFF_MAX_SPECIALIST_REPAIR_ROUNDS
      } else {
        process.env.OPENBUFF_MAX_SPECIALIST_REPAIR_ROUNDS = previous
      }
    }
  })
})

describe('base2 reviewer repair budget cap', () => {
  test('default unlimited does not exhaust at seed count 6', () => {
    // With unlimited default, seeding reviewerRepairRoundCount at the old
    // default (6) must NOT exhaust; the loop continues into repair-editor.
    const base2 = createBase2('default')
    const agentState = {
      agentId: 'base2',
      base2ActiveWork: {
        reviewerRepairRoundCount: 6,
      },
    }
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'run_file_change_hooks',
    })
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
        'Fix the persistent edge case.',
      ]) as any,
    )

    expect(afterReview.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    expect((afterReview.value as any).input.content).not.toContain(
      'automated repair budget exhausted',
    )
    expect(gen.next().value).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'repair-editor' }] },
    })
  })

  test('explicit small maxReviewerRepairRounds still exhausts as opt-in cap', () => {
    const base2 = createBase2('default', { maxReviewerRepairRounds: 1 })
    const agentState = {
      agentId: 'base2',
      base2ActiveWork: {
        reviewerRepairRoundCount: 1,
      },
    }
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'run_file_change_hooks',
    })
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
    ).toMatchObject({ toolName: 'list_jobs' })
    expect(gen.next(feedListJobs()).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
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
    const securityReviewJobs = gen.next({
      toolResult: [
        {
          type: 'json',
          value: { status: ' M sdk/src/policy/terminal-command-policy.ts' },
        },
      ],
    } as any)
    expect(securityReviewJobs.value).toMatchObject({ toolName: 'list_jobs' })
    const securityReview = gen.next(feedListJobs())
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

describe('base2 specialist parent-owned LOOKS_GOOD credit', () => {
  test('LOOKS_GOOD reliability-reviewer with only parent-owned requirementCoverage does not spawn repair-editor', () => {
    // Mirror of agents/e2e/gate-aux-ordering.e2e.test.ts parent-owned credit:
    // a state/session path routes to reliability-reviewer; LOOKS_GOOD whose only
    // requirementCoverage gaps are parent process duties must credit the
    // specialist without spawning repair-editor.
    const tmpDir = makeProjectTempDir('base2-parent-owned-specialist-')
    try {
      const stateDir = join(tmpDir, 'state')
      mkdirSync(stateDir, { recursive: true })
      const absoluteFile = join(stateDir, 'session.ts')
      writeFileSync(absoluteFile, 'export const session = "v1"\n')
      // Prefer project-relative path under .base2-test-scratch when cwd is the
      // openbuff root so the reliability router sees a `state` segment.
      const gateFile = normalizeGateFilePath(absoluteFile)
      const base2 = createBase2('default')
      const agentState = {
        agentId: 'base2-custom',
        base2ActiveWork: {
          changedFiles: [gateFile],
          touchedFiles: [gateFile],
          pendingGateFiles: [gateFile],
          currentPhase: 'awaiting_validation',
          openReviewerBlockers: [],
          openReviewerFindings: [],
          lastValidationSummary: '',
          nextRequiredAction: '',
          lastPinnedStateMessage: '',
          gatePassedFiles: [],
          gatePassedPendingFiles: [],
          gatePassedReviewerVerdict: '',
          gatePassedValidationSummary: '',
          gatePassedFingerprint: '',
          lastReviewerGateSkipReason: '',
          reviewReceipts: [],
          testWriterGateDone: true,
          docWriterGateDone: true,
          securityReviewGateDone: true,
          preEditSecurityReviewDone: true,
          specialistReviewGatesDone: [],
          auxGatesLastPendingFiles: [gateFile],
        },
      }
      // Process tasks stay in the prompt for non-blocking parent context; avoid
      // classifyProactiveRetrieval code-intent keywords so first yield is git_status.
      const prompt =
        'Please finish the pending reliability finding. Parent will later commit and push then confirm CI/CD is green.'
      const gen = base2.handleSteps!({
        agentState,
        prompt,
        params: {},
      } as any)

      expect(gen.next().value).toMatchObject({ toolName: 'git_status', input: {} })
      expect(
        gen.next(feedJson({ status: ` M ${gateFile}` })).value,
      ).toMatchObject({ toolName: 'list_jobs', input: {} })
      expect(gen.next(feedListJobs()).value).toMatchObject({
        toolName: 'spawn_agent_inline',
        input: { agent_type: 'context-pruner' },
      })
      expect(gen.next().value).toMatchObject({ toolName: 'add_message' })
      expect(gen.next().value).toBe('STEP')
      expect(gen.next(finishStepWithToolResult({})).value).toMatchObject({
        toolName: 'git_status',
        input: {},
      })
      expect(
        gen.next(feedJson({ status: ` M ${gateFile}` })).value,
      ).toMatchObject({ toolName: 'list_jobs', input: {} })

      const bundle = gen.next(feedListJobs())
      expect(bundle.value).toMatchObject({
        toolName: 'get_change_review_bundle',
        input: {},
      })
      const spawn = gen.next(
        feedJson({
          snapshotId: 'unit-spec-snap-parent-owned',
          files: [gateFile],
        }),
      )
      expect(spawn.value).toMatchObject({
        toolName: 'spawn_agents',
        input: { agents: [{ agent_type: 'reliability-reviewer' }] },
      })
      const spawnPrompt = (spawn.value as any).input.agents[0].prompt as string
      expect(typeof spawnPrompt).toBe('string')
      expect(
        spawnPrompt.includes('specialist-domain only') ||
          spawnPrompt.includes('Do NOT treat parent workflow'),
      ).toBe(true)
      expect(spawnPrompt).not.toMatch(
        new RegExp(
          `^Requirements:\\s*${prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
          'm',
        ),
      )
      const fingerprint = String(
        (spawn.value as any).input.agents[0].params?.snapshot_id ?? '',
      )
      expect(fingerprint).toMatch(/^v3:[a-f0-9]{64}$/)

      const after = gen.next(
        looksGoodWithParentOwnedRequirements(
          'reliability-reviewer',
          fingerprint,
          [gateFile],
        ),
      )
      const afterValue = after.value as any
      const isRepairEditorSpawn =
        afterValue?.toolName === 'spawn_agents' &&
        afterValue?.input?.agents?.[0]?.agent_type === 'repair-editor'
      expect(isRepairEditorSpawn).toBe(false)

      let creditYield = after
      if (
        afterValue?.toolName === 'add_message' &&
        typeof afterValue?.input?.content === 'string' &&
        afterValue.input.content.includes(
          'parent-owned process requirements were ignored',
        )
      ) {
        creditYield = gen.next()
      }
      expect(
        (creditYield.value as any)?.toolName === 'spawn_agents' &&
          ((creditYield.value as any)?.input?.agents ?? []).some(
            (a: { agent_type?: string }) => a?.agent_type === 'repair-editor',
          ),
      ).toBe(false)

      expect(
        (agentState as any).base2ActiveWork.specialistReviewGatesDone,
      ).toContain('reliability-reviewer')
      expect((agentState as any).base2ActiveWork.currentPhase).not.toBe(
        'repair_loop',
      )
      expect((agentState as any).base2ActiveWork.currentPhase).not.toBe(
        'blocked',
      )
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
