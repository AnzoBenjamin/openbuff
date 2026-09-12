export type MemoryArtifactPathKind =
  | 'source'
  | 'test'
  | 'configuration'
  | 'documentation'
  | 'generated'
  | 'dependency'
  | 'data'
  | 'binary'
  | 'other'

export type MemoryGeneratedDisposition = 'not-generated' | 'tracked-like' | 'ephemeral'

export interface MemoryGeneratedArtifactProvenance {
  generator: string
  config: string
  sourceInputs: string[]
  toolVersion: string
}

export interface MemoryArtifactPolicyDecision {
  allowed: boolean
  normalizedPath?: string
  kind: MemoryArtifactPathKind
  generated: MemoryGeneratedDisposition
  reason?:
    | 'invalid-path'
    | 'private-memory'
    | 'dependency'
    | 'cache'
    | 'log'
    | 'temporary'
    | 'build-output'
    | 'sensitive'
    | 'binary'
    | 'generated-provenance-required'
}

const BINARY_EXTENSIONS = new Set([
  '7z', 'avi', 'bin', 'bmp', 'class', 'dll', 'dmg', 'doc', 'docx', 'exe', 'gif',
  'gz', 'ico', 'jar', 'jpeg', 'jpg', 'mov', 'mp3', 'mp4', 'o', 'obj', 'pdf', 'png',
  'ppt', 'pptx', 'so', 'tar', 'ttf', 'wav', 'webp', 'woff', 'woff2', 'xls', 'xlsx', 'zip',
])
const SOURCE_EXTENSIONS = new Set([
  'c', 'cc', 'cpp', 'cs', 'css', 'go', 'h', 'hpp', 'html', 'java', 'js', 'jsx', 'kt',
  'lua', 'php', 'py', 'rb', 'rs', 'scss', 'sh', 'sql', 'svelte', 'swift', 'ts', 'tsx', 'vue',
])
const CONFIG_NAMES = new Set([
  'dockerfile', 'makefile', 'biome.json', 'eslint.config.js', 'package.json', 'pyproject.toml',
  'tsconfig.json', 'vite.config.ts', 'webpack.config.js',
])
const CONFIG_EXTENSIONS = new Set(['ini', 'json', 'toml', 'yaml', 'yml'])
const DATA_EXTENSIONS = new Set(['csv', 'jsonl', 'ndjson', 'parquet', 'xml'])
const DOC_EXTENSIONS = new Set(['md', 'mdx', 'rst', 'txt'])
const PRIVATE_KEY_OR_CERTIFICATE_EXTENSIONS = new Set([
  'cer', 'cert', 'crt', 'der', 'key', 'p12', 'pem', 'pfx', 'ppk',
])

const segmentMatches = (segments: string[], expression: RegExp): boolean =>
  segments.some((segment) => expression.test(segment))

export function normalizeMemoryArtifactPath(candidate: string): string | undefined {
  if (!candidate || candidate.length > 1_024 || candidate.includes('\0')) return undefined
  const slashed = candidate.replaceAll('\\', '/')
  if (slashed.startsWith('/') || slashed.startsWith('//') || /^[A-Za-z]:\//.test(slashed)) {
    return undefined
  }
  const output: string[] = []
  for (const segment of slashed.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') return undefined
    output.push(segment)
  }
  return output.length > 0 ? output.join('/') : undefined
}

function hasGeneratedProvenance(
  provenance: MemoryGeneratedArtifactProvenance | undefined,
): boolean {
  if (
    !provenance ||
    typeof provenance.generator !== 'string' ||
    typeof provenance.toolVersion !== 'string' ||
    typeof provenance.config !== 'string' ||
    !Array.isArray(provenance.sourceInputs) ||
    provenance.sourceInputs.some((input) => typeof input !== 'string')
  ) {
    return false
  }
  const generator = provenance.generator.trim()
  const toolVersion = provenance.toolVersion.trim()
  const config = normalizeMemoryArtifactPath(provenance.config)
  const inputs = provenance.sourceInputs
    .slice(0, 100)
    .map(normalizeMemoryArtifactPath)
    .filter((value): value is string => value !== undefined)
  return (
    generator.length > 0 &&
    generator.length <= 128 &&
    toolVersion.length > 0 &&
    toolVersion.length <= 128 &&
    config !== undefined &&
    provenance.sourceInputs.length > 0 &&
    provenance.sourceInputs.length <= 100 &&
    inputs.length === provenance.sourceInputs.length
  )
}

