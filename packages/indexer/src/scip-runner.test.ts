import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Worker } from 'node:worker_threads'

import { afterAll, describe, expect, test } from 'bun:test'

import {
  BoundedStreamCapture,
  MAX_SCIP_INDEXERS_PER_CALL,
  SCIP_INDEXER_COMMANDS,
  defaultAsyncScipRunner,
  defaultScipRunner,
  detectAvailableScipIndexers,
  detectAvailableScipIndexersAsync,
  runScipIngest,
  parseScipDumpEdges,
  type AsyncScipRunner,
  type ScipRunner,
  type ScipRunnerInvocation,
  type ScipRunnerResult,
} from './scip-runner'

import type { MetadataIndex } from './types'
import { SCIP_MAX_MERGED_EDGES } from './scip-ingest'
import {
  deriveScipDumpEdges,
  ScipDumpDerivationError,
} from './scip-parse-worker'
import type { ScipDumpDerivationStage } from './scip-parse-worker'

const roots: string[] = []
afterAll(() => {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {}
  }
  // Sweep any leftover per-ecosystem dump directories (best-effort).
  try {
    rmSync(join(tmpdir(), 'openbuff-scip'), { recursive: true, force: true })
  } catch {}
})

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openbuff-scip-runner-'))
  roots.push(root)
  return root
}

function makeIndex(): MetadataIndex {
  return {
    version: '2',
    projectRoot: '/repo',
    builtAt: 123,
    fileCount: 2,
    files: {},
    graph: { nodes: {}, edges: [] },
  }
}

/** Raw SCIP dump producing `edgeCount` unique precise cross-file edges. */
function scipDumpWithEdges(edgeCount: number): unknown {
  const documents: unknown[] = []
  let produced = 0
  let pair = 0
  while (produced < edgeCount) {
    // Respect the per-document occurrence cap (scip-ingest validates it).
    const size = Math.min(20_000, edgeCount - produced)
    const defOccurrences: unknown[] = []
    const refOccurrences: unknown[] = []
    for (let i = 0; i < size; i++) {
      const symbol = `scip-typescript npm pkg 1.0.0 src/sym-${produced + i}#f().`
      defOccurrences.push({ range: [0, 0, 0, 1], symbol, symbol_roles: 1 })
      refOccurrences.push({ range: [0, 0, 0, 1], symbol })
    }
    documents.push(
      { relative_path: `src/def-${pair}.ts`, occurrences: defOccurrences },
      { relative_path: `src/ref-${pair}.ts`, occurrences: refOccurrences },
    )
    produced += size
    pair++
  }
  return { documents }
}

const HELPER_SYMBOL = 'scip-typescript npm pkg 1.0.0 src/util.ts/helper().'

/** Tiny synthetic SCIP dump in the scip-ingest fixture style. */
const scipDump = {
  documents: [
    {
      relative_path: 'src/util.ts',
      language: 'typescript',
      occurrences: [
        { range: [0, 0, 0, 8], symbol: HELPER_SYMBOL, symbol_roles: 1 },
      ],
    },
    {
      relative_path: 'src/app.ts',
      occurrences: [{ range: [2, 0, 2, 8], symbol: HELPER_SYMBOL }],
    },
  ],
}

interface FakeBehavior {
  /** bin -> detection exit status (default: nonzero = unavailable). */
  available?: Record<string, boolean>
  /** bin -> index-run exit status; null means killed-by-timeout. */
  indexExit?: Record<string, number | null>
  /** JSON payload the fake indexer writes at its --output path. */
  dump?: unknown
  /** Per-bin dump payload, overriding `dump` for the given indexer binary. */
  dumpByBin?: Record<string, unknown>
}

function makeFakeRunner(behavior: FakeBehavior): {
  runner: ScipRunner
  invocations: ScipRunnerInvocation[]
} {
  const invocations: ScipRunnerInvocation[] = []
  const runner: ScipRunner = (invocation) => {
    invocations.push(invocation)
    if (invocation.argv[0] === '--version') {
      const available = behavior.available?.[invocation.command] === true
      return {
        status: available ? 0 : 1,
        stdout: available ? 'scip 1.0.0' : '',
        stderr: '',
      }
    }
    // null (killed by timeout) must stay null: `?? 0` would collapse it
    // into a successful exit and mask the timeout status under test.
    const exitFor = behavior.indexExit?.[invocation.command]
    const exit = exitFor === undefined ? 0 : exitFor
    const dump = behavior.dumpByBin?.[invocation.command] ?? behavior.dump
    if (exit === 0 && dump !== undefined) {
      const outIndex = invocation.argv.indexOf('--output')
      const outputPath =
        outIndex >= 0 ? invocation.argv[outIndex + 1] : undefined
      if (outputPath) {
        writeFileSync(
          outputPath,
          typeof dump === 'string' ? dump : JSON.stringify(dump),
        )
      }
    }
    return {
      status: exit,
      stdout: '',
      stderr: exit === 0 ? '' : `${invocation.command} failed`,
    }
  }
  return { runner, invocations }
}

