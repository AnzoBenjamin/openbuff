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

import { getEffectiveAgentToolNames } from '@codebuff/agent-runtime/util/agent-tool-names'

import { createBaseDeep } from '../base2/base-deep'
import {
  createBase2,
  resolveMaxRepairRounds,
  resolveMaxReviewerRepairRounds,
  resolveMaxSpecialistRepairRounds,
} from '../base2/base2'
import { normalizeGateFilePath } from '../base2/gate-paths'
import type { Base2ActiveWorkState } from '../base2/gate-state'
import { extractInlineFunctionSource } from './helpers/extract-inline-function-source'

import type { AgentTemplate } from '@codebuff/agent-runtime/templates/types'

const TEST_TMP_ROOT = join(process.cwd(), '.base2-test-scratch')
mkdirSync(TEST_TMP_ROOT, { recursive: true })

afterAll(() => {
  rmSync(TEST_TMP_ROOT, { recursive: true, force: true })
})

function makeProjectTempDir(prefix: string): string {
  // Ensure the root at USE time, not only at module load. `.base2-test-scratch`
  // is shared with agents/e2e/*.e2e.test.ts, whose afterAll removes the parent
  // once it looks empty; when bun runs those files alongside this one the root
  // can vanish between module load and this call, and mkdtemp then fails with
  // ENOENT. recursive: true makes this a no-op in the common case.
  mkdirSync(TEST_TMP_ROOT, { recursive: true })
  return mkdtempSync(join(TEST_TMP_ROOT, prefix))
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
  // Optional non-blocking advisories: the specialist parent-owned-only pass
  // displays them alongside the ignored process requirements.
  advisories: string[] = [],
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
      ...(advisories.length > 0 ? { advisories } : {}),
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
      advisories?: string[]
      workflow?: {
        completedCount: number
        totalCount: number
        nextWorkflowAction: string
      }
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
      // Reviewer advisories reach the user only through this block, so the
      // bounded payload has to be assertable from a driven lifecycle.
      ...(Array.isArray(parsed.advisories)
        ? {
            advisories: parsed.advisories.map((advisory) => String(advisory)),
          }
        : {}),
      // Declared-workflow progress is emitted on gate-PASS only, so it is read
      // back verbatim here rather than re-derived.
      ...(parsed.workflow && typeof parsed.workflow === 'object'
        ? {
            workflow: parsed.workflow as {
              completedCount: number
              totalCount: number
              nextWorkflowAction: string
            },
          }
        : {}),
    }
  } catch {
    return undefined
  }
}

function buildFingerprint(
  entries: Array<{ file: string; contentMarker: string }>,
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
  const parts = sorted.map((entry) => `${entry.file}\t${entry.contentMarker}`)
  const details = `files-v4\n${parts.join('\n')}\n--\n${validationSummary}`
  return `v3:${createHash('sha256').update(details).digest('hex')}`
}

