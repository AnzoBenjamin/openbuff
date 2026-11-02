import { realClock } from '@codebuff/common/deps/real-runtime-deps'
import { MODEL_PAYLOAD_JSON_CHAR_LIMIT } from '@codebuff/common/util/model-payload-recovery'

// Shared parent-output budgets live in this leaf module so set_output can
// derive its salvage bounds without importing the agent loop through spawn.
export const PARENT_AGENT_OUTPUT_MAX_CHARS = 1_000_000
export const PARENT_AGENT_OUTPUT_STRING_CHARS = 16_000
export const PARENT_AGENT_OUTPUT_HIGH_FIDELITY_STRING_CHARS = 128_000

/**
 * ONE durable-artifact primitive for oversized payloads in this package.
 *
 * Before this module existed, `set-output.ts` and `spawn-agent-utils.ts` each
 * carried their own complete copy of the same capability: a 0o700 directory
 * under the OS temp dir holding 0o600 files, sha256-named artifacts, a 24h TTL
 * sweep, and a 50-entry per-call window. Both had already been through
 * independent reliability review, and they had drifted on every axis at once
 * (content-addressed names vs content-hash+uuid, cached vs uncached mkdir, a
 * persisted cursor vs a rotation counter, with and without a live-path
 * registry). That is the dependency-boundary cost the dependency-reviewer
 * flagged: a future fix to the TTL, the window, the permissions or the
 * pointer-record shape had to be applied twice, and nothing enforced it.
 *
 * This module is that shared primitive. Both call sites now go through it, so
 * there is exactly one place where the TTL, the window size, the permissions
 * and the retention bookkeeping live.
 *
 * Why the Node seam is lazy: `@codebuff/agent-runtime` has no dist —
 * `sdk/tsconfig.json` aliases its source and `sdk/scripts/build.ts` bundles it
 * into the published SDK for `target: 'node'` — so a top-level
 * `node:fs/promises` / `node:os` / `node:path` import would make merely LOADING
 * the central `set_output` handler require a full Node filesystem
 * implementation, even though every function here only runs for a payload that
 * is already oversized. `typeof import(...)` below is a TYPE-only query that
 * emits no runtime import; the handles are resolved on first actual use. A host
 * without Node built-ins gets `undefined` from the loader and every caller
 * degrades to its documented no-persist fallback instead of failing to load.
 */
export type OversizeArtifactFs = {
  tmpdir: typeof import('node:os').tmpdir
  join: typeof import('node:path').join
  mkdir: typeof import('node:fs/promises').mkdir
  readdir: typeof import('node:fs/promises').readdir
  stat: typeof import('node:fs/promises').stat
  unlink: typeof import('node:fs/promises').unlink
  writeFile: typeof import('node:fs/promises').writeFile
  readFile: typeof import('node:fs/promises').readFile
  createHash: typeof import('node:crypto').createHash
  randomUUID: typeof import('node:crypto').randomUUID
}

let oversizeArtifactFsPromise:
  | Promise<OversizeArtifactFs | undefined>
  | undefined

/**
 * Memoized loader for the Node built-ins this module needs.
 *
 * ONLY A SUCCESSFUL RESOLUTION IS CACHED. This promise is process-global state
 * serving two independent consumers (the `set_output` salvage and the
 * parent-output fallback), so caching a FAILURE would let one transient
 * dynamic-import rejection — a loader hook, an ESM interop error, a transient
 * `Promise.all` rejection — poison every later artifact persist for the
 * lifetime of the process: `set_output` would silently degrade to
 * `artifactPersisted: false` and spawn output would permanently lose its
 * recovery artifact, with no retry available. A failed resolution therefore
 * clears the memo so the NEXT call retries; the cache only ever holds handles
 * a host actually proved it has. `resetOversizeArtifactState()` also clears it,
 * so a test or a recovery path can reinstate the seam.
 *
 * The modules are imported INDEPENDENTLY: one failing import cannot void the
 * others, and the resolution reports `undefined` (every caller's documented
 * no-persist fallback) only for the handles that are genuinely unavailable.
 */