export function classifyMemoryArtifactPath(
  candidate: string,
  provenance?: MemoryGeneratedArtifactProvenance,
): MemoryArtifactPolicyDecision {
  const normalizedPath = normalizeMemoryArtifactPath(candidate)
  if (!normalizedPath) {
    return { allowed: false, kind: 'other', generated: 'not-generated', reason: 'invalid-path' }
  }
  const lower = normalizedPath.toLowerCase()
  const segments = lower.split('/')
  const name = segments.at(-1) ?? ''
  const extension = name.includes('.') ? name.split('.').at(-1)! : ''
  const decision = (
    allowed: boolean,
    kind: MemoryArtifactPathKind,
    generated: MemoryGeneratedDisposition,
    reason?: MemoryArtifactPolicyDecision['reason'],
  ): MemoryArtifactPolicyDecision => ({
    allowed,
    normalizedPath,
    kind,
    generated,
    ...(reason ? { reason } : {}),
  })

  if (segments[0] === '.openbuff') return decision(false, 'data', 'ephemeral', 'private-memory')
  if (segmentMatches(segments, /^(node_modules|vendor|third_party|third-party)$/)) {
    return decision(false, 'dependency', 'not-generated', 'dependency')
  }
  if (segmentMatches(segments, /^(\.cache|cache|caches|\.turbo|\.next|\.nuxt|__pycache__)$/)) {
    return decision(false, 'generated', 'ephemeral', 'cache')
  }
  if (segmentMatches(segments, /^(dist|build|out|target|coverage|\.output|\.parcel-cache)$/)) {
    return decision(false, 'generated', 'ephemeral', 'build-output')
  }
  if (segmentMatches(segments, /^(tmp|temp|\.tmp|\.temp|clones?|worktrees?)$/)) {
    return decision(false, 'other', 'ephemeral', 'temporary')
  }
  if (extension === 'log' || segmentMatches(segments, /^(logs?)$/)) {
    return decision(false, 'data', 'ephemeral', 'log')
  }
  if (
    name === '.env' ||
    (segments.includes('.ssh') && (name === 'id_rsa' || name === 'id_ed25519')) ||
    PRIVATE_KEY_OR_CERTIFICATE_EXTENSIONS.has(extension) ||
    (/^(\.env\.|.*(?:secret|password|passwd|token|credential|private[-_.]?key).*)$/i.test(name) &&
      !name.endsWith('.example'))
  ) {
    return decision(false, 'configuration', 'not-generated', 'sensitive')
  }
  if (BINARY_EXTENSIONS.has(extension)) {
    return decision(false, 'binary', 'not-generated', 'binary')
  }

  const trackedGenerated =
    segmentMatches(segments, /^(generated|gen)$/) ||
    /(?:\.generated|\.gen|_generated|_pb2|\.g)\.[^.]+$/.test(name) ||
    name.endsWith('.d.ts')
  if (trackedGenerated) {
    return hasGeneratedProvenance(provenance)
      ? decision(true, 'generated', 'tracked-like')
      : decision(false, 'generated', 'tracked-like', 'generated-provenance-required')
  }
  if (
    segmentMatches(segments, /^(test|tests|__tests__|spec|specs)$/) ||
    /(?:^|\.)(?:test|spec)\.[^.]+$/.test(name)
  ) {
    return decision(true, 'test', 'not-generated')
  }
  if (
    segments[0] === 'docs' ||
    DOC_EXTENSIONS.has(extension) ||
    /^(readme|changelog|contributing|license)(\.|$)/.test(name)
  ) {
    return decision(true, 'documentation', 'not-generated')
  }
  if (
    CONFIG_NAMES.has(name) ||
    CONFIG_EXTENSIONS.has(extension) ||
    name.startsWith('.') && !name.includes('.', 1)
  ) {
    return decision(true, 'configuration', 'not-generated')
  }
  if (DATA_EXTENSIONS.has(extension)) return decision(true, 'data', 'not-generated')
  if (SOURCE_EXTENSIONS.has(extension)) return decision(true, 'source', 'not-generated')
  return decision(true, 'other', 'not-generated')
}

export const isMemoryArtifactPersistenceAllowed = (
  candidate: string,
  provenance?: MemoryGeneratedArtifactProvenance,
): boolean => classifyMemoryArtifactPath(candidate, provenance).allowed
