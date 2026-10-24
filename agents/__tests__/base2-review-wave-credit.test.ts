import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

import { extractInlineFunctionSource } from './helpers/extract-inline-function-source'

/**
 * Hermetic coverage for two serialized `handleSteps` helpers whose correctness
 * is otherwise only reachable through a full gate run:
 *
 * - `recordWaveCompletionsForFiles` — the windowed-review wave credit recorder.
 *   Waves are planned over the UNION of every routed specialist's scoped file
 *   set, but each specialist pass credits only its OWN files, so a wave spanning
 *   files owned by different specialists must accumulate credit ACROSS passes.
 *   The earlier single-pass `waveFiles.every(file => creditedSet.has(file))`
 *   rule could never fully cover such a wave, so it was never recorded and the
 *   post-spawn finalization reported it missing forever
 *   ('specialist-review-waves-incomplete').
 * - `boundNoVerdictDiagnosticCodes` — the durable no-verdict convergence ledger
 *   bound. The convergence key embeds the snapshot fingerprint; an existing key
 *   re-write does NOT move it to the end of insertion order, so the CURRENT
 *   pair's key must be retained EXPLICITLY rather than relying on
 *   `entries.slice(-128)`.
 *
 * Both live inline inside the serialized `handleSteps` generator (which is
 * reconstructed via `.toString()` + `new Function(...)`), so they cannot be
 * imported. This harness extracts their exact production source, supplies the
 * closed-over helpers/state they reference, and evaluates them standalone —
 * the same technique the sibling `base2-writer-spawn-rules` suite uses.
 */