export function loadOversizeArtifactFs(): Promise<
  OversizeArtifactFs | undefined
> {
  if (oversizeArtifactFsPromise) return oversizeArtifactFsPromise
  const attempt = (async () => {
    try {
      const [fsPromises, os, pathModule, cryptoModule] = await Promise.all([
        import('node:fs/promises'),
        import('node:os'),
        import('node:path'),
        import('node:crypto'),
      ])
      return {
        tmpdir: os.tmpdir,
        join: pathModule.join,
        mkdir: fsPromises.mkdir,
        readdir: fsPromises.readdir,
        stat: fsPromises.stat,
        unlink: fsPromises.unlink,
        writeFile: fsPromises.writeFile,
        readFile: fsPromises.readFile,
        createHash: cryptoModule.createHash,
        randomUUID: cryptoModule.randomUUID,
      } satisfies OversizeArtifactFs
    } catch {
      return undefined
    }
  })().then(
    (resolved) => {
      // Cache the SUCCESS only: a failure must stay retryable, so drop the memo
      // before any awaiting caller maps it to its no-persist fallback.
      if (!resolved && oversizeArtifactFsPromise === attempt) {
        oversizeArtifactFsPromise = undefined
      }
      return resolved
    },
    () => {
      if (oversizeArtifactFsPromise === attempt) {
        oversizeArtifactFsPromise = undefined
      }
      return undefined
    },
  )
  oversizeArtifactFsPromise = attempt
  return attempt
}

/**
 * Retention bound shared by every artifact directory: an artifact whose mtime
 * is older than this is reclaimable. It is also the retention FLOOR a returned
 * artifact pointer implies — nothing inside the TTL is ever deleted, so a
 * consumer that reads a pointer later still finds the file.
 */
export const OVERSIZE_ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Per-call sweep window. The work per sweep is BOUNDED AND STATED rather than
 * claimed O(1): one directory listing (the OS returns every name in a single
 * call, so O(entries) names are scanned) plus at most this many mtime stats and
 * at most as many unlinks. Every filesystem call is asynchronous, so a sweep
 * never blocks the tool loop that triggered it.
 */
export const OVERSIZE_ARTIFACT_SWEEP_MAX_ENTRIES = 50

/**
 * LAST-RESORT bound on the number of protected artifact paths.
 *
 * Count is deliberately NOT the primary retention mechanism. Protection is
 * REFCOUNTED per path and, when a pointer names an owning record set (an agent
 * identity), tied to that record set's lifetime: eviction SKIPS entries whose
 * owner is still live, so a fan-out larger than this number can no longer
 * silently de-protect a pointer handed out earlier (which the sweep in the very
 * next persist then unlinked, exactly as the parent was about to read it). The
 * bounded map stays finite because an owner's release path
 * (`releaseLiveArtifactsForOwner`) turns its entries into eviction candidates,
 * and `LIVE_ARTIFACT_HARD_LIMIT` remains the absolute ceiling.
 */
const LIVE_ARTIFACT_LIMIT = 64

/**
 * Absolute ceiling, applied even to entries whose owning record set is still
 * live. Reaching it means a process is holding this many DISTINCT live pointers
 * at once, which is the one case where the count bound still wins.
 */
const LIVE_ARTIFACT_HARD_LIMIT = LIVE_ARTIFACT_LIMIT * 4

/**
 * Clock-skew margin added to the TTL before the sweep will delete anything.
 *
 * The live-path registry is PER PROCESS, so a sibling process (a second SDK
 * instance, a supervised child, or a second settle after a reset) that sweeps
 * with a slightly-ahead clock can otherwise reclaim an artifact this process
 * just wrote and handed out. Refusing to delete anything younger than
 * `TTL + SANE_SKEW` makes an ahead clock harmless: the file simply becomes
 * reclaimable a minute later.
 */
export const OVERSIZE_ARTIFACT_SWEEP_SKEW_MS = 60_000

