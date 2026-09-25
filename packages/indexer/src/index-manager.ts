import { buildMetadataIndex, updateMetadataIndex } from './metadata-indexer'
import {
  computeIndexSnapshotId,
  isIndexReady,
  isIndexStale,
  getIndexDir,
  loadIndex,
  loadSemanticVectors,
  saveIndex,
  saveSemanticVectors,
} from './index-store'
import { queryIndex, type QueryOptions } from './query'
import {
  buildFileVectors,
  getSemanticConfigFingerprint,
  semanticSearch,
  blendSemanticScores,
} from './semantic'
import type { EmbedFn, FileVector, SemanticHit } from './semantic'
import type {
  IndexingConfig,
  IndexBuildError,
  IndexMutationDelta,
  IndexSnapshotIdentity,
  IndexStatus,
  LexicalWeights,
  MetadataIndex,
  QueryIndexMode,
  QueryIndexResult,
} from './types'
import { compareRevisions } from './metadata-indexer'

export class IndexManager {
  // Bounded LRU-ish (FIFO) cache of per-project-root singletons. Prevents
  // unbounded growth when many distinct project roots are indexed in one
  // long-lived process. Insertion order = recency; oldest entry evicted on
  // overflow.
  private static instances = new Map<string, IndexManager>()
  private static readonly MAX_INSTANCE_ROOTS = 8

  private index: MetadataIndex | null = null
  private buildPromise: Promise<void> | null = null
  private lastBuildAttempt = 0
  private forceRefresh = false
  private staleRefreshPending = false
  private embed?: EmbedFn
  private fileVectors: FileVector[] = []
  private lastBuildError: IndexBuildError | undefined
  private pendingMutationDelta: IndexMutationDelta | undefined
  private mutationEpoch = 0
  /**
   * P8.1: bound on parserDegraded delta re-queueing — the currently pending
   * mutation signal may be re-queued at most once; the guard resets only
   * when a new signal arrives or a non-degraded refresh persists.
   */
  private degradedDeltaRequeued = false
  private snapshotCache:
    | { index: MetadataIndex; identity: IndexSnapshotIdentity }
    | undefined
  private readonly MIN_RETRY_INTERVAL_MS = 30_000
  /** Registry key this instance was created under (see {@link getInstanceKey}). */
  private readonly instanceKey: string

  private constructor(
    private readonly projectRoot: string,
    private readonly config: IndexingConfig,
  ) {
    this.instanceKey = IndexManager.getInstanceKey(projectRoot, config)
  }

  static getInstance(
    projectRoot: string,
    config: IndexingConfig = {},
    embed?: EmbedFn,
  ): IndexManager {
    const key = IndexManager.getInstanceKey(projectRoot, config)
    let instance = IndexManager.instances.get(key)
    if (!instance) {
      // Evict the oldest entry when the per-root singleton cache is full so a
      // long-lived process indexing many distinct project roots can't grow it
      // without bound. Map keys iterate in insertion order.
      if (IndexManager.instances.size >= IndexManager.MAX_INSTANCE_ROOTS) {
        const oldestKey = IndexManager.instances.keys().next().value
        if (oldestKey !== undefined) {
          IndexManager.instances.delete(oldestKey)
        }
      }
      instance = new IndexManager(projectRoot, config)
      IndexManager.instances.set(key, instance)
    }
    // Wire an embedder the first time one is supplied (the CLI builds it from
    // the BYOK provider config). Kept out of the instance key so providing it
    // does not fork the singleton.
    if (embed && !instance.embed) {
      instance.embed = embed
      if (instance.index && instance.config.semantic?.enabled) {
        instance.fileVectors = []
        instance.forceRefresh = true
        instance.ensureBuilt()
      }
    }
    return instance
  }

  private static getInstanceKey(
    projectRoot: string,
    config: IndexingConfig,
  ): string {
    return JSON.stringify({
      projectRoot,
      enabled: config.enabled ?? true,
      cacheDir: config.cacheDir ?? '.codebuff-index',
      exclude: config.exclude ?? [],
      semantic: {
        enabled: config.semantic?.enabled ?? false,
        model: config.semantic?.model,
      },
      maxFiles: config.maxFiles ?? 20_000,
      weights: config.weights ?? null,
    })
  }

