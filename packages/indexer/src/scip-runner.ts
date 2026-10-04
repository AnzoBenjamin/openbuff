import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rmSync, rmdirSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { Worker } from 'node:worker_threads'

import { mergeScipEdgesIntoIndex, SCIP_MAX_MERGED_EDGES } from './scip-ingest'
import {
  deriveScipDumpEdges,
  ScipDumpDerivationError,
} from './scip-parse-worker'

import type { ChildProcess } from 'node:child_process'
import type { IndexEdge, MetadataIndex } from './types'
import type { ScipParseWorkerResult } from './scip-parse-worker'

/**
 * SCIP runner (P3-T4): detect the per-ecosystem `scip-*` indexer CLIs when
 * they are installed, run them, and merge the produced SCIP JSON dumps into
 * the metadata index through the existing `parseScipJson` +
 * `mergeScipEdgesIntoIndex` ingestion pipeline.
 *
 * Cost-control contract: NOTHING here runs automatically at refresh time.
 * Automatic refresh-time running is deliberately deferred — every scip-*
 * indexer is a compile-scale process, so callers opt in by invoking
 * `runScipIngest` (or `IndexManager.ingestScipDump` for an already-produced
 * dump). Every subprocess is bounded: argv arrays only (never shell strings),
 * a hard timeout, and a maxBuffer cap. Every indexer fails open
 * independently (absence, failure, and timeout are honest status values,
 * never thrown errors), and the number of indexers per call is capped.
 *
 * Perf contract: the default runner is ASYNC (`spawn`, not `spawnSync`) so a
 * detection probe or an indexer run never blocks the event loop; detection
 * probes are cached per (runner, root, bin) for a short TTL so
 * `detectAvailableScipIndexers` + `runScipIngest` (and repeated ingest calls)
 * do not re-probe the same binaries; indexers run with bounded concurrency;
 * every successful indexer's precise edges are merged in ONE batch pass
 * instead of chaining one full-index-copying merge per indexer; and the whole
 * SCIP dump front half — bounded read, JSON parse, validation
 * (`parseScipJson`), and precise-edge derivation (`scipPreciseEdges`) — runs
 * OFF the event loop in a bounded one-shot worker (`./scip-parse-worker`), so
 * only the derived precise edges ever cross back to the main thread.
 */

/** Injectable sync spawnSync-like process seam (legacy; still supported). */
export type ScipRunner = (invocation: ScipRunnerInvocation) => ScipRunnerResult

/**
 * Injectable async process seam. The default runner implements this over
 * `spawn`, so probes and indexer runs never block the event loop. A legacy
 * sync {@link ScipRunner} is accepted anywhere an async runner is and its
 * result is wrapped in a resolved promise.
 */
export type AsyncScipRunner = (
  invocation: ScipRunnerInvocation,
) => Promise<ScipRunnerResult>

export interface ScipRunnerInvocation {
  command: string
  /** Positional argv array only — never a shell string. */
  argv: string[]
  cwd: string
  timeoutMs: number
  maxBufferBytes: number
}

/** `status === null` means the process was killed (e.g. timeout). */
export interface ScipRunnerResult {
  status: number | null
  stdout: string
  stderr: string
}

/** One per-ecosystem scip-* command configuration. */
export interface ScipIndexerCommand {
  /** Stable ecosystem id used in results. */
  id: string
  /** External binary name resolved from PATH by the spawned process. */
  bin: string
  /** Cheap availability probe (e.g. `['--version']`). */
  detectionArgv: string[]
  /** Builds the index argv; `outputPath` is pre-arranged in a temp dir. */
  indexArgv: (root: string, outputPath: string) => string[]
  /** The indexer's documented default dump file name. */
  outputFile: string
}

/** Hard cap on indexers processed per `runScipIngest` call. */
export const MAX_SCIP_INDEXERS_PER_CALL = 8

/** Bound on indexers spawned concurrently per `runScipIngest` call. */
const MAX_INDEXER_CONCURRENCY = 4

const DETECTION_TIMEOUT_MS = 2_000
const DETECTION_BUFFER_BYTES = 1024 * 1024
const DEFAULT_INDEX_TIMEOUT_MS = 120_000
const MIN_INDEX_TIMEOUT_MS = 1_000
const MAX_INDEX_TIMEOUT_MS = 600_000
const MAX_PROCESS_BUFFER_BYTES = 64 * 1024 * 1024
/** Bound on the SCIP JSON document read back from disk. */
const MAX_DUMP_BYTES = 256 * 1024 * 1024
const MAX_STDERR_SNIPPET = 400
/**
 * Upper bound on the off-thread SCIP dump front half (read, parse, validate,
 * derive) before it is abandoned.
 */
