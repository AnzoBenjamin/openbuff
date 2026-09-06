import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { FILE_READ_STATUS } from '@codebuff/common/old-constants'
import {
  makeOutsideRoot,
  outsideRootsUsable,
  removeScratchParentIfEmpty,
} from '@codebuff/common/testing'
import { createNodeError } from '@codebuff/common/testing/errors'
import {
  configureExternalReadRoots,
  resetExternalReadRootsForTesting,
} from '@codebuff/common/util/project-path-containment'
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'

import { readImages } from '../tools/read-image'

import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type { PathLike } from 'node:fs'

afterAll(removeScratchParentIfEmpty)

function createMockFs(files: Record<string, Buffer>): CodebuffFileSystem {
  return {
    readFile: async (filePath: PathLike) => {
      const file = files[String(filePath)]
      if (file) return file
      throw createNodeError(
        `ENOENT: no such file or directory: ${filePath}`,
        'ENOENT',
      )
    },
    stat: async (filePath: PathLike) => {
      const file = files[String(filePath)]
      if (file) {
        return {
          size: file.length,
          isDirectory: () => false,
          isFile: () => true,
          atimeMs: Date.now(),
          mtimeMs: Date.now(),
        }
      }
      throw createNodeError(
        `ENOENT: no such file or directory: ${filePath}`,
        'ENOENT',
      )
    },
    readdir: async () => [],
    mkdir: async () => undefined,
    realpath: async (filePath: PathLike) => String(filePath),
    unlink: async () => undefined,
    writeFile: async () => undefined,
  } as unknown as CodebuffFileSystem
}

describe('readImages', () => {
  test('returns metadata and media for supported images', async () => {
    const image = Buffer.from('fake-png-bytes')
    const output = await readImages({
      paths: ['screens/current.png'],
      cwd: '/project',
      fs: createMockFs({
        '/project/screens/current.png': image,
      }),
    })

    expect(output[0]).toEqual({
      type: 'json',
      value: {
        images: [
          {
            path: 'screens/current.png',
            status: 'attached',
            mediaType: 'image/png',
            sizeBytes: image.length,
            message: 'Image attached as original media.',
          },
        ],
      },
    })
    expect(output[1]).toEqual({
      type: 'media',
      data: image.toString('base64'),
      mediaType: 'image/png',
    })
  })

  test('applies the host file filter before attaching media', async () => {
    const output = await readImages({
      paths: ['screens/private.png'],
      cwd: '/project',
      fs: createMockFs({
        '/project/screens/private.png': Buffer.from('private-image'),
      }),
      fileFilter: () => ({ status: 'blocked' }),
    })

    expect(output).toHaveLength(1)
    expect(output[0]).toMatchObject({
      type: 'json',
      value: {
        images: [
          {
            path: 'screens/private.png',
            status: 'error',
            message: FILE_READ_STATUS.IGNORED,
          },
        ],
      },
    })
  })

  test('preserves large screenshots as original media when under file limit', async () => {
    const image = Buffer.alloc(2_291_770, 1)
    const output = await readImages({
      paths: ['screens/current.png'],
      cwd: '/project',
      fs: createMockFs({
        '/project/screens/current.png': image,
      }),
    })

    expect(output[0].type).toBe('json')
    if (output[0].type !== 'json') throw new Error('Expected JSON output')
    expect(output[0].value.images[0]).toEqual({
      path: 'screens/current.png',
      status: 'attached',
      mediaType: 'image/png',
      sizeBytes: image.length,
      message: 'Image attached as original media.',
    })

    const media = output[1]
    expect(media.type).toBe('media')
    if (media.type !== 'media') throw new Error('Expected media output')
    expect(media.mediaType).toBe('image/png')
    expect(media.data).toBe(image.toString('base64'))
  })

  test('rejects in-project symlinks pointing outside the project root', async () => {
    if (!outsideRootsUsable()) return
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'readimg-root-'))
    // The symlink TARGET must sit outside the OS temp roots too, or the
    // widened temp exception would legitimately admit this read and the
    // escape refusal would never fire.
    const tmpOutside = makeOutsideRoot('readimg-out-')
    try {
      const projectRoot = fs.realpathSync(tmpRoot)
      const outsideDir = fs.realpathSync(tmpOutside)
      const secret = path.join(outsideDir, 'secret.png')
      fs.writeFileSync(secret, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      const linkPath = path.join(projectRoot, 'leak.png')
      fs.symlinkSync(secret, linkPath)

      const output = await readImages({
        paths: ['leak.png'],
        cwd: projectRoot,
        fs: fs.promises,
      })

      expect(output).toHaveLength(1)
      expect(output[0].type).toBe('json')
      if (output[0].type !== 'json') throw new Error('Expected JSON output')
      const entry = output[0].value.images[0]
      expect(entry.status).toBe('error')
      expect(entry.message).toMatch(/outside the project|OUTSIDE_PROJECT/i)
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
      fs.rmSync(tmpOutside, { recursive: true, force: true })
    }
  })

  test('reports unsupported formats without media output', async () => {
    const output = await readImages({
      paths: ['screens/current.txt'],
      cwd: '/project',
      fs: createMockFs({
        '/project/screens/current.txt': Buffer.from('not an image'),
      }),
    })

    expect(output).toHaveLength(1)
    expect(output[0].type).toBe('json')
    if (output[0].type !== 'json') throw new Error('Expected JSON output')
    expect(output[0].value.images[0]).toMatchObject({
      path: 'screens/current.txt',
      status: 'error',
    })
  })
})

