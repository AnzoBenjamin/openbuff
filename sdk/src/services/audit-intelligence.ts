import { createHash } from 'node:crypto'
import fs from 'node:fs'
import type { BigIntStats } from 'node:fs'
import path from 'node:path'

const ignored = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
])
export const ignoredLiveStateDirectories = [
  '.openbuff',
  '.codebuff-index',
  '.omx',
  '.tmp',
  'debug',
  'scratch-logs',
] as const
const artifactDirectories = new Set(['release', 'release-staging', 'bin'])
export const ignoredLiveStateFileSuffixes = [
  '.log',
  '.sqlite',
  '.sqlite-wal',
  '.sqlite-shm',
  '.sqlite-journal',
] as const
const ignoredLiveStateDirectorySet = new Set<string>(
  ignoredLiveStateDirectories,
)
const ignoredLiveStateFileSuffixList: readonly string[] =
  ignoredLiveStateFileSuffixes

export function isIgnoredPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/')
  const segments = normalized.split('/')
  if (normalized.startsWith('.agents/sessions/')) return true
  if (segments.some((segment) => ignoredLiveStateDirectorySet.has(segment)))
    return true
  return ignoredLiveStateFileSuffixList.some((suffix) =>
    normalized.endsWith(suffix),
  )
}
const sourceExtensions = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.cs',
  '.cpp',
  '.c',
  '.rb',
  '.php',
  '.swift',
  '.kt',
  '.gd',
])
const testPattern =
  /(?:^|\/)(?:__tests__|tests?|spec)(?:\/|$)|\.(?:test|spec)\.[^.]+$/i
const docPattern = /(?:^|\/)(?:README|CHANGELOG|ROADMAP|docs?\/)/i
const generatedPattern = /(?:\.generated\.|\/generated\/|\/dist\/|\/build\/)/i
export const auditDomains = [
  'security',
  'correctness',
  'state-mutation',
  'error-handling',
  'performance',
  'dependency-hygiene',
  'test-coverage',
  'api-contract',
] as const
export type AuditDomain = (typeof auditDomains)[number]

export type CodebaseInventory = {
  schemaVersion: 1
  snapshotId: string
  root: string
  files: string[]
  subsystems: Array<{
    id: string
    files: number
    sourceFiles: number
    tests: number
    docs: number
  }>
  entrypoints: string[]
  manifests: string[]
  routes: string[]
  commands: string[]
  publicApis: string[]
  tests: string[]
  generatedFiles: string[]
  capabilityPacket: { languages: string[]; frameworks: string[] }
  uncoveredDirectories: string[]
  scope?: string[]
  sourceBinding?: {
    status: 'complete'
    identity: 'full-file-sha256'
    shippedMembership: 'all-non-live-entries'
    symlinkIdentity: 'link-target-bytes'
    shippedSourceFiles: string[]
  }
  directoryDispositions?: Array<{
    id: string
    status:
      | 'inventoried'
      | 'generated'
      | 'live-state'
      | 'out-of-scope'
      | 'empty'
    reason: string
  }>
}

function walk(root: string, current = root, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name)
    const relative = path.relative(root, absolute).replace(/\\/g, '/')
    if (entry.isDirectory()) {
      const segments = relative.split('/')
      const mayContainShippedSource = segments.some((segment) =>
        artifactDirectories.has(segment),
      )
      if (
        isIgnoredPath(relative) ||
        (ignored.has(entry.name) &&
          (!mayContainShippedSource ||
            entry.name === '.git' ||
            entry.name === 'node_modules'))
      )
        continue
      walk(root, absolute, out)
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      if (ignored.has(entry.name) || isIgnoredPath(relative)) continue
      out.push(relative)
    }
  }
  return out
}

const maxFileBytes = 256_000

function sameSourceMetadata(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  )
}

