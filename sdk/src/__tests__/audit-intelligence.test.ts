import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  auditDomains,
  evaluateAuditCoverage,
  inspectCodebaseStructure,
  inspectFeatureCompleteness,
  isIgnoredPath,
  promoteFeatureEvidence,
} from '../services/audit-intelligence'
import {
  inspectCodebaseStructureTool,
  inspectFeatureCompletenessTool,
  evaluateAuditCoverageTool,
} from '../tools/audit-intelligence'
import {
  auditCoverageDomains,
  evaluateAuditCoverageParams,
} from '../../../common/src/tools/params/tool/audit-intelligence'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-audit-'))
  roots.push(root)
  fs.mkdirSync(path.join(root, 'cli', 'commands'), { recursive: true })
  fs.mkdirSync(path.join(root, 'sdk', 'src', '__tests__'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ scripts: { test: 'bun test' } }),
  )
  fs.writeFileSync(
    path.join(root, 'cli', 'commands', 'resume-plan.ts'),
    'export function resumePlan() { try { return "ready" } catch (error) { return error } }',
  )
  fs.writeFileSync(
    path.join(root, 'sdk', 'src', 'resume-plan.ts'),
    'export const resumePlan = () => "ready"',
  )
  fs.writeFileSync(
    path.join(root, 'sdk', 'src', '__tests__', 'resume-plan.test.ts'),
    'test("resume plan", () => {})',
  )
  fs.writeFileSync(
    path.join(root, 'README.md'),
    '# Resume plan\nUse the resume plan command.',
  )
  return root
}