function attestedReviewerResult(
  reviewCall: any,
  verdict: 'LOOKS_GOOD' | 'NON_BLOCKING' | 'BLOCKING' = 'LOOKS_GOOD',
  // Object findings (a reviewer-supplied stable `id` plus `summary`) are
  // accepted alongside plain strings so a test can exercise the id half of the
  // condone key, which only exists for a non-minted reviewer-supplied id.
  findings: Array<string | Record<string, unknown>> = [],
  coverage: 'covered' | 'missing' | 'n/a' = 'covered',
  // Optional non-blocking advisories: the gate persists and displays them, so a
  // lifecycle test needs to emit them from a real reviewer receipt.
  advisories: string[] = [],
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
            ...(advisories.length > 0 ? { advisories } : {}),
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

type RepairEditorReadablePaths = (paths: string[], texts?: string[]) => string[]

type InlineCondoneHelpers = {
  condonedKeyMatches: (
    condonedKeys: Set<string>,
    verdictClass: string,
    strippedText: string,
    id?: string,
  ) => boolean
  legacyCondonedTextMatches: (
    condonedTexts: Set<string>,
    text: string,
  ) => boolean
  boundCondonedEntries: (values: string[]) => string[]
  correlateReviewerFindingRecord: (
    blockerText: string,
    records: Array<{ id: string; text: string }>,
  ) => { id: string; text: string } | undefined
}

// The condone helpers live inside the serialized handleSteps generator, so they
// cannot be imported. Reconstruct them together with the helpers they close over
// (stripReviewerVerdictPrefix / isMintedReviewerFindingId /
// condonedFindingKeysFor) so the class-matching, legacy-fallback, bounding, and
// record-correlation rules can be asserted directly instead of only through a
// full gate lifecycle.
function loadInlineCondoneHelpers(): InlineCondoneHelpers {
  const base2Source = readFileSync(
    new URL('../base2/base2.ts', import.meta.url),
    'utf8',
  )
  // handleSteps helpers are TypeScript; transpile before new Function (plain JS).
  const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' })
  const combinedTs = [
    extractInlineFunctionSource(base2Source, 'stripReviewerVerdictPrefix'),
    extractInlineFunctionSource(base2Source, 'isMintedReviewerFindingId'),
    extractInlineFunctionSource(base2Source, 'condonedFindingKeysFor'),
    extractInlineFunctionSource(base2Source, 'condonedKeyMatches'),
    extractInlineFunctionSource(base2Source, 'legacyCondonedTextMatches'),
    extractInlineFunctionSource(base2Source, 'boundCondonedEntries'),
    extractInlineFunctionSource(base2Source, 'correlateReviewerFindingRecord'),
    'return { condonedKeyMatches, legacyCondonedTextMatches, boundCondonedEntries, correlateReviewerFindingRecord }',
  ].join('\n')
  const combinedJs = transpiler.transformSync(combinedTs)
  const buildHelpers = new Function(
    `"use strict";\n${combinedJs}`,
  ) as () => InlineCondoneHelpers

  return buildHelpers()
}

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
  const buildHelper = new Function(
    `"use strict";\n${combinedJs}`,
  ) as () => RepairEditorReadablePaths

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
    const paths = repairEditorReadablePaths(
      ['src/a.ts'],
      [
        'See https://example.com/src/schema.ts and node_modules/pkg/index.ts and .env.local',
      ],
    )
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

describe('base2 inline condone helpers', () => {
  const {
    condonedKeyMatches,
    legacyCondonedTextMatches,
    boundCondonedEntries,
    correlateReviewerFindingRecord,
  } = loadInlineCondoneHelpers()
  const findingText = 'Minor style suggestion.'
  const findingId = 'code-reviewer:correctness:minor-style'

  // RF-1: de-escalation is condonable, one-directionally. A stored BLOCKING key
  // must condone a NON_BLOCKING re-raise of the SAME identity, or the blocker
  // list stays non-empty, another repair-editor is spawned, and the
  // already-applied repair trips the no-progress guard.
  test('a stored BLOCKING key condones a NON_BLOCKING re-raise of the same identity', () => {
    const keys = new Set([
      `BLOCKING::text:${findingText}`,
      `BLOCKING::id:${findingId}`,
    ])
    expect(
      condonedKeyMatches(keys, 'NON_BLOCKING', findingText, findingId),
    ).toBe(true)
    // The text half alone is enough: a record-less finding has no stable id.
    expect(
      condonedKeyMatches(
        new Set([`BLOCKING::text:${findingText}`]),
        'NON_BLOCKING',
        findingText,
      ),
    ).toBe(true)
    // The id half alone is enough too, for a differently-worded re-raise.
    expect(
      condonedKeyMatches(
        new Set([`BLOCKING::id:${findingId}`]),
        'NON_BLOCKING',
        'Reworded nit text.',
        findingId,
      ),
    ).toBe(true)
  })

  test('a stored NON_BLOCKING key never condones a BLOCKING re-raise', () => {
    const keys = new Set([
      `NON_BLOCKING::text:${findingText}`,
      `NON_BLOCKING::id:${findingId}`,
    ])
    // Escalation is new information: the gate must reopen.
    expect(condonedKeyMatches(keys, 'BLOCKING', findingText, findingId)).toBe(
      false,
    )
    // Same class still condones.
    expect(
      condonedKeyMatches(keys, 'NON_BLOCKING', findingText, findingId),
    ).toBe(true)
  })

  test('a legacy prefix-less key stays class-exact in both directions', () => {
    const legacyKeys = new Set([`*::text:${findingText}`])
    expect(condonedKeyMatches(legacyKeys, '*', findingText)).toBe(true)
    expect(condonedKeyMatches(legacyKeys, 'NON_BLOCKING', findingText)).toBe(
      false,
    )
    expect(condonedKeyMatches(legacyKeys, 'BLOCKING', findingText)).toBe(false)
    // A BLOCKING entry does not condone a prefix-less `*` re-raise either: the
    // de-escalation allowance is NON_BLOCKING-only.
    expect(
      condonedKeyMatches(
        new Set([`BLOCKING::text:${findingText}`]),
        '*',
        findingText,
      ),
    ).toBe(false)
  })

  // RF-6: the pre-T1.5 legacy text fallback is one helper, so all three call
  // sites accept both the stripped text and the raw prefixed blocker.
  test('the legacy text fallback matches both stripped and raw prefixed blockers', () => {
    const strippedOnly = new Set([findingText])
    expect(
      legacyCondonedTextMatches(strippedOnly, `NON_BLOCKING: ${findingText}`),
    ).toBe(true)
    expect(legacyCondonedTextMatches(strippedOnly, findingText)).toBe(true)
    const rawOnly = new Set([`BLOCKING: ${findingText}`])
    expect(legacyCondonedTextMatches(rawOnly, `BLOCKING: ${findingText}`)).toBe(
      true,
    )
    expect(legacyCondonedTextMatches(rawOnly, 'A different nit.')).toBe(false)
  })

  // RF-4: the durable condone lists are bounded like reviewReceipts.
  test('boundCondonedEntries dedupes and keeps only the most recent 200 entries', () => {
    const bounded = boundCondonedEntries(
      Array.from({ length: 250 }, (_unused, index) => `key-${index}`),
    )
    expect(bounded).toHaveLength(200)
    expect(bounded[0]).toBe('key-50')
    expect(bounded).toContain('key-249')
    expect(bounded).not.toContain('key-49')
    // Duplicates collapse before the slice, so a repeatedly re-raised finding
    // does not evict distinct entries.
    expect(boundCondonedEntries(['a', 'b', 'a'])).toEqual(['a', 'b'])
  })

  // RF-3: a substring relationship between two finding texts must never attach
  // the wrong record id, because the resulting `<class>::id:<id>` key would
  // condone an unrelated finding.
  test('correlateReviewerFindingRecord prefers [id], then exact text, and refuses ambiguous substrings', () => {
    const shortRecord = { id: 'r-short', text: 'Null check missing.' }
    const longRecord = {
      id: 'r-long',
      text: 'Null check missing. Also bounds check missing.',
    }
    const records = [shortRecord, longRecord]
    // The explicit marker wins even when another record's text matches exactly.
    expect(
      correlateReviewerFindingRecord(
        `NON_BLOCKING: [${longRecord.id}] ${shortRecord.text}`,
        records,
      ),
    ).toBe(longRecord)
    // Exact stripped-text match, not "first record whose text is contained".
    expect(
      correlateReviewerFindingRecord(
        `NON_BLOCKING: ${longRecord.text}`,
        records,
      ),
    ).toBe(longRecord)
    expect(
      correlateReviewerFindingRecord(
        `NON_BLOCKING: ${shortRecord.text}`,
        records,
      ),
    ).toBe(shortRecord)
    // The `[id] text` blocker form is an exact match too.
    expect(
      correlateReviewerFindingRecord(
        `NON_BLOCKING: [${shortRecord.id}] ${shortRecord.text}`,
        [shortRecord],
      ),
    ).toBe(shortRecord)
    // A synthesized blocker that merely CONTAINS both texts is ambiguous, so no
    // id is attached; the text key still carries convergence.
    expect(
      correlateReviewerFindingRecord(
        `BLOCKING: requirement missing: ${longRecord.text}`,
        records,
      ),
    ).toBeUndefined()
    // A single unambiguous containment still correlates.
    expect(
      correlateReviewerFindingRecord(
        `BLOCKING: requirement missing: ${shortRecord.text}`,
        [shortRecord],
      ),
    ).toBe(shortRecord)
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
    expect(base2.systemPrompt).not.toContain('timeout_seconds` for editor')
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
    expect(base2.systemPrompt).toContain('agents/guides/specialist-routing.md')
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
    // and every non-core tier is unlocked by default, so both are on the
    // model-visible surface. They stay declared programmatically as well.
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
      'absolute last tool in the same final message after the single completion summary',
    )
    expect(base2.instructionsPrompt).toContain(
      'if committing, spawn git-committer before suggest_followups',
    )
    expect(base2.instructionsPrompt).toContain(
      'never mid-turn and never before remaining work',
    )
    expect(base2.instructionsPrompt).toContain(
      'If suggest_followups is unavailable, still provide the final summary/end normally',
    )
    expect(base2.stepPrompt).toContain('if that tool is available')
    expect(base2.stepPrompt).toContain(
      'absolute last tool in that same final message',
    )
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
    // create_plan/update_plan_status are implement-tier, and every non-core
    // tier is unlocked by default now, so both are on the default surface.
    expect(base2.toolNames).toContain('create_plan')
    expect(base2.toolNames).toContain('update_plan_status')

    // Plan artifact tools are not mode-gated, so plan mode keeps both
    // create_plan and update_plan_status (it is the mode that creates and
    // maintains plan artifacts). What plan mode still withholds are the
    // mutation/execution tools (edit_transaction, run_terminal_command,
    // run_targeted_validation, write_todos).
    const planBase2 = createBase2('default', { planOnly: true })
    expect(planBase2.toolNames).toContain('create_plan')
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
    // inspect_codebase_structure is audit-tier, and every non-core tier is
    // unlocked by default, so it is present in the plan surface too (it is a
    // read-only analysis tool, so plan mode does not gate it).
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

  test('tells the orchestrator to size delegated work to the child window', () => {
    const base2 = createBase2('default')

    expect(base2.systemPrompt).toContain(
      "Size work to the child's context window",
    )
  })

  test('names the catalog window suffix and the receipt contextUsage field', () => {
    const base2 = createBase2('default')

    expect(base2.systemPrompt).toContain('[context ~200k]')
    expect(base2.systemPrompt).toContain('contextUsage')
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
    // edit_transaction is implement-tier and every non-core tier is unlocked
    // by default, so base-deep exposes it (it inherits createBase2's surface).
    expect(baseDeep.toolNames).toContain('edit_transaction')
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
    // get_change_review_bundle is audit-tier; every non-core tier is unlocked
    // by default, so all three appear on the base-deep model surface.
    expect(baseDeep.toolNames).toContain('create_plan')
    expect(baseDeep.toolNames).toContain('update_plan_status')
    expect(baseDeep.toolNames).toContain('get_change_review_bundle')

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
    ).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect(gen.next().value).toBe('STEP')
    // After the step produces a file change: git_status →
    // run_file_change_hooks.
    const afterStep = gen.next({
      stepsComplete: true,
      toolResult: [{ type: 'json', value: editReceipt('src/a.ts') }],
    } as any)
    expect(afterStep.value).toMatchObject({ toolName: 'git_status' })
    const afterGit = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any)
    expect(afterGit.value).toMatchObject({
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

describe('base2 resume safety: persisted unlockedToolTiers cannot narrow the surface', () => {
  // progressiveToolDisclosure is pinned false, so getEffectiveAgentToolNames
  // returns template.toolNames unchanged even when an older session persisted a
  // NON-EMPTY agentState.unlockedToolTiers — fail-closed by construction, with
  // no per-step clearer to forget. Contract:
  // packages/agent-runtime/src/util/base2-tool-tiers.ts.
  // createBase2 returns the authoring-time SecretAgentDefinition shape
  // (JSON-schema inputSchema, no id), so the structural conversion to the
  // runtime AgentTemplate goes through `unknown`. The annotated return type is
  // what matters: getEffectiveAgentToolNames stays typechecked against
  // AgentTemplate instead of silently accepting a drifted shape via `any`.
  const asTemplate = (base2: ReturnType<typeof createBase2>): AgentTemplate =>
    ({ ...base2, id: 'base2' }) as unknown as AgentTemplate

  test('every mode publishes progressiveToolDisclosure: false (runtime tier filtering off)', () => {
    const agents = [
      createBase2('default'),
      createBase2('fast'),
      createBase2('default', { planOnly: true }),
      createBase2('default', { executePlan: true }),
      // The published runtime-filtering key is false for every mode, and also
      // when the caller narrows the static surface with `unlockedTiers`.
      createBase2('default', { unlockedTiers: [] }),
      createBase2('default', { unlockedTiers: ['implement'] }),
    ]
    for (const base2 of agents) {
      expect(base2.programmaticConfig).toMatchObject({
        progressiveToolDisclosure: false,
      })
    }
  })

  test('a stale non-empty unlockedToolTiers leaves the full surface intact', () => {
    const base2 = createBase2('default')
    for (const staleTiers of [
      ['implement'],
      ['audit'],
      ['implement', 'audit'],
    ]) {
      const effective = getEffectiveAgentToolNames(asTemplate(base2), {
        unlockedToolTiers: staleTiers,
      } as any)
      expect(effective).toEqual(base2.toolNames ?? [])
      expect(effective).toContain('edit_transaction')
      expect(effective).toContain('kill_job')
      expect(effective).toContain('read_image')
    }
  })

  test('handleSteps does not depend on clearing tiers at each yielded step', () => {
    const base2 = createBase2('default')
    const staleTiers = ['implement']
    const agentState: Record<string, unknown> = {
      agentId: 'base2',
      unlockedToolTiers: staleTiers,
    }
    const generator = base2.handleSteps!({
      agentState,
      prompt: 'Make the requested change now please',
      params: {},
      config: base2.programmaticConfig,
    } as any)

    expect(generator.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      generator.next({
        toolResult: [{ type: 'json', value: { status: '' } }],
      } as any).value,
    ).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect(generator.next({ toolResult: [] } as any).value).toBe('STEP')

    // No per-step mutation of the persisted list is performed or needed...
    expect(agentState.unlockedToolTiers).toBe(staleTiers)
    // ...because the surface offered to the model is unaffected by it.
    const effective = getEffectiveAgentToolNames(
      asTemplate(base2),
      agentState as any,
    )
    expect(effective).toEqual(base2.toolNames ?? [])
    expect(effective).toContain('edit_transaction')
    expect(effective).toContain('kill_job')
    expect(effective).toContain('read_image')
  })

  test('conversational fast path also leaves persisted tiers untouched', () => {
    const base2 = createBase2('default')
    const staleTiers = ['audit']
    const agentState: Record<string, unknown> = {
      agentId: 'base2',
      unlockedToolTiers: staleTiers,
    }
    const generator = base2.handleSteps!({
      agentState,
      prompt: 'Hello.',
      params: {},
      config: base2.programmaticConfig,
    } as any)

    expect(generator.next().value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect(generator.next({ toolResult: [] } as any).value).toBe('STEP')
    expect(agentState.unlockedToolTiers).toBe(staleTiers)
    expect(
      getEffectiveAgentToolNames(asTemplate(base2), agentState as any),
    ).toEqual(base2.toolNames ?? [])
  })

  test('an absent unlockedToolTiers is never introduced by handleSteps', () => {
    const base2 = createBase2('default')
    const absentState: Record<string, unknown> = { agentId: 'base2' }
    const absentGenerator = base2.handleSteps!({
      agentState: absentState,
      prompt: 'Hello.',
      params: {},
      config: base2.programmaticConfig,
    } as any)
    expect(absentGenerator.next().value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'context-pruner' },
    })
    expect(absentGenerator.next({ toolResult: [] } as any).value).toBe('STEP')
    // Never introduced — not even as undefined or [].
    expect(
      Object.prototype.hasOwnProperty.call(absentState, 'unlockedToolTiers'),
    ).toBe(false)
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
  test('code-intent prompts no longer auto-query and always start at git_status', () => {
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

    // Automatic proactive query_index injection is removed; even strong
    // code-intent prompts start at the working-tree snapshot.
    expect(
      firstYield('Refactor the authentication module code.'),
    ).toMatchObject({ toolName: 'git_status' })

    // A prompt naming a concrete file path starts at git_status.
    expect(firstYield('Update src/app.ts with the new export')).toMatchObject({
      toolName: 'git_status',
    })

    // Too-short prompts start at git_status.
    expect(firstYield('fix it')).toMatchObject({ toolName: 'git_status' })

    // Continuation prompts start at git_status.
    expect(firstYield('continue working on the previous task')).toMatchObject({
      toolName: 'git_status',
    })
  })

  test('starts codebase-oriented Q&A prompts at git_status', () => {
    const base2 = createBase2('default')
    const generator = base2.handleSteps!({
      prompt: 'Where is authentication configured in this codebase?',
      params: {},
    } as any)

    expect(generator.next().value).toMatchObject({ toolName: 'git_status' })
  })

  test('does not auto-inject structural discovery for broad cross-subsystem audits', () => {
    const base2 = createBase2('default')
    const generator = base2.handleSteps!({
      prompt:
        'Audit context and indexing across the SDK, runtime, CLI, and tests for feature gaps',
      params: {},
    } as any)

    expect(generator.next().value).toMatchObject({ toolName: 'git_status' })
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

  test('strong-intent and Q&A prompts both start at git_status', () => {
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

    expect(firstYield('tell me about the flow')).toMatchObject({
      toolName: 'git_status',
    })
    expect(firstYield('what is this context')).toMatchObject({
      toolName: 'git_status',
    })
    expect(firstYield('show me the index')).toMatchObject({
      toolName: 'git_status',
    })
    expect(firstYield('refactor the authentication module code')).toMatchObject(
      { toolName: 'git_status' },
    )
    expect(
      firstYield('How does the authentication module work in this codebase?'),
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      firstYield('What does this function do in the dependency layer?'),
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      firstYield('Explain the module loading order in this package'),
    ).toMatchObject({ toolName: 'git_status' })
    expect(firstYield('Refactor the authentication module code')).toMatchObject(
      {
        toolName: 'git_status',
      },
    )
    expect(
      firstYield('How do I run the bun test --watch script for this repo?'),
    ).toMatchObject({ toolName: 'git_status' })
    expect(firstYield('run the tests and validate the fix')).toMatchObject({
      toolName: 'git_status',
    })
    expect(firstYield('validate the schema before continuing')).toMatchObject({
      toolName: 'git_status',
    })
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
    ).toMatchObject({
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
    ).toMatchObject({
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
    expect(afterGit.value).toMatchObject({
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
        gen.next({
          toolResult: [{ type: 'json', value: { status: '' } }],
        } as any).value,
      ).toMatchObject({
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
      expect(afterGit.value).toMatchObject({
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
      ).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
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
        gen.next({
          toolResult: [{ type: 'json', value: { status: '' } }],
        } as any).value,
      ).toMatchObject({
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
    ).toMatchObject({
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
    ).toMatchObject({
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
        gen.next({
          toolResult: [{ type: 'json', value: { status: '' } }],
        } as any).value,
      ).toMatchObject({
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
      ).toMatchObject({
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
    ).toMatchObject({
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
            contentMarker: buildContentMarker(fileA),
          },
          {
            file: gateFileB,
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
      ).toMatchObject({
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
      const reused = reusedJobs

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
      ).toMatchObject({
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
      const next = nextJobs

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
          toolResult: [{ type: 'json', value: { status: ` M ${tmpFile}` } }],
        } as any).value,
      ).toMatchObject({
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
      const reused = reusedJobs
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
    ).toMatchObject({
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
    ).toMatchObject({
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
    ).toMatchObject({
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
    ).toMatchObject({
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
      ).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
      const maybePinnedState = gen.next().value
      if (maybePinnedState !== 'STEP') {
        expect(maybePinnedState).toMatchObject({ toolName: 'add_message' })
        expect(gen.next().value).toBe('STEP')
      }

      // Only the never-validated agent-touched dirty reviewable file B is
      // published; the gate-passed file A and the untouched file C are excluded.
      expect((agentState as any).uncommittedUnvalidatedFiles).toEqual([
        'src/b.ts',
      ])
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
      ).toMatchObject({
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
      ).toMatchObject({
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
      expect((agentState as any).base2ActiveWork.latestWorkSummary).toMatch(
        /Unreviewed dirty reviewable files reopened the gate/,
      )
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
      ).toMatchObject({
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
      ).toMatchObject({
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
      const done = afterGit
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
    ).toMatchObject({
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
    ).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next({ stepsComplete: true, toolResult: [] } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const finalGateJobs = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/other.ts' } }],
    } as any)
    const finalGate = finalGateJobs
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
    const done = doneJobs
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
    ).toMatchObject({
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
    ).toMatchObject({
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
    const finalGate = finalGateJobs
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
    const done = doneJobs

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
    ).toMatchObject({
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
    const afterGit = afterGitJobs

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
    ).toMatchObject({
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
    const afterGit = afterGitJobs

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
          toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
        } as any).value,
      ).toMatchObject({
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

      expect(afterGit.value).toMatchObject({
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
      const done = gen.next({
        toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
      } as any)
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
    ).toMatchObject({
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
    ).toMatchObject({
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
    ).toMatchObject({
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
    ).toMatchObject({
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
    ).toMatchObject({
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
    ).toMatchObject({
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
    const finalGate = finalGateJobs
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
    const done = doneJobs

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
    ).toMatchObject({
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
    const skipDiagnostic = skipJobs

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
    ).toMatchObject({
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
    const skipDiagnostic = skipJobs

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
    ).toMatchObject({
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
    const blocked = blockedJobs

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
    ).toMatchObject({
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
    ).toMatchObject({
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
    ).toMatchObject({
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
        gateProgressLine:
          'gate: validation passed; reviewer code-reviewer running',
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
    ).toMatchObject({
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
    ).toMatchObject({
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

  test('legacy gate state without gateProgressLine renders the pinned block with no Gate progress line', () => {
    // Older serialized state lacks the optional field entirely; the type usage
    // here (no gateProgressLine key) is what asserts optionality, and the
    // assertions below are behavioral: the pinned block must still render and
    // must not carry a Gate progress line.
    const legacyState: Base2ActiveWorkState = {
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
    const base2 = createBase2('default')
    const gen = base2.handleSteps!({
      agentState: { agentId: 'base2', base2ActiveWork: legacyState },
      prompt: 'Finish the previous response.',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    const pinned = gen.next()
    expect(pinned.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    const text = (pinned.value as any).input.content as string
    expect(text).toContain('Harness pinned active-work state')
    expect(text).toContain('GATE: PENDING')
    expect(text).not.toContain('Gate progress:')
  })

  // Win 4a delta-only pinned state: after the first full pinned block, a step
  // whose only change is gate progress emits just the progress diff.
  test('second pinned emission is delta-only when only gateProgressLine changed', () => {
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
        gateProgressLine: 'gate: validation hooks running for 1 file(s)',
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
    ).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    const firstPinned = gen.next()
    const firstText = (firstPinned.value as any).input.content as string
    expect(firstText).toContain('Harness pinned active-work state')
    expect(firstText).toContain(
      'Gate progress: gate: validation hooks running for 1 file(s)',
    )

    expect(gen.next().value).toBe('STEP')
    // Simulate a mid-turn setGateProgress write: the progress line changes and
    // lastPinnedStateMessage is reset to '' by markActiveWorkStateChanged. The
    // delta path must key off the last EMITTED block, not that sentinel.
    agentState.base2ActiveWork.gateProgressLine =
      'gate: validation passed; reviewer code-reviewer running'
    agentState.base2ActiveWork.lastPinnedStateMessage = ''

    expect(gen.next({ stepsComplete: false } as any).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    const secondPinned = gen.next()
    expect(secondPinned.value).toMatchObject({
      toolName: 'add_message',
      input: {
        role: 'user',
        content:
          'Gate progress: gate: validation passed; reviewer code-reviewer running',
      },
    })
  })

  test('second pinned emission re-emits the full block when reviewer blockers change', () => {
    const base2 = createBase2('default')
    const agentState = {
      agentId: 'base2',
      base2ActiveWork: {
        changedFiles: ['src/a.ts'],
        touchedFiles: ['src/a.ts'],
        pendingGateFiles: ['src/a.ts'],
        currentPhase: 'awaiting_validation',
        latestWorkSummary: '',
        openReviewerBlockers: [] as string[],
        lastValidationSummary: 'typecheck passed for src/a.ts',
        nextRequiredAction: '',
        lastPinnedStateMessage: '',
        gateProgressLine: 'gate: validation hooks running for 1 file(s)',
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
    ).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    const firstText = (gen.next().value as any).input.content as string
    expect(firstText).toContain('Harness pinned active-work state')

    expect(gen.next().value).toBe('STEP')
    // A reviewer blocker plus a next required action is not a progress-only
    // change, so the whole pinned block must be re-emitted.
    agentState.base2ActiveWork.openReviewerBlockers = [
      'BLOCKING: add a test for the delta path',
    ]
    agentState.base2ActiveWork.nextRequiredAction =
      'Repair the reviewer blocker before finalizing.'
    agentState.base2ActiveWork.gateProgressLine =
      'gate: reviewer code-reviewer reported blockers'
    agentState.base2ActiveWork.lastPinnedStateMessage = ''

    expect(gen.next({ stepsComplete: false } as any).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    const secondPinned = gen.next()
    expect(secondPinned.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    const secondText = (secondPinned.value as any).input.content as string
    expect(secondText).toContain('Harness pinned active-work state')
    expect(secondText).toContain('BLOCKING: add a test for the delta path')
    expect(secondText).toContain(
      'Next required action: Repair the reviewer blocker before finalizing.',
    )
    expect(secondText).toContain(
      'Gate progress: gate: reviewer code-reviewer reported blockers',
    )
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
      ).toMatchObject({
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
      ).toMatchObject({
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
    ).toMatchObject({
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
    ).toMatchObject({
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
    ).toMatchObject({
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
    ).toMatchObject({
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
      ).toMatchObject({
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
      ).toMatchObject({
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
      ).toMatchObject({
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
      ).toMatchObject({
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

  // A repair loop can also oscillate: round 1 writes content B, round 2 writes
  // the ORIGINAL content A again. Every round changes bytes, so the
  // no-progress guard never fires, but the turn is going in circles. The
  // turn-scoped cycle guard must fail closed on the revisited fingerprint.
  test('reviewer repair that oscillates A->B->A trips the cycle guard', () => {
    const tmpDir = makeProjectTempDir('base2-repair-cycle-')
    try {
      const tmpFile = join(tmpDir, 'a.ts')
      const gateFile = normalizeGateFilePath(tmpFile)
      const contentA = 'export const value = 1\n'
      const contentB = 'export const value = 2\n'
      writeFileSync(tmpFile, contentA)
      const base2 = createBase2('default')
      const agentState = { agentId: 'base2' }
      const gen = base2.handleSteps!({
        agentState,
        prompt: 'Make the requested change now please',
        params: {},
      } as any)

      const dirtyStatus = {
        toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
      } as any
      const passingHooks = { toolResult: [{ type: 'json', value: [] }] } as any

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
      expect(gen.next(dirtyStatus).value).toMatchObject({
        toolName: 'run_file_change_hooks',
      })
      expect(gen.next(passingHooks).value).toMatchObject({
        toolName: 'git_status',
      })
      const firstReviewCall = gen.next(dirtyStatus).value
      expect(firstReviewCall).toMatchObject({ toolName: 'spawn_agents' })
      expect(
        gen.next(
          attestedReviewerResult(firstReviewCall, 'BLOCKING', [
            'Fix the edge case.',
          ]) as any,
        ).value,
      ).toMatchObject({ toolName: 'add_message' })
      expect(gen.next().value).toMatchObject({
        toolName: 'spawn_agents',
        input: { agents: [{ agent_type: 'repair-editor' }] },
      })
      const firstFindingIds = (
        agentState as any
      ).base2ActiveWork.openReviewerFindings.map((finding: any) => finding.id)
      // Round 1 really changes bytes (A -> B), so the no-progress guard stays
      // quiet and the loop re-enters validation + review.
      writeFileSync(tmpFile, contentB)
      expect(
        gen.next(completedRepairReceipt(firstFindingIds, [gateFile]) as any)
          .value,
      ).toMatchObject({ toolName: 'git_status' })
      expect(gen.next(dirtyStatus).value).toMatchObject({
        toolName: 'run_file_change_hooks',
      })
      expect((agentState as any).base2ActiveWork.currentPhase).not.toBe(
        'blocked',
      )

      // Round 2: re-enter the loop and review the B snapshot.
      expect(gen.next(passingHooks).value).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
      expect(gen.next().value).toMatchObject({ toolName: 'add_message' })
      expect(gen.next().value).toBe('STEP')
      expect(gen.next({ stepsComplete: true } as any).value).toMatchObject({
        toolName: 'git_status',
      })
      expect(gen.next(dirtyStatus).value).toMatchObject({
        toolName: 'run_file_change_hooks',
      })
      expect(gen.next(passingHooks).value).toMatchObject({
        toolName: 'git_status',
      })
      const secondReviewCall = gen.next(dirtyStatus).value
      expect(secondReviewCall).toMatchObject({ toolName: 'spawn_agents' })
      // A distinct finding text so the condoned-finding filter cannot credit
      // round 1's repair claim as a pass before the cycle guard is reached.
      expect(
        gen.next(
          attestedReviewerResult(secondReviewCall, 'BLOCKING', [
            'Fix the other edge case.',
          ]) as any,
        ).value,
      ).toMatchObject({ toolName: 'add_message' })
      expect(gen.next().value).toMatchObject({
        toolName: 'spawn_agents',
        input: { agents: [{ agent_type: 'repair-editor' }] },
      })
      const secondFindingIds = (
        agentState as any
      ).base2ActiveWork.openReviewerFindings.map((finding: any) => finding.id)
      // Round 2 reverts to the ORIGINAL bytes: the fingerprint changed again
      // (B -> A), so only the turn-scoped cycle set can catch this.
      writeFileSync(tmpFile, contentA)
      expect(
        gen.next(completedRepairReceipt(secondFindingIds, [gateFile]) as any)
          .value,
      ).toMatchObject({ toolName: 'git_status' })
      const afterGuard = gen.next(dirtyStatus)

      // The guard breaks out of the gate loop: no re-validation and no third
      // repair-editor spawn.
      expect(afterGuard.done).toBe(true)
      expect(afterGuard.value).toBeUndefined()
      const activeWork = (agentState as any).base2ActiveWork
      expect(activeWork.lastReviewerGateSkipReason).toBe(
        'reviewer-repair-cycle',
      )
      expect(activeWork.currentPhase).toBe('blocked')
      expect(activeWork.nextRequiredAction).toContain(
        'already visited this turn',
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
    ).toMatchObject({
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
    ).toMatchObject({
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
    expect(
      activeWork.openReviewerFindings.map((finding: any) => finding.id),
    ).toEqual(findingIds)
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
    ).toMatchObject({
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
    ).toMatchObject({
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
      ).toMatchObject({
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
      const next = nextJobs

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
      ).toMatchObject({
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
      const gatePassed = gatePassedJobs

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
      ).toMatchObject({
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
      const next = nextJobs

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
      ).toMatchObject({
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
      const next = nextJobs

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
    ).toMatchObject({
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
    const securityReview = securityReviewJobs
    expect(securityReview.value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'security-reviewer' },
    })
    const prompt = (securityReview.value as any).input.prompt as string
    const snapshotFingerprint = prompt
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

  // RF-4-928ca2ea: gate-level coverage for the SECURITY-reviewer call site of
  // collectParentOwnedRequirementBlockers. A LOOKS_GOOD security receipt whose
  // only requirementCoverage gaps are parent-owned process duties (including
  // one that is parent-owned only via evidence) must credit the security gate
  // without spawning repair-editor.
  test('credits a LOOKS_GOOD security review whose only requirement gaps are parent-owned', () => {
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
    ).toMatchObject({
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
    const afterSecurityPass = gen.next({
      toolResult: [
        {
          type: 'json',
          value: {
            schemaVersion: 1,
            verdict: 'LOOKS_GOOD',
            snapshotFingerprint,
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
            requirementCoverage: [
              { requirement: 'Commit and push', status: 'missing' },
              { requirement: 'Confirm CI/CD is green', status: 'uncertain' },
              // Parent-owned only via evidence; the requirement text alone is
              // in-scope, so the security call site must consult the structured
              // evidence exactly like finalization does.
              {
                requirement: 'Ship remaining workflow steps',
                status: 'missing',
                evidence: [
                  'parent must run full validation gate after this specialist',
                ],
              },
            ],
          },
        },
      ],
    } as any)

    // No repair round was opened for the parent-owned process gaps: the gate
    // credited security review and re-entered the loop instead.
    const afterValue = afterSecurityPass.value as any
    expect(
      afterValue?.toolName === 'spawn_agents' &&
        (afterValue?.input?.agents ?? []).some(
          (agent: { agent_type?: string }) =>
            agent?.agent_type === 'repair-editor',
        ),
    ).toBe(false)
    expect((agentState as any).base2ActiveWork).toMatchObject({
      securityReviewGateDone: true,
      preEditSecurityReviewDone: true,
      securityReviewGateFingerprint: snapshotFingerprint,
    })
    expect((agentState as any).base2ActiveWork.openReviewerBlockers).toEqual([])
    expect((agentState as any).base2ActiveWork.openReviewerFindings).toEqual([])
    expect((agentState as any).base2ActiveWork.currentPhase).not.toBe(
      'repair_loop',
    )
    expect((agentState as any).base2ActiveWork.currentPhase).not.toBe('blocked')
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
    ).toMatchObject({
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
    const securityReview = securityReviewJobs
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
    const revalidationReview = revalidationReviewJobs
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
    ).toMatchObject({
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
    ).toMatchObject({
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
    const securityReview = securityReviewJobs
    expect(securityReview.value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'security-reviewer' },
    })

    const blocked = gen.next({
      toolResult: [{ type: 'json', value: {} }],
    } as any)
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
    ).toMatchObject({
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
    ).toMatchObject({
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
    ).toMatchObject({
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
    ).toMatchObject({
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
        gen.next({
          toolResult: [{ type: 'json', value: { status: '' } }],
        } as any).value,
      ).toMatchObject({
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
      ).toMatchObject({
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
    ).toMatchObject({
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
    ).toMatchObject({
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
    ).toMatchObject({
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
    ).toMatchObject({
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
    ).toMatchObject({
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
    ).toMatchObject({
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

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({
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
    ).toMatchObject({
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
      evidence: [
        'agents/__tests__/base2.test.ts covers the gate behavior change.',
      ],
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
          hookStep.toolName === 'git_status' ? { status: dirtyStatus } : {}
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
    ).toMatchObject({
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
    ).toMatchObject({
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
    expect(
      (agentState as any).base2ActiveWork.gatePassedReviewerVerdict,
    ).not.toBe('NON_BLOCKING')
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
    ).toMatchObject({
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
    ).toMatchObject({
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

  // Feeds the first reviewer result (NON_BLOCKING by default, or BLOCKING when
  // `firstVerdict` is passed so the de-escalation direction can be exercised)
  // and the repair-editor completion receipt, landing on the second (re-review)
  // spawn_agents call. Both verdict classes take the same repair path, so the
  // yield sequence is identical: after the repair receipt the generator yields
  // git_status -> run_file_change_hooks -> spawn_agent_inline (the re-review
  // code-reviewer) -> add_message (pinned active-work, phase awaiting_review) ->
  // STEP, then the next loop iteration drives git_status -> list_jobs ->
  // run_file_change_hooks -> git_status -> spawn_agents (the second review).
  function driveThroughRepairToSecondReview(
    gen: any,
    agentState: any,
    reviewCall: any,
    tmpFile: string,
    gateFile: string,
    findingSummary:
      | string
      | Record<string, unknown>
      | Array<string | Record<string, unknown>>,
    firstVerdict: 'NON_BLOCKING' | 'BLOCKING' = 'NON_BLOCKING',
  ) {
    const firstReview = attestedReviewerResult(
      reviewCall,
      firstVerdict,
      Array.isArray(findingSummary) ? findingSummary : [findingSummary],
    )
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
    const findingIds = (
      agentState as any
    ).base2ActiveWork.openReviewerFindings.map((finding: any) => finding.id)
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
    ).toMatchObject({
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
      expect((agentState as any).base2ActiveWork.currentPhase).toBe(
        'final_response_allowed',
      )
      expect((agentState as any).base2ActiveWork.openReviewerBlockers).toEqual(
        [],
      )
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // RF-1-2ffc3f6b: behavioral coverage for the advisory wiring. A LOOKS_GOOD
  // receipt carrying advisories must (a) persist them (plus advisoryCount) on
  // the durable review receipt and (b) surface the SAME bounded list in the
  // emitted <gate-state> payload, which is the only user-visible advisory
  // surface. Every bound is exercised: a >240-char entry is truncated with
  // '...', inner whitespace is collapsed, empty entries are dropped, and only
  // the first 8 entries survive.
  test('a LOOKS_GOOD receipt with advisories persists and surfaces bounded advisories', () => {
    const { gen, agentState, reviewCall, tmpDir, gateFile } =
      driveToFirstReview()
    try {
      const ansiAdvisory = 'advisory \u001b[31m8\u0000 visible\u007f'
      const advisories = [
        'x'.repeat(300),
        '  spaced\n   advisory  ',
        '',
        'advisory 3',
        'advisory 4',
        'advisory 5',
        'advisory 6',
        'advisory 7',
        // Carries an ANSI escape plus NUL/DEL: the emitter must strip the
        // control bytes while keeping the surrounding visible text.
        ansiAdvisory,
        'advisory 9 dropped',
        'advisory 10 dropped',
      ]
      expect(
        gen.next(
          attestedReviewerResult(
            reviewCall,
            'LOOKS_GOOD',
            [],
            'covered',
            advisories,
          ) as any,
        ).value,
      ).toMatchObject({ toolName: 'git_status' })
      const gatePassed = gen.next({
        toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
      } as any)
      expect(gatePassed.value).toMatchObject({
        toolName: 'add_message',
        input: { role: 'user' },
      })
      // The durable receipt keeps the reviewer's bytes (the persistence path is
      // unchanged); only the emitted <gate-state> text strips control bytes.
      const expectedReceiptAdvisories = [
        `${'x'.repeat(237)}...`,
        'spaced advisory',
        'advisory 3',
        'advisory 4',
        'advisory 5',
        'advisory 6',
        'advisory 7',
        ansiAdvisory,
      ]
      const expectedGateStateAdvisories = [
        ...expectedReceiptAdvisories.slice(0, 7),
        'advisory [31m8 visible',
      ]
      const receipt = (agentState as any).base2ActiveWork.reviewReceipts[0]
      expect(receipt.advisories).toEqual(expectedReceiptAdvisories)
      expect(receipt.advisoryCount).toBe(expectedReceiptAdvisories.length)
      const gateState = parseGateStateBlock(
        (gatePassed.value as any).input.content as string,
      )
      expect(gateState).toMatchObject({
        gate: 'validation/reviewer',
        status: 'passed',
      })
      expect(gateState!.advisories).toEqual(expectedGateStateAdvisories)
      for (const advisory of gateState!.advisories ?? []) {
        expect(/[\u0000-\u001f\u007f]/.test(advisory)).toBe(false)
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // Advisories must also reach the user on the NON-gate-pass paths. On the
  // blocker/repair path no receipt exists yet (recordSuccessfulReviewReceipt
  // only runs once a finalization verdict exists), so the displayed list comes
  // from the shared collector and must apply the same bounds as <gate-state>.
  test('a blocking reviewer round displays bounded advisories without turning them into blockers', () => {
    const { gen, agentState, reviewCall, tmpDir } = driveToFirstReview()
    try {
      const ansiAdvisory = 'advisory \u001b[31m7\u0000 visible\u007f'
      const advisories = [
        'y'.repeat(300),
        '  spaced\n   advisory  ',
        '',
        'advisory 3',
        'advisory 4',
        'advisory 5',
        'advisory 6',
        ansiAdvisory,
        'advisory 8',
        'advisory 9 dropped',
        'advisory 10 dropped',
      ]
      const afterReview = gen.next(
        attestedReviewerResult(
          reviewCall,
          'BLOCKING',
          ['Fix the edge case.'],
          'covered',
          advisories,
        ) as any,
      )
      expect(afterReview.value).toMatchObject({
        toolName: 'add_message',
        input: { role: 'user' },
      })
      const content = (afterReview.value as any).input.content as string
      expect(content).toContain('BLOCKING: Fix the edge case.')
      const lines = content.split('\n')
      const headerIndex = lines.indexOf(
        'Advisories (non-blocking; no change required):',
      )
      expect(headerIndex).toBeGreaterThan(-1)
      const advisoryLines = lines
        .slice(headerIndex + 1)
        .filter((line) => line.startsWith('- '))
      // Exactly 8 bounded lines: the >240-char entry is truncated, inner
      // whitespace is collapsed, the empty entry is dropped, control bytes are
      // stripped, and everything past the 8th entry is discarded.
      expect(advisoryLines).toEqual([
        `- ${'y'.repeat(237)}...`,
        '- spaced advisory',
        '- advisory 3',
        '- advisory 4',
        '- advisory 5',
        '- advisory 6',
        '- advisory [31m7 visible',
        '- advisory 8',
      ])
      for (const line of advisoryLines) {
        expect(/[\u0000-\u001f\u007f]/.test(line)).toBe(false)
      }
      expect(content).not.toContain('advisory 9 dropped')
      // Purely informational: advisories never enter the blocker/finding
      // ledgers, so they cannot drive a repair round or a branch.
      const active = (agentState as any).base2ActiveWork
      const ledgerTexts = [
        ...((active.openReviewerBlockers ?? []) as string[]),
        ...((active.openReviewerFindings ?? []) as Array<{ text: string }>).map(
          (finding) => finding.text,
        ),
      ]
      expect(active.openReviewerBlockers).toEqual([
        'BLOCKING: Fix the edge case.',
      ])
      for (const text of ledgerTexts) {
        expect(text).not.toContain('advisory')
        expect(text).not.toContain('y'.repeat(20))
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('a blocking reviewer round with no advisories keeps the blocker message byte-identical', () => {
    const { gen, reviewCall, tmpDir } = driveToFirstReview()
    try {
      const afterReview = gen.next(
        attestedReviewerResult(reviewCall, 'BLOCKING', [
          'Fix the edge case.',
        ]) as any,
      )
      expect(afterReview.value).toMatchObject({
        toolName: 'add_message',
        input: { role: 'user' },
      })
      const content = (afterReview.value as any).input.content as string
      // No header, no extra blank line: the empty advisory list adds nothing.
      expect(content).toBe(
        [
          'Reviewer gate: code-reviewer returned blocking feedback. The harness will send these exact findings to repair-editor:',
          '',
          'BLOCKING: Fix the edge case.',
          '',
          'These findings remain open until targeted validation and a fresh matching reviewer pass clear them.',
        ].join('\n'),
      )
      expect(content).not.toContain('Advisories')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // T1.5: condoning is keyed on (verdict class, finding identity), not text
  // alone. Under the old text-only key the stored condone entry stripped the
  // NON_BLOCKING/BLOCKING prefix, so re-raising the SAME text at a HIGHER
  // verdict class was swallowed by the condone filter and the gate finalized on
  // an escalation it never repaired.
  test('re-raising a condoned NON_BLOCKING text as BLOCKING is not condoned', () => {
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
      const active = (agentState as any).base2ActiveWork
      // The repair round condoned the NON_BLOCKING class only.
      expect(active.condonedFindingKeys).toContain(
        `NON_BLOCKING::text:${findingText}`,
      )
      expect(active.condonedFindingKeys).not.toContain(
        `BLOCKING::text:${findingText}`,
      )
      // Same text, escalated verdict class: new information, must stay open.
      const secondReview = attestedReviewerResult(
        secondReviewCall,
        'BLOCKING',
        [findingText],
      )
      const afterSecond = gen.next(secondReview as any)
      expect(afterSecond.value).toMatchObject({
        toolName: 'add_message',
        input: { role: 'user' },
      })
      expect((afterSecond.value as any).input.content).toContain(
        `BLOCKING: ${findingText}`,
      )
      expect(active.openReviewerBlockers).toContain(`BLOCKING: ${findingText}`)
      expect(active.currentPhase).not.toBe('final_response_allowed')
      expect(gen.next().value).toMatchObject({
        toolName: 'spawn_agents',
        input: { agents: [{ agent_type: 'repair-editor' }] },
      })
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // Same-class re-raise: a NON_BLOCKING finding already reported as addressed
  // and re-raised as NON_BLOCKING carries no new information, so the loop must
  // converge. (The de-escalation direction is the separate test below.)
  test('a condoned finding re-raised at the same class still converges', () => {
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
      const secondReview = attestedReviewerResult(
        secondReviewCall,
        'NON_BLOCKING',
        [findingText],
      )
      const afterSecond = gen.next(secondReview as any)
      const active = (agentState as any).base2ActiveWork
      expect(active.currentPhase).not.toBe('repair_loop')
      expect(active.currentPhase).not.toBe('blocked')
      // Condoned pass: finalization, not another repair spawn.
      expect(afterSecond.value).toMatchObject({ toolName: 'git_status' })
      const gatePassed = gen.next({
        toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
      } as any)
      expect((gatePassed.value as any).input.content).toMatch(
        /reviewer gate passed with LOOKS_GOOD/i,
      )
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // RF-1/RF-2/RF-8: de-escalation is the mirror of the escalation case above and
  // IS condonable, one-directionally. A finding condoned at BLOCKING and
  // re-raised as a NON_BLOCKING nit carries no new information; if it were not
  // condoned the blocker list would stay non-empty, another repair-editor would
  // be spawned, and the already-applied repair would trip the no-progress guard,
  // leaving the gate 'blocked' instead of converging.
  test('a finding condoned at BLOCKING and re-raised as NON_BLOCKING still converges', () => {
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
        'BLOCKING',
      )
      const active = (agentState as any).base2ActiveWork
      // The repair round condoned the BLOCKING class only; the NON_BLOCKING key
      // is never written, so convergence relies on the de-escalation allowance
      // rather than on a same-class key.
      expect(active.condonedFindingKeys).toContain(
        `BLOCKING::text:${findingText}`,
      )
      expect(active.condonedFindingKeys).not.toContain(
        `NON_BLOCKING::text:${findingText}`,
      )
      // Same identity, DE-ESCALATED verdict class: still condoned.
      const secondReview = attestedReviewerResult(
        secondReviewCall,
        'NON_BLOCKING',
        [findingText],
      )
      const afterSecond = gen.next(secondReview as any)
      expect(active.currentPhase).not.toBe('repair_loop')
      expect(active.currentPhase).not.toBe('blocked')
      // Condoned pass: git_status -> gate-passed add_message, no repair spawn.
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
      expect((agentState as any).base2ActiveWork.currentPhase).toBe(
        'final_response_allowed',
      )
      // The first round's BLOCKING blocker string is cleared by the
      // condoned-pass cleanup rather than left looking open.
      expect((agentState as any).base2ActiveWork.openReviewerBlockers).toEqual(
        [],
      )
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // RF-3: the id half of the condone key only exists for a reviewer-supplied
  // (non-minted) finding id, so a suite that only feeds plain-string findings
  // never executes that push branch. An object finding carrying a stable id
  // must produce `NON_BLOCKING::id:<id>`, a re-raise of that id at BLOCKING
  // must stay open, and a co-reported record-less finding (minted `RF-...` id)
  // must contribute no `::id:` key at all.
  test('an object finding with a stable id records an id-keyed condone key and stays open when re-raised as BLOCKING', () => {
    const findingId = 'code-reviewer:correctness:minor-style'
    const findingText = 'Minor style suggestion.'
    const blockerText = `[${findingId}] ${findingText}`
    const plainFindingText = 'A plain-string nit with no id'
    const objectFinding = {
      id: findingId,
      summary: findingText,
      severity: 'low',
      dimension: 'correctness',
      evidence: ['a.ts uses the expected behavior.'],
      correction: 'Optional naming cleanup.',
    }
    const { gen, agentState, reviewCall, tmpDir, tmpFile, gateFile } =
      driveToFirstReview()
    try {
      const secondReviewCall = driveThroughRepairToSecondReview(
        gen,
        agentState,
        reviewCall,
        tmpFile,
        gateFile,
        [objectFinding, plainFindingText],
      )
      const active = (agentState as any).base2ActiveWork
      const condonedKeys = active.condonedFindingKeys as string[]
      // (a) the reviewer-supplied id produced an id-keyed condone entry.
      expect(condonedKeys).toContain(`NON_BLOCKING::id:${findingId}`)
      expect(condonedKeys).toContain(`NON_BLOCKING::text:${blockerText}`)
      // (c) the record-less finding got a minted RF-... id, which is positional
      // and therefore never keyed on.
      expect(condonedKeys).toContain(`NON_BLOCKING::text:${plainFindingText}`)
      expect(condonedKeys.filter((key) => key.includes('::id:'))).toEqual([
        `NON_BLOCKING::id:${findingId}`,
      ])
      expect(
        condonedKeys.some((key) => /::id:RF-\d+-[0-9a-f]{8}$/.test(key)),
      ).toBe(false)
      // (b) the same identity re-raised at BLOCKING is new information.
      const secondReview = attestedReviewerResult(
        secondReviewCall,
        'BLOCKING',
        [objectFinding, plainFindingText],
      )
      const afterSecond = gen.next(secondReview as any)
      expect(afterSecond.value).toMatchObject({
        toolName: 'add_message',
        input: { role: 'user' },
      })
      expect((afterSecond.value as any).input.content).toContain(
        `BLOCKING: ${blockerText}`,
      )
      expect(active.openReviewerBlockers).toContain(`BLOCKING: ${blockerText}`)
      expect(
        (
          active.openReviewerFindings as Array<{
            id: string
            status: string
          }>
        ).find((finding) => finding.id === findingId)?.status,
      ).toBe('open')
      expect(active.currentPhase).not.toBe('final_response_allowed')
      expect(gen.next().value).toMatchObject({
        toolName: 'spawn_agents',
        input: { agents: [{ agent_type: 'repair-editor' }] },
      })
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // RF-1: the condoned-pass cleanup used to filter openReviewerBlockers by
  // STRIPPED TEXT only. mergeReviewerFindings retains other families' blockers,
  // so a security-reviewer `BLOCKING: <same text>` blocker that was never
  // condoned was silently dropped when the code-reviewer round credited a
  // condoned pass. The cleanup must key on (verdict class, identity) like every
  // other condone decision.
  test('condoned pass keeps another reviewer BLOCKING blocker that shares the condoned text', () => {
    const findingText = 'Minor style suggestion.'
    const securityBlocker = `BLOCKING: ${findingText}`
    const tmpDir = makeProjectTempDir('base2-condoned-cleanup-')
    const tmpFile = join(tmpDir, 'a.ts')
    const gateFile = normalizeGateFilePath(tmpFile)
    writeFileSync(tmpFile, 'export const value = 1\n')
    try {
      const base2 = createBase2('default')
      const agentState = {
        agentId: 'base2-custom',
        base2ActiveWork: {
          touchedFiles: [gateFile],
          changedFiles: [gateFile],
          pendingGateFiles: [gateFile],
          currentPhase: 'awaiting_validation',
          latestWorkSummary: '',
          // Security-reviewer blocker whose text matches the condoned
          // code-reviewer nit byte-for-byte, at the higher verdict class.
          openReviewerBlockers: [securityBlocker],
          openReviewerFindings: [
            {
              id: 'security-reviewer:containment:same-text',
              gateId: 'security-reviewer:prior-snapshot',
              text: securityBlocker,
              status: 'open',
              files: [gateFile],
              snapshotFingerprint: 'prior-snapshot',
              reviewer: 'security-reviewer',
              createdAt: '2025-01-01T00:00:00.000Z',
            },
          ],
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
          // A prior code-reviewer repair round condoned the NON_BLOCKING nit.
          condonedFindingTexts: [findingText],
          condonedFindingKeys: [`NON_BLOCKING::text:${findingText}`],
          // Keep the aux gates out of this turn; only the final gate matters.
          testWriterGateDone: true,
          docWriterGateDone: true,
          securityReviewGateDone: true,
          preEditSecurityReviewDone: true,
          specialistReviewGatesDone: [],
          auxGatesLastPendingFiles: [gateFile],
        },
      }
      const gen = base2.handleSteps!({
        agentState,
        prompt: 'Finish the pending review.',
        params: {},
      } as any)
      expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
      expect(
        gen.next(feedJson({ status: ` M ${gateFile}` })).value,
      ).toMatchObject({ toolName: 'spawn_agent_inline' })
      const maybePinned = gen.next().value
      if (maybePinned !== 'STEP') {
        expect(maybePinned).toMatchObject({ toolName: 'add_message' })
        expect(gen.next().value).toBe('STEP')
      }
      expect(gen.next(finishStepWithToolResult({})).value).toMatchObject({
        toolName: 'git_status',
      })
      expect(
        gen.next(feedJson({ status: ` M ${gateFile}` })).value,
      ).toMatchObject({ toolName: 'run_file_change_hooks' })
      expect(
        gen.next({ toolResult: [{ type: 'json', value: [] }] } as any).value,
      ).toMatchObject({ toolName: 'git_status' })
      const reviewCall = gen.next(feedJson({ status: ` M ${gateFile}` }))
        .value as any
      expect(reviewCall).toMatchObject({ toolName: 'spawn_agents' })
      // Every collected blocker is condoned, so the round credits a condoned
      // pass and runs the cleanup instead of spawning repair-editor.
      const afterReview = gen.next(
        attestedReviewerResult(reviewCall, 'NON_BLOCKING', [
          findingText,
        ]) as any,
      )
      expect(afterReview.value).toMatchObject({ toolName: 'git_status' })
      const active = (agentState as any).base2ActiveWork
      // The never-condoned security blocker survives the cleanup.
      expect(active.openReviewerBlockers).toContain(securityBlocker)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // RF-2: the security/specialist record shape used to store the UNPREFIXED
  // record text, so reviewerVerdictClass returned the `*` wildcard and a repair
  // round recorded `*::text:` / `*::id:` keys. With the old wildcard match those
  // condoned ANY later class, so a security nit re-raised as BLOCKING was
  // swallowed. The record now stores the prefixed blocker string and `*` matches
  // only `*`, so the escalation stays open.
  test('a security finding re-raised at BLOCKING is not condoned by a class-agnostic condone key', () => {
    const findingId = 'security-reviewer:containment:fixture-path'
    const findingText = 'Reject nested fixture paths.'
    const securityFile = 'sdk/src/policy/terminal-command-policy.ts'
    const blocker = `BLOCKING: [${findingId}] ${findingText}`
    const base2 = createBase2('default')
    const agentState = {
      agentId: 'base2',
      base2ActiveWork: {
        touchedFiles: [],
        changedFiles: [],
        pendingGateFiles: [],
        currentPhase: 'idle',
        latestWorkSummary: '',
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
        // A prior repair round condoned this finding as a NON_BLOCKING nit.
        // Both the class-keyed entries and the legacy class-agnostic `*`
        // entries (what the pre-fix security path recorded from its unprefixed
        // record text) are seeded; neither may condone a BLOCKING re-raise.
        condonedFindingTexts: [findingText, `[${findingId}] ${findingText}`],
        condonedFindingKeys: [
          `NON_BLOCKING::text:[${findingId}] ${findingText}`,
          `NON_BLOCKING::id:${findingId}`,
          `*::text:[${findingId}] ${findingText}`,
          `*::text:${findingText}`,
          `*::id:${findingId}`,
        ],
      },
    }
    const gen = base2.handleSteps!({
      agentState,
      prompt: `Update ${securityFile}.`,
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
        toolResult: [{ type: 'json', value: editReceipt(securityFile) }],
      } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const securityReview = gen.next({
      toolResult: [{ type: 'json', value: { status: ` M ${securityFile}` } }],
    } as any)
    expect(securityReview.value).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'security-reviewer' },
    })
    const snapshotFingerprint = (
      (securityReview.value as any).input.prompt as string
    )
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
            reviewedFiles: [securityFile],
            findings: [{ id: findingId, summary: findingText }],
            coverage: 'covered',
            dimensions: {},
            requirementCoverage: [],
          },
        },
      ],
    } as any)

    expect(blockerMessage.value).toMatchObject({ toolName: 'add_message' })
    const active = (agentState as any).base2ActiveWork
    expect(active.openReviewerBlockers).toContain(blocker)
    const escalated = (
      active.openReviewerFindings as Array<{
        id: string
        text: string
        status: string
      }>
    ).find((finding) => finding.id === findingId)
    // The record carries the PREFIXED blocker string, so the derived class is
    // BLOCKING rather than the class-agnostic `*`.
    expect(escalated?.text).toBe(blocker)
    expect(escalated?.status).toBe('open')
    expect(active.currentPhase).toBe('repair_loop')
    expect(gen.next().value).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'repair-editor' }] },
    })
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
      // and push), which must be filtered out via
      // collectParentOwnedRequirementBlockers and must NOT produce a blocker or
      // a repair spawn.
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
      // out by collectParentOwnedRequirementBlockers, so it is never elevated as
      // a blocker. Because a parent-owned row is not repair fuel,
      // collectReviewerBlockers still emits the synthetic NON_BLOCKING
      // empty-findings placeholder, and THAT survives the filter: NON_BLOCKING
      // is not a finalization credit, so an empty surviving list would leave the
      // gate with no repair target and a misdiagnosed no-verdict loop.
      const blockers = (active.openReviewerBlockers ?? []) as string[]
      expect(
        blockers.some((blocker: string) =>
          /BLOCKING:\s*requirement\s+missing:\s*commit and push/i.test(blocker),
        ),
      ).toBe(false)
      expect(blockers).toEqual([
        'NON_BLOCKING: reviewer returned non-blocking nits without findings; re-address and re-review until LOOKS_GOOD',
      ])
      // The surviving placeholder is not a coverage finding, so the gate drives
      // the ordinary repair-editor round instead of burning the no-verdict
      // budget with zero repair targets.
      expect(afterReview.value).toMatchObject({
        toolName: 'add_message',
        input: { role: 'user' },
      })
      expect((afterReview.value as any).input.content).toContain(
        'NON_BLOCKING: reviewer returned non-blocking nits without findings',
      )
      expect(gen.next().value).toMatchObject({
        toolName: 'spawn_agents',
        input: { agents: [{ agent_type: 'repair-editor' }] },
      })
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // T0.2: condone credit is orchestrator-owned evidence, not reviewer/repair
  // self-report. A receipt that lists finding ids but is not `completed` (or
  // changed no files) must not condone anything, so the finding stays open and
  // the next re-review re-elevates it.
  test('blocked repair receipt does not condone the findings it claims to have addressed', () => {
    const findingText = 'Minor style suggestion.'
    const { gen, agentState, reviewCall, tmpDir, tmpFile, gateFile } =
      driveToFirstReview()
    try {
      const firstReview = attestedReviewerResult(reviewCall, 'NON_BLOCKING', [
        findingText,
      ])
      expect(gen.next(firstReview as any).value).toMatchObject({
        toolName: 'add_message',
        input: { role: 'user' },
      })
      expect(gen.next().value).toMatchObject({
        toolName: 'spawn_agents',
        input: { agents: [{ agent_type: 'repair-editor' }] },
      })
      const findingIds = (
        agentState as any
      ).base2ActiveWork.openReviewerFindings.map((finding: any) => finding.id)
      // Real byte change so the no-progress fingerprint guard does not fire for
      // an unrelated reason; the receipt status is what must block condoning.
      writeFileSync(tmpFile, 'export const value = 2 // partially repaired\n')
      const blockedReceipt = repairSpawnReport({
        receiptId: 'repair-blocked-claiming-findings',
        status: 'blocked',
        changedFiles: [{ path: gateFile }],
        findingsAddressed: findingIds,
        value: {
          status: 'blocked',
          changedFiles: [{ path: gateFile }],
          findingsAddressed: findingIds,
        },
      })
      expect(gen.next(blockedReceipt as any).value).toMatchObject({
        toolName: 'git_status',
      })
      // The claim was rejected: nothing is condoned, so the finding stays open.
      expect(
        (agentState as any).base2ActiveWork.condonedFindingTexts ?? [],
      ).toEqual([])
      // Drive the re-review and confirm the same finding still blocks.
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
      expect(gen.next().value).toMatchObject({ toolName: 'add_message' })
      expect(gen.next().value).toBe('STEP')
      expect(
        gen.next({ stepsComplete: true, toolResult: [] } as any).value,
      ).toMatchObject({ toolName: 'git_status' })
      expect(
        gen.next({
          toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
        } as any).value,
      ).toMatchObject({ toolName: 'run_file_change_hooks' })
      expect(
        gen.next({ toolResult: [{ type: 'json', value: [] }] } as any).value,
      ).toMatchObject({ toolName: 'git_status' })
      const secondReviewCall = gen.next({
        toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
      } as any).value as any
      expect(secondReviewCall).toMatchObject({ toolName: 'spawn_agents' })
      const secondReview = attestedReviewerResult(
        secondReviewCall,
        'NON_BLOCKING',
        [findingText],
      )
      const afterSecond = gen.next(secondReview as any)
      expect(afterSecond.value).toMatchObject({
        toolName: 'add_message',
        input: { role: 'user' },
      })
      expect((afterSecond.value as any).input.content).toContain(
        `NON_BLOCKING: ${findingText}`,
      )
      expect(
        (agentState as any).base2ActiveWork.openReviewerBlockers,
      ).toContain(`NON_BLOCKING: ${findingText}`)
      expect(gen.next().value).toMatchObject({
        toolName: 'spawn_agents',
        input: { agents: [{ agent_type: 'repair-editor' }] },
      })
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('completed repair receipt with no changed files does not condone its findings', () => {
    const findingText = 'Minor style suggestion.'
    const { gen, agentState, reviewCall, tmpDir, gateFile } =
      driveToFirstReview()
    try {
      const firstReview = attestedReviewerResult(reviewCall, 'NON_BLOCKING', [
        findingText,
      ])
      expect(gen.next(firstReview as any).value).toMatchObject({
        toolName: 'add_message',
        input: { role: 'user' },
      })
      expect(gen.next().value).toMatchObject({
        toolName: 'spawn_agents',
        input: { agents: [{ agent_type: 'repair-editor' }] },
      })
      const findingIds = (
        agentState as any
      ).base2ActiveWork.openReviewerFindings.map((finding: any) => finding.id)
      // status: 'completed' and every id claimed, but zero changed files: the
      // receipt has no positive evidence, so the claim is rejected.
      const noChangeReceipt = repairSpawnReport({
        receiptId: 'repair-completed-no-changes',
        status: 'completed',
        changedFiles: [],
        findingsAddressed: findingIds,
        value: {
          status: 'completed',
          changedFiles: [],
          findingsAddressed: findingIds,
        },
      })
      expect(gen.next(noChangeReceipt as any).value).toMatchObject({
        toolName: 'git_status',
      })
      expect(
        (agentState as any).base2ActiveWork.condonedFindingTexts ?? [],
      ).toEqual([])
      // The repair changed no bytes, so the no-progress guard blocks the gate
      // instead of crediting a condoned pass.
      gen.next({
        toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
      } as any)
      const active = (agentState as any).base2ActiveWork
      expect(active.condonedFindingTexts ?? []).toEqual([])
      expect(active.currentPhase).not.toBe('final_response_allowed')
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
    ).toMatchObject({
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
    ).toMatchObject({
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
    // edit_transaction and run_terminal_command are implement-tier; every
    // non-core tier is unlocked by default and executePlan opens the terminal
    // mode gate, so both are on the execute-plan surface.
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
    ).toMatchObject({
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
    ).toMatchObject({
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
      ).toMatchObject({
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
      ).toMatchObject({
        toolName: 'run_file_change_hooks',
      })
      expect(
        gen.next({
          toolResult: [{ type: 'json', value: [] }],
        } as any).value,
      ).toMatchObject({ toolName: 'git_status' })
      const reviewCall = gen.next({
        toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
      } as any).value
      expect(reviewCall).toMatchObject({ toolName: 'spawn_agents' })
      expect(
        gen.next(attestedReviewerResult(reviewCall) as any).value,
      ).toMatchObject({ toolName: 'git_status' })
      const gatePassed = gen.next({
        toolResult: [{ type: 'json', value: { status: ` M ${gateFile}` } }],
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
      ).toMatchObject({
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
      ).toMatchObject({
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
      ).toMatchObject({
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

  test('retains a credited-as-deleted file whose stored marker is still missing (no gate loop)', () => {
    // A file deleted in the changeset is credited with marker 'missing'. On a
    // later turn the file is still deleted, so readGateFileContentMarker still
    // returns 'missing' == the stored marker and isCreditableContentMarker
    // accepts it. The credited deletion must NOT be evicted and re-armed on
    // every loop, or the gate would reopen forever on a stable deletion.
    const base2 = createBase2('default')
    const tmpDir = makeProjectTempDir('base2-credit-deleted-')
    const tmpFile = join(tmpDir, 'a.ts')
    try {
      writeFileSync(tmpFile, 'export const value = 1\n')
      const gateFile = normalizeGateFilePath(tmpFile)
      // The file was deleted in the same changeset that was gate-passed, so it
      // is absent from disk now.
      rmSync(tmpFile, { force: true })
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
          // A deletion is credited with the stable 'missing' marker.
          gatePassedFileMarkers: { [gateFile]: 'missing' },
        },
      }
      const gen = base2.handleSteps!({
        agentState,
        prompt: 'Finish the previous response.',
        params: {},
      } as any)

      expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
      // Working-tree deletion: ` D <path>`.
      expect(
        gen.next({
          toolResult: [{ type: 'json', value: { status: ` D ${tmpFile}` } }],
        } as any).value,
      ).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
      // The retain path does not deterministically emit a pinned-state message.
      const maybePinnedState = gen.next().value
      if (maybePinnedState !== 'STEP') {
        expect(maybePinnedState).toMatchObject({ toolName: 'add_message' })
        expect(gen.next().value).toBe('STEP')
      }

      // Stored 'missing' === current 'missing', creditable, so no eviction:
      // the gate is NOT reopened and nothing is republished as unvalidated.
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

  test('evicts a credited-as-deleted file that reappears on disk (fail closed)', () => {
    // A deletion that passes the gate is credited with marker 'missing'. If the
    // same path reappears with content, readGateFileContentMarker returns a
    // present sha256:... marker that no longer matches the stored 'missing', so
    // the file is evicted and the gate reopened for re-review (fail closed).
    const base2 = createBase2('default')
    const tmpDir = makeProjectTempDir('base2-credit-reappear-')
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
          // Credited as deleted in a prior turn, but the file is present now.
          gatePassedFileMarkers: { [gateFile]: 'missing' },
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
      ).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
      expect(gen.next().value).toMatchObject({ toolName: 'add_message' })
      expect(gen.next().value).toBe('STEP')

      // Marker mismatch (present sha256 vs stored 'missing') -> evicted and
      // republished as unvalidated; the gate reopens.
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

  test('evicts a credited-as-deleted file whose current marker becomes non-creditable (fail closed)', () => {
    // 'missing' is creditable only for an actually-deleted file. If the current
    // marker turns into a non-attestable error string (e.g. 'unreadable:...'
    // for an unreadable/symlink-escape/size-0 state), the stored 'missing' no
    // longer matches and the file must be evicted rather than retain credit.
    const base2 = createBase2('default')
    const tmpDir = makeProjectTempDir('base2-credit-noncred-')
    const gateFile = normalizeGateFilePath(join(tmpDir, 'a.ts'))
    try {
      // A directory at the gate path makes readGateFileContentMarker return
      // 'unreadable:not-a-file': a genuinely non-creditable marker that must
      // evict even though 'missing' is now creditable.
      mkdirSync(join(tmpDir, 'a.ts'), { recursive: true })
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
          gatePassedFileMarkers: { [gateFile]: 'missing' },
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
          toolResult: [{ type: 'json', value: { status: ` D ${gateFile}` } }],
        } as any).value,
      ).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
      expect(gen.next().value).toMatchObject({ toolName: 'add_message' })
      expect(gen.next().value).toBe('STEP')

      // Current marker is not 'missing' (the file reads as unreadable/error),
      // so the stale stored-'missing' credit is evicted and republished.
      expect((agentState as any).base2ActiveWork.gatePassedFiles).toEqual([])
      expect((agentState as any).base2ActiveWork.currentPhase).toBe(
        'awaiting_validation',
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
    ).toMatchObject({
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
    const validation = validationJobs
    expect(validation.value).toMatchObject({
      toolName: 'run_file_change_hooks',
    })

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
    expect((review.value as any).input.agents[0]).not.toHaveProperty(
      'background',
    )
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
    ).toMatchObject({
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
    ).toMatchObject({
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
        repairSpawn.input.agents[0].handoff.permissions
          .readablePaths as string[],
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
    ).toMatchObject({
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
    const finalized = finalizedJobs
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

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({
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
    ).toMatchObject({
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
    expect((agentState as any).base2ActiveWork.testWriterGateDone).toBe(true)
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
      !(
        step.toolName === 'run_file_change_hooks' ||
        step.toolName === 'git_status'
      ) &&
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

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
        .value,
    ).toMatchObject({
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
    ).toMatchObject({
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
    expect((agentState as any).base2ActiveWork.testWriterGateDone).toBe(true)
    expect((agentState as any).base2ActiveWork.validationAssurance).toBe(
      'reduced',
    )
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
    ).toMatchObject({
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
    ).toMatchObject({
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
    ).toMatchObject({
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
    ).toMatchObject({
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
    ).toMatchObject({
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
    ).toMatchObject({
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
    ).toMatchObject({
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
    ).toMatchObject({
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
    const securityReview = securityReviewJobs
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
    // The object-finding blocker correlates by [id] to its real record, and the
    // stored text is the PREFIXED blocker string so reviewerVerdictClass can
    // derive the finding's verdict class for condone keying.
    expect(findings[1].id).toBe('security-reviewer:containment:real')
    expect(findings[1].text).toBe(
      'BLOCKING: [security-reviewer:containment:real] Reject nested fixture paths.',
    )
  })

  test('code-reviewer object findings keep their reviewer-supplied id', () => {
    // T1.3: the final code-reviewer path used to mint a content-hash `RF-...`
    // id for EVERY blocker, so a re-raised finding got a fresh id each round
    // while the security and specialist paths already correlated by
    // reviewer-supplied id. An object finding carrying `id` must keep it; a
    // record-less string finding must still fall back to a minted id. The
    // stored text must stay the prefixed blocker string (including the `[id] `
    // segment) because the condone filter and the carried/new derivation both
    // key on it.
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
    expect(
      gen.next({ toolResult: [{ type: 'json', value: [] }] } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const reviewCall = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any).value
    expect(reviewCall).toMatchObject({ toolName: 'spawn_agents' })

    // Attest from the spawn prompt exactly like attestedReviewerResult does,
    // but with an OBJECT finding, which that helper cannot express.
    const reviewPrompt = String(
      (reviewCall as any)?.input?.agents?.[0]?.prompt ?? '',
    )
    const fingerprint =
      reviewPrompt.match(
        /Snapshot fingerprint \(echo exactly\): ([^\n]+)/,
      )?.[1] ?? ''
    const reviewedFiles =
      reviewPrompt
        .match(/(?:Gate-scope|Pending) changed files: ([^\n]+)/)?.[1]
        ?.split(',')
        .map((file: string) => file.trim())
        .filter((file: string) => file && file !== '(unknown)') ?? []
    const reviewerId = 'code-reviewer:src/a.ts:guard'
    const afterReview = gen.next({
      toolResult: [
        {
          type: 'json',
          value: [
            {
              schemaVersion: 1,
              verdict: 'NON_BLOCKING',
              snapshotFingerprint: fingerprint,
              reviewedFiles,
              findings: [
                {
                  id: reviewerId,
                  text: 'Tighten the early-return guard.',
                  severity: 'low',
                  dimension: 'correctness',
                },
                'A plain-string finding with no id',
              ],
              coverage: 'covered',
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
    } as any)
    expect(afterReview.value).toMatchObject({ toolName: 'add_message' })

    const codeReviewerFindings = (agentState as any).base2ActiveWork
      .openReviewerFindings as Array<{ id: string; text: string }>
    expect(codeReviewerFindings).toHaveLength(2)
    const correlated = codeReviewerFindings.find((finding) =>
      finding.text.includes('Tighten the early-return guard.'),
    )
    expect(correlated?.id).toBe(reviewerId)
    expect(correlated?.text).toBe(
      `NON_BLOCKING: [${reviewerId}] Tighten the early-return guard.`,
    )
    const uncorrelated = codeReviewerFindings.find((finding) =>
      finding.text.includes('A plain-string finding with no id'),
    )
    expect(uncorrelated?.id).toMatch(/^RF-/)
    expect(uncorrelated?.text).toBe(
      'NON_BLOCKING: A plain-string finding with no id',
    )
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
      // Process tasks stay in the prompt for non-blocking parent context; keep
      // a non-codebase-intent prompt so there is no query_index prelude.
      const prompt =
        'Please finish the pending reliability finding. Parent will later commit and push then confirm CI/CD is green.'
      const gen = base2.handleSteps!({
        agentState,
        prompt,
        params: {},
      } as any)

      expect(gen.next().value).toMatchObject({
        toolName: 'git_status',
        input: {},
      })
      expect(
        gen.next(feedJson({ status: ` M ${gateFile}` })).value,
      ).toMatchObject({
        toolName: 'spawn_agent_inline',
        input: { agent_type: 'context-pruner' },
      })
      expect(gen.next().value).toMatchObject({ toolName: 'add_message' })
      expect(gen.next().value).toBe('STEP')
      expect(gen.next(finishStepWithToolResult({})).value).toMatchObject({
        toolName: 'git_status',
        input: {},
      })
      const bundle = gen.next(feedJson({ status: ` M ${gateFile}` }))
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
          // The specialist harness supports advisories directly, so this case
          // covers the specialist parent-owned-only pass path (the security
          // pass path is the analogue and is covered by its own gate wiring).
          ['z'.repeat(300), 'specialist advisory 1'],
        ),
      )
      const afterValue = after.value as any
      const isRepairEditorSpawn =
        afterValue?.toolName === 'spawn_agents' &&
        afterValue?.input?.agents?.[0]?.agent_type === 'repair-editor'
      expect(isRepairEditorSpawn).toBe(false)

      expect(afterValue).toMatchObject({
        toolName: 'add_message',
        input: { role: 'user' },
      })
      const parentOwnedContent = afterValue.input.content as string
      expect(parentOwnedContent).toContain(
        'parent-owned process requirements were ignored',
      )
      expect(parentOwnedContent).toContain(
        'Advisories (non-blocking; no change required):',
      )
      expect(parentOwnedContent).toContain(`- ${'z'.repeat(237)}...`)
      expect(parentOwnedContent).toContain('- specialist advisory 1')

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

describe('base2 specialist attestation tolerance', () => {
  // RF-1: a pending path that is DELETED on disk carries a `missing` content
  // marker and cannot be read by the specialist, so it must be
  // attested-by-absence exactly like the final code-reviewer path. Without the
  // deleted set at the specialist call sites the omitted deleted path is a
  // coverage gap, which combined with a stale-snapshot finding escalates to the
  // bundle-refresh retry and then the terminal `could not attest` block.
  test('credits a routed specialist that omits a deleted pending file from reviewedFiles', () => {
    const tmpDir = makeProjectTempDir('base2-specialist-deleted-')
    try {
      const stateDir = join(tmpDir, 'state')
      mkdirSync(stateDir, { recursive: true })
      const presentAbsolute = join(stateDir, 'session.ts')
      writeFileSync(presentAbsolute, 'export const session = "v1"\n')
      const deletedAbsolute = join(stateDir, 'legacy-session.ts')
      writeFileSync(deletedAbsolute, 'export const legacy = "gone"\n')
      rmSync(deletedAbsolute, { force: true })
      const presentFile = normalizeGateFilePath(presentAbsolute)
      const deletedFile = normalizeGateFilePath(deletedAbsolute)
      const pendingFiles = [presentFile, deletedFile]
      const status = ` M ${presentFile}\n D ${deletedFile}`
      const base2 = createBase2('default')
      const agentState = {
        agentId: 'base2-custom',
        base2ActiveWork: {
          changedFiles: pendingFiles,
          touchedFiles: pendingFiles,
          pendingGateFiles: pendingFiles,
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
          auxGatesLastPendingFiles: pendingFiles,
        },
      }
      const gen = base2.handleSteps!({
        agentState,
        prompt: 'Please finish the pending reliability finding.',
        params: {},
      } as any)

      expect(gen.next().value).toMatchObject({
        toolName: 'git_status',
        input: {},
      })
      expect(gen.next(feedJson({ status })).value).toMatchObject({
        toolName: 'spawn_agent_inline',
        input: { agent_type: 'context-pruner' },
      })
      expect(gen.next().value).toMatchObject({ toolName: 'add_message' })
      expect(gen.next().value).toBe('STEP')
      expect(gen.next(finishStepWithToolResult({})).value).toMatchObject({
        toolName: 'git_status',
        input: {},
      })
      const bundle = gen.next(feedJson({ status }))
      expect(bundle.value).toMatchObject({
        toolName: 'get_change_review_bundle',
        input: {},
      })
      const spawn = gen.next(
        feedJson({ snapshotId: 'unit-spec-snap-deleted', files: pendingFiles }),
      )
      expect(spawn.value).toMatchObject({
        toolName: 'spawn_agents',
        input: { agents: [{ agent_type: 'reliability-reviewer' }] },
      })
      const fingerprint = String(
        (spawn.value as any).input.agents[0].params?.snapshot_id ?? '',
      )
      expect(fingerprint).toMatch(/^v3:[a-f0-9]{64}$/)

      // LOOKS_GOOD attesting ONLY the readable file, plus a stale-snapshot
      // finding record. Pre-fix the omitted deleted path was a coverage gap and
      // the stale record escalated to the bundle-refresh retry; now the
      // deletion is attested-by-absence, so the gate credits the specialist and
      // re-enters the loop at context pruning.
      const afterSpecialist = gen.next(
        feedJson({
          agentType: 'reliability-reviewer',
          value: {
            schemaVersion: 1,
            family: 'reviewer',
            verdict: 'LOOKS_GOOD',
            snapshotFingerprint: fingerprint,
            reviewedFiles: [presentFile],
            findings: [
              {
                id: 'reliability-reviewer:correctness:stale-snapshot',
                summary: 'The supplied snapshot is stale and does not match.',
                evidence: ['The current review bundle has a newer snapshot.'],
              },
            ],
            coverage: 'covered',
            dimensions: {},
            requirementCoverage: [],
          },
        }),
      )
      expect(afterSpecialist.value).not.toMatchObject({
        toolName: 'get_change_review_bundle',
      })
      expect(afterSpecialist.value).toMatchObject({
        toolName: 'spawn_agent_inline',
        input: { agent_type: 'context-pruner' },
      })
      const activeWork = (agentState as any).base2ActiveWork
      expect(activeWork.specialistReviewGatesDone).toContain(
        'reliability-reviewer',
      )
      expect(activeWork.currentPhase).not.toBe('blocked')
      expect(activeWork.openReviewerBlockers).toEqual([])
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // RF-2: the specialist path tolerates a coverage-complete review whose
  // well-formed v3 fingerprint does not match the expected snapshot; that
  // tolerated drift must be RECORDED (gate telemetry with dedicated
  // reported/expected keys) rather than accepted silently.
  test('records fingerprint drift for a coverage-complete routed specialist review', () => {
    const tmpDir = makeProjectTempDir('base2-specialist-drift-')
    const telemetry: Array<Record<string, unknown>> = []
    const originalInfo = console.info
    console.info = (...args: unknown[]) => {
      const [first] = args
      if (typeof first === 'string' && first.includes('"base2.gate"')) {
        telemetry.push(JSON.parse(first) as Record<string, unknown>)
      }
    }
    try {
      const stateDir = join(tmpDir, 'state')
      mkdirSync(stateDir, { recursive: true })
      const absoluteFile = join(stateDir, 'session.ts')
      writeFileSync(absoluteFile, 'export const session = "v1"\n')
      const gateFile = normalizeGateFilePath(absoluteFile)
      const driftFingerprint = `v3:${'e'.repeat(64)}`
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
      const gen = base2.handleSteps!({
        agentState,
        prompt: 'Please finish the pending reliability finding.',
        params: {},
      } as any)

      expect(gen.next().value).toMatchObject({
        toolName: 'git_status',
        input: {},
      })
      expect(
        gen.next(feedJson({ status: ` M ${gateFile}` })).value,
      ).toMatchObject({
        toolName: 'spawn_agent_inline',
        input: { agent_type: 'context-pruner' },
      })
      expect(gen.next().value).toMatchObject({ toolName: 'add_message' })
      expect(gen.next().value).toBe('STEP')
      expect(gen.next(finishStepWithToolResult({})).value).toMatchObject({
        toolName: 'git_status',
        input: {},
      })
      const bundle = gen.next(feedJson({ status: ` M ${gateFile}` }))
      expect(bundle.value).toMatchObject({
        toolName: 'get_change_review_bundle',
        input: {},
      })
      const spawn = gen.next(
        feedJson({ snapshotId: 'unit-spec-snap-drift', files: [gateFile] }),
      )
      expect(spawn.value).toMatchObject({
        toolName: 'spawn_agents',
        input: { agents: [{ agent_type: 'reliability-reviewer' }] },
      })
      const expectedFingerprint = String(
        (spawn.value as any).input.agents[0].params?.snapshot_id ?? '',
      )
      expect(expectedFingerprint).toMatch(/^v3:[a-f0-9]{64}$/)
      expect(expectedFingerprint).not.toBe(driftFingerprint)

      const afterSpecialist = gen.next(
        feedJson({
          agentType: 'reliability-reviewer',
          value: {
            schemaVersion: 1,
            family: 'reviewer',
            verdict: 'LOOKS_GOOD',
            snapshotFingerprint: driftFingerprint,
            reviewedFiles: [gateFile],
            findings: [],
            coverage: 'covered',
            dimensions: {},
            requirementCoverage: [],
          },
        }),
      )
      // Drift is tolerated: the specialist is credited and the loop re-enters.
      expect(afterSpecialist.value).toMatchObject({
        toolName: 'spawn_agent_inline',
        input: { agent_type: 'context-pruner' },
      })
      expect(
        (agentState as any).base2ActiveWork.specialistReviewGatesDone,
      ).toContain('reliability-reviewer')

      const driftEvents = telemetry.filter(
        (event) => event.reviewerStatus === 'attestation-fingerprint-drift',
      )
      expect(driftEvents).toHaveLength(1)
      expect(driftEvents[0]).toMatchObject({
        event: 'base2.gate',
        reviewer: 'reliability-reviewer',
        reportedFingerprint: driftFingerprint,
        expectedFingerprint,
        pendingFiles: [gateFile],
      })
      expect(driftEvents[0]!.reuseReason).toBeUndefined()
    } finally {
      console.info = originalInfo
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('base2 reviewer round-findings telemetry', () => {
  // One `round-findings` event per code-reviewer round. new-vs-carried is
  // derived from the PERSISTED openReviewerFindings ledger (read before
  // mergeReviewerFindings overwrites it), so a repeated finding text is
  // reported as carried rather than new. The shadow-mode suppression fields
  // are logged only: the gate still blocks and spawns repair.
  test('emits one round-findings event per round and carries repeated finding text', () => {
    const tmpDir = makeProjectTempDir('base2-round-findings-')
    const tmpFile = join(tmpDir, 'a.ts')
    const gateFile = normalizeGateFilePath(tmpFile)
    writeFileSync(tmpFile, 'export const value = 1\n')
    const findingText = 'Minor style suggestion.'
    const telemetry: Array<Record<string, unknown>> = []
    const originalInfo = console.info
    console.info = (...args: unknown[]) => {
      const [first] = args
      if (typeof first === 'string' && first.includes('"base2.gate"')) {
        telemetry.push(JSON.parse(first) as Record<string, unknown>)
      }
    }
    try {
      const base2 = createBase2('default')
      const agentState = { agentId: 'base2-custom' }
      const gen = base2.handleSteps!({
        agentState,
        prompt: 'Make the requested change now please',
        params: {},
      } as any)

      expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
      expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
      expect(gen.next().value).toBe('STEP')
      expect(
        gen.next(finishStepWithToolResult(editReceipt(gateFile))).value,
      ).toMatchObject({ toolName: 'git_status' })
      expect(
        gen.next(feedJson({ status: ` M ${gateFile}` })).value,
      ).toMatchObject({ toolName: 'run_file_change_hooks' })
      expect(gen.next(feedJson([])).value).toMatchObject({
        toolName: 'git_status',
      })
      const firstReviewCall = gen.next(feedJson({ status: ` M ${gateFile}` }))
        .value as any
      expect(firstReviewCall).toMatchObject({ toolName: 'spawn_agents' })

      // Round 1: one NON_BLOCKING finding with nothing persisted yet.
      expect(
        gen.next(
          attestedReviewerResult(firstReviewCall, 'NON_BLOCKING', [
            findingText,
          ]) as any,
        ).value,
      ).toMatchObject({ toolName: 'add_message' })
      const firstRoundEvents = telemetry.filter(
        (event) => event.reviewerStatus === 'round-findings',
      )
      expect(firstRoundEvents).toHaveLength(1)
      expect(firstRoundEvents[0]).toMatchObject({
        event: 'base2.gate',
        reviewer: 'code-reviewer',
        repairRound: 1,
        findingCount: 1,
        rawFindingCount: 1,
        newFindingCount: 1,
        carriedFindingCount: 0,
        pendingFileCount: 1,
        // Shadow mode: a threshold that dropped every suppressible finding
        // would have passed this round. Logged only — see the blocker
        // assertion below.
        suppressibleFindingCount: 1,
        wouldPassAtThisRound: true,
      })
      expect(
        Number(firstRoundEvents[0]!.newFindingCount) +
          Number(firstRoundEvents[0]!.carriedFindingCount),
      ).toBe(Number(firstRoundEvents[0]!.findingCount))
      // Observation only: the shadow fields did not unblock the gate.
      expect(
        (agentState as any).base2ActiveWork.openReviewerBlockers,
      ).toContain(`NON_BLOCKING: ${findingText}`)

      expect(gen.next().value).toMatchObject({
        toolName: 'spawn_agents',
        input: { agents: [{ agent_type: 'repair-editor' }] },
      })
      // Progress-only receipt: real bytes change (so the no-progress guard
      // passes) but no finding id is claimed, so nothing is condoned and the
      // same text legitimately returns as CARRIED next round.
      writeFileSync(tmpFile, 'export const value = 2 // touched\n')
      expect(
        gen.next(progressOnlyRepairReceipt([gateFile]) as any).value,
      ).toMatchObject({ toolName: 'git_status' })
      expect(
        gen.next(feedJson({ status: ` M ${gateFile}` })).value,
      ).toMatchObject({ toolName: 'run_file_change_hooks' })
      expect(
        gen.next(
          feedJson([{ hookName: 'typecheck', exitCode: 0, stdout: 'ok' }]),
        ).value,
      ).toMatchObject({ toolName: 'spawn_agent_inline' })
      expect(gen.next().value).toMatchObject({ toolName: 'add_message' })
      expect(gen.next().value).toBe('STEP')
      expect(
        gen.next({ stepsComplete: true, toolResult: [] } as any).value,
      ).toMatchObject({ toolName: 'git_status' })
      expect(
        gen.next(feedJson({ status: ` M ${gateFile}` })).value,
      ).toMatchObject({ toolName: 'run_file_change_hooks' })
      expect(gen.next(feedJson([])).value).toMatchObject({
        toolName: 'git_status',
      })
      const secondReviewCall = gen.next(feedJson({ status: ` M ${gateFile}` }))
        .value as any
      expect(secondReviewCall).toMatchObject({ toolName: 'spawn_agents' })

      // Round 2 returns the SAME finding text: the comparison reads the
      // persisted round-1 records, so it is CARRIED, not new.
      expect(
        gen.next(
          attestedReviewerResult(secondReviewCall, 'NON_BLOCKING', [
            findingText,
          ]) as any,
        ).value,
      ).toMatchObject({ toolName: 'add_message' })
      const roundEvents = telemetry.filter(
        (event) => event.reviewerStatus === 'round-findings',
      )
      expect(roundEvents).toHaveLength(2)
      expect(roundEvents[1]).toMatchObject({
        reviewer: 'code-reviewer',
        repairRound: 2,
        findingCount: 1,
        newFindingCount: 0,
      })
      expect(
        Number(roundEvents[1]!.carriedFindingCount),
      ).toBeGreaterThanOrEqual(1)
      expect(
        Number(roundEvents[1]!.newFindingCount) +
          Number(roundEvents[1]!.carriedFindingCount),
      ).toBe(Number(roundEvents[1]!.findingCount))
    } finally {
      console.info = originalInfo
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

// T1.2(c): the reviewer is stateless across repair rounds, so a re-review
// packet carries a ledger of the findings a prior round already reported as
// addressed. Built only from already-persisted state
// (reviewerRepairRoundCount / openReviewerFindings).
describe('base2 reviewer re-review round ledger', () => {
  /** Seeded gate state parked right before the final code-reviewer spawn. */
  function seededReviewState(
    gateFile: string,
    overrides: Partial<Record<string, unknown>>,
  ) {
    return {
      touchedFiles: [gateFile],
      changedFiles: [gateFile],
      pendingGateFiles: [gateFile],
      currentPhase: 'awaiting_validation',
      latestWorkSummary: '',
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
      // Keep the aux gates out of the way: only the final gate matters here.
      testWriterGateDone: true,
      docWriterGateDone: true,
      securityReviewGateDone: true,
      preEditSecurityReviewDone: true,
      specialistReviewGatesDone: [],
      auxGatesLastPendingFiles: [gateFile],
      ...overrides,
    }
  }

  /** Drive a seeded turn to the final code-reviewer spawn and return its prompt. */
  function driveSeededStateToReviewPrompt(
    gateFile: string,
    activeWork: Record<string, unknown>,
  ): string {
    const base2 = createBase2('default')
    const gen = base2.handleSteps!({
      agentState: { agentId: 'base2-custom', base2ActiveWork: activeWork },
      prompt: 'Finish the pending review.',
      params: {},
      config: base2.programmaticConfig,
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next(feedJson({ status: ` M ${gateFile}` })).value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    const maybePinned = gen.next().value
    if (maybePinned !== 'STEP') {
      expect(maybePinned).toMatchObject({ toolName: 'add_message' })
      expect(gen.next().value).toBe('STEP')
    }
    expect(gen.next(finishStepWithToolResult({})).value).toMatchObject({
      toolName: 'git_status',
    })
    expect(
      gen.next(feedJson({ status: ` M ${gateFile}` })).value,
    ).toMatchObject({ toolName: 'run_file_change_hooks' })
    expect(gen.next(feedJson([])).value).toMatchObject({
      toolName: 'git_status',
    })
    const reviewCall = gen.next(feedJson({ status: ` M ${gateFile}` }))
      .value as any
    expect(reviewCall).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'code-reviewer' }] },
    })
    return String(reviewCall.input.agents[0].prompt)
  }

  function codeReviewerFinding(text: string, index: number) {
    return {
      id: `RF-${index + 1}-0000000${index}`,
      gateId: 'code-reviewer:prior-snapshot',
      text,
      status: 'open' as const,
      files: ['src/a.ts'],
      snapshotFingerprint: 'prior-snapshot',
      reviewer: 'code-reviewer' as const,
      createdAt: '2025-01-01T00:00:00.000Z',
    }
  }

  test('round 0 (first review) adds no ledger at all', () => {
    const base2 = createBase2('default')
    const gen = base2.handleSteps!({
      agentState: { agentId: 'base2-custom' },
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next(finishStepWithToolResult(editReceipt('src/a.ts'))).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(gen.next(feedJson({ status: ' M src/a.ts' })).value).toMatchObject({
      toolName: 'run_file_change_hooks',
    })
    expect(gen.next(feedJson([])).value).toMatchObject({
      toolName: 'git_status',
    })
    const reviewCall = gen.next(feedJson({ status: ' M src/a.ts' }))
      .value as any
    const prompt = String(reviewCall.input.agents[0].prompt)

    expect(prompt).not.toContain('Repair round:')
    expect(prompt).not.toContain('This is a re-review')
    expect(prompt).not.toContain('repeated VERBATIM')
    // No stray blank line either: the validation summary is immediately
    // followed by the bounded-read instruction, exactly as before.
    expect(prompt).toContain(
      'Validation gate summary: No configured file-change hooks ran.\nRead large files via read_files windows',
    )
  })

  test('a re-review emits the round line, the verbatim re-raise rule, and its own findings verbatim', () => {
    const tmpDir = makeProjectTempDir('base2-ledger-rereview-')
    try {
      const gateFile = normalizeGateFilePath(join(tmpDir, 'a.ts'))
      writeFileSync(join(tmpDir, 'a.ts'), 'export const value = 1\n')
      const codeFindings = [
        codeReviewerFinding('NON_BLOCKING: Tighten the early-return guard.', 0),
        codeReviewerFinding(
          'BLOCKING: [code-reviewer:tests:missing-case] Add a case for the empty payload.',
          1,
        ),
      ]
      const securityFinding = {
        id: 'security-reviewer:containment:fixture-path',
        gateId: 'security-reviewer:prior-snapshot',
        text: 'BLOCKING: [security-reviewer:containment:fixture-path] Reject nested fixture paths.',
        status: 'open' as const,
        files: [gateFile],
        snapshotFingerprint: 'prior-snapshot',
        reviewer: 'security-reviewer' as const,
        createdAt: '2025-01-01T00:00:00.000Z',
      }
      const prompt = driveSeededStateToReviewPrompt(
        gateFile,
        seededReviewState(gateFile, {
          reviewerRepairRoundCount: 2,
          // Code-reviewer records first so the rehydrated owed-set keeps the
          // final block on the code-reviewer family.
          openReviewerFindings: [...codeFindings, securityFinding],
        }),
      )

      expect(prompt).toContain('Repair round: 2. This is a re-review.')
      expect(prompt).toContain(
        'Findings raised earlier and reported addressed are listed below. Verify each is genuinely fixed and cite the line that fixes it. If a fix is wrong or incomplete, re-raise the finding with its ORIGINAL text repeated VERBATIM and put your reason on a separate line: the gate matches re-raises by exact text (and by stable finding id when you supplied one), so a reworded re-raise is treated as a brand-new finding and the repair loop cannot converge.',
      )
      // Verbatim rendering: the NON_BLOCKING:/BLOCKING: prefix and the `[id] `
      // segment are exactly what the condone matcher compares against.
      expect(prompt).toContain(
        '  - NON_BLOCKING: Tighten the early-return guard.',
      )
      expect(prompt).toContain(
        '  - BLOCKING: [code-reviewer:tests:missing-case] Add a case for the empty payload.',
      )
      // Another reviewer family's finding must not leak into this packet.
      expect(prompt).not.toContain('Reject nested fixture paths.')
      expect(prompt).not.toContain('more earlier findings omitted')
      // The ledger sits immediately after the validation summary line.
      const lines = prompt.split('\n')
      const summaryIndex = lines.findIndex((line) =>
        line.startsWith('Validation gate summary: '),
      )
      expect(lines[summaryIndex + 1]).toBe(
        'Repair round: 2. This is a re-review.',
      )
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('caps the ledger at 12 entries and reports how many were omitted', () => {
    const tmpDir = makeProjectTempDir('base2-ledger-cap-')
    try {
      const gateFile = normalizeGateFilePath(join(tmpDir, 'a.ts'))
      writeFileSync(join(tmpDir, 'a.ts'), 'export const value = 1\n')
      const openReviewerFindings = Array.from(
        { length: 14 },
        (_unused, index) =>
          codeReviewerFinding(`NON_BLOCKING: Finding number ${index}.`, index),
      )
      const prompt = driveSeededStateToReviewPrompt(
        gateFile,
        seededReviewState(gateFile, {
          reviewerRepairRoundCount: 3,
          openReviewerFindings,
        }),
      )

      const bullets = prompt
        .split('\n')
        .filter((line) => line.startsWith('  - '))
      // 12 findings plus the single omitted-count bullet.
      expect(bullets).toHaveLength(13)
      expect(bullets[0]).toBe('  - NON_BLOCKING: Finding number 0.')
      expect(bullets[11]).toBe('  - NON_BLOCKING: Finding number 11.')
      expect(bullets[12]).toBe('  - (+2 more earlier findings omitted)')
      expect(prompt).not.toContain('Finding number 12.')
      expect(prompt).not.toContain('Finding number 13.')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('emits only the round line when no finding belongs to this reviewer', () => {
    const tmpDir = makeProjectTempDir('base2-ledger-empty-')
    try {
      const gateFile = normalizeGateFilePath(join(tmpDir, 'a.ts'))
      writeFileSync(join(tmpDir, 'a.ts'), 'export const value = 1\n')
      const prompt = driveSeededStateToReviewPrompt(
        gateFile,
        seededReviewState(gateFile, {
          reviewerRepairRoundCount: 1,
          openReviewerFindings: [
            {
              id: 'security-reviewer:containment:fixture-path',
              gateId: 'security-reviewer:prior-snapshot',
              text: 'BLOCKING: Reject nested fixture paths.',
              status: 'open' as const,
              files: [gateFile],
              snapshotFingerprint: 'prior-snapshot',
              reviewer: 'security-reviewer' as const,
              createdAt: '2025-01-01T00:00:00.000Z',
            },
          ],
        }),
      )

      expect(prompt).toContain('Repair round: 1. This is a re-review.')
      expect(prompt).not.toContain('repeated VERBATIM')
      expect(prompt.split('\n').some((line) => line.startsWith('  - '))).toBe(
        false,
      )
      expect(prompt).not.toContain('Reject nested fixture paths.')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('base2 emitGateTelemetry durable sink recorder', () => {
  /**
   * Drive a gate-disabled turn to its skip diagnostic (which emits telemetry).
   *
   * Mirrors the drive sequence and handleSteps argument shape of the passing
   * test 'fast/no-validation mode skips file-change hooks and reviewer after
   * edits', with the single difference that the caller-supplied `params` is
   * passed instead of `params: {}`. In particular NO `config` key is passed:
   * createBase2('fast').programmaticConfig carries `hasNoValidation: false`,
   * and handleSteps prefers an explicit boolean `config.hasNoValidation` over
   * the `base2-fast` agentId allowlist, so supplying the config would turn the
   * validation/reviewer gate back ON and never reach the skip diagnostic.
   */
  function driveDisabledGateTurn(params: Record<string, unknown>) {
    const base2 = createBase2('fast')
    const agentState = { agentId: 'base2-fast' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Make the requested change now please',
      params,
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    expect(gen.next().value).toBe('STEP')
    expect(
      gen.next(finishStepWithToolResult(editReceipt('src/a.ts'))).value,
    ).toMatchObject({ toolName: 'git_status' })
    return gen.next(feedJson({ status: ' M src/a.ts' }))
  }

  test('forwards the same undefined-stripped payload to the injected recorder and console.info', () => {
    const recorded: Array<Record<string, unknown>> = []
    const logged: string[] = []
    const originalInfo = console.info
    console.info = (...args: unknown[]) => {
      const [first] = args
      if (typeof first === 'string' && first.includes('"base2.gate"')) {
        logged.push(first)
      }
    }
    try {
      const skipDiagnostic = driveDisabledGateTurn({
        orchestrationControlPlane: {
          recordGateTelemetry: (payload: Record<string, unknown>) => {
            recorded.push(payload)
          },
        },
      })

      expect(skipDiagnostic.value).toMatchObject({ toolName: 'add_message' })
      expect(recorded).toHaveLength(1)
      // Keys/values verified against the gates-disabled skip site in
      // agents/base2/base2.ts (currentPhase/pendingFileCount/pendingFiles/
      // reviewerStatus/validationStatus/skipReason) plus the `event:
      // 'base2.gate'` key emitGateTelemetry prepends.
      expect(recorded[0]).toMatchObject({
        event: 'base2.gate',
        pendingFiles: ['src/a.ts'],
        pendingFileCount: 1,
        reviewerStatus: 'skipped',
        validationStatus: 'skipped',
        skipReason: 'validation-and-reviewer-gates-disabled',
      })
      // Undefined-stripped: keys whose value was undefined never appear.
      expect(
        Object.values(recorded[0]).every((value) => value !== undefined),
      ).toBe(true)
      // console.info still logs, and it logs the SAME object.
      expect(logged).toHaveLength(1)
      expect(JSON.parse(logged[0])).toEqual(recorded[0])
    } finally {
      console.info = originalInfo
    }
  })

  test('behaves exactly as before when no recorder is injected', () => {
    const logged: string[] = []
    const originalInfo = console.info
    console.info = (...args: unknown[]) => {
      const [first] = args
      if (typeof first === 'string' && first.includes('"base2.gate"')) {
        logged.push(first)
      }
    }
    try {
      const skipDiagnostic = driveDisabledGateTurn({})
      expect(skipDiagnostic.value).toMatchObject({ toolName: 'add_message' })
      expect(logged).toHaveLength(1)
      expect(JSON.parse(logged[0])).toMatchObject({
        event: 'base2.gate',
        skipReason: 'validation-and-reviewer-gates-disabled',
      })
    } finally {
      console.info = originalInfo
    }
  })

  test('a throwing recorder never throws out of the gate loop', () => {
    const logged: string[] = []
    const originalInfo = console.info
    console.info = (...args: unknown[]) => {
      const [first] = args
      if (typeof first === 'string' && first.includes('"base2.gate"')) {
        logged.push(first)
      }
    }
    try {
      const skipDiagnostic = driveDisabledGateTurn({
        orchestrationControlPlane: {
          recordGateTelemetry: () => {
            throw new Error('sink exploded')
          },
        },
      })
      // The gate continued to its skip diagnostic instead of surfacing the
      // error.
      expect(skipDiagnostic.value).toMatchObject({
        toolName: 'add_message',
        input: { role: 'user' },
      })
      expect((skipDiagnostic.value as any).input.content).toContain(
        'validation-and-reviewer-gates-disabled',
      )
      // The pre-existing console.info channel survives a throwing sink.
      expect(logged).toHaveLength(1)
      expect(JSON.parse(logged[0])).toMatchObject({
        event: 'base2.gate',
        skipReason: 'validation-and-reviewer-gates-disabled',
      })
    } finally {
      console.info = originalInfo
    }
  })

  test('a failing console emit still reaches the durable sink', () => {
    const recorded: Array<Record<string, unknown>> = []
    const originalInfo = console.info
    // Stands in for every way the console leg can fail — a host console that
    // throws, or a JSON.stringify that throws on a circular/BigInt payload.
    // Narrowed to the gate line so unrelated console.info callers on the drive
    // path are unaffected.
    console.info = (...args: unknown[]) => {
      const [first] = args
      if (typeof first === 'string' && first.includes('"base2.gate"')) {
        throw new Error('console exploded')
      }
    }
    try {
      const skipDiagnostic = driveDisabledGateTurn({
        orchestrationControlPlane: {
          recordGateTelemetry: (payload: Record<string, unknown>) => {
            recorded.push(payload)
          },
        },
      })

      expect(skipDiagnostic.value).toMatchObject({ toolName: 'add_message' })
      // The durable sink line is preserved even though the console leg failed.
      expect(recorded).toHaveLength(1)
      expect(recorded[0]).toMatchObject({
        event: 'base2.gate',
        skipReason: 'validation-and-reviewer-gates-disabled',
      })
    } finally {
      console.info = originalInfo
    }
  })
})

type InlineEmitGateTelemetry = (payload: Record<string, unknown>) => void

// emitGateTelemetry lives inside the serialized handleSteps generator and is
// only reachable through the gate loop, whose call sites never pass an `event`
// key. Reconstruct it with stub `params` / `mutableAgentState` bindings so the
// after-the-copy-loop discriminator guard can be asserted directly (the
// analogous `recordedAt` guard is covered by
// common/src/util/__tests__/gate-telemetry.test.ts).
function loadInlineEmitGateTelemetry(
  recordGateTelemetry: (payload: Record<string, unknown>) => void,
  transitionBase2Gate?: (input: { current: unknown; phase: string }) => unknown,
): InlineEmitGateTelemetry {
  const base2Source = readFileSync(
    new URL('../base2/base2.ts', import.meta.url),
    'utf8',
  )
  // handleSteps helpers are TypeScript; transpile before new Function (plain JS).
  const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' })
  const combinedJs = transpiler.transformSync(
    [
      extractInlineFunctionSource(base2Source, 'emitGateTelemetry'),
      'return emitGateTelemetry',
    ].join('\n'),
  )
  const buildHelper = new Function(
    'params',
    'mutableAgentState',
    `"use strict";\n${combinedJs}`,
  ) as (
    params: unknown,
    mutableAgentState: Record<string, unknown>,
  ) => InlineEmitGateTelemetry

  return buildHelper(
    {
      orchestrationControlPlane: {
        recordGateTelemetry,
        ...(transitionBase2Gate ? { transitionBase2Gate } : {}),
      },
    },
    {},
  )
}

describe('base2 inline emitGateTelemetry discriminator guard', () => {
  test('a payload key named `event` cannot override the base2.gate discriminator', () => {
    const recorded: Array<Record<string, unknown>> = []
    const logged: string[] = []
    const emitGateTelemetry = loadInlineEmitGateTelemetry((payload) => {
      recorded.push(payload)
    })
    const originalInfo = console.info
    console.info = (...args: unknown[]) => {
      const [first] = args
      if (typeof first === 'string' && first.includes('"base2.gate"')) {
        logged.push(first)
      }
    }
    try {
      emitGateTelemetry({
        event: 'attacker-supplied',
        skipReason: 'inline-discriminator-guard',
        reviewerStatus: undefined,
      })
    } finally {
      console.info = originalInfo
    }

    // `safePayload.event` is assigned AFTER the undefined-stripping copy loop,
    // so the payload key is overridden instead of winning.
    expect(recorded).toHaveLength(1)
    expect(recorded[0].event).toBe('base2.gate')
    expect(recorded[0].skipReason).toBe('inline-discriminator-guard')
    // Undefined-stripping still applies to the rest of the payload.
    expect('reviewerStatus' in recorded[0]).toBe(false)
    // console.info logs the SAME overridden discriminator.
    expect(logged).toHaveLength(1)
    expect(JSON.parse(logged[0])).toEqual(recorded[0])
  })
})

describe('base2 inline emitGateTelemetry transition isolation', () => {
  test('a rejected phase transition still records the payload and logs it', () => {
    const recorded: Array<Record<string, unknown>> = []
    const logged: string[] = []
    // base2GateWorkflowV1 throws on an illegal transition (e.g. 'repair_loop'
    // from the default 'idle'). That throw must not cost us the telemetry for
    // the very event that reported the illegal phase.
    const emitGateTelemetry = loadInlineEmitGateTelemetry(
      (payload) => {
        recorded.push(payload)
      },
      () => {
        throw new Error('illegal transition: idle -> repair_loop')
      },
    )
    const originalInfo = console.info
    console.info = (...args: unknown[]) => {
      const [first] = args
      if (typeof first === 'string' && first.includes('"base2.gate"')) {
        logged.push(first)
      }
    }
    try {
      emitGateTelemetry({
        currentPhase: 'repair_loop',
        skipReason: 'inline-transition-throw',
      })
    } finally {
      console.info = originalInfo
    }

    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({
      event: 'base2.gate',
      currentPhase: 'repair_loop',
      skipReason: 'inline-transition-throw',
    })
    // The pre-existing console.info channel survives the throw too, and both
    // channels still share one payload object.
    expect(logged).toHaveLength(1)
    expect(JSON.parse(logged[0])).toEqual(recorded[0])
  })
})

type InlineGateStateBlockHelpers = {
  formatGateStateBlock: (
    gate: 'validation' | 'reviewer' | 'validation/reviewer',
    status: 'passed' | 'failed' | 'skipped',
    details: string,
    repairRound?: number,
    advisories?: string[],
    workflow?: {
      completedCount: number
      totalCount: number
      nextWorkflowAction: string
    },
  ) => string
  extractGateStateBlocksFromMessage: (message: unknown) => Array<{
    gate: string
    status: string
    details: string
    repairRound?: number
    maxRepairRounds?: number
  }>
}

// Both helpers live inside the serialized handleSteps generator, so reconstruct
// them (plus collectMessageText, which the reader walks messages with) with a
// stub MAX_REPAIR_ROUNDS binding. That pairs the PRODUCER with base2's OWN
// conversation-gate-reuse READER, which is what a truncated block would break.
function loadInlineGateStateBlockHelpers(): InlineGateStateBlockHelpers {
  const base2Source = readFileSync(
    new URL('../base2/base2.ts', import.meta.url),
    'utf8',
  )
  const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' })
  const combinedJs = transpiler.transformSync(
    [
      extractInlineFunctionSource(base2Source, 'formatGateStateBlock'),
      // formatGateStateBlock bounds its advisories through this shared helper,
      // which the reviewer/security/specialist add_message surfaces also call.
      // Reconstructing the producer without it throws at call time.
      extractInlineFunctionSource(base2Source, 'boundAdvisoryLines'),
      // Same contract for the declared-workflow bounds helper: the producer
      // calls it unconditionally (it is what decides whether to emit the
      // optional `workflow` key at all), so omitting it here throws
      // `boundWorkflowProgress is not defined` on every call, not only on the
      // calls that pass workflow progress.
      extractInlineFunctionSource(base2Source, 'boundWorkflowProgress'),
      extractInlineFunctionSource(
        base2Source,
        'extractGateStateBlocksFromMessage',
      ),
      extractInlineFunctionSource(base2Source, 'collectMessageText'),
      'return { formatGateStateBlock, extractGateStateBlocksFromMessage }',
    ].join('\n'),
  )
  const buildHelpers = new Function(
    'MAX_REPAIR_ROUNDS',
    `"use strict";\n${combinedJs}`,
  ) as (maxRepairRounds: number) => InlineGateStateBlockHelpers

  return buildHelpers(Number.POSITIVE_INFINITY)
}

describe('base2 inline formatGateStateBlock delimiter safety', () => {
  test('reviewer-authored text carrying the closing delimiter cannot truncate the block', () => {
    const { formatGateStateBlock, extractGateStateBlocksFromMessage } =
      loadInlineGateStateBlockHelpers()
    const hostileAdvisory =
      'advisory quoting </gate-state> from the persisted format'
    const block = formatGateStateBlock(
      'validation/reviewer',
      'passed',
      'reviewer quoted </gate-state> in details; pending files: a.ts',
      0,
      [hostileAdvisory],
    )

    // Exactly one closing delimiter survives in the emitted bytes: the real
    // terminator at the very end. The payload copies are escaped as `<\/`.
    expect(block.split('</gate-state>')).toHaveLength(2)
    expect(block.endsWith('</gate-state>')).toBe(true)
    expect(block).toContain('<\\/gate-state>')

    // base2's own conversation-gate-reuse reader still sees the whole record,
    // and JSON.parse restores the quoted delimiter byte-for-byte.
    const states = extractGateStateBlocksFromMessage({
      role: 'user',
      content: block,
    })
    expect(states).toHaveLength(1)
    expect(states[0]!).toMatchObject({
      gate: 'validation/reviewer',
      status: 'passed',
      repairRound: 0,
    })
    expect(states[0]!.details).toContain('</gate-state>')

    // The same bytes round-trip through the CLI-facing parse shape too.
    const parsed = parseGateStateBlock(block)
    expect(parsed?.advisories).toEqual([hostileAdvisory])
  })
})

describe('base2 gate-pass continuation directive', () => {
  /** write_todos tool-call + successful tool result, the fixture shape the
   * existing workflow-todo-progress cases use. */
  function writeTodosHistory(
    todos: Array<{ content: string; status: string }>,
  ) {
    return [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'todos-1',
            toolName: 'write_todos',
            input: { todos },
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
  }

  /** Drive one edit through validation + code-reviewer to the gate-pass
   * add_message and return its content. */
  function driveToGatePassMessage(agentState: Record<string, unknown>): string {
    const base2 = createBase2('default')
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Make the requested change now please',
      params: {},
      config: base2.programmaticConfig,
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    const maybePinned = gen.next().value
    if (maybePinned !== 'STEP') {
      expect(maybePinned).toMatchObject({ toolName: 'add_message' })
      expect(gen.next().value).toBe('STEP')
    }
    expect(
      gen.next(finishStepWithToolResult(editReceipt('src/a.ts'))).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(gen.next(feedJson({ status: ' M src/a.ts' })).value).toMatchObject({
      toolName: 'run_file_change_hooks',
    })
    expect(gen.next(feedJson([])).value).toMatchObject({
      toolName: 'git_status',
    })
    const reviewCall = gen.next(feedJson({ status: ' M src/a.ts' }))
      .value as any
    expect(reviewCall).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'code-reviewer' }] },
    })
    expect(
      gen.next(attestedReviewerResult(reviewCall) as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const gatePassed = gen.next(feedJson({ status: ' M src/a.ts' }))
    expect(gatePassed.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    return (gatePassed.value as any).input.content as string
  }

  test('with no incomplete workflow todos the gate-pass notice is unchanged', () => {
    const content = driveToGatePassMessage({ agentId: 'base2-custom' })

    // The original notice text is load-bearing for prompt/gate snapshots.
    expect(content).toContain(
      'Provide your single user-visible completion summary now',
    )
    expect(content).toContain(
      'Do not make more edits unless absolutely necessary; any new edits will rerun the gate.',
    )
    // ...and no continuation directive is emitted.
    expect(content).not.toContain('Next workflow action:')
    expect(content).not.toContain('declared workflow still has remaining items')
    expect(content).not.toContain('Default behavior: continue with that next')
  })

  test('with an incomplete workflow todo the gate-pass notice tells the agent to continue this turn', () => {
    const content = driveToGatePassMessage({
      agentId: 'base2-custom',
      messageHistory: writeTodosHistory([
        { content: 'Implement wave 1 of the refactor', status: 'completed' },
        { content: 'Implement wave 2 of the refactor', status: 'pending' },
      ]),
    })

    expect(content).toContain(
      'The gate passed for the current edits, but your declared workflow still has remaining items: Completed 1/2.',
    )
    expect(content).toContain(
      'Next workflow action: Implement wave 2 of the refactor',
    )
    expect(content).toContain(
      'Default behavior: continue with that next workflow item in this same turn instead of finalizing.',
    )
    // A re-armed gate is the concern that currently makes the model stop, so it
    // is addressed explicitly.
    expect(content).toContain(
      'New edits will re-arm the validation/reviewer gate.',
    )
    // Stopping early is allowed but must be stated with a concrete reason.
    expect(content).toContain(
      'you MUST say so explicitly in your completion summary and state the concrete reason',
    )
    expect(content).toContain(
      'Silently finalizing with incomplete declared todos is not acceptable.',
    )
    // The original single-summary / suggest_followups-last ordering still
    // applies when it does finalize.
    expect(content).toContain('Write at most one completion summary per turn.')
    expect(content).toContain(
      'Call suggest_followups only as the absolute last tool after that summary',
    )
  })

  test('DEFAULT step prompt carries the write_todos continuation directive; fast mode does not', () => {
    const base2 = createBase2('default')
    expect(base2.stepPrompt).toContain(
      'a passing validation/reviewer gate is not a stopping point',
    )
    expect(base2.stepPrompt).toContain(
      'continue through the remaining declared items in this same turn',
    )

    const fast = createBase2('fast')
    expect(fast.stepPrompt).not.toContain(
      'a passing validation/reviewer gate is not a stopping point',
    )
  })

  test('EXECUTE_PLAN step prompt continues to the next plan task without relaxing one-in_progress', () => {
    const executePlan = createBase2('default', { executePlan: true })

    expect(executePlan.stepPrompt).toContain(
      'claim the next actionable task and keep executing in this same turn',
    )
    expect(executePlan.stepPrompt).toContain(
      'one in_progress at a time, never claiming several at once',
    )
    expect(executePlan.stepPrompt).toContain(
      'naming the task ID you reached and what remains',
    )
    // It also inherits the shared DEFAULT-mode directive.
    expect(executePlan.stepPrompt).toContain(
      'a passing validation/reviewer gate is not a stopping point',
    )
  })

  // The soft continuation directive above is prompt prose; the machine-readable
  // <gate-state> block must ALSO report the outstanding declared work, so a
  // consumer can tell a finalized-with-work-remaining turn from a clean one.
  test('the gate-pass <gate-state> block carries workflow progress when declared work remains', () => {
    const content = driveToGatePassMessage({
      agentId: 'base2-custom',
      messageHistory: writeTodosHistory([
        { content: 'Implement wave 1 of the refactor', status: 'completed' },
        { content: 'Implement wave 2 of the refactor', status: 'pending' },
        { content: 'Add focused tests', status: 'pending' },
      ]),
    })

    const gateState = parseGateStateBlock(content)
    expect(gateState).toMatchObject({
      gate: 'validation/reviewer',
      status: 'passed',
    })
    expect(gateState!.workflow).toEqual({
      completedCount: 1,
      totalCount: 3,
      nextWorkflowAction: 'Implement wave 2 of the refactor',
    })
  })

  // completedCount < totalCount is the load-bearing guard: emitting on equality
  // would report a finished workflow as incomplete on every clean turn. The
  // payload must stay byte-identical to the pre-field output here.
  test('the workflow key is absent when every declared todo is complete', () => {
    const content = driveToGatePassMessage({
      agentId: 'base2-custom',
      messageHistory: writeTodosHistory([
        { content: 'Implement wave 1 of the refactor', status: 'completed' },
        { content: 'Implement wave 2 of the refactor', status: 'completed' },
      ]),
    })

    expect(parseGateStateBlock(content)!.workflow).toBeUndefined()
    expect(content).not.toContain('"workflow"')
  })

  test('the workflow key is absent when no declared workflow progress exists', () => {
    const content = driveToGatePassMessage({ agentId: 'base2-custom' })

    expect(parseGateStateBlock(content)!.workflow).toBeUndefined()
    expect(content).not.toContain('"workflow"')
  })

  test('the workflow key is absent when the next workflow action is blank', () => {
    // Seeded rather than driven through write_todos: a whitespace-only todo
    // content is dropped by the extractor, so a progress record that is
    // genuinely incomplete yet carries a blank action can only arrive from
    // normalized serialized state.
    const content = driveToGatePassMessage({
      agentId: 'base2-custom',
      base2ActiveWork: {
        touchedFiles: [],
        changedFiles: [],
        pendingGateFiles: [],
        currentPhase: 'idle',
        latestWorkSummary: '',
        openReviewerBlockers: [],
        lastValidationSummary: '',
        nextRequiredAction: '',
        lastPinnedStateMessage: '',
        workflowTodoProgress: {
          todos: [
            { content: 'Wave 1', status: 'completed', completed: true },
            { content: '   ', status: 'pending', completed: false },
          ],
          completedCount: 1,
          totalCount: 2,
          nextWorkflowAction: '   ',
        },
      },
    })

    expect(parseGateStateBlock(content)!.workflow).toBeUndefined()
    expect(content).not.toContain('"workflow"')
  })

  test('the workflow action is truncated at 240 characters', () => {
    const content = driveToGatePassMessage({
      agentId: 'base2-custom',
      messageHistory: writeTodosHistory([
        { content: 'Implement wave 1 of the refactor', status: 'completed' },
        { content: 'x'.repeat(300), status: 'pending' },
      ]),
    })

    const workflow = parseGateStateBlock(content)!.workflow
    expect(workflow).toEqual({
      completedCount: 1,
      totalCount: 2,
      nextWorkflowAction: `${'x'.repeat(237)}...`,
    })
    expect(workflow!.nextWorkflowAction).toHaveLength(240)
  })

  // Model-authored text flows into the CLI's <text> renderer, so an unstripped
  // ESC could spoof terminal output.
  test('control characters are stripped from the workflow action', () => {
    const content = driveToGatePassMessage({
      agentId: 'base2-custom',
      messageHistory: writeTodosHistory([
        { content: 'Implement wave 1 of the refactor', status: 'completed' },
        {
          content: 'continue \u001b[31mwave 2\u0000\tnow\u007f',
          status: 'pending',
        },
      ]),
    })

    const workflow = parseGateStateBlock(content)!.workflow
    expect(workflow!.nextWorkflowAction).toBe('continue [31mwave 2 now')
    expect(/[\u0000-\u001f\u007f]/.test(workflow!.nextWorkflowAction)).toBe(
      false,
    )
  })
})

describe('base2 reviewer skip via the durable receipt ledger', () => {
  /** Durable review receipt in the shape recordSuccessfulReviewReceipt writes. */
  function reviewReceiptFor(params: {
    reviewer: string
    snapshotFingerprint: string
    reviewedFiles: string[]
    verdict?: 'LOOKS_GOOD' | 'NON_BLOCKING'
    /**
     * Defaults to the gate-computed `${reviewer}:${snapshotFingerprint}` id
     * recordSuccessfulReviewReceipt writes. Overridden to model a receipt whose
     * reviewer-REPORTED `snapshotFingerprint` drifted from the fingerprint base2
     * computed for that review, which the attestation path tolerates.
     */
    gateId?: string
  }) {
    const {
      reviewer,
      snapshotFingerprint,
      reviewedFiles,
      verdict = 'LOOKS_GOOD',
      gateId = `${reviewer}:${snapshotFingerprint}`,
    } = params
    return {
      gateId,
      reviewer,
      verdict,
      snapshotFingerprint,
      reviewedFiles,
      reviewedFileCount: reviewedFiles.length,
      dimensions: {},
      findings: [],
      findingCount: 0,
      requirementCoverage: [],
      requirementCoverageCount: 0,
      recordedAt: '2025-01-01T00:00:00.000Z',
    }
  }

  /**
   * Gate state parked mid-gate on one pending reviewable file, with the aux
   * gates already credited so only the FINAL reviewer decision runs.
   */
  function reviewerSkipSeedState(
    gateFile: string,
    overrides: Partial<Record<string, unknown>>,
  ) {
    return {
      touchedFiles: [gateFile],
      changedFiles: [gateFile],
      pendingGateFiles: [gateFile],
      currentPhase: 'awaiting_validation',
      latestWorkSummary: '',
      openReviewerBlockers: [],
      openReviewerFindings: [],
      lastValidationSummary: '',
      nextRequiredAction: '',
      lastPinnedStateMessage: '',
      gatePassedFiles: [],
      gatePassedFileMarkers: {},
      gatePassedPendingFiles: [],
      gatePassedReviewerVerdict: '',
      gatePassedValidationSummary: '',
      gatePassedFingerprint: '',
      reviewedReviewableFingerprint: '',
      lastReviewerGateSkipReason: '',
      reviewReceipts: [],
      testWriterGateDone: true,
      docWriterGateDone: true,
      securityReviewGateDone: true,
      preEditSecurityReviewDone: true,
      specialistReviewGatesDone: [],
      auxGatesLastPendingFiles: [gateFile],
      ...overrides,
    }
  }

  /** Drive a seeded turn to the yield that follows the reviewer-skip decision. */
  function driveToReviewerDecision(
    gateFile: string,
    activeWork: Record<string, unknown>,
  ) {
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2-custom', base2ActiveWork: activeWork }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Finish the pending review.',
      params: {},
      config: base2.programmaticConfig,
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next(feedJson({ status: ` M ${gateFile}` })).value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    const maybePinned = gen.next().value
    if (maybePinned !== 'STEP') {
      expect(maybePinned).toMatchObject({ toolName: 'add_message' })
      expect(gen.next().value).toBe('STEP')
    }
    expect(gen.next(finishStepWithToolResult({})).value).toMatchObject({
      toolName: 'git_status',
    })
    expect(
      gen.next(feedJson({ status: ` M ${gateFile}` })).value,
    ).toMatchObject({ toolName: 'run_file_change_hooks' })
    expect(gen.next(feedJson([])).value).toMatchObject({
      toolName: 'git_status',
    })
    const decision = gen.next(feedJson({ status: ` M ${gateFile}` }))
    return { gen, agentState, decision }
  }

  function seedReviewableFile(prefix: string) {
    const tmpDir = makeProjectTempDir(prefix)
    const tmpFile = join(tmpDir, 'a.ts')
    writeFileSync(tmpFile, 'export const value = 1\n')
    const gateFile = normalizeGateFilePath(tmpFile)
    return {
      tmpDir,
      gateFile,
      // Same construction as the gate's reviewable fingerprint:
      // hashGateSnapshotDetails(buildGateSnapshotDetails(reviewable, '')).
      reviewableFingerprint: buildFingerprint(
        [{ file: gateFile, contentMarker: buildContentMarker(tmpFile) }],
        '',
      ),
    }
  }

  test('a matching receipt skips the reviewer even when the scalar holds a later-wave fingerprint', () => {
    // Wave 1 reviewed {A}, wave 2 reviewed {C}, so the single scalar holds only
    // fingerprint({C}). A later cycle that re-arms on the unchanged {A} set
    // must reuse the durable receipt instead of re-spawning the reviewer.
    const { tmpDir, gateFile, reviewableFingerprint } = seedReviewableFile(
      'base2-reviewer-skip-receipt-',
    )
    const telemetry: Array<Record<string, unknown>> = []
    const originalInfo = console.info
    console.info = (...args: unknown[]) => {
      const [first] = args
      if (typeof first === 'string' && first.includes('"base2.gate"')) {
        telemetry.push(JSON.parse(first) as Record<string, unknown>)
      }
    }
    try {
      const { gen, agentState, decision } = driveToReviewerDecision(
        gateFile,
        reviewerSkipSeedState(gateFile, {
          reviewedReviewableFingerprint: `v3:${'a'.repeat(64)}`,
          reviewReceipts: [
            reviewReceiptFor({
              reviewer: 'code-reviewer',
              snapshotFingerprint: reviewableFingerprint,
              reviewedFiles: [gateFile],
            }),
          ],
        }),
      )

      // The reviewer was NOT spawned; the gate reported the skip instead.
      expect(decision.value).toMatchObject({
        toolName: 'add_message',
        input: { role: 'user' },
      })
      const content = (decision.value as any).input.content as string
      expect(content).toContain(
        'Reviewer gate skipped (reviewer skip: reviewable source set unchanged since last review)',
      )
      const gateState = parseGateStateBlock(content)
      expect(gateState).toMatchObject({ gate: 'reviewer', status: 'skipped' })
      expect(gateState!.details).toContain(
        'reviewer-skip-reviewable-set-unchanged',
      )
      expect(gateState!.details).toContain(gateFile)
      expect(
        telemetry.some(
          (event) =>
            event.reviewerStatus === 'skipped' &&
            event.skipReason === 'reviewer-skip-reviewable-set-unchanged',
        ),
      ).toBe(true)

      // The rest of the gate finalizes directly: no code-reviewer spawn at all.
      const afterSkip = gen.next()
      expect(afterSkip.value).toMatchObject({ toolName: 'git_status' })
      const gatePassed = gen.next(feedJson({ status: ` M ${gateFile}` }))
      expect(gatePassed.value).toMatchObject({
        toolName: 'add_message',
        input: { role: 'user' },
      })
      expect((gatePassed.value as any).input.content).toMatch(
        /reviewer gate passed with LOOKS_GOOD/i,
      )
      expect((agentState as any).base2ActiveWork.currentPhase).toBe(
        'final_response_allowed',
      )
    } finally {
      console.info = originalInfo
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('a matching receipt plus a matching scalar still skips the reviewer (no regression)', () => {
    const { tmpDir, gateFile, reviewableFingerprint } = seedReviewableFile(
      'base2-reviewer-skip-scalar-',
    )
    try {
      const { decision } = driveToReviewerDecision(
        gateFile,
        reviewerSkipSeedState(gateFile, {
          reviewedReviewableFingerprint: reviewableFingerprint,
          reviewReceipts: [
            reviewReceiptFor({
              reviewer: 'code-reviewer',
              snapshotFingerprint: reviewableFingerprint,
              reviewedFiles: [gateFile],
            }),
          ],
        }),
      )

      expect(decision.value).toMatchObject({
        toolName: 'add_message',
        input: { role: 'user' },
      })
      const content = (decision.value as any).input.content as string
      expect(content).toContain(
        'reviewer skip: reviewable source set unchanged since last review',
      )
      expect(parseGateStateBlock(content)!.details).toContain(
        'reviewer-skip-reviewable-set-unchanged',
      )
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('a non-attestable reviewable fingerprint never grants a receipt-based skip (fail closed)', () => {
    // With no collision-resistant hash available, hashGateSnapshotDetails
    // returns the STABLE sentinel 'unreadable:no-crypto'. Every receipt
    // predicate then matches trivially, so only the attestability guard keeps
    // the gate from treating a stable error string as content evidence.
    const tmpDir = makeProjectTempDir('base2-reviewer-skip-no-crypto-')
    const originalGetBuiltinModule = (process as any).getBuiltinModule
    const originalRequire = (globalThis as any).require
    try {
      const tmpFile = join(tmpDir, 'a.ts')
      writeFileSync(tmpFile, 'export const value = 1\n')
      const gateFile = normalizeGateFilePath(tmpFile)
      const nonAttestableFingerprint = 'unreadable:no-crypto'
      // Remove both module loaders the inline hasher probes.
      ;(process as any).getBuiltinModule = undefined
      ;(globalThis as any).require = undefined
      const { decision } = driveToReviewerDecision(
        gateFile,
        reviewerSkipSeedState(gateFile, {
          reviewedReviewableFingerprint: nonAttestableFingerprint,
          reviewReceipts: [
            reviewReceiptFor({
              reviewer: 'code-reviewer',
              snapshotFingerprint: nonAttestableFingerprint,
              reviewedFiles: [gateFile],
            }),
          ],
        }),
      )

      expect(decision.value).toMatchObject({
        toolName: 'spawn_agents',
        input: { agents: [{ agent_type: 'code-reviewer' }] },
      })
      // Self-check that the current fingerprint really is the non-attestable
      // marker, so the spawn is caused by the attestability guard.
      expect((decision.value as any).input.agents[0].prompt).toContain(
        `Snapshot fingerprint (echo exactly): ${nonAttestableFingerprint}`,
      )
    } finally {
      ;(process as any).getBuiltinModule = originalGetBuiltinModule
      ;(globalThis as any).require = originalRequire
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // The persisted `snapshotFingerprint` is REVIEWER-REPORTED and drift-tolerated
  // by the attestation path, so it is not content evidence on its own. Only the
  // gate-computed `gateId` (`${reviewer}:${expectedFingerprint}`) may buy a skip.
  test('a receipt whose gate-computed gateId does not match still spawns the reviewer', () => {
    const { tmpDir, gateFile, reviewableFingerprint } = seedReviewableFile(
      'base2-reviewer-skip-reported-only-',
    )
    try {
      const { decision } = driveToReviewerDecision(
        gateFile,
        reviewerSkipSeedState(gateFile, {
          reviewReceipts: [
            reviewReceiptFor({
              reviewer: 'code-reviewer',
              // The reviewer REPORTED the current reviewable fingerprint...
              snapshotFingerprint: reviewableFingerprint,
              reviewedFiles: [gateFile],
              // ...but base2 computed a different fingerprint for that review,
              // so the gate-computed receipt id does not attest these bytes.
              gateId: `code-reviewer:v3:${'b'.repeat(64)}`,
            }),
          ],
        }),
      )

      expect(decision.value).toMatchObject({
        toolName: 'spawn_agents',
        input: { agents: [{ agent_type: 'code-reviewer' }] },
      })
      expect((decision.value as any).input.agents[0].prompt).toContain(
        `Snapshot fingerprint (echo exactly): ${reviewableFingerprint}`,
      )
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('a receipt whose reviewedFiles or reviewer family differs still spawns the reviewer', () => {
    const { tmpDir, gateFile, reviewableFingerprint } = seedReviewableFile(
      'base2-reviewer-skip-mismatch-',
    )
    try {
      // Same fingerprint and count, different reviewed file set.
      const mismatchedFiles = driveToReviewerDecision(
        gateFile,
        reviewerSkipSeedState(gateFile, {
          reviewedReviewableFingerprint: reviewableFingerprint,
          reviewReceipts: [
            reviewReceiptFor({
              reviewer: 'code-reviewer',
              snapshotFingerprint: reviewableFingerprint,
              reviewedFiles: ['src/other.ts'],
            }),
          ],
        }),
      )
      expect(mismatchedFiles.decision.value).toMatchObject({
        toolName: 'spawn_agents',
        input: { agents: [{ agent_type: 'code-reviewer' }] },
      })

      // A security-reviewer receipt can never satisfy the code-reviewer gate.
      const mismatchedFamily = driveToReviewerDecision(
        gateFile,
        reviewerSkipSeedState(gateFile, {
          reviewedReviewableFingerprint: reviewableFingerprint,
          reviewReceipts: [
            reviewReceiptFor({
              reviewer: 'security-reviewer',
              snapshotFingerprint: reviewableFingerprint,
              reviewedFiles: [gateFile],
            }),
          ],
        }),
      )
      expect(mismatchedFamily.decision.value).toMatchObject({
        toolName: 'spawn_agents',
        input: { agents: [{ agent_type: 'code-reviewer' }] },
      })
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('base2 EXECUTE_PLAN gate-issued plan-task receipts', () => {
  /** update_plan_status tool call plus its paired tool result. */
  function planStatusHistory(
    input: Record<string, unknown>,
    result: Record<string, unknown> = { message: 'Updated 1 task line(s).' },
  ) {
    return [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'plan-1',
            toolName: 'update_plan_status',
            input: {
              path: '.agents/sessions/demo/PLAN.md',
              ...input,
            },
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'plan-1',
        toolName: 'update_plan_status',
        content: [{ type: 'json', value: result }],
      },
    ]
  }

  /**
   * Run a turn far enough for the turn-start extraction to publish the claimed
   * plan task, then read it back off durable gate state.
   */
  function claimedTaskAfterTurn(params: {
    messageHistory?: unknown[]
    seededActivePlanTaskId?: string
  }): string | undefined {
    const base2 = createBase2('default', { executePlan: true })
    const agentState: Record<string, unknown> = {
      agentId: 'base2-execute-plan',
      ...(params.messageHistory
        ? { messageHistory: params.messageHistory }
        : {}),
      ...(params.seededActivePlanTaskId
        ? {
            base2ActiveWork: {
              activePlanTaskId: params.seededActivePlanTaskId,
            },
          }
        : {}),
    }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Continue the plan.',
      params: {},
      config: base2.programmaticConfig,
    } as any)
    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    return (agentState as any).base2ActiveWork.activePlanTaskId
  }

  /** Drive one reviewable edit through validation + code-reviewer to the gate pass. */
  function driveToPlanGatePass(params: {
    gateFile: string
    agentState: Record<string, unknown>
  }): { content: string; reviewFingerprint: string } {
    const base2 = createBase2('default', { executePlan: true })
    const gen = base2.handleSteps!({
      agentState: params.agentState,
      prompt: 'Continue the plan.',
      params: {},
      config: base2.programmaticConfig,
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    const maybePinned = gen.next().value
    if (maybePinned !== 'STEP') {
      expect(maybePinned).toMatchObject({ toolName: 'add_message' })
      expect(gen.next().value).toBe('STEP')
    }
    expect(
      gen.next(finishStepWithToolResult(editReceipt(params.gateFile))).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next(feedJson({ status: ` M ${params.gateFile}` })).value,
    ).toMatchObject({ toolName: 'run_file_change_hooks' })
    expect(gen.next(feedJson([])).value).toMatchObject({
      toolName: 'git_status',
    })
    const reviewCall = gen.next(feedJson({ status: ` M ${params.gateFile}` }))
      .value as any
    expect(reviewCall).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'code-reviewer' }] },
    })
    const reviewFingerprint =
      String(reviewCall.input.agents[0].prompt).match(
        /Snapshot fingerprint \(echo exactly\): ([^\n]+)/,
      )?.[1] ?? ''
    expect(
      gen.next(attestedReviewerResult(reviewCall) as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const gatePassed = gen.next(feedJson({ status: ` M ${params.gateFile}` }))
    expect(gatePassed.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    return {
      content: (gatePassed.value as any).input.content as string,
      reviewFingerprint,
    }
  }

  /**
   * Same gate pass, but for a NON-reviewable pending file so the final reviewer
   * is skipped. That is the only way to reach a gate pass while the snapshot
   * fingerprint is non-attestable: a reviewer can never attest one, so the
   * spawn path would block on attestation instead of passing.
   */
  function driveToGatePassViaReviewerSkip(params: {
    gateFile: string
    agentState: Record<string, unknown>
  }): string {
    const base2 = createBase2('default', { executePlan: true })
    const gen = base2.handleSteps!({
      agentState: params.agentState,
      prompt: 'Continue the plan.',
      params: {},
      config: base2.programmaticConfig,
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    const maybePinned = gen.next().value
    if (maybePinned !== 'STEP') {
      expect(maybePinned).toMatchObject({ toolName: 'add_message' })
      expect(gen.next().value).toBe('STEP')
    }
    expect(
      gen.next(finishStepWithToolResult(editReceipt(params.gateFile))).value,
    ).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next(feedJson({ status: ` M ${params.gateFile}` })).value,
    ).toMatchObject({ toolName: 'run_file_change_hooks' })
    expect(gen.next(feedJson([])).value).toMatchObject({
      toolName: 'git_status',
    })
    const reviewerSkip = gen.next(feedJson({ status: ` M ${params.gateFile}` }))
    expect(reviewerSkip.value).toMatchObject({ toolName: 'add_message' })
    expect((reviewerSkip.value as any).input.content).toContain(
      'Reviewer gate skipped',
    )
    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    const gatePassed = gen.next(feedJson({ status: ` M ${params.gateFile}` }))
    expect(gatePassed.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    return (gatePassed.value as any).input.content as string
  }

  function seedIdleGateState(
    overrides: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      touchedFiles: [],
      changedFiles: [],
      pendingGateFiles: [],
      currentPhase: 'idle',
      latestWorkSummary: '',
      openReviewerBlockers: [],
      lastValidationSummary: '',
      nextRequiredAction: '',
      lastPinnedStateMessage: '',
      ...overrides,
    }
  }

  /**
   * Gate state parked mid-gate on one already-pending file, with the aux gates
   * credited so only the FINAL validation + code-reviewer decision runs. Unlike
   * seedIdleGateState + a fresh edit, resuming a seeded pending file records NO
   * change this turn, which is the only way to observe the mint's idempotent
   * same-receiptId branch (a re-recorded change to a covered file supersedes the
   * receipt first).
   */
  function seedPendingGateState(
    gateFile: string,
    overrides: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      touchedFiles: [gateFile],
      changedFiles: [gateFile],
      pendingGateFiles: [gateFile],
      currentPhase: 'awaiting_validation',
      latestWorkSummary: '',
      openReviewerBlockers: [],
      openReviewerFindings: [],
      lastValidationSummary: '',
      nextRequiredAction: '',
      lastPinnedStateMessage: '',
      gatePassedFiles: [],
      gatePassedFileMarkers: {},
      gatePassedPendingFiles: [],
      gatePassedReviewerVerdict: '',
      gatePassedValidationSummary: '',
      gatePassedFingerprint: '',
      reviewedReviewableFingerprint: '',
      lastReviewerGateSkipReason: '',
      reviewReceipts: [],
      testWriterGateDone: true,
      docWriterGateDone: true,
      securityReviewGateDone: true,
      preEditSecurityReviewDone: true,
      specialistReviewGatesDone: [],
      auxGatesLastPendingFiles: [gateFile],
      ...overrides,
    }
  }

  /** Resume a seeded pending file through validation + review to the gate pass. */
  function driveSeededPendingGatePass(params: {
    gateFile: string
    agentState: Record<string, unknown>
  }): { content: string; reviewFingerprint: string } {
    const base2 = createBase2('default', { executePlan: true })
    const gen = base2.handleSteps!({
      agentState: params.agentState,
      prompt: 'Continue the plan.',
      params: {},
      config: base2.programmaticConfig,
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(
      gen.next(feedJson({ status: ` M ${params.gateFile}` })).value,
    ).toMatchObject({ toolName: 'spawn_agent_inline' })
    const maybePinned = gen.next().value
    if (maybePinned !== 'STEP') {
      expect(maybePinned).toMatchObject({ toolName: 'add_message' })
      expect(gen.next().value).toBe('STEP')
    }
    expect(gen.next(finishStepWithToolResult({})).value).toMatchObject({
      toolName: 'git_status',
    })
    expect(
      gen.next(feedJson({ status: ` M ${params.gateFile}` })).value,
    ).toMatchObject({ toolName: 'run_file_change_hooks' })
    expect(gen.next(feedJson([])).value).toMatchObject({
      toolName: 'git_status',
    })
    const reviewCall = gen.next(feedJson({ status: ` M ${params.gateFile}` }))
      .value as any
    expect(reviewCall).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'code-reviewer' }] },
    })
    const reviewFingerprint =
      String(reviewCall.input.agents[0].prompt).match(
        /Snapshot fingerprint \(echo exactly\): ([^\n]+)/,
      )?.[1] ?? ''
    expect(
      gen.next(attestedReviewerResult(reviewCall) as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const gatePassed = gen.next(feedJson({ status: ` M ${params.gateFile}` }))
    expect(gatePassed.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    return {
      content: (gatePassed.value as any).input.content as string,
      reviewFingerprint,
    }
  }

  /** Live gate-issued plan-task receipt ledger published on durable gate state. */
  function planTaskReceiptsOf(
    agentState: Record<string, unknown>,
  ): Array<Record<string, unknown>> {
    return (agentState as any).base2ActiveWork.planTaskGateReceipts as Array<
      Record<string, unknown>
    >
  }

  /**
   * Drive a turn only as far as the turn-start bookkeeping (hydration, credited
   * file eviction, plan-task receipt content verification), which all runs right
   * after the first git_status result is fed back.
   */
  function driveToTurnStartBookkeeping(
    agentState: Record<string, unknown>,
    status = '',
  ): void {
    const base2 = createBase2('default', { executePlan: true })
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Continue the plan.',
      params: {},
      config: base2.programmaticConfig,
    } as any)
    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    gen.next(feedJson({ status }))
  }

  test('an explicit currentTask pointer is normalized to its stable ID token', () => {
    // "<ID> <prose>" is a legitimate pointer shape, and validatePlanTransition
    // matches it against a task id by prefix, so the claim must store the ID.
    expect(
      claimedTaskAfterTurn({
        messageHistory: planStatusHistory({
          currentTask: 'P2-T3 Implement the thing',
          updates: [{ taskId: 'P2-T3', status: 'in_progress' }],
        }),
      }),
    ).toBe('P2-T3')
  })

  test('the last in_progress update is claimed when no currentTask is supplied', () => {
    expect(
      claimedTaskAfterTurn({
        messageHistory: planStatusHistory({
          updates: [
            { taskId: 'P1-T9', status: 'pending' },
            { taskId: 'P2-T3', status: 'in_progress' },
          ],
        }),
      }),
    ).toBe('P2-T3')
  })

  test('an in_progress update falls back to task when taskId is absent', () => {
    expect(
      claimedTaskAfterTurn({
        messageHistory: planStatusHistory({
          updates: [{ task: 'P4-T2 — do the thing', status: 'in_progress' }],
        }),
      }),
    ).toBe('P4-T2')
  })

  test('a successful empty currentTask clears the claimed task', () => {
    // The handler's message for a call that both rewrites a line and empties the
    // pointer; the unrelated pending update cannot itself clear P2-T3, so only
    // the empty currentTask can.
    expect(
      claimedTaskAfterTurn({
        seededActivePlanTaskId: 'P2-T3',
        messageHistory: planStatusHistory(
          {
            currentTask: '',
            updates: [{ taskId: 'P9-T1', status: 'pending' }],
          },
          {
            message: 'Updated 1 task line(s). Current task pointer cleared.',
          },
        ),
      }),
    ).toBeUndefined()
  })

  test('a pointer-only clear message clears the claimed task', () => {
    // A call that ONLY empties the pointer (`currentTask: ''`, no `updates`)
    // returns exactly 'Current task pointer cleared.', which matches none of the
    // shared success verbs; the claim tracker must still recognize it, or later
    // gate passes keep minting receipts for a released task.
    expect(
      claimedTaskAfterTurn({
        seededActivePlanTaskId: 'P2-T3',
        messageHistory: planStatusHistory(
          { currentTask: '' },
          { message: 'Current task pointer cleared.' },
        ),
      }),
    ).toBeUndefined()
  })

  test('a pointer-only claim message claims the task', () => {
    // Same root cause in the other direction: a pointer-only SET returns exactly
    // 'Current task -> "<task>".', so without recognizing it the claim is never
    // recorded and the gate can never mint a receipt for that task.
    expect(
      claimedTaskAfterTurn({
        messageHistory: planStatusHistory(
          { currentTask: 'P2-T3 Implement the thing' },
          { message: 'Current task -> "P2-T3 Implement the thing".' },
        ),
      }),
    ).toBe('P2-T3')
  })

  test('a pointer-only clear that applied nothing leaves the claim intact', () => {
    // Fail closed: the handler reports an unapplied call with a failure phrase,
    // so the opt-in pointer-message pattern must not credit it.
    expect(
      claimedTaskAfterTurn({
        seededActivePlanTaskId: 'P2-T3',
        messageHistory: planStatusHistory(
          { currentTask: '' },
          { message: 'No changes applied.' },
        ),
      }),
    ).toBe('P2-T3')
  })

  test('moving the claimed task to done clears the claim', () => {
    expect(
      claimedTaskAfterTurn({
        seededActivePlanTaskId: 'P2-T3',
        messageHistory: planStatusHistory({
          updates: [{ taskId: 'P2-T3', status: 'done' }],
        }),
      }),
    ).toBeUndefined()
  })

  test('a rejected update_plan_status call never claims a task', () => {
    // The runtime handler refuses a plan transition atomically, so a claim it
    // never applied must not let the gate mint a receipt for that task.
    expect(
      claimedTaskAfterTurn({
        messageHistory: planStatusHistory(
          {
            currentTask: 'P2-T3 Implement the thing',
            updates: [{ taskId: 'P2-T3', status: 'in_progress' }],
          },
          {
            errorMessage:
              'update_plan_status: PLAN transition is atomic; no task matched: P2-T3.',
          },
        ),
      }),
    ).toBeUndefined()
  })

  test('a fresh gate pass mints one receipt and names it in the gate-pass message', () => {
    const tmpDir = makeProjectTempDir('base2-plan-gate-receipt-')
    try {
      const tmpFile = join(tmpDir, 'a.ts')
      writeFileSync(tmpFile, 'export const value = 1\n')
      const gateFile = normalizeGateFilePath(tmpFile)
      const agentState: Record<string, unknown> = {
        agentId: 'base2-execute-plan',
        messageHistory: planStatusHistory({
          currentTask: 'P2-T3 Implement the thing',
          updates: [{ taskId: 'P2-T3', status: 'in_progress' }],
        }),
      }

      const { content, reviewFingerprint } = driveToPlanGatePass({
        gateFile,
        agentState,
      })

      // The receipt must be bound to the fingerprint base2 hashed itself for
      // this review, never to a reviewer-reported value.
      expect(reviewFingerprint).toBe(
        buildFingerprint(
          [{ file: gateFile, contentMarker: buildContentMarker(tmpFile) }],
          '',
        ),
      )
      const expectedReceiptId = `plan-gate:P2-T3:${reviewFingerprint.slice(0, 16)}`
      expect(expectedReceiptId).toMatch(/^plan-gate:P2-T3:v3:[a-f0-9]{13}$/)

      const receipts = (agentState as any).base2ActiveWork
        .planTaskGateReceipts as Array<Record<string, unknown>>
      expect(receipts).toHaveLength(1)
      expect(receipts[0]).toMatchObject({
        receiptId: expectedReceiptId,
        taskId: 'P2-T3',
        evidence: 'reviewed-diff',
        snapshotFingerprint: reviewFingerprint,
        files: [gateFile],
        validationSummary: 'No configured file-change hooks ran.',
        reviewerVerdict: 'LOOKS_GOOD',
      })

      expect(content).toContain(
        `Plan task P2-T3 gate receipt: ${expectedReceiptId}.`,
      )
      expect(content).toContain(
        'Pass this exact string in update_plan_status checkpoint.receiptIds when marking P2-T3 done; do not invent a receipt ID.',
      )
      // The evidence sentence is APPENDED after the pinned instruction above, so
      // both existing substrings still match unchanged.
      expect(content).toContain(
        'Evidence: reviewed diff over 1 file(s). This receipt is superseded when any covered file changes again; re-read the current ID after the next gate pass.',
      )
      // The receipt line is an extra LINE inside the existing gate-pass
      // message, inserted before the finalization instruction so that
      // instruction stays last.
      expect(content.indexOf(expectedReceiptId)).toBeLessThan(
        content.indexOf(
          'Provide your single user-visible completion summary now',
        ),
      )
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('a repeat pass on the identical snapshot appends no duplicate receipt', () => {
    const tmpDir = makeProjectTempDir('base2-plan-gate-receipt-dedupe-')
    try {
      const tmpFile = join(tmpDir, 'a.ts')
      writeFileSync(tmpFile, 'export const value = 1\n')
      const gateFile = normalizeGateFilePath(tmpFile)
      const reviewableFingerprint = buildFingerprint(
        [{ file: gateFile, contentMarker: buildContentMarker(tmpFile) }],
        '',
      )
      const seededReceipt = {
        receiptId: `plan-gate:P2-T3:${reviewableFingerprint.slice(0, 16)}`,
        taskId: 'P2-T3',
        evidence: 'reviewed-diff',
        snapshotFingerprint: reviewableFingerprint,
        files: [gateFile],
        validationSummary: 'No configured file-change hooks ran.',
        reviewerVerdict: 'LOOKS_GOOD',
        recordedAt: '2025-01-01T00:00:00.000Z',
      }
      const agentState: Record<string, unknown> = {
        agentId: 'base2-execute-plan',
        // Resumed mid-gate rather than re-edited: a fresh edit to a covered file
        // is a recorded CHANGE, which supersedes the receipt before the mint
        // runs. This path records no change, so the mint hits its idempotent
        // same-receiptId branch and must leave the seed (and its recordedAt)
        // exactly as it was.
        base2ActiveWork: seedPendingGateState(gateFile, {
          activePlanTaskId: 'P2-T3',
          planTaskGateReceipts: [seededReceipt],
        }),
      }

      const { content, reviewFingerprint } = driveSeededPendingGatePass({
        gateFile,
        agentState,
      })

      expect(reviewFingerprint).toBe(reviewableFingerprint)
      expect(planTaskReceiptsOf(agentState)).toEqual([seededReceipt])
      // The content now DOES name the receipt: the ID is printed whenever a live
      // receipt exists for the claimed task, not only when this pass minted one,
      // because supersession changes the ID and it must stay recoverable.
      expect(content).toContain(
        `Plan task P2-T3 gate receipt: ${seededReceipt.receiptId}.`,
      )
      expect(content).toContain('Evidence: reviewed diff over 1 file(s).')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('with no claimed plan task the gate mints nothing and the pass content is unchanged', () => {
    const tmpDir = makeProjectTempDir('base2-plan-gate-receipt-unclaimed-')
    try {
      const tmpFile = join(tmpDir, 'a.ts')
      writeFileSync(tmpFile, 'export const value = 1\n')
      const gateFile = normalizeGateFilePath(tmpFile)
      const agentState: Record<string, unknown> = {
        agentId: 'base2-execute-plan',
      }

      const { content } = driveToPlanGatePass({ gateFile, agentState })

      expect(
        (agentState as any).base2ActiveWork.activePlanTaskId,
      ).toBeUndefined()
      // The key is PRESENT (the gate is active) but empty, and that is what
      // makes the runtime reject an invented checkpoint receipt.
      expect((agentState as any).base2ActiveWork.planTaskGateReceipts).toEqual(
        [],
      )
      expect(content).not.toContain('gate receipt')
      expect(content).toContain(
        `Reviewer gate passed with LOOKS_GOOD for pending files: ${gateFile}.`,
      )
      expect(content).toContain(
        'Provide your single user-visible completion summary now',
      )
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('a non-attestable gate fingerprint mints no receipt (fail closed)', () => {
    // Without a collision-resistant hash, hashGateSnapshotDetails returns the
    // STABLE 'unreadable:no-crypto' sentinel. That is an error string, not
    // content evidence — two unrelated snapshots compare equal under it — so it
    // must never become a receipt ID.
    const originalGetBuiltinModule = (process as any).getBuiltinModule
    const originalRequire = (globalThis as any).require
    try {
      ;(process as any).getBuiltinModule = undefined
      ;(globalThis as any).require = undefined
      const agentState: Record<string, unknown> = {
        agentId: 'base2-execute-plan',
        base2ActiveWork: seedIdleGateState({ activePlanTaskId: 'P2-T3' }),
      }

      const content = driveToGatePassViaReviewerSkip({
        gateFile: 'docs/plan-notes.md',
        agentState,
      })

      expect((agentState as any).base2ActiveWork.planTaskGateReceipts).toEqual(
        [],
      )
      expect(content).not.toContain('gate receipt')
    } finally {
      ;(process as any).getBuiltinModule = originalGetBuiltinModule
      ;(globalThis as any).require = originalRequire
    }
  })

  // R1: a plan task whose gate cycle produced NO reviewable diff must still be
  // completable, and its receipt must say so instead of carrying the hash of an
  // empty file list while presenting as reviewed-diff evidence.
  test('a docs-only gate cycle mints an unreviewed-scope receipt over the validated pending set', () => {
    const tmpDir = makeProjectTempDir('base2-plan-gate-receipt-docs-')
    try {
      const docsFile = join(tmpDir, 'plan-notes.md')
      writeFileSync(docsFile, '# Plan notes\n')
      const gateFile = normalizeGateFilePath(docsFile)
      const agentState: Record<string, unknown> = {
        agentId: 'base2-execute-plan',
        base2ActiveWork: seedIdleGateState({ activePlanTaskId: 'P2-T3' }),
      }

      const content = driveToGatePassViaReviewerSkip({ gateFile, agentState })

      const expectedFingerprint = buildFingerprint(
        [{ file: gateFile, contentMarker: buildContentMarker(docsFile) }],
        '',
      )
      // The whole point of the kind: the fingerprint is the hash of the
      // VALIDATED pending set, not of the empty reviewable subset (which is a
      // constant and would claim content evidence that does not exist).
      expect(expectedFingerprint).not.toBe(buildFingerprint([], ''))
      const receipts = planTaskReceiptsOf(agentState)
      expect(receipts).toHaveLength(1)
      expect(receipts[0]).toMatchObject({
        receiptId: `plan-gate:P2-T3:unreviewed-scope:${expectedFingerprint.slice(0, 16)}`,
        taskId: 'P2-T3',
        evidence: 'unreviewed-scope',
        snapshotFingerprint: expectedFingerprint,
        files: [gateFile],
        reviewerVerdict: 'LOOKS_GOOD',
      })
      expect(receipts[0].receiptId).toMatch(
        /^plan-gate:P2-T3:unreviewed-scope:v3:[a-f0-9]{13}$/,
      )

      expect(content).toContain(
        `Plan task P2-T3 gate receipt: ${receipts[0].receiptId}.`,
      )
      expect(content).toContain(
        'Evidence: no reviewable diff in this gate cycle; validation covered 1 non-reviewable file(s). This receipt is superseded as soon as any further change is recorded.',
      )
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // R1: zero pending files reaches the same gate-pass emission with
  // reviewerFinalizationVerdict EMPTY (passVerdict falls back to LOOKS_GOOD), so
  // the 'no-diff' mint must not depend on a verdict being present.
  test('a gate pass with no pending files mints a no-diff receipt', () => {
    const agentState: Record<string, unknown> = {
      agentId: 'base2-execute-plan',
      base2ActiveWork: seedIdleGateState({ activePlanTaskId: 'P2-T3' }),
    }
    const base2 = createBase2('default', { executePlan: true })
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Continue the plan.',
      params: {},
      config: base2.programmaticConfig,
    } as any)

    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
    expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
      toolName: 'spawn_agent_inline',
    })
    const maybePinned = gen.next().value
    if (maybePinned !== 'STEP') {
      expect(maybePinned).toMatchObject({ toolName: 'add_message' })
      expect(gen.next().value).toBe('STEP')
    }
    // No edit artifact at all: verification-only work.
    expect(gen.next(finishStepWithToolResult({})).value).toMatchObject({
      toolName: 'git_status',
    })
    const gatePassed = gen.next(feedJson({ status: '' }))
    expect(gatePassed.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    const content = (gatePassed.value as any).input.content as string

    const emptyFingerprint = buildFingerprint([], '')
    const receipts = planTaskReceiptsOf(agentState)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      receiptId: `plan-gate:P2-T3:no-diff:${emptyFingerprint.slice(0, 16)}`,
      taskId: 'P2-T3',
      evidence: 'no-diff',
      snapshotFingerprint: emptyFingerprint,
      files: [],
      reviewerVerdict: 'LOOKS_GOOD',
    })
    expect(receipts[0].receiptId).toMatch(
      /^plan-gate:P2-T3:no-diff:v3:[a-f0-9]{13}$/,
    )
    expect(content).toContain(
      `Plan task P2-T3 gate receipt: ${receipts[0].receiptId}.`,
    )
    expect(content).toContain(
      'Evidence: no file changes in this gate cycle. This receipt is superseded as soon as any further change is recorded.',
    )
  })

  // R2 mechanism 1: content verification at turn start. A receipt whose covered
  // bytes changed is no longer true, so it must stop authorizing completion even
  // though its taskId/receiptId still "match" a checkpoint.
  test('turn-start content verification drops a receipt whose covered bytes changed', () => {
    const tmpDir = makeProjectTempDir('base2-plan-gate-receipt-stale-')
    try {
      const tmpFile = join(tmpDir, 'a.ts')
      writeFileSync(tmpFile, 'export const value = 1\n')
      const gateFile = normalizeGateFilePath(tmpFile)
      const staleFingerprint = buildFingerprint(
        [{ file: gateFile, contentMarker: buildContentMarker(tmpFile) }],
        '',
      )
      // The code changed after the receipt was issued.
      writeFileSync(tmpFile, 'export const value = 2\n')
      const agentState: Record<string, unknown> = {
        agentId: 'base2-execute-plan',
        base2ActiveWork: seedIdleGateState({
          activePlanTaskId: 'P2-T3',
          planTaskGateReceipts: [
            {
              receiptId: `plan-gate:P2-T3:${staleFingerprint.slice(0, 16)}`,
              taskId: 'P2-T3',
              evidence: 'reviewed-diff',
              snapshotFingerprint: staleFingerprint,
              files: [gateFile],
              validationSummary: 'No configured file-change hooks ran.',
              reviewerVerdict: 'LOOKS_GOOD',
              recordedAt: '2025-01-01T00:00:00.000Z',
            },
          ],
        }),
      }

      driveToTurnStartBookkeeping(agentState)

      const activeWork = (agentState as any).base2ActiveWork
      expect(activeWork.planTaskGateReceipts).toEqual([])
      // PRUNED, not deleted: presence is what keeps gate-issued verification
      // active in the runtime handler, so an invented ID still fails.
      expect('planTaskGateReceipts' in activeWork).toBe(true)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('turn-start content verification keeps a receipt whose bytes still match', () => {
    const tmpDir = makeProjectTempDir('base2-plan-gate-receipt-fresh-')
    try {
      const tmpFile = join(tmpDir, 'a.ts')
      writeFileSync(tmpFile, 'export const value = 1\n')
      const gateFile = normalizeGateFilePath(tmpFile)
      const liveReceipt = {
        receiptId: `plan-gate:P2-T3:${buildFingerprint(
          [{ file: gateFile, contentMarker: buildContentMarker(tmpFile) }],
          '',
        ).slice(0, 16)}`,
        taskId: 'P2-T3',
        evidence: 'reviewed-diff',
        snapshotFingerprint: buildFingerprint(
          [{ file: gateFile, contentMarker: buildContentMarker(tmpFile) }],
          '',
        ),
        files: [gateFile],
        validationSummary: 'No configured file-change hooks ran.',
        reviewerVerdict: 'LOOKS_GOOD',
        recordedAt: '2025-01-01T00:00:00.000Z',
      }
      const agentState: Record<string, unknown> = {
        agentId: 'base2-execute-plan',
        base2ActiveWork: seedIdleGateState({
          activePlanTaskId: 'P2-T3',
          planTaskGateReceipts: [liveReceipt],
        }),
      }

      driveToTurnStartBookkeeping(agentState)

      expect(planTaskReceiptsOf(agentState)).toEqual([liveReceipt])
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // A PRESENT-but-non-array ledger (corrupt or hand-edited serialized state)
  // must fail closed rather than throw: the mint's `.some(...)`, the printed
  // live-receipt `.find(...)`, and the pinned recovery line all read this key.
  test('a non-array planTaskGateReceipts ledger is normalized to an empty array', () => {
    const agentState: Record<string, unknown> = {
      agentId: 'base2-execute-plan',
      base2ActiveWork: seedIdleGateState({
        activePlanTaskId: 'P2-T3',
        planTaskGateReceipts: {
          receiptId: 'plan-gate:P2-T3:v3:0123456789abc',
          taskId: 'P2-T3',
        },
      }),
    }

    driveToTurnStartBookkeeping(agentState)

    const activeWork = (agentState as any).base2ActiveWork
    expect(activeWork.planTaskGateReceipts).toEqual([])
    // NORMALIZED, not deleted: presence is what keeps gate-issued verification
    // active in the runtime handler, so an invented ID still fails.
    expect('planTaskGateReceipts' in activeWork).toBe(true)
  })

  test('a gate pass over a non-array ledger still mints and prints one receipt', () => {
    const tmpDir = makeProjectTempDir('base2-plan-gate-receipt-nonarray-')
    try {
      const tmpFile = join(tmpDir, 'a.ts')
      writeFileSync(tmpFile, 'export const value = 1\n')
      const gateFile = normalizeGateFilePath(tmpFile)
      const agentState: Record<string, unknown> = {
        agentId: 'base2-execute-plan',
        base2ActiveWork: seedIdleGateState({
          activePlanTaskId: 'P2-T3',
          // Not an array: the mint's `.some(...)`, the printed receipt's
          // `.find(...)`, and the pinned recovery line's `.find(...)` would each
          // throw a TypeError and fail the whole turn.
          planTaskGateReceipts: 'corrupt',
        }),
      }

      const { content, reviewFingerprint } = driveToPlanGatePass({
        gateFile,
        agentState,
      })

      const expectedReceiptId = `plan-gate:P2-T3:${reviewFingerprint.slice(0, 16)}`
      const receipts = planTaskReceiptsOf(agentState)
      expect(receipts).toHaveLength(1)
      expect(receipts[0]).toMatchObject({
        receiptId: expectedReceiptId,
        taskId: 'P2-T3',
        evidence: 'reviewed-diff',
        files: [gateFile],
      })
      expect(content).toContain(
        `Plan task P2-T3 gate receipt: ${expectedReceiptId}.`,
      )
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // R2 mechanism 2: change supersession. A 'no-diff' fingerprint is a constant
  // and an 'unreviewed-scope' one attests no review, so content verification can
  // never retire them — only supersession can.
  test('a recorded change supersedes non-reviewed receipts and intersecting reviewed ones', () => {
    const tmpDir = makeProjectTempDir('base2-plan-gate-receipt-supersede-')
    try {
      const editedFile = join(tmpDir, 'a.ts')
      const unrelatedFile = join(tmpDir, 'b.ts')
      const docsFile = join(tmpDir, 'notes.md')
      writeFileSync(editedFile, 'export const a = 1\n')
      writeFileSync(unrelatedFile, 'export const b = 1\n')
      writeFileSync(docsFile, '# notes\n')
      const editedGateFile = normalizeGateFilePath(editedFile)
      const unrelatedGateFile = normalizeGateFilePath(unrelatedFile)
      const docsGateFile = normalizeGateFilePath(docsFile)

      const receiptFor = (params: {
        taskId: string
        evidence: string
        files: Array<{ gateFile: string; absolutePath: string }>
      }) => {
        const fingerprint = buildFingerprint(
          params.files.map((file) => ({
            file: file.gateFile,
            contentMarker: buildContentMarker(file.absolutePath),
          })),
          '',
        )
        return {
          receiptId: `plan-gate:${params.taskId}:${params.evidence === 'reviewed-diff' ? '' : `${params.evidence}:`}${fingerprint.slice(0, 16)}`,
          taskId: params.taskId,
          evidence: params.evidence,
          snapshotFingerprint: fingerprint,
          files: params.files.map((file) => file.gateFile),
          validationSummary: 'No configured file-change hooks ran.',
          reviewerVerdict: 'LOOKS_GOOD',
          recordedAt: '2025-01-01T00:00:00.000Z',
        }
      }
      const intersectingReviewed = receiptFor({
        taskId: 'P1-T1',
        evidence: 'reviewed-diff',
        files: [{ gateFile: editedGateFile, absolutePath: editedFile }],
      })
      const unrelatedReviewed = receiptFor({
        taskId: 'P1-T2',
        evidence: 'reviewed-diff',
        files: [{ gateFile: unrelatedGateFile, absolutePath: unrelatedFile }],
      })
      const unreviewedScope = receiptFor({
        taskId: 'P1-T3',
        evidence: 'unreviewed-scope',
        files: [{ gateFile: docsGateFile, absolutePath: docsFile }],
      })
      const noDiff = {
        receiptId: `plan-gate:P1-T4:no-diff:${buildFingerprint([], '').slice(0, 16)}`,
        taskId: 'P1-T4',
        evidence: 'no-diff',
        snapshotFingerprint: buildFingerprint([], ''),
        files: [] as string[],
        validationSummary: 'No configured file-change hooks ran.',
        reviewerVerdict: 'LOOKS_GOOD',
        recordedAt: '2025-01-01T00:00:00.000Z',
      }
      const agentState: Record<string, unknown> = {
        agentId: 'base2-execute-plan',
        base2ActiveWork: seedIdleGateState({
          activePlanTaskId: 'P1-T1',
          planTaskGateReceipts: [
            intersectingReviewed,
            unrelatedReviewed,
            unreviewedScope,
            noDiff,
          ],
        }),
      }

      const base2 = createBase2('default', { executePlan: true })
      const gen = base2.handleSteps!({
        agentState,
        prompt: 'Continue the plan.',
        params: {},
        config: base2.programmaticConfig,
      } as any)
      expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
      expect(gen.next(feedJson({ status: '' })).value).toMatchObject({
        toolName: 'spawn_agent_inline',
      })
      // Every seeded receipt survives turn-start content verification, so the
      // drops below are attributable to supersession alone.
      expect(planTaskReceiptsOf(agentState)).toEqual([
        intersectingReviewed,
        unrelatedReviewed,
        unreviewedScope,
        noDiff,
      ])
      const maybePinned = gen.next().value
      if (maybePinned !== 'STEP') {
        expect(maybePinned).toMatchObject({ toolName: 'add_message' })
        expect(gen.next().value).toBe('STEP')
      }
      // One recorded change to editedGateFile.
      expect(
        gen.next(finishStepWithToolResult(editReceipt(editedGateFile))).value,
      ).toMatchObject({ toolName: 'git_status' })

      expect(planTaskReceiptsOf(agentState)).toEqual([unrelatedReviewed])
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // One live receipt per task: the printed ID must be unambiguous, so a mint
  // REPLACES that task's earlier receipt instead of appending.
  test('a second fresh pass for the same task replaces its earlier receipt', () => {
    const tmpDir = makeProjectTempDir('base2-plan-gate-receipt-replace-')
    try {
      const tmpFile = join(tmpDir, 'a.ts')
      const unrelatedFile = join(tmpDir, 'b.ts')
      writeFileSync(tmpFile, 'export const value = 1\n')
      writeFileSync(unrelatedFile, 'export const other = 1\n')
      const gateFile = normalizeGateFilePath(tmpFile)
      const unrelatedGateFile = normalizeGateFilePath(unrelatedFile)
      // Same task, covering a DIFFERENT file whose bytes never change, so it
      // survives both content verification and supersession. Only the
      // one-live-receipt-per-task replacement can remove it.
      const earlierSameTaskFingerprint = buildFingerprint(
        [
          {
            file: unrelatedGateFile,
            contentMarker: buildContentMarker(unrelatedFile),
          },
        ],
        '',
      )
      const earlierSameTaskReceipt = {
        receiptId: `plan-gate:P2-T3:${earlierSameTaskFingerprint.slice(0, 16)}`,
        taskId: 'P2-T3',
        evidence: 'reviewed-diff',
        snapshotFingerprint: earlierSameTaskFingerprint,
        files: [unrelatedGateFile],
        validationSummary: 'No configured file-change hooks ran.',
        reviewerVerdict: 'LOOKS_GOOD',
        recordedAt: '2025-01-01T00:00:00.000Z',
      }
      const agentState: Record<string, unknown> = {
        agentId: 'base2-execute-plan',
        base2ActiveWork: seedIdleGateState({
          activePlanTaskId: 'P2-T3',
          planTaskGateReceipts: [earlierSameTaskReceipt],
        }),
      }

      const first = driveToPlanGatePass({ gateFile, agentState })
      const firstReceiptId = `plan-gate:P2-T3:${first.reviewFingerprint.slice(0, 16)}`
      expect(firstReceiptId).not.toBe(earlierSameTaskReceipt.receiptId)
      expect(planTaskReceiptsOf(agentState)).toHaveLength(1)
      expect(planTaskReceiptsOf(agentState)[0].receiptId).toBe(firstReceiptId)
      expect(first.content).not.toContain(earlierSameTaskReceipt.receiptId)

      // A later pass over different bytes for the same claimed task likewise
      // leaves exactly one receipt, carrying the new ID.
      writeFileSync(tmpFile, 'export const value = 2\n')
      const second = driveToPlanGatePass({ gateFile, agentState })
      const secondReceiptId = `plan-gate:P2-T3:${second.reviewFingerprint.slice(0, 16)}`

      expect(secondReceiptId).not.toBe(firstReceiptId)
      const receipts = planTaskReceiptsOf(agentState)
      expect(receipts).toHaveLength(1)
      expect(receipts[0]).toMatchObject({
        receiptId: secondReceiptId,
        taskId: 'P2-T3',
        evidence: 'reviewed-diff',
        snapshotFingerprint: second.reviewFingerprint,
        files: [gateFile],
      })
      expect(second.content).toContain(
        `Plan task P2-T3 gate receipt: ${secondReceiptId}.`,
      )
      expect(second.content).not.toContain(firstReceiptId)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // R3: pinned state survives context compaction, so it is the durable place to
  // re-read the live receipt ID after supersession changed it.
  test('the pinned active-work message names the live plan-task gate receipt', () => {
    const tmpDir = makeProjectTempDir('base2-plan-gate-receipt-pinned-')
    try {
      const tmpFile = join(tmpDir, 'a.ts')
      writeFileSync(tmpFile, 'export const value = 1\n')
      const gateFile = normalizeGateFilePath(tmpFile)
      const liveFingerprint = buildFingerprint(
        [{ file: gateFile, contentMarker: buildContentMarker(tmpFile) }],
        '',
      )
      const liveReceipt = {
        receiptId: `plan-gate:P2-T3:${liveFingerprint.slice(0, 16)}`,
        taskId: 'P2-T3',
        evidence: 'reviewed-diff',
        snapshotFingerprint: liveFingerprint,
        files: [gateFile],
        validationSummary: 'No configured file-change hooks ran.',
        reviewerVerdict: 'LOOKS_GOOD',
        recordedAt: '2025-01-01T00:00:00.000Z',
      }

      /** Pinned block emitted right after the turn's context-pruner spawn. */
      function pinnedMessageFor(activeWork: Record<string, unknown>): string {
        const base2 = createBase2('default', { executePlan: true })
        const gen = base2.handleSteps!({
          agentState: {
            agentId: 'base2-execute-plan',
            base2ActiveWork: activeWork,
          },
          prompt: 'Continue the plan.',
          params: {},
          config: base2.programmaticConfig,
        } as any)
        expect(gen.next().value).toMatchObject({ toolName: 'git_status' })
        expect(
          gen.next(feedJson({ status: ` M ${gateFile}` })).value,
        ).toMatchObject({ toolName: 'spawn_agent_inline' })
        const pinned = gen.next()
        expect(pinned.value).toMatchObject({
          toolName: 'add_message',
          input: { role: 'user' },
        })
        return (pinned.value as any).input.content as string
      }

      expect(
        pinnedMessageFor(
          seedPendingGateState(gateFile, {
            activePlanTaskId: 'P2-T3',
            planTaskGateReceipts: [liveReceipt],
          }),
        ),
      ).toContain(
        `Live plan-task gate receipt: ${liveReceipt.receiptId} (task P2-T3, evidence reviewed-diff)`,
      )

      // No claimed task: nothing to recover, so the line is omitted entirely.
      expect(
        pinnedMessageFor(
          seedPendingGateState(gateFile, {
            planTaskGateReceipts: [liveReceipt],
          }),
        ),
      ).not.toContain('Live plan-task gate receipt:')

      // Claimed task with no live receipt (e.g. it was just superseded).
      expect(
        pinnedMessageFor(
          seedPendingGateState(gateFile, {
            activePlanTaskId: 'P2-T3',
            planTaskGateReceipts: [],
          }),
        ),
      ).not.toContain('Live plan-task gate receipt:')

      // Claimed task with a PRESENT-but-non-array ledger: the pinned line reads
      // this key with `.find(...)`, so it must fail closed (line omitted, turn
      // still produces the pinned block) instead of throwing a TypeError.
      expect(
        pinnedMessageFor(
          seedPendingGateState(gateFile, {
            activePlanTaskId: 'P2-T3',
            planTaskGateReceipts: 'corrupt',
          }),
        ),
      ).not.toContain('Live plan-task gate receipt:')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // Presence-vs-absence is load-bearing in the other direction too: with the
  // gate disabled no receipt could ever be minted, so publishing the key would
  // make every plan task impossible to complete.
  test('a no-validation run leaves planTaskGateReceipts absent entirely', () => {
    const base2 = createBase2('default', { hasNoValidation: true })
    const agentState: Record<string, unknown> = {
      agentId: 'base2-no-validation',
      messageHistory: planStatusHistory({
        currentTask: 'P2-T3 Implement the thing',
        updates: [{ taskId: 'P2-T3', status: 'in_progress' }],
      }),
    }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Continue the plan.',
      params: {},
      config: base2.programmaticConfig,
    } as any)
    expect(gen.next().value).toMatchObject({ toolName: 'git_status' })

    const activeWork = (agentState as any).base2ActiveWork
    // The task is still tracked; only the receipt ledger stays unpublished.
    expect(activeWork.activePlanTaskId).toBe('P2-T3')
    expect('planTaskGateReceipts' in activeWork).toBe(false)
  })

  // Same invariant on the resume path: a session that published the key under a
  // gate-enabled run must not carry it into a gate-disabled variant, where no
  // receipt can ever be minted and every new plan task would become impossible
  // to complete.
  test('a gate-disabled variant clears an inherited planTaskGateReceipts key', () => {
    const seededReceipt = {
      receiptId: 'plan-gate:P1-T1:v3:0123456789abc',
      taskId: 'P1-T1',
      evidence: 'reviewed-diff',
      snapshotFingerprint: 'v3:0123456789abc',
      files: ['src/a.ts'],
      validationSummary: 'No configured file-change hooks ran.',
      reviewerVerdict: 'LOOKS_GOOD',
      recordedAt: '2025-01-01T00:00:00.000Z',
    }
    const variants = [
      {
        agentId: 'base2-no-validation',
        base2: createBase2('default', { hasNoValidation: true }),
        passConfig: true,
      },
      {
        agentId: 'base2-plan',
        base2: createBase2('default', { planOnly: true }),
        passConfig: true,
      },
      {
        // base2-fast disables the gate through the agentId fallback, which is
        // only consulted when no programmaticConfig is supplied.
        agentId: 'base2-fast',
        base2: createBase2('fast'),
        passConfig: false,
      },
    ]

    for (const variant of variants) {
      const agentState: Record<string, unknown> = {
        agentId: variant.agentId,
        base2ActiveWork: seedIdleGateState({
          activePlanTaskId: 'P2-T3',
          planTaskGateReceipts: [seededReceipt],
        }),
      }
      const gen = variant.base2.handleSteps!({
        agentState,
        prompt: 'Continue the plan.',
        params: {},
        ...(variant.passConfig
          ? { config: variant.base2.programmaticConfig }
          : {}),
      } as any)
      expect(gen.next().value).toMatchObject({ toolName: 'git_status' })

      const activeWork = (agentState as any).base2ActiveWork
      // Absent again, so update_plan_status falls back to the legacy "any
      // non-empty receiptIds" rule instead of demanding gate evidence this run
      // can never issue.
      expect('planTaskGateReceipts' in activeWork).toBe(false)
      // The claim is execution tracking, not gate credit, so it stays.
      expect(activeWork.activePlanTaskId).toBe('P2-T3')
    }
  })

  test('the EXECUTE_PLAN prompts state the gate-issued receipt contract', () => {
    const executePlan = createBase2('default', { executePlan: true })

    expect(executePlan.stepPrompt).toContain(
      'copy the gate-issued receipt ID from the gate-pass message into update_plan_status checkpoint.receiptIds',
    )
    expect(executePlan.stepPrompt).toContain(
      'the runtime verifies them against gate state and rejects an unmatched one',
    )
    expect(executePlan.instructionsPrompt).toContain(
      'plan-gate:<taskId>:<fingerprintPrefix>',
    )
    expect(executePlan.instructionsPrompt).toContain(
      'never invent a receipt ID',
    )
    // Supersession changes the ID, so both prompts must say the model has to
    // re-read the NEW one instead of reusing an earlier gate-pass message.
    expect(executePlan.instructionsPrompt).toContain(
      "A receipt is SUPERSEDED when the task's files change again",
    )
    expect(executePlan.instructionsPrompt).toContain(
      'never reuse an ID from an earlier gate-pass message',
    )
    expect(executePlan.stepPrompt).toContain(
      'superseded once the files it covers change again',
    )
    expect(executePlan.stepPrompt).toContain(
      'never reuse an ID from an earlier gate-pass message',
    )
  })
})