function loadInlineReviewCreditHelpers(): {
  isCreditEligibleSpecialistResult: (
    blockers: string[],
    creditPathQualified: boolean,
  ) => boolean
  invalidateWaveCompletionsForSpecialistBlockers: (
    blockers: string[],
    fingerprint: string,
    blockedFiles: string[],
  ) => void
  findDriftedPriorWaveFiles: (
    priorMarkers: Record<string, string>,
    markerFor: (file: string) => string,
  ) => string[]
  recordWaveCompletionsForFiles: (
    creditedFiles: string[],
    plannedWaves: string[][],
    fingerprint: string,
    agentType: string,
  ) => void
  getWaveCompletions: () => Record<
    string,
    {
      fingerprint: string
      waveIndex: number
      files: string[]
      creditedFiles?: string[]
      creditedFileMarkers?: Record<string, string>
      completedAt?: string
      lastTouchedAt?: string
    }
  >
  getWaveCreditMarkers: () => Record<string, Record<string, string>> | undefined
  seedWaveLedgers: (
    completions: Record<string, {
      fingerprint: string
      waveIndex: number
      files: string[]
      creditedFiles?: string[]
      creditedFileMarkers?: Record<string, string>
      completedAt?: string
    }>,
    markers: Record<string, Record<string, string>>,
  ) => void
  resetWaveCompletions: () => void
  boundNoVerdictDiagnosticCodes: (
    codes: Record<string, string>,
    retainKey: string,
  ) => Record<string, string>
  boundWaveCompletions: (
    completions: Record<
      string,
      {
        fingerprint: string
        waveIndex: number
        files: string[]
        creditedFiles?: string[]
        creditedFileMarkers?: Record<string, string>
        completedAt?: string
        lastTouchedAt?: string
      }
    >,
    currentFingerprint: string,
  ) => Record<
    string,
    {
      fingerprint: string
      waveIndex: number
      files: string[]
      creditedFiles?: string[]
      creditedFileMarkers?: Record<string, string>
      completedAt?: string
      lastTouchedAt?: string
    }
  >
} {
  const base2Source = readFileSync(
    new URL('../base2/base2.ts', import.meta.url),
    'utf8',
  )
  const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' })
  const base2JavaScript = transpiler.transformSync(base2Source)

  const helperNames = [
    'normalizeGateFilePath',
    'normalizeGateFileList',
    'hashGateSnapshotDetails',
    'waveKey',
    'findDriftedPriorWaveFiles',
    'isCreditEligibleSpecialistResult',
    'invalidateWaveCompletionsForSpecialistBlockers',
    'boundWaveCompletions',
    'recordWaveCompletionsForFiles',
    'boundNoVerdictDiagnosticCodes',
    // DRIFT-INVALIDATION: recordWaveCompletionsForFiles now re-reads each
    // file's LIVE content marker to re-open a wave whose bytes drifted, so the
    // marker helper chain must be extracted too. `readGateFileContentMarker`
    // delegates to the uncached body and its two lazy built-in resolvers.
    'readGateFileContentMarker',
    'readGateFileContentMarkerUncached',
    'readGateMarkerBuiltinFs',
    'requirePath',
  ] as const

  const helperSource = helperNames
    .map((functionName) =>
      extractInlineFunctionSource(base2JavaScript, functionName),
    )
    .join('\n\n')

  // `recordWaveCompletionsForFiles` reads/writes `activeWorkState.waveCompletions`
  // and `hashGateSnapshotDetails`/`normalizeGateFilePath` resolve node builtins
  // lazily, so a minimal mutable state holder plus the extracted helpers is all
  // the reconstruction needs.
  // Module-scope bindings the extracted marker helpers close over: the
  // missing-content sentinel, the marker-cache bounds/grace window, and the
  // cache itself. Mirrors the production `handleSteps` module scope.
  const prelude =
    `\nconst activeWorkState = {};\n` +
    `const GATE_FILE_MISSING_CONTENT_MARKER = 'missing';\n` +
    `const GATE_MARKER_CACHE_MAX = 250;\n` +
    `const GATE_MARKER_CACHE_GRACE_MS = 3000;\n` +
    `const gateMarkerCache = new Map();\n`
  const epilogue = `\nreturn {\n  recordWaveCompletionsForFiles,\n  findDriftedPriorWaveFiles,\n  invalidateWaveCompletionsForSpecialistBlockers,\n  seedWaveLedgers: (completions, markers) => { activeWorkState.waveCompletions = completions; activeWorkState.specialistWaveCreditMarkers = markers; },\n  isCreditEligibleSpecialistResult,\n  boundNoVerdictDiagnosticCodes,\n  boundWaveCompletions,\n  getWaveCompletions: () => activeWorkState.waveCompletions,\n  getWaveCreditMarkers: () => activeWorkState.specialistWaveCreditMarkers,\n  resetWaveCompletions: () => { activeWorkState.waveCompletions = undefined; activeWorkState.specialistWaveCreditMarkers = undefined; },\n};\n`

  const combinedJs = transpiler.transformSync(
    `${prelude}${helperSource}${epilogue}`,
  )
  const buildHelpers = new Function(`"use strict";\n${combinedJs}`) as () => {
    isCreditEligibleSpecialistResult: (
      blockers: string[],
      creditPathQualified: boolean,
    ) => boolean
    invalidateWaveCompletionsForSpecialistBlockers: (
      blockers: string[],
      fingerprint: string,
      blockedFiles: string[],
    ) => void
    findDriftedPriorWaveFiles: (
      priorMarkers: Record<string, string>,
      markerFor: (file: string) => string,
    ) => string[]
    recordWaveCompletionsForFiles: (
      creditedFiles: string[],
      plannedWaves: string[][],
      fingerprint: string,
      agentType: string,
    ) => void
    getWaveCompletions: () => Record<
      string,
      {
        fingerprint: string
        waveIndex: number
        files: string[]
        creditedFiles?: string[]
        creditedFileMarkers?: Record<string, string>
        completedAt?: string
        lastTouchedAt?: string
      }
    >
    getWaveCreditMarkers: () => Record<string, Record<string, string>> | undefined
    seedWaveLedgers: (
      completions: Record<string, {
        fingerprint: string
        waveIndex: number
        files: string[]
        creditedFiles?: string[]
        creditedFileMarkers?: Record<string, string>
        completedAt?: string
      }>,
      markers: Record<string, Record<string, string>>,
    ) => void
    resetWaveCompletions: () => void
    boundNoVerdictDiagnosticCodes: (
      codes: Record<string, string>,
      retainKey: string,
    ) => Record<string, string>
    boundWaveCompletions: (
      completions: Record<
        string,
        {
          fingerprint: string
          waveIndex: number
          files: string[]
          creditedFiles?: string[]
          creditedFileMarkers?: Record<string, string>
          completedAt?: string
          lastTouchedAt?: string
        }
      >,
      currentFingerprint: string,
    ) => Record<
      string,
      {
        fingerprint: string
        waveIndex: number
        files: string[]
        creditedFiles?: string[]
        creditedFileMarkers?: Record<string, string>
        completedAt?: string
        lastTouchedAt?: string
      }
    >
  }
  return buildHelpers()
}

