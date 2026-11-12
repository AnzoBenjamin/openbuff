#!/usr/bin/env bun
/** Verification-only bootstrap. Acquisition and native enforcement are separate gates. */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { arch, release } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { createNodeProcessScope } from '../common/src/util/node-process-scope'
import type { CleanupResult } from '../common/src/types/contracts/process-scope'

export type FileSeal = { path: string; sha256: string }
export type ToolId = 'bun' | 'node' | 'cargo' | 'rustc' | 'bwrap'
type Selector =
  | { kind: 'path-name'; name: string }
  | { kind: 'absolute-path'; path: string }
type ToolSelection = {
  selector: Selector
  expectedVersion: string | null
  versionConstraintSource?: { file: FileSeal; jsonPointer: string }
  expectedSha256ByHost: Record<string, string>
  selectionEvidence: FileSeal | null
  acquisition: 'separate-required' | 'already-selected'
}
export type BootstrapSelectionManifest = {
  schemaVersion: 1
  type: 'body-bootstrap-selection'
  tools: Partial<Record<ToolId, ToolSelection>>
  cells: Record<
    string,
    {
      boundary: 'bootstrap-prerequisites'
      tools: ToolId[]
      cells: string[]
      artifacts: string[]
      platform: 'linux' | 'darwin' | 'win32' | 'any'
    }
  >
  inputs: {
    packages: FileSeal[]
    locks: FileSeal[]
    sources: FileSeal[]
    configuration: FileSeal[]
  }
  artifacts: {
    id: string
    path: string
    sha256: string | null
    executable: boolean
    buildReceipt: FileSeal | null
    boundary: 'checkout-build' | 'isolated-installed' | 'native-build'
  }[]
  capabilities: {
    id: string
    state: 'unavailable' | 'verified'
    boundary: string
    proof: FileSeal | null
  }[]
}
export type BootstrapRequest = {
  manifestPath: string
  evidenceDir: string
  requiredCells: readonly string[]
}
export type BootstrapEnvironment = Readonly<{
  PATH?: string
  PATHEXT?: string
  BODY_BUN?: string
  BODY_EVIDENCE?: string
  BODY_TOOLCHAIN_MANIFEST?: string
}>
export type ProbeRequest = {
  argv: readonly string[]
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  maxOutputBytes: number
  signal?: AbortSignal
}
export type ProbeReceipt = {
  argv: readonly string[]
  cwd: string
  startedAtUtc: string
  finishedAtUtc: string
  environment: Record<string, string>
  elapsedMs: number
  pid: number | null
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  timedOut: boolean
  outputLimitExceeded: boolean
  aborted: boolean
  error: string | null
  cleanup: CleanupResult | null
}
export type BootstrapDependencies = {
  root: string
  environment: BootstrapEnvironment
  platform: { os: string; arch: string; kernelRelease: string }
  readFile(path: string): Buffer
  realpath(path: string): string
  inspect(path: string): {
    isFile: boolean
    executable: boolean
    byteLength: number
    mode: number
    device: string
    inode: string
  }
  now(): string
  probe(request: ProbeRequest): Promise<ProbeReceipt>
  makeEvidenceDirectory(path: string): void
  writeEvidence(path: string, value: unknown): void
}
type FileObservation = {
  path: string
  expectedSha256: string | null
  sha256: string | null
  present: boolean
  isFile: boolean | null
  byteLength: number | null
  executable: boolean | null
  mode: number | null
  device: string | null
  inode: string | null
  error: string | null
}
type ToolObservation = {
  id: ToolId
  state: 'available' | 'unavailable'
  reason: string | null
  expectedVersion: string | null
  version: string | null
  selectedPath: string | null
  resolvedPath: string | null
  before: FileObservation | null
  after: FileObservation | null
  final: {
    selectedPath: string | null
    resolvedPath: string | null
    alias: FileObservation | null
    canonical: FileObservation | null
    bodyBun: {
      path: string
      resolvedPath: string | null
      file: FileObservation
    } | null
    reason: string | null
  } | null
  command: ProbeReceipt | null
}
const tools = new Set<ToolId>(['bun', 'node', 'cargo', 'rustc', 'bwrap'])
const digestPattern = /^[a-f0-9]{64}$/
const versionPattern = /^\d+\.\d+\.\d+$/
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error)
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function object(
  value: unknown,
  keys: readonly string[],
  required = keys,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object')
  const item = value as Record<string, unknown>
  if (
    Object.keys(item).some((key) => !keys.includes(key)) ||
    required.some((key) => !Object.hasOwn(item, key))
  )
    throw new Error('Unknown or missing manifest field')
  return item
}
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0'))
    throw new Error('Expected a nonempty string')
}
function seal(value: unknown): asserts value is FileSeal {
  const item = object(value, ['path', 'sha256'])
  text(item.path)
  if (!isAbsolute(item.path) && item.path.split(/[/\\]/).includes('..'))
    throw new Error('Relative input escapes repository root')
  if (typeof item.sha256 !== 'string' || !digestPattern.test(item.sha256))
    throw new Error('Invalid SHA-256 seal')
}
function stringList(value: unknown): asserts value is string[] {
  if (!Array.isArray(value)) throw new Error('Expected a list')
  value.forEach(text)
  if (new Set(value).size !== value.length)
    throw new Error('Duplicate list entry')
}
function oneOf(value: unknown, allowed: readonly unknown[]) {
  if (!allowed.includes(value)) throw new Error('Unsupported manifest value')
}