const SCIP_PARSE_TIMEOUT_MS = 120_000

/**
 * Detection-probe cache: one entry per (runner, root, bin) for a short TTL,
 * so `detectAvailableScipIndexers` + `runScipIngest` — and repeated ingest
 * calls against the same root — reuse one probe per binary instead of
 * re-probing (each probe is a spawned process with a 2s timeout). Entries are
 * FIFO-trimmed so the cache cannot grow without bound.
 */
const DETECTION_CACHE_TTL_MS = 60_000
const MAX_DETECTION_CACHE_ENTRIES = 64
const detectionCache = new Map<
  string,
  { status: number | null; expiresAt: number }
>()
/**
 * In-flight detection probes keyed by the detection cache key (perf:
 * scip-detection-probe-no-single-flight): concurrent
 * detectAvailableScipIndexersAsync / runScipIngest calls on a cold cache key
 * join one probe per binary instead of each spawning their own probe process
 * (2s timeout each). Entries are removed as soon as their probe settles.
 */
const inFlightDetections = new Map<string, Promise<number | null>>()
const runnerIds = new WeakMap<object, number>()
let nextRunnerId = 1

function runnerIdFor(runner: object): number {
  let id = runnerIds.get(runner)
  if (id === undefined) {
    id = nextRunnerId++
    runnerIds.set(runner, id)
  }
  return id
}

function detectionCacheKey(runner: object, root: string, bin: string): string {
  // Both built-in runners probe the same real binaries, so they share one
  // cache namespace; injected (test) runners are keyed per instance so a fake
  // runner's answers never leak into another runner's probes.
  const shared =
    runner === (defaultScipRunner as object) ||
    runner === (defaultAsyncScipRunner as object)
  const id = shared ? 0 : runnerIdFor(runner)
  return `${id}\0${root}\0${bin}`
}

function trimDetectionCache(): void {
  while (detectionCache.size > MAX_DETECTION_CACHE_ENTRIES) {
    const oldest = detectionCache.keys().next().value
    if (oldest === undefined) break
    detectionCache.delete(oldest)
  }
}

/**
 * The supported scip-* indexers, in fixed table order (results keep this
 * order, so output is deterministic). The Rust entry uses `scip-rust`; a
 * rust-analyzer-based variant would be an additional table row, not a
 * shell-string fallback.
 */
export const SCIP_INDEXER_COMMANDS: readonly ScipIndexerCommand[] = [
  {
    id: 'typescript',
    bin: 'scip-typescript',
    detectionArgv: ['--version'],
    indexArgv: (_root, outputPath) => ['index', '--output', outputPath],
    outputFile: 'index.scip',
  },
  {
    id: 'python',
    bin: 'scip-python',
    detectionArgv: ['--version'],
    indexArgv: (_root, outputPath) => ['index', '--output', outputPath],
    outputFile: 'index.scip',
  },
  {
    id: 'rust',
    bin: 'scip-rust',
    detectionArgv: ['--version'],
    indexArgv: (_root, outputPath) => ['index', '--output', outputPath],
    outputFile: 'index.scip',
  },
  {
    id: 'java',
    bin: 'scip-java',
    detectionArgv: ['--version'],
    indexArgv: (_root, outputPath) => ['index', '--output', outputPath],
    outputFile: 'index.scip',
  },
  {
    id: 'go',
    bin: 'scip-go',
    detectionArgv: ['--version'],
    indexArgv: (_root, outputPath) => ['index', '--output', outputPath],
    outputFile: 'index.scip',
  },
  {
    id: 'clang',
    bin: 'scip-clang',
    detectionArgv: ['--version'],
    indexArgv: (_root, outputPath) => ['index', '--output', outputPath],
    outputFile: 'index.scip',
  },
  {
    id: 'dotnet',
    bin: 'scip-dotnet',
    detectionArgv: ['--version'],
    indexArgv: (_root, outputPath) => ['index', '--output', outputPath],
    outputFile: 'index.scip',
  },
  {
    id: 'ruby',
    bin: 'scip-ruby',
    detectionArgv: ['--version'],
    indexArgv: (_root, outputPath) => ['index', '--output', outputPath],
    outputFile: 'index.scip',
  },
]