describe('base2 wave credit accumulation across specialists', () => {
  test('a blocker result cannot qualify for or retain specialist wave credit', () => {
    const helpers = loadInlineReviewCreditHelpers()

    expect(
      helpers.isCreditEligibleSpecialistResult(
        ['BLOCKING: unresolved finding'],
        false,
      ),
    ).toBe(false)
    expect(helpers.isCreditEligibleSpecialistResult([], true)).toBe(true)
    // The reduced-assurance no-verdict path remains eligible only when blocker-free.
    expect(
      helpers.isCreditEligibleSpecialistResult(
        ['BLOCKING: unresolved finding'],
        true,
      ),
    ).toBe(false)

    const fingerprint = 'v3:' + 'a'.repeat(64)
    helpers.seedWaveLedgers(
      {
        completed: {
          fingerprint,
          waveIndex: 0,
          files: ['agents/a.ts', 'agents/b.ts'],
          creditedFiles: ['agents/a.ts', 'agents/b.ts'],
          creditedFileMarkers: {
            'agents/a.ts': 'sha256:a:1',
            'agents/b.ts': 'sha256:b:1',
          },
          completedAt: '2025-01-01T00:00:00.000Z',
        },
        unrelated: {
          fingerprint,
          waveIndex: 1,
          files: ['agents/other.ts'],
          creditedFiles: ['agents/other.ts'],
          creditedFileMarkers: { 'agents/other.ts': 'sha256:other:1' },
          completedAt: '2025-01-01T00:00:00.000Z',
        },
      },
      {
        'reviewer-a': {
          'agents/a.ts': 'sha256:a:1',
          'agents/b.ts': 'sha256:b:1',
          'agents/other.ts': 'sha256:other:1',
        },
      },
    )
    helpers.invalidateWaveCompletionsForSpecialistBlockers(
      ['BLOCKING: unresolved finding'],
      fingerprint,
      ['agents/a.ts'],
    )
    expect(helpers.getWaveCompletions()).toEqual({
      unrelated: {
        fingerprint,
        waveIndex: 1,
        files: ['agents/other.ts'],
        creditedFiles: ['agents/other.ts'],
        creditedFileMarkers: { 'agents/other.ts': 'sha256:other:1' },
        completedAt: '2025-01-01T00:00:00.000Z',
      },
    })
    expect(helpers.getWaveCreditMarkers()).toEqual({
      'reviewer-a': { 'agents/other.ts': 'sha256:other:1' },
    })
  })
  test('only specialists with spawned scoped reviews enter retry, verdict, and bypass credit handling', () => {
    const base2Source = readFileSync(
      new URL('../base2/base2.ts', import.meta.url),
      'utf8',
    )

    // Routed specialists with an empty scope are deliberately not spawned and
    // therefore have no result. Every post-spawn result/credit path must use
    // the actual spawned set, or a missing result can be mistaken for a
    // no-verdict review and credited with reduced assurance.
    expect(base2Source).toContain(
      'const retrySpecialists = spawnableSpecialists.filter((agentType) => {',
    )
    expect(base2Source).toContain(
      'if (!specialistTerminalFailure) {\n                for (const agentType of spawnableSpecialists) {',
    )
    expect(base2Source).toContain(
      'for (const routedAgent of spawnableSpecialists) {',
    )

    expect(base2Source).toContain(
      'isCreditEligibleSpecialistResult(\n                      blockers,\n                      specialistResultCreditPathQualified,\n                    )',
    )
    const guardedWaveRecord =
      'if (blockers.length === 0) {\n                      recordWaveCompletionsForFiles('
    expect(base2Source.split(guardedWaveRecord).length - 1).toBe(2)
    expect(base2Source).toContain(
      'for (const agentType of spawnableSpecialists) {\n                  const expectedSnapshotId',
    )
  })

  test('a current-pass marker refresh cannot hide drift from the pre-pass credit snapshot', () => {
    const helpers = loadInlineReviewCreditHelpers()
    const priorMarkers: Record<string, string> = {
      'agents/previously-credited.ts': 'sha256:before:1',
    }
    // The specialist pass refreshes its marker after the file changes. The
    // pre-pass snapshot remains authoritative, so finalization must detect it.
    const postPassMarkers: Record<string, string> = {
      ...priorMarkers,
      'agents/previously-credited.ts': 'sha256:after:1',
    }

    expect(
      helpers.findDriftedPriorWaveFiles(
        priorMarkers,
        (file) => postPassMarkers[file] ?? 'unreadable:missing',
      ),
    ).toEqual(['agents/previously-credited.ts'])
    expect(priorMarkers['agents/previously-credited.ts']).toBe(
      'sha256:before:1',
    )
  })

  test('a wave spanning two specialists is credited once the union of passes covers it', () => {
    const helpers = loadInlineReviewCreditHelpers()
    helpers.resetWaveCompletions()
    const fingerprint = 'v3:' + 'a'.repeat(64)
    // One planned wave (index 0) over files owned by DIFFERENT specialists.
    const plannedWaves = [
      ['agents/a.ts', 'agents/b.ts', 'common/c.ts'],
    ]

    // First specialist pass credits only its own file.
    helpers.recordWaveCompletionsForFiles(
      ['agents/a.ts'],
      plannedWaves,
      fingerprint,
      'reviewer-a',
    )
    const key = Object.keys(helpers.getWaveCompletions())[0]
    expect(key).toBeDefined()
    // Not yet complete: the wave is missing the other two files.
    expect(helpers.getWaveCompletions()[key].completedAt).toBeUndefined()

    // Second specialist pass credits its own files, completing the union.
    helpers.recordWaveCompletionsForFiles(
      ['agents/b.ts', 'common/c.ts'],
      plannedWaves,
      fingerprint,
      'reviewer-b',
    )
    expect(helpers.getWaveCompletions()[key].completedAt).toBeDefined()
    expect(helpers.getWaveCompletions()[key].files).toEqual([
      'agents/a.ts',
      'agents/b.ts',
      'common/c.ts',
    ])
  })

  test('a wave fully covered by a single pass is credited immediately', () => {
    const helpers = loadInlineReviewCreditHelpers()
    helpers.resetWaveCompletions()
    const fingerprint = 'v3:' + 'b'.repeat(64)
    const plannedWaves = [['agents/a.ts', 'agents/b.ts']]
    helpers.recordWaveCompletionsForFiles(
      ['agents/a.ts', 'agents/b.ts'],
      plannedWaves,
      fingerprint,
      'reviewer-a',
    )
    const key = Object.keys(helpers.getWaveCompletions())[0]
    expect(helpers.getWaveCompletions()[key].completedAt).toBeDefined()
  })

  test('the recorder writes the WAVE-UNIVERSE marker ledger the finalization check reads, keyed by agentType', () => {
    // The post-spawn finalization check validates each wave file's live marker
    // against `specialistWaveCreditMarkers[agentType][file]` — the SAME ledger
    // this recorder writes from each completion's own `creditedFileMarkers`.
    // That is what closes the no-verdict marker-mismatch: the completion record
    // and its validation source are written by ONE call, from ONE marker read,
    // over the wave universe (NOT the raw R4-widened scoped set).
    const helpers = loadInlineReviewCreditHelpers()
    helpers.resetWaveCompletions()
    const fingerprint = 'v3:' + 'e'.repeat(64)
    const plannedWaves = [['agents/a.ts', 'agents/b.ts']]
    helpers.recordWaveCompletionsForFiles(
      ['agents/a.ts', 'agents/b.ts'],
      plannedWaves,
      fingerprint,
      'reviewer-a',
    )
    const markers = helpers.getWaveCreditMarkers()
    expect(markers?.['reviewer-a']).toBeDefined()
    // Both wave-universe files are present and carry the SAME marker the
    // completion record stored, so the finalization check's
    // `recordedMarker === storedMarker` comparison holds.
    const key = Object.keys(helpers.getWaveCompletions())[0]
    const recorded = helpers.getWaveCompletions()[key].creditedFileMarkers
    expect(markers?.['reviewer-a']).toEqual(recorded)
    // A second specialist accumulates into its OWN bucket, so the union over
    // routed specialists used at validation time matches the union used at
    // plan time.
    helpers.recordWaveCompletionsForFiles(
      ['agents/b.ts'],
      plannedWaves,
      fingerprint,
      'reviewer-b',
    )
    expect(helpers.getWaveCreditMarkers()?.['reviewer-b']).toBeDefined()
  })

  test('accumulated credit is discarded when the fingerprint changes', () => {
    const helpers = loadInlineReviewCreditHelpers()
    helpers.resetWaveCompletions()
    const plannedWaves = [['agents/a.ts', 'agents/b.ts']]
    helpers.recordWaveCompletionsForFiles(
      ['agents/a.ts'],
      plannedWaves,
      'v3:' + 'c'.repeat(64),
      'reviewer-a',
    )
    // A different fingerprint must not inherit the prior partial credit: the
    // wave stays incomplete until the new snapshot's files are credited.
    helpers.recordWaveCompletionsForFiles(
      ['agents/a.ts'],
      plannedWaves,
      'v3:' + 'd'.repeat(64),
      'reviewer-a',
    )
    const completions = helpers.getWaveCompletions()
    for (const entry of Object.values(completions)) {
      expect(entry.completedAt).toBeUndefined()
    }
  })

  test('the bound retains prior-snapshot waves so a revert re-finds its partial credit', () => {
    const helpers = loadInlineReviewCreditHelpers()
    const originalFingerprint = 'v3:' + 'f'.repeat(64)
    const intermediateFingerprint = 'v3:' + '0'.repeat(64)
    const waveKeyFor = (fingerprint: string) =>
      `${fingerprint}#w0#` + '0'.repeat(64)

    // The ORIGINAL snapshot credited wave 0 partially.
    const completions: Record<
      string,
      {
        fingerprint: string
        waveIndex: number
        files: string[]
        creditedFiles?: string[]
        creditedFileMarkers?: Record<string, string>
        completedAt?: string
      }
    > = {
      [waveKeyFor(originalFingerprint)]: {
        fingerprint: originalFingerprint,
        waveIndex: 0,
        files: ['agents/a.ts', 'agents/b.ts'],
        creditedFiles: ['agents/a.ts'],
        creditedFileMarkers: { 'agents/a.ts': 'v3:marker-a' },
      },
    }

    // An intermediate edit mints a new snapshot's key; bounding relative to it
    // must NOT evict the original snapshot's partial wave (a revert restores
    // the original fingerprint and therefore the original wave key).
    completions[waveKeyFor(intermediateFingerprint)] = {
      fingerprint: intermediateFingerprint,
      waveIndex: 0,
      files: ['agents/a.ts', 'agents/b.ts'],
      creditedFiles: ['agents/a.ts'],
      creditedFileMarkers: { 'agents/a.ts': 'v3:marker-a' },
    }
    const bounded = helpers.boundWaveCompletions(
      completions,
      intermediateFingerprint,
    )
    expect(bounded[waveKeyFor(originalFingerprint)]).toBeDefined()
    expect(
      bounded[waveKeyFor(originalFingerprint)].creditedFileMarkers,
    ).toEqual({ 'agents/a.ts': 'v3:marker-a' })
    expect(bounded[waveKeyFor(intermediateFingerprint)]).toBeDefined()
  })

  test('the bound keeps the current fingerprint and trims beyond the distinct-fingerprint limit', () => {
    const helpers = loadInlineReviewCreditHelpers()
    const currentFingerprint = 'v3:' + '9'.repeat(64)
    const completions: Record<
      string,
      {
        fingerprint: string
        waveIndex: number
        files: string[]
        creditedFiles?: string[]
        creditedFileMarkers?: Record<string, string>
        completedAt?: string
      }
    > = {}
    const waveKeyFor = (fingerprint: string, index: number) =>
      `${fingerprint}#w${index}#` + '0'.repeat(64)
    // 20 stale fingerprints (above the 8-fingerprint retention limit), each
    // with a single wave, plus the current fingerprint's wave.
    for (let i = 0; i < 20; i++) {
      const fingerprint = `v3:${i.toString(16).padStart(64, '0')}`
      completions[waveKeyFor(fingerprint, 0)] = {
        fingerprint,
        waveIndex: 0,
        files: ['agents/a.ts'],
        creditedFiles: ['agents/a.ts'],
      }
    }
    completions[waveKeyFor(currentFingerprint, 0)] = {
      fingerprint: currentFingerprint,
      waveIndex: 0,
      files: ['agents/a.ts'],
      creditedFiles: ['agents/a.ts'],
    }
    const bounded = helpers.boundWaveCompletions(
      completions,
      currentFingerprint,
    )
    // The current fingerprint always survives.
    expect(bounded[waveKeyFor(currentFingerprint, 0)]).toBeDefined()
    // The oldest stale fingerprint is evicted; the most recent stale ones stay.
    expect(
      bounded[waveKeyFor('v3:' + '0'.repeat(64), 0)],
    ).toBeUndefined()
    expect(
      bounded[waveKeyFor(`v3:${(19).toString(16).padStart(64, '0')}`, 0)],
    ).toBeDefined()
  })

  test('the bound ranks stale fingerprints by most-recent touch, not insertion order', () => {
    const helpers = loadInlineReviewCreditHelpers()
    const currentFingerprint = 'v3:' + '9'.repeat(64)
    const waveKeyFor = (fingerprint: string) => `${fingerprint}#w0#` + '0'.repeat(64)
    // `reverted` is inserted FIRST (early object position) but is RE-TOUCHED
    // last, so its `lastTouchedAt` stamp is the newest of the stale buckets.
    // Object insertion order does not move a re-written key to the end, so a
    // first-seen ordering would evict it; touch-recency must retain it.
    const revertedFingerprint = 'v3:' + '1'.repeat(64)
    const completions: Record<
      string,
      {
        fingerprint: string
        waveIndex: number
        files: string[]
        creditedFiles?: string[]
        creditedFileMarkers?: Record<string, string>
        completedAt?: string
        lastTouchedAt?: string
      }
    > = {}
    completions[waveKeyFor(revertedFingerprint)] = {
      fingerprint: revertedFingerprint,
      waveIndex: 0,
      files: ['agents/a.ts'],
      creditedFiles: ['agents/a.ts'],
      lastTouchedAt: new Date(Date.now() + 10_000).toISOString(),
    }
    // Fill the remaining distinct-fingerprint slots (limit is 8) with buckets
    // touched EARLIER than the reverted one, inserted AFTER it.
    for (let i = 0; i < 8; i++) {
      const fingerprint = `v3:${(i + 2).toString(16).padStart(64, '0')}`
      completions[waveKeyFor(fingerprint)] = {
        fingerprint,
        waveIndex: 0,
        files: ['agents/a.ts'],
        creditedFiles: ['agents/a.ts'],
        lastTouchedAt: new Date(1_000 + i).toISOString(),
      }
    }
    completions[waveKeyFor(currentFingerprint)] = {
      fingerprint: currentFingerprint,
      waveIndex: 0,
      files: ['agents/a.ts'],
      creditedFiles: ['agents/a.ts'],
      lastTouchedAt: new Date().toISOString(),
    }
    const bounded = helpers.boundWaveCompletions(
      completions,
      currentFingerprint,
    )
    // The most recently touched stale fingerprint survives despite sitting
    // early in insertion order; the two earliest-touched stale buckets are
    // evicted by the 8-distinct-fingerprint limit.
    expect(bounded[waveKeyFor(revertedFingerprint)]).toBeDefined()
    expect(bounded[waveKeyFor(currentFingerprint)]).toBeDefined()
    expect(
      bounded[waveKeyFor(`v3:${(2).toString(16).padStart(64, '0')}`)],
    ).toBeUndefined()
  })

  test('a re-credited wave refreshes its lastTouchedAt stamp', () => {
    const helpers = loadInlineReviewCreditHelpers()
    helpers.resetWaveCompletions()
    const fingerprint = 'v3:' + 'a'.repeat(64)
    const plannedWaves = [['agents/a.ts', 'agents/b.ts']]
    // First pass credits only part of the wave.
    helpers.recordWaveCompletionsForFiles(
      ['agents/a.ts'],
      plannedWaves,
      fingerprint,
      'reviewer-a',
    )
    const key = Object.keys(helpers.getWaveCompletions())[0]
    const firstStamp = helpers.getWaveCompletions()[key].lastTouchedAt
    expect(typeof firstStamp).toBe('string')
    // A later pass re-credits the SAME key in place; the stamp must be present
    // on the re-write (it is what makes the bucket rank as most-recently
    // touched even though its insertion position is unchanged).
    helpers.recordWaveCompletionsForFiles(
      ['agents/b.ts'],
      plannedWaves,
      fingerprint,
      'reviewer-a',
    )
    expect(typeof helpers.getWaveCompletions()[key].lastTouchedAt).toBe('string')
    expect(helpers.getWaveCompletions()[key].completedAt).toBeDefined()
  })
})