export function validateBootstrapManifest(
  value: unknown,
): BootstrapSelectionManifest {
  const item = object(value, [
    'schemaVersion',
    'type',
    'tools',
    'cells',
    'inputs',
    'artifacts',
    'capabilities',
  ])
  oneOf(item.schemaVersion, [1])
  oneOf(item.type, ['body-bootstrap-selection'])
  const selections = object(item.tools, [...tools], [])
  for (const selection of Object.values(selections)) {
    const t = object(
      selection,
      [
        'selector',
        'expectedVersion',
        'versionConstraintSource',
        'expectedSha256ByHost',
        'selectionEvidence',
        'acquisition',
      ],
      [
        'selector',
        'expectedVersion',
        'expectedSha256ByHost',
        'selectionEvidence',
        'acquisition',
      ],
    )
    const selector = object(t.selector, ['kind', 'name', 'path'], ['kind'])
    if (selector.kind === 'path-name') {
      text(selector.name)
      if (Object.hasOwn(selector, 'path') || /[/\\]/.test(selector.name))
        throw new Error('Invalid PATH tool selector')
    } else {
      oneOf(selector.kind, ['absolute-path'])
      text(selector.path)
      if (Object.hasOwn(selector, 'name') || !isAbsolute(selector.path))
        throw new Error('Executable path must be absolute')
    }
    if (
      t.expectedVersion !== null &&
      (typeof t.expectedVersion !== 'string' ||
        !versionPattern.test(t.expectedVersion))
    )
      throw new Error('Tool versions must be exact')
    oneOf(t.acquisition, ['separate-required', 'already-selected'])
    if (t.selectionEvidence !== null) seal(t.selectionEvidence)
    if (t.versionConstraintSource !== undefined) {
      const source = object(t.versionConstraintSource, ['file', 'jsonPointer'])
      seal(source.file)
      text(source.jsonPointer)
      if (!(source.jsonPointer as string).startsWith('/'))
        throw new Error('Invalid JSON pointer')
    }
    if (
      !t.expectedSha256ByHost ||
      typeof t.expectedSha256ByHost !== 'object' ||
      Array.isArray(t.expectedSha256ByHost)
    )
      throw new Error('Invalid host checksums')
    for (const [host, digest] of Object.entries(t.expectedSha256ByHost)) {
      if (
        !/^(linux|darwin|win32)-[a-z0-9_]+$/.test(host) ||
        typeof digest !== 'string' ||
        !digestPattern.test(digest)
      )
        throw new Error('Invalid host checksum')
    }
  }
  const inputs = object(item.inputs, [
    'packages',
    'locks',
    'sources',
    'configuration',
  ])
  const paths = new Set<string>()
  for (const category of Object.values(inputs)) {
    if (!Array.isArray(category) || category.length === 0)
      throw new Error('Input categories cannot be empty')
    for (const entry of category) {
      seal(entry)
      if (paths.has(entry.path)) throw new Error('Duplicate sealed input')
      paths.add(entry.path)
    }
  }
  if (!Array.isArray(item.artifacts) || !Array.isArray(item.capabilities))
    throw new Error('Expected artifact/capability lists')
  const artifactIds = new Set<string>(),
    artifactPaths = new Set<string>()
  for (const entry of item.artifacts) {
    const a = object(entry, [
      'id',
      'path',
      'sha256',
      'executable',
      'buildReceipt',
      'boundary',
    ])
    text(a.id)
    text(a.path)
    if (artifactIds.has(a.id) || artifactPaths.has(a.path))
      throw new Error('Duplicate artifact ID or path')
    artifactIds.add(a.id)
    artifactPaths.add(a.path)
    if (
      a.sha256 !== null &&
      (typeof a.sha256 !== 'string' || !digestPattern.test(a.sha256))
    )
      throw new Error('Invalid artifact checksum')
    if (typeof a.executable !== 'boolean')
      throw new Error('Invalid executable requirement')
    if (a.buildReceipt !== null) seal(a.buildReceipt)
    oneOf(a.boundary, ['checkout-build', 'isolated-installed', 'native-build'])
  }
  const capabilityIds = new Set<string>()
  for (const entry of item.capabilities) {
    const c = object(entry, ['id', 'state', 'boundary', 'proof'])
    text(c.id)
    text(c.boundary)
    if (capabilityIds.has(c.id)) throw new Error('Duplicate capability ID')
    capabilityIds.add(c.id)
    oneOf(c.state, ['unavailable', 'verified'])
    if (c.proof !== null) seal(c.proof)
    if (c.state === 'verified' && c.proof === null)
      throw new Error('Verified capability requires a sealed proof')
  }
  if (
    !item.cells ||
    typeof item.cells !== 'object' ||
    Array.isArray(item.cells) ||
    !Object.keys(item.cells).length
  )
    throw new Error('Cells cannot be empty')
  const cells = item.cells as Record<string, unknown>
  for (const [id, entry] of Object.entries(cells)) {
    if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error('Invalid cell ID')
    const c = object(entry, [
      'boundary',
      'tools',
      'cells',
      'artifacts',
      'platform',
    ])
    oneOf(c.boundary, ['bootstrap-prerequisites'])
    oneOf(c.platform, ['linux', 'darwin', 'win32', 'any'])
    stringList(c.tools)
    stringList(c.cells)
    stringList(c.artifacts)
    if (!c.tools.length && !c.cells.length && !c.artifacts.length)
      throw new Error('Empty prerequisite cell')
    if (
      c.tools.some((name) => !Object.hasOwn(selections, name)) ||
      c.cells.some((name) => !Object.hasOwn(cells, name)) ||
      c.artifacts.some((name) => !artifactIds.has(name))
    )
      throw new Error('Unknown prerequisite')
  }
  const visiting = new Set<string>(),
    visited = new Set<string>()
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('Cyclic cell prerequisites')
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of (cells[id] as { cells: string[] }).cells)
      visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  Object.keys(cells).forEach(visit)
  return structuredClone(value) as BootstrapSelectionManifest
}

