import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { IndexManager } from '@codebuff/indexer'
import {
  openIndexStorage,
  closeIndexStorage,
} from '@codebuff/indexer/durable-index-store'
import { initializeRepositoryIntelligenceNative } from './repository-intelligence-native'

/** Packaged backend + parser + normalized publication, without providers or user stores. */
export async function smokeRepositoryIntelligence(): Promise<void> {
  const temporary = await mkdtemp(
    path.join(tmpdir(), 'openbuff-intelligence-smoke-'),
  )
  const root = path.join(temporary, 'project')
  await mkdir(root)
  try {
    await writeFile(
      path.join(root, 'feature.ts'),
      'export function rememberedFeature() { return 42 }\n',
    )
    await initializeRepositoryIntelligenceNative({
      cacheRoot: path.join(temporary, 'native'),
    })
    const manager = IndexManager.getInstance(root)
    if (!(await manager.waitUntilReady(15_000, true)))
      throw new Error('Repository index did not reconcile')
    const query = manager.query('rememberedFeature')
    if (!query.results.some((result) => result.path === 'feature.ts'))
      throw new Error('Packaged parser/query returned no feature')
    const { store } = await openIndexStorage(root)
    const stats = await store.stats()
    const declared = JSON.parse(
      await readFile(
        path.join(
          path.dirname(process.execPath),
          'repository-intelligence-manifest.json',
        ),
        'utf8',
      ),
    )
    if (declared.backend === 'rust-sqlite' && stats.backend !== 'rust-sqlite')
      throw new Error('Bundled native service was not adopted')
    console.log(
      JSON.stringify({
        smoke: 'repository intelligence ok',
        backend: stats.backend,
        files: query.results.length,
        records: stats.records,
        writes: stats.writes,
      }),
    )
  } finally {
    await closeIndexStorage(root)
    await rm(temporary, { recursive: true, force: true })
  }
}