/**
 * Bookkeeping for the shared artifact directories.
 *
 * Every mutation below is SYNCHRONOUS — there is no `await` between a read and
 * the matching write — which makes each one atomic on the event loop for EVERY
 * caller without requiring a lock. That is deliberate:
 *
 *  - A process-global async mutex around the persist would have to cover the
 *    payload write itself. Subagent fan-out is exactly the case oversized
 *    payloads exist for, so serializing that I/O would turn aggregate latency
 *    from max(write_i) into sum(write_i) and let one slow filesystem call block
 *    every other child's write. None of the filesystem I/O needs a critical
 *    section; only these maps do.
 *  - The sweep cursor is reserved BEFORE the first await, so two interleaved
 *    sweeps of the same directory receive distinct cursors and therefore
 *    distinct windows rather than stat-ing the same up-to-50 entries twice.
 */
const sweepCursors = new Map<string, number>()

/**
 * In-flight DETACHED sweeps.
 *
 * Declared here (before `resetOversizeArtifactState` reads it) so no module
 * initializer can observe it in the temporal dead zone. Kept only so a caller
 * that needs the sweep's effect observable (retention fixtures, shutdown) can
 * join it; nothing in the persist path awaits it. Entries remove themselves on
 * settle, so this set never grows with process history.
 */
const pendingOversizeArtifactSweeps = new Set<Promise<void>>()

function trackOversizeArtifactSweep(sweep: Promise<void>): void {
  pendingOversizeArtifactSweeps.add(sweep)
  void sweep.finally(() => pendingOversizeArtifactSweeps.delete(sweep))
}

/**
 * Await every detached TTL sweep currently in flight.
 *
 * NOT part of any tool or settle path: it exists so a caller that needs the
 * sweep's effect to be visible (retention fixtures, shutdown) can join it
 * explicitly. Production persists never await it.
 */
export async function flushOversizeArtifactSweeps(): Promise<void> {
  const sweeps = [...pendingOversizeArtifactSweeps]
  if (sweeps.length === 0) return
  await Promise.allSettled(sweeps)
}

/**
 * One protected artifact path.
 *
 * `refs` is the number of published pointers that name this path. It exists
 * because the same content-addressed path can be handed out more than once:
 * with a single boolean-ish entry, one holder forgetting the path (a later
 * compaction of identical content, the release of a discarded record) removed
 * protection for EVERY holder, and the next sweep unlinked a file an earlier,
 * still-valid receipt pointed at. `remember`/`forget` are balanced per
 * published pointer, so protection lasts until the LAST holder lets go.
 *
 * `owner` is the record set (agent identity) the pointer belongs to. Eviction
 * skips entries whose owner is still live, so protection survives count
 * pressure instead of being voided by it, and `owner` gives a disposed or
 * cancelled agent a deterministic release path.
 */
type LiveArtifactEntry = {
  refs: number
  rememberedAt: number
  owner?: string
}

/**
 * Artifact paths still referenced by a record handed out by this process. The
 * sweep skips them so a returned pointer cannot be deleted underneath the
 * consumer about to read it. Protection is bounded on BOTH axes: by refcount
 * first (a path stays protected while any published pointer names it), by count
 * only as a last resort (oldest-first eviction in Map insertion order, which
 * needs no sort), and by time (an entry past the TTL is dropped on read, so
 * protection can never outlive the documented retention).
 */
const liveArtifactPaths = new Map<string, LiveArtifactEntry>()

/**
 * Owner record sets whose pointers have been released. An entry belonging to a
 * released owner is an eviction candidate even if it is still refcounted, so
 * retention tracks live records rather than accumulated process history.
 */
const releasedArtifactOwners = new Set<string>()

/**
 * How many entries in `liveArtifactPaths` are actual eviction CANDIDATES (an
 * entry with no owner, or whose owner has been released).
 *
 * Maintained incrementally so `rememberLiveArtifact` can answer "is there
 * anything evictable?" in O(1). Without it, every persist above
 * `LIVE_ARTIFACT_LIMIT` snapshotted the whole map, skipped every still-live
 * entry and evicted nothing — so during a wide fan-out each of N persists paid
 * O(map size) and the map only shrank at the 4x hard ceiling. The amortized
 * per-persist bookkeeping is O(1) again on the path that exists for fan-out.
 */