describe('readImages — allowlisted external read roots', () => {
  // Synthetic absolute root: every filesystem call in these cases goes through
  // the mock filesystem, and the name deliberately avoids the `openbuff-`
  // owned-temp patterns so an allow here can only come from the external read
  // allowlist — i.e. the readableRoots support read_image documents.
  const externalRoot = path.resolve('/external-read-root')
  const externalImage = path.join(externalRoot, 'notes.png')
  const externalPrivateKeyImage = path.join(externalRoot, 'id_rsa.png')

  beforeEach(() => {
    resetExternalReadRootsForTesting()
  })

  afterEach(() => {
    // The registry is module state: reset unconditionally so no later test
    // inherits an open external read boundary.
    resetExternalReadRootsForTesting()
  })

  test('attaches an image inside an allowlisted root', async () => {
    configureExternalReadRoots([externalRoot])
    const image = Buffer.from('external-png-bytes')

    const output = await readImages({
      paths: [externalImage],
      cwd: '/project',
      fs: createMockFs({ [externalImage]: image }),
    })

    // Regression guard: read_image used to re-check the resolved realpath
    // against the project root, which rejected every external-read resolution
    // with OUTSIDE_PROJECT even though the resolver had already contained it
    // inside the allowlisted root.
    expect(output[0]).toEqual({
      type: 'json',
      value: {
        images: [
          {
            path: externalImage,
            status: 'attached',
            mediaType: 'image/png',
            sizeBytes: image.length,
            message: 'Image attached as original media.',
          },
        ],
      },
    })
    expect(output[1]).toEqual({
      type: 'media',
      data: image.toString('base64'),
      mediaType: 'image/png',
    })
  })

  test('refuses the same image while the registry is unconfigured', async () => {
    // No configureExternalReadRoots call: the default posture is closed, so the
    // allow above is attributable to the allowlist rather than to paths outside
    // the project having become generally readable.
    const output = await readImages({
      paths: [externalImage],
      cwd: '/project',
      fs: createMockFs({ [externalImage]: Buffer.from('external-png-bytes') }),
    })

    expect(output).toHaveLength(1)
    expect(output[0].type).toBe('json')
    if (output[0].type !== 'json') throw new Error('Expected JSON output')
    expect(output[0].value.images[0]).toEqual({
      path: externalImage,
      status: 'error',
      message: FILE_READ_STATUS.OUTSIDE_PROJECT,
    })
  })

  test('refuses a sensitive basename inside an allowlisted root', async () => {
    configureExternalReadRoots([externalRoot])

    const output = await readImages({
      paths: [externalPrivateKeyImage],
      cwd: '/project',
      fs: createMockFs({
        [externalPrivateKeyImage]: Buffer.from('private-key-bytes'),
      }),
      // An allow-everything host filter proves the refusal comes from the
      // resolver's fail-closed mandatory-sensitive check (which returns no
      // resolution at all, hence OUTSIDE_PROJECT), not from host policy.
      fileFilter: () => ({ status: 'allow' }),
    })

    expect(output).toHaveLength(1)
    expect(output[0].type).toBe('json')
    if (output[0].type !== 'json') throw new Error('Expected JSON output')
    expect(output[0].value.images[0]).toEqual({
      path: externalPrivateKeyImage,
      status: 'error',
      message: FILE_READ_STATUS.OUTSIDE_PROJECT,
    })
  })

  test('stats and reads only the resolver-validated operationPath, never a second realpath (TOCTOU)', async () => {
    configureExternalReadRoots([externalRoot])
    // Chained realpath: the caller path dereferences to the target the resolver
    // validates and returns as `operationPath`, and THAT target dereferences
    // again to a redirect. So any second, unvalidated `fs.realpath` in the
    // handler would silently move the stat/read to `redirectTarget` — the
    // TOCTOU window this test pins closed. Only the resolver's single validated
    // dereference may be touched.
    const validatedImage = path.join(externalRoot, 'notes-real.png')
    const redirectTarget = path.resolve(
      '/external-read-secrets/credentials.json',
    )
    const realpathRedirects: Record<string, string> = {
      [externalImage]: validatedImage,
      [validatedImage]: redirectTarget,
    }
    const image = Buffer.from('validated-png-bytes')
    const files: Record<string, Buffer> = {
      [validatedImage]: image,
      // Registered so a redirected read would SUCCEED (and be observable in the
      // output) rather than failing for an unrelated ENOENT reason.
      [redirectTarget]: Buffer.from('redirected-secret-bytes'),
    }
    const statCalls: string[] = []
    const readFileCalls: string[] = []
    const injectedFs = {
      // `realpath` is the minimum member the read-only resolver calls.
      realpath: async (filePath: PathLike) =>
        realpathRedirects[String(filePath)] ?? String(filePath),
      stat: async (filePath: PathLike) => {
        statCalls.push(String(filePath))
        const file = files[String(filePath)]
        if (!file) {
          throw createNodeError(
            `ENOENT: no such file or directory: ${filePath}`,
            'ENOENT',
          )
        }
        return {
          size: file.length,
          isDirectory: () => false,
          isFile: () => true,
          atimeMs: Date.now(),
          mtimeMs: Date.now(),
        }
      },
      readFile: async (filePath: PathLike) => {
        readFileCalls.push(String(filePath))
        const file = files[String(filePath)]
        if (!file) {
          throw createNodeError(
            `ENOENT: no such file or directory: ${filePath}`,
            'ENOENT',
          )
        }
        return file
      },
      readdir: async () => [],
      mkdir: async () => undefined,
      unlink: async () => undefined,
      writeFile: async () => undefined,
    } as unknown as CodebuffFileSystem

    const output = await readImages({
      paths: [externalImage],
      cwd: '/project',
      fs: injectedFs,
    })

    // Exactly the resolver's validated operationPath is stat'd and read...
    expect(statCalls).toEqual([validatedImage])
    expect(readFileCalls).toEqual([validatedImage])
    // ...and the redirect target is never touched.
    expect(statCalls).not.toContain(redirectTarget)
    expect(readFileCalls).not.toContain(redirectTarget)

    // The attached bytes come from the validated path, not the redirect.
    expect(output[0]).toEqual({
      type: 'json',
      value: {
        images: [
          {
            path: externalImage,
            status: 'attached',
            mediaType: 'image/png',
            sizeBytes: image.length,
            message: 'Image attached as original media.',
          },
        ],
      },
    })
    expect(output[1]).toEqual({
      type: 'media',
      data: image.toString('base64'),
      mediaType: 'image/png',
    })
  })

  test('applies a host fileFilter to the external-read policy alias', async () => {
    configureExternalReadRoots([externalRoot])
    // external-read results carry an ABSOLUTE relativePath, so without the
    // scoped alias a host filter written against project-relative globs would
    // silently stop applying — a fail-open.
    const blockedAliases: string[] = []

    const output = await readImages({
      paths: [externalImage],
      cwd: '/project',
      fs: createMockFs({ [externalImage]: Buffer.from('external-png-bytes') }),
      fileFilter: (candidate) => {
        if (candidate === 'external-read/notes.png') {
          blockedAliases.push(candidate)
          return { status: 'blocked' }
        }
        return { status: 'allow' }
      },
    })

    expect(blockedAliases).toEqual(['external-read/notes.png'])
    expect(output).toHaveLength(1)
    expect(output[0].type).toBe('json')
    if (output[0].type !== 'json') throw new Error('Expected JSON output')
    expect(output[0].value.images[0]).toEqual({
      path: externalImage,
      status: 'error',
      message: FILE_READ_STATUS.IGNORED,
    })
  })
})
