import { expect, test } from 'bun:test'
import { createMockFs } from '@codebuff/common/testing/mocks/filesystem'
import { createHostReadPolicy } from '@codebuff/common/util/project-path-containment'
import { bindHostFileSystem } from '../services/host-filesystem'
import { getDefaultFilesystemAuthority } from '../tools/filesystem-authority'
import { createNodeFileSystem } from '../tools/node-filesystem'
import type { CodebuffFileSystem, CodebuffTextRangeReadResult } from '@codebuff/common/types/filesystem'
import type { Dirent } from 'node:fs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const policy = () => createHostReadPolicy('/virtual/project', ['/approved'], value => value)

function privateAdapter() {
  const calls: Array<{ method: string; limit?: number }> = []
  let released = 0
  class Adapter {
    #text = 'receiver-owned bytes'
    async readFile() { calls.push({ method: 'readFile' }); return this.#text }
    async readdir() { calls.push({ method: 'readdir' }); return [this.#text] }
    async realpath(value: string) { calls.push({ method: 'realpath' }); return this.#text ? value : '' }
    async readTextFile(_path: unknown, limit: number): Promise<CodebuffTextRangeReadResult> {
      calls.push({ method: 'readTextFile', limit })
      return { data: Buffer.from(this.#text).subarray(0, limit), startLine: 1, endLine: 1, totalLines: 1, complete: false }
    }
    async readTextRange(_path: unknown, _start: number, _end: number, limit: number): Promise<CodebuffTextRangeReadResult> {
      calls.push({ method: 'readTextRange', limit })
      return { data: Buffer.from(this.#text).subarray(0, limit), startLine: 1, endLine: 1, totalLines: 1, complete: false }
    }
    async readRange(_path: unknown, start: number, end: number) {
      calls.push({ method: 'readRange' })
      return { data: Buffer.from(this.#text).subarray(start, end), endExclusive: end }
    }
    async conditionalCommit() { calls.push({ method: 'conditionalCommit' }); return { applied: this.#text.length > 0 } }
    async streamDirectory() {
      calls.push({ method: 'streamDirectory' })
      const text = this.#text
      return (async function* () {
        try {
          yield { name: text } as Dirent
          yield { name: 'second' } as Dirent
        } finally { released++ }
      })()
    }
  }
  const base = createMockFs()
  const adapter = Object.assign(new Adapter(), {
    mkdir: base.mkdir, stat: base.stat, unlink: base.unlink, writeFile: base.writeFile,
    mutationAuthority: 'native_atomic' as const, hostProcessView: true,
  })
  Object.assign(adapter.readTextFile, { readFileView: adapter.readFile })
  Object.assign(adapter.readTextRange, { readFileView: adapter.readFile })
  Object.assign(adapter.streamDirectory, { readdirView: adapter.readdir })
  // The fixture only uses the filesystem call forms above; production consumers
  // still see the complete Node overload surface on CodebuffFileSystem.
  return { source: adapter as unknown as CodebuffFileSystem, calls, get released() { return released } }
}

test('host filesystem wrapper preserves private-class receivers even for detached calls', async () => {
  const fixture = privateAdapter()
  const readPolicy = policy()
  const bound = bindHostFileSystem(fixture.source, readPolicy)
  const { readFile, readdir, realpath, readRange, conditionalCommit } = bound
  expect(await readFile('/virtual/file', 'utf8')).toBe('receiver-owned bytes')
  expect(await readdir('/virtual')).toEqual(['receiver-owned bytes'])
  expect(await realpath('/virtual/file')).toBe('/virtual/file')
  expect((await readRange!('/virtual/file', 0, 8)).data).toEqual(Buffer.from('receiver'))
  expect(await conditionalCommit!('/virtual/file', 'updated', { expectedHash: null })).toEqual({ applied: true })
  expect(bound.hostReadPolicy).toBe(readPolicy)
  expect(bound.mutationAuthority).toBe('native_atomic')
  expect(bound.hostProcessView).toBe(true)
  expect(Object.isFrozen(bound)).toBe(true)
})

test('bounded read views remain paired with the wrapper and preserve byte limits', async () => {
  const fixture = privateAdapter()
  const bound = bindHostFileSystem(fixture.source, policy())
  expect(bound.readTextFile!.readFileView).toBe(bound.readFile)
  expect(bound.readTextRange!.readFileView).toBe(bound.readFile)
  expect((await bound.readTextFile!('/virtual/file', 4)).data).toEqual(Buffer.from('rece'))
  expect((await bound.readTextRange!('/virtual/file', 1, 1, 3)).data).toEqual(Buffer.from('rec'))
  expect(fixture.calls).toEqual([{ method: 'readTextFile', limit: 4 }, { method: 'readTextRange', limit: 3 }])
  expect(Object.isFrozen(bound.readTextFile)).toBe(true)
})

test('stream directory view remains paired and early exit releases its source iterator', async () => {
  const fixture = privateAdapter()
  const bound = bindHostFileSystem(fixture.source, policy())
  expect(bound.streamDirectory!.readdirView).toBe(bound.readdir)
  const entries = []
  for await (const entry of await bound.streamDirectory!('/virtual')) { entries.push(entry.name); break }
  expect(entries).toEqual(['receiver-owned bytes'])
  expect(fixture.released).toBe(1)
})

test('a mismatched optional view is preserved as mismatched, never relabeled authoritative', () => {
  const fixture = privateAdapter()
  const foreign = createMockFs()
  fixture.source.readTextFile!.readFileView = foreign.readFile
  fixture.source.readTextRange!.readFileView = foreign.readFile
  fixture.source.streamDirectory!.readdirView = foreign.readdir
  const bound = bindHostFileSystem(fixture.source, policy())
  expect(bound.readTextFile!.readFileView).toBe(foreign.readFile)
  expect(bound.readTextRange!.readFileView).not.toBe(bound.readFile)
  expect(bound.streamDirectory!.readdirView).toBe(foreign.readdir)
  expect(bound.streamDirectory!.readdirView).not.toBe(bound.readdir)
})

test('missing optional authority stays absent instead of being synthesized', () => {
  const source = createMockFs()
  delete source.readTextFile
  delete source.readTextRange
  delete source.readRange
  delete source.conditionalCommit
  delete source.streamDirectory
  const bound = bindHostFileSystem(source, policy())
  expect(bound.readTextFile).toBeUndefined()
  expect(bound.readTextRange).toBeUndefined()
  expect(bound.readRange).toBeUndefined()
  expect(bound.conditionalCommit).toBeUndefined()
  expect(bound.streamDirectory).toBeUndefined()
})

test.each([true, false])('default authority preserves exclusive creation with a frozen host adapter; supplied=%s', async supplied => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b19-frozen-filesystem-'))
  try {
    const source = createNodeFileSystem()
    if (!supplied) delete source.createFileExclusive
    const bound = bindHostFileSystem(source, createHostReadPolicy(root, [], value => value))
    const authority = getDefaultFilesystemAuthority(root, bound)
    expect(getDefaultFilesystemAuthority(root, bound)).toBe(authority)
    const authorized = await authority.authorizePath('created.txt', 'create')
    if (!authorized.allowed) throw new Error(authorized.code)
    expect(await authority.createExclusive(authorized.path, 'created bytes')).toEqual({ supported: true })
    expect(fs.readFileSync(path.join(root, 'created.txt'), 'utf8')).toBe('created bytes')
    await expect(authority.createExclusive(authorized.path, 'overwrite')).rejects.toMatchObject({ code: 'EEXIST' })
    expect(fs.readFileSync(path.join(root, 'created.txt'), 'utf8')).toBe('created bytes')
    expect((await authority.authorizePath('../outside.txt', 'create')).allowed).toBe(false)
    expect(Object.isFrozen(bound)).toBe(true)
    expect(typeof bound.createFileExclusive).toBe(supplied ? 'function' : 'undefined')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