describe('base2 no-verdict convergence ledger retention', () => {
  test('the current pair is retained even when it was inserted before the eviction window', () => {
    const helpers = loadInlineReviewCreditHelpers()
    const limit = 128
    const codes: Record<string, string> = {}
    // The CURRENT pair's key is written FIRST, so it sits at the head of
    // insertion order; the >limit other pairs then push it outside
    // `slice(-limit)`.
    const currentKey = 'reviewer\nv3:' + 'e'.repeat(64)
    codes[currentKey] = 'prose_only'
    for (let i = 0; i < limit + 10; i++) {
      codes[`other-${i}\nv3:${i.toString(16).padStart(64, '0')}`] = 'prose_only'
    }
    // Re-write the current pair (an existing key re-write does NOT move it to
    // the end of insertion order) and bound the ledger.
    codes[currentKey] = 'prose_only'
    const bounded = helpers.boundNoVerdictDiagnosticCodes(codes, currentKey)
    expect(Object.keys(bounded)).toHaveLength(limit)
    expect(bounded[currentKey]).toBe('prose_only')
  })

  test('the bound keeps at most the limit and drops the oldest non-retained pairs', () => {
    const helpers = loadInlineReviewCreditHelpers()
    const codes: Record<string, string> = {}
    for (let i = 0; i < 200; i++) {
      codes[`k-${i}`] = 'unshaped_only'
    }
    const bounded = helpers.boundNoVerdictDiagnosticCodes(codes, 'k-199')
    expect(Object.keys(bounded)).toHaveLength(128)
    expect(bounded['k-199']).toBe('unshaped_only')
    expect(bounded['k-0']).toBeUndefined()
  })

  test('a ledger at or below the limit is returned unchanged', () => {
    const helpers = loadInlineReviewCreditHelpers()
    const codes: Record<string, string> = { 'k-0': 'prose_only' }
    expect(helpers.boundNoVerdictDiagnosticCodes(codes, 'k-0')).toBe(codes)
  })
})

