import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

import { assertProviderHostContext, createProviderHostContext, credentialRoster, getAncestorProviderConfigPathsForContext, getCapturedProviderConfig, getConfigDirForContext, loadHostConfigSnapshot } from '../host-config'
import type { HostConfigurationInputs, HostConfigSnapshot, ProviderHostContext } from '../host-config'
import type { ConfigReadFs } from '../provider-config'

type Operation = 'readFile' | 'stat' | 'readDirectory' | 'realpath'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
const missing = (target: string) => Object.assign(new Error(`fixture missing: ${target}`), { code: 'ENOENT' })

function inputs(overrides: Partial<HostConfigurationInputs> = {}): HostConfigurationInputs {
  return { environment: {}, platform: 'linux', invocationCwd: '/virtual/project', projectRoot: '/virtual/project',
    home: { kind: 'none' }, globals: { kind: 'disabled' }, selection: { kind: 'none' },
    trust: { ancestorConfig: false, projectReadableRoots: false }, ...overrides }
}

/** A complete filesystem port: no operation falls through to the host disk. */
function memoryFs(initial: Record<string, unknown> = {}) {
  const files = new Map(Object.entries(initial).map(([name, value]) => [name, typeof value === 'string' ? Buffer.from(value) : Buffer.from(JSON.stringify(value))]))
  const directories = new Map<string, string[]>()
  const realpaths = new Map<string, string>()
  const calls: Array<{ operation: Operation; target: string; count: number }> = []
  const counts = new Map<string, number>()
  let hook: ((operation: Operation, target: string, count: number) => unknown) | undefined
  const invoke = <T>(operation: Operation, target: string, normal: () => T): T => {
    const key = `${operation}:${target}`
    const count = (counts.get(key) ?? 0) + 1; counts.set(key, count)
    calls.push({ operation, target, count })
    const override = hook?.(operation, target, count)
    return override === undefined ? normal() : override as T
  }
  const port: ConfigReadFs = {
    readFile: target => invoke('readFile', target, () => { const bytes = files.get(target); if (!bytes) throw missing(target); return new Uint8Array(bytes) }),
    stat: target => invoke('stat', target, () => {
      if (files.has(target)) return { kind: 'file', size: files.get(target)!.byteLength, revision: 'r1' }
      if (directories.has(target)) return { kind: 'directory', size: 0, revision: 'r1' }
      throw missing(target)
    }),
    readDirectory: target => invoke('readDirectory', target, () => { const names = directories.get(target); if (!names) throw missing(target); return [...names] }),
    realpath: target => invoke('realpath', target, () => realpaths.get(target) ?? target),
  }
  return { port, files, directories, realpaths, calls, setHook(value: typeof hook) { hook = value } }
}

function capture(configuration: HostConfigurationInputs, reader: ConfigReadFs): HostConfigSnapshot {
  const result = loadHostConfigSnapshot({ inputs: configuration, fs: reader })
  if (result.status !== 'complete') throw new Error(result.cause)
  return result.snapshot
}

const provider = (apiKeyEnv?: string) => ({ type: 'openai-compatible', baseURL: 'https://fixture.invalid/v1', models: ['fixture-model'], ...(apiKeyEnv ? { apiKeyEnv } : {}) })
const explicit = (selected = 'openbuff.json') => inputs({ selection: { kind: 'explicit', path: selected, required: true } })

