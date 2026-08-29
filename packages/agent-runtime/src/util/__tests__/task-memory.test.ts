import { describe, expect, test } from 'bun:test'
import { createInitialWorkspaceState } from '@codebuff/common/types/workspace-state'

import {
  bufferToolEvidenceForStep,
  commitTaskMemory,
  compileTaskMemoryContext,
  deriveTaskMemoryDraftFromMessages,
  deriveTaskMemoryFocusPaths,
  ensureTaskMemoryGoal,
  flushBufferedToolEvidenceIntoTaskMemory,
  mergeAgentReceiptIntoTaskMemory,
  mergeTaskMemoryDraft,
  recordToolEvidenceInTaskMemory,
} from '../task-memory'

const draft = {
  schemaVersion: 1 as const,
  goal: 'Ship the context compiler',
  requirements: ['Preserve requirements'],
  decisions: ['Use typed memory'],
  filesInspected: ['src/a.ts'],
  editsMade: [],
  validationResults: [],
  reviewReceipts: [],
  blockers: ['Need tests'],
  nextActions: ['Run tests'],
  historicalSummary: 'Earlier work',
  evidence: [],
}

const readFilesOutput = (entries: { path: string; contentHash: string }[]) => [
  {
    type: 'json' as const,
    value: {
      kind: 'read_files_result',
      version: 1,
      status: 'ok',
      results: entries.map((entry, requestIndex) => ({
        selector: 'file',
        requestIndex,
        path: entry.path,
        status: 'ok',
        complete: true,
        template: false,
        editAnchor: {
          startLine: 1,
          endLine: 40,
          contentHash: entry.contentHash,
          readCapability: `cap.v3.${entry.path}`,
        },
      })),
    },
  },
]