function hashInventory(files: string[], root: string): string {
  const hash = createHash('sha256')
  hash.update('openbuff-source-snapshot-v2\n')
  for (const file of files) {
    const absolute = path.join(root, file)
    const stat = fs.lstatSync(absolute, { bigint: true })
    const contentHash = createHash('sha256')
    if (stat.isSymbolicLink()) {
      contentHash.update(fs.readlinkSync(absolute, { encoding: 'buffer' }))
      if (!sameSourceMetadata(stat, fs.lstatSync(absolute, { bigint: true })))
        throw new Error(`Source changed during snapshot attestation: ${file}`)
    } else {
      const fd = fs.openSync(absolute, 'r')
      try {
        const before = fs.fstatSync(fd, { bigint: true })
        if (!before.isFile() || !sameSourceMetadata(stat, before))
          throw new Error(`Source changed during snapshot attestation: ${file}`)
        const buffer = Buffer.allocUnsafe(64 * 1024)
        let position = 0
        while (true) {
          const count = fs.readSync(fd, buffer, 0, buffer.length, position)
          if (count === 0) break
          contentHash.update(buffer.subarray(0, count))
          position += count
        }
        const after = fs.fstatSync(fd, { bigint: true })
        const current = fs.lstatSync(absolute, { bigint: true })
        if (
          BigInt(position) !== before.size ||
          !sameSourceMetadata(before, after) ||
          !sameSourceMetadata(before, current)
        )
          throw new Error(`Source changed during snapshot attestation: ${file}`)
      } finally {
        fs.closeSync(fd)
      }
    }
    // Frame each path/type/mode and full content digest independently. Raw
    // file bodies may contain arbitrary bytes, including another record header.
    hash.update(
      JSON.stringify([
        file,
        stat.mode.toString(),
        stat.isSymbolicLink() ? 'link' : 'file',
        contentHash.digest('hex'),
      ]) + '\n',
    )
  }
  return hash.digest('hex')
}

export function inspectCodebaseStructure(
  cwd: string,
  scope?: string[],
): CodebaseInventory {
  const root = path.resolve(cwd)
  const allFiles = walk(root).sort()
  const files = scope?.length
    ? allFiles.filter((file) =>
        scope.some(
          (prefix) =>
            file === prefix || file.startsWith(`${prefix.replace(/\/$/, '')}/`),
        ),
      )
    : allFiles
  const subsystemMap = new Map<string, string[]>()
  for (const file of files) {
    const id = file.includes('/') ? file.split('/')[0]! : '.'
    subsystemMap.set(id, [...(subsystemMap.get(id) ?? []), file])
  }
  const manifests = files.filter((file) =>
    /(^|\/)(package\.json|Cargo\.toml|pyproject\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|Package\.swift|project\.godot)$/.test(
      file,
    ),
  )
  const tests = files.filter((file) => testPattern.test(file))
  const entrypoints = files.filter((file) =>
    /(^|\/)(index|main|app|server|cli)\.[^.]+$/i.test(file),
  )
  const routes = files.filter(
    (file) =>
      /(^|\/)(routes?|pages?|app)\//i.test(file) || /route\.[^.]+$/i.test(file),
  )
  const commands = files.filter((file) =>
    /(^|\/)(commands?|scripts)\//i.test(file),
  )
  const publicApis = files.filter(
    (file) =>
      /(^|\/)(index|mod|lib)\.[^.]+$/i.test(file) ||
      /(^|\/)exports?\.[^.]+$/i.test(file),
  )
  const generatedFiles = files.filter((file) => generatedPattern.test(file))
  const extensionLanguages: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.py': 'python',
    '.rs': 'rust',
    '.go': 'go',
    '.java': 'java',
    '.cs': 'csharp',
    '.cpp': 'cpp',
    '.c': 'c',
    '.rb': 'ruby',
    '.php': 'php',
    '.swift': 'swift',
    '.kt': 'kotlin',
    '.gd': 'gdscript',
  }
  const languages = [
    ...new Set(
      files
        .map((file) => extensionLanguages[path.extname(file).toLowerCase()])
        .filter((value): value is string => Boolean(value)),
    ),
  ]
  const frameworkSignals: Array<[RegExp, string]> = [
    [/(^|\/)next\.config\./, 'nextjs'],
    [/(^|\/)vite\.config\./, 'vite'],
    [/(^|\/)angular\.json$/, 'angular'],
    [/(^|\/)svelte\.config\./, 'svelte'],
    [/(^|\/)Cargo\.toml$/, 'cargo'],
    [/(^|\/)go\.mod$/, 'go-modules'],
    [/(^|\/)pyproject\.toml$/, 'python-packaging'],
    [/(^|\/)project\.godot$/, 'godot'],
  ]
  const frameworks = frameworkSignals
    .filter(([pattern]) => files.some((file) => pattern.test(file)))
    .map(([, id]) => id)
  const directoryDispositions = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const id = entry.name
      if (subsystemMap.has(id))
        return {
          id,
          status: 'inventoried' as const,
          reason: 'Included in source snapshot',
        }
      if (ignored.has(id))
        return {
          id,
          status: 'generated' as const,
          reason: 'Dependency, VCS or generated directory',
        }
      if (ignoredLiveStateDirectorySet.has(id))
        return {
          id,
          status: 'live-state' as const,
          reason: 'Runtime state excluded from source identity',
        }
      if (
        scope?.length &&
        !scope.some((prefix) => prefix === id || prefix.startsWith(`${id}/`))
      )
        return {
          id,
          status: 'out-of-scope' as const,
          reason: 'Excluded by requested scope',
        }
      return {
        id,
        status: 'empty' as const,
        reason: 'No included source files',
      }
    })
  return {
    schemaVersion: 1,
    snapshotId: hashInventory(files, root),
    root,
    ...(scope?.length ? { scope: [...scope] } : {}),
    files,
    subsystems: [...subsystemMap].map(([id, owned]) => ({
      id,
      files: owned.length,
      sourceFiles: owned.filter((file) =>
        sourceExtensions.has(path.extname(file).toLowerCase()),
      ).length,
      tests: owned.filter((file) => testPattern.test(file)).length,
      docs: owned.filter((file) => docPattern.test(file)).length,
    })),
    entrypoints,
    manifests,
    routes,
    commands,
    publicApis,
    tests,
    generatedFiles,
    capabilityPacket: { languages, frameworks },
    uncoveredDirectories: [],
    directoryDispositions,
    sourceBinding: {
      status: 'complete',
      identity: 'full-file-sha256',
      shippedMembership: 'all-non-live-entries',
      symlinkIdentity: 'link-target-bytes',
      shippedSourceFiles: files.filter((file) =>
        file.split('/').some((segment) => artifactDirectories.has(segment)),
      ),
    },
  }
}