export function parseBootstrapArgs(argv: readonly string[]): BootstrapRequest {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index],
      value = argv[index + 1]
    if (
      !['--manifest', '--require', '--evidence-dir'].includes(key) ||
      values.has(key) ||
      !value ||
      value.startsWith('--')
    )
      throw new Error(
        'Expected --manifest, --require and --evidence-dir exactly once',
      )
    values.set(key, value)
  }
  if (values.size !== 3) throw new Error('Missing bootstrap arguments')
  const requiredCells = values.get('--require')!.split(',')
  if (
    requiredCells.some((name) => !/^[a-z][a-z0-9-]*$/.test(name)) ||
    new Set(requiredCells).size !== requiredCells.length
  )
    throw new Error('Invalid or empty required cells')
  return {
    manifestPath: values.get('--manifest')!,
    evidenceDir: values.get('--evidence-dir')!,
    requiredCells,
  }
}

export function captureBootstrapEnvironment(
  env: NodeJS.ProcessEnv,
): BootstrapEnvironment {
  return Object.freeze(
    Object.fromEntries(
      [
        'PATH',
        'PATHEXT',
        'BODY_BUN',
        'BODY_EVIDENCE',
        'BODY_TOOLCHAIN_MANIFEST',
      ].flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]])),
    ),
  )
}