describe('task memory', () => {
  test('commits revisions transactionally and rejects stale writers', () => {
    const first = commitTaskMemory({
      draft,
      expectedRevision: -1,
      now: 10,
    })
    expect(first.revision).toBe(0)
    expect(first.checksum).toHaveLength(8)
    expect(() =>
      commitTaskMemory({
        current: first,
        draft,
        expectedRevision: -1,
      }),
    ).toThrow('revision conflict')
    const second = commitTaskMemory({
      current: first,
      draft: mergeTaskMemoryDraft(first, {
        ...draft,
        decisions: ['Compile per request'],
      }),
      expectedRevision: 0,
      now: 20,
    })
    expect(second.revision).toBe(1)
    expect(second.decisions).toEqual([
      'Use typed memory',
      'Compile per request',
    ])
  })

  test('compiles bounded role-specific request context', () => {
    const memory = commitTaskMemory({ draft, expectedRevision: -1 })
    const compiled = compileTaskMemoryContext({
      memory,
      agentType: 'editor',
      contextWindowTokens: 8_000,
      rootAgent: false,
    })
    expect(compiled).toContain('<task_memory>')
    expect(compiled).toContain('Ship the context compiler')
    expect(compiled).toContain('Need tests')
  })

  test('keeps critical recall fields valid and excludes revision-stale evidence for small models', () => {
    const memory = commitTaskMemory({
      draft: {
        ...draft,
        requirements: Array.from(
          { length: 40 },
          (_, index) => `Requirement ${index}: ${'detail '.repeat(80)}`,
        ),
        decisions: ['Use route-safe budgets'],
        blockers: ['Reviewer protocol must clear'],
        nextActions: ['Resume the exact pending validation action'],
        workspaceRevision: 9,
        workspaceSnapshotId: 'workspace-9',
        evidence: [
          {
            id: 'old-read',
            kind: 'read',
            summary: 'stale file contents',
            workspaceRevision: 8,
          },
          {
            id: 'live-read',
            kind: 'read',
            summary: 'fresh file contents',
            workspaceRevision: 9,
          },
        ],
      },
      expectedRevision: -1,
    })
    const compiled = compileTaskMemoryContext({
      memory,
      agentType: 'repair-editor',
      contextWindowTokens: 8_000,
      rootAgent: false,
    })
    const json = compiled.match(
      /<task_memory>[\s\S]*?\n(\{[\s\S]*\})\n<\/task_memory>/,
    )?.[1]
    expect(json).toBeDefined()
    const parsed = JSON.parse(json!)
    expect(compiled.length).toBeLessThan(4_000)
    expect(parsed.blockers).toContain('Reviewer protocol must clear')
    expect(parsed.nextActions).toContain(
      'Resume the exact pending validation action',
    )
    expect(parsed.workspaceRevision).toBe(9)
    expect(JSON.stringify(parsed.evidence)).toContain('fresh file contents')
    expect(JSON.stringify(parsed.evidence)).not.toContain('stale file contents')
  })

  test('keeps hash-verified path evidence across workspace revisions', () => {
    const compileWithStale = (stale: boolean) => {
      const memory = commitTaskMemory({
        draft: {
          ...draft,
          workspaceRevision: 20,
          workspaceSnapshotId: 'workspace-20',
          evidence: [
            {
              id: 'hash-verified-read',
              kind: 'read' as const,
              summary: 'hash-verified contents of src/a.ts',
              path: 'src/a.ts',
              stale,
              workspaceRevision: 3,
            },
          ],
        },
        expectedRevision: -1,
      })
      const compiled = compileTaskMemoryContext({ memory })
      const json = compiled.match(
        /<task_memory>[\s\S]*?\n(\{[\s\S]*\})\n<\/task_memory>/,
      )?.[1]
      expect(json).toBeDefined()
      return JSON.stringify(JSON.parse(json!).evidence)
    }

    // Reconciliation hashed this file against disk, so the revision counter
    // must not override its verdict.
    expect(compileWithStale(false)).toContain(
      'hash-verified contents of src/a.ts',
    )
    expect(compileWithStale(true)).not.toContain(
      'hash-verified contents of src/a.ts',
    )
  })

  test('still guards pathless evidence by workspace revision', () => {
    const memory = commitTaskMemory({
      draft: {
        ...draft,
        workspaceRevision: 20,
        workspaceSnapshotId: 'workspace-20',
        evidence: [
          {
            id: 'pathless-read',
            kind: 'read' as const,
            summary: 'unverifiable observation without a path',
            workspaceRevision: 3,
          },
        ],
      },
      expectedRevision: -1,
    })
    const compiled = compileTaskMemoryContext({ memory })
    expect(compiled).not.toContain('unverifiable observation without a path')
  })

  test('per-kind evidence caps stop review churn evicting reads', () => {
    const reads = Array.from({ length: 5 }, (_, index) => ({
      id: `read-${index}`,
      kind: 'read' as const,
      summary: `read evidence ${index}`,
      path: `src/read-${index}.ts`,
      verifiedAt: index + 1,
    }))
    const reviews = Array.from({ length: 300 }, (_, index) => ({
      id: `review-${index}`,
      kind: 'review' as const,
      summary: `review evidence ${index}`,
      verifiedAt: 1_000 + index,
    }))
    const memory = commitTaskMemory({
      draft: { ...draft, evidence: [...reads, ...reviews] },
      expectedRevision: -1,
    })

    const storedReviews = memory.evidence.filter(
      (item) => item.kind === 'review',
    )
    const storedReads = memory.evidence.filter((item) => item.kind === 'read')
    expect(storedReviews).toHaveLength(32)
    expect(storedReviews[storedReviews.length - 1]!.id).toBe('review-299')
    expect(storedReads.map((item) => item.id)).toEqual(
      reads.map((item) => item.id),
    )
  })

  test('focusPaths reorders evidence selection toward the requested files', () => {
    const memory = commitTaskMemory({
      draft: {
        ...draft,
        evidence: [
          {
            id: 'target-read',
            kind: 'read' as const,
            summary: 'target file behavior',
            path: 'src/target.ts',
            verifiedAt: 1,
          },
          ...Array.from({ length: 8 }, (_, index) => ({
            id: `unrelated-${index}`,
            kind: 'read' as const,
            summary: `unrelated observation ${index}`,
            path: `src/unrelated-${index}.ts`,
            verifiedAt: 100 + index,
          })),
        ],
      },
      expectedRevision: -1,
    })
    const compileParams = {
      memory,
      agentType: 'editor',
      contextWindowTokens: 8_000,
      rootAgent: false,
    }
    const evidenceOf = (compiled: string) => {
      const json = compiled.match(
        /<task_memory>[\s\S]*?\n(\{[\s\S]*\})\n<\/task_memory>/,
      )?.[1]
      expect(json).toBeDefined()
      return JSON.stringify(JSON.parse(json!).evidence)
    }

    expect(evidenceOf(compileTaskMemoryContext(compileParams))).not.toContain(
      'target file behavior',
    )
    expect(
      evidenceOf(
        compileTaskMemoryContext({
          ...compileParams,
          focusPaths: ['src/target.ts'],
        }),
      ),
    ).toContain('target file behavior')
  })

  test('focus matching ignores near-miss filenames and honors directory prefixes', () => {
    const memory = commitTaskMemory({
      draft: {
        ...draft,
        evidence: [
          {
            id: 'read:src/a.tsx',
            kind: 'read' as const,
            summary: 'Read src/a.tsx lines 1-40',
            path: 'src/a.tsx',
            verifiedAt: 1,
          },
          {
            id: 'read:src/nested/child.ts',
            kind: 'read' as const,
            summary: 'Read src/nested/child.ts lines 1-40',
            path: 'src/nested/child.ts',
            verifiedAt: 2,
          },
          ...Array.from({ length: 8 }, (_, index) => ({
            id: `unrelated-${index}`,
            kind: 'note' as const,
            summary: `unrelated note ${index}`,
            verifiedAt: 100 + index,
          })),
        ],
      },
      expectedRevision: -1,
    })
    const compileParams = {
      memory,
      agentType: 'editor',
      contextWindowTokens: 8_000,
      rootAgent: false,
    }
    const evidenceOf = (compiled: string) => {
      const json = compiled.match(
        /<task_memory>[\s\S]*?\n(\{[\s\S]*\})\n<\/task_memory>/,
      )?.[1]
      expect(json).toBeDefined()
      return JSON.stringify(JSON.parse(json!).evidence)
    }

    // `src/a.ts` must not score `src/a.tsx`: substring matching used to promote
    // the near-miss filename into the compiled block.
    expect(
      evidenceOf(
        compileTaskMemoryContext({
          ...compileParams,
          focusPaths: ['src/a.ts'],
        }),
      ),
    ).not.toContain('src/a.tsx')

    // A segment-aware directory prefix still scores the files beneath it.
    expect(
      evidenceOf(
        compileTaskMemoryContext({
          ...compileParams,
          focusPaths: ['src/nested'],
        }),
      ),
    ).toContain('src/nested/child.ts')
  })

  test('empty focusPaths compiles identically to omitting focusPaths', () => {
    const memory = commitTaskMemory({
      draft: {
        ...draft,
        evidence: [
          {
            id: 'read-a',
            kind: 'read' as const,
            summary: 'observation about src/a.ts',
            path: 'src/a.ts',
            verifiedAt: 2,
          },
          {
            id: 'decision-a',
            kind: 'decision' as const,
            summary: 'chose the bounded compiler',
            verifiedAt: 1,
          },
        ],
      },
      expectedRevision: -1,
      now: 5,
    })
    expect(compileTaskMemoryContext({ memory, focusPaths: [] })).toBe(
      compileTaskMemoryContext({ memory }),
    )
  })

  test('derived focus paths pull request-relevant evidence into the compiled block', () => {
    const memory = commitTaskMemory({
      draft: {
        ...draft,
        evidence: [
          {
            id: 'validation-target',
            kind: 'validation' as const,
            summary: 'bun test failed for src/target.ts',
            verifiedAt: 1,
          },
          ...Array.from({ length: 6 }, (_, index) => ({
            id: `note-${index}`,
            kind: 'note' as const,
            summary: `unrelated note ${index}`,
            verifiedAt: 10 + index,
          })),
          {
            id: 'read:src/target.ts',
            kind: 'read' as const,
            summary: 'Read src/target.ts lines 1-40',
            path: 'src/target.ts',
            freshnessHash: 'target',
            verifiedAt: 100,
          },
        ],
      },
      expectedRevision: -1,
    })

    // Only read/edit evidence names a file the request is working on.
    expect(deriveTaskMemoryFocusPaths(memory)).toEqual(['src/target.ts'])

    const compileParams = {
      memory,
      agentType: 'editor',
      contextWindowTokens: 8_000,
      rootAgent: false,
    }
    const evidenceOf = (compiled: string) => {
      const json = compiled.match(
        /<task_memory>[\s\S]*?\n(\{[\s\S]*\})\n<\/task_memory>/,
      )?.[1]
      expect(json).toBeDefined()
      return JSON.stringify(JSON.parse(json!).evidence)
    }

    // Recency alone spends the small evidence budget on the newest unrelated
    // notes; the focus paths the production caller derives keep the validation
    // evidence about the file actually under work.
    expect(evidenceOf(compileTaskMemoryContext(compileParams))).not.toContain(
      'bun test failed for src/target.ts',
    )
    expect(
      evidenceOf(
        compileTaskMemoryContext({
          ...compileParams,
          focusPaths: deriveTaskMemoryFocusPaths(memory),
        }),
      ),
    ).toContain('bun test failed for src/target.ts')
  })

  test('deriveTaskMemoryFocusPaths ignores stale and pathless evidence', () => {
    expect(deriveTaskMemoryFocusPaths(undefined)).toEqual([])
    const memory = commitTaskMemory({
      draft: {
        ...draft,
        evidence: [
          {
            id: 'read:src/stale.ts',
            kind: 'read' as const,
            summary: 'Read src/stale.ts lines 1-10',
            path: 'src/stale.ts',
            stale: true,
            verifiedAt: 3,
          },
          {
            id: 'decision-1',
            kind: 'decision' as const,
            summary: 'chose the bounded compiler',
            verifiedAt: 2,
          },
          {
            id: 'edit:src/live.ts',
            kind: 'edit' as const,
            summary: 'update src/live.ts',
            path: 'src/live.ts',
            freshnessHash: 'live',
            verifiedAt: 1,
          },
        ],
      },
      expectedRevision: -1,
    })
    expect(deriveTaskMemoryFocusPaths(memory)).toEqual(['src/live.ts'])
  })

  test('repeat reads of an unchanged file cost no revision', () => {
    const first = recordToolEvidenceInTaskMemory({
      toolName: 'read_files',
      callId: 'call-read-1',
      output: readFilesOutput([
        { path: 'src/a.ts', contentHash: 'sha256:same' },
      ]),
    })
    expect(first).toBeDefined()

    // Byte-identical derived evidence returns the same object, so the caller
    // skips the write entirely.
    expect(
      recordToolEvidenceInTaskMemory({
        current: first,
        toolName: 'read_files',
        callId: 'call-read-2',
        output: readFilesOutput([
          { path: 'src/a.ts', contentHash: 'sha256:same' },
        ]),
      }),
    ).toBe(first)

    // A changed hash is genuinely new evidence and still commits.
    const changed = recordToolEvidenceInTaskMemory({
      current: first,
      toolName: 'read_files',
      callId: 'call-read-3',
      output: readFilesOutput([
        { path: 'src/a.ts', contentHash: 'sha256:changed' },
      ]),
    })
    expect(changed!.revision).toBe(first!.revision + 1)
    // Stored without the `sha256:` prefix, matching what the SDK store's
    // `hashFile` produces and compares against.
    expect(
      changed!.evidence.find((item) => item.id === 'read:src/a.ts')!
        .freshnessHash,
    ).toBe('changed')
  })

  test('imports legacy knowledge blocks without making them authoritative chat', () => {
    const derived = deriveTaskMemoryDraftFromMessages({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                '<knowledge_memory>',
                'Goal:',
                '  Keep state',
                'Decisions:',
                '  - Use revisions',
                'Blockers:',
                '  - None',
                'Next Action:',
                '  Validate',
                '</knowledge_memory>',
              ].join('\n'),
            },
          ],
        },
      ],
    })
    expect(derived.goal).toBe('Keep state')
    expect(derived.decisions).toEqual(['Use revisions'])
    expect(derived.nextActions).toEqual(['Validate'])
  })

  test('preserves requirements, decisions, blockers, revision, and resume action across repeated compactions', () => {
    let memory = commitTaskMemory({
      expectedRevision: -1,
      now: 1,
      draft: {
        ...draft,
        requirements: ['Never lose the user requirement'],
        decisions: ['Keep typed memory authoritative'],
        blockers: ['Fresh reviewer receipt still required'],
        nextActions: ['Run the matching reviewer gate'],
        workspaceRevision: 17,
        workspaceSnapshotId: 'workspace-17',
      },
    })

    for (let pass = 0; pass < 4; pass += 1) {
      memory = commitTaskMemory({
        current: memory,
        expectedRevision: memory.revision,
        now: pass + 2,
        draft: mergeTaskMemoryDraft(memory, {
          ...draft,
          goal: '',
          requirements: [],
          decisions: [],
          blockers: [],
          nextActions: [],
          historicalSummary: `compaction pass ${pass + 1}`,
          workspaceRevision: 17,
          workspaceSnapshotId: 'workspace-17',
        }),
      })
    }

    expect(memory.revision).toBe(4)
    for (const contextWindowTokens of [32_000, 1_000_000]) {
      const compiled = compileTaskMemoryContext({
        memory,
        agentType: 'base2',
        contextWindowTokens,
        rootAgent: true,
      })
      expect(compiled).toContain('Never lose the user requirement')
      expect(compiled).toContain('Keep typed memory authoritative')
      expect(compiled).toContain('Fresh reviewer receipt still required')
      expect(compiled).toContain('Run the matching reviewer gate')
      expect(compiled).toContain('workspace-17')
    }
  })

  test('stores oversized reviewer receipts as bounded valid JSON', () => {
    const longEvidence = 'evidence '.repeat(300)
    const snapshotFingerprint =
      '42e53a6db836535c0088089375e4601d23061e52d7b44f39fa85815fc225523a'
    const memory = mergeAgentReceiptIntoTaskMemory({
      objective: 'Review the routed change',
      receipt: {
        schemaVersion: 1,
        receiptId: 'review-receipt-1',
        taskId: 'review-task-1',
        role: 'reviewer',
        agentId: 'integration-reviewer-1',
        status: 'completed',
        changedFiles: [],
        requirementsAddressed: [],
        acceptanceCriteriaAddressed: [],
        findingsAddressed: [],
        evidence: [
          {
            id: 'review-evidence-1',
            kind: 'review',
            summary: longEvidence,
          },
        ],
        assumptions: [],
        unresolved: [],
        requestedValidation: [],
        artifacts: [],
        errors: [],
        output: {
          schemaVersion: 1,
          family: 'reviewer',
          verdict: 'LOOKS_GOOD',
          snapshotFingerprint,
          reviewedFiles: [
            'client/src/routes/_index/compare.lazy.tsx',
            'client/src/routes/_index/blog/index.lazy.tsx',
            'client/src/routes/_index/index.lazy.tsx',
          ],
          coverage: 'covered',
          dimensions: { integration: 'pass' },
          findings: [],
          requirementCoverage: [
            {
              requirement:
                'Continue after correcting the specialist protocol output',
              status: 'satisfied',
              evidence: [longEvidence],
            },
          ],
        },
      },
    })

    expect(memory.reviewReceipts).toHaveLength(1)
    expect(memory.reviewReceipts[0]!.length).toBeLessThanOrEqual(4_000)
    const stored = JSON.parse(memory.reviewReceipts[0]!)
    expect(stored.review).toMatchObject({
      verdict: 'LOOKS_GOOD',
      snapshotFingerprint,
      reviewedFileCount: 3,
      requirementCount: 1,
    })
  })

  test('ensureTaskMemoryGoal captures the goal once and never burns repeat revisions', () => {
    // Nothing observed and nothing stored: no record is worth creating.
    expect(ensureTaskMemoryGoal({ goal: '   ' })).toBeUndefined()

    const withoutGoal = commitTaskMemory({
      draft: { ...draft, goal: '' },
      expectedRevision: -1,
      now: 1,
    })
    const captured = ensureTaskMemoryGoal({
      current: withoutGoal,
      goal: '  Capture the goal outside compaction  ',
      workspaceState: createInitialWorkspaceState(0),
    })
    expect(captured?.goal).toBe('Capture the goal outside compaction')
    expect(captured?.revision).toBe(withoutGoal.revision + 1)
    expect(captured?.workspaceRevision).toBe(0)
    expect(captured?.workspaceSnapshotId).toBe('workspace.v1.0.00000000')
    // Other fields survive the goal-only commit.
    expect(captured?.requirements).toEqual(withoutGoal.requirements)

    // Repeat steps must reuse the same object so no revision is spent.
    expect(
      ensureTaskMemoryGoal({ current: captured, goal: 'A different phrasing' }),
    ).toBe(captured)
  })

  test('recordToolEvidenceInTaskMemory records root-level reads', () => {
    const memory = recordToolEvidenceInTaskMemory({
      toolName: 'read_files',
      callId: 'call-read-1',
      output: readFilesOutput([
        { path: 'src/a.ts', contentHash: 'sha256:aaa' },
        { path: 'src/b.ts', contentHash: 'sha256:bbb' },
      ]),
    })
    expect(memory).toBeDefined()
    const reads = memory!.evidence.filter((item) => item.kind === 'read')
    expect(reads).toHaveLength(2)
    expect(reads.map((item) => item.path)).toEqual(['src/a.ts', 'src/b.ts'])
    // The runtime producer emits `sha256:<hex>` but the consumer (`hashFile` in
    // sdk/src/services/task-memory-store.ts) emits a bare hex digest, so the
    // prefix is stripped at record time or every entry reconciles stale.
    expect(reads.map((item) => item.freshnessHash)).toEqual(['aaa', 'bbb'])
    expect(memory!.filesInspected).toEqual(['src/a.ts', 'src/b.ts'])
  })

  test('records only complete whole-file reads, never range/symbol slices', () => {
    const memory = recordToolEvidenceInTaskMemory({
      toolName: 'read_files',
      callId: 'call-read-mixed',
      output: [
        {
          type: 'json',
          value: {
            kind: 'read_files_result',
            version: 1,
            status: 'ok',
            results: [
              {
                selector: 'file',
                requestIndex: 0,
                path: 'src/whole.ts',
                status: 'ok',
                complete: true,
                template: false,
                editAnchor: {
                  startLine: 1,
                  endLine: 40,
                  contentHash: 'sha256:whole',
                  readCapability: 'cap.v3.whole',
                },
              },
              {
                // A range anchor hashes only the slice, so the store's
                // whole-file digest could never match it.
                selector: 'range',
                requestIndex: 1,
                path: 'src/slice.ts',
                status: 'ok',
                complete: true,
                startLine: 10,
                endLine: 20,
                totalLines: 400,
                editAnchor: {
                  startLine: 10,
                  endLine: 20,
                  contentHash: 'sha256:slice',
                  readCapability: 'cap.v3.slice',
                },
              },
            ],
          },
        },
      ],
    })
    expect(memory!.evidence.map((item) => item.path)).toEqual(['src/whole.ts'])
    expect(memory!.filesInspected).toEqual(['src/whole.ts'])
  })

  test('per-loop caps keep a full read payload from starving the mutation loop', () => {
    const reads = Array.from({ length: 40 }, (_, index) => ({
      path: `src/read-${index}.ts`,
      contentHash: `sha256:read-${index}`,
    }))
    const memory = recordToolEvidenceInTaskMemory({
      toolName: 'read_files',
      callId: 'call-both-kinds',
      output: [
        ...readFilesOutput(reads),
        {
          type: 'json',
          value: {
            kind: 'file_mutation_result',
            version: 1,
            operationId: 'op-both',
            outcome: 'applied',
            actions: [
              {
                actionId: 'a-0',
                index: 0,
                action: 'update',
                path: 'src/edited.ts',
                outcome: 'applied',
                beforeHash: 'sha256:before',
                afterHash: 'sha256:after',
              },
            ],
          },
        },
      ],
    })
    const readEntries = memory!.evidence.filter((item) => item.kind === 'read')
    // The read loop stops at its own 32-entry cap...
    expect(readEntries).toHaveLength(32)
    // ...and the mutation loop still records, because the caps are per loop
    // rather than shared across the combined evidence length.
    expect(
      memory!.evidence.filter((item) => item.kind === 'edit')[0]!.path,
    ).toBe('src/edited.ts')
  })

  test('one step-scoped commit covers every buffered tool result', () => {
    const owner = {}
    bufferToolEvidenceForStep({
      owner,
      toolName: 'read_files',
      callId: 'call-read-a',
      output: readFilesOutput([
        { path: 'src/a.ts', contentHash: 'sha256:aaa' },
      ]),
    })
    bufferToolEvidenceForStep({
      owner,
      toolName: 'read_files',
      callId: 'call-read-b',
      output: readFilesOutput([
        { path: 'src/b.ts', contentHash: 'sha256:bbb' },
      ]),
    })

    const flushed = flushBufferedToolEvidenceIntoTaskMemory({ owner })
    // Concurrent calls in one step used to each commit revision N+1, so the
    // second assignment silently clobbered the first call's evidence. One
    // commit per step keeps both.
    expect(flushed!.revision).toBe(0)
    expect(flushed!.evidence.map((item) => item.id)).toEqual([
      'read:src/a.ts',
      'read:src/b.ts',
    ])
    expect(flushed!.filesInspected).toEqual(['src/a.ts', 'src/b.ts'])

    // The buffer is cleared, so a step with no tool evidence commits nothing.
    expect(
      flushBufferedToolEvidenceIntoTaskMemory({
        owner,
        current: flushed,
      }),
    ).toBeUndefined()
  })

  test('buffering ignores tool results with no derivable evidence', () => {
    const owner = {}
    bufferToolEvidenceForStep({
      owner,
      toolName: 'list_directory',
      callId: 'call-list-1',
      output: [
        {
          type: 'json',
          value: {
            kind: 'list_directory_result',
            version: 1,
            entries: [{ path: 'src', type: 'directory' }],
          },
        },
      ],
    })
    expect(flushBufferedToolEvidenceIntoTaskMemory({ owner })).toBeUndefined()
  })

  test('recordToolEvidenceInTaskMemory records only applied mutation actions', () => {
    const memory = recordToolEvidenceInTaskMemory({
      toolName: 'edit_transaction',
      callId: 'call-edit-1',
      output: [
        {
          type: 'json',
          value: {
            kind: 'file_mutation_result',
            version: 1,
            operationId: 'op-1',
            outcome: 'partial',
            actions: [
              {
                actionId: 'a-0',
                index: 0,
                action: 'update',
                path: 'src/applied.ts',
                outcome: 'applied',
                beforeHash: 'sha256:before',
                afterHash: 'sha256:after',
              },
              {
                actionId: 'a-1',
                index: 1,
                action: 'delete',
                path: 'src/removed.ts',
                outcome: 'applied',
                beforeHash: 'sha256:before',
                afterHash: null,
              },
              {
                actionId: 'a-2',
                index: 2,
                action: 'update',
                path: 'src/skipped.ts',
                outcome: 'not_applied',
                beforeHash: null,
                afterHash: null,
              },
            ],
          },
        },
      ],
    })
    expect(memory).toBeDefined()
    const edits = memory!.evidence.filter((item) => item.kind === 'edit')
    expect(edits.map((item) => item.path)).toEqual([
      'src/applied.ts',
      'src/removed.ts',
    ])
    expect(edits[0]!.freshnessHash).toBe('after')
    // A deleted file has no post-state hash to verify against.
    expect(edits[1]!.freshnessHash).toBeUndefined()
    expect(memory!.editsMade).toEqual(['src/applied.ts', 'src/removed.ts'])
    expect(JSON.stringify(memory!.evidence)).not.toContain('src/skipped.ts')
  })

  test('re-reading a file replaces its stale evidence instead of duplicating it', () => {
    const first = recordToolEvidenceInTaskMemory({
      toolName: 'read_files',
      callId: 'call-read-1',
      output: readFilesOutput([
        { path: 'src/a.ts', contentHash: 'sha256:old' },
      ]),
    })
    const second = recordToolEvidenceInTaskMemory({
      current: first,
      toolName: 'read_files',
      callId: 'call-read-2',
      output: readFilesOutput([
        { path: 'src/a.ts', contentHash: 'sha256:new' },
      ]),
    })
    const entries = second!.evidence.filter(
      (item) => item.id === 'read:src/a.ts',
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]!.freshnessHash).toBe('new')
    expect(second!.filesInspected).toEqual(['src/a.ts'])
  })

  test('recordToolEvidenceInTaskMemory skips tool results with no derivable evidence', () => {
    expect(
      recordToolEvidenceInTaskMemory({
        toolName: 'list_directory',
        callId: 'call-list-1',
        output: [
          {
            type: 'json',
            value: {
              kind: 'list_directory_result',
              version: 1,
              entries: [{ path: 'src', type: 'directory' }],
            },
          },
        ],
      }),
    ).toBeUndefined()

    // Reads without a trustworthy anchor hash are skipped too: a partial slice
    // would reconcile as permanently stale.
    expect(
      recordToolEvidenceInTaskMemory({
        toolName: 'read_files',
        callId: 'call-read-partial',
        output: [
          {
            type: 'json',
            value: {
              kind: 'read_files_result',
              version: 1,
              status: 'partial',
              results: [
                {
                  selector: 'file',
                  requestIndex: 0,
                  path: 'src/a.ts',
                  status: 'partial',
                  complete: false,
                  template: false,
                },
              ],
            },
          },
        ],
      }),
    ).toBeUndefined()
  })

  test('merge dedupes repeated list entries', () => {
    const base = commitTaskMemory({ draft, expectedRevision: -1 })
    const merged = mergeTaskMemoryDraft(base, {
      ...draft,
      decisions: ['Use typed memory'],
    })
    expect(
      merged.decisions.filter((entry) => entry === 'Use typed memory'),
    ).toHaveLength(1)
  })

  test('the compiled banner scopes its freshness claim to session start', () => {
    const memory = commitTaskMemory({ draft, expectedRevision: -1 })
    const banner = compileTaskMemoryContext({ memory }).split('\n')[1]!
    // Nothing re-reconciles mid-session, so the banner must not claim that all
    // stale evidence is excluded: a read entry recorded before this session
    // edited the same file is still compiled in.
    expect(banner).toContain('at session start')
    expect(banner).toContain('not re-verified')
    expect(banner).toContain('verify live files before mutation')
  })

  test('compile excludes stale evidence from request context', () => {
    const memory = commitTaskMemory({
      draft: {
        ...draft,
        evidence: [
          {
            id: 'ev-fresh',
            kind: 'decision' as const,
            summary: 'Fresh decision context',
          },
          {
            id: 'ev-stale',
            kind: 'read' as const,
            summary: 'Stale observation about auth.ts internals',
            stale: true,
          },
        ],
      },
      expectedRevision: -1,
    })
    const compiled = compileTaskMemoryContext({ memory })
    expect(compiled).toContain('<task_memory>')
    expect(compiled).toContain('Fresh decision context')
    expect(compiled).not.toContain('Stale observation about auth.ts internals')
  })

  test('budget overflow keeps newest entries instead of backfilling older ones', () => {
    // Root-agent budgets at scale 1 give decisions maxItemChars=520 and
    // maxTotalChars=3600. The 300-char newest entry plus seven ~519-char
    // fillers exhaust the budget mid-list, so the small oldest entry must
    // be dropped (break) rather than backfilled around the overflow
    // (which the old `continue` did, inverting recency priority).
    const memory = commitTaskMemory({
      draft: {
        ...draft,
        decisions: [
          'old-small-marker',
          ...Array.from(
            { length: 7 },
            (_, index) => `filler-${index}-` + 'x'.repeat(510),
          ),
          'newest-decision-survives',
        ],
      },
      expectedRevision: -1,
    })
    const compiled = compileTaskMemoryContext({ memory, rootAgent: true })
    const json = compiled.match(
      /<task_memory>[\s\S]*?\n(\{[\s\S]*\})\n<\/task_memory>/,
    )?.[1]
    expect(json).toBeDefined()
    const parsed = JSON.parse(json!)
    const decisions: string[] = parsed.decisions
    expect(decisions[decisions.length - 1]).toContain(
      'newest-decision-survives',
    )
    expect(JSON.stringify(decisions)).not.toContain('old-small-marker')
  })

  test('buffer drops evidence beyond MAX_BUFFERED_STEP_EVIDENCE', () => {
    const owner = {}
    // Each buffered call contributes one evidence entry; loop past the 512
    // cap so the drop branch is exercised. The raw buffer holds 512 entries
    // (0-511), but the committed evidence is then trimmed by the per-kind
    // cap (read: 64), so the flushed result keeps the 64 newest reads.
    for (let index = 0; index < 600; index += 1) {
      bufferToolEvidenceForStep({
        owner,
        toolName: 'read_files',
        callId: `call-${index}`,
        output: readFilesOutput([
          { path: `src/file-${index}.ts`, contentHash: `sha256:hash-${index}` },
        ]),
      })
    }
    const flushed = flushBufferedToolEvidenceIntoTaskMemory({ owner })
    expect(flushed).toBeDefined()
    // Raw buffer capped at 512, then per-kind cap trims reads to 64 newest.
    expect(flushed!.evidence).toHaveLength(64)
    expect(flushed!.evidence[0]!.path).toBe('src/file-448.ts')
    expect(flushed!.evidence[63]!.path).toBe('src/file-511.ts')
    // Buffer is cleared after commit; subsequent flush yields nothing.
    expect(flushBufferedToolEvidenceIntoTaskMemory({ owner })).toBeUndefined()
  })

  test('two distinct owners buffer and flush independently', () => {
    const ownerA = {}
    const ownerB = {}
    bufferToolEvidenceForStep({
      owner: ownerA,
      toolName: 'read_files',
      callId: 'call-a-1',
      output: readFilesOutput([
        { path: 'src/a.ts', contentHash: 'sha256:aaa' },
      ]),
    })
    bufferToolEvidenceForStep({
      owner: ownerB,
      toolName: 'read_files',
      callId: 'call-b-1',
      output: readFilesOutput([
        { path: 'src/b.ts', contentHash: 'sha256:bbb' },
      ]),
    })
    bufferToolEvidenceForStep({
      owner: ownerA,
      toolName: 'read_files',
      callId: 'call-a-2',
      output: readFilesOutput([
        { path: 'src/a2.ts', contentHash: 'sha256:aaa2' },
      ]),
    })
    const flushedA = flushBufferedToolEvidenceIntoTaskMemory({ owner: ownerA })
    const flushedB = flushBufferedToolEvidenceIntoTaskMemory({ owner: ownerB })
    expect(flushedA!.evidence.map((item) => item.path)).toEqual([
      'src/a.ts',
      'src/a2.ts',
    ])
    expect(flushedB!.evidence.map((item) => item.path)).toEqual(['src/b.ts'])
    // Each owner's buffer is isolated and cleared independently.
    expect(
      flushBufferedToolEvidenceIntoTaskMemory({ owner: ownerA }),
    ).toBeUndefined()
    expect(
      flushBufferedToolEvidenceIntoTaskMemory({ owner: ownerB }),
    ).toBeUndefined()
  })
})