describe('strict host configuration capture', () => {
  test('disabled globals and home-none ignore captured ambient selector variables', () => {
    const reader = memoryFs({ '/ambient/openbuff.json': { defaultModel: 'ambient' } })
    const snapshot = capture(inputs({ environment: { OPENBUFF_CONFIG_DIR: '/ambient', XDG_CONFIG_HOME: '/ambient', OPENBUFF_PROVIDER_CONFIG: '/ambient/openbuff.json' } }), reader.port)
    expect(snapshot.configDir).toBeUndefined()
    expect(snapshot.loaded.sourceFilePaths).toEqual([])
    expect(snapshot.loaded.config.defaultModel).toBeUndefined()
    expect(reader.calls.every(call => call.operation === 'realpath' && call.target === '/virtual/project')).toBe(true)
    expect(getConfigDirForContext(snapshot.inputs)).toBeUndefined()
  })

  test('explicit relative selectors and globals resolve from captured invocation cwd', () => {
    const reader = memoryFs({ '/virtual/invocation/selected.json': { defaultModel: 'selected' }, '/virtual/project/openbuff.json': { defaultModel: 'wrong-project' } })
    const snapshot = capture(inputs({ invocationCwd: '/virtual/invocation', globals: { kind: 'directory', path: 'settings' },
      selection: { kind: 'explicit', path: 'selected.json', required: true } }), reader.port)
    expect(snapshot.loaded.config.defaultModel).toBe('selected')
    expect(snapshot.configDir).toBe('/virtual/invocation/settings')
    expect(snapshot.loaded.sourceFilePaths).toEqual(['/virtual/invocation/selected.json'])
  })

  test('ancestor discovery stops at captured home and never substitutes ambient home', () => {
    const configuration = inputs({ invocationCwd: '/virtual/home/project', projectRoot: '/virtual/home/project', home: { kind: 'path', path: '/virtual/home' }, selection: { kind: 'discover' } })
    expect(getAncestorProviderConfigPathsForContext(configuration)).toEqual(['/virtual/home/project/openbuff.json', '/virtual/home/openbuff.json'])
    const reader = memoryFs({ '/virtual/openbuff.json': { defaultModel: 'outside-home' } })
    expect(capture(configuration, reader.port).loaded.sourceFilePaths).toEqual([])
    expect(reader.calls.some(call => call.target === '/virtual/openbuff.json')).toBe(false)
  })

  for (const [name, content] of [
    ['invalid JSON', '{'], ['invalid provider schema', { providers: [] }],
  ] as const) test(`selected config ${name} is unavailable`, () => {
    const reader = memoryFs({ '/virtual/project/openbuff.json': content })
    expect(loadHostConfigSnapshot({ inputs: explicit(), fs: reader.port }).status).toBe('unavailable')
  })

  test('invalid UTF-8 is not silently decoded into valid-looking config', () => {
    const reader = memoryFs()
    reader.files.set('/virtual/project/openbuff.json', Buffer.from([0xff, 0xfe]))
    expect(loadHostConfigSnapshot({ inputs: explicit(), fs: reader.port }).status).toBe('unavailable')
  })

  test('required selected file and required includes cannot be silently skipped', () => {
    expect(loadHostConfigSnapshot({ inputs: explicit(), fs: memoryFs().port })).toMatchObject({ status: 'unavailable', cause: expect.stringContaining('Required provider config is absent') })
    const reader = memoryFs({ '/virtual/project/openbuff.json': { include: 'missing.json' } })
    expect(loadHostConfigSnapshot({ inputs: explicit(), fs: reader.port })).toMatchObject({ status: 'unavailable', cause: expect.stringContaining('include is absent') })
  })

  test('selected directories and include cycles are unavailable', () => {
    const reader = memoryFs()
    reader.directories.set('/virtual/project/openbuff.json', [])
    expect(loadHostConfigSnapshot({ inputs: explicit(), fs: reader.port }).status).toBe('unavailable')
    const cyclic = memoryFs({ '/virtual/project/openbuff.json': { include: 'other.json' }, '/virtual/project/other.json': { include: 'openbuff.json' } })
    expect(loadHostConfigSnapshot({ inputs: explicit(), fs: cyclic.port })).toMatchObject({ status: 'unavailable', cause: expect.stringContaining('cycle') })
  })

  test('include directories use deterministic order and reject escaping entries', () => {
    const reader = memoryFs({ '/virtual/project/openbuff.json': { include: 'fragments' }, '/virtual/project/fragments/a.json': { defaultModel: 'a' }, '/virtual/project/fragments/z.json': { defaultModel: 'z' } })
    reader.directories.set('/virtual/project/fragments', ['z.json', 'notes.txt', 'a.json'])
    expect(capture(explicit(), reader.port).loaded.config.defaultModel).toBe('z')
    reader.directories.set('/virtual/project/fragments', ['../escape.json'])
    expect(loadHostConfigSnapshot({ inputs: explicit(), fs: reader.port }).status).toBe('unavailable')
  })

  test('credential trust follows the declaring fragment rather than its trusted includer', () => {
    const reader = memoryFs({
      '/virtual/project/openbuff.json': { include: '/outside/provider.json', providers: { local: provider('LOCAL_KEY') } },
      '/outside/provider.json': { providers: { external: provider('EXTERNAL_KEY'), keyless: provider() } },
    })
    const snapshot = capture(explicit(), reader.port)
    expect(Object.keys(snapshot.loaded.config.providers).sort()).toEqual(['keyless', 'local'])
    expect(snapshot.credentialNames).toEqual(['LOCAL_KEY'])
    expect(snapshot.loaded.diagnostics).toContainEqual({ filePath: '/outside/provider.json', message: 'Untrusted apiKeyEnv provider excluded: external' })
    const trusted = capture({ ...explicit(), trust: { ancestorConfig: true, projectReadableRoots: false } }, reader.port)
    expect(trusted.credentialNames).toEqual(['EXTERNAL_KEY', 'LOCAL_KEY'])
  })

  test('a project symlink cannot promote an outside fragment into trusted credential provenance', () => {
    const reader = memoryFs({ '/virtual/project/openbuff.json': { include: 'linked.json' }, '/virtual/project/linked.json': {}, '/outside/provider.json': { providers: { escaped: provider('ESCAPED_KEY') } } })
    reader.realpaths.set('/virtual/project/linked.json', '/outside/provider.json')
    expect(capture(explicit(), reader.port).loaded.config.providers).toEqual({})
  })

  test('readable roots require trust in the actual declaring fragment', () => {
    const reader = memoryFs({
      '/virtual/global/openbuff.json': { include: '/outside/roots.json', readableRoots: ['/safe/docs'] },
      '/outside/roots.json': { readableRoots: ['/outside/docs'] },
    })
    const configuration = inputs({ globals: { kind: 'directory', path: '/virtual/global' }, selection: { kind: 'discover' } })
    expect(capture(configuration, reader.port).readableRoots).toEqual(['/virtual/global', '/safe/docs'])
    const project = memoryFs({ '/virtual/project/openbuff.json': { readableRoots: ['/project/opt-in'] } })
    expect(capture(explicit(), project.port).readableRoots).toEqual([])
    expect(capture({ ...explicit(), trust: { ancestorConfig: false, projectReadableRoots: true } }, project.port).readableRoots).toEqual(['/project/opt-in'])
  })

  for (const operation of ['readFile', 'stat', 'realpath'] as const) test(`capture rejects changing ${operation} observations`, () => {
    const reader = memoryFs({ '/virtual/project/openbuff.json': { defaultModel: 'before' } })
    reader.setHook((op, target, count) => {
      if (op !== operation || target !== '/virtual/project/openbuff.json' || count < 2) return
      if (op === 'readFile') return Buffer.from('{"defaultModel":"after!"}')
      if (op === 'stat') return { kind: 'file', size: reader.files.get(target)!.byteLength, revision: 'r2' }
      return '/retargeted/openbuff.json'
    })
    expect(loadHostConfigSnapshot({ inputs: explicit(), fs: reader.port })).toMatchObject({ status: 'unavailable', cause: expect.stringContaining('changed during capture') })
  })

  test('capture rejects directory membership mutation', () => {
    const reader = memoryFs({ '/virtual/project/openbuff.json': { include: 'parts' }, '/virtual/project/parts/a.json': {} })
    reader.directories.set('/virtual/project/parts', ['a.json'])
    reader.setHook((operation, target, count) => operation === 'readDirectory' && target.endsWith('/parts') && count > 1 ? ['a.json', 'new.json'] : undefined)
    expect(loadHostConfigSnapshot({ inputs: explicit(), fs: reader.port })).toMatchObject({ status: 'unavailable', cause: expect.stringContaining('changed during capture') })
  })

  test('capture rejects a previously absent discovered config appearing during verification', () => {
    const reader = memoryFs()
    reader.setHook((operation, target, count) => operation === 'stat' && target === '/virtual/project/openbuff.json' && count > 1 ? { kind: 'file', size: 2, revision: 'new' } : undefined)
    expect(loadHostConfigSnapshot({ inputs: inputs({ selection: { kind: 'discover' } }), fs: reader.port })).toMatchObject({ status: 'unavailable', cause: expect.stringContaining('changed during capture') })
  })

  test('capture rejects a previously missing realpath becoming a canonical root', () => {
    const reader = memoryFs()
    reader.setHook((operation, target, count) => {
      if (operation !== 'realpath' || target !== '/virtual/global') return
      if (count === 1) throw missing(target)
      return '/canonical/new-global'
    })
    const configuration = inputs({ globals: { kind: 'directory', path: '/virtual/global' } })
    expect(loadHostConfigSnapshot({ inputs: configuration, fs: reader.port })).toMatchObject({ status: 'unavailable', cause: expect.stringContaining('changed during capture') })
  })

  test('an explicit filesystem failure never falls back to the real selected config', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-host-config-')); roots.push(root)
    fs.writeFileSync(path.join(root, 'config.json'), '{}')
    const reader = memoryFs()
    const result = loadHostConfigSnapshot({ inputs: explicit(path.join(root, 'config.json')), fs: reader.port })
    expect(result).toMatchObject({ status: 'unavailable', cause: expect.stringContaining('Required provider config is absent') })
    expect(reader.calls.some(call => call.operation === 'stat' && call.target === path.join(root, 'config.json'))).toBe(true)
  })

  test('snapshot copies and freezes source inputs, config graphs, and credential names', () => {
    const environment = { CUSTOM_KEY: 'captured' }
    const reader = memoryFs({ '/virtual/project/openbuff.json': { providers: { custom: provider('CUSTOM_KEY') } } })
    const snapshot = capture({ ...explicit(), environment }, reader.port)
    environment.CUSTOM_KEY = 'mutated'
    reader.files.set('/virtual/project/openbuff.json', Buffer.from('{}'))
    expect(snapshot.inputs.environment.CUSTOM_KEY).toBe('captured')
    expect(snapshot.loaded.config.providers.custom.models).toEqual(['fixture-model'])
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.inputs.environment)).toBe(true)
    expect(Object.isFrozen(snapshot.loaded.config.providers.custom.models)).toBe(true)
    expect(Object.isFrozen(snapshot.credentialNames)).toBe(true)
    expect(() => (snapshot.loaded.config.providers.custom.models as string[]).push('injected')).toThrow()
    expect(credentialRoster(snapshot)).toContain('CUSTOM_KEY')
    expect(Object.is(getCapturedProviderConfig(snapshot), snapshot.loaded)).toBe(true)
    expect(capture(explicit(), reader.port).loaded.config.providers).toEqual({})
  })

  test('copied snapshots and provider contexts are not authentic handles', () => {
    const snapshot = capture(inputs(), memoryFs().port)
    expect(() => getCapturedProviderConfig({ ...snapshot })).toThrow('Invalid host configuration snapshot')
    expect(() => createProviderHostContext({ ...snapshot })).toThrow('Invalid host configuration snapshot')
    const context = createProviderHostContext(snapshot)
    expect(() => assertProviderHostContext(context)).not.toThrow()
    expect(() => assertProviderHostContext({ ...context } as ProviderHostContext)).toThrow('Invalid provider host context')
  })

  test('credential environments stay isolated across captures and later caller mutation', async () => {
    const firstEnvironment = { OPENBUFF_CHATGPT_OAUTH_TOKEN: 'fixture-run-a', CUSTOM_KEY: 'custom-a' }
    const first = createProviderHostContext(capture(inputs({ environment: firstEnvironment }), memoryFs().port))
    const second = createProviderHostContext(capture(inputs({ environment: { OPENBUFF_CHATGPT_OAUTH_TOKEN: 'fixture-run-b', CUSTOM_KEY: 'custom-b' } }), memoryFs().port))
    firstEnvironment.OPENBUFF_CHATGPT_OAUTH_TOKEN = 'changed'
    const [a, b] = await Promise.all([first.credentials.getValidChatGptOAuthCredentials(), second.credentials.getValidChatGptOAuthCredentials()])
    expect(a?.accessToken).toBe('fixture-run-a')
    expect(b?.accessToken).toBe('fixture-run-b')
    expect(first.credentialEnvironment.CUSTOM_KEY).toBe('custom-a')
    expect(second.credentialEnvironment.CUSTOM_KEY).toBe('custom-b')
  })

  test('disabled credential store reads neither ambient tokens nor ambient credential files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-host-credentials-')); roots.push(root)
    fs.writeFileSync(path.join(root, 'credentials.json'), JSON.stringify({ chatgptOAuth: { accessToken: 'fixture-store', refreshToken: '', expiresAt: Date.now() + 1e9, connectedAt: 1 } }))
    const names = ['OPENBUFF_CONFIG_DIR', 'CODEBUFF_CHATGPT_OAUTH_TOKEN', 'OPENBUFF_CHATGPT_OAUTH_TOKEN'] as const
    const previous = Object.fromEntries(names.map(name => [name, process.env[name]]))
    try {
      process.env.OPENBUFF_CONFIG_DIR = root
      process.env.CODEBUFF_CHATGPT_OAUTH_TOKEN = 'fixture-ambient-legacy'
      process.env.OPENBUFF_CHATGPT_OAUTH_TOKEN = 'fixture-ambient-openbuff'
      const context = createProviderHostContext(capture(inputs(), memoryFs().port))
      expect(await context.credentials.getValidChatGptOAuthCredentials()).toBeNull()
      expect(await context.credentials.refreshChatGptOAuthToken?.()).toBeNull()
      delete process.env.CODEBUFF_CHATGPT_OAUTH_TOKEN
      delete process.env.OPENBUFF_CHATGPT_OAUTH_TOKEN
      // With ambient tokens absent, an accidental disk fallback would reveal
      // the valid synthetic store token rather than passing vacuously.
      expect(await context.credentials.getValidChatGptOAuthCredentials()).toBeNull()
    } finally {
      for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name] }
    }
  })

  test('captured custom credential ports retain their original receiver', async () => {
    const port = { token: 'fixture-custom', async getValidChatGptOAuthCredentials() { return { accessToken: this.token, refreshToken: '', expiresAt: 1, connectedAt: 1 } } }
    const context = createProviderHostContext(capture(inputs(), memoryFs().port), port)
    expect((await context.credentials.getValidChatGptOAuthCredentials())?.accessToken).toBe('fixture-custom')
  })
})