let evictableLiveArtifactCount = 0

function isEvictableOwner(owner: string | undefined): boolean {
  return owner === undefined || releasedArtifactOwners.has(owner)
}

/**
 * Mark an artifact as referenced by a live record. Re-remembering an existing
 * path moves it to the tail so insertion order keeps meaning "oldest first",
 * and INCREMENTS its refcount instead of overwriting the single entry.
 *
 * `now` is the registration stamp when the caller supplies one (the persist
 * path passes its own `options.now`, matching this signature); it is CLAMPED to
 * the process clock so an ahead clock (an injected future value in a test, a
 * host with a skew, a fixed `now` threaded from a serialized state) can never
 * extend protection past the process's own view of the TTL. A caller clock from
 * the future therefore protects rather than de-protects the pointer.
 *
 * `owner` pins the entry to a record set's lifetime: eviction skips owners that
 * have not been released, so count pressure cannot silently void the retention
 * promise for a pointer already handed out.
 */
export function rememberLiveArtifact(
  artifactPath: string,
  now?: number,
  owner?: string,
): void {
  const existing = liveArtifactPaths.get(artifactPath)
  const processNow = realClock.now()
  // Delete before set so a re-remembered path really moves to the tail.
  liveArtifactPaths.delete(artifactPath)
  if (existing !== undefined && isEvictableOwner(existing.owner)) {
    evictableLiveArtifactCount -= 1
  }
  const nextOwner = owner ?? existing?.owner
  liveArtifactPaths.set(artifactPath, {
    refs: (existing?.refs ?? 0) + 1,
    rememberedAt: Math.min(now ?? processNow, processNow),
    owner: nextOwner,
  })
  if (isEvictableOwner(nextOwner)) evictableLiveArtifactCount += 1
  // A re-remembered pointer makes its owner live again, so re-check the other
  // entries that owner still holds: they just stopped being candidates.
  if (owner !== undefined) releasedArtifactOwners.delete(owner)
  const excess = liveArtifactPaths.size - LIVE_ARTIFACT_LIMIT
  if (excess <= 0) return
  // O(1) fast path: nothing is evictable, so the snapshot below could not
  // remove anything. Skip it and let the hard-ceiling branch (inside
  // evictLiveArtifacts) decide. This is the wide-fan-out case that used to
  // rebuild the whole map on every persist.
  if (evictableLiveArtifactCount <= 0) return
  evictLiveArtifacts(excess)
}

/**
 * Bounded, DETERMINISTIC eviction.
 *
 * The candidate list is snapshotted FIRST (`[...liveArtifactPaths.entries()]`)
 * and deletions are applied from that snapshot, so the number of entries
 * removed is exactly the number chosen here. Deleting from a Map while
 * iterating its own `keys()` made the count depend on interleavings with a
 * concurrent re-remember, which is unobservable and untestable.
 *
 * Entries whose owning record set is still live are skipped: they are not the
 * primary bound. Only when the absolute ceiling is reached does the count cap
 * win over an unreleased owner.
 */
function evictLiveArtifacts(excess: number): void {
  let remaining = excess
  const snapshot = [...liveArtifactPaths.entries()]
  for (const [stalePath, entry] of snapshot) {
    if (remaining <= 0) return
    if (!isEvictableOwner(entry.owner)) continue
    liveArtifactPaths.delete(stalePath)
    evictableLiveArtifactCount -= 1
    remaining -= 1
  }
  if (remaining <= 0) return
  // Last resort: even owned entries are evicted, oldest first, and only while
  // the map is above the absolute ceiling.
  for (const [stalePath, entry] of snapshot) {
    if (liveArtifactPaths.size <= LIVE_ARTIFACT_HARD_LIMIT) return
    if (!liveArtifactPaths.has(stalePath)) continue
    if (isEvictableOwner(entry.owner)) evictableLiveArtifactCount -= 1
    liveArtifactPaths.delete(stalePath)
  }
}