  /**
   * Start building the index in the background. Safe to call multiple times.
   * Returns immediately without blocking.
   */
  ensureBuilt(): void {
    // Detached-instance gate (reliability finding
    // detached-index-manager-still-runs-own-build-loop): a holder evicted
    // from the registry must not run a second _build loop against the same
    // cache directory — forward to the registered singleton instead.
    const registered = IndexManager.instances.get(this.instanceKey)
    if (registered && registered !== this) {
      // Preserve this holder's accumulated state before delegating (a delta
      // queued while the holder was detached must reach the singleton that
      // answers queries, and a path-less stale signal must not be silently
      // dropped) and mirror the singleton's post-forward epoch onto this
      // holder so per-instance epochs stay equal (reliability findings
      // detached-indexmanager-pending-delta-dropped-on-forward /
      // ensurebuilt-forward-no-epoch-mirror).
      this.forwardPendingMutationsTo(registered)
      registered.ensureBuilt()
      return
    }
    if (this.config.enabled === false) return
    if (this.config.semantic?.enabled && !this.embed) {
      console.debug(
        '[indexer] semantic indexing is enabled but no embedder was provided; using metadata index only.',
      )
    }
    if (this.buildPromise) return
    if (
      !this.forceRefresh &&
      Date.now() - this.lastBuildAttempt < this.MIN_RETRY_INTERVAL_MS
    ) {
      return
    }
    const staleRefresh = this.forceRefresh
    const mutationDelta = this.pendingMutationDelta
    this.forceRefresh = false
    this.pendingMutationDelta = undefined
    this.staleRefreshPending = staleRefresh
    this.buildPromise = this._build(mutationDelta).finally(() => {
      this.buildPromise = null
      this.staleRefreshPending = false
    })
  }

  /**
   * Monotonic in-process epoch incremented on every filesystem-mutation
   * signal ({@link markStale} / {@link markPathsChanged}). Readonly and never
   * persisted: it lets callers (e.g. the query_index tool result) detect
   * external index mutations that did not advance a workspace revision.
   */
  get indexMutationEpoch(): number {
    return this.mutationEpoch
  }

  /**
   * Advance this holder's epoch after forwarding a mutation signal to the
   * registered singleton (see {@link markStale}). The pre-forward epoch is
   * read exactly once and the write is derived from that single captured
   * value, so the read-modify-write on the shared field is one atomic step:
   * two concurrent forwarded signals (or a forwarded signal racing a local
   * mutation) can never both read the same pre-forward epoch and collapse
   * two distinct mutation signals into a single advance of the documented
   * strictly-monotonic per-instance epoch (reliability finding
   * detached-epoch-forward-not-atomic).
   */
  private advanceEpochAfterForward(singletonEpoch: number): void {
    const epochBeforeForward = this.mutationEpoch
    this.mutationEpoch = Math.max(epochBeforeForward + 1, singletonEpoch)
  }

  /**
   * Forward a detached holder's accumulated mutation state to the registered
   * singleton and mirror its post-signal epoch. Shared by every detached
   * forward path (ensureBuilt, waitUntilReady, query, queryBlended) so a
   * delta queued while the holder was detached reaches the singleton even
   * when callers only use the query/readiness paths — only ensureBuilt
   * drained this state before, so a holder whose callers never call
   * ensureBuilt left the singleton answering from a snapshot that never saw
   * the queued delta (reliability finding
   * detached-query-forward-skips-pending-drain). The forwarded signal
   * advances the singleton's epoch, so the holder mirrors the singleton's
   * post-forward epoch via {@link advanceEpochAfterForward} exactly like the
   * markStale/markPathsChanged forward paths (reliability finding
   * ensurebuilt-forward-no-epoch-mirror).
   */
  private forwardPendingMutationsTo(registered: IndexManager): void {
    const pendingDelta = this.pendingMutationDelta
    const holdersForceRefresh = this.forceRefresh
    this.pendingMutationDelta = undefined
    this.forceRefresh = false
    if (pendingDelta) {
      registered.markPathsChanged(pendingDelta)
    } else if (holdersForceRefresh) {
      registered.markStale()
    } else {
      // Nothing to forward: no signal advanced the singleton, so the epoch
      // mirror must not pretend one did.
      return
    }
    this.advanceEpochAfterForward(registered.indexMutationEpoch)
  }