/** Owned, bounded version probe; this cooperative group is not native containment. */
export async function runBootstrapProbe(
  request: ProbeRequest,
): Promise<ProbeReceipt> {
  const startedAtUtc = new Date().toISOString(),
    start = performance.now()
  const expiresAtMs = start + request.timeoutMs
  const result: ProbeReceipt = {
    argv: [...request.argv],
    cwd: request.cwd,
    environment: { ...request.env },
    startedAtUtc,
    finishedAtUtc: startedAtUtc,
    elapsedMs: 0,
    pid: null,
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    outputLimitExceeded: false,
    aborted: request.signal?.aborted ?? false,
    error: null,
    cleanup: null,
  }
  if (result.aborted)
    return { ...result, error: 'Probe cancelled before dispatch' }
  let stdoutSeenBytes = 0,
    stderrSeenBytes = 0,
    retainedBytes = 0
  let stdoutDrained = false,
    stderrDrained = false
  const chunks: Record<'stdout' | 'stderr', Buffer[]> = {
    stdout: [],
    stderr: [],
  }
  let publish!: (cleanup: CleanupResult) => void
  const completed = new Promise<CleanupResult>((resolveCleanup) => {
    publish = resolveCleanup
  })
  const detached = process.platform === 'linux'
  let child
  try {
    child = spawn(request.argv[0], [...request.argv.slice(1)], {
      cwd: request.cwd,
      env: request.env,
      detached,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    return {
      ...result,
      error: errorText(error),
      finishedAtUtc: new Date().toISOString(),
      elapsedMs: performance.now() - start,
    }
  }
  result.pid = child.pid ?? null
  const scope = createNodeProcessScope(child, {
    detached,
    originalDeadline: {
      kind: 'finite',
      domainId: 'process-monotonic',
      limitId: randomUUID(),
      expiresAtMs,
    },
    remainingMs: () => Math.max(0, expiresAtMs - performance.now()),
    signal: request.signal,
    output: () => ({
      stdoutSeenBytes,
      stderrSeenBytes,
      retainedBytes,
      droppedBytes: stdoutSeenBytes + stderrSeenBytes - retainedBytes,
      complete: stdoutDrained && stderrDrained && !result.outputLimitExceeded,
    }),
    onCleanup: publish,
  })
  child.on('error', (error) => {
    result.error = error.message
  })
  child.on('exit', (code, signal) => {
    result.exitCode = code
    result.signal = signal
  })
  for (const name of ['stdout', 'stderr'] as const) {
    child[name].on('data', (chunk: Buffer) => {
      if (name === 'stdout') stdoutSeenBytes += chunk.length
      else stderrSeenBytes += chunk.length
      const keep = Math.min(
        chunk.length,
        Math.max(0, request.maxOutputBytes - retainedBytes),
      )
      if (keep) {
        chunks[name].push(Buffer.from(chunk.subarray(0, keep)))
        retainedBytes += keep
      }
      if (keep < chunk.length && !result.outputLimitExceeded) {
        result.outputLimitExceeded = true
        void scope.requestStop('output-limit', true)
      }
    })
    child[name].on('end', () => {
      if (name === 'stdout') stdoutDrained = true
      else stderrDrained = true
    })
  }
  result.cleanup = await completed
  result.timedOut = result.cleanup.trigger === 'deadline'
  result.aborted = request.signal?.aborted ?? false
  result.stdout = Buffer.concat(chunks.stdout).toString('utf8')
  result.stderr = Buffer.concat(chunks.stderr).toString('utf8')
  result.finishedAtUtc = new Date().toISOString()
  result.elapsedMs = performance.now() - start
  return result
}

export function defaultBootstrapDependencies(
  environment: BootstrapEnvironment,
): BootstrapDependencies {
  return {
    root: resolve(import.meta.dir, '..'),
    environment,
    platform: { os: process.platform, arch: arch(), kernelRelease: release() },
    readFile: (path) => readFileSync(path),
    realpath: (path) => realpathSync(path),
    now: () => new Date().toISOString(),
    inspect: (path) => {
      const stat = statSync(path, { bigint: true })
      let executable = false
      try {
        accessSync(path, constants.X_OK)
        executable = true
      } catch {
        /* report unavailable */
      }
      return {
        isFile: stat.isFile(),
        executable,
        byteLength: Number(stat.size),
        mode: Number(stat.mode),
        device: String(stat.dev),
        inode: String(stat.ino),
      }
    },
    probe: runBootstrapProbe,
    makeEvidenceDirectory: (path) => {
      mkdirSync(resolve(path, '..'), { recursive: true })
      mkdirSync(path)
    },
    writeEvidence: (path, value) =>
      writeFileSync(path, JSON.stringify(value, null, 2) + '\n', {
        flag: 'wx',
      }),
  }
}

function observeFile(
  path: string,
  expectedSha256: string | null,
  deps: BootstrapDependencies,
): FileObservation {
  try {
    const absolute = resolve(deps.root, path),
      info = deps.inspect(absolute)
    return {
      path,
      expectedSha256,
      sha256: info.isFile ? hash(deps.readFile(absolute)) : null,
      present: true,
      isFile: info.isFile,
      byteLength: info.byteLength,
      executable: info.executable,
      mode: info.mode,
      device: info.device,
      inode: info.inode,
      error: info.isFile ? null : 'Not a regular file',
    }
  } catch (error) {
    return {
      path,
      expectedSha256,
      sha256: null,
      present: false,
      isFile: null,
      byteLength: null,
      executable: null,
      mode: null,
      device: null,
      inode: null,
      error: errorText(error),
    }
  }
}
function toolFileFailure(
  file: FileObservation,
  before: FileObservation,
): string | null {
  if (!file.present) return `Executable is missing or unreadable: ${file.error}`
  if (!file.isFile) return 'Executable is not a regular file'
  if (!file.executable) return 'Executable is nonexecutable'
  if (!file.expectedSha256 || file.sha256 !== file.expectedSha256)
    return 'Executable checksum changed or mismatched'
  if (
    file.sha256 !== before.sha256 ||
    file.byteLength !== before.byteLength ||
    file.mode !== before.mode ||
    file.device !== before.device ||
    file.inode !== before.inode
  )
    return 'Executable file identity or mode changed'
  return null
}
function resolveTool(
  selector: Selector,
  deps: BootstrapDependencies,
): string | null {
  if (selector.kind === 'absolute-path') return selector.path
  const names =
    deps.platform.os === 'win32'
      ? [
          selector.name,
          ...(deps.environment.PATHEXT ?? '.EXE;.CMD;.BAT')
            .split(';')
            .map((ext) => selector.name + ext),
        ]
      : [selector.name]
  for (const directory of (deps.environment.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)) {
    if (!isAbsolute(directory)) continue
    for (const name of names) {
      const path = join(directory, name)
      try {
        if (deps.inspect(path).isFile) return path
      } catch {
        /* next PATH entry */
      }
    }
  }
  return null
}
function actualVersion(id: ToolId, output: string): string | null {
  const patterns = {
    bun: /^(\d+\.\d+\.\d+)$/,
    node: /^v(\d+\.\d+\.\d+)$/,
    cargo: /^cargo (\d+\.\d+\.\d+)(?: [^\n]*)?$/,
    rustc: /^rustc (\d+\.\d+\.\d+)(?: [^\n]*)?$/,
    bwrap: /^bubblewrap (\d+\.\d+\.\d+)$/,
  }
  if (id === 'rustc') {
    const lines = output.trim().split('\n'),
      version = lines[0].match(patterns.rustc)?.[1] ?? null
    return lines.includes(`release: ${version}`) ? version : null
  }
  return output.trim().match(patterns[id])?.[1] ?? null
}
function pointer(value: unknown, jsonPointer: string): unknown {
  let current = value
  for (const component of jsonPointer.slice(1).split('/')) {
    const key = component.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key))
      throw new Error('Missing version constraint')
    current = (current as Record<string, unknown>)[key]
  }
  return current
}
function satisfiesMinimum(version: string, constraint: unknown): boolean {
  if (typeof constraint !== 'string' || !/^>=\d+\.\d+\.\d+$/.test(constraint))
    throw new Error('Unsupported SDK minimum version expression')
  const expected = constraint.slice(2).split('.').map(Number),
    actual = version.split('.').map(Number)
  for (let index = 0; index < 3; index++) {
    if (actual[index] !== expected[index])
      return actual[index] > expected[index]
  }
  return true
}

