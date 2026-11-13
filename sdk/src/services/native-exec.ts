import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isExecutionDeadlineSignal } from '@codebuff/common/util/execution-context'

import type { ChildProcess } from 'node:child_process'
import type {
  Clock,
  LaunchFacts,
  PolicyProfile,
  Refusal,
  Result,
} from '@codebuff/common/types/contracts/execution-context'
import type { NativeLaunchObserver } from '@codebuff/common/types/contracts/native-execution'
import type {
  CleanupResult,
  OwnedProcessScope,
  ScopeObservation,
  ScopeOutput,
  StopReason,
} from '@codebuff/common/types/contracts/process-scope'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type {
  AdmittedNodeLaunch,
  NodeDispatchHandle,
  NodeDispatchResult,
} from './execution-launch'

const EXEC_PROTOCOL = 'openbuff.exec.v1'
const FRAME_LIMIT = 64 * 1024
const PLAN_LIMIT = 1024 * 1024
const CLEANUP_VERSION = 'openbuff.cleanup.v1:200:200:1000:200'
const CLEANUP_LIMITS = Object.freeze({
  termGraceMs: 200,
  killReapGraceMs: 200,
  joinGraceMs: 1000,
  reportGraceMs: 200,
})
export const NATIVE_FILTER_SHA256 =
  '9dd8d9f9dff7061c7678ef8a7c73187c0bd95b23b845f5a33643c2f9610418b1'
export function nativeFilterSha256(network: 'deny' | 'inherit'): string {
  return network === 'deny'
    ? NATIVE_FILTER_SHA256
    : 'e37993f735cb14741f6323ca75ec941189dfbb26e301796f0799858b80799bf7'
}
const TRUST_BOUNDARY =
  'Trusted host installation; concurrent hostile same-inode writers are outside this boundary. Post-spawn validation does not prevent artifact instructions executing beforehand.'
const digest = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex')
const refuse = (reason: Refusal['reason'], cause: string): Refusal =>
  Object.freeze({ ok: false, reason, cause })

export type NativeArtifactIdentity = Readonly<{
  path: string
  sha256: string
  platform: 'linux-x64-gnu'
  crateVersion: string
  workspaceProtocol: string
}>
export type NativeToolIdentity = Readonly<{ path: string; sha256: string }>
type OpenIdentity = Readonly<{
  dev: bigint
  ino: bigint
  size: bigint
  mode: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}>
type InstallationState = {
  fd: number
  artifact: NativeArtifactIdentity
  bwrap: NativeToolIdentity
  selected: OpenIdentity
  closed: boolean
  fdClosed: boolean
  leases: number
}
const installations = new WeakMap<object, InstallationState>()

/** A private in-process registration, not an identity accepted from wire JSON. */
export interface VerifiedNativeInstallation {
  readonly artifact: NativeArtifactIdentity
  readonly bwrap: NativeToolIdentity
  readonly trustBoundary: string
  close(): void
}

function identity(fd: number): OpenIdentity {
  const stat = fs.fstatSync(fd, { bigint: true })
  if (!stat.isFile()) throw new Error('Native artifact is not a regular file')
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mode: stat.mode,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  })
}
function sameIdentity(a: OpenIdentity, b: OpenIdentity): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mode === b.mode &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  )
}
function sameGeneration(a: OpenIdentity, b: OpenIdentity): boolean {
  // Rename/unlink legitimately changes ctime/link metadata. Complete read
  // stability still compares ctime; held-generation checks bind inode/bytes.
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mode === b.mode &&
    a.mtimeNs === b.mtimeNs
  )
}
function completeDescriptor(
  fd: number,
): Readonly<{ identity: OpenIdentity; sha256: string }> {
  const before = identity(fd)
  if (
    before.size <= 0n ||
    before.size > 32n * 1024n * 1024n ||
    (before.mode & 0o111n) === 0n
  )
    throw new Error('Native artifact is empty, oversized or nonexecutable')
  const bytes = Buffer.alloc(Number(before.size))
  let read = 0
  while (read < bytes.length) {
    const count = fs.readSync(fd, bytes, read, bytes.length - read, read)
    if (count <= 0) throw new Error('Incomplete native descriptor hash')
    read += count
  }
  if (
    !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    !sameIdentity(before, identity(fd))
  )
    throw new Error('Native ELF descriptor changed during verification')
  return { identity: before, sha256: digest(bytes) }
}
function verifyOpenFile(
  filePath: string,
  sha256: string,
): Readonly<{ fd: number; selected: OpenIdentity }> {
  if (!path.isAbsolute(filePath) || !/^[a-f0-9]{64}$/.test(sha256))
    throw new Error('Native file requires an absolute path and trusted SHA256')
  const fd = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  )
  try {
    const checked = completeDescriptor(fd)
    if (checked.sha256 !== sha256)
      throw new Error('Native executable checksum mismatch')
    return { fd, selected: checked.identity }
  } catch (error) {
    fs.closeSync(fd)
    throw error
  }
}
function stateFor(installation: VerifiedNativeInstallation): InstallationState {
  const state = installations.get(installation)
  if (!state || state.closed)
    throw new Error('Native installation registration is missing or closed')
  return verifyHeldState(state)
}
function verifyHeldState(state: InstallationState): InstallationState {
  if (state.fdClosed)
    throw new Error('Native held installation descriptor is closed')
  const checked = completeDescriptor(state.fd)
  if (
    !sameGeneration(state.selected, checked.identity) ||
    checked.sha256 !== state.artifact.sha256
  )
    throw new Error('Selected native artifact generation drifted')
  return state
}
function retainInstallation(installation: VerifiedNativeInstallation) {
  const state = stateFor(installation)
  state.leases++
  let active = true
  return Object.freeze({
    verify() {
      if (!active)
        throw new Error('Native dispatch installation lease is closed')
      return verifyHeldState(state)
    },
    release() {
      if (!active) return
      active = false
      state.leases--
      if (state.closed && state.leases === 0 && !state.fdClosed) {
        state.fdClosed = true
        fs.closeSync(state.fd)
      }
    },
  })
}

export function verifyNativeInstallation(
  options: Readonly<{
    artifact: NativeArtifactIdentity
    bwrap: NativeToolIdentity
  }>,
): Result<VerifiedNativeInstallation> {
  if (
    process.platform !== 'linux' ||
    process.arch !== 'x64' ||
    options.artifact.platform !== 'linux-x64-gnu'
  )
    return refuse(
      'unavailable',
      'Native enforcement is unavailable on this platform cell',
    )
  let artifactFd: number | undefined
  try {
    const artifact = Object.freeze({ ...options.artifact })
    const bwrap = Object.freeze({ ...options.bwrap })
    if (artifact.workspaceProtocol !== '1' || artifact.crateVersion !== '0.1.0')
      throw new Error('Native build/workspace protocol pin is unsupported')
    const opened = verifyOpenFile(artifact.path, artifact.sha256)
    artifactFd = opened.fd
    const tool = verifyOpenFile(bwrap.path, bwrap.sha256)
    fs.closeSync(tool.fd)
    const installation: VerifiedNativeInstallation = Object.freeze({
      artifact,
      bwrap,
      trustBoundary: TRUST_BOUNDARY,
      close() {
        if (this !== installation) return
        const state = installations.get(installation)!
        if (!state.closed) {
          state.closed = true
          if (state.leases === 0 && !state.fdClosed) {
            state.fdClosed = true
            fs.closeSync(state.fd)
          }
        }
      },
    })
    installations.set(installation, {
      fd: opened.fd,
      artifact,
      bwrap,
      selected: opened.selected,
      closed: false,
      fdClosed: false,
      leases: 0,
    })
    return { ok: true, value: installation }
  } catch (error) {
    if (artifactFd !== undefined) fs.closeSync(artifactFd)
    return refuse(
      'unavailable',
      error instanceof Error
        ? error.message
        : 'Native installation verification failed',
    )
  }
}

