import { describe, expect, it } from 'bun:test'

import { writeAuditFindingsParams } from '../tool/write-audit-findings'

import type { AuditFindingsInput } from '../tool/write-audit-findings'

const validInput = {
  sessionSlug: 'audit-openbuff-2026-07',
  shardId: 'runtime-1',
  snapshotId: 'snapshot-1',
  findings: [],
  coverage: {
    subsystemIds: ['agent-runtime'],
    featureIds: ['tool-dispatch'],
    files: ['packages/agent-runtime/src/tools/tool-executor.ts'],
    domains: [
      'security',
      'correctness',
      'state-mutation',
      'error-handling',
      'performance',
      'dependency-hygiene',
      'test-coverage',
      'api-contract',
    ],
  },
  noIssuesFound: true,
}

describe('write_audit_findings input', () => {
  it('accepts one safe derived-artifact identity', () => {
    const parsed = writeAuditFindingsParams.inputSchema.safeParse(validInput)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.coverage.domains).toContain('api-contract')
    }
  })

  it('keeps legacy calls without snapshotId valid', () => {
    const { snapshotId: _snapshotId, ...legacyInput } = validInput
    expect(
      writeAuditFindingsParams.inputSchema.safeParse(legacyInput).success,
    ).toBe(true)
  })

  it('keeps legacy calls without explicit domains valid', () => {
    const { domains: _domains, ...coverage } = validInput.coverage
    expect(
      writeAuditFindingsParams.inputSchema.safeParse({
        ...validInput,
        coverage,
      }).success,
    ).toBe(true)
  })

  it('rejects an explicitly empty coverage.domains list', () => {
    // coverageDomainsNonEmptyRule: domains carries .min(1), so an explicit []
    // is rejected rather than treated as an omitted field (which the previous
    // test covers). Only the omitted path was tested before.
    const parsed = writeAuditFindingsParams.inputSchema.safeParse({
      ...validInput,
      coverage: { ...validInput.coverage, domains: [] },
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects a snapshot-bound call with an empty coverage.subsystemIds', () => {
    // snapshotCoverageCompletenessRule: when snapshotId AND coverage.domains
    // are both present the call emits a structuralReceipt, so subsystemIds
    // must name at least one entry (evaluate_audit_coverage rejects an empty
    // subsystem_ids list). Fail-closed guard with no prior coverage.
    const parsed = writeAuditFindingsParams.inputSchema.safeParse({
      ...validInput,
      coverage: { ...validInput.coverage, subsystemIds: [] },
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects a snapshot-bound call with an empty coverage.files', () => {
    // Same fail-closed snapshotCoverageCompletenessRule guard for the files
    // list: an empty files list yields a structuralReceipt that
    // evaluate_audit_coverage rejects, so it is rejected at this boundary.
    const parsed = writeAuditFindingsParams.inputSchema.safeParse({
      ...validInput,
      coverage: { ...validInput.coverage, files: [] },
    })
    expect(parsed.success).toBe(false)
  })

  it('recovers findings entries serialized as individual JSON strings', () => {
    // Some tool-calling models stringify each findings entry rather than the
    // whole array. The alias layer's coerceToArray recovers a stringified
    // whole array, but per-entry stringified objects previously reached Zod as
    // `findings[0]: expected object, received string`.
    const finding = {
      severity: 'LOW',
      domain: 'correctness',
      path: 'src/index.ts',
      title: 'A finding',
      risk: 'Something could go wrong.',
      fix: 'Do the safe thing.',
      evidence: 'The relevant code path.',
    }
    const parsed = writeAuditFindingsParams.inputSchema.safeParse({
      ...validInput,
      findings: [JSON.stringify(finding), JSON.stringify(finding)],
      noIssuesFound: false,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.findings).toHaveLength(2)
      expect(parsed.data.findings[0]?.domain).toBe('correctness')
    }
  })

  it('leaves a genuinely malformed findings string as a validation error', () => {
    // A string entry that does not parse to a plain object is passed through
    // untouched so validation still fails closed rather than guessing.
    const parsed = writeAuditFindingsParams.inputSchema.safeParse({
      ...validInput,
      findings: ['not json at all'],
      noIssuesFound: false,
    })
    expect(parsed.success).toBe(false)
  })

  it('normalizes the legacy api-abi finding domain', () => {
    const parsed = writeAuditFindingsParams.inputSchema.safeParse({
      ...validInput,
      findings: [
        {
          severity: 'LOW',
          domain: 'api-abi',
          path: 'src/index.ts',
          title: 'Compatibility note',
          risk: 'Contracts could drift.',
          fix: 'Keep the public contract aligned.',
          evidence: 'The exported shape is public.',
        },
      ],
      noIssuesFound: false,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.findings[0]?.domain).toBe('api-contract')
    }
  })

  it('AuditFindingsInput accepts the api-abi alias and omittable noIssuesFound', () => {
    // AuditFindingsInput is the accepted call surface (z.input of inputSchema),
    // so it must admit the documented legacy 'api-abi' findings[].domain alias
    // and treat noIssuesFound as omittable — the same surface the generated
    // WriteAuditFindingsParams advertises. The annotated assignment is a
    // compile-time regression guard: the previous z.infer definition rejected
    // both, and the parse below confirms the schema accepts the surface too.
    const call: AuditFindingsInput = {
      sessionSlug: 'audit-openbuff-2026-07',
      shardId: 'typed-surface-1',
      findings: [
        {
          severity: 'LOW',
          domain: 'api-abi',
          path: 'src/index.ts',
          title: 'Compatibility note',
          risk: 'Contracts could drift.',
          fix: 'Keep the public contract aligned.',
          evidence: 'The exported shape is public.',
        },
      ],
      coverage: {
        subsystemIds: ['agent-runtime'],
        featureIds: ['tool-dispatch'],
        files: ['packages/agent-runtime/src/tools/tool-executor.ts'],
      },
    }
    const parsed = writeAuditFindingsParams.inputSchema.safeParse(call)
    expect(parsed.success).toBe(true)
  })

  it('rejects traversal and dot path segments', () => {
    for (const sessionSlug of ['../escape', '..', '.', 'nested/session']) {
      expect(
        writeAuditFindingsParams.inputSchema.safeParse({
          ...validInput,
          sessionSlug,
        }).success,
      ).toBe(false)
    }
  })

  it('requires noIssuesFound to agree with the findings array', () => {
    expect(
      writeAuditFindingsParams.inputSchema.safeParse({
        ...validInput,
        noIssuesFound: false,
      }).success,
    ).toBe(false)
  })

  it('rejects a snapshot-bound call whose subsystemIds or files list is empty', () => {
    // The snapshot-completeness superRefine is a fail-closed guard: when both
    // snapshotId and coverage.domains are present the call receives a
    // structuralReceipt, and evaluate_audit_coverage rejects a receipt whose
    // subsystem_ids or files list is empty, so each empty list must be
    // rejected here rather than yielding an unusable receipt.
    for (const field of ['subsystemIds', 'files'] as const) {
      const parsed = writeAuditFindingsParams.inputSchema.safeParse({
        ...validInput,
        coverage: {
          ...validInput.coverage,
          [field]: [],
        },
      })
      expect(parsed.success).toBe(false)
      if (!parsed.success) {
        expect(
          parsed.error.issues.some(
            (issue) =>
              issue.path[0] === 'coverage' && issue.path[1] === field,
          ),
        ).toBe(true)
      }
    }
  })

  it('rejects an explicitly empty coverage.domains list', () => {
    // coverage.domains carries .min(1): an explicitly empty list must be
    // rejected rather than treated as an omitted field, since [] would claim a
    // snapshot-bound call evaluated zero domains while still emitting a
    // structuralReceipt.
    const parsed = writeAuditFindingsParams.inputSchema.safeParse({
      ...validInput,
      coverage: {
        ...validInput.coverage,
        domains: [],
      },
    })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(
        parsed.error.issues.some(
          (issue) =>
            issue.path[0] === 'coverage' && issue.path[1] === 'domains',
        ),
      ).toBe(true)
    }
  })
})

describe('write_audit_findings provider input', () => {
  // The provider surface generates the wire JSON Schema and deliberately drops
  // every regex `pattern`: the Unicode property escapes the input schema needs
  // for its hygiene rules are rejected by strict provider-side validators
  // before generation. Handler enforcement stays on inputSchema, pinned below.
  const providerFinding = {
    severity: 'LOW',
    domain: 'api-abi',
    path: 'src/index.ts',
    title: 'Compatibility note',
    risk: 'Contracts could drift.',
    fix: 'Keep the public contract aligned.',
    evidence: 'The exported shape is public.',
  }

  const providerInput = {
    sessionSlug: 'audit-openbuff-2026-07',
    shardId: 'provider-1',
    snapshotId: 'snapshot-1',
    findings: [providerFinding],
    coverage: {
      subsystemIds: ['agent-runtime'],
      featureIds: ['tool-dispatch'],
      files: ['packages/agent-runtime/src/tools/tool-executor.ts'],
      domains: ['api-contract'],
    },
    noIssuesFound: false,
  }

  it('accepts a minimal valid payload on the pattern-free surface', () => {
    expect(
      writeAuditFindingsParams.providerInputSchema.safeParse(providerInput)
        .success,
    ).toBe(true)
  })

  it('accepts finding text with em dashes and curly quotes', () => {
    expect(
      writeAuditFindingsParams.providerInputSchema.safeParse({
        ...providerInput,
        findings: [
          {
            ...providerFinding,
            title: 'Contract drift — “harmless” renames break callers',
            risk: 'Callers see “compatible” shapes — and break.',
            fix: 'Treat every rename as breaking — align the contract.',
            evidence: 'The export is `T` — the docs claim “U”.',
          },
        ],
      }).success,
    ).toBe(true)
  })

  it('still rejects a control character in a finding title on inputSchema', () => {
    expect(
      writeAuditFindingsParams.inputSchema.safeParse({
        ...providerInput,
        findings: [{ ...providerFinding, title: 'Bad\u0000title' }],
      }).success,
    ).toBe(false)
  })

  it('still rejects duplicate coverage entries on inputSchema', () => {
    expect(
      writeAuditFindingsParams.inputSchema.safeParse({
        ...providerInput,
        coverage: {
          ...providerInput.coverage,
          files: ['src/tool-executor.ts', 'src/tool-executor.ts'],
        },
      }).success,
    ).toBe(false)
  })
})