  /**
   * Signal that on-disk files changed (e.g. the agent just edited code), so the
   * next {@link waitUntilReady}/{@link query} performs an incremental refresh
   * even if the index is not yet time-stale. Cheap and path-less: the
   * incremental update detects exactly which files changed by mtime/hash.
   */
  markStale(): void {
    // Race fix: a detached instance (evicted from the registry but still held
    // by a caller) must not run its own build loop against the same cache
    // directory — two _build loops would race and the detached instance's
    // freshness signals would never reach the instance answering queries.
    // Forward the mutation signal to the registered singleton instead.
    const registered = IndexManager.instances.get(this.instanceKey)
    if (registered && registered !== this) {
      // The epoch contract is per-instance: a caller holding a detached
      // instance observes the mutation via the epoch on the instance it
      // holds. Forward first, then MIRROR the singleton's post-signal epoch:
      // a blind +1 on a counter that never agreed with the singleton's
      // before the call diverges monotonically with every forwarded signal,
      // so consumers comparing epochs across instances see a permanent,
      // growing offset (reliability findings
      // instance-registry-unbounded-detached-fanout /
      // detached-instance-epoch-divergence).
      registered.markStale()
      // Adopt the singleton's post-signal epoch only when it is ahead of
      // this holder's next epoch: a restarted singleton (fresh instance
      // after registry eviction) starts at 0, and mirroring it verbatim
      // would move this holder's monotonic epoch backwards on the first
      // forward (reliability finding detached-epoch-mirror-can-regress).
      this.advanceEpochAfterForward(registered.indexMutationEpoch)
      return
    }
    this.mutationEpoch += 1
    this.pendingMutationDelta = undefined
    this.forceRefresh = true
  }

  /** Queue a precise filesystem mutation delta for the next refresh. */
  markPathsChanged(delta: IndexMutationDelta): void {
    // Forward from a detached instance to the registered singleton, mirroring
    // markStale above.
    const registered = IndexManager.instances.get(this.instanceKey)
    if (registered && registered !== this) {
      // Merge any delta accumulated on this holder before the forward so
      // mutation signals queued while the holder was detached still reach
      // the singleton that answers queries (reliability finding
      // detached-indexmanager-pending-delta-dropped-on-forward). Mirror
      // markStale above: forward first, then mirror the singleton's
      // post-signal epoch so per-instance epochs stay equal instead of
      // diverging monotonically (reliability finding
      // detached-instance-epoch-divergence).
      const forwarded = mergeMutationDeltas(this.pendingMutationDelta, delta)
      this.pendingMutationDelta = undefined
      registered.markPathsChanged(forwarded)
      // Mirror markStale above, with the same no-regress guard: adopt the
      // singleton's post-signal epoch only when it is ahead of this holder's
      // next epoch (reliability finding detached-epoch-mirror-can-regress).
      this.advanceEpochAfterForward(registered.indexMutationEpoch)
      return
    }
    this.mutationEpoch += 1
    // A fresh mutation signal re-arms the P8.1 parserDegraded re-queue bound.
    this.degradedDeltaRequeued = false
    this.pendingMutationDelta = mergeMutationDeltas(
      this.pendingMutationDelta,
      delta,
    )
    this.forceRefresh = true
  }

  /**
   * Wait for the index to be ready (up to timeoutMs).
   * Starts a build if needed.
   */
  async waitUntilReady(timeoutMs = 30_000): Promise<void> {
    // Detached-instance gate (reliability finding
    // detached-index-manager-still-runs-own-build-loop): forward readiness to
    // the registered singleton so the holder never builds (or serves) its own
    // index.
    const registered = IndexManager.instances.get(this.instanceKey)
    if (registered && registered !== this) {
      // Drain the holder's queued mutation state before delegating so a
      // delta queued while the holder was detached reaches the singleton now
      // instead of being deferred until something else calls ensureBuilt
      // (reliability finding detached-query-forward-skips-pending-drain).
      this.forwardPendingMutationsTo(registered)
      await registered.waitUntilReady(timeoutMs)
      return
    }
    this.scheduleRefreshIfNeeded()
    if (
      isIndexReady(this.index) &&
      !this.forceRefresh &&
      !this.staleRefreshPending &&
      (!this.config.semantic?.enabled || !this.embed || this.isSemanticReady())
    ) {
      return
    }
    this.ensureBuilt()
    if (!this.buildPromise) return
    await Promise.race([
      this.buildPromise,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ])
  }