/** Legacy sync runner over `spawnSync` (kept for compatibility). */
export const defaultScipRunner: ScipRunner = (invocation) => {
  try {
    const result = spawnSync(invocation.command, invocation.argv, {
      cwd: invocation.cwd,
      encoding: 'utf8',
      timeout: invocation.timeoutMs,
      // spawnSync buffers stdout/stderr fully; maxBuffer is the hard byte cap.
      maxBuffer: invocation.maxBufferBytes,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timedOut =
      !!result.error &&
      ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ||
        result.signal === 'SIGTERM')
    if (timedOut) {
      return {
        status: null,
        stdout: '',
        stderr: `${invocation.command} timed out`,
      }
    }
    // A spawnSync failure that killed the process — a maxBuffer overflow
    // (error.code ENOBUFS) or an unspawnable binary (ENOENT) — also reports
    // a non-numeric exit status (Node: `status: null`; Bun: `status:
    // undefined`). Downstream (`runSingleIndexer`) reads a bare null as a
    // timeout, so map the spawn error to a non-null failure status carrying
    // the error message instead of misreporting it as a timeout.
    if (result.status == null && result.error) {
      return {
        status: -1,
        stdout: typeof result.stdout === 'string' ? result.stdout : '',
        stderr: result.error.message,
      }
    }
    return {
      status: result.status,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr:
        typeof result.stderr === 'string'
          ? result.stderr
          : (result.error?.message ?? ''),
    }
  } catch (error) {
    return {
      status: -1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Byte-bounded stream capture (perf: scip-runner-stdout-char-cap-mismatch):
 * child output is accumulated as RAW BYTES against the invocation's
 * `maxBufferBytes` budget and decoded exactly once at stream end, so a
 * multibyte UTF-8 sequence split across stream-chunk boundaries is never
 * mangled by per-chunk `chunk.toString()` and the cap is compared in the
 * same unit (bytes) as the budget. Later chunks beyond the cap are dropped.
 * Mirrors the SDK's `BoundedStreamCapture` (diagnostic-delta-runner).
 */
export class BoundedStreamCapture {
  private chunks: Buffer[] = []
  private retained = 0

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer | string): void {
    if (this.retained >= this.maxBytes) return
    const bytes =
      typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    const take = Math.min(this.maxBytes - this.retained, bytes.length)
    if (take <= 0) return
    this.chunks.push(bytes.subarray(0, take))
    this.retained += take
  }

  /** Decode the retained byte prefix exactly once (multibyte-safe). */
  text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

/**
 * Default async runner over `spawn`: a probe or indexer run never blocks the
 * event loop. Output is capped at the invocation's maxBufferBytes (counted in
 * BYTES via {@link BoundedStreamCapture}, not UTF-16 code units) and the node
 * `timeout` option's SIGTERM kill maps to `status: null` (timeout), matching
 * the legacy sync runner's contract.
 */
export const defaultAsyncScipRunner: AsyncScipRunner = (invocation) =>
  new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(invocation.command, invocation.argv, {
        cwd: invocation.cwd,
        timeout: invocation.timeoutMs,
        // spawn has no maxBuffer option (that is spawnSync-only); output is
        // bounded by the data handlers below, which stop accumulating at
        // maxBufferBytes.
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({
        status: -1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      })
      return
    }
    const stdout = new BoundedStreamCapture(invocation.maxBufferBytes)
    const stderr = new BoundedStreamCapture(invocation.maxBufferBytes)
    let settled = false
    const finish = (result: ScipRunnerResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    // Raw-byte accumulation with ONE decode at stream end (perf:
    // scip-runner-stdout-char-cap-mismatch): per-chunk chunk.toString()
    // split multibyte UTF-8 sequences at chunk boundaries, and the old cap
    // compared UTF-16 string length against the byte budget.
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr.push(chunk)
    })
    child.on('error', (error: Error) => {
      // Spawn failure (e.g. ENOENT): the binary is not available.
      finish({ status: -1, stdout: '', stderr: error.message })
    })
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (signal === 'SIGTERM') {
        finish({
          status: null,
          stdout: '',
          stderr: `${invocation.command} timed out`,
        })
        return
      }
      finish({ status: code, stdout: stdout.text(), stderr: stderr.text() })
    })
  })

/** Adapt a legacy sync runner to the async seam (identity-stable per runner). */
const asyncWrapperMemo = new WeakMap<ScipRunner, AsyncScipRunner>()

/**
 * Wrap a sync `ScipRunner` so it satisfies the async seam. The default runner
 * is genuinely non-blocking (`defaultAsyncScipRunner`); this wrapper exists
 * only for legacy injected sync runners (tests, custom integrations), which
 * resolve on the next microtask.
 */
