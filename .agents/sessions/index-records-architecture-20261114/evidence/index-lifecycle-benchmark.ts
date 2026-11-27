import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

import { IndexManager } from '../../../../packages/indexer/src/index-manager'
import {
  closeIndexStorage,
  openIndexStorage,
  saveIndexGeneration,
} from '../../../../packages/indexer/src/durable-index-store'
import { getIndexPublicationToken } from '../../../../packages/indexer/src/index-store'
import { mergeScipEdgesIntoIndex } from '../../../../packages/indexer/src/scip-ingest'
import { openRepositoryServiceStorage } from '../../../../packages/indexer/src/repository-service-client'
import {
  setIndexStorageFactory,
  type IndexStoragePort,
  type IndexStorageStats,
} from '../../../../packages/indexer/src/storage-port'
import { canonicalJson } from '../../../../packages/indexer/src/stable-json'
import type { MetadataIndex } from '../../../../packages/indexer/src/types'

type Backend = 'embedded' | 'native'
const repositoryRoot = path.resolve(import.meta.dir, '../../../..')
const resultPrefix = 'INDEX_BENCHMARK_RESULT '
const codeFiles = Number(process.env.INDEX_BENCHMARK_FILES ?? 800)
const repetitions = Number(process.env.INDEX_BENCHMARK_REPETITIONS ?? 3)
const executable = path.resolve(
  process.env.INDEX_BENCHMARK_EXECUTABLE ??
    path.join(repositoryRoot, 'rust/target/release/openbuff-intelligence'),
)
const evidenceDirectory = import.meta.dir
const config = { maxFiles: 5_000, exclude: ['.native-service/**'] }

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function preciseDigest(index: MetadataIndex): string {
  return createHash('sha256')
    .update(
      canonicalJson(
        index.graph.edges.filter((edge) => edge.confidence === 'precise'),
      ),
    )
    .digest('hex')
}

function source(number: number, updated = false): string {
  const id = String(number).padStart(4, '0')
  return (
    `// Local repository fixture ${id}; ${'cached source record and incremental extraction. '.repeat(28)}\n` +
    `export function ${updated ? 'updatedFeature' : 'feature'}${id}(value: number) { return cacheRecord${id}(value) }\n` +
    `export function cacheRecord${id}(value: number) { return value + ${number} }\n`
  )
}

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(tmpdir(), 'openbuff-index-benchmark-'),
  )
  await fs.mkdir(path.join(root, 'src'))
  await fs.mkdir(path.join(root, '.native-service'), { mode: 0o700 })
  await fs.writeFile(
    path.join(root, 'README.md'),
    '# Local repository fixture\nDurable source discovery and incremental extraction.\n',
  )
  await fs.writeFile(
    path.join(root, 'src/router.ts'),
    "import { helper } from './helper'\nexport function route() { return helper() }\n",
  )
  await fs.writeFile(
    path.join(root, 'src/helper.ts'),
    'export function helper() { return 1 }\n',
  )
  for (let number = 0; number < codeFiles; number++) {
    await fs.writeFile(
      path.join(root, `src/feature-${String(number).padStart(4, '0')}.ts`),
      source(number),
    )
  }
  return root
}

async function databaseFiles(
  root: string,
  backend: Backend,
): Promise<Record<string, number>> {
  const directory = path.join(
    root,
    backend === 'native' ? '.native-service' : '.codebuff-index',
  )
  const files: Record<string, number> = {}
  for (const name of await fs.readdir(directory)) {
    if (!/\.(?:sqlite|db)(?:-wal|-shm)?$/.test(name)) continue
    files[name] = (await fs.stat(path.join(directory, name))).size
  }
  return files
}