  /**
   * Query the index. Returns empty results if index is not yet ready.
   *
   * Lexical field weights from `indexing.weights.lexical` in `openbuff.json`
   * are merged in (callers can still override per-query via `options.lexicalWeights`).
   */
  query(
    query: string,
    options: {
      limit?: number
      fileTypes?: string[]
      pathPrefixes?: string[]
      mode?: QueryIndexMode
      from?: string
      to?: string
      lexicalWeights?: LexicalWeights
    } = {},
  ): {
    results: QueryIndexResult[]
    ready: boolean
    totalIndexed: number
    indexAge: number
    status: IndexStatus
    snapshot?: IndexSnapshotIdentity
  } {
    // Detached-instance gate (reliability finding
    // detached-index-manager-still-runs-own-build-loop): serve the registered
    // singleton's index — the holder must never answer from its own stale
    // snapshot.
    const registered = IndexManager.instances.get(this.instanceKey)
    if (registered && registered !== this) {
      // Drain the holder's queued mutation state before delegating (reliability
      // finding detached-query-forward-skips-pending-drain).
      this.forwardPendingMutationsTo(registered)
      return registered.query(query, options)
    }
    if (this.config.enabled === false) {
      return {
        results: [],
        ready: false,
        totalIndexed: 0,
        indexAge: 0,
        status: this.getStatus(),
        snapshot: undefined,
      }
    }
    if (!isIndexReady(this.index)) {
      this.ensureBuilt()
      return {
        results: [],
        ready: false,
        totalIndexed: 0,
        indexAge: 0,
        status: this.getStatus(),
        snapshot: undefined,
      }
    }
    this.scheduleRefreshIfNeeded()
    if (this.forceRefresh || this.staleRefreshPending) {
      this.ensureBuilt()
      // Continue with the last known-good snapshot while refresh runs.
    }
    const results = queryIndex(
      this.index,
      query,
      withConfigLexicalWeights(options, this.config),
    ).map((result) => ({
      ...result,
      indexedHash: this.index!.files[result.path]?.hash,
    }))
    return {
      results,
      ready: true,
      totalIndexed: this.index.fileCount,
      indexAge: Date.now() - this.index.builtAt,
      status: this.getStatus(),
      snapshot: this.getSnapshotIdentity(this.index),
    }
  }