describe('base2 wave-completion bound preserves fingerprint-less (legacy) entries', () => {
  test('an entry whose fingerprint is undefined survives the rebuild instead of being silently evicted', () => {
    // A legacy / partially-serialized wave completion carries no `fingerprint`.
    // It has no fingerprint to rank against the distinct-fingerprint limit, so
    // it must NOT be treated as disposable: the old code returned `true` from
    // `needsBound` for such an entry AND never inserted it into `byFingerprint`,
    // so the rebuild dropped it even when the ledger was otherwise within cap.
    const helpers = loadInlineReviewCreditHelpers()
    const currentFingerprint = 'v3:' + '9'.repeat(64)
    const legacyKey = 'legacy#w0#' + '0'.repeat(64)
    const completions: Record<
      string,
      {
        fingerprint: string
        waveIndex: number
        files: string[]
        creditedFiles?: string[]
        creditedFileMarkers?: Record<string, string>
        completedAt?: string
      }
    > = {
      [legacyKey]: {
        // Deliberately missing the required `fingerprint` member, exactly as a
        // completion serialized before the fingerprint field existed would be.
        fingerprint: undefined as unknown as string,
        waveIndex: 0,
        files: ['agents/a.ts'],
        creditedFiles: ['agents/a.ts'],
        creditedFileMarkers: { 'agents/a.ts': 'v3:marker-a' },
      },
      ['v3:' + '9'.repeat(64) + '#w0#' + '0'.repeat(64)]: {
        fingerprint: currentFingerprint,
        waveIndex: 0,
        files: ['agents/b.ts'],
        creditedFiles: ['agents/b.ts'],
      },
    }
    const bounded = helpers.boundWaveCompletions(
      completions,
      currentFingerprint,
    )
    // The fingerprint-less entry is retained with its credit intact.
    expect(bounded[legacyKey]).toBeDefined()
    expect(bounded[legacyKey].creditedFileMarkers).toEqual({
      'agents/a.ts': 'v3:marker-a',
    })
    // The current fingerprint's wave is retained too.
    expect(bounded[Object.keys(completions)[1]]).toBeDefined()
  })

  test('fingerprint-less entries do not consume the distinct-fingerprint budget', () => {
    // The 8-distinct-fingerprint limit ranks STAMPED fingerprints only; the
    // fingerprint-less bucket must not push a legitimately retained stale
    // fingerprint out of the window.
    const helpers = loadInlineReviewCreditHelpers()
    const currentFingerprint = 'v3:' + '9'.repeat(64)
    const waveKeyFor = (fingerprint: string) => `${fingerprint}#w0#` + '0'.repeat(64)
    const completions: Record<
      string,
      {
        fingerprint: string
        waveIndex: number
        files: string[]
        creditedFiles?: string[]
        creditedFileMarkers?: Record<string, string>
        completedAt?: string
      }
    > = {}
    // 8 stale fingerprints — exactly the retention limit — plus several
    // fingerprint-less entries and the current fingerprint.
    for (let i = 0; i < 8; i++) {
      const fingerprint = `v3:${(i + 1).toString(16).padStart(64, '0')}`
      completions[waveKeyFor(fingerprint)] = {
        fingerprint,
        waveIndex: 0,
        files: ['agents/a.ts'],
        creditedFiles: ['agents/a.ts'],
      }
    }
    for (let i = 0; i < 3; i++) {
      completions[`legacy-${i}#w0#` + '0'.repeat(64)] = {
        fingerprint: undefined as unknown as string,
        waveIndex: 0,
        files: ['agents/legacy.ts'],
        creditedFiles: ['agents/legacy.ts'],
      }
    }
    completions[waveKeyFor(currentFingerprint)] = {
      fingerprint: currentFingerprint,
      waveIndex: 0,
      files: ['agents/b.ts'],
      creditedFiles: ['agents/b.ts'],
    }
    const bounded = helpers.boundWaveCompletions(
      completions,
      currentFingerprint,
    )
    // Every legacy entry survives and no stale fingerprint was evicted early.
    for (let i = 0; i < 3; i++) {
      expect(bounded[`legacy-${i}#w0#` + '0'.repeat(64)]).toBeDefined()
    }
    expect(bounded[waveKeyFor(currentFingerprint)]).toBeDefined()
  })
})