/**
 * Drop ONE reference to an artifact's protection. Protection is balanced per
 * published pointer, so a holder letting go cannot de-protect a path another
 * holder still names; the entry disappears once its last reference is gone.
 * Called when the record naming it is superseded or discarded, so the map
 * tracks live records rather than process history.
 */
export function forgetLiveArtifact(artifactPath: string): void {
  const entry = liveArtifactPaths.get(artifactPath)
  if (!entry) return
  if (entry.refs > 1) {
    liveArtifactPaths.set(artifactPath, { ...entry, refs: entry.refs - 1 })
    return
  }
  if (isEvictableOwner(entry.owner)) evictableLiveArtifactCount -= 1
  liveArtifactPaths.delete(artifactPath)
}

/**
 * Release EVERY artifact protected on behalf of one record set (an agent
 * identity). Production callers invoke this when a child's agent state is
 * disposed or its spawn is cancelled, so retention follows LIVE records instead
 * of accumulated process history and a cancelled agent cannot pin artifacts the
 * sweep is entitled to reclaim.
 */
export function releaseLiveArtifactsForOwner(owner: string): void {
  releasedArtifactOwners.add(owner)
  for (const [artifactPath, entry] of [...liveArtifactPaths]) {
    if (entry.owner !== owner) continue
    // These entries were NOT candidates before the release, so they do not
    // change the evictable count when they leave.
    liveArtifactPaths.delete(artifactPath)
  }
}

/**
 * Introspection for the retention fixtures: the protected paths in insertion
 * order (oldest first). Exposed so the FIFO/refcount claims are verifiable at
 * runtime instead of by source-text matching.
 */
export function inspectLiveArtifactPaths(): string[] {
  return [...liveArtifactPaths.keys()]
}

/**
 * Whether a path is still protected by a live record inside the TTL.
 *
 * Evaluated on the SAME internal clock `rememberLiveArtifact` stamped with, so
 * protection for a pointer handed out by this process can never be expired by
 * a skewed or injected caller clock.
 */
function isLiveArtifact(artifactPath: string): boolean {
  const entry = liveArtifactPaths.get(artifactPath)
  if (entry === undefined) return false
  if (realClock.now() - entry.rememberedAt <= OVERSIZE_ARTIFACT_TTL_MS)
    return true
  if (isEvictableOwner(entry.owner)) evictableLiveArtifactCount -= 1
  liveArtifactPaths.delete(artifactPath)
  return false
}

/**
 * Reset ALL module-level state: the retention bookkeeping (sweep rotation
 * cursors, the live-path/refcount registry and the released-owner set) AND the
 * lazily resolved Node handles. Disposal of a single record set goes through
 * `releaseLiveArtifactsForOwner`; this reset is for tests and recovery paths so
 * assertions never depend on ordering-dependent global state left by an earlier
 * test, and so the loader seam can be reinstated.
 */
export function resetOversizeArtifactState(): void {
  sweepCursors.clear()
  liveArtifactPaths.clear()
  evictableLiveArtifactCount = 0
  releasedArtifactOwners.clear()
  pendingOversizeArtifactSweeps.clear()
  oversizeArtifactFsPromise = undefined
}

export type OversizeArtifactSweepOptions = {
  /** Absolute path of the artifact just written; never deleted by this call. */
  protect?: string
  /** Current time in epoch ms, used for both the TTL and the cursor window. */
  now: number
  /**
   * Cancellation hook. Checked before the listing and before every unlink, so a
   * cancelled child stops paying for I/O it will discard.
   */
  signal?: AbortSignal
}