  /**
   * Like {@link query} but blends semantic-similarity hits into the lexical
   * ranking when semantic indexing is ready. Async because it embeds the query.
   * Falls back to pure lexical results when semantic is unavailable.
   *
   * The semantic blend weight from `indexing.weights.semanticBlend` in
   * `openbuff.json` controls how strongly semantic hits influence the combined
   * ranking (historical default: 1).
   */
  async queryBlended(
    query: string,
    options: {
      limit?: number
      fileTypes?: string[]
      pathPrefixes?: string[]
      mode?: QueryIndexMode
      from?: string
      to?: string
      lexicalWeights?: LexicalWeights
    } = {},
  ): Promise<{
    results: QueryIndexResult[]
    ready: boolean
    totalIndexed: number
    indexAge: number
    status: IndexStatus
    snapshot?: IndexSnapshotIdentity
  }> {
    // Detached-instance gate (reliability finding
    // detached-index-manager-still-runs-own-build-loop): delegate the blended
    // query to the registered singleton so lexical results and semantic
    // vectors come from one index generation.
    const registered = IndexManager.instances.get(this.instanceKey)
    if (registered && registered !== this) {
      // Drain the holder's queued mutation state before delegating (reliability
      // finding detached-query-forward-skips-pending-drain).
      this.forwardPendingMutationsTo(registered)
      return registered.queryBlended(query, options)
    }
    const lexical = this.query(query, options)
    if (!lexical.ready || !this.index || !this.isSemanticReady()) {
      return lexical
    }
    // Semantic blending only applies to free-text search, not graph traversal.
    if (
      options.mode &&
      options.mode !== 'search' &&
      options.mode !== 'explain'
    ) {
      return lexical
    }

    // Pin the snapshot for the whole blend: searchSemantic awaits the query
    // embedding, and a concurrent refresh (_build) can replace this.index
    // during that await. Working against the captured snapshot keeps file
    // metadata for semantic-only hits and the returned totalIndexed/indexAge/
    // snapshot identity consistent with the lexical results (reliability
    // finding queryblended-mixed-snapshot-metadata).
    const snapshot = this.index
    // Pin the vector set together with the snapshot: _buildVectors
    // repopulates this.fileVectors inside the same _build that swaps
    // this.index, so the semantic search must run against the vectors that
    // belong to THIS snapshot — a hit computed against newer vectors can
    // reference a path the pinned snapshot never had (reliability finding
    // queryblended-pins-index-not-vectors).
    const pinnedVectors = this.fileVectors

    const limit = options.limit ?? 20
    const semantic = await this.searchSemantic(
      query,
      limit,
      options.fileTypes,
      options.pathPrefixes,
      { snapshot, vectors: pinnedVectors },
    )
    if (semantic.length === 0) return lexical

    const lexByPath = new Map(lexical.results.map((r) => [r.path, r]))
    const blended = blendSemanticScores(
      lexical.results.map((r) => ({ path: r.path, score: r.score })),
      semantic,
      this.config.weights?.semanticBlend,
    ).slice(0, limit)

    const results: QueryIndexResult[] = blended.map(({ path, score }) => {
      const existing = lexByPath.get(path)
      if (existing) return { ...existing, score }
      // Semantic-only hit: surface it with file metadata from the pinned
      // snapshot — never from a concurrently refreshed index.
      const file = snapshot.files[path]
      return {
        path,
        score,
        matchedOn: ['semantic'],
        indexedHash: file?.hash,
        symbols: file?.symbols.slice(0, 10),
        headings: file?.headings.slice(0, 5),
      }
    })

    return { ...lexical, results }
  }