describe('detectAvailableScipIndexers', () => {
  test('filters to installed indexers in fixed table order', () => {
    const root = makeRoot()
    const { runner, invocations } = makeFakeRunner({
      available: { 'scip-go': true, 'scip-typescript': true },
    })
    const available = detectAvailableScipIndexers(root, { runner })
    // Table order, not detection-success order.
    expect(available).toEqual(['typescript', 'go'])
    // Probes are argv arrays with the 2s detection timeout.
    expect(invocations.length).toBe(SCIP_INDEXER_COMMANDS.length)
    for (const invocation of invocations) {
      expect(invocation.argv).toEqual(['--version'])
      expect(invocation.timeoutMs).toBe(2_000)
      expect(invocation.cwd).toBe(root)
    }
  })

  test('never throws when the runner throws', () => {
    const root = makeRoot()
    const runner: ScipRunner = () => {
      throw new Error('spawn exploded')
    }
    expect(detectAvailableScipIndexers(root, { runner })).toEqual([])
  })
})

describe('runScipIngest', () => {
  test('runs available indexers and merges the produced dump', async () => {
    const root = makeRoot()
    const { runner, invocations } = makeFakeRunner({
      available: { 'scip-typescript': true },
      dump: scipDump,
    })
    const result = await runScipIngest(root, {
      runner,
      index: makeIndex(),
      indexers: ['typescript'],
    })
    expect(result.results).toEqual([
      { indexer: 'typescript', status: 'ok', edgesMerged: 1 },
    ])
    expect(result.mergedTotal).toBe(1)
    const precise = result.mergedIndex?.graph.edges.filter(
      (edge) => edge.confidence === 'precise',
    )
    expect(precise).toHaveLength(1)
    expect(precise?.[0]).toMatchObject({
      from: 'file:src/app.ts',
      to: 'file:src/util.ts',
      type: 'references',
      confidence: 'precise',
    })
    // Every subprocess was argv-array only with bounded timeout + maxBuffer.
    const indexInvocation = invocations.find(
      (invocation) => invocation.argv[0] !== '--version',
    )
    expect(indexInvocation).toBeDefined()
    expect(Array.isArray(indexInvocation!.argv)).toBe(true)
    expect(indexInvocation!.timeoutMs).toBe(120_000)
    expect(indexInvocation!.maxBufferBytes).toBe(64 * 1024 * 1024)
    expect(indexInvocation!.argv).toContain('--output')
  })

  test('isolates per-indexer failures', async () => {
    const root = makeRoot()
    const { runner } = makeFakeRunner({
      available: { 'scip-typescript': true, 'scip-python': true },
      indexExit: { 'scip-python': 3 },
      dump: scipDump,
    })
    const result = await runScipIngest(root, {
      runner,
      index: makeIndex(),
      indexers: ['typescript', 'python'],
    })
    expect(result.results.map((entry) => entry.status)).toEqual([
      'ok',
      'error',
    ])
    expect(result.results[1]?.error).toContain('scip-python')
    // The healthy indexer still merged its dump.
    expect(result.mergedTotal).toBe(1)
  })

  test('reports timeout status when the indexer is killed', async () => {
    const root = makeRoot()
    const { runner } = makeFakeRunner({
      available: { 'scip-typescript': true },
      indexExit: { 'scip-typescript': null },
    })
    const result = await runScipIngest(root, {
      runner,
      index: makeIndex(),
      indexers: ['typescript'],
    })
    expect(result.results[0]?.status).toBe('timeout')
    expect(result.mergedTotal).toBe(0)
  })

  test('reports an error when the dump is missing or unparseable', async () => {
    const root = makeRoot()
    // No dump written: the indexer exited 0 but produced nothing.
    const missing = await runScipIngest(root, {
      runner: makeFakeRunner({
        available: { 'scip-typescript': true },
      }).runner,
      index: makeIndex(),
      indexers: ['typescript'],
    })
    expect(missing.results[0]?.status).toBe('error')
    expect(missing.results[0]?.error).toContain('no SCIP dump')

    // Malformed dump: parse fails closed with an error result, no throw.
    const malformed = await runScipIngest(join(root, 'second'), {
      runner: makeFakeRunner({
        available: { 'scip-typescript': true },
        dump: '{not json',
      }).runner,
      index: makeIndex(),
      indexers: ['typescript'],
    })
    expect(malformed.results[0]?.status).toBe('error')
    expect(malformed.results[0]?.error).toContain(
      'failed to parse SCIP dump',
    )
  })

  test('enforces the per-call indexer cap and clamps its bounds', async () => {
    const root = makeRoot()
    const { runner } = makeFakeRunner({
      available: Object.fromEntries(
        SCIP_INDEXER_COMMANDS.map((entry) => [entry.bin, true]),
      ),
    })
    const capped = await runScipIngest(root, { runner, maxIndexers: 2 })
    expect(capped.results).toHaveLength(2)
    expect(capped.results.map((entry) => entry.indexer)).toEqual([
      SCIP_INDEXER_COMMANDS[0].id,
      SCIP_INDEXER_COMMANDS[1].id,
    ])

    // maxIndexers below 1 clamps up to 1.
    const floor = await runScipIngest(join(root, 'floor'), {
      runner,
      maxIndexers: 0,
    })
    expect(floor.results).toHaveLength(1)

    // The absolute cap is MAX_SCIP_INDEXERS_PER_CALL even with a huge request.
    const unlimited = await runScipIngest(join(root, 'unlimited'), {
      runner,
      maxIndexers: Number.MAX_SAFE_INTEGER,
    })
    expect(unlimited.results).toHaveLength(MAX_SCIP_INDEXERS_PER_CALL)
  })

  test('clamps the index timeout into [1s, 600s]', async () => {
    const root = makeRoot()
    const low = makeFakeRunner({
      available: { 'scip-typescript': true },
      dump: scipDump,
    })
    await runScipIngest(root, {
      runner: low.runner,
      indexers: ['typescript'],
      timeoutMs: 5,
    })
    const lowInvocation = low.invocations.find(
      (invocation) => invocation.argv[0] !== '--version',
    )
    expect(lowInvocation?.timeoutMs).toBe(1_000)

    const high = makeFakeRunner({
      available: { 'scip-typescript': true },
      dump: scipDump,
    })
    await runScipIngest(join(root, 'high'), {
      runner: high.runner,
      indexers: ['typescript'],
      timeoutMs: Number.MAX_SAFE_INTEGER,
    })
    const highInvocation = high.invocations.find(
      (invocation) => invocation.argv[0] !== '--version',
    )
    expect(highInvocation?.timeoutMs).toBe(600_000)
  })

  test('detect-and-dump mode skips the merge when no index is supplied', async () => {
    const root = makeRoot()
    const { runner } = makeFakeRunner({
      available: { 'scip-typescript': true },
      dump: scipDump,
    })
    const result = await runScipIngest(root, {
      runner,
      indexers: ['typescript'],
    })
    expect(result.results[0]).toEqual({ indexer: 'typescript', status: 'ok' })
    expect(result.mergedIndex).toBeUndefined()
  })

  test('ignores unknown indexer ids in the filter', async () => {
    const root = makeRoot()
    const { runner, invocations } = makeFakeRunner({})
    const result = await runScipIngest(root, {
      runner,
      indexers: ['nosuchindexer'],
    })
    expect(result.results).toEqual([])
    expect(invocations).toEqual([])
  })

  test('shares detection probes between detectAvailableScipIndexers and runScipIngest', async () => {
    const root = makeRoot()
    const { runner, invocations } = makeFakeRunner({
      available: { 'scip-typescript': true },
      dump: scipDump,
    })
    const available = detectAvailableScipIndexers(root, { runner })
    expect(available).toEqual(['typescript'])
    const result = await runScipIngest(root, {
      runner,
      index: makeIndex(),
      indexers: ['typescript'],
    })
    expect(result.results[0]?.status).toBe('ok')
    // The ingest phase reuses the cached detection result instead of
    // re-probing the same binary: exactly one `--version` probe of
    // scip-typescript across both calls (each probe is a real spawned
    // process with a 2s timeout).
    const tsProbes = invocations.filter(
      (invocation) =>
        invocation.command === 'scip-typescript' &&
        invocation.argv[0] === '--version',
    )
    expect(tsProbes).toHaveLength(1)
  })

  test('merges multiple indexer dumps in one batch pass with cross-source dedupe', async () => {
    const root = makeRoot()
    const { runner } = makeFakeRunner({
      available: { 'scip-typescript': true, 'scip-python': true },
      dump: scipDump,
    })
    const result = await runScipIngest(root, {
      runner,
      index: makeIndex(),
      indexers: ['typescript', 'python'],
    })
    // Both indexers succeeded and each contributed its dump's edge.
    expect(result.results.map((entry) => entry.status)).toEqual(['ok', 'ok'])
    expect(result.results.map((entry) => entry.edgesMerged)).toEqual([1, 1])
    // The two dumps derive the same precise edge; the single-pass batch merge
    // dedupes it, so the merged total is 1 — not 2.
    expect(result.mergedTotal).toBe(1)
    const precise = result.mergedIndex?.graph.edges.filter(
      (edge) => edge.confidence === 'precise',
    )
    expect(precise).toHaveLength(1)
  })

  test('isolates concurrent invocations with per-call unique dump paths', async () => {
    const root = makeRoot()
    const { runner, invocations } = makeFakeRunner({
      available: { 'scip-typescript': true },
      dump: scipDump,
    })
    // Two concurrent invocations against the SAME root: the shared
    // deterministic dump path would let one read the other's partially
    // written or already-cleaned dump, so each invocation must get its own
    // per-call temp directory.
    const [first, second] = await Promise.all([
      runScipIngest(root, {
        runner,
        index: makeIndex(),
        indexers: ['typescript'],
      }),
      runScipIngest(root, {
        runner,
        index: makeIndex(),
        indexers: ['typescript'],
      }),
    ])
    expect(first.results[0]?.status).toBe('ok')
    expect(second.results[0]?.status).toBe('ok')
    expect(first.mergedTotal).toBe(1)
    expect(second.mergedTotal).toBe(1)
    // Each concurrent invocation ran against its own --output path.
    const outputPaths = invocations
      .filter((invocation) => invocation.argv[0] !== '--version')
      .map(
        (invocation) =>
          invocation.argv[invocation.argv.indexOf('--output') + 1],
      )
    expect(outputPaths).toHaveLength(2)
    expect(new Set(outputPaths).size).toBe(2)
  })

  test('single-flights concurrent probes on a cold cache key', async () => {
    const root = makeRoot()
    const { runner, invocations } = makeFakeRunner({
      available: { 'scip-typescript': true },
    })
    // Concurrent detection + ingest on a cold cache key: each used to spawn
    // its own probe process per binary (2s timeout each) before any result
    // was cached. The in-flight single-flight makes them join one probe.
    const [available, ingest] = await Promise.all([
      detectAvailableScipIndexersAsync(root, { runner }),
      runScipIngest(root, {
        runner,
        index: makeIndex(),
        indexers: ['typescript'],
      }),
    ])
    expect(available).toContain('typescript')
    // No dump is produced by this fake (no `dump` behavior), so the ingest's
    // indexer run fails open — the probe count is what this test pins.
    expect(ingest.results[0]?.status).toBe('error')
    const tsProbes = invocations.filter(
      (invocation) =>
        invocation.command === 'scip-typescript' &&
        invocation.argv[0] === '--version',
    )
    expect(tsProbes).toHaveLength(1)
  })

  test('fails an over-cap indexer at the merge cap without a premerge accumulation spike', async () => {
    const root = makeRoot()
    const { runner } = makeFakeRunner({
      available: { 'scip-typescript': true },
      dumpByBin: {
        'scip-typescript': scipDumpWithEdges(SCIP_MAX_MERGED_EDGES + 1),
      },
    })
    const result = await runScipIngest(root, {
      runner,
      index: makeIndex(),
      indexers: ['typescript'],
    })
    // The cap is consulted during accumulation (perf:
    // scip-premerge-edge-accumulation): the indexer is attributed the merge's
    // own edge-limit error and its over-cap edges are never retained for a
    // merge that could only discard them.
    expect(result.results[0]?.status).toBe('error')
    expect(result.results[0]?.error).toContain('exceeded the cap')
    expect(result.mergedTotal).toBe(0)
    expect(result.mergedIndex).toBeUndefined()
  })

  test('an over-cap indexer does not consume the batch budget of smaller indexers', async () => {
    const root = makeRoot()
    const { runner } = makeFakeRunner({
      available: { 'scip-typescript': true, 'scip-python': true },
      dumpByBin: {
        'scip-typescript': scipDumpWithEdges(SCIP_MAX_MERGED_EDGES + 1),
        'scip-python': scipDump,
      },
    })
    const result = await runScipIngest(root, {
      runner,
      index: makeIndex(),
      indexers: ['typescript', 'python'],
    })
    // Table order: the over-cap indexer trips the budget; the smaller dump
    // behind it still merges instead of failing with the whole batch.
    expect(result.results[0]?.status).toBe('error')
    expect(result.results[0]?.error).toContain('exceeded the cap')
    expect(result.results[1]).toMatchObject({
      indexer: 'python',
      status: 'ok',
      edgesMerged: 1,
    })
    expect(result.mergedTotal).toBe(1)
    const precise = result.mergedIndex?.graph.edges.filter(
      (edge) => edge.confidence === 'precise',
    )
    expect(precise).toHaveLength(1)
  })

  test('attributes the off-thread derive stage to the merge, not the parse', async () => {
    const root = makeRoot()
    // A dump whose document escapes the project root fails the edge
    // derivation stage inside the parse worker (scip-ingest fails closed),
    // so the per-indexer error must carry the merge attribution this stage
    // had when it ran on-thread — not `failed to parse SCIP dump`.
    const { runner } = makeFakeRunner({
      available: { 'scip-typescript': true },
      dump: {
        documents: [
          {
            relative_path: '../escape.ts',
            occurrences: [
              {
                range: [0, 0, 0, 1],
                symbol: HELPER_SYMBOL,
                symbol_roles: 1,
              },
            ],
          },
        ],
      },
    })
    const result = await runScipIngest(root, {
      runner,
      index: makeIndex(),
      indexers: ['typescript'],
    })
    expect(result.results[0]?.status).toBe('error')
    expect(result.results[0]?.error).toContain('SCIP merge failed')
    expect(result.results[0]?.error).not.toContain('failed to parse SCIP dump')
    expect(result.mergedTotal).toBe(0)
  })

  test('merges a full-cap batch without argument-spread assembly', async () => {
    const root = makeRoot()
    const { runner } = makeFakeRunner({
      available: { 'scip-typescript': true },
      dumpByBin: {
        'scip-typescript': scipDumpWithEdges(SCIP_MAX_MERGED_EDGES),
      },
    })
    const result = await runScipIngest(root, {
      runner,
      index: makeIndex(),
      indexers: ['typescript'],
    })
    // The batch merge must assemble every indexer's edges without spreading
    // them through function arguments (perf:
    // scip-runner-spread-batch-assembly): a per-indexer edge count at the
    // merge cap sits at the engine argument-spread scale, so the assembly
    // has to stay a plain item-by-item append and merge cleanly.
    expect(result.results[0]).toMatchObject({
      indexer: 'typescript',
      status: 'ok',
      edgesMerged: SCIP_MAX_MERGED_EDGES,
    })
    // All cap-worth of derived edges were assembled into one batch; each
    // occurrence pair carries a unique symbol, so the dedupe keeps every
    // SCIP_MAX_MERGED_EDGES precise edge — exactly at the cap, not over it.
    expect(result.mergedTotal).toBe(SCIP_MAX_MERGED_EDGES)
    expect(result.mergedIndex).toBeDefined()
  })

  test('cleans up the per-invocation nonce temp directory after ingest', async () => {
    const root = makeRoot()
    const { runner } = makeFakeRunner({
      available: { 'scip-typescript': true },
      dump: scipDump,
    })
    const result = await runScipIngest(root, {
      runner,
      index: makeIndex(),
      indexers: ['typescript'],
    })
    expect(result.results[0]?.status).toBe('ok')
    // After ingest, the per-root sanitized directory (which held this
    // invocation's nonce directory and its per-ecosystem dump directories)
    // is removed (perf: scip-runner-nonce-temp-dirs-never-removed), so an
    // opt-in ingest call no longer leaks empty directories into the OS temp
    // dir. Only the shared 'openbuff-scip' parent is deliberately left.
    const sanitized =
      root.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120) || 'project'
    expect(
      existsSync(join(tmpdir(), 'openbuff-scip', sanitized)),
    ).toBe(false)
  })
})

