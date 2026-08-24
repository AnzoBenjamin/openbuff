import { describe, expect, test } from 'bun:test'

import { createMockFs } from '@codebuff/common/testing/mocks/filesystem'
import {
  auditIdentifierRule,
  coverageDomainAliasRule,
  coverageDomainsNonEmptyRule,
  coverageEntryHygieneCrossReference,
  coverageEntryHygieneRule,
  coverageUniquenessCrossReference,
  coverageUniquenessRule,
  findingEntryHygieneRule,
  noIssuesFoundRule,
  snapshotCoverageCompletenessRule,
  writeAuditFindingsParams,
} from '@codebuff/common/tools/params/tool/write-audit-findings'
import { getContentHash } from '@codebuff/common/util/content-hash'

import {
  auditFindingsArtifactPath,
  renderAuditFindingsMarkdown,
  writeAuditFindings,
} from '../tools/write-audit-findings'

const input = {
  sessionSlug: 'audit-openbuff-2026-07',
  shardId: 'runtime-1',
  snapshotId: 'snapshot-1',
  findings: [
    {
      severity: 'HIGH' as const,
      domain: 'correctness' as const,
      path: 'packages/agent-runtime/src/tools/tool-executor.ts',
      line: 688,
      title: 'Derived artifact path must remain scoped',
      risk: 'An arbitrary path would broaden shard mutation authority.',
      fix: 'Derive the path from validated session and shard identifiers.',
      evidence: 'The executor checks the same derived path as the SDK writer.',
    },
  ],
  coverage: {
    subsystemIds: ['agent-runtime'],
    featureIds: ['tool-dispatch'],
    files: ['packages/agent-runtime/src/tools/tool-executor.ts'],
    domains: [
      'security' as const,
      'correctness' as const,
      'state-mutation' as const,
      'error-handling' as const,
      'performance' as const,
      'dependency-hygiene' as const,
      'test-coverage' as const,
      'api-contract' as const,
    ],
  },
  noIssuesFound: false,
}