  private async _build(mutationDelta?: IndexMutationDelta): Promise<void> {
    if (this.config.enabled === false) return
    this.lastBuildAttempt = Date.now()
    const cacheDir = this.config.cacheDir ?? '.codebuff-index'
    let stage: IndexBuildError['stage'] = 'load'
    try {
      const existing = await loadIndex(this.projectRoot, cacheDir)
      const expectedBuiltAt = existing?.builtAt ?? null
      let index: MetadataIndex
      stage = 'walk'
      if (existing) {
        index = await updateMetadataIndex(
          existing,
          this.projectRoot,
          this.config,
          mutationDelta,
        )
      } else {
        index = await buildMetadataIndex(this.projectRoot, this.config)
      }
      // P8.1: a degraded refresh did not incorporate the delta, so its
      // revision must not be stamped onto the preserved prior snapshot.
      // Never regress either: updateMetadataIndex early-returns stale
      // complete deltas without applying them (and otherwise preserves the
      // already-incorporated revision), so only stamp the delta revision
      // when it does not move the persisted workspaceRevision backwards.
      if (
        mutationDelta?.revision !== undefined &&
        !index.parserDegraded &&
        (index.workspaceRevision === undefined ||
          compareRevisions(mutationDelta.revision, index.workspaceRevision) >=
            0)
      ) {
        index.workspaceRevision = mutationDelta.revision
      }
      stage = 'persist'
      const persisted = await saveIndex(index, this.projectRoot, cacheDir, {
        expectedBuiltAt,
      })
      if (!persisted) {
        this.forceRefresh = true
        if (mutationDelta) {
          this.pendingMutationDelta = mergeMutationDeltas(
            this.pendingMutationDelta,
            mutationDelta,
          )
        }
      }
      if (index.parserDegraded && mutationDelta && !this.degradedDeltaRequeued) {
        // P8.1: the tree-sitter parse degraded and the delta was dropped.
        // Re-queue it once so the next refresh re-applies it; the raw flag
        // bound prevents infinite retries when parsing stays degraded.
        this.degradedDeltaRequeued = true
        this.forceRefresh = true
        this.pendingMutationDelta = mergeMutationDeltas(
          this.pendingMutationDelta,
          mutationDelta,
        )
        console.debug(
          '[indexer] parser degraded; mutation delta re-queued for the next refresh.',
        )
      } else if (persisted && !index.parserDegraded) {
        this.degradedDeltaRequeued = false
      }
      if (persisted) {
        // Fail-closed verification: only trust disk when it still holds the
        // snapshot we just built. Verified by comparing snapshot content
        // directly rather than by re-deriving a content digest, so the check
        // cannot be silently disabled if this module's identity hash and
        // index-store's ever drift apart. A mismatch falls back to the
        // in-memory index so a concurrent writer can't swap content under us.
        let verified: MetadataIndex | null = null
        try {
          verified = await loadIndex(this.projectRoot, cacheDir)
        } catch {
          verified = null
        }
        if (verified && !isSameIndexSnapshot(verified, index)) {
          verified = null
        }
        if (!verified) {
          console.warn(
            '[indexer] persisted index failed snapshot verification; serving the in-memory index.',
          )
        }
        this.index = verified ?? index
      } else {
        // Our save lost the CAS race: preserve concurrent-newest-wins by
        // serving the newest on-disk index (unverified). The read is guarded
        // so a failed read can't discard the index we just built.
        let onDisk: MetadataIndex | null = null
        try {
          onDisk = await loadIndex(this.projectRoot, cacheDir)
        } catch {
          onDisk = null
        }
        this.index = onDisk ?? index
      }
      this.snapshotCache = undefined
      this.lastBuildError = undefined
      await this._buildVectors(this.index, cacheDir)
    } catch (err) {
      // Index build failures are never fatal
      console.debug('[indexer] build failed:', err)
      this.lastBuildError = createBuildError(
        stage,
        err,
        getIndexDir(this.projectRoot, cacheDir),
      )
      if (mutationDelta) {
        this.pendingMutationDelta = mergeMutationDeltas(
          this.pendingMutationDelta,
          mutationDelta,
        )
      }
    }
  }

  private getSnapshotIdentity(index: MetadataIndex): IndexSnapshotIdentity {
    if (this.snapshotCache?.index === index) return this.snapshotCache.identity
    // Content-addressed: builtAt is metadata only (kept on the identity
    // object) and excluded from the snapshotId hash input so identical
    // content yields identical snapshotIds across rebuilds. Delegates to the
    // single canonical implementation in index-store so the published
    // identity can never drift from the verification digest.
    const identity: IndexSnapshotIdentity = {
      schemaVersion: 1,
      snapshotId: computeIndexSnapshotId(index),
      indexVersion: index.version,
      builtAt: index.builtAt,
      ...(index.workspaceRevision !== undefined
        ? { workspaceRevision: index.workspaceRevision }
        : {}),
    }
    this.snapshotCache = { index, identity }
    return identity
  }

  /**
   * Embed all indexed files when semantic indexing is enabled and an embedder
   * is wired. Non-fatal: a failure here leaves lexical search fully functional.
   */
  private async _buildVectors(
    index: MetadataIndex,
    cacheDir: string,
  ): Promise<void> {
    if (!this.config.semantic?.enabled || !this.embed) return
    try {
      const fingerprint = getSemanticConfigFingerprint(
        this.config.semantic,
        this.embed,
      )
      const persisted = await loadSemanticVectors(
        this.projectRoot,
        fingerprint,
        cacheDir,
      )
      this.fileVectors = await buildFileVectors(
        Object.values(index.files),
        this.embed,
        64,
        [...this.fileVectors, ...persisted],
      )
      await saveSemanticVectors(
        this.projectRoot,
        fingerprint,
        this.fileVectors,
        cacheDir,
      )
    } catch (err) {
      console.debug('[indexer] semantic vector build failed:', err)
      this.fileVectors = []
      this.lastBuildError = createBuildError(
        'semantic',
        err,
        getIndexDir(this.projectRoot, cacheDir),
      )
    }
  }

