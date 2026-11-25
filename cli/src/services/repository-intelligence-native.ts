import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { setIndexStorageFactory } from '@codebuff/indexer/storage-port'
import { openRepositoryServiceStorage } from '@codebuff/indexer/repository-service-client'

let initialized: Promise<void> | undefined

/** Backend releases may change executable bytes without changing store identity. */
export function repositoryIntelligenceCacheKey(
  directory: string,
  gitCommonDir?: string,
): string {
  const storageDirectory = gitCommonDir
    ? path.join(gitCommonDir, 'openbuff-index')
    : directory
  return createHash('sha256')
    .update(path.resolve(storageDirectory))
    .digest('hex')
    .slice(0, 24)
}

/** Host-owned bundled infrastructure; project files cannot select its executable. */
export function initializeRepositoryIntelligenceNative(
  options: { cacheRoot?: string } = {},
): Promise<void> {
  return (initialized ??= (async () => {
    const directory = path.dirname(process.execPath)
    const fileName =
      process.platform === 'win32'
        ? 'openbuff-intelligence.exe'
        : 'openbuff-intelligence'
    const executable = path.join(directory, fileName)
    const manifest = path.join(
      directory,
      'repository-intelligence-manifest.json',
    )
    if (!existsSync(manifest)) return // Source development and SDK use the embedded port.
    const declared = JSON.parse(await readFile(manifest, 'utf8'))
    if (declared.backend === 'embedded' && declared.protocolVersion === 1)
      return
    const metadata = await lstat(executable)
    if (
      declared.protocolVersion !== 1 ||
      declared.file !== fileName ||
      declared.platform !== process.platform ||
      declared.arch !== process.arch ||
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (await realpath(executable)) !== executable ||
      createHash('sha256')
        .update(await readFile(executable))
        .digest('hex') !== declared.sha256
    )
      throw new Error(
        'Bundled repository service failed integrity verification',
      )
    setIndexStorageFactory(async (storageOptions) => {
      const key = repositoryIntelligenceCacheKey(
        storageOptions.directory,
        storageOptions.identity.gitCommonDir,
      )
      const cache = path.join(
        options.cacheRoot ??
          path.join(homedir(), '.cache', 'openbuff', 'intelligence'),
        key,
      )
      try {
        return await openRepositoryServiceStorage({
          directory: cache,
          executable,
        })
      } catch (error) {
        // Do not silently switch a previously native canonical head to another
        // store after an uncertain write. Missing service is a degraded query.
        throw new Error(
          `Repository service unavailable: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    })
  })())
}