async function worker(
  backend: Backend,
  phase: string,
  root: string,
): Promise<void> {
  let encodedPutValueBytes = 0
  let putRows = 0
  let deleteRows = 0
  const instrumentation = (store: IndexStoragePort): IndexStoragePort => ({
    protocolVersion: 1,
    get: (request) => store.get(request),
    query: (request) => store.query(request),
    stats: (request) => store.stats(request),
    close: () => store.close(),
    batch: async (request) => {
      const result = await store.batch(request)
      if (result.committed) {
        for (const put of request.puts ?? [])
          encodedPutValueBytes += Buffer.byteLength(JSON.stringify(put.value))
        putRows += request.puts?.length ?? 0
        deleteRows += request.deletes?.length ?? 0
      }
      return result
    },
  })
  if (backend === 'native') {
    setIndexStorageFactory(async () =>
      instrumentation(
        await openRepositoryServiceStorage({
          directory: path.join(root, '.native-service'),
          executable,
        }),
      ),
    )
  } else {
    const { createEmbeddedIndexStorage } =
      await import('../../../../packages/indexer/src/embedded-storage')
    setIndexStorageFactory(async (options) =>
      instrumentation(await createEmbeddedIndexStorage(options)),
    )
  }

  const started = performance.now()
  const manager = IndexManager.getInstance(root, config)
  check(await manager.waitUntilReady(120_000), `${phase}: discovery timed out`)
  const discoveryMs = performance.now() - started
  const discovery = manager.query('helper', { limit: 3 })
  check(
    discovery.results.some((hit) => hit.path === 'src/helper.ts'),
    `${phase}: discovery cannot retrieve cached source`,
  )
  const discoveryView = {
    freshness: discovery.status.freshness,
    stale: discovery.status.stale,
    refreshing: discovery.status.refreshing,
    preciseEdges: manager
      .getSnapshot()!
      .graph.edges.filter((edge) => edge.confidence === 'precise').length,
  }
  check(
    await manager.waitUntilReconciled(120_000),
    `${phase}: reconciliation timed out`,
  )
  const reconciliationMs = performance.now() - started
  let snapshot = manager.getSnapshot()!
  check(
    snapshot.freshness === 'verified',
    `${phase}: source attestation was not verified`,
  )
  check(
    snapshot.fileCount === codeFiles + 3,
    `${phase}: fixture coverage changed`,
  )
  const reconciliationWork = { ...snapshot.updateStats }

  let precisePublicationMs: number | undefined
  if (phase === 'cold') {
    const preciseStarted = performance.now()
    snapshot = mergeScipEdgesIntoIndex(snapshot, [
      {
        from: 'file:src/router.ts',
        to: 'file:src/helper.ts',
        type: 'references',
        weight: 0.9,
        label: 'scip:benchmark/helper',
        confidence: 'precise',
      },
    ]).index
    check(
      await saveIndexGeneration(snapshot, root, undefined, {
        expectedPublicationToken: getIndexPublicationToken(
          manager.getSnapshot()!,
        ),
      }),
      'Precise layer publication failed',
    )
    precisePublicationMs = performance.now() - preciseStarted
  } else {
    check(
      discoveryView.freshness === 'unverified' &&
        discoveryView.stale &&
        discoveryView.refreshing,
      `${phase}: cached discovery did not precede verification: ${JSON.stringify(discoveryView)}; ${JSON.stringify(reconciliationWork)}`,
    )
    check(
      reconciliationWork.parsedFiles === 0 &&
        reconciliationWork.graphFilesUpdated === 0 &&
        reconciliationWork.postingsUpdated === 0,
      `${phase}: unchanged sources were unnecessarily re-derived`,
    )
  }
  check(
    snapshot.graph.edges.filter((edge) => edge.confidence === 'precise')
      .length === 1,
    `${phase}: precise layer disappeared`,
  )
  const storage = await openIndexStorage(root)
  const reconciledStats = await storage.store.stats()
  const beforeChangeWrites = reconciledStats.writes
  const beforeChangeBytes = encodedPutValueBytes
  let change: Record<string, unknown> | undefined
  if (phase === 'change') {
    const changeStarted = performance.now()
    const changedPath = 'src/feature-0000.ts'
    await fs.writeFile(path.join(root, changedPath), source(0, true))
    manager.markPathsChanged({
      changedPaths: [changedPath],
      complete: true,
      revision: 1,
    })
    check(
      await manager.waitUntilReconciled(120_000),
      'One-file change reconciliation timed out',
    )
    snapshot = manager.getSnapshot()!
    const stats = await storage.store.stats()
    check(
      snapshot.updateStats?.hashedFiles === 1 &&
        snapshot.updateStats.parsedFiles === 1 &&
        snapshot.updateStats.graphFilesUpdated === 1,
      'One-file change was not targeted',
    )
    check(
      stats.writes - beforeChangeWrites <= 30,
      `One-file persistence wrote ${stats.writes - beforeChangeWrites} rows: ${JSON.stringify(snapshot.updateStats)}`,
    )
    check(
      snapshot.graph.edges.filter((edge) => edge.confidence === 'precise')
        .length === 1,
      'Unrelated change invalidated precise producer data',
    )
    change = {
      elapsedMs: performance.now() - changeStarted,
      work: snapshot.updateStats,
      rowWrites: stats.writes - beforeChangeWrites,
      encodedPutValueBytes: encodedPutValueBytes - beforeChangeBytes,
    }
  }
  const output = {
    backend,
    phase,
    discoveryMs,
    reconciliationMs,
    precisePublicationMs,
    discovery: discoveryView,
    fileCount: snapshot.fileCount,
    reconciliationWork,
    preciseDigest: preciseDigest(snapshot),
    change,
    writesThisProcess: { putRows, deleteRows, encodedPutValueBytes },
    storage: await storage.store.stats(),
    physicalDatabaseFileBytes: await databaseFiles(root, backend),
  }
  await closeIndexStorage(root)
  console.log(resultPrefix + JSON.stringify(output))
}