/**
 * A Worker stand-in whose construction succeeds but whose script never
 * loads: the failure surfaces asynchronously on the worker 'error' event,
 * exactly like a compiled Node build where './scip-parse-worker.ts' does
 * not exist next to the compiled module. The async twin of the
 * constructor-throw unavailability the on-thread degradation already covers.
 */
function makeLoadFailedWorker(): Worker {
  const fake = new EventEmitter() as unknown as Worker
  const emitter = fake as unknown as EventEmitter
  fake.postMessage = () => {}
  fake.terminate = () => Promise.resolve(1)
  queueMicrotask(() =>
    emitter.emit(
      'error',
      new Error(
        "Cannot find module '/build/scip-parse-worker.ts'",
      ),
    ),
  )
  return fake
}

describe('parseScipDumpEdges', () => {
  test('derives the precise edges of a bounded dump off-thread', async () => {
    const root = makeRoot()
    const dumpPath = join(root, 'index.scip')
    writeFileSync(dumpPath, JSON.stringify(scipDump))
    // The whole front half (read, parse, validate, derive) runs in the
    // worker; the main thread receives only the derived precise edges.
    const edges = await parseScipDumpEdges(dumpPath)
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({
      from: 'file:src/app.ts',
      to: 'file:src/util.ts',
      type: 'references',
      confidence: 'precise',
    })
  })

  test('rejects on malformed JSON with the underlying parse message', async () => {
    const root = makeRoot()
    const dumpPath = join(root, 'index.scip')
    writeFileSync(dumpPath, '{not json')
    // The worker parser surfaces its engine's own parse detail (Bun: "JSON
    // Parse error: ...", V8: "Unexpected ..."); only the propagation contract
    // is pinned here, not engine-specific wording.
    expect(parseScipDumpEdges(dumpPath)).rejects.toThrow(
      /JSON Parse error|Unexpected/,
    )
  })

  test('rejects when the dump file is missing', async () => {
    const root = makeRoot()
    await expect(
      parseScipDumpEdges(join(root, 'absent.scip')),
    ).rejects.toThrow(/ENOENT/)
  })

  test('surfaces the derive stage for a dump escaping the project root', async () => {
    const root = makeRoot()
    const dumpPath = join(root, 'index.scip')
    writeFileSync(
      dumpPath,
      JSON.stringify({
        documents: [
          {
            relative_path: '../escape.ts',
            occurrences: [
              { range: [0, 0, 0, 1], symbol: HELPER_SYMBOL, symbol_roles: 1 },
            ],
          },
        ],
      }),
    )
    // scip-ingest fails closed on unsafe document paths during edge
    // derivation, so the derivation stage (not the parse stage) is what
    // failed here — and the runner maps that stage to the merge attribution.
    await expect(parseScipDumpEdges(dumpPath)).rejects.toThrow(
      ScipDumpDerivationError,
    )
    await expect(parseScipDumpEdges(dumpPath)).rejects.toMatchObject({
      stage: 'derive',
    })
  })

  test('degrades to the on-thread derivation when the worker script fails to load asynchronously', async () => {
    const root = makeRoot()
    const dumpPath = join(root, 'index.scip')
    writeFileSync(dumpPath, JSON.stringify(scipDump))
    // A compiled Node build without './scip-parse-worker.ts' next to the
    // compiled module reports the failed load via the worker 'error' event,
    // not a constructor throw. The documented degradation must still apply:
    // resolve with the on-thread derivation's identical edges instead of
    // rejecting and reporting the indexer as an error.
    const edges = await parseScipDumpEdges(dumpPath, makeLoadFailedWorker)
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({
      from: 'file:src/app.ts',
      to: 'file:src/util.ts',
      type: 'references',
      confidence: 'precise',
    })
  })

  test('keeps the stage-tagged derivation error through the async-load degradation', async () => {
    const root = makeRoot()
    const dumpPath = join(root, 'index.scip')
    writeFileSync(
      dumpPath,
      JSON.stringify({
        documents: [
          {
            relative_path: '../escape.ts',
            occurrences: [
              { range: [0, 0, 0, 1], symbol: HELPER_SYMBOL, symbol_roles: 1 },
            ],
          },
        ],
      }),
    )
    // Degradation must not blur failure attribution: a dump escaping the
    // project root still rejects with the derive-stage ScipDumpDerivationError
    // the on-thread pipeline produces, which the runner maps to the merge
    // attribution (not `failed to parse SCIP dump`).
    await expect(
      parseScipDumpEdges(dumpPath, makeLoadFailedWorker),
    ).rejects.toThrow(ScipDumpDerivationError)
    await expect(
      parseScipDumpEdges(dumpPath, makeLoadFailedWorker),
    ).rejects.toMatchObject({ stage: 'derive' })
  })
})