function toAsyncRunner(runner: ScipRunner): AsyncScipRunner {
  return async (invocation) => runner(invocation)
}

function resolveAsyncRunner(opts: {
  runner?: ScipRunner
  asyncRunner?: AsyncScipRunner
}): { run: AsyncScipRunner; identity: object } {
  if (opts.asyncRunner) return { run: opts.asyncRunner, identity: opts.asyncRunner }
  if (opts.runner) {
    // Memoize the wrapper per original runner so the detection cache keys off
    // a stable identity: detectAvailableScipIndexers (sync) and runScipIngest
    // (async) sharing one injected runner must share one cache namespace.
    let wrapped = asyncWrapperMemo.get(opts.runner)
    if (!wrapped) {
      wrapped = toAsyncRunner(opts.runner)
      asyncWrapperMemo.set(opts.runner, wrapped)
    }
    return { run: wrapped, identity: opts.runner }
  }
  return { run: defaultAsyncScipRunner, identity: defaultScipRunner }
}

export type ScipIndexerStatus = 'ok' | 'error' | 'unavailable' | 'timeout'

export interface ScipIndexerRunResult {
  indexer: string
  status: ScipIndexerStatus
  /**
   * Precise edges contributed by this indexer's dump (only for `ok` runs that
   * merged into a supplied index, before cross-source dedupe in the batch
   * merge; `mergedTotal` carries the deduped total actually added).
   */
  edgesMerged?: number
  error?: string
}

export interface ScipIngestRunResult {
  results: ScipIndexerRunResult[]
  /** Total precise edges merged across all successful indexers. */
  mergedTotal: number
  /** Accumulated snapshot when `opts.index` was supplied and any merge ran. */
  mergedIndex?: MetadataIndex
}

export interface ScipIngestRunOptions {
  /**
   * Injectable async process seam; defaults to the non-blocking `spawn`
   * runner. Prefer this over the legacy sync `runner`.
   */
  asyncRunner?: AsyncScipRunner
  /** Legacy sync process seam; wrapped and still supported for compat. */
  runner?: ScipRunner
  /** Current index snapshot to merge precise edges into (merge is skipped
   * when omitted — detect-and-dump mode). */
  index?: MetadataIndex
  /** Index-run timeout; default 120s, clamped to [1s, 600s]. */
  timeoutMs?: number
  /** Restrict to specific indexer ids (unknown ids are ignored). */
  indexers?: string[]
  /** Cap on indexers processed, clamped to [1, MAX_SCIP_INDEXERS_PER_CALL]. */
  maxIndexers?: number
}

/**
 * Probe every table entry with its detection argv (2s timeout each) and
 * return the ids of the installed indexers in table order. Never throws.
 * Probe results are cached (short TTL) and shared with `runScipIngest`, so a
 * detect-then-ingest sequence probes each binary once.
 */
export function detectAvailableScipIndexers(
  root: string,
  opts: { runner?: ScipRunner } = {},
): string[] {
  const runner = opts.runner ?? defaultScipRunner
  const available: string[] = []
  for (const entry of SCIP_INDEXER_COMMANDS) {
    if (detectionStatusSync(root, entry, runner) === 0) available.push(entry.id)
  }
  return available
}

/**
 * Async counterpart of {@link detectAvailableScipIndexers} over the
 * non-blocking runner seam, sharing the same detection cache.
 */
export async function detectAvailableScipIndexersAsync(
  root: string,
  opts: { runner?: ScipRunner; asyncRunner?: AsyncScipRunner } = {},
): Promise<string[]> {
  const { run, identity } = resolveAsyncRunner(opts)
  const available: string[] = []
  await Promise.all(
    SCIP_INDEXER_COMMANDS.map(async (entry) => {
      if ((await detectionStatusAsync(root, entry, run, identity)) === 0) {
        available.push(entry.id)
      }
    }),
  )
  // Restore table order after the parallel probes.
  return SCIP_INDEXER_COMMANDS.filter((entry) => available.includes(entry.id)).map(
    (entry) => entry.id,
  )
}

function detectionStatusSync(
  root: string,
  entry: ScipIndexerCommand,
  runner: ScipRunner,
  identity: object = runner,
): number | null {
  const key = detectionCacheKey(identity, root, entry.bin)
  const cached = detectionCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.status
  try {
    const detection = runner({
      command: entry.bin,
      argv: entry.detectionArgv,
      cwd: root,
      timeoutMs: DETECTION_TIMEOUT_MS,
      maxBufferBytes: DETECTION_BUFFER_BYTES,
    })
    detectionCache.set(key, {
      status: detection.status,
      expiresAt: Date.now() + DETECTION_CACHE_TTL_MS,
    })
    trimDetectionCache()
    return detection.status
  } catch {
    // A throwing runner is not an available indexer; nothing is cached so a
    // transient failure is retried on the next call.
    return -1
  }
}