export type FeatureCompletenessRecord = {
  feature: string
  snapshotId?: string
  evidenceKind: 'heuristic' | 'verified'
  maturity?: 'unknown' | 'absent' | 'partial' | 'unwired'
  inspectionStatus?: 'complete' | 'partial'
  evidence: {
    entrypoints: string[]
    implementation: string[]
    consumers: string[]
    tests: string[]
    docs: string[]
    failureStates: string[]
  }
  status:
    | 'complete'
    | 'partial'
    | 'implemented_but_unreachable'
    | 'documented_but_unimplemented'
    | 'tested_without_runtime_wiring'
    | 'runtime_wired_without_failure_coverage'
    | 'unknown'
  missing: string[]
}

export function inspectFeatureCompleteness(
  cwd: string,
  feature: string,
  inventory: CodebaseInventory,
): FeatureCompletenessRecord {
  const terms = feature
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 3)
  const candidates = [
    ...new Set([
      ...inventory.entrypoints,
      ...inventory.routes,
      ...inventory.commands,
      ...inventory.publicApis,
      ...inventory.tests,
      ...inventory.files,
    ]),
  ]
  const matching = candidates.filter((file) => {
    const haystack = `${file}\n${safeRead(path.join(cwd, file))}`.toLowerCase()
    return terms.some((term) => haystack.includes(term))
  })
  const evidence = {
    entrypoints: matching.filter(
      (file) =>
        inventory.entrypoints.includes(file) ||
        inventory.commands.includes(file) ||
        inventory.routes.includes(file),
    ),
    implementation: matching.filter(
      (file) =>
        sourceExtensions.has(path.extname(file).toLowerCase()) &&
        !testPattern.test(file),
    ),
    consumers: matching.filter((file) =>
      /(?:cli|ui|components?|pages?|routes?|sdk)\//i.test(file),
    ),
    tests: matching.filter((file) => testPattern.test(file)),
    docs: matching.filter((file) => docPattern.test(file)),
    failureStates: matching.filter((file) =>
      /error|retry|cancel|timeout|empty|loading|permission/i.test(
        safeRead(path.join(cwd, file)),
      ),
    ),
  }
  const missing = Object.entries(evidence)
    .filter(([, value]) => value.length === 0)
    .map(([key]) => key)
  let status: FeatureCompletenessRecord['status'] =
    missing.length === 0 ? 'unknown' : 'partial'
  if (!evidence.implementation.length && evidence.docs.length)
    status = 'documented_but_unimplemented'
  else if (
    evidence.implementation.length &&
    !evidence.entrypoints.length &&
    !evidence.consumers.length
  )
    status = 'implemented_but_unreachable'
  else if (evidence.tests.length && !evidence.entrypoints.length)
    status = 'tested_without_runtime_wiring'
  else if (evidence.entrypoints.length && !evidence.failureStates.length)
    status = 'runtime_wired_without_failure_coverage'
  else if (matching.length === 0) status = 'unknown'
  return {
    feature,
    snapshotId: inventory.snapshotId,
    evidenceKind: 'heuristic',
    maturity: 'unknown',
    inspectionStatus: 'partial',
    evidence,
    status,
    missing,
  }
}

function safeRead(file: string): string {
  try {
    return fs.statSync(file).size <= maxFileBytes
      ? fs.readFileSync(file, 'utf8')
      : ''
  } catch {
    return ''
  }
}