describe('deriveScipDumpEdges (on-thread fallback)', () => {
  /** Stage reported by a failing derivation, or a thrown contract error. */
  function derivationStageOf(run: () => unknown): ScipDumpDerivationStage {
    try {
      run()
    } catch (error) {
      if (error instanceof ScipDumpDerivationError) return error.stage
      throw error
    }
    throw new Error('expected the derivation to fail')
  }

  test('derives the same edges as the worker path', () => {
    const root = makeRoot()
    const dumpPath = join(root, 'index.scip')
    writeFileSync(dumpPath, JSON.stringify(scipDump))
    const edges = deriveScipDumpEdges(dumpPath)
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({
      from: 'file:src/app.ts',
      to: 'file:src/util.ts',
      confidence: 'precise',
    })
  })

  test('tags an unreadable file with the parse stage', () => {
    const root = makeRoot()
    expect(derivationStageOf(() => deriveScipDumpEdges(join(root, 'absent.scip')))).toBe(
      'parse',
    )
  })

  test('tags malformed JSON with the parse stage', () => {
    const root = makeRoot()
    const dumpPath = join(root, 'index.scip')
    writeFileSync(dumpPath, '{not json')
    expect(derivationStageOf(() => deriveScipDumpEdges(dumpPath))).toBe('parse')
  })

  test('tags a schema violation with the validate stage', () => {
    const root = makeRoot()
    const dumpPath = join(root, 'index.scip')
    // Valid JSON, invalid SCIP shape: documents must be an array.
    writeFileSync(dumpPath, JSON.stringify({ documents: {} }))
    expect(derivationStageOf(() => deriveScipDumpEdges(dumpPath))).toBe(
      'validate',
    )
  })

  test('tags an unsafe document path with the derive stage', () => {
    const root = makeRoot()
    const dumpPath = join(root, 'index.scip')
    writeFileSync(
      dumpPath,
      JSON.stringify({
        documents: [
          {
            relative_path: '../escape.ts',
            occurrences: [
              { range: [0, 0, 0, 1], symbol: HELPER_SYMBOL, symbol_roles: 1 },
            ],
          },
        ],
      }),
    )
    expect(derivationStageOf(() => deriveScipDumpEdges(dumpPath))).toBe('derive')
  })
})