async function detectionStatusAsync(
  root: string,
  entry: ScipIndexerCommand,
  runner: AsyncScipRunner,
  identity: object,
): Promise<number | null> {
  const key = detectionCacheKey(identity, root, entry.bin)
  const cached = detectionCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.status
  // Single-flight: concurrent callers on a cold cache key join one in-flight
  // probe per binary. The in-flight promise is registered synchronously (the
  // runner is invoked before the first await), so a concurrent caller can
  // never miss it and duplicate the spawned probe process.
  const inFlight = inFlightDetections.get(key)
  if (inFlight) return inFlight
  // Declared before assignment so the finally-block identity guard can close
  // over the in-flight promise without tripping definite-assignment analysis.
  let probe: Promise<number | null> | undefined
  probe = (async () => {
    try {
      const detection = await runner({
        command: entry.bin,
        argv: entry.detectionArgv,
        cwd: root,
        timeoutMs: DETECTION_TIMEOUT_MS,
        maxBufferBytes: DETECTION_BUFFER_BYTES,
      })
      detectionCache.set(key, {
        status: detection.status,
        expiresAt: Date.now() + DETECTION_CACHE_TTL_MS,
      })
      trimDetectionCache()
      return detection.status
    } catch {
      // A throwing runner is not an available indexer; nothing is cached so
      // a transient failure is retried on the next call.
      return -1
    } finally {
      if (inFlightDetections.get(key) === probe) inFlightDetections.delete(key)
    }
  })()
  inFlightDetections.set(key, probe)
  return probe
}

/**
 * Detect available scip-* indexers (each binary probed at most once per TTL
 * window via the shared detection cache), run each available indexer's index
 * argv against `root` with bounded concurrency on the async (non-blocking)
 * runner seam, read the produced dumps (bounded), and merge ALL of their
 * precise edges into the supplied index in ONE batch pass through
 * `mergeScipEdgesIntoIndex`. Fails open per indexer: one broken ecosystem
 * never blocks the others, and the whole call never throws. Total work is
 * bounded (indexer cap, concurrency cap, per-process timeout and maxBuffer,
 * 256MiB dump-read cap).
 *
 * Concurrency contract: every invocation writes its dumps into a per-call
 * unique temp directory (a random nonce under the sanitized project-root
 * name), so two concurrent `runScipIngest` calls against the same root never
 * share a dump path — one invocation can never read another's partially
 * written or already-cleaned dump, and cleanup only removes the invoking
 * call's own temp directory.
 */