  /** True when semantic search can run (enabled, embedder wired, vectors built). */
  isSemanticReady(): boolean {
    return Boolean(
      this.config.semantic?.enabled &&
      this.embed &&
      this.fileVectors.length > 0,
    )
  }

  getStatus(): IndexStatus {
    this.scheduleRefreshIfNeeded()
    const indexAge = this.index ? Date.now() - this.index.builtAt : 0
    const refreshing = Boolean(this.buildPromise || this.staleRefreshPending)
    const stale = Boolean(
      this.index &&
      (this.forceRefresh ||
        refreshing ||
        this.lastBuildError ||
        isIndexStale(this.index)),
    )
    const diagnostics = this.index?.parseDiagnostics ?? []
    const state: IndexStatus['state'] =
      this.config.enabled === false
        ? 'disabled'
        : !this.index
          ? refreshing
            ? 'building'
            : this.lastBuildError
              ? 'failed'
              : 'empty'
          : diagnostics.length > 0 ||
              this.lastBuildError ||
              this.index.coverage?.parser?.truncated
            ? 'degraded'
            : stale
              ? 'stale'
              : 'ready'
    const semantic: IndexStatus['semantic'] = !this.config.semantic?.enabled
      ? 'disabled'
      : this.isSemanticReady()
        ? 'ready'
        : this.embed
          ? refreshing
            ? 'building'
            : 'failed'
          : 'unavailable'
    const coverage = this.index?.coverage
    const coverageNotice = coverage?.truncated
      ? ` Index coverage is partial: walker skipped ${coverage.skippedFiles} file(s) under ${coverage.skippedPrefixes.join(', ') || 'no walker prefixes'}; parser skipped ${coverage.parser?.skippedFiles ?? 0} file(s) under ${coverage.parser?.skippedPrefixes.join(', ') || 'no parser prefixes'}.`
      : ''
    const errorNotice = this.lastBuildError
      ? ` Last ${this.lastBuildError.stage} error: ${this.lastBuildError.message}`
      : ''
    return {
      state,
      ready: Boolean(this.index),
      stale,
      refreshing,
      semantic,
      totalIndexed: this.index?.fileCount ?? 0,
      indexAge,
      diagnostics,
      coverage,
      lastBuildError: this.lastBuildError,
      message: `${state === 'ready' ? 'Index ready.' : state === 'stale' ? 'Serving a stale snapshot while refreshing.' : state === 'degraded' ? 'Index ready with partial coverage or diagnostics.' : state === 'failed' ? 'Index build failed.' : state === 'building' ? 'Index is building.' : state === 'disabled' ? 'Indexing is disabled.' : 'Index is empty or unavailable.'}${coverageNotice}${errorNotice}`,
    }
  }