export type NativeClockMapping = Readonly<{
  domainId: string
  hostSendMs: number
  hostReceiveMs: number
  nativeSampleNs: string
}>
const mappings = new WeakMap<
  object,
  Readonly<{ installation: VerifiedNativeInstallation; clock: Clock }>
>()
export type NativeCalibrationSetup = (
  heldArtifactFd: number,
) => Result<ChildProcess>
export type NativeCalibrationRefusal = Refusal &
  Readonly<{
    cleanupPending: boolean
    setupPid: number | null
    cleanupAuthority: 'original-host-setup-owner'
  }>
export type NativeCalibrationResult =
  | Result<NativeClockMapping>
  | NativeCalibrationRefusal

/** Called under a separately owned host-setup budget, never a new action limit. */
export async function calibrateNativeClock(
  installation: VerifiedNativeInstallation,
  clock: Clock,
  setup: NativeCalibrationSetup,
  signal?: AbortSignal,
): Promise<NativeCalibrationResult> {
  if (signal?.aborted)
    return refuse(
      isExecutionDeadlineSignal(signal) ? 'deadline-exhausted' : 'cancelled',
      isExecutionDeadlineSignal(signal)
        ? 'Native original calibration deadline exhausted'
        : 'Native calibration setup was cancelled',
    )
  let state: InstallationState
  try {
    state = stateFor(installation)
  } catch (error) {
    return refuse('unavailable', String(error))
  }
  const hostSendMs = clock.nowMs()
  if (!Number.isFinite(hostSendMs))
    return refuse('unavailable', 'Host monotonic clock sample is invalid')
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      const dispatched = setup(state.fd)
      if (!dispatched.ok) {
        resolve(dispatched)
        return
      }
      child = dispatched.value
    } catch (error) {
      resolve(refuse('unavailable', String(error)))
      return
    }
    const output: Buffer[] = []
    let size = 0,
      settled = false,
      closeObserved = false
    let failure: Refusal | undefined
    const finishFailure = (
      cause: string,
      reason: Refusal['reason'] = 'unavailable',
    ) => {
      const observedReason = signal?.aborted
        ? isExecutionDeadlineSignal(signal)
          ? 'deadline-exhausted'
          : 'cancelled'
        : reason
      failure ??= refuse(observedReason, cause)
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      try {
        child.kill('SIGKILL')
      } catch {
        /* Original setup owner retains cleanup. */
      }
      resolve(
        Object.freeze({
          ...failure,
          cleanupPending: !closeObserved && child.pid !== undefined,
          setupPid: child.pid ?? null,
          cleanupAuthority: 'original-host-setup-owner' as const,
        }),
      )
    }
    const abort = () => {
      const deadline = signal !== undefined && isExecutionDeadlineSignal(signal)
      finishFailure(
        deadline
          ? 'Native original calibration deadline exhausted'
          : 'Native calibration cancelled',
        deadline ? 'deadline-exhausted' : 'cancelled',
      )
    }
    const timer = setTimeout(() => {
      finishFailure('Native calibration setup timeout')
    }, 2000)
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout?.on('data', (bytes: Buffer) => {
      size += bytes.length
      if (size > FRAME_LIMIT) {
        finishFailure('Native version output bound exceeded')
      } else output.push(Buffer.from(bytes))
    })
    child.stderr?.on('data', () => {
      finishFailure('Native version probe wrote unexpected stderr')
    })
    child.once('error', (error) => {
      finishFailure(error.message)
    })
    child.once('close', (code) => {
      closeObserved = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (settled) return
      if (signal?.aborted) {
        finishFailure(
          'Native calibration closed during original setup cancellation',
        )
        return
      }
      if (failure || code !== 0) {
        finishFailure(
          failure?.cause ?? 'Native version probe failed',
          failure?.reason,
        )
        return
      }
      try {
        const hostReceiveMs = clock.nowMs()
        const report = parseNativeJson(Buffer.concat(output))
        if (
          !Number.isFinite(hostReceiveMs) ||
          hostReceiveMs < hostSendMs ||
          hostReceiveMs - hostSendMs > 2000 ||
          report.execProtocol !== EXEC_PROTOCOL ||
          report.workspaceProtocol !== state.artifact.workspaceProtocol ||
          report.crateVersion !== state.artifact.crateVersion ||
          report.platform !== state.artifact.platform ||
          typeof report.monotonicNs !== 'string' ||
          !/^[0-9]+$/.test(report.monotonicNs)
        )
          throw new Error('Native protocol/build/clock calibration mismatch')
        stateFor(installation)
        const mapping = Object.freeze({
          domainId: clock.domainId,
          hostSendMs,
          hostReceiveMs,
          nativeSampleNs: report.monotonicNs,
        })
        mappings.set(mapping, { installation, clock })
        settled = true
        resolve({ ok: true, value: mapping })
      } catch (error) {
        finishFailure(String(error))
      }
    })
    if (signal?.aborted) abort()
  })
}

/** Earlier offset bound: native sample minus host RECEIVE, never a fresh limit. */
export function nativeExpiryNs(
  mapping: NativeClockMapping,
  installation: VerifiedNativeInstallation,
  clock: Clock,
  expiresAtMs: number,
): Result<string> {
  try {
    stateFor(installation)
  } catch (error) {
    return refuse('unavailable', String(error))
  }
  const registration = mappings.get(mapping)
  if (
    !registration ||
    registration.clock !== clock ||
    registration.installation !== installation ||
    mapping.domainId !== clock.domainId ||
    !Number.isFinite(expiresAtMs)
  )
    return refuse(
      'unavailable',
      'Native clock mapping is not registered for this host clock/installation',
    )
  const now = clock.nowMs()
  if (
    !Number.isFinite(now) ||
    now < mapping.hostReceiveMs ||
    expiresAtMs <= now
  )
    return refuse(
      'deadline-exhausted',
      'Original native action expiry is exhausted or host clock is nonmonotonic',
    )
  const delta = Math.floor((expiresAtMs - mapping.hostReceiveMs) * 1_000_000)
  if (!Number.isSafeInteger(delta))
    return refuse(
      'unavailable',
      'Native expiry conversion is outside the calibrated numeric range',
    )
  const expiry = BigInt(mapping.nativeSampleNs) + BigInt(delta)
  return expiry > 0n
    ? { ok: true, value: expiry.toString() }
    : refuse('deadline-exhausted', 'Mapped native expiry is exhausted')
}

export type NativeMount = Readonly<{
  source: string
  destination: string
  write: boolean
  dev: string
  ino: string
}>
export type NativeMountPolicy = Readonly<{
  mounts: readonly NativeMount[]
  symlinks: readonly (readonly [string, string])[]
  digest: string
}>
const mountPolicies = new WeakSet<object>()