export async function runScipIngest(
  root: string,
  opts: ScipIngestRunOptions = {},
): Promise<ScipIngestRunResult> {
  const { run, identity } = resolveAsyncRunner(opts)
  // Per-invocation temp-directory nonce: concurrent calls against the same
  // root get distinct dump paths instead of racing on one shared path.
  const nonce = randomUUID()
  const timeoutMs = Math.min(
    Math.max(opts.timeoutMs ?? DEFAULT_INDEX_TIMEOUT_MS, MIN_INDEX_TIMEOUT_MS),
    MAX_INDEX_TIMEOUT_MS,
  )
  const maxIndexers = clampIndexerCount(opts.maxIndexers)
  const wanted = opts.indexers ? new Set(opts.indexers) : null
  const candidates = SCIP_INDEXER_COMMANDS.filter(
    (entry) => !wanted || wanted.has(entry.id),
  ).slice(0, maxIndexers)

  // 1. Probe every candidate's availability ONCE (parallel, cached, and
  // shared with detectAvailableScipIndexers) before any indexer is launched.
  const detectionStatuses = new Map<string, number | null>()
  await Promise.all(
    candidates.map(async (entry) => {
      detectionStatuses.set(
        entry.id,
        await detectionStatusAsync(root, entry, run, identity),
      )
    }),
  )
  const runnable = candidates.filter(
    (entry) => detectionStatuses.get(entry.id) === 0,
  )

  // 2. Run the available indexers with bounded concurrency — never blocking
  // the event loop, and never more than MAX_INDEXER_CONCURRENCY at once.
  const outcomes = new Map<
    string,
    { status: ScipIndexerStatus; error?: string; edges?: IndexEdge[] }
  >()
  await mapWithConcurrency(runnable, MAX_INDEXER_CONCURRENCY, async (entry) => {
    outcomes.set(
      entry.id,
      await runSingleIndexer(root, entry, run, timeoutMs, nonce, SCIP_MAX_MERGED_EDGES),
    )
  })

  // 3. Assemble per-indexer results in fixed table order and clean up temp
  // dirs, then merge every successful dump's precise edges in ONE batch pass.
  const results: ScipIndexerRunResult[] = []
  const dumps = new Map<string, IndexEdge[]>()
  // Cumulative batch budget (perf: scip-premerge-edge-accumulation): the
  // merge's 'edge-limit' cap is consulted DURING accumulation, not after
  // every derived edge has been retained. An indexer whose derived edges do
  // not fit the remaining budget is attributed the cap error up front and its
  // edges are released, instead of holding millions of edge objects until the
  // merge loop finally throws and discards them.
  let batchBudget = SCIP_MAX_MERGED_EDGES
  for (const entry of candidates) {
    const status = detectionStatuses.get(entry.id)
    const result: ScipIndexerRunResult = { indexer: entry.id, status: 'unavailable' }
    if (status === 0) {
      const outcome = outcomes.get(entry.id)!
      result.status = outcome.status
      if (outcome.error !== undefined) result.error = outcome.error
      if (opts.index && outcome.edges) {
        if (outcome.edges.length > batchBudget) {
          result.status = 'error'
          result.error = `SCIP merge failed: SCIP merge exceeded the cap of ${SCIP_MAX_MERGED_EDGES} edges`
          // Release the derived edges; the merge could only discard them.
          outcome.edges = undefined
        } else {
          result.edgesMerged = outcome.edges.length
          dumps.set(entry.id, outcome.edges)
          batchBudget -= outcome.edges.length
        }
      }
    } else {
      result.error = `${entry.bin} not available (detection exit ${
        status === null ? 'timeout' : status
      })`
    }
    results.push(result)
    // Best-effort cleanup of this indexer's per-ecosystem temp directory.
    try {
      rmSync(path.dirname(scipDumpPath(root, entry, nonce)), {
        recursive: true,
        force: true,
      })
    } catch {
      // Temp-dir cleanup is best-effort; the dump was already read.
    }
  }
  // Best-effort cleanup of this invocation's own temp directories (perf:
  // scip-runner-nonce-temp-dirs-never-removed): the per-indexer loop above
  // removes each ecosystem dump directory, but the per-invocation nonce
  // directory (and its per-root sanitized parent) stayed behind, so every
  // opt-in ingest call leaked up to 8 empty directories into the OS temp dir.
  // The nonce directory is removed unconditionally; the shared per-root
  // parent is removed with a plain (non-recursive) directory removal so a
  // concurrent sibling invocation against the same root (its own nonce dir
  // still live inside the parent) is protected — that removal fails with
  // ENOTEMPTY and is swallowed. Only when this call is the last sibling does
  // the parent go too.
  try {
    const nonceDir = scipWorkspaceDir(root, nonce)
    rmSync(nonceDir, { recursive: true, force: true })
    rmdirSync(path.dirname(nonceDir))
  } catch {
    // Temp-dir cleanup is best-effort; the dumps were already read, and a
    // non-empty parent means a concurrent sibling invocation still owns it.
  }

  let mergedIndex = opts.index
  let mergedTotal = 0
  let mergedIndexChanged = false
  if (opts.index && dumps.size > 0) {
    // One snapshot copy for the whole batch — not one per successful indexer.
    // Edges are appended item-by-item (perf:
    // scip-runner-spread-batch-assembly): argument spread
    // (batch.push(...edges)) sits just under JavaScriptCore's
    // function-argument limit, so a per-indexer edge count approaching the
    // merge cap would throw a RangeError instead of merging.
    const batch: IndexEdge[] = []
    for (const entry of candidates) {
      for (const edge of dumps.get(entry.id) ?? []) {
        batch.push(edge)
      }
    }
    try {
      const merged = mergeScipEdgesIntoIndex(opts.index, batch)
      mergedIndex = merged.index
      mergedTotal = merged.edgesMerged
      mergedIndexChanged = true
    } catch (error) {
      // A batch-merge failure (e.g. the edge cap) is attributed to every
      // contributing indexer, matching the per-indexer fail-open contract.
      const message = `SCIP merge failed: ${errorMessage(error)}`
      for (const result of results) {
        if (dumps.has(result.indexer)) {
          result.status = 'error'
          result.error = message
          delete result.edgesMerged
        }
      }
    }
  }

  return {
    results,
    mergedTotal,
    ...(mergedIndexChanged && mergedIndex ? { mergedIndex } : {}),
  }
}

