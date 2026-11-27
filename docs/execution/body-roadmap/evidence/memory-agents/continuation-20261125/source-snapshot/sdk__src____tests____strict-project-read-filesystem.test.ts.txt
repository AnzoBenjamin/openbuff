import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  createHostReadPolicy,
  deriveProjectOnlyReadPolicy,
} from '@codebuff/common/util/project-path-containment'
import { bindFilesystemSandbox } from '@codebuff/common/util/filesystem-sandbox'
import { bindHostFileSystem } from '../services/host-filesystem'
import { createNodeFileSystem } from '../tools/node-filesystem'
import { getFilesStructured } from '../tools/read-files'
import { listDirectory, supportsStreamDirectory } from '../tools/list-directory'

let root: string, project: string, outside: string
beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'guarded-project-read-')),
  )
  project = path.join(root, 'project')
  outside = path.join(root, 'outside.txt')
  fs.mkdirSync(project)
  fs.mkdirSync(path.join(project, 'src'))
  fs.writeFileSync(
    path.join(project, 'src', 'source.ts'),
    'first\nsecond\nthird\n',
  )
  fs.writeFileSync(path.join(project, '.env'), 'controlled-sensitive-canary')
  fs.writeFileSync(outside, 'controlled-outside-canary')
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
function views(options: Parameters<typeof createNodeFileSystem>[0] = {}) {
  const policy = createHostReadPolicy(project, [root], fs.realpathSync, {
    mode: 'unrestricted',
    allowPaths: [root],
  })
  const source = createNodeFileSystem(options)
  const ordinary = bindHostFileSystem(source, policy)
  const strictPolicy = deriveProjectOnlyReadPolicy(policy)
  return {
    source,
    ordinary,
    strictPolicy,
    strict: bindHostFileSystem(ordinary, strictPolicy),
  }
}