/** Trusted host captures canonical mount identities before target admission. */
export function captureNativeMountPolicy(
  options: Readonly<{
    projectRoot: string
    allowedPaths: readonly string[]
    policy: PolicyProfile
    runtimePaths: readonly string[]
  }>,
): Result<NativeMountPolicy> {
  try {
    const writable = !['read-only', 'librarian-read-only'].includes(
      options.policy,
    )
    const entries = new Map<string, NativeMount>()
    const symlinks: (readonly [string, string])[] = []
    for (const [candidate, write, runtime] of [
      ...options.runtimePaths.map((p) => [p, false, true] as const),
      ...[options.projectRoot, ...options.allowedPaths].map(
        (p) => [p, writable, false] as const,
      ),
    ]) {
      if (
        !path.isAbsolute(candidate) ||
        candidate === '/' ||
        candidate === '/proc' ||
        candidate === '/dev' ||
        candidate === '/tmp' ||
        candidate.startsWith('/.openbuff')
      )
        throw new Error(
          'Native mount roster contains an invalid/root/reserved source',
        )
      const source = fs.realpathSync(candidate)
      if (!runtime && source !== candidate)
        throw new Error(
          'Workspace allow paths must be canonical; lexical symlinks do not grant external access',
        )
      const stat = fs.statSync(source, { bigint: true })
      const prior = entries.get(source)
      if (prior && prior.write !== write)
        throw new Error('Conflicting native runtime/workspace mount access')
      entries.set(
        source,
        Object.freeze({
          source,
          destination: source,
          write,
          dev: stat.dev.toString(),
          ino: stat.ino.toString(),
        }),
      )
      if (source !== candidate)
        symlinks.push(
          Object.freeze([
            path.relative(path.dirname(candidate), source),
            candidate,
          ] as const),
        )
    }
    // A writable descendant of a read-only runtime tree is an explicit grant;
    // a writable ancestor of runtime paths would broaden the captured roster.
    const mounts = Object.freeze(
      [...entries.values()].sort(
        (a, b) =>
          a.destination.length - b.destination.length ||
          a.destination.localeCompare(b.destination),
      ),
    )
    const links = Object.freeze(symlinks)
    const policy = Object.freeze({
      mounts,
      symlinks: links,
      digest: digest(JSON.stringify({ mounts, symlinks: links })),
    })
    mountPolicies.add(policy)
    return { ok: true, value: policy }
  } catch (error) {
    return refuse(
      'unavailable',
      error instanceof Error ? error.message : 'Native mount capture failed',
    )
  }
}

export function nativeAdapterOptions(
  installation: VerifiedNativeInstallation,
  mounts: NativeMountPolicy,
  selection: Readonly<{
    network: 'deny' | 'inherit'
    landlock: 'disabled' | 'optional' | 'required'
    maxRetainedOutputBytes?: number
  }> = { network: 'deny', landlock: 'optional' },
): Result<Readonly<Record<string, string>>> {
  try {
    stateFor(installation)
    if (!mountPolicies.has(mounts))
      throw new Error('Native mount policy is not host-registered')
    const outputBytes = selection.maxRetainedOutputBytes ?? 10 * 1024 * 1024
    if (
      !Number.isSafeInteger(outputBytes) ||
      outputBytes <= 0 ||
      outputBytes > 1_073_741_824
    )
      throw new Error('Native captured output quota is invalid')
    return {
      ok: true,
      value: Object.freeze({
        nativeAdapter: EXEC_PROTOCOL,
        nativeArtifactSha256: installation.artifact.sha256,
        nativePlatform: installation.artifact.platform,
        nativeBuildVersion: installation.artifact.crateVersion,
        nativeWorkspaceProtocol: installation.artifact.workspaceProtocol,
        nativeBwrapSha256: installation.bwrap.sha256,
        nativeMountDigest: mounts.digest,
        nativeFilterSha256: nativeFilterSha256(selection.network),
        nativeNetwork: selection.network,
        nativeLandlock: selection.landlock,
        nativeMaxRetainedOutputBytes: String(outputBytes),
        nativeCleanupVersion: CLEANUP_VERSION,
      }),
    }
  } catch (error) {
    return refuse('unavailable', String(error))
  }
}

export function encodeNativeFrame(value: unknown, prepare = false): Buffer {
  const body = Buffer.from(JSON.stringify(value))
  if (body.length === 0 || body.length > (prepare ? PLAN_LIMIT : FRAME_LIMIT))
    throw new Error('Native control frame exceeds its bound')
  const frame = Buffer.alloc(4 + body.length)
  frame.writeUInt32LE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

export class NativeFrameDecoder {
  private pending = Buffer.alloc(0)
  push(bytes: Buffer): readonly Record<string, unknown>[] {
    if (this.pending.length + bytes.length > PLAN_LIMIT + FRAME_LIMIT + 4)
      throw new Error('Native control input buffer bound exceeded')
    this.pending = Buffer.concat([this.pending, bytes])
    const frames: Record<string, unknown>[] = []
    while (this.pending.length >= 4) {
      const length = this.pending.readUInt32LE(0)
      if (length === 0 || length > FRAME_LIMIT)
        throw new Error('Invalid native output frame length')
      if (this.pending.length < length + 4) break
      const body = this.pending.subarray(4, length + 4)
      frames.push(parseNativeJson(body))
      this.pending = this.pending.subarray(length + 4)
      if (frames.length > 8) throw new Error('Native output frame flood')
    }
    return frames
  }
  end(): void {
    if (this.pending.length !== 0)
      throw new Error('Native EOF in partial frame')
  }
}

function parseNativeJson(bytes: Buffer): Record<string, unknown> {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  let i = 0
  const whitespace = () => {
    while (/\s/.test(text[i] ?? '') && i < text.length) i++
  }
  const string = (): string => {
    whitespace()
    const start = i
    if (text[i++] !== '"') throw new Error('Malformed native JSON string')
    while (i < text.length) {
      const char = text[i++]
      if (char === '\\') i++
      else if (char === '"') return JSON.parse(text.slice(start, i)) as string
    }
    throw new Error('Unterminated native JSON string')
  }
  const value = (depth: number): void => {
    if (depth > 64) throw new Error('Native JSON nesting bound exceeded')
    whitespace()
    if (text[i] === '{') {
      i++
      whitespace()
      const keys = new Set<string>()
      if (text[i] === '}') {
        i++
        return
      }
      for (;;) {
        const key = string()
        if (keys.has(key)) throw new Error('Duplicate native JSON field')
        keys.add(key)
        whitespace()
        if (text[i++] !== ':') throw new Error('Malformed native JSON object')
        value(depth + 1)
        whitespace()
        const end = text[i++]
        if (end === '}') return
        if (end !== ',') throw new Error('Malformed native JSON object')
      }
    }
    if (text[i] === '[') {
      i++
      whitespace()
      if (text[i] === ']') {
        i++
        return
      }
      for (;;) {
        value(depth + 1)
        whitespace()
        const end = text[i++]
        if (end === ']') return
        if (end !== ',') throw new Error('Malformed native JSON array')
      }
    }
    if (text[i] === '"') {
      string()
      return
    }
    const start = i
    while (i < text.length && !/[\s,}\]]/.test(text[i]!)) i++
    if (start === i) throw new Error('Malformed native JSON value')
    JSON.parse(text.slice(start, i))
  }
  value(0)
  whitespace()
  if (i !== text.length) throw new Error('Trailing native JSON content')
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Native control frame is not an object')
  return parsed as Record<string, unknown>
}

// Identity is created only inside the synchronous exact target dispatch. It is
// private because its plain digest covers the exact delegated environment.
export function privateNativePlanIdentity(
  planJson: string,
  artifactSha256: string,
) {
  return Object.freeze({
    planDigest: digest(planJson),
    nonce: randomUUID(),
    artifactSha256,
  })
}
import { spawn } from 'node:child_process'

export type NativeDispatchOptions = Readonly<{
  installation: VerifiedNativeInstallation
  clock: Clock
  mapping: NativeClockMapping
  mounts: NativeMountPolicy
  network: 'deny' | 'inherit'
  landlock: 'disabled' | 'optional' | 'required'
  output?: () => ScopeOutput
  spawn?: CodebuffSpawn
}>
type NativeCleanup = Readonly<{
  complete: boolean
  scopeTier: 'linux-pid-namespace' | 'direct-child'
  pidNamespace: string | null
  namespaceAbsent: boolean | null
  initAbsent: boolean | null
  outerChildReaped: boolean
  reapedPids: readonly number[]
  stopAtNs: string | null
  allChildrenReaped: boolean
  reapCount: number
  observationsTruncated: boolean
  observedAtNs: string
  originalExpiryNs: string | null
  signals: readonly Readonly<{
    signal: 'SIGTERM' | 'SIGKILL'
    pid: number
    atNs: string
    result: string
  }>[]
}>
type NativeWaiterIdentity = Readonly<{
  waiterPid: number
  waiterStartTime: string
  pidNamespace: string | null
  namespaceDepth: number | null
}>
type NativeTargetIdentity = NativeWaiterIdentity &
  Readonly<{
    targetPid: number
    targetLocalPid: number
    targetStartTime: string
  }>
