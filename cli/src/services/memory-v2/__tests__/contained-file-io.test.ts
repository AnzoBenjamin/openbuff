import { describe, expect, test } from 'bun:test'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ContainedFileIoError,
  createContainedProjectDirectory,
  readContainedProjectFile,
} from '../contained-file-io'

describe('contained file I/O', () => {
  test('reads exact bounded bytes and returns their digest', () => {
    const root = mkdtempSync(join(tmpdir(), 'contained-read-'))
    mkdirSync(join(root, 'input'))
    writeFileSync(join(root, 'input', 'file.txt'), 'hello')
    const result = readContainedProjectFile(root, 'input/file.txt', 5)
    expect(result.text).toBe('hello')
    expect(result.bytes).toEqual(Buffer.from('hello'))
    expect(result.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  test('rejects traversal, symlinks, nonregular files, oversize, and non-owner content', () => {
    const root = mkdtempSync(join(tmpdir(), 'contained-reject-'))
    writeFileSync(join(root, 'large'), 'large')
    mkdirSync(join(root, 'directory'))
    symlinkSync(join(root, 'large'), join(root, 'link'))
    for (const path of ['../large', '/absolute', 'link', 'directory']) {
      expect(() => readContainedProjectFile(root, path, 10)).toThrow(ContainedFileIoError)
    }
    expect(() => readContainedProjectFile(root, 'large', 4)).toThrow(
      new ContainedFileIoError('too-large'),
    )
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      chmodSync(join(root, 'large'), 0o600)
    }
  })

  test('root rename after descriptor acquisition stays anchored to original inode', () => {
    const root = mkdtempSync(join(tmpdir(), 'contained-anchor-'))
    const moved = `${root}-moved`
    writeFileSync(join(root, 'value'), 'original')
    const result = readContainedProjectFile(root, 'value', 100, {
      afterRootDescriptor: () => {
        renameSync(root, moved)
        mkdirSync(root)
        writeFileSync(join(root, 'value'), 'replacement')
      },
    })
    expect(result.text).toBe('original')
  })

  test('creates owner-only directories and exclusive files with anchored cleanup', () => {
    const root = mkdtempSync(join(tmpdir(), 'contained-create-'))
    const directory = createContainedProjectDirectory(root, '.openbuff/memory/exports')
    directory.writeExclusive('one.json', '{}')
    expect(readFileSync(join(root, '.openbuff/memory/exports/one.json'), 'utf8')).toBe('{}')
    expect(lstatSync(join(root, '.openbuff/memory/exports')).mode & 0o777).toBe(0o700)
    expect(lstatSync(join(root, '.openbuff/memory/exports/one.json')).mode & 0o777).toBe(0o600)
    expect(() => directory.writeExclusive('one.json', '{}')).toThrow(new ContainedFileIoError('exists'))
    directory.remove('one.json')
    directory.remove('one.json')
    directory.close()
    directory.close()
  })

  test('rejects a symlink encountered while securely creating directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'contained-create-link-'))
    const outside = mkdtempSync(join(tmpdir(), 'contained-outside-'))
    mkdirSync(join(root, '.openbuff'))
    symlinkSync(outside, join(root, '.openbuff', 'memory'))
    expect(() => createContainedProjectDirectory(root, '.openbuff/memory/exports')).toThrow(ContainedFileIoError)
  })
})