describe('writeAuditFindings', () => {
  test('derives and renders the findings artifact path', () => {
    expect(auditFindingsArtifactPath(input)).toBe(
      '.agents/sessions/audit-openbuff-2026-07/findings/runtime-1.md',
    )
    const markdown = renderAuditFindingsMarkdown(input)
    expect(markdown).toContain('# Audit findings: runtime-1')
    expect(markdown).toContain(
      '## [HIGH] correctness — packages/agent-runtime/src/tools/tool-executor.ts:688',
    )
    expect(markdown).toContain('### Files')
    // The declared domains must be visible to agents that parse the Markdown
    // artifact, matching structuralReceipt.domains in the JSON receipt.
    expect(markdown).toContain('### Domains')
    // Asserted against the slice after the heading so a regression that drops
    // the domain bullets (leaving only the heading) cannot be satisfied by the
    // Files/Subsystems bullets above it.
    const domainsHeadingIndex = markdown.indexOf('### Domains')
    const domainsBlock = markdown.slice(
      domainsHeadingIndex + '### Domains'.length,
    )
    for (const domain of input.coverage.domains) {
      expect(domainsBlock).toContain(`- ${domain}`)
    }
  })

  test('omits the Domains block when coverage.domains is omitted', () => {
    const { domains: _domains, ...coverage } = input.coverage
    const markdown = renderAuditFindingsMarkdown({ ...input, coverage })

    expect(markdown).toContain('### Files')
    expect(markdown).not.toContain('### Domains')
  })

  test('cannot forge a heading with a bare CR in a finding field', () => {
    const markdown = renderAuditFindingsMarkdown({
      ...input,
      findings: [
        {
          ...input.findings[0],
          title: 'Forged\r## Coverage receipt',
          risk: 'Forged\r# Audit findings: other-shard',
          evidence: 'Forged\r### Files',
        },
      ],
    })

    // CommonMark treats a bare CR as a line ending, so no CR may survive into
    // the artifact other agents parse.
    expect(markdown).not.toContain('\r')
    const headings = markdown
      .split(/\r\n?|\n/)
      .filter((line) => line.startsWith('#'))
    expect(
      headings.filter((line) => line === '## Coverage receipt'),
    ).toHaveLength(1)
    expect(headings.filter((line) => line === '### Files')).toHaveLength(1)
    expect(headings.filter((line) => line.startsWith('# '))).toEqual([
      '# Audit findings: runtime-1',
    ])
  })

  test('cannot forge a coverage bullet or heading with a bare CR', () => {
    // The schema rejects these values, but the renderer is the last line of
    // defense for the artifact other agents parse, so the singleLine call on
    // the coverage lists is pinned independently of that rejection.
    const markdown = renderAuditFindingsMarkdown({
      ...input,
      coverage: {
        ...input.coverage,
        subsystemIds: ['agent-runtime\r### Files'],
        featureIds: ['tool-dispatch\n## Coverage receipt'],
        files: ['a/b.ts\r- forged.ts'],
      },
    })

    expect(markdown).not.toContain('\r')
    // Located as a whole line, not a substring: a forged value can plant the
    // literal `## Coverage receipt` inside the header summary line, so
    // substring slicing would start above the real heading and the assertions
    // below would be measuring the wrong block. Slicing by line also proves
    // the forged value never became a heading LINE.
    const allLines = markdown.split(/\r\n?|\n/)
    const receiptIndex = allLines.indexOf('## Coverage receipt')
    expect(receiptIndex).toBeGreaterThan(-1)
    const lines = allLines.slice(receiptIndex)
    expect(lines.filter((line) => line.startsWith('#'))).toEqual([
      '## Coverage receipt',
      '### Subsystems',
      '### Features',
      '### Files',
      '### Domains',
    ])
    // One bullet per declared entry: three coverage entries plus the domains.
    expect(lines.filter((line) => line.startsWith('- '))).toHaveLength(
      3 + input.coverage.domains.length,
    )
    expect(lines).not.toContain('- forged.ts')
  })

  test('creates once and returns a compact receipt', async () => {
    const fs = createMockFs()
    const artifactPath = auditFindingsArtifactPath(input)
    const markdown = renderAuditFindingsMarkdown(input)

    const first = await writeAuditFindings({
      parameters: input,
      cwd: '/repo',
      fs,
    })
    const receipt = first[0]?.type === 'json' ? first[0].value : undefined
    expect(receipt).toEqual({
      artifactPath,
      artifacts: [artifactPath],
      findingCount: 1,
      severityCounts: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0 },
      coverage: { subsystemCount: 1, featureCount: 1, fileCount: 1 },
      structuralReceipt: {
        schema_version: 1,
        snapshot_id: 'snapshot-1',
        shard_id: 'runtime-1',
        subsystem_ids: ['agent-runtime'],
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
      contentHash: getContentHash(markdown),
    })
    expect(JSON.stringify(receipt)).not.toContain(input.findings[0].risk)
    expect(await fs.readFile(`/repo/${artifactPath}`, 'utf8')).toBe(markdown)

    const second = await writeAuditFindings({
      parameters: input,
      cwd: '/repo',
      fs,
    })
    const collision = second[0]?.type === 'json' ? second[0].value : undefined
    expect(collision).toMatchObject({ artifactPath })
    const collisionMessage =
      collision && typeof collision === 'object' && 'errorMessage' in collision
        ? collision.errorMessage
        : undefined
    expect(typeof collisionMessage).toBe('string')
    expect(collisionMessage).not.toBe('')
    expect(collisionMessage).toContain('the file already exists')
    expect(await fs.readFile(`/repo/${artifactPath}`, 'utf8')).toBe(markdown)
  })

  test('preserves the legacy receipt shape when snapshotId is omitted', async () => {
    const fs = createMockFs()
    const { snapshotId: _snapshotId, ...legacyInput } = input
    const legacyParams = { ...legacyInput, shardId: 'runtime-legacy' }
    const artifactPath = auditFindingsArtifactPath(legacyParams)
    const markdown = renderAuditFindingsMarkdown(legacyParams)
    const result = await writeAuditFindings({
      parameters: legacyParams,
      cwd: '/repo',
      fs,
    })
    const receipt = result[0]?.type === 'json' ? result[0].value : undefined

    // The success receipt must be asserted too: `not.toHaveProperty` alone
    // also holds for the `{ artifactPath, errorMessage }` failure shape.
    expect(receipt).toMatchObject({
      artifactPath,
      artifacts: [artifactPath],
      findingCount: 1,
      contentHash: getContentHash(markdown),
    })
    expect(receipt).not.toHaveProperty('structuralReceipt')
    expect(await fs.readFile(`/repo/${artifactPath}`, 'utf8')).toBe(markdown)
  })

  test('does not attest to domain coverage when domains are omitted', async () => {
    const fs = createMockFs()
    const { domains: _domains, ...coverage } = input.coverage
    const params = {
      ...input,
      shardId: 'runtime-without-domains',
      coverage,
    }
    const artifactPath = auditFindingsArtifactPath(params)
    const markdown = renderAuditFindingsMarkdown(params)
    const result = await writeAuditFindings({
      parameters: params,
      cwd: '/repo',
      fs,
    })
    const receipt = result[0]?.type === 'json' ? result[0].value : undefined

    expect(receipt).toMatchObject({
      artifactPath,
      artifacts: [artifactPath],
      findingCount: 1,
      contentHash: getContentHash(markdown),
    })
    expect(receipt).not.toHaveProperty('structuralReceipt')
    expect(await fs.readFile(`/repo/${artifactPath}`, 'utf8')).toBe(markdown)
  })

  test('rewrites the legacy api-abi domain alias to api-contract', async () => {
    const fs = createMockFs()
    const shardId = 'runtime-legacy-domain'
    const artifactPath = auditFindingsArtifactPath({
      sessionSlug: input.sessionSlug,
      shardId,
    })
    const result = await writeAuditFindings({
      parameters: {
        ...input,
        shardId,
        findings: [{ ...input.findings[0], domain: 'api-abi' }],
      },
      cwd: '/repo',
      fs,
    })
    const receipt = result[0]?.type === 'json' ? result[0].value : undefined

    expect(receipt).toMatchObject({ artifactPath, findingCount: 1 })
    const markdown = await fs.readFile(`/repo/${artifactPath}`, 'utf8')
    expect(markdown).toContain(
      `## [HIGH] api-contract — ${input.findings[0].path}:688`,
    )
    expect(markdown).not.toContain('api-abi')
  })

  test('rejects noIssuesFound=true when findings are reported', async () => {
    const fs = createMockFs()
    const shardId = 'runtime-claims-no-issues'
    const artifactPath = auditFindingsArtifactPath({
      sessionSlug: input.sessionSlug,
      shardId,
    })
    const result = await writeAuditFindings({
      parameters: { ...input, shardId, noIssuesFound: true },
      cwd: '/repo',
      fs,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        artifactPath,
        errorMessage: 'Missing or invalid write_audit_findings parameters.',
      },
    })
    await expect(fs.readFile(`/repo/${artifactPath}`, 'utf8')).rejects.toThrow()
  })

  test('rejects noIssuesFound=false when findings are empty', async () => {
    const fs = createMockFs()
    const shardId = 'runtime-empty-findings'
    const artifactPath = auditFindingsArtifactPath({
      sessionSlug: input.sessionSlug,
      shardId,
    })
    const result = await writeAuditFindings({
      parameters: { ...input, shardId, findings: [], noIssuesFound: false },
      cwd: '/repo',
      fs,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        artifactPath,
        errorMessage: 'Missing or invalid write_audit_findings parameters.',
      },
    })
    await expect(fs.readFile(`/repo/${artifactPath}`, 'utf8')).rejects.toThrow()
  })

  test('rejects a zero-findings call that omits noIssuesFound', async () => {
    const fs = createMockFs()
    const shardId = 'runtime-omitted-flag'
    const artifactPath = auditFindingsArtifactPath({
      sessionSlug: input.sessionSlug,
      shardId,
    })
    const { noIssuesFound: _noIssuesFound, ...legacyParams } = input

    // The flag defaults to false, so a clean shard must attest explicitly
    // instead of having the claim inferred from an empty findings array.
    const result = await writeAuditFindings({
      parameters: { ...legacyParams, shardId, findings: [] },
      cwd: '/repo',
      fs,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        artifactPath,
        errorMessage: 'Missing or invalid write_audit_findings parameters.',
      },
    })
    await expect(fs.readFile(`/repo/${artifactPath}`, 'utf8')).rejects.toThrow()
  })

  test('accepts a non-empty findings call that omits noIssuesFound', async () => {
    const fs = createMockFs()
    const shardId = 'runtime-omitted-flag-with-findings'
    const { noIssuesFound: _noIssuesFound, ...legacyParams } = input
    const params = { ...legacyParams, shardId }
    const artifactPath = auditFindingsArtifactPath(params)

    // Pins the accepted direction of the default: it must stay `false`, so a
    // shard that reports findings without sending the flag still writes its
    // artifact. A default flipped to `true` would reject this call.
    const result = await writeAuditFindings({
      parameters: params,
      cwd: '/repo',
      fs,
    })
    const receipt = result[0]?.type === 'json' ? result[0].value : undefined

    expect(receipt).toMatchObject({
      artifactPath,
      artifacts: [artifactPath],
      findingCount: 1,
    })
    const markdown = await fs.readFile(`/repo/${artifactPath}`, 'utf8')
    expect(markdown).not.toContain('No issues found')
  })

  test('rejects the legacy api-abi alias in coverage.domains', async () => {
    const fs = createMockFs()
    const shardId = 'runtime-legacy-coverage-domain'
    const artifactPath = auditFindingsArtifactPath({
      sessionSlug: input.sessionSlug,
      shardId,
    })

    // The alias is only accepted on findings[].domain; the tool description
    // states this restriction because the rejection message is generic.
    const result = await writeAuditFindings({
      parameters: {
        ...input,
        shardId,
        coverage: { ...input.coverage, domains: ['api-abi'] },
      },
      cwd: '/repo',
      fs,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        artifactPath,
        errorMessage: 'Missing or invalid write_audit_findings parameters.',
      },
    })
    await expect(fs.readFile(`/repo/${artifactPath}`, 'utf8')).rejects.toThrow()
  })

  test('rejects a repeated coverage entry at the writer boundary', async () => {
    const fs = createMockFs()
    const shardId = 'runtime-duplicate-coverage-entry'
    const artifactPath = auditFindingsArtifactPath({
      sessionSlug: input.sessionSlug,
      shardId,
    })

    // A repeated entry inflates `- Files covered: N`, the receipt's coverage
    // counts, and structuralReceipt.files. One list is enough at this level:
    // the schema-issue case below pins the refinement on all four lists; this
    // case pins that the writer refuses the call and writes no artifact.
    const result = await writeAuditFindings({
      parameters: {
        ...input,
        shardId,
        coverage: {
          ...input.coverage,
          files: [...input.coverage.files, ...input.coverage.files],
        },
      },
      cwd: '/repo',
      fs,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        artifactPath,
        errorMessage: 'Missing or invalid write_audit_findings parameters.',
      },
    })
    await expect(fs.readFile(`/repo/${artifactPath}`, 'utf8')).rejects.toThrow()
  })

  test('rejects a control character in a coverage list at the writer boundary', async () => {
    const fs = createMockFs()
    const shardId = 'runtime-control-char-files'
    const artifactPath = auditFindingsArtifactPath({
      sessionSlug: input.sessionSlug,
      shardId,
    })

    // Rendering collapses line endings, but the raw value is echoed verbatim
    // into structuralReceipt.files, so it is rejected at parse time instead of
    // relying on the Markdown normalization. One list is enough at this level:
    // the schema-level case below pins the per-field character matrix; this
    // case pins that the writer refuses the call and writes no artifact.
    const result = await writeAuditFindings({
      parameters: {
        ...input,
        shardId,
        coverage: {
          ...input.coverage,
          files: [
            'packages/agent-runtime/src/tools/tool-executor.ts\r- forged.ts',
          ],
        },
      },
      cwd: '/repo',
      fs,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        artifactPath,
        errorMessage: 'Missing or invalid write_audit_findings parameters.',
      },
    })
    await expect(fs.readFile(`/repo/${artifactPath}`, 'utf8')).rejects.toThrow()
  })

  test('rejects control and format characters in every string coverage list', () => {
    // The renderer's singleLine only collapses CR/LF, and the parsed value is
    // echoed verbatim into structuralReceipt.files/subsystem_ids, so the
    // hygiene regex must reject the whole control/format class on all three
    // lists — including the tab and line endings the renderer would otherwise
    // normalize away.
    for (const field of ['subsystemIds', 'featureIds', 'files'] as const) {
      for (const char of [
        '\t',
        '\n',
        '\r',
        '\u0000',
        '\u000b',
        '\u000c',
        '\u001b',
        '\u0085',
        '\u200b',
        '\u2028',
        '\u2029',
      ]) {
        const parsed = writeAuditFindingsParams.inputSchema.safeParse({
          ...input,
          coverage: {
            ...input.coverage,
            [field]: [`a/b.ts${char}- forged.ts`],
          },
        })

        // The loop variables are asserted alongside the result so a regression
        // names the offending list and character instead of `false !== true`.
        expect({ field, char, success: parsed.success }).toEqual({
          field,
          char,
          success: false,
        })
      }
    }
  })

  test('rejects a coverage entry longer than its length bound', () => {
    // The bound is checked on the raw value, so it is pinned here: an
    // accidentally widened maxLength would let an unbounded path into the
    // artifact and structuralReceipt.
    const bounds = { subsystemIds: 200, featureIds: 200, files: 500 } as const
    for (const [field, maxLength] of Object.entries(bounds)) {
      expect(
        writeAuditFindingsParams.inputSchema.safeParse({
          ...input,
          coverage: { ...input.coverage, [field]: ['a'.repeat(maxLength + 1)] },
        }).success,
      ).toBe(false)
      expect(
        writeAuditFindingsParams.inputSchema.safeParse({
          ...input,
          coverage: { ...input.coverage, [field]: ['a'.repeat(maxLength)] },
        }).success,
      ).toBe(true)
    }
  })

  test('rejects coverage entries that differ only in surrounding whitespace', () => {
    // ['a/b.ts', 'a/b.ts '] renders two identical bullets and inflates the
    // counts the uniqueness rule exists to protect, so uniqueness is judged
    // after coverageEntrySchema's trim — the same trimmed value the writer
    // renders and echoes into the receipt.
    const duplicated: Record<string, string[]> = {
      subsystemIds: ['agent-runtime', 'agent-runtime '],
      featureIds: ['tool-dispatch', ' tool-dispatch'],
      files: [
        'packages/agent-runtime/src/tools/tool-executor.ts',
        'packages/agent-runtime/src/tools/tool-executor.ts ',
      ],
    }
    for (const [field, values] of Object.entries(duplicated)) {
      const parsed = writeAuditFindingsParams.inputSchema.safeParse({
        ...input,
        coverage: { ...input.coverage, [field]: values },
      })

      // Only rejection is asserted: the issue path and message are pinned once,
      // by 'names the offending list when a coverage entry is repeated'.
      expect(parsed.success).toBe(false)
    }
  })

  test('trims a coverage entry before rendering and echoing it', async () => {
    const fs = createMockFs()
    const shardId = 'runtime-padded-entry'
    const artifactPath = auditFindingsArtifactPath({
      sessionSlug: input.sessionSlug,
      shardId,
    })
    // A single padded entry is not a duplicate, so it parses: the trim in
    // coverageEntrySchema is what keeps the Markdown bullet and
    // structuralReceipt.files/subsystem_ids equal to the trimmed path
    // evaluate_audit_coverage compares against.
    const result = await writeAuditFindings({
      parameters: {
        ...input,
        shardId,
        coverage: {
          ...input.coverage,
          subsystemIds: [' agent-runtime'],
          files: ['packages/agent-runtime/src/tools/tool-executor.ts '],
        },
      },
      cwd: '/repo',
      fs,
    })
    const receipt = result[0]?.type === 'json' ? result[0].value : undefined

    expect(receipt).toMatchObject({
      artifactPath,
      structuralReceipt: {
        subsystem_ids: ['agent-runtime'],
        files: ['packages/agent-runtime/src/tools/tool-executor.ts'],
      },
    })
    const markdown = await fs.readFile(`/repo/${artifactPath}`, 'utf8')
    const lines = markdown.split('\n')
    expect(lines).toContain(
      '- packages/agent-runtime/src/tools/tool-executor.ts',
    )
    expect(lines).toContain('- agent-runtime')
    expect(lines).not.toContain('-  agent-runtime')
    expect(markdown).not.toContain('tool-executor.ts \n')
  })

  test('rejects a whitespace-only coverage entry', () => {
    // The trim runs inside coverageEntrySchema, so non-emptiness is checked on
    // the trimmed value: a padded-blank entry cannot become an empty coverage
    // bullet or an empty structuralReceipt path.
    for (const field of ['subsystemIds', 'featureIds', 'files'] as const) {
      const parsed = writeAuditFindingsParams.inputSchema.safeParse({
        ...input,
        coverage: { ...input.coverage, [field]: ['   '] },
      })

      // Carries the field into the assertion so a regression names the list.
      expect({ field, success: parsed.success }).toEqual({
        field,
        success: false,
      })
    }
  })

  test('rejects an explicitly empty coverage.domains list', () => {
    // `.min(1)` on an optional list is the one boundary a caller cannot infer
    // from the field being optional: `[]` is rejected rather than treated as
    // omitted, and the rejection message names no rule, so the boundary is
    // pinned here and advertised by coverageDomainsNonEmptyRule.
    expect(
      writeAuditFindingsParams.inputSchema.safeParse({
        ...input,
        coverage: { ...input.coverage, domains: [] },
      }).success,
    ).toBe(false)

    // Omitting the field entirely stays accepted: that is the legacy shape
    // that receives no structuralReceipt.
    const { domains: _domains, ...coverage } = input.coverage
    expect(
      writeAuditFindingsParams.inputSchema.safeParse({ ...input, coverage })
        .success,
    ).toBe(true)
  })

  test('names the offending list when a coverage entry is repeated', () => {
    // Uniqueness tightens input that previously parsed, and the SDK writer
    // collapses every failure to one generic message, so the schema issue
    // itself must name the rule for callers that do surface zod issues. Each
    // list interpolates its own field name, so all four are pinned here.
    const duplicated: Record<string, string[]> = {
      subsystemIds: ['agent-runtime'],
      featureIds: ['tool-dispatch'],
      files: ['packages/agent-runtime/src/tools/tool-executor.ts'],
      domains: ['security'],
    }
    for (const [field, values] of Object.entries(duplicated)) {
      const parsed = writeAuditFindingsParams.inputSchema.safeParse({
        ...input,
        coverage: { ...input.coverage, [field]: [...values, ...values] },
      })

      expect(parsed.success).toBe(false)
      expect(
        parsed.error?.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      ).toEqual([
        {
          path: ['coverage', field],
          message: `List each coverage.${field} entry at most once`,
        },
      ])
    }
  })

  test('keeps accepting duplicate-free shard payloads after the uniqueness tightening', () => {
    // Compatibility guard for the hasNoDuplicates refinements: they narrow
    // input that previously parsed, and the SDK writer collapses the failure to
    // one generic message. The audit callers shipped with the repo ask a shard
    // to report the coverage it actually covered instead of emitting a fixed
    // payload, so the shapes that must keep parsing are the snapshot-bound one
    // and the legacy one without snapshotId/domains — both duplicate-free.
    expect(writeAuditFindingsParams.inputSchema.safeParse(input).success).toBe(
      true,
    )

    const { snapshotId: _snapshotId, ...legacyInput } = input
    const { domains: _domains, ...legacyCoverage } = input.coverage
    expect(
      writeAuditFindingsParams.inputSchema.safeParse({
        ...legacyInput,
        coverage: legacyCoverage,
      }).success,
    ).toBe(true)
  })

  test('rejects a snapshotId that is over-long or control-bearing', async () => {
    // snapshotId is echoed verbatim into structuralReceipt.snapshot_id, the
    // same sink the coverage lists are hardened for, so it is bounded to the
    // canonical identifier charset rather than any non-empty string.
    const oversized = 'a'.repeat(101)
    for (const snapshotId of [
      oversized,
      'snapshot-1\u0000',
      'snapshot-1\u2028forged',
      'snapshot 1',
      'snapshot/1',
    ]) {
      expect(
        writeAuditFindingsParams.inputSchema.safeParse({ ...input, snapshotId })
          .success,
      ).toBe(false)
    }

    const fs = createMockFs()
    const shardId = 'runtime-oversized-snapshot'
    const artifactPath = auditFindingsArtifactPath({
      sessionSlug: input.sessionSlug,
      shardId,
    })
    const result = await writeAuditFindings({
      parameters: { ...input, shardId, snapshotId: oversized },
      cwd: '/repo',
      fs,
    })
    const value = result[0]?.type === 'json' ? result[0].value : undefined

    expect(value).toMatchObject({
      artifactPath,
      errorMessage: 'Missing or invalid write_audit_findings parameters.',
    })
    // The rejected value must not be amplified back through the error payload.
    expect(JSON.stringify(value)).not.toContain(oversized)
    await expect(fs.readFile(`/repo/${artifactPath}`, 'utf8')).rejects.toThrow()
  })

  test('rejects control and format characters in the finding text fields', () => {
    // The renderer's singleLine only collapses CR/LF, so a NUL or U+2028 in a
    // finding string would otherwise reach the Markdown artifact other agents
    // parse; the schema rejects the rest of the control/format class instead.
    for (const field of ['title', 'risk', 'fix', 'evidence'] as const) {
      for (const char of ['\u0000', '\u001b', '\u200b', '\u2028', '\u2029']) {
        expect(
          writeAuditFindingsParams.inputSchema.safeParse({
            ...input,
            findings: [{ ...input.findings[0], [field]: `forged${char}value` }],
          }).success,
        ).toBe(false)
      }

      // Tabs and line breaks stay accepted: finding prose legitimately wraps
      // and the writer collapses the line endings before rendering.
      expect(
        writeAuditFindingsParams.inputSchema.safeParse({
          ...input,
          findings: [{ ...input.findings[0], [field]: 'wrapped\n\tvalue' }],
        }).success,
      ).toBe(true)
    }
  })

  test('holds findings[].path to the single-line coverage entry rule', () => {
    // A finding location is never wrapped prose, and it is rendered into the
    // `## [SEVERITY] domain — path:line` heading, so it is held to the same
    // hygiene rule as coverage.files rather than the prose rule: tabs and line
    // breaks are rejected here even though they are accepted in title/risk/
    // fix/evidence.
    for (const value of [
      'wrapped\n\tvalue',
      'a/b.ts\t- forged.ts',
      'a/b.ts\r### Files',
      'a/b.ts\n## Coverage receipt',
      'a/b.ts\u0000',
      'a/b.ts\u2028forged',
      '   ',
      'a'.repeat(501),
    ]) {
      expect(
        writeAuditFindingsParams.inputSchema.safeParse({
          ...input,
          findings: [{ ...input.findings[0], path: value }],
        }).success,
      ).toBe(false)
    }

    // Padded values are trimmed, so the parsed path is the exact value the
    // renderer puts in the finding heading.
    const parsed = writeAuditFindingsParams.inputSchema.safeParse({
      ...input,
      findings: [{ ...input.findings[0], path: ' packages/a/b.ts ' }],
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.findings[0].path).toBe('packages/a/b.ts')
  })

  test('accepts a realistic sha256 snapshotId at the identifier bound', () => {
    // inspect_codebase_structure returns a 64-character sha256 hex digest
    // (hashInventory), so the bound must keep accepting that length — and the
    // documented composable flow breaks silently if it is ever tightened below
    // the schema's own 100-character maximum.
    for (const snapshotId of ['a'.repeat(64), 'a'.repeat(100)]) {
      const parsed = writeAuditFindingsParams.inputSchema.safeParse({
        ...input,
        snapshotId,
      })

      expect(parsed.success).toBe(true)
      expect(parsed.data?.snapshotId).toBe(snapshotId)
    }
  })

  test('rejects an empty subsystemIds or files list on a snapshot-bound call', () => {
    // Such a call emits structuralReceipt, whose subsystem_ids/files are held
    // to `.min(1)` by evaluate_audit_coverage, so an empty list here would
    // produce a receipt that tool rejects — contradicting the description's
    // directly composable claim.
    for (const field of ['subsystemIds', 'files'] as const) {
      const parsed = writeAuditFindingsParams.inputSchema.safeParse({
        ...input,
        coverage: { ...input.coverage, [field]: [] },
      })

      expect(parsed.success).toBe(false)
      expect(
        parsed.error?.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      ).toEqual([
        {
          path: ['coverage', field],
          message: `List at least one coverage.${field} entry when snapshotId and coverage.domains are set: evaluate_audit_coverage rejects the resulting structuralReceipt with an empty list`,
        },
      ])
    }

    // featureIds has no counterpart in structuralReceipt, so it still composes
    // when empty and must not be tightened along with the other two.
    expect(
      writeAuditFindingsParams.inputSchema.safeParse({
        ...input,
        coverage: { ...input.coverage, featureIds: [] },
      }).success,
    ).toBe(true)
  })

  test('keeps accepting empty coverage lists on calls that get no structuralReceipt', () => {
    // The completeness rule exists only to protect the receipt, so the two
    // shapes that receive none must keep parsing: no snapshotId, and no
    // coverage.domains.
    const { snapshotId: _snapshotId, ...legacyInput } = input
    const { domains: _domains, ...coverageWithoutDomains } = input.coverage
    const emptyLists = { subsystemIds: [], files: [] }

    expect(
      writeAuditFindingsParams.inputSchema.safeParse({
        ...legacyInput,
        coverage: { ...input.coverage, ...emptyLists },
      }).success,
    ).toBe(true)
    expect(
      writeAuditFindingsParams.inputSchema.safeParse({
        ...input,
        coverage: { ...coverageWithoutDomains, ...emptyLists },
      }).success,
    ).toBe(true)
  })

  test('states the noIssuesFound and coverage rules on the fields they govern', () => {
    // Every parse failure collapses to one generic message, so the schema docs
    // are the only place a rejected call can learn these rules. They live on
    // the field each one governs rather than in the tool description paragraph.
    // Asserted through the exported rule constants, so rewording a rule cannot
    // break this suite while it still fails if a rule stops being advertised at
    // all.
    const shape = writeAuditFindingsParams.inputSchema.shape
    expect(shape.noIssuesFound.description).toContain(noIssuesFoundRule)
    expect(shape.snapshotId.description).toContain(
      snapshotCoverageCompletenessRule,
    )
    // Every identifier field is bound by auditIdentifierSchema, so all three
    // state its charset/length/dot-segment rules through the one constant.
    for (const field of ['sessionSlug', 'shardId', 'snapshotId'] as const) {
      expect({
        field,
        statesIdentifierRule:
          shape[field].description?.includes(auditIdentifierRule) ?? false,
      }).toEqual({ field, statesIdentifierRule: true })
    }
    // The finding-entry hygiene levels are enforced but otherwise
    // undiscoverable, so they are advertised on `findings` itself.
    expect(shape.findings.description).toContain(findingEntryHygieneRule)
    expect(shape.coverage.shape.domains.description).toContain(
      coverageDomainsNonEmptyRule,
    )
    expect(shape.coverage.description).toContain(coverageUniquenessRule)
    expect(shape.coverage.shape.domains.description).toContain(
      coverageDomainAliasRule,
    )
    // Uniqueness is enforced on every coverage list, so the domains
    // description points at the rule for callers that read only that field —
    // by cross-reference, not by repeating its full text into the schema.
    expect(shape.coverage.shape.domains.description).toContain(
      coverageUniquenessCrossReference,
    )
    expect(shape.coverage.shape.domains.description).not.toContain(
      coverageUniquenessRule,
    )
    // The single-line hygiene rule governs all three string coverage lists, so
    // it is stated once on `coverage` and cross-referenced from each list
    // instead of tripling ~60 words into the tool schema sent to the model.
    expect(shape.coverage.description).toContain(coverageEntryHygieneRule)
    for (const field of ['subsystemIds', 'featureIds', 'files'] as const) {
      expect(shape.coverage.shape[field].description).toContain(
        coverageEntryHygieneCrossReference,
      )
      expect(shape.coverage.shape[field].description).not.toContain(
        coverageEntryHygieneRule,
      )
      // Uniqueness rejects these lists too, so each one also points at that
      // rule — a caller reading only `coverage.files` must not miss it.
      expect(shape.coverage.shape[field].description).toContain(
        coverageUniquenessCrossReference,
      )
      expect(shape.coverage.shape[field].description).not.toContain(
        coverageUniquenessRule,
      )
    }

    // The constant-based assertions above also hold for a gutted rule string,
    // so each rule additionally pins one stable keyword of the behaviour it
    // advertises: the accepted flag combination, the uniqueness requirement
    // plus its whitespace-normalized comparison, the canonical domain id
    // callers must use in coverage.domains, and the single-line requirement on
    // the string coverage lists.
    expect(shape.noIssuesFound.description).toContain('noIssuesFound=true')
    expect(shape.snapshotId.description).toContain('at least one entry')
    expect(shape.coverage.description).toContain('at most once')
    expect(shape.coverage.description).toContain(
      'trimming surrounding whitespace',
    )
    expect(shape.coverage.shape.domains.description).toContain('api-contract')
    expect(shape.coverage.shape.domains.description).toContain(
      'at least one domain',
    )
    expect(shape.coverage.description).toContain('single-line')
    expect(shape.coverage.shape.files.description).toContain('single-line')
    expect(shape.shardId.description).toContain(
      'letters, digits, dot, underscore, or dash',
    )
    expect(shape.findings.description).toContain('single-line')
    expect(shape.findings.description).toContain('tabs and line breaks')

    // The rules must not be duplicated back into the tool description
    // paragraph...
    expect(writeAuditFindingsParams.description).not.toContain(
      noIssuesFoundRule,
    )
    expect(writeAuditFindingsParams.description).not.toContain(
      coverageDomainAliasRule,
    )
    expect(writeAuditFindingsParams.description).not.toContain(
      coverageUniquenessRule,
    )
    // ...but it must still point a rejected caller at the field descriptions.
    expect(writeAuditFindingsParams.description).toContain(
      'field descriptions of noIssuesFound and coverage',
    )
  })

  test('attests to the declared domain count when no issues are found', () => {
    const markdown = renderAuditFindingsMarkdown({
      ...input,
      findings: [],
      noIssuesFound: true,
    })

    // The count is derived from what the caller actually attested to.
    expect(markdown).toContain('No issues found across all 8 declared domains.')
    expect(markdown).not.toContain(
      'No issues found across the declared domains.',
    )
    expect(markdown).toContain('- Files covered: 1')
    expect(markdown).not.toContain('## [')
  })

  test('claims no domain count when coverage.domains is omitted and no issues are found', () => {
    const { domains: _domains, ...coverage } = input.coverage
    const markdown = renderAuditFindingsMarkdown({
      ...input,
      coverage,
      findings: [],
      noIssuesFound: true,
    })

    expect(markdown).toContain('No issues found across the declared domains.')
    expect(markdown).not.toContain('No issues found across all')
  })

  test('returns the declared error shape instead of throwing on invalid input', async () => {
    const fs = createMockFs()
    // Missing findings/coverage: the schema rejects it, but sessionSlug and
    // shardId are usable so the artifactPath is still reported.
    const result = await writeAuditFindings({
      parameters: {
        sessionSlug: 'audit-openbuff-2026-07',
        shardId: 'runtime-1',
      },
      cwd: '/repo',
      fs,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        artifactPath:
          '.agents/sessions/audit-openbuff-2026-07/findings/runtime-1.md',
        errorMessage: 'Missing or invalid write_audit_findings parameters.',
      },
    })
  })

  test('does not echo unusable identifiers into the reported artifact path', async () => {
    const fs = createMockFs()
    const result = await writeAuditFindings({
      parameters: { sessionSlug: '../escape', shardId: 42 },
      cwd: '/repo',
      fs,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        artifactPath: '.agents/sessions/(unparsed)/findings/(unparsed).md',
        errorMessage: 'Missing or invalid write_audit_findings parameters.',
      },
    })
  })

  test('does not echo bare dot-segment identifiers into the reported artifact path', async () => {
    const fs = createMockFs()
    // No slash, so only the dot-segment refinement rejects these.
    const result = await writeAuditFindings({
      parameters: { sessionSlug: '..', shardId: '.' },
      cwd: '/repo',
      fs,
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        artifactPath: '.agents/sessions/(unparsed)/findings/(unparsed).md',
        errorMessage: 'Missing or invalid write_audit_findings parameters.',
      },
    })
  })

  test('does not echo an over-long identifier into the reported artifact path', async () => {
    const fs = createMockFs()
    const oversizedSlug = 'a'.repeat(101)
    const result = await writeAuditFindings({
      parameters: { sessionSlug: oversizedSlug, shardId: 'runtime-1' },
      cwd: '/repo',
      fs,
    })
    const value = result[0]?.type === 'json' ? result[0].value : undefined

    expect(value).toMatchObject({
      artifactPath: '.agents/sessions/(unparsed)/findings/runtime-1.md',
      errorMessage: 'Missing or invalid write_audit_findings parameters.',
    })
    expect(JSON.stringify(value)).not.toContain(oversizedSlug)
  })
})