const nativePid = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value > 0 &&
  value <= 2_147_483_647
const nativeStart = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9]{1,20}$/.test(value) &&
  BigInt(value) <= 18_446_744_073_709_551_615n
function parseWaiterIdentity(
  frame: Record<string, unknown>,
  scoped: boolean,
): NativeWaiterIdentity {
  if (
    !nativePid(frame.waiterPid) ||
    !nativeStart(frame.waiterStartTime) ||
    (scoped
      ? typeof frame.pidNamespace !== 'string' ||
        !/^pid:\[[0-9]+\]$/.test(frame.pidNamespace) ||
        !Number.isSafeInteger(frame.namespaceDepth) ||
        Number(frame.namespaceDepth) < 2 ||
        Number(frame.namespaceDepth) > 32
      : frame.pidNamespace !== null || frame.namespaceDepth !== null)
  )
    throw new Error('Native waiter identity schema mismatch')
  return Object.freeze({
    waiterPid: frame.waiterPid,
    waiterStartTime: frame.waiterStartTime,
    pidNamespace: frame.pidNamespace as string | null,
    namespaceDepth: frame.namespaceDepth as number | null,
  })
}
function parseTargetIdentity(
  frame: Record<string, unknown>,
  waiter: NativeWaiterIdentity,
): NativeTargetIdentity {
  const observed = parseWaiterIdentity(frame, waiter.pidNamespace !== null)
  if (
    Object.entries(waiter).some(([key, value]) => frame[key] !== value) ||
    !nativePid(frame.targetPid) ||
    frame.targetPid === waiter.waiterPid ||
    !nativePid(frame.targetLocalPid) ||
    !nativeStart(frame.targetStartTime)
  )
    throw new Error('Native target identity contradicts original waiter')
  return Object.freeze({
    ...observed,
    targetPid: frame.targetPid,
    targetLocalPid: frame.targetLocalPid,
    targetStartTime: frame.targetStartTime,
  })
}
/** Host-private, never serialize plain plan/environment digests in public results. */
export type NativeFinalResult = Readonly<{
  targetEntry: 'entered' | 'not-entered' | 'unknown'
  targetPid: number | null
  waiterPid: number | null
  waiterStartTime: string | null
  targetLocalPid: number | null
  targetStartTime: string | null
  pidNamespace: string | null
  namespaceDepth: number | null
  exitCode: number | null
  signal: number | null
  waitStatusSource:
    | 'direct-target'
    | 'bwrap-target-exit'
    | 'bwrap-status-ambiguous'
    | 'not-observed'
    | 'native-target-wait'
  wrapperExitCode: number | null
  wrapperSignal: number | null
  cause: string | null
  enforced: LaunchFacts['profile']['enforced']
  usage: Readonly<{ cpuMicros: number; maxRssKiB: number; scope: string }>
  targetUsage: Readonly<{
    cpuMicros: number
    maxRssKiB: number
    scope: string
  }> | null
  cleanup: NativeCleanup
}>
export type NativeDispatchHandle = NodeDispatchHandle &
  Readonly<{ nativeResult: Promise<Result<NativeFinalResult>> }>
const retainedScopes = new Map<
  OwnedProcessScope,
  Readonly<{
    facts: () => LaunchFacts
    resourceSignal: AbortSignal
    child: ChildProcess
    stopping?: () => boolean
  }>
>()
export function retainedNativeScopes(
  hostContextId: string,
): readonly OwnedProcessScope[] {
  return [...retainedScopes]
    .filter(([, value]) => value.facts().hostContextId === hostContextId)
    .map(([scope]) => scope)
}
export async function joinNativeScopeCleanup(
  hostContextId: string,
): Promise<readonly CleanupResult[]> {
  const stopped = [...retainedScopes].filter(
    ([scope, value]) =>
      value.facts().hostContextId === hostContextId &&
      (value.resourceSignal.aborted ||
        value.stopping?.() ||
        scope.currentCleanup() !== undefined ||
        value.child.exitCode !== null ||
        value.child.signalCode !== null),
  )
  return Promise.all(
    stopped.map(([scope]) => scope.requestStop('owner-shutdown')),
  )
}

/** A returned monitor stays root-join-visible if adapter setup throws. */
function failedSetupScope(
  child: ChildProcess,
  facts: () => LaunchFacts,
  clock: Clock,
  onStop: () => void,
  drains: () => ScopeOutput,
): OwnedProcessScope {
  let closed = false,
    resolveClose!: () => void,
    stopAt: number | undefined
  const close = new Promise<void>((resolve) => {
    resolveClose = resolve
  })
  let cleanup: CleanupResult | undefined,
    pending: Promise<CleanupResult> | undefined,
    pendingInFlight = false
  const scopeId = `native-failed-setup-${facts().launchId}`
  const originalDeadline = facts().deadlines.resourceLifetime
  const observation = (): ScopeObservation => ({
    sampledAtMs: clock.nowMs(),
    clockDomainId: clock.domainId,
    leader: closed ? 'exited-reaped' : 'unknown',
    scopePresence: closed ? 'absent' : 'unknown',
    members: [],
    membershipComplete: closed,
    identity: closed ? 'verified' : 'unknown',
    streams: {
      stdin: closed ? 'closed' : 'unknown',
      stdout: drains().complete ? 'drained' : 'unknown',
      stderr: drains().complete ? 'drained' : 'unknown',
    },
  })
  const scope: OwnedProcessScope = Object.freeze({
    scopeId,
    tier: 'direct-child',
    observe: async () => observation(),
    requestStop(reason: StopReason, force = false) {
      if (stopAt === undefined) {
        stopAt = clock.nowMs()
        onStop()
      }
      if (force && !pendingInFlight && cleanup?.status !== 'complete')
        pending = undefined
      pending ??= (async () => {
        pendingInFlight = true
        if (!closed) {
          try {
            child.kill('SIGTERM')
          } catch {
            /* Retain the original monitor. */
          }
        }
        let killTimer: ReturnType<typeof setTimeout> | undefined,
          joinTimer: ReturnType<typeof setTimeout> | undefined
        if (!closed)
          killTimer = setTimeout(
            () => {
              if (!closed) {
                try {
                  child.kill('SIGKILL')
                } catch {
                  /* Still unknown. */
                }
              }
            },
            Math.max(0, stopAt! + 200 - clock.nowMs()),
          )
        await Promise.race([
          close,
          new Promise<void>((resolve) => {
            joinTimer = setTimeout(
              resolve,
              Math.max(0, stopAt! + 1400 - clock.nowMs()),
            )
          }),
        ])
        if (killTimer) clearTimeout(killTimer)
        if (joinTimer) clearTimeout(joinTimer)
        const output = drains(),
          complete = closed && output.complete
        cleanup = Object.freeze({
          attemptId: randomUUID(),
          scopeId,
          status: complete ? 'complete' : 'unknown',
          selectedTier: 'direct-child',
          observedTier: 'direct-child',
          satisfiesSelectedTier: complete,
          trigger: reason,
          originalDeadline,
          firstStopAtMs: stopAt!,
          killAtMs: stopAt! + 200,
          observeUntilMs: stopAt! + 1400,
          signals: [],
          finalObservation: observation(),
          output,
          cleanupAuthorityRetained: !complete,
          selectedLimitSatisfied:
            originalDeadline.kind === 'finite'
              ? complete && clock.nowMs() <= originalDeadline.expiresAtMs + 1400
              : null,
          cause:
            'Native monitor adapter setup failed before target protocol initialization',
          launchFacts: facts(),
        })
        if (complete) retainedScopes.delete(scope)
        return cleanup
      })().finally(() => {
        pendingInFlight = false
      })
      return pending
    },
    retryCleanup: (force?: boolean) =>
      scope.requestStop('owner-shutdown', force),
    currentCleanup: () => cleanup,
  })
  child.once('close', () => {
    closed = true
    resolveClose()
  })
  return scope
}