/**
 * Bounded, best-effort TTL sweep for one artifact directory.
 *
 * Deletion is decided by an MTIME CHECK ALONE, never by a recorded listing
 * position, and two paths are always spared: `protect` (the artifact the
 * caller just wrote) and anything a live record still points at. The window
 * start is `(cursor * WINDOW) % entries`, i.e. a pure forward counter with no
 * time-derived jitter, so consecutive sweeps walk disjoint windows and every
 * entry is visited within `ceil(entries / WINDOW)` calls — a property a
 * fixed-baseline directory fixture can verify.
 *
 * Never throws: a failed sweep must never fail the persist that triggered it
 * nor the tool call carrying the resulting record.
 */
export async function sweepExpiredArtifacts(
  fsModule: OversizeArtifactFs,
  dir: string,
  options: OversizeArtifactSweepOptions,
): Promise<void> {
  const { now, protect, signal } = options
  if (signal?.aborted) return
  // Reserve this call's window SYNCHRONOUSLY, before the first await, so
  // concurrent sweeps of the same directory get distinct cursors instead of
  // stat-ing the SAME entries and leaving the rest unvisited.
  const cursor = sweepCursors.get(dir) ?? 0
  sweepCursors.set(dir, cursor + 1)
  try {
    // Snapshot the listing FIRST so the unlinks below cannot mutate the
    // iteration mid-loop.
    const allEntries = await fsModule.readdir(dir)
    if (allEntries.length === 0) return
    const windowSize = Math.min(
      OVERSIZE_ARTIFACT_SWEEP_MAX_ENTRIES,
      allEntries.length,
    )
    // Wrapping modular window: a short (or shrinking) directory still yields a
    // full contiguous window instead of a truncated tail that later calls never
    // revisit.
    const startIndex =
      (cursor * OVERSIZE_ARTIFACT_SWEEP_MAX_ENTRIES) % allEntries.length
    for (let offset = 0; offset < windowSize; offset += 1) {
      if (signal?.aborted) return
      const entry = allEntries[(startIndex + offset) % allEntries.length]
      if (entry === undefined || !entry.endsWith('.json')) continue
      const filePath = fsModule.join(dir, entry)
      if (filePath === protect) continue
      if (isLiveArtifact(filePath)) continue
      let mtimeMs: number
      try {
        mtimeMs = (await fsModule.stat(filePath)).mtimeMs
      } catch {
        // Best-effort per entry: a raced deletion or EACCES on one file must
        // not stop the sweep.
        continue
      }
      // The TTL carries a SKEW margin, so a caller (or a sibling process) whose
      // clock runs ahead can never reclaim an artifact written moments ago by
      // another consumer sharing this directory.
      if (
        now - mtimeMs <=
        OVERSIZE_ARTIFACT_TTL_MS + OVERSIZE_ARTIFACT_SWEEP_SKEW_MS
      ) {
        continue
      }
      // Re-check liveness as close to the unlink as possible: the first check
      // happened before the `stat` await, and a `rememberLiveArtifact` in that
      // window (a record published concurrently by another caller) must still
      // win. Only a path that was NOT live at snapshot time AND is still not
      // live at unlink time is deleted.
      if (isLiveArtifact(filePath)) continue
      try {
        await fsModule.unlink(filePath)
        const swept = liveArtifactPaths.get(filePath)
        if (swept !== undefined && isEvictableOwner(swept.owner)) {
          evictableLiveArtifactCount -= 1
        }
        liveArtifactPaths.delete(filePath)
      } catch {
        // Best-effort per entry.
      }
    }
  } catch {
    // Best-effort: a failed sweep never fails the persist.
  }
}

export type OversizeArtifactDirOptions = {
  /**
   * Directory name under the OS temp dir. Kept per capability so the two
   * callers stay inspectable on their own.
   */
  dirName: string
  /**
   * `unique` (default) suffixes a per-call uuid onto the content hash, so a
   * returned path is uniquely OWNED by the record that names it and one
   * record's sweep can never invalidate another's pointer. `content-addressed`
   * keeps the historical bare-sha256 name used by the parent-output artifact,
   * where the same bytes deliberately map to the same path.
   */
  naming?: 'unique' | 'content-addressed'
}

export type PersistedOversizeArtifact = {
  artifactPath: string
  createdAt: string
}