export function promoteFeatureEvidence(
  record: FeatureCompletenessRecord,
  inventory: CodebaseInventory,
  attestedFiles: readonly string[],
): {
  record: FeatureCompletenessRecord
  verified: boolean
  unattested: string[]
} {
  const attested = new Set(attestedFiles)
  const inventoryFiles = new Set(inventory.files)
  const unattested = new Set<string>()
  for (const category of Object.values(record.evidence)) {
    for (const file of category)
      if (!attested.has(file) || !inventoryFiles.has(file)) unattested.add(file)
  }
  if (record.snapshotId !== inventory.snapshotId) unattested.add('snapshot_id')
  if (
    Object.values(record.evidence).some((files) => files.length > 0) &&
    unattested.size === 0
  )
    return {
      record: {
        ...record,
        evidenceKind: 'verified',
        inspectionStatus: 'complete',
        maturity: record.maturity ?? 'unknown',
      },
      verified: true,
      unattested: [],
    }
  return { record, verified: false, unattested: [...unattested] }
}

export type AuditCoverageReceipt = {
  schemaVersion: 1
  snapshotId: string
  shardId: string
  subsystemIds: string[]
  files: string[]
  domains: AuditDomain[]
}

export function evaluateAuditCoverage(params: {
  inventory: CodebaseInventory
  structuralReceipts: AuditCoverageReceipt[]
  featureRecords: FeatureCompletenessRecord[]
  outOfScope?: Array<{ id: string; reason: string }>
}) {
  const exclusions = new Map(
    (params.outOfScope ?? []).map((item) => [item.id, item.reason]),
  )
  const inventoryFiles = new Set(params.inventory.files)
  const subsystemFor = (file: string) =>
    file.includes('/') ? file.split('/')[0]! : '.'
  const validReceipts = params.structuralReceipts.filter(
    (receipt) =>
      receipt.schemaVersion === 1 &&
      receipt.snapshotId === params.inventory.snapshotId &&
      receipt.shardId.length > 0 &&
      receipt.files.length > 0 &&
      receipt.files.every((file) => inventoryFiles.has(file)) &&
      receipt.subsystemIds.every((id) =>
        receipt.files.some((file) => subsystemFor(file) === id),
      ),
  )
  const uncoveredSubsystems = params.inventory.subsystems
    .map((item) => item.id)
    .filter((id) => {
      if (exclusions.has(id)) return false
      const domains = new Set(
        validReceipts
          .filter((receipt) => receipt.subsystemIds.includes(id))
          .flatMap((receipt) => receipt.domains),
      )
      return auditDomains.some((domain) => !domains.has(domain))
    })
  const invalidReceipts = params.structuralReceipts
    .filter((receipt) => !validReceipts.includes(receipt))
    .map((receipt) => receipt.shardId)
  const coveredFiles = new Set(
    validReceipts.flatMap((receipt) => receipt.files),
  )
  const uncoveredFiles = params.inventory.files.filter(
    (file) => !exclusions.has(subsystemFor(file)) && !coveredFiles.has(file),
  )
  const incompleteFeatures = params.featureRecords.filter(
    (item) =>
      item.snapshotId !== params.inventory.snapshotId ||
      item.evidenceKind !== 'verified' ||
      !Object.values(item.evidence).some((files) => files.length > 0) ||
      Object.values(item.evidence).some((files) =>
        files.some((file) => !inventoryFiles.has(file)),
      ),
  )
  const inspectionComplete =
    params.featureRecords.length > 0 &&
    invalidReceipts.length === 0 &&
    uncoveredSubsystems.length === 0 &&
    uncoveredFiles.length === 0 &&
    incompleteFeatures.length === 0
  return {
    schemaVersion: 1 as const,
    snapshotId: params.inventory.snapshotId,
    complete: inspectionComplete,
    inspectionComplete,
    readinessComplete: false,
    assurance: inspectionComplete
      ? 'source_inspection'
      : 'incomplete_inspection',
    sourceBinding: {
      status: 'current',
      snapshotId: params.inventory.snapshotId,
    },
    featureAssessments: params.featureRecords.map((item) => ({
      feature: item.feature,
      maturity: item.maturity ?? 'unknown',
      status: item.status,
      assurance:
        item.evidenceKind === 'verified' ? 'source_inspection' : 'heuristic',
      runtimeReadiness: 'not_assessed',
      missing: item.missing,
    })),
    invalidReceipts,
    uncoveredSubsystems,
    uncoveredFiles,
    directoryDispositions: params.inventory.directoryDispositions ?? [],
    incompleteFeatures: incompleteFeatures.map((item) => ({
      feature: item.feature,
      status: item.status,
      missing: item.missing,
      reason:
        item.snapshotId !== params.inventory.snapshotId
          ? 'snapshot_mismatch'
          : item.evidenceKind !== 'verified'
            ? 'unverified_evidence'
            : 'incomplete_source_evidence',
    })),
    outOfScope: [...exclusions].map(([id, reason]) => ({ id, reason })),
  }
}