function validateFinal(
  value: Record<string, unknown>,
  expiry: string | null,
): NativeFinalResult {
  const result = value as unknown as NativeFinalResult
  const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max
  const ns = (v: unknown) =>
    typeof v === 'string' &&
    /^[0-9]{1,20}$/.test(v) &&
    BigInt(v) <= 18_446_744_073_709_551_615n
  const nullable = (v: unknown, test: (v: unknown) => boolean) =>
    v === null || test(v)
  const c = result.cleanup,
    u = result.usage
  if (
    !['entered', 'not-entered', 'unknown'].includes(result.targetEntry) ||
    !c ||
    typeof c.complete !== 'boolean' ||
    !['linux-pid-namespace', 'direct-child'].includes(c.scopeTier) ||
    !nullable(
      c.pidNamespace,
      (v) => typeof v === 'string' && /^pid:\[[0-9]+\]$/.test(v),
    ) ||
    !nullable(c.namespaceAbsent, (v) => typeof v === 'boolean') ||
    !nullable(c.initAbsent, (v) => typeof v === 'boolean') ||
    typeof c.outerChildReaped !== 'boolean' ||
    typeof c.allChildrenReaped !== 'boolean' ||
    typeof c.observationsTruncated !== 'boolean' ||
    !integer(c.reapCount) ||
    !Array.isArray(c.reapedPids) ||
    c.reapedPids.length > 128 ||
    !c.reapedPids.every((v) => integer(v, 1, 2_147_483_647)) ||
    c.reapCount < c.reapedPids.length ||
    !nullable(c.stopAtNs, ns) ||
    !ns(c.observedAtNs) ||
    c.originalExpiryNs !== expiry ||
    (c.stopAtNs !== null && BigInt(c.stopAtNs) > BigInt(c.observedAtNs)) ||
    !Array.isArray(c.signals) ||
    c.signals.length > 128 ||
    !c.signals.every(
      (s) =>
        s &&
        ['SIGTERM', 'SIGKILL'].includes(s.signal) &&
        integer(s.pid, 1, 2_147_483_647) &&
        ns(s.atNs) &&
        ['delivered', 'unknown'].includes(s.result) &&
        BigInt(s.atNs) <= BigInt(c.observedAtNs),
    ) ||
    !u ||
    !integer(u.cpuMicros) ||
    !integer(u.maxRssKiB) ||
    u.scope !==
      'direct-and-adopted-wait4; maxrss is not aggregate tree memory' ||
    !nullable(result.targetPid, (v) => integer(v, 1, 2_147_483_647)) ||
    !nullable(result.waiterPid, nativePid) ||
    !nullable(result.waiterStartTime, nativeStart) ||
    !nullable(result.targetLocalPid, nativePid) ||
    !nullable(result.targetStartTime, nativeStart) ||
    result.pidNamespace !== c.pidNamespace ||
    !nullable(result.namespaceDepth, (v) => integer(v, 2, 32)) ||
    (result.targetUsage !== null &&
      (!result.targetUsage ||
        !integer(result.targetUsage.cpuMicros) ||
        !integer(result.targetUsage.maxRssKiB) ||
        result.targetUsage.scope !==
          'actual-target-wait4; maxrss is target peak')) ||
    !nullable(result.exitCode, (v) => integer(v, 0, 255)) ||
    !nullable(result.signal, (v) => integer(v, 1, 64)) ||
    !nullable(result.wrapperExitCode, (v) => integer(v, 0, 255)) ||
    !nullable(result.wrapperSignal, (v) => integer(v, 1, 64)) ||
    !nullable(
      result.cause,
      (v) => typeof v === 'string' && v.length <= FRAME_LIMIT,
    ) ||
    !['not-observed', 'native-target-wait'].includes(result.waitStatusSource) ||
    !Array.isArray(result.enforced) ||
    result.enforced.length > 7 ||
    !result.enforced.every(
      (e) =>
        e &&
        [
          'exact-env',
          'cooperative-cancellation',
          'filesystem-isolation',
          'network-isolation',
          'process-tree-containment',
          'memory-limit',
          'deadline-termination',
        ].includes(e.capability) &&
        ['enforced', 'not-enforced', 'not-requested'].includes(e.status) &&
        typeof e.evidenceId === 'string' &&
        e.evidenceId === value.scopeId,
    ) ||
    new Set(result.enforced.map((e) => e.capability)).size !==
      result.enforced.length
  )
    throw new Error('Invalid native final schema/original expiry')
  if (
    c.complete &&
    (!c.outerChildReaped ||
      (result.targetPid !== null && !c.allChildrenReaped) ||
      (c.scopeTier === 'linux-pid-namespace' &&
        (c.namespaceAbsent !== true ||
          c.initAbsent !== true ||
          !c.pidNamespace)))
  )
    throw new Error('Native final lacks death/reap proof')
  if (
    (result.exitCode !== null && result.signal !== null) ||
    (result.wrapperExitCode !== null && result.wrapperSignal !== null) ||
    (result.targetEntry === 'entered' && result.targetPid === null) ||
    (result.waiterPid === null) !== (result.waiterStartTime === null) ||
    (result.targetPid === null) !== (result.targetLocalPid === null) ||
    (result.targetPid === null) !== (result.targetStartTime === null) ||
    (result.targetPid !== null &&
      (result.waiterPid === null || result.targetPid === result.waiterPid)) ||
    (result.pidNamespace === null) !== (result.namespaceDepth === null) ||
    (result.waitStatusSource === 'native-target-wait' &&
      (result.targetEntry !== 'entered' ||
        result.targetUsage === null ||
        (result.exitCode === null && result.signal === null))) ||
    (result.waitStatusSource === 'not-observed' &&
      (result.exitCode !== null ||
        result.signal !== null ||
        result.targetUsage !== null ||
        !result.cause?.trim()))
  )
    throw new Error('Native target/wrapper wait qualification mismatch')
  return Object.freeze({
    targetEntry: result.targetEntry,
    targetPid: result.targetPid,
    waiterPid: result.waiterPid,
    waiterStartTime: result.waiterStartTime,
    targetLocalPid: result.targetLocalPid,
    targetStartTime: result.targetStartTime,
    pidNamespace: result.pidNamespace,
    namespaceDepth: result.namespaceDepth,
    exitCode: result.exitCode,
    signal: result.signal,
    waitStatusSource: result.waitStatusSource,
    wrapperExitCode: result.wrapperExitCode,
    wrapperSignal: result.wrapperSignal,
    cause: result.cause,
    enforced: Object.freeze(
      result.enforced.map((e) => Object.freeze({ ...e })),
    ),
    usage: Object.freeze({ ...u }),
    targetUsage:
      result.targetUsage === null
        ? null
        : Object.freeze({ ...result.targetUsage }),
    cleanup: Object.freeze({
      ...c,
      reapedPids: Object.freeze([...c.reapedPids]),
      signals: Object.freeze(c.signals.map((s) => Object.freeze({ ...s }))),
    }),
  })
}