/**
 * Whether `artifactPath` exists and is readable, used to recognize an
 * IDEMPOTENT re-persist: under `content-addressed` naming the same bytes map to
 * the same path, and a prior attempt may already have written it.
 */
async function isReadableArtifact(
  fsModule: OversizeArtifactFs,
  artifactPath: string,
  serialized: string,
): Promise<boolean> {
  try {
    const metadata = await fsModule.stat(artifactPath)
    if (
      !metadata.isFile() ||
      metadata.size !== Buffer.byteLength(serialized, 'utf8')
    )
      return false
    // A failed exclusive write can leave a partial file. Existence alone must
    // not turn a later retry into a successful, corrupt recovery pointer.
    return (await fsModule.readFile(artifactPath, 'utf8')) === serialized
  } catch {
    return false
  }
}

/**
 * Whether a write rejection is the `wx` already-exists case. Node reports it as
 * an `fs` error carrying `code: 'EEXIST'`; anything else is a genuine failure
 * and keeps the caller's documented no-persist fallback.
 */
function isAlreadyExistsError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === 'EEXIST'
  )
}

/** Directory holding the artifacts for one capability. */
export function oversizeArtifactDir(
  fsModule: OversizeArtifactFs,
  dirName: string,
): string {
  return fsModule.join(fsModule.tmpdir(), dirName)
}

/**
 * Persist an oversized payload verbatim to an owner-only artifact, then run
 * the bounded TTL sweep for that directory.
 *
 * Security: the directory is created 0o700 and each file written 0o600
 * regardless of the process umask, so untruncated model output sitting in a
 * shared temp directory stays readable only by this user.
 *
 * `tmpdir()` is resolved on every call and the `mkdir` is deliberately
 * UNCACHED: persistence rate is bounded by the payload threshold that got us
 * here, so one extra syscall is free, and re-resolving is what lets a TMPDIR
 * override (tests included) or a temp dir deleted out from under the process
 * self-heal on the next call instead of needing a cache reset.
 *
 * IDEMPOTENT under `content-addressed` naming: a `wx` write that hits an
 * existing path is verified readable and treated as a SUCCESSFUL persist (with
 * liveness re-registered for it) instead of returning `undefined`. That is the
 * property that motivated content addressing — a retry of the same bytes must
 * reuse the artifact already on disk, not degrade to the lossy
 * `artifactPersisted: false` diagnostic.
 *
 * `signal` is checked before the write and before the sweep, so a cancelled
 * child does not pay for I/O it will discard, and `owner` pins the resulting
 * liveness entry to the owning record set so its release is deterministic.
 *
 * Returns `undefined` on ANY error (or cancellation); callers then degrade to
 * their documented no-persist fallback rather than failing the tool call.
 */