describe('opened-target strict project read views', () => {
  test('benign byte/text/directory reads retain bounded view contracts', async () => {
    const { strict } = views()
    const target = path.join(project, 'src', 'source.ts')
    expect(await strict.readFile(target, 'utf8')).toBe('first\nsecond\nthird\n')
    expect(
      Buffer.from((await strict.readRange!(target, 6, 12)).data).toString(),
    ).toBe('second')
    expect(strict.readTextFile!.readFileView).toBe(strict.readFile)
    expect(strict.readTextRange!.readFileView).toBe(strict.readFile)
    const range = await strict.readTextRange!(target, 2, 2, 8)
    expect(Buffer.from(range.data).toString()).toBe('second\n')
    expect(range).toMatchObject({
      startLine: 2,
      endLine: 2,
      complete: true,
      metadataComplete: true,
    })
    expect(await strict.readdir(path.join(project, 'src'))).toEqual([
      'source.ts',
    ])
    expect(supportsStreamDirectory(strict)).toBe(true)
    expect(strict.streamDirectory!.readdirView).toBe(strict.readdir)
    const read = await getFilesStructured({
      filePaths: ['src/source.ts'],
      cwd: project,
      fs: strict,
    })
    expect(read.results[0]).toMatchObject({ status: 'ok', complete: true })
  })

  test('sensitive, owned-temp, external, symlink, hardlink and special-file targets never return bytes', async () => {
    const { strict } = views()
    fs.symlinkSync(outside, path.join(project, 'outside-alias.txt'))
    fs.symlinkSync(
      path.join(project, '.env'),
      path.join(project, 'sensitive-alias.txt'),
    )
    fs.linkSync(outside, path.join(project, 'hardlink.txt'))
    const fifo = path.join(project, 'pipe')
    expect(spawnSync('/usr/bin/mkfifo', [fifo]).status).toBe(0)
    for (const target of [
      '.env',
      '.env ',
      'outside-alias.txt',
      'sensitive-alias.txt',
      'hardlink.txt',
      'pipe',
      outside,
    ]) {
      const full = path.isAbsolute(target) ? target : path.join(project, target)
      await expect(strict.readFile(full)).rejects.toThrow()
      await expect(strict.readRange!(full, 0, 8)).rejects.toThrow()
      await expect(strict.readTextFile!(full, 32)).rejects.toThrow()
    }
    const listing = await listDirectory({
      directoryPath: '.',
      projectPath: project,
      fs: strict,
    })
    expect(listing[0]).toMatchObject({
      type: 'json',
      value: { files: [], directories: ['src'] },
    })
  })

  test('a symlink substituted immediately before a body read is refused before capture', async () => {
    const target = path.join(project, 'src', 'source.ts')
    let replaced = false,
      reads = 0
    const { strict } = views({
      textReadInstrumentation: {
        observe(event) {
          if (event.seam === 'before_read' && !replaced) {
            replaced = true
            fs.renameSync(target, path.join(project, 'src', 'old.ts'))
            fs.symlinkSync(outside, target)
          }
          if (event.seam === 'read') reads++
        },
      },
    })
    await expect(strict.readTextFile!(target, 64)).rejects.toThrow()
    expect(replaced).toBe(true)
    expect(reads).toBe(0)
  })

  test('a newly created hardlink is refused before a body read', async () => {
    const target = path.join(project, 'src', 'source.ts')
    let linked = false,
      reads = 0
    const { strict } = views({
      textReadInstrumentation: {
        observe(event) {
          if (event.seam === 'before_read' && !linked) {
            linked = true
            fs.linkSync(target, path.join(root, 'new-alias'))
          }
          if (event.seam === 'read') reads++
        },
      },
    })
    await expect(strict.readTextFile!(target, 64)).rejects.toThrow()
    expect(reads).toBe(0)
  })

  test('replacement after capture is refused instead of publishing the held old file', async () => {
    const target = path.join(project, 'src', 'source.ts')
    let replaced = false
    const { strict } = views({
      textReadInstrumentation: {
        observe(event) {
          if (event.seam === 'read' && !replaced) {
            replaced = true
            fs.renameSync(target, path.join(project, 'src', 'previous.ts'))
            fs.writeFileSync(target, 'replacement\n')
          }
        },
      },
    })
    await expect(strict.readTextFile!(target, 64)).rejects.toThrow()
    expect(replaced).toBe(true)
  })

  test('an intermediate directory swap cannot redirect a held traversal', async () => {
    const target = path.join(project, 'src', 'source.ts')
    const elsewhere = path.join(root, 'elsewhere')
    fs.mkdirSync(elsewhere)
    fs.writeFileSync(
      path.join(elsewhere, 'source.ts'),
      'controlled-directory-canary',
    )
    let replaced = false
    const { strict } = views({
      textReadInstrumentation: {
        observe(event) {
          if (event.seam === 'before_read' && !replaced) {
            replaced = true
            fs.renameSync(
              path.join(project, 'src'),
              path.join(project, 'old-src'),
            )
            fs.symlinkSync(elsewhere, path.join(project, 'src'))
          }
        },
      },
    })
    await expect(strict.readTextFile!(target, 64)).rejects.toThrow()
  })

  test('unsupported/decorated adapters fail unavailable without reading raw host or custom bytes', async () => {
    const { source, strictPolicy } = views()
    let reads = 0
    const custom = Object.assign(Object.create(source), {
      readFile: async () => {
        reads++
        return Buffer.from('unsafe-custom-bytes')
      },
    })
    const guarded = bindHostFileSystem(custom, strictPolicy)
    await expect(
      guarded.readFile(path.join(project, 'src', 'source.ts')),
    ).rejects.toThrow('unavailable')
    const result = await getFilesStructured({
      filePaths: ['src/source.ts'],
      cwd: project,
      fs: guarded,
    })
    expect(result.results[0]?.status).toBe('error')
    expect(JSON.stringify(result)).not.toContain('unsafe-custom-bytes')
    expect(reads).toBe(0)
    expect(() => bindHostFileSystem(source, { ...strictPolicy })).toThrow(
      'Invalid host read policy',
    )
  })

  test('an unverified custom descriptor-open seam cannot fall back to raw host files', async () => {
    let opens = 0
    const { strict } = views({
      textReadInstrumentation: {
        async open() {
          opens++
          throw new Error('unverified custom view')
        },
      },
    })
    await expect(
      strict.readFile(path.join(project, 'src', 'source.ts')),
    ).rejects.toThrow('unavailable')
    await expect(
      strict.readTextFile!(path.join(project, 'src', 'source.ts'), 32),
    ).rejects.toThrow('unavailable')
    expect(opens).toBe(0)
  })

  test('rebound sandbox cannot weaken guarded reads and ordinary unrestricted access is unchanged', async () => {
    const { ordinary, strict, strictPolicy } = views()
    bindFilesystemSandbox(strictPolicy, {
      mode: 'unrestricted',
      allowPaths: [root],
    })
    await expect(strict.readFile(outside)).rejects.toThrow()
    await expect(strict.readFile(path.join(project, '.env'))).rejects.toThrow()
    expect(await ordinary.readFile(outside, 'utf8')).toBe(
      'controlled-outside-canary',
    )
    expect(await ordinary.readFile(path.join(project, '.env'), 'utf8')).toBe(
      'controlled-sensitive-canary',
    )
  })
})