/** One synchronous dispatch creates the exact plan and private entry identity. */
export function dispatchNativeLaunch(
  admitted: AdmittedNodeLaunch,
  options: NativeDispatchOptions,
): NodeDispatchResult {
  try {
    const state = stateFor(options.installation)
    if (!mountPolicies.has(options.mounts))
      return refuse(
        'invalid-context',
        'Native mount policy is not host-registered',
      )
    const dispatched = admitted.launch.dispatchNow(
      admitted.permit,
      (input, boundObserver): NativeDispatchHandle => {
        const observer = boundObserver as NativeLaunchObserver,
          facts = () => admitted.launch.facts()
        const initial = facts(),
          profile = initial.profile.requested
        if (
          initial.profile.selected?.backend !== 'native-exec' ||
          input.adapterOptions.nativeAdapter !== EXEC_PROTOCOL ||
          input.adapterOptions.nativeArtifactSha256 !== state.artifact.sha256 ||
          input.adapterOptions.nativeMountDigest !== options.mounts.digest ||
          typeof observer.nativeTransportObserved !== 'function'
        )
          throw new Error(
            'Native adapter/profile/generation is not captured by this launch',
          )
        const resourceDeadline = input.deadlines.resourceLifetime
        let expiry: string | null = null
        if (resourceDeadline.kind === 'finite') {
          if (resourceDeadline.domainId !== options.clock.domainId)
            throw new Error('Native resource deadline clock domain differs')
          const mapped = nativeExpiryNs(
            options.mapping,
            options.installation,
            options.clock,
            resourceDeadline.expiresAtMs,
          )
          if (!mapped.ok) throw new Error(mapped.cause)
          expiry = mapped.value
        }
        const policy =
          profile.policy === 'full-access'
            ? 'full-access'
            : 'linux-bwrap-seccomp'
        const selectedNetwork =
          policy === 'full-access' ? 'inherit' : options.network
        const selectedLandlock =
          policy === 'full-access' ? 'disabled' : options.landlock
        const filterDigest = nativeFilterSha256(selectedNetwork)
        if (
          input.adapterOptions.nativeNetwork !== selectedNetwork ||
          input.adapterOptions.nativeLandlock !== selectedLandlock ||
          input.adapterOptions.nativeFilterSha256 !== filterDigest
        )
          throw new Error(
            'Native network/Landlock/filter selection is not captured by this launch',
          )
        const outputBytes = Number(
          input.adapterOptions.nativeMaxRetainedOutputBytes,
        )
        if (
          input.adapterOptions.nativeCleanupVersion !== CLEANUP_VERSION ||
          !Number.isSafeInteger(outputBytes) ||
          outputBytes <= 0 ||
          outputBytes > 1_073_741_824 ||
          String(outputBytes) !==
            input.adapterOptions.nativeMaxRetainedOutputBytes
        )
          throw new Error(
            'Native output/cleanup selection is not captured by this launch',
          )
        const plan = {
          schema: 'openbuff.exec.plan.v1',
          protocol: EXEC_PROTOCOL,
          launchId: initial.launchId,
          resourceId: initial.resourceId,
          resourceGeneration: initial.resourceGeneration,
          ownerId: initial.ownerId,
          requestId: initial.requestId,
          leaseId: initial.leaseId,
          correlation: initial.correlation,
          executionBindingDigest: initial.executionBindingDigest,
          artifact: {
            sha256: state.artifact.sha256,
            platform: state.artifact.platform,
            crateVersion: state.artifact.crateVersion,
            workspaceProtocol: state.artifact.workspaceProtocol,
          },
          executable: input.executable,
          argv: input.argv,
          cwd: input.cwd,
          env: Object.entries(input.env).sort(([a], [b]) => a.localeCompare(b)),
          policy: profile.policy,
          required: profile.required,
          optional: profile.optional ?? [],
          mode: policy,
          bwrap: state.bwrap,
          mounts: options.mounts.mounts,
          symlinks: options.mounts.symlinks,
          network: selectedNetwork,
          landlock: selectedLandlock,
          expiryNs: expiry,
          deadlines: input.deadlines,
          filterDigest,
          cleanupLimits: CLEANUP_LIMITS,
          outputLimits: {
            authority: options.output ? 'host-spool' : 'unavailable',
            maxRetainedBytes: outputBytes,
            controlFrameBytes: FRAME_LIMIT,
            prepareFrameBytes: PLAN_LIMIT,
          },
        }
        const planJson = JSON.stringify(plan),
          identity = privateNativePlanIdentity(planJson, state.artifact.sha256)
        let observed: Result<Readonly<{ pid: number }>> = refuse(
          'unavailable',
          'Native target entry has not been observed',
        )
        let startSettled = false,
          settleStart!: (result: Result<Readonly<{ pid: number }>>) => void
        const started = new Promise<Result<Readonly<{ pid: number }>>>(
          (resolve) => {
            settleStart = resolve
          },
        )
        const finishStart = (result: Result<Readonly<{ pid: number }>>) => {
          observed = result
          if (!startSettled) {
            startSettled = true
            settleStart(result)
          }
        }
        let settleFinal!: (result: Result<NativeFinalResult>) => void
        const nativeResult = new Promise<Result<NativeFinalResult>>(
          (resolve) => {
            settleFinal = resolve
          },
        )
        let phase:
          | 'spawn'
          | 'initialize'
          | 'prepare'
          | 'commit'
          | 'target-created'
          | 'entered'
          | 'final' = 'spawn'
        let final: NativeFinalResult | undefined,
          failure: Refusal | undefined,
          finalSettled = false,
          protocolInvalidated = false,
          waiterIdentity: NativeWaiterIdentity | undefined,
          targetIdentity: NativeTargetIdentity | undefined,
          scopeId = `native-transport-${initial.launchId}`
        let pendingBytes = 0,
          closed = false,
          stdoutDrained = false,
          stderrDrained = false,
          stdoutSeenBytes = 0,
          stderrSeenBytes = 0
        let resolveClose!: () => void
        const close = new Promise<void>((resolve) => {
          resolveClose = resolve
        })
        const spawnNow =
          options.spawn ??
          ((command, argv, config) =>
            spawn(command, [...(argv ?? [])], config ?? {}))
        const installationLease = retainInstallation(options.installation)
        let child: ChildProcess
        try {
          child = spawnNow(
            '/proc/self/fd/5',
            ['exec', '--expiry-ns', expiry ?? 'none'],
            {
              cwd: input.cwd,
              env: { LANG: 'C', LC_ALL: 'C' },
              detached: false,
              shell: false,
              stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', state.fd],
            },
          )
        } catch (error) {
          // No child was returned; later setup exceptions cannot use this path.
          installationLease.release()
          throw error
        }
        let physicalSpawnObserved = false
        const fallbackScope = failedSetupScope(
          child,
          facts,
          options.clock,
          () => {
            observer.cleanupCommitted()
          },
          () => ({
            stdoutSeenBytes,
            stderrSeenBytes,
            retainedBytes: 0,
            droppedBytes: 0,
            complete: stdoutDrained && stderrDrained,
          }),
        )
        retainedScopes.set(fallbackScope, {
          facts,
          resourceSignal: input.resourceSignal,
          child,
          stopping: () => true,
        })
        child.once('spawn', () => {
          physicalSpawnObserved = true
        })
        child.once('close', () => {
          installationLease.release()
        })
        child.once('error', () => {
          if (!physicalSpawnObserved && child.pid === undefined)
            installationLease.release()
        })
        let registeredScope: OwnedProcessScope | undefined
        try {
          child.stdout?.once('end', () => {
            stdoutDrained = true
          })
          child.stderr?.once('end', () => {
            stderrDrained = true
          })
          const controlInput = child.stdio[3] as
            | import('node:stream').Writable
            | null
          const controlOutput = child.stdio[4] as
            | import('node:stream').Readable
            | null
          let stopAt: number | undefined,
            cleanup: CleanupResult | undefined,
            cleanupPromise: Promise<CleanupResult> | undefined,
            cleanupInFlight = false
          const send = (value: unknown, prepare = false) => {
            if (!controlInput || controlInput.destroyed || phase === 'final')
              throw new Error('Native control input unavailable/closed')
            const frame = encodeNativeFrame(value, prepare)
            if (pendingBytes + frame.length > 2 * PLAN_LIMIT)
              throw new Error('Native host control output queue bound exceeded')
            pendingBytes += frame.length
            controlInput.write(frame, (error) => {
              pendingBytes -= frame.length
              if (error) fail(error.message)
            })
          }
          const stop = (reason: StopReason) => {
            if (stopAt !== undefined) return
            observer.cleanupCommitted()
            stopAt = options.clock.nowMs()
            try {
              send({ type: 'stop', reason })
            } catch {
              controlInput?.destroy()
            }
          }
          const fail = (cause: string) => {
            // A protocol or adapter error invalidates any prior final candidate,
            // including errors discovered while finishing the framed stream.
            final = undefined
            protocolInvalidated = true
            failure ??= refuse(
              input.resourceSignal.aborted
                ? isExecutionDeadlineSignal(input.resourceSignal)
                  ? 'deadline-exhausted'
                  : 'cancelled'
                : 'unavailable',
              cause,
            )
            observer.failure({ source: 'adapter-observation-error', cause })
            finishStart(failure)
            stop('adapter-error')
          }
          const settle = () => {
            if (!finalSettled) {
              finalSettled = true
              settleFinal(
                final &&
                  !protocolInvalidated &&
                  final.waitStatusSource === 'native-target-wait'
                  ? { ok: true, value: final }
                  : (failure ??
                      refuse('unavailable', 'Native final report missing')),
              )
            }
          }
          const observation = (): ScopeObservation => ({
            sampledAtMs: options.clock.nowMs(),
            clockDomainId: options.clock.domainId,
            leader: final?.cleanup.outerChildReaped
              ? 'exited-reaped'
              : closed
                ? 'unknown'
                : phase === 'entered'
                  ? 'running'
                  : 'not-started',
            scopePresence: final?.cleanup.complete
              ? 'absent'
              : final
                ? 'unknown'
                : 'living',
            members: [],
            membershipComplete: final?.cleanup.complete === true,
            identity: final ? 'verified' : 'unknown',
            streams: {
              stdin: child.stdin?.destroyed ? 'closed' : 'open',
              stdout: stdoutDrained ? 'drained' : 'open',
              stderr: stderrDrained ? 'drained' : 'open',
            },
          })
          const scope: OwnedProcessScope = Object.freeze({
            get scopeId() {
              return scopeId
            },
            tier:
              policy === 'full-access' ? 'direct-child' : 'linux-pid-namespace',
            observe: async () => observation(),
            requestStop(reason: StopReason, force = false) {
              stop(reason)
              if (force && !cleanupInFlight && cleanup?.status !== 'complete')
                cleanupPromise = undefined
              cleanupPromise ??= (async () => {
                cleanupInFlight = true
                let timeout: ReturnType<typeof setTimeout> | undefined
                await Promise.race([
                  close,
                  new Promise<void>((resolve) => {
                    timeout = setTimeout(
                      resolve,
                      Math.max(0, stopAt! + 1400 - options.clock.nowMs()),
                    )
                  }),
                ])
                if (timeout) clearTimeout(timeout)
                if (!closed) {
                  child.kill('SIGKILL')
                  controlInput?.destroy()
                  controlOutput?.destroy()
                  child.stdin?.destroy()
                  child.stdout?.destroy()
                  child.stderr?.destroy()
                }
                const output = options.output?.() ?? {
                  stdoutSeenBytes,
                  stderrSeenBytes,
                  retainedBytes: 0,
                  droppedBytes: 0,
                  complete: stdoutDrained && stderrDrained,
                }
                const noTargetSetupProof =
                  final?.targetEntry === 'not-entered' &&
                  final.targetPid === null &&
                  final.cleanup.scopeTier === 'direct-child' &&
                  final.cleanup.allChildrenReaped
                const complete =
                  closed &&
                  !protocolInvalidated &&
                  final?.cleanup.complete === true &&
                  (final.cleanup.scopeTier === scope.tier ||
                    noTargetSetupProof) &&
                  stdoutDrained &&
                  stderrDrained
                cleanup = Object.freeze({
                  attemptId: randomUUID(),
                  scopeId,
                  status: complete ? 'complete' : 'unknown',
                  selectedTier: scope.tier,
                  observedTier: final?.cleanup.scopeTier ?? 'direct-child',
                  satisfiesSelectedTier:
                    complete && final?.cleanup.scopeTier === scope.tier,
                  trigger: reason,
                  originalDeadline: resourceDeadline,
                  firstStopAtMs: stopAt!,
                  killAtMs: stopAt! + 200,
                  observeUntilMs: stopAt! + 1400,
                  signals: [],
                  finalObservation: observation(),
                  output,
                  cleanupAuthorityRetained: !complete,
                  selectedLimitSatisfied:
                    resourceDeadline.kind === 'finite'
                      ? complete &&
                        options.clock.nowMs() <=
                          resourceDeadline.expiresAtMs + 1400
                      : null,
                  ...(complete
                    ? {}
                    : {
                        cause:
                          failure?.cause ??
                          'Native final/namespace/outer/drain reconciliation incomplete',
                      }),
                  launchFacts: facts(),
                })
                if (complete) retainedScopes.delete(scope)
                return cleanup
              })().finally(() => {
                cleanupInFlight = false
              })
              return cleanupPromise
            },
            retryCleanup: (force?: boolean) =>
              scope.requestStop('owner-shutdown', force),
            currentCleanup: () => cleanup,
          })
          retainedScopes.set(scope, {
            facts,
            resourceSignal: input.resourceSignal,
            child,
            stopping: () => stopAt !== undefined,
          })
          registeredScope = scope
          retainedScopes.delete(fallbackScope)
          const onAbort = () => {
            const deadline = isExecutionDeadlineSignal(input.resourceSignal)
            failure ??= refuse(
              deadline ? 'deadline-exhausted' : 'cancelled',
              deadline
                ? 'Native original resource deadline exhausted'
                : 'Native resource cancelled',
            )
            stop(deadline ? 'deadline' : 'owner-cancel')
          }
          input.resourceSignal.addEventListener('abort', onAbort, {
            once: true,
          })
          child.stdout?.on('data', (bytes: Buffer) => {
            stdoutSeenBytes += bytes.length
          })
          child.stderr?.on('data', (bytes: Buffer) => {
            stderrSeenBytes += bytes.length
          })
          controlInput?.on('error', (error) => fail(error.message))
          controlOutput?.on('error', (error) => fail(error.message))
          child.once('error', (error) => fail(error.message))
          child.once('spawn', () => {
            try {
              installationLease.verify()
              const actualFd = fs.openSync(`/proc/${child.pid}/exe`, 'r')
              try {
                const actual = completeDescriptor(actualFd)
                if (
                  !sameGeneration(actual.identity, state.selected) ||
                  actual.sha256 !== state.artifact.sha256
                )
                  throw new Error(
                    'Actual native monitor executable generation differs',
                  )
              } finally {
                fs.closeSync(actualFd)
              }
              const recorded = observer.nativeTransportObserved({
                source: 'native-monitor-spawn',
                pid: child.pid!,
                ...identity,
              })
              if (!recorded.ok) throw new Error(recorded.cause)
              phase = 'initialize'
              send({
                type: 'initialize',
                protocol: EXEC_PROTOCOL,
                workspaceProtocol: state.artifact.workspaceProtocol,
                artifactSha256: state.artifact.sha256,
              })
            } catch (error) {
              fail(String(error))
            }
          })
          const decoder = new NativeFrameDecoder()
          controlOutput?.on('data', (bytes: Buffer) => {
            if (protocolInvalidated) return
            try {
              for (const frame of decoder.push(bytes)) {
                if (frame.type === 'initialized' && phase === 'initialize') {
                  const filters = frame.filterDigests as
                    | Record<string, unknown>
                    | undefined
                  if (
                    frame.execProtocol !== EXEC_PROTOCOL ||
                    frame.workspaceProtocol !==
                      state.artifact.workspaceProtocol ||
                    frame.crateVersion !== state.artifact.crateVersion ||
                    frame.platform !== state.artifact.platform ||
                    filters?.[selectedNetwork] !== filterDigest
                  )
                    throw new Error(
                      'Native initialized protocol/build/filter mismatch',
                    )
                  installationLease.verify()
                  phase = 'prepare'
                  send({ type: 'prepare', ...identity, planJson }, true)
                  continue
                }
                if (
                  frame.nonce !== identity.nonce ||
                  frame.planDigest !== identity.planDigest ||
                  frame.artifactSha256 !== identity.artifactSha256
                )
                  throw new Error('Native report plan identity mismatch')
                if (frame.type === 'prepared' && phase === 'prepare') {
                  if (
                    typeof frame.scopeId !== 'string' ||
                    !Array.isArray(frame.enforced)
                  )
                    throw new Error(
                      'Native prepared scope/enforcement schema mismatch',
                    )
                  waiterIdentity = parseWaiterIdentity(
                    frame,
                    policy !== 'full-access',
                  )
                  scopeId = frame.scopeId
                  installationLease.verify()
                  const prepared = observer.nativePrepared({
                    source: 'native-adapter-ready',
                    scopeId,
                    ...identity,
                    enforced:
                      frame.enforced as LaunchFacts['profile']['enforced'],
                  })
                  if (!prepared.ok) throw new Error(prepared.cause)
                  const commit = observer.commitNativeTargetEntry(identity)
                  if (!commit.ok) throw new Error(commit.cause)
                  if (
                    input.resourceSignal.aborted ||
                    commit.value.facts.executionBindingDigest !==
                      initial.executionBindingDigest ||
                    (expiry !== null &&
                      BigInt(expiry) <=
                        BigInt(options.mapping.nativeSampleNs) +
                          BigInt(
                            Math.floor(
                              (options.clock.nowMs() -
                                options.mapping.hostReceiveMs) *
                                1_000_000,
                            ),
                          ))
                  )
                    throw new Error(
                      'Native original entry basis/deadline exhausted',
                    )
                  phase = 'commit'
                  send({ type: 'commit', ...identity, expiryNs: expiry })
                  continue
                }
                if (frame.type === 'target-created' && phase === 'commit') {
                  if (frame.scopeId !== scopeId || !waiterIdentity)
                    throw new Error(
                      'Native target created without prepared waiter',
                    )
                  targetIdentity = parseTargetIdentity(frame, waiterIdentity)
                  phase = 'target-created'
                  continue
                }
                if (
                  frame.type === 'target-entered' &&
                  phase === 'target-created'
                ) {
                  if (
                    frame.scopeId !== scopeId ||
                    typeof frame.pid !== 'number' ||
                    !targetIdentity ||
                    frame.pid !== targetIdentity.targetPid ||
                    Object.entries(targetIdentity).some(
                      ([key, value]) => frame[key] !== value,
                    ) ||
                    !['exec-image', 'normal-wait-after-intent-eof'].includes(
                      String(frame.observation),
                    )
                  )
                    throw new Error('Native exec-status evidence mismatch')
                  const observedEntry = observer.nativeTargetEntered({
                    source: 'native-adapter-exec-status',
                    scopeId,
                    pid: frame.pid,
                    ...identity,
                  })
                  if (!observedEntry.ok) throw new Error(observedEntry.cause)
                  phase = 'entered'
                  finishStart({
                    ok: true,
                    value: Object.freeze({ pid: frame.pid }),
                  })
                  continue
                }
                if (frame.type === 'final' && phase !== 'final') {
                  const candidate = validateFinal(frame, expiry)
                  if (frame.scopeId !== scopeId && phase !== 'prepare')
                    throw new Error('Native final scope mismatch')
                  if (
                    (candidate.targetEntry === 'entered') !==
                    (phase === 'entered')
                  )
                    throw new Error(
                      'Native final target entry contradicts observed phase',
                    )
                  if (
                    targetIdentity
                      ? Object.entries(targetIdentity).some(
                          ([key, value]) =>
                            candidate[key as keyof NativeFinalResult] !== value,
                        )
                      : candidate.targetPid !== null
                  )
                    throw new Error(
                      'Native final target tuple contradicts accepted child identity',
                    )
                  if (
                    waiterIdentity &&
                    Object.entries(waiterIdentity).some(
                      ([key, value]) =>
                        candidate[key as keyof NativeFinalResult] !== value,
                    )
                  )
                    throw new Error(
                      'Native final waiter tuple contradicts prepared identity',
                    )
                  if (
                    candidate.cleanup.complete &&
                    candidate.targetPid !== null &&
                    candidate.cleanup.scopeTier !== scope.tier
                  )
                    throw new Error(
                      'Native final cleanup tier contradicts selected scope',
                    )
                  final = candidate
                  phase = 'final'
                  controlInput?.end()
                  if (final.cause)
                    failure ??= refuse(
                      final.cause.includes('deadline')
                        ? 'deadline-exhausted'
                        : 'unavailable',
                      final.cause,
                    )
                  if (!startSettled)
                    finishStart(
                      failure ??
                        refuse('unavailable', 'Native target did not enter'),
                    )
                  continue
                }
                throw new Error('Native output repeated/out-of-order frame')
              }
            } catch (error) {
              fail(String(error))
            }
          })
          controlOutput?.once('end', () => {
            try {
              decoder.end()
            } catch (error) {
              fail(String(error))
            }
          })
          child.once('close', () => {
            closed = true
            input.resourceSignal.removeEventListener('abort', onAbort)
            if (!startSettled)
              finishStart(
                failure ??
                  refuse(
                    'unavailable',
                    'Native monitor closed before target entry',
                  ),
              )
            settle()
            resolveClose()
            if (
              !protocolInvalidated &&
              final?.cleanup.complete &&
              (final.cleanup.scopeTier === scope.tier ||
                (final.targetEntry === 'not-entered' &&
                  final.targetPid === null &&
                  final.cleanup.allChildrenReaped)) &&
              stdoutDrained &&
              stderrDrained
            )
              retainedScopes.delete(scope)
          })
          if (!controlInput || !controlOutput)
            fail('Native dedicated control pipes unavailable')
          if (input.resourceSignal.aborted) onAbort()
          return Object.freeze({
            child,
            input,
            facts,
            started,
            observation: () => observed,
            resourceRefusal: () => failure,
            remainingResourceMs: () =>
              resourceDeadline.kind === 'unbounded'
                ? null
                : Math.max(
                    0,
                    resourceDeadline.expiresAtMs - options.clock.nowMs(),
                  ),
            scope,
            nativeResult,
          })
        } catch (error) {
          // A returned child may already be alive. Keep its lease through its
          // actual close; no throw after spawn is evidence of process absence.
          void (registeredScope ?? fallbackScope).requestStop('adapter-error')
          throw error
        }
      },
    )
    return dispatched.ok
      ? { ok: true, value: dispatched.value.handle }
      : dispatched.reason === 'dispatch-failed'
        ? { ...refuse('unavailable', dispatched.cause), dispatchFailed: true }
        : dispatched
  } catch (error) {
    return refuse(
      'invalid-context',
      error instanceof Error ? error.message : 'Native dispatch facade failed',
    )
  }
}
