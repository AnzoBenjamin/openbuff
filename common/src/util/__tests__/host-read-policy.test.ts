import { afterEach, expect, test } from 'bun:test'
import { createMockFs } from '../../testing/mocks/filesystem'
import { configureExternalReadRoots, createHostReadPolicy, getHostReadRoots, resetExternalReadRootsForTesting, resolveProjectPath, resolveProjectPathForFileSystemRead, resolveProjectPathForRead } from '../project-path-containment'
import type { HostReadPolicy } from '../project-path-containment'

const project = '/virtual/host-policy-project'
afterEach(resetExternalReadRootsForTesting)

test('host policy authenticates identity and project before consulting a filesystem', async () => {
  const policy = createHostReadPolicy(project, ['/approved'], value => value)
  let calls = 0
  const fileSystem = createMockFs({ realpathImpl: async value => { calls++; return value } })
  const copied = { ...policy } as HostReadPolicy
  expect(() => getHostReadRoots(copied)).toThrow('Invalid host read policy')
  expect(resolveProjectPathForRead(project, 'inside.ts', copied)).toBeNull()
  expect(await resolveProjectPathForFileSystemRead(project, 'inside.ts', fileSystem, copied)).toBeNull()
  expect(await resolveProjectPathForFileSystemRead('/different-project', '/approved/file.ts', fileSystem, policy)).toBeNull()
  expect(calls).toBe(0)
})

test('host read roots are immutable and do not grant write containment', async () => {
  const roots = ['/approved']
  const policy = createHostReadPolicy(project, roots, value => value)
  roots.push('/later')
  expect(getHostReadRoots(policy)).toEqual(['/approved'])
  expect(Object.isFrozen(getHostReadRoots(policy))).toBe(true)
  const fileSystem = createMockFs({ realpathImpl: async value => value })
  expect(await resolveProjectPathForFileSystemRead(project, '/approved/file.ts', fileSystem, policy)).toMatchObject({ fullPath: '/approved/file.ts', scope: 'external-read' })
  expect(resolveProjectPath(project, '/approved/file.ts')).toBeNull()
  expect(await resolveProjectPathForFileSystemRead(project, '/later/file.ts', fileSystem, policy)).toBeNull()
  expect(await resolveProjectPathForFileSystemRead(project, '/approved', fileSystem, policy)).toBeNull()
  expect(await resolveProjectPathForFileSystemRead(project, '/approved/credentials.json', fileSystem, policy)).toBeNull()
})

test('an explicit host policy never adopts process-global roots', async () => {
  configureExternalReadRoots(['/legacy'], project)
  const policy = createHostReadPolicy(project, ['/approved'], value => value)
  const fileSystem = createMockFs({ realpathImpl: async value => value })
  expect(await resolveProjectPathForFileSystemRead(project, '/legacy/file.ts', fileSystem, policy)).toBeNull()
  expect(resolveProjectPathForRead(project, '/legacy/file.ts', policy)).toBeNull()
})

test('filesystem-bound policy is used when no explicit policy argument is supplied', async () => {
  const policy = createHostReadPolicy(project, ['/approved'], value => value)
  const fileSystem = { ...createMockFs({ realpathImpl: async value => value }), hostReadPolicy: policy }
  expect(await resolveProjectPathForFileSystemRead(project, '/approved/file.ts', fileSystem)).toMatchObject({ fullPath: '/approved/file.ts' })
  expect(await resolveProjectPathForFileSystemRead(project, 'inside.ts', { ...fileSystem, hostReadPolicy: { ...policy } as HostReadPolicy })).toBeNull()
})

test('external-root symlink retarget cannot adopt the new destination', async () => {
  let destination = '/canonical/a'
  const realpath = (value: string) => value === '/approved' || value.startsWith('/approved/') ? destination + value.slice('/approved'.length) : value
  const policy = createHostReadPolicy(project, ['/approved'], realpath)
  const fileSystem = createMockFs({ realpathImpl: async value => realpath(value) })
  expect(await resolveProjectPathForFileSystemRead(project, '/approved/file.ts', fileSystem, policy)).toMatchObject({ realFullPath: '/canonical/a/file.ts' })
  destination = '/canonical/b'
  expect(await resolveProjectPathForFileSystemRead(project, '/approved/file.ts', fileSystem, policy)).toBeNull()
  expect(await resolveProjectPathForFileSystemRead(project, '/canonical/b/file.ts', fileSystem, policy)).toBeNull()
})

test('project-root retarget refuses even an otherwise project-relative read', async () => {
  let destination = '/canonical/project-a'
  const realpath = (value: string) => value === project || value.startsWith(project + '/') ? destination + value.slice(project.length) : value
  const policy = createHostReadPolicy(project, [], realpath)
  const fileSystem = createMockFs({ realpathImpl: async value => realpath(value) })
  expect(await resolveProjectPathForFileSystemRead(project, 'file.ts', fileSystem, policy)).not.toBeNull()
  destination = '/canonical/project-b'
  expect(await resolveProjectPathForFileSystemRead(project, 'file.ts', fileSystem, policy)).toBeNull()
})

test('policy capture rejects relative lexical or canonical boundaries', () => {
  expect(() => createHostReadPolicy('relative', [], value => value)).toThrow()
  expect(() => createHostReadPolicy(project, ['relative'], value => value)).toThrow()
  expect(() => createHostReadPolicy(project, [], () => 'relative')).toThrow()
})
