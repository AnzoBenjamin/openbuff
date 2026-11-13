import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import {
  createNodeFileSystem,
  NODE_TEXT_READ_CHUNK_BYTES,
} from '../tools/node-filesystem'
import { getExactContentHash } from '@codebuff/common/util/content-hash'
import { changeFile } from '../tools/change-file'
import { WorkspaceMutationBroker } from '../services/workspace-mutation-broker'
import { detectFilesystemCapabilities } from '../tools/filesystem-authority'

test('default Node filesystem provides bounded text range reads', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openbuff-range-'))
  const file = path.join(directory, 'large.txt')
  try {
    await writeFile(file, 'one\ntwo\nthree\nfour\n')
    const fs = createNodeFileSystem()
    expect(fs.conditionalCommit).toBeUndefined()
    expect(fs.conditionalDelete).toBeUndefined()
    expect(fs.conditionalMove).toBeUndefined()
    const result = await fs.readTextRange!(file, 2, 3, 1024)
    expect(Buffer.from(result.data).toString('utf8')).toBe('two\nthree\n')
    expect(result).toMatchObject({
      startLine: 2,
      endLine: 3,
      totalLines: 4,
      complete: true,
      metadataComplete: true,
      rawBasis: {
        scope: 'lines',
        rawHash: getExactContentHash('two\nthree\n'),
        documentRawHash: getExactContentHash('one\ntwo\nthree\nfour\n'),
        startByte: 4,
        endByteExclusive: 14,
        view: 'descriptor',
        coherence: 'checked',
      },
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('whole bounded reads preserve BOM bytes and distinguish visible/final-empty entries', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openbuff-byte-'))
  const file = path.join(directory, 'text.txt')
  try {
    const fs = createNodeFileSystem()
    for (const [content, visible, ceiling] of [
      ['', 0, 1],
      ['\uFEFF', 0, 1],
      ['a\n', 1, 2],
      ['a', 1, 1],
      ['\uFEFFa\r\n', 1, 2],
    ] as const) {
      await writeFile(file, content)
      const result = await fs.readTextFile!(file, 1024)
      expect(Buffer.from(result.data).toString('utf8')).toBe(content)
      expect(result).toMatchObject({
        totalLines: visible,
        endLine: ceiling,
        complete: true,
        metadataComplete: true,
        rawBasis: {
          scope: 'whole',
          rawHash: getExactContentHash(content),
          includesBom: content.startsWith('\uFEFF'),
        },
      })
    }
    await writeFile(file, '\uFEFFa\r\n\uFEFFlater\n')
    const later = await fs.readTextRange!(file, 2, 2, 1024)
    expect(Buffer.from(later.data).toString('utf8')).toBe('\uFEFFlater\n')
    expect(later.rawBasis).toMatchObject({
      scope: 'lines',
      includesBom: false,
      documentBom: 'utf8',
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('skipped and rejected long lines retain only the actual B/C backing capacities', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openbuff-budget-'))
  const file = path.join(directory, 'text.txt')
  try {
    let peak = 0
    let pending = 0
    const fs = createNodeFileSystem({
      textReadInstrumentation: {
        observe(event) {
          const capacities = new Map<ArrayBufferLike, number>([
            [event.output.buffer, event.output.buffer.byteLength],
            [event.input.buffer, event.input.buffer.byteLength],
          ])
          peak = Math.max(
            peak,
            [...capacities.values()].reduce((sum, value) => sum + value, 0),
          )
          pending = Math.max(pending, event.pendingBytes)
        },
      },
    })
    await writeFile(
      file,
      `${'x'.repeat(2 * NODE_TEXT_READ_CHUNK_BYTES)}\nyes\n`,
    )
    const skipped = await fs.readTextRange!(file, 2, 2, 1024)
    expect(Buffer.from(skipped.data).toString('utf8')).toBe('yes\n')
    const rejected = await fs.readTextRange!(file, 1, 1, 1024)
    expect(rejected).toMatchObject({
      complete: false,
      metadataComplete: true,
      totalLines: 2,
    })
    expect(rejected.data.byteLength).toBe(0)
    expect(rejected.rawBasis).toBeUndefined()
    expect(peak).toBe(1024 + NODE_TEXT_READ_CHUNK_BYTES)
    expect(pending).toBeLessThanOrEqual(1024)
    expect(rejected.data.buffer.byteLength).toBe(1024)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('pre-abort and invalid budgets open nothing; zero budget still observes EOF', async () => {
  let opened = 0
  const fs = createNodeFileSystem({
    textReadInstrumentation: {
      open: async (filePath, flags) => {
        opened++
        return open(filePath, flags)
      },
    },
  })
  const controller = new AbortController()
  controller.abort(new Error('pre-abort'))
  await expect(
    fs.readTextRange!('/missing', 1, 1, 1024, { signal: controller.signal }),
  ).rejects.toThrow('pre-abort')
  for (const budget of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await expect(
      fs.readTextRange!('/missing', 1, 1, budget),
    ).rejects.toBeInstanceOf(RangeError)
  }
  expect(opened).toBe(0)
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openbuff-zero-'))
  const file = path.join(directory, 'text.txt')
  try {
    await writeFile(file, '')
    expect(await fs.readTextFile!(file, 0)).toMatchObject({
      complete: true,
      metadataComplete: true,
      totalLines: 0,
    })
    await writeFile(file, 'a')
    expect(await fs.readTextFile!(file, 0)).toMatchObject({
      complete: false,
      metadataComplete: true,
      totalLines: 1,
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('aborted descriptor reads settle only after actual delayed close and never return a view', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openbuff-close-'))
  const file = path.join(directory, 'text.txt')
  let releaseClose!: () => void
  let markClosing!: () => void
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve
  })
  const closing = new Promise<void>((resolve) => {
    markClosing = resolve
  })
  const controller = new AbortController()
  let settled = false
  const seams: string[] = []
  try {
    await writeFile(file, 'a\n')
    const fs = createNodeFileSystem({
      textReadInstrumentation: {
        open: async (filePath, flags) => {
          const handle = await open(filePath, flags)
          return {
            stat: handle.stat.bind(handle),
            read: handle.read.bind(handle),
            close: async () => {
              markClosing()
              await closeGate
              await handle.close()
            },
          }
        },
        observe(event) {
          seams.push(event.seam)
          if (event.seam === 'before_read')
            controller.abort(new Error('cancelled during retaining'))
        },
      },
    })
    const pending = fs.readTextRange!(file, 1, 1, 1024, {
      signal: controller.signal,
    })
    pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await closing
    expect(settled).toBe(false)
    releaseClose()
    await expect(pending).rejects.toThrow('cancelled during retaining')
    expect(seams).toContain('close')
    expect(seams).not.toContain('return')
  } finally {
    releaseClose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('invalid UTF-8 in discarded metadata closes the descriptor without returning authority', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openbuff-utf8-'))
  const file = path.join(directory, 'text.txt')
  const seams: string[] = []
  try {
    await writeFile(file, Buffer.from([0x61, 0x0a, 0xed, 0xa0, 0x80]))
    const fs = createNodeFileSystem({
      textReadInstrumentation: {
        observe(event) {
          seams.push(event.seam)
        },
      },
    })
    await expect(fs.readTextRange!(file, 1, 1, 1024)).rejects.toMatchObject({
      code: 'UNSUPPORTED_ENCODING',
    })
    expect(seams).toContain('close')
    expect(seams).not.toContain('return')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('default Node filesystem fails closed instead of emulating conditional commit', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openbuff-cas-'))
  const file = path.join(directory, 'file.txt')
  try {
    await writeFile(file, 'before\n')
    const fs = createNodeFileSystem()
    const result = await changeFile({
      parameters: {
        type: 'file',
        path: 'file.txt',
        content: 'after\n',
      },
      cwd: directory,
      fs,
    })
    expect(result[0]?.type === 'json' ? result[0].value : null).toMatchObject({
      outcome: 'not_applied',
      errors: [expect.objectContaining({ code: 'unsupported' })],
    })
    expect(await fs.readFile(file, 'utf8')).toBe('before\n')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('broker-backed Node filesystem exposes cooperative conditional mutations', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openbuff-broker-fs-'))
  const stateDir = path.join(directory, 'state')
  const workspace = path.join(directory, 'workspace')
  const file = path.join(workspace, 'file.txt')
  try {
    await mkdir(workspace, { recursive: true })
    await writeFile(file, 'before\n')
    const broker = await WorkspaceMutationBroker.create({
      cwd: workspace,
      stateDir,
    })
    const fs = createNodeFileSystem({ mutationBroker: broker })
    expect(fs.conditionalCommit).toBeFunction()
    expect(fs.conditionalDelete).toBeFunction()
    expect(fs.conditionalMove).toBeFunction()
    expect(detectFilesystemCapabilities(fs).tier).toBe('cooperative')

    const result = await changeFile({
      parameters: {
        type: 'file',
        path: 'file.txt',
        content: 'after\n',
      },
      cwd: workspace,
      fs,
    })
    expect(result[0]?.type === 'json' ? result[0].value : null).toMatchObject({
      outcome: 'applied',
      authorityTier: 'conditional_commit',
    })
    expect(await fs.readFile(file, 'utf8')).toBe('after\n')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