export async function verifyBootstrap(
  value: unknown,
  request: BootstrapRequest,
  deps: BootstrapDependencies,
  signal?: AbortSignal,
) {
  const startedAtUtc = deps.now(),
    manifestPath = resolve(deps.root, request.manifestPath),
    evidenceDir = resolve(deps.root, request.evidenceDir)
  const observations: ToolObservation[] = [],
    findings: string[] = []
  const cells: Record<
    string,
    {
      state: 'available' | 'unavailable'
      boundary: 'bootstrap-prerequisites'
      reasons: string[]
    }
  > = {}
  let manifest: BootstrapSelectionManifest | null = null,
    exitCode: 0 | 1 | 2 = 0
  let inputsBefore: FileObservation[] = [],
    inputsAfter: FileObservation[] = []
  let artifactsBefore: FileObservation[] = [],
    artifactsAfter: FileObservation[] = []
  const manifestBefore = observeFile(manifestPath, null, deps)
  try {
    const manifestBytes = deps.readFile(manifestPath)
    if (
      hash(manifestBytes) !== manifestBefore.sha256 ||
      !isDeepStrictEqual(JSON.parse(manifestBytes.toString('utf8')), value)
    )
      throw new Error('Parsed policy differs from the sealed input manifest')
    manifest = validateBootstrapManifest(value)
    stringList(request.requiredCells)
    if (
      !request.requiredCells.length ||
      request.requiredCells.some((id) => !Object.hasOwn(manifest!.cells, id))
    )
      throw new Error('Unknown or empty required cells')
    for (const [key, path] of [
      ['BODY_TOOLCHAIN_MANIFEST', manifestPath],
      ['BODY_EVIDENCE', evidenceDir],
    ] as const) {
      const configured = deps.environment[key]
      if (configured !== undefined && resolve(deps.root, configured) !== path)
        throw new Error(`${key} conflicts with explicit arguments`)
    }
    const seals = [
      ...Object.values(manifest.inputs).flat(),
      ...Object.values(manifest.tools).flatMap((t) =>
        [t.selectionEvidence, t.versionConstraintSource?.file].filter(
          (entry): entry is FileSeal => !!entry,
        ),
      ),
      ...manifest.artifacts.flatMap((a) =>
        a.buildReceipt ? [a.buildReceipt] : [],
      ),
      ...manifest.capabilities.flatMap((c) => (c.proof ? [c.proof] : [])),
    ]
    const expected = new Map<string, string>()
    for (const entry of seals) {
      if (expected.has(entry.path) && expected.get(entry.path) !== entry.sha256)
        throw new Error('Conflicting input seals')
      expected.set(entry.path, entry.sha256)
    }
    inputsBefore = [...expected].map(([path, digest]) =>
      observeFile(path, digest, deps),
    )
    artifactsBefore = manifest.artifacts.map((a) =>
      observeFile(a.path, a.sha256, deps),
    )
    for (const file of inputsBefore)
      if (file.sha256 !== file.expectedSha256)
        findings.push(`Frozen input unavailable or mismatched: ${file.path}`)
    if (!manifestBefore.present) findings.push('Input manifest is unavailable')
    const required = new Set<ToolId>(),
      collected = new Set<string>()
    const collect = (id: string) => {
      if (collected.has(id)) return
      collected.add(id)
      for (const tool of manifest!.cells[id].tools) required.add(tool)
      manifest!.cells[id].cells.forEach(collect)
    }
    request.requiredCells.forEach(collect)
    for (const [id, selection] of Object.entries(manifest.tools) as [
      ToolId,
      ToolSelection,
    ][]) {
      const row: ToolObservation = {
        id,
        state: 'unavailable',
        reason: 'Not requested',
        expectedVersion: selection.expectedVersion,
        version: null,
        selectedPath: null,
        resolvedPath: null,
        before: null,
        after: null,
        final: null,
        command: null,
      }
      observations.push(row)
      if (!required.has(id)) continue
      if (findings.length) {
        row.reason = 'Frozen shared inputs failed; no probe dispatched'
        continue
      }
      try {
        row.selectedPath = resolveTool(selection.selector, deps)
        if (!row.selectedPath)
          throw new Error('Executable not found on captured PATH')
        row.resolvedPath = deps.realpath(row.selectedPath)
        const digest =
          selection.expectedSha256ByHost[
            `${deps.platform.os}-${deps.platform.arch}`
          ] ?? null
        row.before = observeFile(row.resolvedPath, digest, deps)
        if (!row.before.present || !row.before.isFile || !row.before.executable)
          throw new Error('Tool is missing or nonexecutable')
        if (
          id === 'bun' &&
          deps.environment.BODY_BUN &&
          deps.realpath(resolve(deps.root, deps.environment.BODY_BUN)) !==
            row.resolvedPath
        )
          throw new Error(
            'BODY_BUN differs from selected actual Bun executable',
          )
        // A mismatched or unpinned binary receives no dispatch authority. Its bytes are still retained.
        if (
          !digest ||
          row.before.sha256 !== digest ||
          !selection.expectedVersion
        )
          throw new Error(
            'Selected executable checksum/version is unavailable or mismatched',
          )
        const env: Record<string, string> = {
          LANG: 'C',
          LC_ALL: 'C',
          RUSTUP_AUTO_INSTALL: '0',
          ...(deps.environment.PATH ? { PATH: deps.environment.PATH } : {}),
          BODY_TOOLCHAIN_MANIFEST: manifestPath,
          BODY_EVIDENCE: evidenceDir,
        }
        if (deps.environment.BODY_BUN) env.BODY_BUN = deps.environment.BODY_BUN
        row.command = await deps.probe({
          argv: [row.resolvedPath, id === 'rustc' ? '-vV' : '--version'],
          cwd: deps.root,
          env,
          timeoutMs: 10_000,
          maxOutputBytes: 65_536,
          signal,
        })
        row.after = observeFile(row.resolvedPath, digest, deps)
        const afterFailure = toolFileFailure(row.after, row.before)
        if (afterFailure) throw new Error(`Post-probe: ${afterFailure}`)
        if (
          resolveTool(selection.selector, deps) !== row.selectedPath ||
          deps.realpath(row.selectedPath) !== row.resolvedPath
        )
          throw new Error('Executable changed during probe')
        const cmd = row.command
        if (
          cmd.exitCode !== 0 ||
          cmd.error ||
          cmd.timedOut ||
          cmd.aborted ||
          cmd.outputLimitExceeded ||
          !cmd.cleanup ||
          cmd.cleanup.status !== 'complete' ||
          !cmd.cleanup.output.complete ||
          !cmd.cleanup.satisfiesSelectedTier ||
          cmd.cleanup.selectedLimitSatisfied === false ||
          cmd.elapsedMs > 10_000
        )
          throw new Error(
            'Version probe failed, cancelled, undrained or cleanup-incomplete',
          )
        row.version = actualVersion(id, cmd.stdout)
        if (row.version !== selection.expectedVersion)
          throw new Error(
            `Version mismatch: expected ${selection.expectedVersion}, observed ${row.version ?? 'unparseable'}`,
          )
        if (selection.versionConstraintSource) {
          const source = selection.versionConstraintSource
          if (
            !satisfiesMinimum(
              row.version,
              pointer(
                JSON.parse(
                  deps
                    .readFile(resolve(deps.root, source.file.path))
                    .toString('utf8'),
                ),
                source.jsonPointer,
              ),
            )
          )
            throw new Error('Selected version is below SDK minimum')
        }
        row.state = 'available'
        row.reason = null
      } catch (error) {
        row.reason = errorText(error)
      }
    }
    inputsAfter = [...expected].map(([path, digest]) =>
      observeFile(path, digest, deps),
    )
    artifactsAfter = manifest.artifacts.map((a) =>
      observeFile(a.path, a.sha256, deps),
    )
    for (let index = 0; index < inputsAfter.length; index++) {
      const file = inputsAfter[index]
      if (
        file.sha256 !== file.expectedSha256 ||
        file.sha256 !== inputsBefore[index].sha256
      )
        findings.push(`Frozen input drift: ${file.path}`)
    }
    for (let index = 0; index < artifactsAfter.length; index++)
      if (artifactsAfter[index].sha256 !== artifactsBefore[index].sha256)
        findings.push(`Artifact drift: ${artifactsAfter[index].path}`)
    if (signal?.aborted) findings.push('Bootstrap request cancelled')
    const artifactBound = (
      artifact: BootstrapSelectionManifest['artifacts'][number],
    ) => {
      if (
        !artifact.buildReceipt ||
        !artifact.sha256 ||
        artifact.boundary === 'isolated-installed'
      )
        return false
      try {
        // Only producer receipts explicitly binding this artifact to every frozen source can supply build-byte provenance.
        // This does not certify an isolated installation or native enforcement behavior.
        const proof = JSON.parse(
          deps
            .readFile(resolve(deps.root, artifact.buildReceipt.path))
            .toString('utf8'),
        )
        return (
          proof.schemaVersion === 1 &&
          proof.type === 'body-bootstrap-artifact-build' &&
          proof.exitCode === 0 &&
          proof.artifact?.sha256 === artifact.sha256 &&
          resolve(deps.root, proof.artifact?.path ?? '') ===
            resolve(deps.root, artifact.path) &&
          manifest!.inputs.sources.every(
            (source) =>
              proof.sourceContractHashes?.[source.path] === source.sha256,
          ) &&
          [
            ...manifest!.inputs.packages,
            ...manifest!.inputs.locks,
            ...manifest!.inputs.configuration,
          ].every(
            (context) =>
              proof.contextContractHashes?.[context.path] === context.sha256,
          )
        )
      } catch {
        return false
      }
    }
    // Later probes can change earlier tools. Sample every selected alias and
    // canonical file again before computing readiness, without upgrading failures.
    for (const row of observations) {
      if (!row.selectedPath || !row.resolvedPath || !row.before) continue
      const selection = manifest.tools[row.id]!
      row.final = {
        selectedPath: null,
        resolvedPath: null,
        alias: observeFile(row.selectedPath, row.before.expectedSha256, deps),
        canonical: observeFile(
          row.resolvedPath,
          row.before.expectedSha256,
          deps,
        ),
        bodyBun:
          row.id === 'bun' && deps.environment.BODY_BUN
            ? {
                path: resolve(deps.root, deps.environment.BODY_BUN),
                resolvedPath: null,
                file: observeFile(
                  resolve(deps.root, deps.environment.BODY_BUN),
                  row.before.expectedSha256,
                  deps,
                ),
              }
            : null,
        reason: null,
      }
      try {
        row.final.selectedPath = resolveTool(selection.selector, deps)
        row.final.resolvedPath = deps.realpath(row.selectedPath)
        const failure =
          toolFileFailure(row.final.canonical!, row.before) ??
          toolFileFailure(row.final.alias!, row.before)
        if (failure) throw new Error(failure)
        if (
          row.final.selectedPath !== row.selectedPath ||
          row.final.resolvedPath !== row.resolvedPath
        )
          throw new Error('Selected executable alias or canonical path changed')
        if (row.final.bodyBun) {
          row.final.bodyBun.resolvedPath = deps.realpath(row.final.bodyBun.path)
          const bodyBunFailure = toolFileFailure(
            row.final.bodyBun.file,
            row.before,
          )
          if (bodyBunFailure) throw new Error(`BODY_BUN: ${bodyBunFailure}`)
          if (row.final.bodyBun.resolvedPath !== row.resolvedPath)
            throw new Error(
              'BODY_BUN differs from selected actual Bun executable',
            )
        }
      } catch (error) {
        row.final.reason = `Final sweep: ${errorText(error)}`
        if (row.state === 'available') {
          row.state = 'unavailable'
          row.reason = row.final.reason
        }
      }
    }
    const resolveCell = (id: string): (typeof cells)[string] => {
      if (Object.hasOwn(cells, id)) return cells[id]
      const definition = manifest!.cells[id],
        reasons: string[] = []
      if (
        definition.platform !== 'any' &&
        definition.platform !== deps.platform.os
      )
        reasons.push('Host platform unavailable')
      for (const tool of definition.tools) {
        const row = observations.find((t) => t.id === tool)!
        if (row.state !== 'available') reasons.push(`${tool}: ${row.reason}`)
      }
      for (const child of definition.cells)
        if (resolveCell(child).state !== 'available')
          reasons.push(`Prerequisite cell unavailable: ${child}`)
      for (const artifactId of definition.artifacts) {
        const a = manifest!.artifacts.find((entry) => entry.id === artifactId)!,
          observed = artifactsAfter[manifest!.artifacts.indexOf(a)]
        if (
          !artifactBound(a) ||
          observed.sha256 !== a.sha256 ||
          (a.executable && !observed.executable)
        )
          reasons.push(`Artifact boundary unverified: ${artifactId}`)
      }
      return (cells[id] = {
        state: reasons.length || findings.length ? 'unavailable' : 'available',
        boundary: 'bootstrap-prerequisites',
        reasons,
      })
    }
    Object.keys(manifest.cells).forEach(resolveCell)
    if (
      request.requiredCells.some((id) => cells[id].state !== 'available') ||
      findings.length
    )
      exitCode = 1
  } catch (error) {
    exitCode = 2
    findings.push(errorText(error))
  }
  const manifestAfter = observeFile(manifestPath, manifestBefore.sha256, deps)
  if (manifestBefore.sha256 !== manifestAfter.sha256) {
    findings.push('Selection manifest changed during verification')
    if (exitCode === 0) exitCode = 1
  }
  const observed = {
    schemaVersion: 1,
    type: 'body-bootstrap-observed-toolchain',
    platform: deps.platform,
    selectionManifest: manifestBefore,
    selectionManifestAfter: manifestAfter,
    inputsBefore,
    inputsAfter,
    artifactsBefore,
    artifactsAfter,
    tools: observations,
    cells,
    capabilities: (manifest?.capabilities ?? []).map((c) => ({
      ...c,
      declaredState: c.state,
      state: 'unavailable',
      reason:
        'Bootstrap checks prerequisites, not native enforcement or installed consumer behavior',
    })),
  }
  const observedBytes = Buffer.from(JSON.stringify(observed, null, 2) + '\n')
  const receipt = {
    schemaVersion: 1,
    type: 'body-bootstrap-verification',
    startedAtUtc,
    finishedAtUtc: deps.now(),
    repositoryRoot: deps.root,
    manifest: { path: manifestPath, sha256: manifestBefore.sha256 },
    observedManifest: {
      path: join(evidenceDir, 'toolchain-manifest.observed.json'),
      sha256: hash(observedBytes),
    },
    requiredCells: [...request.requiredCells],
    cells,
    findings,
    exitCode,
    acquisitionExecuted: false,
    offlineVerification: true,
    offlineBoundary:
      'No install/fetch/build command; no OS network fence claimed',
    nativeEnforcementApproved: false,
    B32Accepted: false,
    B21Accepted: false,
    limitations: [
      'Executable hash checks and numeric process identity checks are cooperative, not atomic OS fencing.',
      'Checkout artifacts and version probes supply no isolated-installed or native enforcement assurance.',
    ],
  }
  deps.makeEvidenceDirectory(evidenceDir)
  deps.writeEvidence(
    join(evidenceDir, 'toolchain-manifest.observed.json'),
    observed,
  )
  deps.writeEvidence(join(evidenceDir, 'receipt.json'), receipt)
  return { exitCode, receipt, observed }
}