async function runWorker(
  backend: Backend,
  phase: string,
  root: string,
): Promise<any> {
  const started = performance.now()
  const child = Bun.spawn(
    [process.execPath, import.meta.filename, '--worker', backend, phase, root],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  await fs.appendFile(
    path.join(evidenceDirectory, 'index-lifecycle-benchmark.raw.jsonl'),
    JSON.stringify({ backend, phase, exitCode, stdout, stderr }) + '\n',
  )
  check(exitCode === 0, `${backend}/${phase} failed: ${stderr}\n${stdout}`)
  const line = stdout
    .split('\n')
    .find((entry) => entry.startsWith(resultPrefix))
  check(line, `${backend}/${phase} produced no result`)
  return {
    ...JSON.parse(line.slice(resultPrefix.length)),
    processWallMs: performance.now() - started,
  }
}

async function startNative(
  root: string,
): Promise<ReturnType<typeof Bun.spawn>> {
  const directory = path.join(root, '.native-service')
  await fs.rm(path.join(directory, 'service.sock'), { force: true })
  const child = Bun.spawn([executable, '--serve', directory], {
    stdout: 'ignore',
    stderr: 'pipe',
  })
  const deadline = Date.now() + 10_000
  while (
    !(
      await fs.stat(path.join(directory, 'service.sock')).catch(() => null)
    )?.isSocket()
  ) {
    check(Date.now() < deadline, 'Native fixture service did not start')
    check(
      child.exitCode === null,
      'Native fixture service exited before listening',
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return child
}

async function stopNative(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  child.kill(9)
  await child.exited
  if (child.stderr)
    await fs.appendFile(
      path.join(
        evidenceDirectory,
        'index-lifecycle-benchmark.native.stderr.log',
      ),
      await new Response(child.stderr).text(),
    )
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

async function main(): Promise<void> {
  check(
    Number.isSafeInteger(codeFiles) && codeFiles > 0 && codeFiles < 4_997,
    'Invalid fixture file count',
  )
  check(
    Number.isSafeInteger(repetitions) && repetitions > 0 && repetitions < 10,
    'Invalid repetition count',
  )
  await fs.writeFile(
    path.join(evidenceDirectory, 'index-lifecycle-benchmark.raw.jsonl'),
    '',
  )
  await fs.writeFile(
    path.join(evidenceDirectory, 'index-lifecycle-benchmark.native.stderr.log'),
    '',
  )
  const runs: any[] = []
  for (const backend of ['embedded', 'native'] as const) {
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      const root = await fixture()
      let service: ReturnType<typeof Bun.spawn> | undefined
      try {
        if (backend === 'native') service = await startNative(root)
        const cold = await runWorker(backend, 'cold', root)
        const cached = await runWorker(backend, 'cached', root)
        check(
          cold.preciseDigest === cached.preciseDigest,
          'Cached generation changed precise producer data',
        )
        const changed = await runWorker(backend, 'change', root)
        check(
          cold.preciseDigest === changed.preciseDigest,
          'Unrelated one-file change changed precise producer data',
        )
        let restarted: any | undefined
        if (service) {
          await stopNative(service)
          service = undefined
          service = await startNative(root)
          restarted = await runWorker(backend, 'service-restart', root)
          check(
            restarted.preciseDigest === cold.preciseDigest,
            'Service restart changed precise producer data',
          )
        }
        runs.push({ backend, repetition, cold, cached, changed, restarted })
        console.info(
          `${backend} ${repetition}/${repetitions}: cold ${cold.discoveryMs.toFixed(1)}ms, cached ${cached.discoveryMs.toFixed(1)}ms, reconciliation ${cached.reconciliationMs.toFixed(1)}ms, one file ${changed.change.elapsedMs.toFixed(1)}ms`,
        )
      } finally {
        if (service) await stopNative(service)
        await fs.rm(root, { recursive: true, force: true })
      }
    }
  }
  const summaries = (['embedded', 'native'] as const).map((backend) => {
    const selected = runs.filter((run) => run.backend === backend)
    return {
      backend,
      coldDiscoveryMedianMs: median(
        selected.map((run) => run.cold.discoveryMs),
      ),
      cachedDiscoveryMedianMs: median(
        selected.map((run) => run.cached.discoveryMs),
      ),
      cachedReconciliationMedianMs: median(
        selected.map((run) => run.cached.reconciliationMs),
      ),
      oneFileChangeMedianMs: median(
        selected.map((run) => run.changed.change.elapsedMs),
      ),
      oneFileRowWrites: selected.map((run) => run.changed.change.rowWrites),
      oneFileEncodedPutValueBytes: selected.map(
        (run) => run.changed.change.encodedPutValueBytes,
      ),
    }
  })
  const report = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    fixture: {
      generatedCodeFiles: codeFiles,
      indexedFiles: codeFiles + 3,
      repetitions,
    },
    environment: {
      bun: Bun.version,
      node: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
    },
    nativeExecutable: {
      path: executable,
      sha256: createHash('sha256')
        .update(await fs.readFile(executable))
        .digest('hex'),
    },
    methodology: {
      processes:
        'Each phase uses a fresh Bun process; cached phases share only persisted data. Native restart uses SIGKILL and a new service process.',
      timing:
        'Operation clocks start immediately before IndexManager construction; processWallMs includes module/runtime startup and cleanup.',
      bytes:
        'encodedPutValueBytes sums JSON UTF-8 value bytes in committed puts; storage.bytes is live logical JSON bytes; database file sizes are observed allocation, not total disk I/O.',
      fixtureStores:
        'Disposable generated fixtures only; removed after each repetition.',
    },
    summaries,
    runs,
  }
  await fs.writeFile(
    path.join(evidenceDirectory, 'index-lifecycle-benchmark.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  const table = summaries
    .map(
      (entry) =>
        `| ${entry.backend} | ${entry.coldDiscoveryMedianMs.toFixed(1)} | ${entry.cachedDiscoveryMedianMs.toFixed(1)} | ${entry.cachedReconciliationMedianMs.toFixed(1)} | ${entry.oneFileChangeMedianMs.toFixed(1)} | ${entry.oneFileRowWrites.join(', ')} | ${entry.oneFileEncodedPutValueBytes.join(', ')} |`,
    )
    .join('\n')
  await fs.writeFile(
    path.join(evidenceDirectory, 'INDEX-BENCHMARK.md'),
    `# Index lifecycle evidence\n\nRecorded ${report.recordedAt}. ${codeFiles + 3} indexed files; ${repetitions} repetitions per backend, each phase in a fresh process.\n\n| Backend | Cold discovery ms | Cached discovery ms | Cached reconciliation ms | One-file change ms | One-file row writes | One-file put value bytes |\n|---|---:|---:|---:|---:|---|---|\n${table}\n\nEvery cached discovery was available with unverified freshness while reconciliation continued. Every no-change reconciliation parsed zero files, updated zero graph sources and changed zero postings. Every one-file update hashed, parsed and updated one source; its row-write bound was asserted. Precise edge and producer dependency digests remained identical through cached process reopening, unrelated edits and abrupt native service restart.\n\nReproduce from repository root: \`bun .agents/sessions/index-records-architecture-20261114/evidence/index-lifecycle-benchmark.ts\`. Optional variables: \`INDEX_BENCHMARK_FILES\`, \`INDEX_BENCHMARK_REPETITIONS\`, \`INDEX_BENCHMARK_EXECUTABLE\`.\n\nOperation clocks begin before manager construction. The JSON artifact separately records process wall time, native executable SHA-256, every work counter, live storage bytes and observed SQLite/WAL allocation. Put-value byte counts measure committed JSON payloads; they do not claim total physical disk writes. Fixtures are generated locally and deleted; user caches are untouched.\n`,
  )
  console.info(JSON.stringify(summaries))
}

if (process.argv[2] === '--worker')
  await worker(process.argv[3] as Backend, process.argv[4]!, process.argv[5]!)
else await main()