describe('BoundedStreamCapture', () => {
  test('caps retention in BYTES, not UTF-16 code units', () => {
    // Each '€' is 1 UTF-16 code unit but 3 UTF-8 bytes: the old char-count
    // cap of 3 would have retained all three euro signs (9 bytes); the byte
    // cap retains exactly one (3 bytes).
    const capture = new BoundedStreamCapture(3)
    capture.push('€')
    capture.push('€')
    capture.push('€')
    expect(capture.text()).toBe('€')
    expect(Buffer.byteLength(capture.text(), 'utf8')).toBe(3)
  })

  test('drops chunks beyond the byte cap', () => {
    const capture = new BoundedStreamCapture(4)
    capture.push('abc')
    capture.push('def')
    expect(capture.text()).toBe('abcd')
  })

  test('decodes a multibyte UTF-8 sequence split across chunks', () => {
    // 'é' is 2 UTF-8 bytes; the first chunk ends mid-sequence, so a
    // per-chunk chunk.toString() would have mangled it into U+FFFD.
    const capture = new BoundedStreamCapture(1024)
    const bytes = Buffer.from('héllo€', 'utf8')
    capture.push(bytes.subarray(0, 2))
    capture.push(bytes.subarray(2))
    expect(capture.text()).toBe('héllo€')
  })
})

