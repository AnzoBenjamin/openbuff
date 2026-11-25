import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createHostReadPolicy,
  deriveProjectOnlyReadPolicy,
  getHostReadProjectRoot,
  getHostReadRoots,
  isProjectOnlyReadPolicy,
  resolveProjectPathForRead,
  resolveProjectPathForFileSystemRead,
  type HostReadPolicy,
} from '../project-path-containment'
import { bindFilesystemSandbox, withFilesystemSandbox } from '../filesystem-sandbox'

let root: string, project: string, external: string, parent: HostReadPolicy
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'strict-read-policy-')))
  project = path.join(root, 'project')
  external = path.join(root, 'external')
  fs.mkdirSync(project)
  fs.mkdirSync(external)
  fs.writeFileSync(path.join(project, 'source.ts'), 'export const benign = true\n')
  fs.writeFileSync(path.join(project, '.env'), 'controlled-sensitive-canary')
  fs.writeFileSync(path.join(external, 'notes.txt'), 'controlled-external-canary')
  parent = createHostReadPolicy(project, [external], fs.realpathSync, { mode: 'unrestricted', allowPaths: [external] })
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
const adapter = fs.promises as import('../../types/filesystem').CodebuffFileSystem

describe('authenticated opt-in project-only read policy', () => {
  test('derivation reuses the admission capture and is monotonic', () => {
    let captures = 0
    const original = createHostReadPolicy(project, [external], selected => { captures++; return fs.realpathSync(selected) })
    const strict = deriveProjectOnlyReadPolicy(original)
    expect(captures).toBe(2)
    expect(getHostReadRoots(strict)).toEqual([])
    expect(getHostReadProjectRoot(strict)).toEqual({ projectRoot: project, realProjectRoot: project })
    expect(Object.isFrozen(getHostReadProjectRoot(strict))).toBe(true)
    expect(isProjectOnlyReadPolicy(original)).toBe(false)
    expect(isProjectOnlyReadPolicy(strict)).toBe(true)
    expect(deriveProjectOnlyReadPolicy(strict)).toBe(strict)
    expect(captures).toBe(2)
  })

  test('both resolvers admit benign source and deny sensitive/temp/external targets', async () => {
    const strict = deriveProjectOnlyReadPolicy(parent)
    for (const candidate of ['source.ts', path.join(project, 'source.ts')]) {
      expect(resolveProjectPathForRead(project, candidate, strict)?.scope).toBe('project')
      expect((await resolveProjectPathForFileSystemRead(project, candidate, adapter, strict))?.scope).toBe('project')
    }
    for (const candidate of ['.env', './.env', '.\\.env', '.env ', '../external/notes.txt', path.join(external, 'notes.txt')]) {
      expect(resolveProjectPathForRead(project, candidate, strict)).toBeNull()
      expect(await resolveProjectPathForFileSystemRead(project, candidate, adapter, strict)).toBeNull()
    }
    fs.symlinkSync(path.join(project, '.env'), path.join(project, 'innocent.txt'))
    fs.symlinkSync(path.join(external, 'notes.txt'), path.join(project, 'outside.txt'))
    for (const candidate of ['innocent.txt', 'outside.txt']) {
      expect(resolveProjectPathForRead(project, candidate, strict)).toBeNull()
      expect(await resolveProjectPathForFileSystemRead(project, candidate, adapter, strict)).toBeNull()
    }
  })

  test('ambient or rebound sandbox policy cannot widen strict reads', async () => {
    const strict = deriveProjectOnlyReadPolicy(parent)
    bindFilesystemSandbox(strict, { mode: 'unrestricted', allowPaths: [external] })
    await withFilesystemSandbox({ mode: 'unrestricted', allowPaths: [external] }, async () => {
      expect(resolveProjectPathForRead(project, '.env', strict)).toBeNull()
      expect(await resolveProjectPathForFileSystemRead(project, path.join(external, 'notes.txt'), adapter, strict)).toBeNull()
      expect(resolveProjectPathForRead(project, 'source.ts', strict)?.scope).toBe('project')
    })
  })

  test('forged, cloned and wrong-project tokens fail closed', async () => {
    const strict = deriveProjectOnlyReadPolicy(parent)
    for (const token of [{}, { ...strict }, JSON.parse(JSON.stringify(strict))]) {
      expect(isProjectOnlyReadPolicy(token)).toBe(false)
      expect(() => deriveProjectOnlyReadPolicy(token as HostReadPolicy)).toThrow('Invalid host read policy')
      expect(() => getHostReadProjectRoot(token as HostReadPolicy)).toThrow('Invalid host read policy')
      expect(resolveProjectPathForRead(project, 'source.ts', token as HostReadPolicy)).toBeNull()
      expect(await resolveProjectPathForFileSystemRead(project, 'source.ts', adapter, token as HostReadPolicy)).toBeNull()
    }
    expect(resolveProjectPathForRead(external, 'notes.txt', strict)).toBeNull()
    expect(await resolveProjectPathForFileSystemRead(external, 'notes.txt', adapter, strict)).toBeNull()
  })

  test('retargeting a selected root never recaptures the derived boundary', async () => {
    const selected = path.join(root, 'selected')
    fs.symlinkSync(project, selected)
    const captured = createHostReadPolicy(selected, [], fs.realpathSync)
    fs.unlinkSync(selected)
    fs.symlinkSync(external, selected)
    const strict = deriveProjectOnlyReadPolicy(captured)
    expect(getHostReadProjectRoot(strict)).toEqual({ projectRoot: selected, realProjectRoot: project })
    expect(resolveProjectPathForRead(selected, 'notes.txt', strict)).toBeNull()
    expect(await resolveProjectPathForFileSystemRead(selected, 'notes.txt', adapter, strict)).toBeNull()
  })

  test('non-opt-in unrestricted control is unchanged', async () => {
    for (const candidate of ['.env', path.join(external, 'notes.txt')]) {
      expect(resolveProjectPathForRead(project, candidate, parent)).not.toBeNull()
      expect(await resolveProjectPathForFileSystemRead(project, candidate, adapter, parent)).not.toBeNull()
    }
  })
})