/**
 * Injectable worker constructor for {@link parseScipDumpEdges} (the same
 * test-seam shape as the runner injection `runScipIngest` takes): constructs
 * the one-shot parse worker, or throws synchronously when worker threads are
 * unavailable in this runtime.
 */
export type ScipParseWorkerSpawn = () => Worker

function defaultScipParseWorkerSpawn(): Worker {
  return new Worker(new URL('./scip-parse-worker.ts', import.meta.url))
}

/**
 * Run the OFF-thread front half of SCIP dump ingestion in a one-shot worker
 * (perf: scip-dump-json-parse-heap-spike): the worker reads the dump at
 * `filePath`, JSON.parses it, validates it through `parseScipJson`, and
 * derives its precise edges through `scipPreciseEdges` — the raw dump text
 * and the intermediate parse graph never touch the main thread, which only
 * receives the derived `IndexEdge[]` (the file size was already bounded by
 * the caller's stat cap). Any derivation failure — unreadable file, malformed
 * JSON, schema violation, or a document escaping the project root — rejects
 * with a {@link ScipDumpDerivationError} carrying its stage, and callers map
 * every failure to the same fail-open per-indexer error status as before.
 *
 * Degradation: when worker threads are unavailable in this runtime, the same
 * derivation stages run on-thread instead — same results, same errors, worse
 * latency. This covers BOTH unavailability shapes: a synchronous constructor
 * throw, and a worker script that fails to load asynchronously (Node reports
 * that via the worker 'error' event, not at construction — e.g. a compiled
 * build where './scip-parse-worker.ts' does not exist next to the compiled
 * module). A worker exit with a non-zero code or a timeout still rejects
 * (fail-open per-indexer status), exactly like the on-thread pipeline's
 * failure modes.
 */
export async function parseScipDumpEdges(
  filePath: string,
  spawnWorker: ScipParseWorkerSpawn = defaultScipParseWorkerSpawn,
): Promise<IndexEdge[]> {
  let worker: Worker
  try {
    worker = spawnWorker()
  } catch {
    // Workers are unavailable in this runtime: same stages, same errors,
    // worse latency — fall back to the on-thread derivation instead of
    // failing the ingest.
    return deriveScipDumpEdges(filePath)
  }
  return await new Promise<IndexEdge[]>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      finish()
      void worker.terminate()
    }
    timer = setTimeout(
      () =>
        settle(() =>
          reject(
            new Error(`SCIP dump parse exceeded ${SCIP_PARSE_TIMEOUT_MS}ms`),
          ),
        ),
      SCIP_PARSE_TIMEOUT_MS,
    )
    worker.on('message', (envelope: ScipParseWorkerResult) => {
      settle(() => {
        if (envelope.ok) {
          resolve(envelope.edges)
        } else {
          reject(
            new ScipDumpDerivationError(envelope.stage, envelope.message),
          )
        }
      })
    })
    worker.on('error', () => {
      settle(() => {
        // The worker failed before reporting any derivation result — the
        // async twin of the constructor-throw fallback above (Node reports
        // a worker script that cannot be loaded via the 'error' event, not
        // at construction). Degrade to the documented on-thread derivation
        // — same stages, same stage-tagged errors, same results — instead
        // of failing the ingest with an untagged worker error. A derivation
        // that itself fails throws the same ScipDumpDerivationError the
        // on-thread pipeline produces, so runSingleIndexer's stage-based
        // merge-vs-parse attribution is preserved either way.
        try {
          resolve(deriveScipDumpEdges(filePath))
        } catch (derivationError) {
          reject(derivationError)
        }
      })
    })
    worker.on('exit', (code: number) => {
      settle(() =>
        reject(new Error(`SCIP parse worker exited with code ${code}`)),
      )
    })
    worker.postMessage(filePath)
  })
}