describe('defaultAsyncScipRunner', () => {
  test('preserves multibyte output through the byte-bounded capture', async () => {
    const root = makeRoot()
    const scriptPath = join(root, 'emit.js')
    writeFileSync(scriptPath, "process.stdout.write('héllo€')\n")
    const result = await defaultAsyncScipRunner({
      command: process.execPath,
      argv: [scriptPath],
      cwd: root,
      timeoutMs: 10_000,
      maxBufferBytes: 1024,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('héllo€')
  })

  test('caps child output at maxBufferBytes', async () => {
    const root = makeRoot()
    const scriptPath = join(root, 'emit.js')
    writeFileSync(scriptPath, "process.stdout.write('abcdefghij')\n")
    const result = await defaultAsyncScipRunner({
      command: process.execPath,
      argv: [scriptPath],
      cwd: root,
      timeoutMs: 10_000,
      maxBufferBytes: 4,
    })
    expect(result.stdout).toBe('abcd')
  })

  test('resolves status -1 with the spawn error for a missing binary', async () => {
    const result = await defaultAsyncScipRunner({
      command: 'openbuff-definitely-not-a-binary',
      argv: [],
      cwd: makeRoot(),
      timeoutMs: 1_000,
      maxBufferBytes: 1024,
    })
    expect(result.status).toBe(-1)
    // The spawn failure surfaces through the runner's stderr, but the exact
    // wording is engine-specific (Bun: "Executable not found in $PATH: ...",
    // Node: "spawn ... ENOENT"); only the propagation contract is pinned.
    expect(result.stderr).toMatch(/ENOENT|not found in \$PATH/)
  })
})

describe('defaultScipRunner', () => {
  test('maps a spawnSync failure that killed the process to an error, not a timeout', () => {
    // spawnSync of a missing binary reports the same failure shape as a
    // maxBuffer overflow (error.code ENOBUFS): error.code set, `status:
    // null`, signal null. The pre-fix seam propagated that bare null, which
    // downstream (`runSingleIndexer`) misreads as a timeout; the seam must
    // translate it into a non-null failure status carrying the error message.
    const result = defaultScipRunner({
      command: 'openbuff-definitely-not-a-binary',
      argv: [],
      cwd: makeRoot(),
      timeoutMs: 1_000,
      maxBufferBytes: 1024,
    })
    expect(result.status).toBe(-1)
    expect(result.stderr).toMatch(/ENOENT|not found/)
  })

  test('still reports the timeout contract for a real timeout', () => {
    const root = makeRoot()
    const scriptPath = join(root, 'hang.js')
    // The child would exit on its own after 5s, so a runtime without
    // spawnSync timeout support fails slowly instead of hanging forever.
    writeFileSync(scriptPath, 'setTimeout(() => process.exit(0), 5_000)\n')
    const result = defaultScipRunner({
      command: process.execPath,
      argv: [scriptPath],
      cwd: root,
      timeoutMs: 250,
      maxBufferBytes: 1024,
    })
    // `status: null` stays reserved for the killed-by-timeout case — the
    // error mapping must not swallow it.
    expect(result.status).toBeNull()
    expect(result.stderr).toContain('timed out')
  })
})

describe('detection hard timeout (inFlightDetections leak)', () => {
  test('a never-settling probe is abandoned at the hard deadline and its in-flight entry is deleted', async () => {
    const root = makeRoot()
    let invocations = 0
    // A broken runner seam that NEVER settles — the exact leak shape: every
    // detection call would previously hold its inFlightDetections entry
    // forever, so later callers joined the wedged promise and detection for
    // those binaries never recovered.
    const neverRunner: AsyncScipRunner = async () => {
      invocations += 1
      return new Promise<ScipRunnerResult>(() => {})
    }
    const started = Date.now()
    const settled = await Promise.race([
      detectAvailableScipIndexersAsync(root, {
        asyncRunner: neverRunner,
        detectionHardTimeoutMs: 100,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('detection wedged past deadline+grace')),
          5_000,
        ),
      ),
    ])
    // The timed-out probes fail open to unavailable, never throw, and the
    // whole call settles well within the deadline + generous grace.
    expect(settled).toEqual([])
    expect(Date.now() - started).toBeLessThan(5_000)
    // The in-flight entry was DELETED on timeout: a second call re-probes
    // from scratch (2 x 8 fresh invocations) instead of joining the wedged
    // promise forever (which would leave the count at 8).
    await detectAvailableScipIndexersAsync(root, {
      asyncRunner: neverRunner,
      detectionHardTimeoutMs: 100,
    })
    expect(invocations).toBe(2 * SCIP_INDEXER_COMMANDS.length)
  })
})

describe('worker-load degradation memoization', () => {
  test('the failed worker spawn is attempted once per seam and the degradation is surfaced once', async () => {
    const root = makeRoot()
    const dumpPath = join(root, 'index.scip')
    writeFileSync(dumpPath, JSON.stringify(scipDump))
    let constructions = 0
    const spawnOnce = (): Worker => {
      constructions += 1
      return makeLoadFailedWorker()
    }
    const degradations: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => {
      const [first] = args
      if (typeof first === 'string' && first.includes('[scip-runner]')) {
        degradations.push(first)
      }
    }
    try {
      const edges = await parseScipDumpEdges(dumpPath, spawnOnce)
      expect(edges).toHaveLength(1)
      expect(constructions).toBe(1)
      expect(degradations).toHaveLength(1)
      // A second ingest on the SAME seam skips the doomed worker attempt
      // (memoized degradation) instead of silently degrading every time.
      const again = await parseScipDumpEdges(dumpPath, spawnOnce)
      expect(again).toHaveLength(1)
      expect(constructions).toBe(1)
      // Log-once: the diagnostic is not re-emitted per ingest.
      expect(degradations).toHaveLength(1)
      expect(degradations[0]).toContain('degrading to on-thread')
    } finally {
      console.error = originalError
    }
  })

  test('memoization is per seam: a fresh seam attempts its worker again', async () => {
    const root = makeRoot()
    const dumpPath = join(root, 'index.scip')
    writeFileSync(dumpPath, JSON.stringify(scipDump))
    let constructions = 0
    const freshSeam = (): Worker => {
      constructions += 1
      return makeLoadFailedWorker()
    }
    // The earlier test's seam was degraded, but THIS seam has its own entry,
    // so it still attempts (and fails, then degrades) its own worker.
    const edges = await parseScipDumpEdges(dumpPath, freshSeam)
    expect(edges).toHaveLength(1)
    expect(constructions).toBe(1)
  })
})