export async function persistOversizeArtifact(
  serialized: string,
  contentHash: string,
  options: OversizeArtifactDirOptions & {
    now: number
    /** Record set (agent identity) the published pointer belongs to. */
    owner?: string
    /** Cancellation hook; aborts the write and the sweep. */
    signal?: AbortSignal
  },
): Promise<PersistedOversizeArtifact | undefined> {
  const { owner, signal } = options
  if (signal?.aborted) return undefined
  const fsModule = await loadOversizeArtifactFs()
  if (!fsModule) return undefined
  const dir = oversizeArtifactDir(fsModule, options.dirName)
  let artifactPath: string
  // Whether THIS call created the file. Only a fresh write is worth paying for
  // a directory listing + stat window: an idempotent hit means nothing new
  // appeared, so the amortized sweep cost per persist stays O(1).
  let createdArtifact = true
  try {
    await fsModule.mkdir(dir, { recursive: true, mode: 0o700 })
    artifactPath = fsModule.join(
      dir,
      options.naming === 'content-addressed'
        ? `${contentHash}.json`
        : `${contentHash}-${fsModule.randomUUID()}.json`,
    )
    try {
      await fsModule.writeFile(artifactPath, serialized, {
        mode: 0o600,
        flag: 'wx',
      })
    } catch (error) {
      // Only the content-addressed naming is idempotent: the same bytes
      // deliberately map to the same path, so an existing readable file IS this
      // persist's artifact. `unique` names carry a fresh uuid, so an EEXIST
      // there is a genuine failure.
      if (
        options.naming !== 'content-addressed' ||
        !isAlreadyExistsError(error) ||
        !(await isReadableArtifact(fsModule, artifactPath, serialized))
      ) {
        return undefined
      }
      createdArtifact = false
    }
  } catch {
    return undefined
  }
  // Synchronous registration: it completes before this call yields back to the
  // event loop, so neither this call's sweep below nor any concurrent sweep can
  // observe the protection map half-built for this path. Registration is
  // stamped with this call's `options.now` (see `rememberLiveArtifact`) and
  // keyed to the owning record set when one was supplied.
  rememberLiveArtifact(artifactPath, options.now, owner)
  if (createdArtifact && !signal?.aborted) {
    // The sweep is STARTED, not awaited, so this persist's latency is
    // WRITE-BOUND: a caller's `set_output` (and the settle boundary that awaits
    // it) pays one write, never one write + a directory listing + up to
    // OVERSIZE_ARTIFACT_SWEEP_MAX_ENTRIES stat calls. That aggregate is exactly
    // what this module's design note says must not be imported into the
    // fan-out hot path, and `unique` naming means every salvage persist is a
    // fresh create that would otherwise always sweep.
    //
    // The sweep still runs — retention is not weakened — it just runs detached
    // and best-effort (it never throws). It reserves its own window cursor
    // synchronously before its first await, so concurrent detached sweeps of
    // the same directory walk DISJOINT windows instead of stat-ing the same
    // entries. `protect` keeps the artifact just written out of this window.
    // `flushOversizeArtifactSweeps()` is the join point for a caller (or a
    // fixture) that needs the sweep's effect observable.
    trackOversizeArtifactSweep(
      sweepExpiredArtifacts(fsModule, dir, {
        now: options.now,
        protect: artifactPath,
        signal,
      }),
    )
  }
  return { artifactPath, createdAt: new Date(options.now).toISOString() }
}

/**
 * Content identity (sha256) of a payload, resolved through the same lazy seam
 * so no `node:crypto` import sits at module scope. Resolves to `undefined` on a
 * host without Node built-ins, where callers take their no-persist fallback.
 */
export async function hashOversizeArtifactPayload(
  payload: string,
): Promise<string | undefined> {
  const fsModule = await loadOversizeArtifactFs()
  if (!fsModule) return undefined
  try {
    return fsModule.createHash('sha256').update(payload).digest('hex')
  } catch {
    return undefined
  }
}

/**
 * Release an artifact that was WRITTEN but never referenced by a stored
 * record. Nothing downstream names it, so keeping it would pin a full copy
 * against the TTL sweep for 24h.
 *
 * Ordering matters: the unlink happens FIRST and protection is dropped in a
 * `finally`. Forgetting first left a window in which a competing sweep could
 * pass its own liveness check for the same path (or observe the path
 * unregistered) and unlink concurrently, so the liveness map provided no mutual
 * exclusion exactly where it was needed. Because the filename carries a
 * per-salvage uuid, dropping protection after the delete has no downside: the
 * path is uniquely owned by the record being released.
 */
export async function releaseUnreferencedArtifact(
  artifactPath: string,
): Promise<void> {
  try {
    const fsModule = await loadOversizeArtifactFs()
    if (fsModule) await fsModule.unlink(artifactPath)
  } catch {
    // Best-effort: nothing downstream references the path.
  } finally {
    forgetLiveArtifact(artifactPath)
  }
}

/**
 * The parse bound every oversized payload in this package is measured against.
 * Re-exported here so the artifact primitive and its fixtures share one source
 * rather than each restating the number.
 */
export const MAX_OVERSIZE_PAYLOAD_CHARS = MODEL_PAYLOAD_JSON_CHAR_LIMIT