  /**
   * Rank indexed files by semantic similarity to the query. Returns [] when
   * semantic indexing is unavailable, so callers can fall back to lexical-only.
   */
  async searchSemantic(
    query: string,
    limit = 20,
    fileTypes?: string[],
    pathPrefixes?: string[],
    pinned?: { snapshot: MetadataIndex; vectors: FileVector[] },
  ): Promise<SemanticHit[]> {
    if (!this.isSemanticReady() || !this.embed) return []
    // A pinned {snapshot, vectors} pair captured together keeps the
    // fileTypes filter and the vector set in the same index generation —
    // filtering live this.index against live this.fileVectors lets a
    // concurrent refresh mix generations (reliability finding
    // query-vs-build-vectors-filetype-inconsistency).
    const vectors = pinned ? pinned.vectors : this.fileVectors
    const metadataIndex = pinned ? pinned.snapshot : this.index
    try {
      const allowedVectors = vectors.filter((entry) => {
        if (
          fileTypes?.length &&
          !matchesFileTypes(metadataIndex?.files[entry.path]?.ext, fileTypes)
        ) {
          return false
        }
        if (!pathPrefixes?.length) return true
        return pathPrefixes.some((rawPrefix) => {
          const prefix = rawPrefix
            .replace(/\\/g, '/')
            .replace(/^\.\//, '')
            .replace(/^\/+|\/+$/g, '')
          return entry.path === prefix || entry.path.startsWith(`${prefix}/`)
        })
      })
      return await semanticSearch(query, allowedVectors, this.embed, limit)
    } catch (err) {
      console.debug('[indexer] semantic search failed:', err)
      return []
    }
  }

  private scheduleRefreshIfNeeded(): void {
    if (
      !this.index ||
      (!isIndexStale(this.index) && !this.lastBuildError?.retryable) ||
      this.buildPromise ||
      this.forceRefresh ||
      Date.now() - this.lastBuildAttempt < this.MIN_RETRY_INTERVAL_MS
    ) {
      return
    }
    this.forceRefresh = true
    this.ensureBuilt()
  }
}

/**
 * Merge the project-level lexical weights from `indexing.weights.lexical` into a
 * query options object. Per-query `lexicalWeights` (if provided by the caller)
 * take precedence over the config defaults — the caller's explicit override
 * wins. Returns the options object with `lexicalWeights` populated when the
 * config defines any lexical weights and the caller did not supply its own.
 */
function withConfigLexicalWeights(
  options: QueryOptions,
  config: IndexingConfig,
): QueryOptions {
  const configLexical = config.weights?.lexical
  if (!configLexical) return options
  // Caller-supplied per-query weights take precedence over config defaults.
  if (options.lexicalWeights) return options
  return { ...options, lexicalWeights: configLexical }
}

/**
 * Compares two index snapshots by the content that defines a snapshot: schema
 * version, project root, workspace revision (matching the store's
 * `undefined -> 'unknown'` normalization), and every file's content hash.
 * Backs the fail-closed verification in `_build` without depending on two
 * independently implemented content-addressed digests agreeing.
 */
function isSameIndexSnapshot(
  a: MetadataIndex,
  b: MetadataIndex,
): boolean {
  if (
    a.version !== b.version ||
    a.projectRoot !== b.projectRoot ||
    (a.workspaceRevision ?? 'unknown') !== (b.workspaceRevision ?? 'unknown')
  ) {
    return false
  }
  const aPaths = Object.keys(a.files)
  if (aPaths.length !== Object.keys(b.files).length) return false
  return aPaths.every(
    (filePath) => a.files[filePath]?.hash === b.files[filePath]?.hash,
  )
}

function mergeMutationDeltas(current: IndexMutationDelta | undefined, next: IndexMutationDelta): IndexMutationDelta {
  // P8.3: select the max revision with numeric-aware comparison; plain string
  // territory ("10" < "9") would let an older-dated delta win the merge.
  const revision =
    current?.revision !== undefined &&
    next.revision !== undefined &&
    compareRevisions(current.revision, next.revision) > 0
      ? current.revision
      : (next.revision ?? current?.revision)
  const changedPaths = new Set([
    ...(current?.changedPaths ?? []),
    ...(next.changedPaths ?? []),
  ])
  const deletedPaths = new Set([
    ...(current?.deletedPaths ?? []),
    ...(next.deletedPaths ?? []),
  ])
  for (const deletedPath of deletedPaths) changedPaths.delete(deletedPath)
  return {
    changedPaths: Array.from(changedPaths),
    deletedPaths: Array.from(deletedPaths),
    complete: current
      ? current.complete === true && next.complete === true
      : next.complete,
    revision,
  }
}

function createBuildError(
  stage: IndexBuildError['stage'],
  error: unknown,
  cachePath: string,
): IndexBuildError {
  const message = error instanceof Error ? error.message : String(error)
  return {
    stage,
    message: message.slice(0, 2_000),
    timestamp: Date.now(),
    retryable: !/refusing to use non-owned/i.test(message),
    cachePath,
  }
}

function matchesFileTypes(
  extension: string | undefined,
  fileTypes: string[],
): boolean {
  if (!extension) return false
  const normalizedExtension = extension.replace(/^\./, '').toLowerCase()
  return fileTypes.some(
    (fileType) =>
      fileType.trim().replace(/^\./, '').toLowerCase() === normalizedExtension,
  )
}