export async function main(
  argv: readonly string[],
  deps: BootstrapDependencies,
): Promise<number> {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log(
      'Usage: body-bootstrap.ts --manifest <file> --require <cell,...> --evidence-dir <new-directory>\nVerification only; no acquisition or native enforcement approval.',
    )
    return 0
  }
  try {
    const request = parseBootstrapArgs(argv)
    let manifest: unknown
    try {
      manifest = JSON.parse(
        deps
          .readFile(resolve(deps.root, request.manifestPath))
          .toString('utf8'),
      )
    } catch {
      manifest = null
    }
    const controller = new AbortController(),
      cancel = () => controller.abort(new Error('Bootstrap cancelled'))
    process.once('SIGINT', cancel)
    process.once('SIGTERM', cancel)
    try {
      const result = await verifyBootstrap(
        manifest,
        request,
        deps,
        controller.signal,
      )
      console.log(
        JSON.stringify({
          exitCode: result.exitCode,
          receipt: join(
            resolve(deps.root, request.evidenceDir),
            'receipt.json',
          ),
        }),
      )
      return result.exitCode
    } finally {
      process.removeListener('SIGINT', cancel)
      process.removeListener('SIGTERM', cancel)
    }
  } catch (error) {
    console.error(errorText(error))
    return 2
  }
}
if (import.meta.main)
  process.exitCode = await main(
    process.argv.slice(2),
    defaultBootstrapDependencies(captureBootstrapEnvironment(process.env)),
  )