describe('native audit intelligence', () => {
  test('creates a snapshot-bound structural and capability inventory', () => {
    const inventory = inspectCodebaseStructure(fixture())
    expect(inventory.snapshotId).toHaveLength(64)
    expect(inventory.subsystems.map((item) => item.id)).toContain('cli')
    expect(inventory.commands).toContain('cli/commands/resume-plan.ts')
    expect(inventory.capabilityPacket.languages).toContain('typescript')
  })

  test('keeps SDK and tool-schema audit domains aligned', () => {
    expect(auditDomains).toEqual(auditCoverageDomains)
  })

  test('returns a snapshot-bound feature coverage receipt', () => {
    const root = fixture()
    const inventory = inspectCodebaseStructure(root)
    const result = inspectFeatureCompletenessTool(root, {
      feature: 'resume plan',
      snapshot_id: inventory.snapshotId,
    })
    const value = result[0]?.type === 'json' ? result[0].value : undefined
    expect(value).toMatchObject({
      coverageReceipt: {
        schema_version: 1,
        snapshot_id: inventory.snapshotId,
        feature: 'resume plan',
        evidence_kind: 'heuristic',
      },
    })
  })

  test('evaluates vertical feature evidence and blocks uncovered structure', () => {
    const root = fixture()
    const inventory = inspectCodebaseStructure(root)
    const feature = inspectFeatureCompleteness(root, 'resume plan', inventory)
    expect(feature.evidence.implementation.length).toBeGreaterThan(0)
    const blocked = evaluateAuditCoverage({
      inventory,
      structuralReceipts: [
        {
          schemaVersion: 1,
          snapshotId: inventory.snapshotId,
          shardId: 'cli-shard',
          subsystemIds: ['cli'],
          files: ['cli/commands/resume-plan.ts'],
          domains: [...auditDomains],
        },
      ],
      featureRecords: [feature],
    })
    expect(blocked.complete).toBe(false)
    expect(blocked.uncoveredSubsystems).toContain('sdk')
    expect(blocked.incompleteFeatures).toHaveLength(1)
  })

  test('rejects string attestations and an empty feature inventory', () => {
    expect(
      evaluateAuditCoverageParams.inputSchema.safeParse({
        snapshot_id: 'x',
        structural_receipts: ['cli'],
        features: [],
      }).success,
    ).toBe(false)
    const inventory = inspectCodebaseStructure(fixture())
    const receipts = inventory.subsystems.map((subsystem) => ({
      schemaVersion: 1 as const,
      snapshotId: inventory.snapshotId,
      shardId: `${subsystem.id}-shard`,
      subsystemIds: [subsystem.id],
      files: inventory.files.filter(
        (file) =>
          (file.includes('/') ? file.split('/')[0] : '.') === subsystem.id,
      ),
      domains: [...auditDomains],
    }))
    expect(
      evaluateAuditCoverage({
        inventory,
        structuralReceipts: receipts,
        featureRecords: [],
      }).complete,
    ).toBe(false)
  })

  test('normalizes composable audit receipts and keeps heuristic evidence incomplete', () => {
    const parsed = evaluateAuditCoverageParams.inputSchema.safeParse({
      snapshotId: 'snapshot-1',
      structuralReceipts: [
        {
          schemaVersion: 1,
          snapshotId: 'snapshot-1',
          shardId: 'server-shard',
          subsystemIds: ['server'],
          files: ['server/src/index.ts'],
          domains: ['correctness', 'api-abi'],
        },
      ],
      featureReceipts: [
        {
          schemaVersion: 1,
          snapshotId: 'snapshot-1',
          feature: 'review flow',
          evidenceKind: 'heuristic',
          evidence: {
            entrypoints: ['server/src/index.ts'],
            implementation: ['server/src/reviewer.ts'],
            consumers: ['server/src/index.ts'],
            tests: ['server/src/reviewer.test.ts'],
            docs: ['README.md'],
            failureStates: ['server/src/reviewer.ts'],
          },
        },
      ],
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.structural_receipts[0]).toMatchObject({
      schema_version: 1,
      snapshot_id: 'snapshot-1',
      shard_id: 'server-shard',
      subsystem_ids: ['server'],
      domains: ['correctness', 'api-contract'],
    })
    expect(parsed.data.features[0]).toMatchObject({
      schema_version: 1,
      snapshot_id: 'snapshot-1',
      evidence_kind: 'heuristic',
      evidence: { failure_states: ['server/src/reviewer.ts'] },
    })
  })

  test('rejects receipts that do not carry their own snapshot identity', () => {
    const parsed = evaluateAuditCoverageParams.inputSchema.safeParse({
      snapshot_id: 'snapshot-1',
      structural_receipts: [
        {
          schema_version: 1,
          shard_id: 'server-shard',
          subsystem_ids: ['server'],
          files: ['server/src/index.ts'],
          domains: ['correctness'],
        },
      ],
      features: [
        {
          schema_version: 1,
          feature: 'review flow',
          evidence_kind: 'heuristic',
          evidence: {
            entrypoints: [],
            implementation: [],
            consumers: [],
            tests: [],
            docs: [],
            failure_states: [],
          },
        },
      ],
    })

    expect(parsed.success).toBe(false)
  })

  test('requires snapshot-bound files, all domains, and verified feature evidence', () => {
    const inventory = inspectCodebaseStructure(fixture())
    const feature = inspectFeatureCompleteness(
      inventory.root,
      'resume plan',
      inventory,
    )
    const receipts = inventory.subsystems.map((subsystem) => ({
      schemaVersion: 1 as const,
      snapshotId: inventory.snapshotId,
      shardId: `${subsystem.id}-shard`,
      subsystemIds: [subsystem.id],
      files: inventory.files.filter(
        (file) =>
          (file.includes('/') ? file.split('/')[0] : '.') === subsystem.id,
      ),
      domains: [...auditDomains],
    }))
    expect(
      evaluateAuditCoverage({
        inventory,
        structuralReceipts: receipts,
        featureRecords: [feature],
      }).complete,
    ).toBe(false)
    const verified = {
      ...feature,
      evidenceKind: 'verified' as const,
      status: 'complete' as const,
      missing: [],
      evidence: {
        entrypoints: ['cli/commands/resume-plan.ts'],
        implementation: ['sdk/src/resume-plan.ts'],
        consumers: ['cli/commands/resume-plan.ts'],
        tests: ['sdk/src/__tests__/resume-plan.test.ts'],
        docs: ['README.md'],
        failureStates: ['cli/commands/resume-plan.ts'],
      },
    }
    expect(
      evaluateAuditCoverage({
        inventory,
        structuralReceipts: receipts,
        featureRecords: [verified],
      }).complete,
    ).toBe(true)
    expect(
      evaluateAuditCoverage({
        inventory,
        structuralReceipts: [
          { ...receipts[0]!, snapshotId: 'stale' },
          ...receipts.slice(1),
        ],
        featureRecords: [verified],
      }).complete,
    ).toBe(false)
  })

  test('excludes live-state paths from the snapshot', () => {
    const root = fixture()
    // cli/commands/extra.ts is an inventoried (non-ignored) path, so it must be
    // written before the first snapshot; only live-state churn may happen
    // between the two snapshots for the id-stability assertion below.
    fs.writeFileSync(
      path.join(root, 'cli', 'commands', 'extra.ts'),
      'export const extra = 1',
    )
    const before = inspectCodebaseStructure(root)
    expect(isIgnoredPath('.openbuff/memory/x.sqlite-wal')).toBe(true)
    expect(isIgnoredPath('.agents/sessions/slug/findings/f.md')).toBe(true)
    expect(isIgnoredPath('.agents/config.json')).toBe(false)
    expect(isIgnoredPath('tmp.log')).toBe(true)
    expect(isIgnoredPath('state.sqlite-shm')).toBe(true)
    expect(isIgnoredPath('cli/commands/extra.ts')).toBe(false)
    fs.mkdirSync(path.join(root, '.openbuff', 'memory'), { recursive: true })
    fs.writeFileSync(path.join(root, '.openbuff', 'memory', 'x.sqlite-wal'), '')
    fs.mkdirSync(path.join(root, '.codebuff-index'), { recursive: true })
    fs.writeFileSync(
      path.join(root, '.codebuff-index', 'metadata.json.tmp'),
      '',
    )
    fs.mkdirSync(path.join(root, 'debug'), { recursive: true })
    fs.writeFileSync(path.join(root, 'debug', 'log.jsonl'), '')
    fs.mkdirSync(path.join(root, '.agents', 'sessions', 'slug', 'findings'), {
      recursive: true,
    })
    fs.writeFileSync(
      path.join(root, '.agents', 'sessions', 'slug', 'findings', 'f.md'),
      '',
    )
    fs.writeFileSync(path.join(root, 'tmp.log'), '')
    const after = inspectCodebaseStructure(root)
    expect(after.snapshotId).toBe(before.snapshotId)
    expect(after.files).not.toContain('.openbuff/memory/x.sqlite-wal')
    expect(after.files).not.toContain('.codebuff-index/metadata.json.tmp')
    expect(after.files).not.toContain('debug/log.jsonl')
    expect(after.files).not.toContain('.agents/sessions/slug/findings/f.md')
    expect(after.files).not.toContain('tmp.log')
    expect(after.files).toContain('cli/commands/extra.ts')
  })

  test('probes survive live-state churn between calls with a cached inventory', () => {
    const root = fixture()
    const inventory = inspectCodebaseStructure(root)
    const first = inspectFeatureCompletenessTool(root, {
      feature: 'resume plan',
      snapshot_id: inventory.snapshotId,
    })
    const firstValue = first[0]?.type === 'json' ? first[0].value : undefined
    expect(firstValue).toMatchObject({
      coverageReceipt: { snapshot_id: inventory.snapshotId },
    })
    fs.mkdirSync(path.join(root, '.agents', 'sessions', 'x', 'findings'), {
      recursive: true,
    })
    fs.writeFileSync(
      path.join(root, '.agents', 'sessions', 'x', 'findings', 'y.md'),
      'resume plan scratchpad',
    )
    const second = inspectFeatureCompletenessTool(root, {
      feature: 'resume plan',
      snapshot_id: inventory.snapshotId,
    })
    const secondValue = second[0]?.type === 'json' ? second[0].value : undefined
    expect(secondValue).not.toHaveProperty('errorMessage')
    expect(secondValue).toMatchObject({
      coverageReceipt: { snapshot_id: inventory.snapshotId },
    })
  })

  test('evaluate_audit_coverage validates receipts against the stored inventory after findings writes', () => {
    const root = fixture()
    const inventory = inspectCodebaseStructure(root)
    fs.mkdirSync(path.join(root, '.agents', 'sessions', 'after', 'findings'), {
      recursive: true,
    })
    fs.writeFileSync(
      path.join(root, '.agents', 'sessions', 'after', 'findings', 'notes.md'),
      'resume plan notes',
    )
    const feature = inspectFeatureCompleteness(root, 'resume plan', inventory)
    const attested = [...new Set(Object.values(feature.evidence).flat())]
    const promotion = promoteFeatureEvidence(feature, inventory, attested)
    expect(promotion.verified).toBe(true)
    const receipts = inventory.subsystems.map((subsystem) => ({
      schemaVersion: 1 as const,
      snapshotId: inventory.snapshotId,
      shardId: `${subsystem.id}-shard`,
      subsystemIds: [subsystem.id],
      files: inventory.files.filter(
        (file) =>
          (file.includes('/') ? file.split('/')[0] : '.') === subsystem.id,
      ),
      domains: [...auditDomains],
    }))
    expect(
      evaluateAuditCoverage({
        inventory,
        structuralReceipts: receipts,
        featureRecords: [promotion.record],
      }).complete,
    ).toBe(true)
  })

  test('full source identity changes for equal-length mutations after 256KB', () => {
    const root = fixture()
    fs.writeFileSync(
      path.join(root, 'sdk', 'src', 'big.ts'),
      'x'.repeat(300_000),
    )
    const before = inspectCodebaseStructure(root)
    expect(before.files).toContain('sdk/src/big.ts')
    expect(before.snapshotId).toHaveLength(64)
    fs.writeFileSync(
      path.join(root, 'sdk', 'src', 'big.ts'),
      `${'x'.repeat(256_000)}y${'x'.repeat(43_999)}`,
    )
    const after = inspectCodebaseStructure(root)
    expect(after.snapshotId).not.toBe(before.snapshotId)
  })

  test('promoteFeatureEvidence flips to verified only with full attestation', () => {
    const inventory = inspectCodebaseStructure(fixture())
    const record = {
      feature: 'resume plan',
      snapshotId: inventory.snapshotId,
      evidenceKind: 'heuristic' as const,
      status: 'partial' as const,
      missing: ['failureStates'],
      evidence: {
        entrypoints: ['cli/commands/resume-plan.ts'],
        implementation: ['sdk/src/resume-plan.ts'],
        consumers: ['cli/commands/resume-plan.ts'],
        tests: ['sdk/src/__tests__/resume-plan.test.ts'],
        docs: ['README.md'],
        failureStates: ['cli/commands/resume-plan.ts'],
      },
    }
    const attested = [...new Set(Object.values(record.evidence).flat())]
    const promoted = promoteFeatureEvidence(record, inventory, attested)
    expect(promoted.verified).toBe(true)
    expect(promoted.unattested).toEqual([])
    expect(promoted.record).toMatchObject({
      evidenceKind: 'verified',
      inspectionStatus: 'complete',
      status: 'partial',
      maturity: 'unknown',
      missing: ['failureStates'],
    })
    const rejected = promoteFeatureEvidence(
      record,
      inventory,
      attested.filter((file) => file !== 'README.md'),
    )
    expect(rejected.verified).toBe(false)
    expect(rejected.record).toEqual(record)
    expect(rejected.unattested).toEqual(['README.md'])
  })

  test('cached tools reattest source bytes and retain findings-only snapshot stability', () => {
    const root = fixture()
    const inventory = inspectCodebaseStructure(root)
    inspectCodebaseStructureTool(root)
    fs.writeFileSync(
      path.join(root, 'sdk/src/resume-plan.ts'),
      'export const resumePlan = () => "changed"',
    )
    const stale = inspectFeatureCompletenessTool(root, {
      snapshot_id: inventory.snapshotId,
      feature: 'resume plan',
    })
    const value = stale[0]?.type === 'json' ? stale[0].value : undefined
    expect(value).toMatchObject({
      sourceBinding: {
        status: 'stale',
        expectedSnapshotId: inventory.snapshotId,
      },
    })
    expect(value).toHaveProperty('errorMessage')
  })

  test('release source membership and full tail bytes participate in attestation', () => {
    const root = fixture()
    fs.mkdirSync(path.join(root, 'release'))
    fs.mkdirSync(path.join(root, 'empty-directory'))
    fs.writeFileSync(path.join(root, 'release/publish.ts'), 'x'.repeat(300_000))
    fs.writeFileSync(
      path.join(root, 'release/openbuff.exe'),
      'generated binary',
    )
    const before = inspectCodebaseStructure(root)
    expect(before.sourceBinding?.shippedSourceFiles).toContain(
      'release/publish.ts',
    )
    // Release membership is conservative; file extensions cannot certify that
    // an executable or an unfamiliar language file contains no shipped source.
    expect(before.files).toContain('release/openbuff.exe')
    expect(before.directoryDispositions).toContainEqual({
      id: 'empty-directory',
      status: 'empty',
      reason: 'No included source files',
    })
    fs.writeFileSync(
      path.join(root, 'release/publish.ts'),
      'x'.repeat(299_999) + 'y',
    )
    expect(inspectCodebaseStructure(root).snapshotId).not.toBe(
      before.snapshotId,
    )
  })

  test('attests extensionless release scripts and unfamiliar source extensions', () => {
    const root = fixture()
    fs.mkdirSync(path.join(root, 'release', 'tools'), { recursive: true })
    fs.mkdirSync(path.join(root, 'bin'))
    for (const file of [
      'release/tools/bootstrap',
      'bin/openbuff',
      'release/tools/worker.hpp',
    ]) {
      fs.writeFileSync(path.join(root, file), '#!/bin/sh\nprintf "one"\n')
      const before = inspectCodebaseStructure(root)
      expect(before.sourceBinding?.shippedSourceFiles).toContain(file)
      fs.writeFileSync(path.join(root, file), '#!/bin/sh\nprintf "two"\n')
      expect(inspectCodebaseStructure(root).snapshotId).not.toBe(
        before.snapshotId,
      )
    }
  })

  test('symlink retargets invalidate a cached shipped-source snapshot', () => {
    const root = fixture()
    fs.mkdirSync(path.join(root, 'release', 'tools'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'release', 'tools', 'a.ts'),
      'export const a = 1\n',
    )
    fs.writeFileSync(
      path.join(root, 'release', 'tools', 'b.ts'),
      'export const b = 1\n',
    )
    const link = path.join(root, 'release', 'tools', 'link.ts')
    fs.symlinkSync('a.ts', link)
    const before = inspectCodebaseStructure(root)
    inspectCodebaseStructureTool(root)
    expect(before.sourceBinding?.shippedSourceFiles).toContain(
      'release/tools/link.ts',
    )
    fs.unlinkSync(link)
    fs.symlinkSync('b.ts', link)
    expect(inspectCodebaseStructure(root).snapshotId).not.toBe(
      before.snapshotId,
    )
    expect(
      inspectFeatureCompletenessTool(root, {
        feature: 'resume plan',
        snapshot_id: before.snapshotId,
      })[0],
    ).toMatchObject({
      type: 'json',
      value: { sourceBinding: { status: 'stale' } },
    })
  })

  test('file contents cannot impersonate a second source record', () => {
    const root = fixture()
    fs.mkdirSync(path.join(root, 'release', 'tools'), { recursive: true })
    const first = 'release/tools/a.ts'
    const second = 'release/tools/b.ts'
    fs.writeFileSync(path.join(root, first), 'x')
    fs.writeFileSync(path.join(root, second), 'y')
    const mode = fs.statSync(path.join(root, second)).mode
    const before = inspectCodebaseStructure(root)
    inspectCodebaseStructureTool(root)
    fs.unlinkSync(path.join(root, second))
    fs.writeFileSync(path.join(root, first), `x\n${second}\0${mode}\0file\0y`)
    const after = inspectCodebaseStructure(root)
    expect(after.files).not.toContain(second)
    expect(after.snapshotId).not.toBe(before.snapshotId)
    expect(
      inspectFeatureCompletenessTool(root, {
        feature: 'resume plan',
        snapshot_id: before.snapshotId,
      })[0],
    ).toMatchObject({
      type: 'json',
      value: { sourceBinding: { status: 'stale' } },
    })
  })

  test('rejects a same-inode rewrite observed at the final metadata boundary', () => {
    const root = fixture()
    const file = path.join(root, 'sdk', 'src', 'resume-plan.ts')
    const original = fs.lstatSync.bind(fs)
    let calls = 0
    const stat = spyOn(fs, 'lstatSync').mockImplementation(((
      ...args: Parameters<typeof fs.lstatSync>
    ) => {
      if (args[0] === file && ++calls === 2)
        fs.writeFileSync(file, 'export const resumePlan = () => "wrong"')
      return original(...args)
    }) as typeof fs.lstatSync)
    try {
      expect(() => inspectCodebaseStructure(root)).toThrow(
        'Source changed during snapshot attestation',
      )
      expect(calls).toBe(2)
    } finally {
      stat.mockRestore()
    }
    expect(inspectCodebaseStructure(root).sourceBinding?.status).toBe(
      'complete',
    )
  })

  test('nested feature identity cannot borrow the enclosing snapshot', () => {
    const root = fixture()
    const inventory = inspectCodebaseStructure(root)
    inspectCodebaseStructureTool(root)
    const result = evaluateAuditCoverageTool(root, {
      snapshot_id: inventory.snapshotId,
      structural_receipts: inventory.subsystems.map((subsystem) => ({
        schema_version: 1,
        snapshot_id: inventory.snapshotId,
        shard_id: subsystem.id,
        subsystem_ids: [subsystem.id],
        files: inventory.files.filter(
          (file) =>
            (file.includes('/') ? file.split('/')[0] : '.') === subsystem.id,
        ),
        domains: [...auditDomains],
      })),
      features: [
        {
          schema_version: 1,
          snapshot_id: 'foreign-snapshot',
          feature: 'resume plan',
          evidence_kind: 'verified',
          evidence: {
            entrypoints: [],
            implementation: [],
            consumers: [],
            tests: [],
            docs: ['README.md'],
            failure_states: [],
          },
        },
      ],
    })
    const value = result[0]?.type === 'json' ? result[0].value : undefined
    expect(value).toMatchObject({
      inspectionComplete: false,
      readinessComplete: false,
    })
    expect(value).toMatchObject({
      incompleteFeatures: [
        { feature: 'resume plan', reason: 'snapshot_mismatch' },
      ],
    })
  })

  test('complete source inspection preserves partial, unwired, absent and unknown maturity', () => {
    const root = fixture()
    const inventory = inspectCodebaseStructure(root)
    const structuralReceipts = inventory.subsystems.map((subsystem) => ({
      schemaVersion: 1 as const,
      snapshotId: inventory.snapshotId,
      shardId: subsystem.id,
      subsystemIds: [subsystem.id],
      files: inventory.files.filter(
        (file) =>
          (file.includes('/') ? file.split('/')[0] : '.') === subsystem.id,
      ),
      domains: [...auditDomains],
    }))
    for (const maturity of [
      'partial',
      'unwired',
      'absent',
      'unknown',
    ] as const) {
      const assessment = evaluateAuditCoverage({
        inventory,
        structuralReceipts,
        featureRecords: [
          {
            feature: 'resume plan',
            snapshotId: inventory.snapshotId,
            evidenceKind: 'verified',
            maturity,
            status: 'partial',
            missing: ['implementation', 'tests'],
            evidence: {
              entrypoints: [],
              implementation: [],
              consumers: [],
              tests: [],
              docs: ['README.md'],
              failureStates: [],
            },
          },
        ],
      })
      expect(assessment.inspectionComplete).toBe(true)
      expect(assessment.readinessComplete).toBe(false)
      expect(assessment.featureAssessments[0]).toMatchObject({
        maturity,
        assurance: 'source_inspection',
        runtimeReadiness: 'not_assessed',
      })
    }
    const discovered = inspectFeatureCompleteness(
      root,
      'resume plan',
      inventory,
    )
    const promoted = promoteFeatureEvidence(
      discovered,
      inventory,
      inventory.files,
    )
    expect(promoted.verified).toBe(true)
    expect(promoted.record.status).not.toBe('complete')
    expect(promoted.record.maturity).toBe('unknown')
    expect(
      evaluateAuditCoverage({
        inventory,
        structuralReceipts,
        featureRecords: [promoted.record],
      }).readinessComplete,
    ).toBe(false)
  })

  test('a subsystem receipt cannot hide an omitted source file', () => {
    const root = fixture()
    const inventory = inspectCodebaseStructure(root)
    const assessment = evaluateAuditCoverage({
      inventory,
      structuralReceipts: inventory.subsystems.map((subsystem) => ({
        schemaVersion: 1 as const,
        snapshotId: inventory.snapshotId,
        shardId: subsystem.id,
        subsystemIds: [subsystem.id],
        files: inventory.files
          .filter(
            (file) =>
              (file.includes('/') ? file.split('/')[0] : '.') === subsystem.id,
          )
          .slice(0, 1),
        domains: [...auditDomains],
      })),
      featureRecords: [
        promoteFeatureEvidence(
          inspectFeatureCompleteness(root, 'resume plan', inventory),
          inventory,
          inventory.files,
        ).record,
      ],
    })
    expect(assessment.inspectionComplete).toBe(false)
    expect(assessment.uncoveredFiles.length).toBeGreaterThan(0)
  })
})