async function runSingleIndexer(
  root: string,
  entry: ScipIndexerCommand,
  runner: AsyncScipRunner,
  timeoutMs: number,
  nonce: string,
  maxEdges: number,
): Promise<{ status: ScipIndexerStatus; error?: string; edges?: IndexEdge[] }> {
  // The availability probe already ran (cached) for every candidate before
  // any indexer was launched, so no re-probe happens here.

  // 1. Run the indexer into its pre-arranged per-invocation temp output path.
  const outputPath = scipDumpPath(root, entry, nonce)
  try {
    await mkdir(path.dirname(outputPath), { recursive: true })
  } catch (error) {
    return {
      status: 'error',
      error: `failed to prepare dump directory: ${errorMessage(error)}`,
    }
  }

  let run: ScipRunnerResult
  try {
    run = await runner({
      command: entry.bin,
      argv: entry.indexArgv(root, outputPath),
      cwd: root,
      timeoutMs,
      maxBufferBytes: MAX_PROCESS_BUFFER_BYTES,
    })
  } catch (error) {
    return { status: 'error', error: `indexer invocation failed: ${errorMessage(error)}` }
  }
  if (run.status === null) {
    return { status: 'timeout', error: `${entry.bin} timed out after ${timeoutMs}ms` }
  }
  if (run.status !== 0) {
    return {
      status: 'error',
      error: `${entry.bin} exited with ${run.status}: ${stderrSnippet(run.stderr)}`,
    }
  }

  // 2. Locate and bound the dump by size before anything reads it.
  try {
    const stats = await stat(outputPath)
    if (stats.size > MAX_DUMP_BYTES) {
      return {
        status: 'error',
        error: `SCIP dump exceeds the ${MAX_DUMP_BYTES}-byte read cap`,
      }
    }
  } catch {
    return { status: 'error', error: `no SCIP dump found at ${outputPath}` }
  }

  // 3. Parse, validate, and derive OFF the event loop (perf:
  // scip-dump-json-parse-heap-spike): a near-cap 256MiB dump's JSON.parse
  // blocks the event loop for seconds and spikes the main-thread heap, and
  // validation plus edge derivation repeat the same O(dump) work, so the
  // whole front half runs in the parse worker and only the derived precise
  // edges cross back — the raw dump text and the intermediate parse graph
  // never touch the main thread.
  let edges: IndexEdge[]
  try {
    edges = await parseScipDumpEdges(outputPath)
  } catch (error) {
    // Derivation-stage failures (a document escaping the project root) keep
    // the merge attribution they had when this ran on-thread; every other
    // failure (unreadable file, malformed JSON, schema violation, worker
    // error, timeout) is a parse failure. Both fail open per indexer.
    if (error instanceof ScipDumpDerivationError && error.stage === 'derive') {
      return { status: 'error', error: `SCIP merge failed: ${error.message}` }
    }
    return {
      status: 'error',
      error: `failed to parse SCIP dump: ${errorMessage(error)}`,
    }
  }

  // 4. Bounded retention (perf: scip-premerge-edge-accumulation): a legitimate
  // near-cap dump can derive very large edge sets, so a dump whose edge count
  // already exceeds the merge cap fails HERE with the merge's own edge-limit
  // attribution instead of retaining every derived edge until the merge loop
  // throws and discards them.
  if (edges.length > maxEdges) {
    return {
      status: 'error',
      error: `SCIP merge failed: SCIP merge exceeded the cap of ${SCIP_MAX_MERGED_EDGES} edges`,
    }
  }
  return { status: 'ok', edges }
}

/**
 * Workspace-scoped temp directory for SCIP dumps, keyed by a sanitized
 * project-root name plus a per-`runScipIngest` invocation nonce: concurrent
 * invocations against the same root isolate their dumps in distinct
 * directories, so one run can never read another's partially written or
 * already-cleaned dump.
 */
function scipWorkspaceDir(root: string, nonce: string): string {
  const sanitized =
    root.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120) || 'project'
  return path.join(tmpdir(), 'openbuff-scip', sanitized, nonce)
}

function scipDumpPath(
  root: string,
  entry: ScipIndexerCommand,
  nonce: string,
): string {
  return path.join(scipWorkspaceDir(root, nonce), entry.id, entry.outputFile)
}

function clampIndexerCount(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return MAX_SCIP_INDEXERS_PER_CALL
  }
  return Math.min(MAX_SCIP_INDEXERS_PER_CALL, Math.max(1, Math.floor(value)))
}

/**
 * Bounded fan-out local to the indexer package (the SDK's shared helper lives
 * in a different package): at most `concurrency` mappers in flight, results
 * index-aligned. Mappers here never reject (runSingleIndexer fails open), so
 * no failure propagation is needed.
 */
async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      async () => {
        while (nextIndex < values.length) {
          const index = nextIndex++
          results[index] = await map(values[index]!)
        }
      },
    ),
  )
  return results
}

function stderrSnippet(stderr: string): string {
  return stderr.trim().replace(/\s+/g, ' ').slice(0, MAX_STDERR_SNIPPET)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
