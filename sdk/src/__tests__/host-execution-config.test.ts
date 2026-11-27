import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

import { loadHostConfigSnapshot, nodeConfigReadFs } from '../host-config'
import {
  clearProviderConfigCacheForTest,
  loadProviderConfigSync,
  providerConfigFileSchema,
} from '../provider-config'
import { hostExecutionConfigSchema } from '../services/host-execution-config'

import type {
  HostConfigurationInputs,
  HostConfigSnapshot,
} from '../host-config'
import type { ConfigReadFs } from '../provider-config'
import type { HostExecutionConfig } from '../services/host-execution-config'

const roots: string[] = []
afterEach(() => {
  clearProviderConfigCacheForTest()
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})

function nativeDeclaration(
  tag: 'base' | 'override' = 'base',
): HostExecutionConfig {
  return {
    profile: {
      policy: tag === 'base' ? 'workspace-write' : 'read-only',
      preferredBackend: 'native-exec',
      required: ['exact-env', 'filesystem-isolation'],
      optional: ['network-isolation'],
      allowBackendFallback: false,
    },
    native: {
      artifact: {
        path: `/trusted/${tag}/openbuff-native`,
        sha256: (tag === 'base' ? 'a' : 'b').repeat(64),
        platform: 'linux-x64-gnu',
        crateVersion: '0.1.0',
        workspaceProtocol: '1',
      },
      bwrap: { path: `/trusted/${tag}/bwrap`, sha256: 'c'.repeat(64) },
      runtimePaths: [`/trusted/${tag}/runtime`],
      network: tag === 'base' ? 'deny' : 'inherit',
      landlock: tag === 'base' ? 'optional' : 'required',
    },
  }
}

const portableDeclaration: HostExecutionConfig = {
  profile: {
    policy: 'full-access',
    preferredBackend: 'portable-ts',
    required: ['exact-env'],
    optional: [],
    allowBackendFallback: false,
  },
}

/** Change raw JSON, without asserting that malformed input has the output type. */
function change(field: readonly string[], replacement?: unknown): unknown {
  const value: unknown = structuredClone(nativeDeclaration())
  let parent = value as Record<string, unknown>
  for (const part of field.slice(0, -1))
    parent = parent[part] as Record<string, unknown>
  const key = field[field.length - 1]!
  if (replacement === undefined) delete parent[key]
  else parent[key] = replacement
  return value
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b21-execution-config-'))
  roots.push(root)
  const project = path.join(root, 'project')
  const global = path.join(root, 'global')
  const external = path.join(root, 'external')
  for (const directory of [project, global, external])
    fs.mkdirSync(directory, { recursive: true })
  const readCalls: string[] = []
  // Every captured FS operation is confined to this owned fixture. Discovery
  // above its root observes ENOENT, never the user's real ancestor config.
  const owned = (target: string) => {
    if (target !== root && !target.startsWith(root + path.sep))
      throw Object.assign(new Error('Outside owned config fixture'), {
        code: 'ENOENT',
      })
  }
  const reader: ConfigReadFs = {
    readFile(target) {
      owned(target)
      readCalls.push(target)
      return nodeConfigReadFs.readFile(target)
    },
    stat(target) {
      owned(target)
      return nodeConfigReadFs.stat(target)
    },
    readDirectory(target) {
      owned(target)
      return nodeConfigReadFs.readDirectory(target)
    },
    realpath(target) {
      owned(target)
      return nodeConfigReadFs.realpath(target)
    },
  }
  const inputs: HostConfigurationInputs = {
    environment: {},
    platform: 'linux',
    invocationCwd: project,
    projectRoot: project,
    home: { kind: 'path', path: root },
    globals: { kind: 'directory', path: global },
    selection: { kind: 'discover' },
    trust: { ancestorConfig: false, projectReadableRoots: false },
  }
  function write(filePath: string, config: unknown) {
    owned(filePath)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(config))
    return filePath
  }
  function capture(
    overrides: Partial<HostConfigurationInputs> = {},
  ): HostConfigSnapshot {
    const result = loadHostConfigSnapshot({
      inputs: { ...inputs, ...overrides },
      fs: reader,
    })
    if (result.status !== 'complete') throw new Error(result.cause)
    return result.snapshot
  }
  function selected(filePath: string): HostConfigurationInputs['selection'] {
    return { kind: 'explicit', path: filePath, required: true }
  }
  function legacy(filePath: string) {
    // The legacy selector has an explicit env seam; do not mutate process.env.
    clearProviderConfigCacheForTest()
    return loadProviderConfigSync({
      env: { OPENBUFF_PROVIDER_CONFIG: filePath },
    })
  }
  return {
    root,
    project,
    global,
    external,
    reader,
    inputs,
    readCalls,
    write,
    capture,
    selected,
    legacy,
  }
}

describe('host execution declaration schema', () => {
  test('preserves a complete native declaration through provider parsing', () => {
    const execution = nativeDeclaration()
    expect(hostExecutionConfigSchema.parse(execution)).toEqual(execution)
    expect(providerConfigFileSchema.parse({ execution }).execution).toEqual(
      execution,
    )
  })

  test('accepts an explicit portable profile without a native installation', () => {
    expect(hostExecutionConfigSchema.parse(portableDeclaration)).toEqual(
      portableDeclaration,
    )
    expect(providerConfigFileSchema.parse({}).execution).toBeUndefined()
    const native = nativeDeclaration()
    expect(
      hostExecutionConfigSchema.safeParse({
        ...portableDeclaration,
        native: native.native,
      }).success,
    ).toBe(false)
  })

  for (const field of [
    ['clock'],
    ['profile', 'authority'],
    ['native', 'mapping'],
    ['native', 'artifact', 'heldFd'],
    ['native', 'bwrap', 'receipt'],
  ])
    test(`rejects wire authority field ${field.join('.')}`, () => {
      const result = hostExecutionConfigSchema.safeParse(
        change(field, 'untrusted'),
      )
      expect(result.success).toBe(false)
      if (result.success)
        throw new Error('Unknown declaration field was accepted')
      expect(
        result.error.issues.some((issue) => issue.code === 'unrecognized_keys'),
      ).toBe(true)
      expect(
        providerConfigFileSchema.safeParse({
          execution: change(field, 'untrusted'),
        }).success,
      ).toBe(false)
    })

  for (const field of [
    ['profile'],
    ['profile', 'policy'],
    ['profile', 'preferredBackend'],
    ['profile', 'required'],
    ['profile', 'allowBackendFallback'],
    ['native'],
    ['native', 'artifact'],
    ['native', 'artifact', 'path'],
    ['native', 'artifact', 'sha256'],
    ['native', 'bwrap'],
    ['native', 'runtimePaths'],
    ['native', 'network'],
    ['native', 'landlock'],
  ])
    test(`rejects missing explicit field ${field.join('.')}`, () => {
      expect(hostExecutionConfigSchema.safeParse(change(field)).success).toBe(
        false,
      )
    })

  test('optional capability list may be omitted without inventing a fallback', () => {
    const parsed = hostExecutionConfigSchema.parse(
      change(['profile', 'optional']),
    )
    expect(parsed.profile.optional).toBeUndefined()
    expect(parsed.profile.allowBackendFallback).toBe(false)
  })

  for (const field of ['required', 'optional'])
    test(`rejects duplicate ${field} capabilities`, () => {
      expect(
        hostExecutionConfigSchema.safeParse(
          change(['profile', field], ['exact-env', 'exact-env']),
        ).success,
      ).toBe(false)
    })

  test('rejects overlap between required and optional capabilities', () => {
    expect(
      hostExecutionConfigSchema.safeParse(
        change(['profile', 'optional'], ['exact-env']),
      ).success,
    ).toBe(false)
  })

  for (const field of [
    ['native', 'artifact', 'path'],
    ['native', 'bwrap', 'path'],
    ['native', 'runtimePaths', '0'],
  ])
    for (const [label, value] of [
      ['relative', './untrusted'],
      ['empty', ''],
      ['NUL', '/trusted/invalid\0path'],
    ])
      test(`rejects ${label} descriptor path ${field.join('.')}`, () => {
        expect(
          hostExecutionConfigSchema.safeParse(change(field, value)).success,
        ).toBe(false)
      })

  test('requires a nonempty explicit runtime roster', () => {
    expect(
      hostExecutionConfigSchema.safeParse(
        change(['native', 'runtimePaths'], []),
      ).success,
    ).toBe(false)
  })

  for (const tool of ['artifact', 'bwrap'])
    for (const [label, value] of [
      ['uppercase', 'A'.repeat(64)],
      ['short', 'a'.repeat(63)],
      ['nonhex', 'g'.repeat(64)],
    ])
      test(`rejects ${label} ${tool} checksum`, () => {
        expect(
          hostExecutionConfigSchema.safeParse(
            change(['native', tool, 'sha256'], value),
          ).success,
        ).toBe(false)
      })

  for (const [field, value] of [
    ['platform', 'linux-arm64-gnu'],
    ['crateVersion', '9.9.9'],
    ['workspaceProtocol', '2'],
  ])
    test(`rejects unsupported artifact ${field}`, () => {
      expect(
        hostExecutionConfigSchema.safeParse(
          change(['native', 'artifact', field!], value),
        ).success,
      ).toBe(false)
    })

  test('rejects unknown capability and non-boolean fallback', () => {
    expect(
      hostExecutionConfigSchema.safeParse(
        change(['profile', 'required'], ['imaginary-isolation']),
      ).success,
    ).toBe(false)
    expect(
      hostExecutionConfigSchema.safeParse(
        change(['profile', 'allowBackendFallback'], 'true'),
      ).success,
    ).toBe(false)
  })
})

describe('execution declaration provenance', () => {
  test('absent declaration remains absent in captured and legacy loaders', () => {
    const f = fixture()
    const selected = f.write(path.join(f.project, 'openbuff.json'), {
      defaultModel: 'local/model',
    })
    const snapshot = f.capture({ selection: f.selected(selected) })
    expect(snapshot.loaded.config.execution).toBeUndefined()
    expect(snapshot.loaded.sourceFiles?.execution).toBeUndefined()
    expect(snapshot.executionOrigin).toBeUndefined()
    const legacy = f.legacy(selected)
    expect(legacy.config.execution).toBeUndefined()
    expect(legacy.sourceFiles?.execution).toBeUndefined()
  })

  test('global declaration is trusted and deeply frozen in the captured snapshot', () => {
    const f = fixture()
    const execution = nativeDeclaration()
    const origin = f.write(path.join(f.global, 'openbuff.json'), { execution })
    const snapshot = f.capture()
    expect(snapshot.loaded.config.execution).toEqual(execution)
    expect(snapshot.executionOrigin).toEqual({
      filePath: origin,
      trusted: true,
    })
    expect(snapshot.loaded.sourceFiles?.execution).toBe(origin)
    expect(Object.isFrozen(snapshot.executionOrigin)).toBe(true)
    expect(Object.isFrozen(snapshot.loaded.config.execution)).toBe(true)
    expect(
      Object.isFrozen(snapshot.loaded.config.execution?.native?.runtimePaths),
    ).toBe(true)
    expect(
      Object.isFrozen(snapshot.loaded.config.execution?.profile.required),
    ).toBe(true)
    f.write(origin, { execution: nativeDeclaration('override') })
    expect(snapshot.loaded.config.execution).toEqual(execution)
    expect(f.legacy(origin).sourceFiles?.execution).toBe(origin)
  })

  test('omitting execution in later fragments inherits the entire block and exact origin', () => {
    const f = fixture()
    const base = f.write(path.join(f.global, 'base.json'), {
      execution: nativeDeclaration(),
    })
    const unrelated = f.write(path.join(f.external, 'unrelated.json'), {
      defaultModel: 'local/unrelated',
    })
    const parent = f.write(path.join(f.project, 'selected.json'), {
      include: [base, unrelated],
    })
    const snapshot = f.capture({ selection: f.selected(parent) })
    expect(snapshot.loaded.config.execution).toEqual(nativeDeclaration())
    expect(snapshot.loaded.config.defaultModel).toBe('local/unrelated')
    expect(snapshot.executionOrigin).toEqual({ filePath: base, trusted: true })
    const legacy = f.legacy(parent)
    expect(legacy.config.execution).toEqual(nativeDeclaration())
    expect(legacy.sourceFiles?.execution).toBe(base)
  })

  for (const [name, replacement] of [
    ['native', nativeDeclaration('override')],
    ['portable', portableDeclaration],
  ] as const)
    test(`${name} override replaces the entire installation/profile record and origin`, () => {
      const f = fixture()
      const base = f.write(path.join(f.global, 'base.json'), {
        execution: nativeDeclaration(),
      })
      const parent = f.write(path.join(f.project, 'selected.json'), {
        include: base,
        execution: replacement,
      })
      const snapshot = f.capture({ selection: f.selected(parent) })
      expect(snapshot.loaded.config.execution).toEqual(replacement)
      expect(snapshot.loaded.sourceFiles?.execution).toBe(parent)
      expect(snapshot.executionOrigin).toEqual({
        filePath: parent,
        trusted: true,
      })
      const legacy = f.legacy(parent)
      expect(legacy.config.execution).toEqual(replacement)
      expect(legacy.sourceFiles?.execution).toBe(parent)
      if (name === 'portable') {
        expect(snapshot.loaded.config.execution?.native).toBeUndefined()
        expect(legacy.config.execution?.native).toBeUndefined()
      }
    })

  test('partial override cannot splice new descriptor bytes into an inherited profile', () => {
    const f = fixture()
    const base = f.write(path.join(f.global, 'base.json'), {
      execution: nativeDeclaration(),
    })
    const parent = f.write(path.join(f.project, 'selected.json'), {
      include: base,
      execution: { native: nativeDeclaration('override').native },
    })
    const snapshot = loadHostConfigSnapshot({
      inputs: { ...f.inputs, selection: f.selected(parent) },
      fs: f.reader,
    })
    expect(snapshot.status).toBe('unavailable')
    expect(() => f.legacy(parent)).toThrow('Invalid provider config')
  })

  for (const mode of ['global', 'explicit'] as const)
    test(`external included declaration does not inherit ${mode} parent trust`, () => {
      const f = fixture()
      const origin = f.write(path.join(f.external, 'execution.json'), {
        execution: nativeDeclaration(),
      })
      const parent = f.write(
        path.join(mode === 'global' ? f.global : f.project, 'openbuff.json'),
        { include: origin },
      )
      const snapshot = f.capture(
        mode === 'explicit' ? { selection: f.selected(parent) } : {},
      )
      expect(snapshot.loaded.config.execution).toEqual(nativeDeclaration())
      expect(snapshot.loaded.sourceFiles?.execution).toBe(origin)
      expect(snapshot.executionOrigin).toEqual({
        filePath: origin,
        trusted: false,
      })
      expect(snapshot.loaded.sourceFilePaths).toContain(origin)
      const legacy = f.legacy(parent)
      expect(legacy.config.execution).toEqual(nativeDeclaration())
      expect(legacy.sourceFiles?.execution).toBe(origin)
    })

  test('nested later external declaration retains its own origin instead of restoring global authority', () => {
    const f = fixture()
    const base = f.write(path.join(f.global, 'base.json'), {
      execution: nativeDeclaration(),
    })
    const origin = f.write(path.join(f.external, 'override.json'), {
      execution: nativeDeclaration('override'),
    })
    const nested = f.write(path.join(f.global, 'nested.json'), {
      include: origin,
    })
    const parent = f.write(path.join(f.global, 'openbuff.json'), {
      include: [base, nested],
    })
    const snapshot = f.capture()
    expect(snapshot.loaded.config.execution).toEqual(
      nativeDeclaration('override'),
    )
    expect(snapshot.executionOrigin).toEqual({
      filePath: origin,
      trusted: false,
    })
    const legacy = f.legacy(parent)
    expect(legacy.config.execution).toEqual(nativeDeclaration('override'))
    expect(legacy.sourceFiles?.execution).toBe(origin)
  })

  test('included global fragment is independently trusted outside the explicit parent', () => {
    const f = fixture()
    const origin = f.write(path.join(f.global, 'fragment.json'), {
      execution: nativeDeclaration(),
    })
    const parent = f.write(path.join(f.external, 'selected.json'), {
      include: origin,
    })
    expect(
      f.capture({ selection: f.selected(parent) }).executionOrigin,
    ).toEqual({ filePath: origin, trusted: true })
    expect(f.legacy(parent).sourceFiles?.execution).toBe(origin)
  })

  test('explicit symlink selection trusts its canonical declaring file', () => {
    const f = fixture()
    const origin = f.write(path.join(f.external, 'execution.json'), {
      execution: nativeDeclaration(),
    })
    const alias = path.join(f.project, 'selected.json')
    fs.symlinkSync(origin, alias)
    const snapshot = f.capture({ selection: f.selected(alias) })
    expect(snapshot.executionOrigin).toEqual({
      filePath: origin,
      trusted: true,
    })
    expect(snapshot.loaded.sourceFiles?.execution).toBe(origin)
    expect(snapshot.loaded.sourceFilePaths).toEqual([origin])
    expect(f.readCalls.every((file) => file !== alias)).toBe(true)
    // Legacy loading records lexical source paths, never a captured trust grant.
    expect(f.legacy(alias).sourceFiles?.execution).toBe(alias)
  })

  test('global symlink to an outside declaration cannot grant execution trust', () => {
    const f = fixture()
    const origin = f.write(path.join(f.external, 'execution.json'), {
      execution: nativeDeclaration(),
    })
    fs.symlinkSync(origin, path.join(f.global, 'openbuff.json'))
    const snapshot = f.capture()
    expect(snapshot.executionOrigin).toEqual({
      filePath: origin,
      trusted: false,
    })
    expect(snapshot.loaded.sourceFiles?.execution).toBe(origin)
  })

  test('global directory trust uses its canonical root', () => {
    const f = fixture()
    const origin = f.write(path.join(f.global, 'openbuff.json'), {
      execution: nativeDeclaration(),
    })
    const alias = path.join(f.root, 'global-alias')
    fs.symlinkSync(f.global, alias)
    const snapshot = f.capture({ globals: { kind: 'directory', path: alias } })
    expect(snapshot.loaded.sourceFiles?.execution).toBe(origin)
    expect(snapshot.executionOrigin).toEqual({
      filePath: origin,
      trusted: true,
    })
  })

  for (const trust of [
    { ancestorConfig: false, projectReadableRoots: false },
    { ancestorConfig: true, projectReadableRoots: false },
    { ancestorConfig: false, projectReadableRoots: true },
    { ancestorConfig: true, projectReadableRoots: true },
  ])
    test(`discovered project execution remains untrusted with flags ${JSON.stringify(trust)}`, () => {
      const f = fixture()
      const origin = f.write(path.join(f.project, 'openbuff.json'), {
        execution: nativeDeclaration(),
        readableRoots: [f.external],
      })
      const snapshot = f.capture({ trust })
      expect(snapshot.executionOrigin).toEqual({
        filePath: origin,
        trusted: false,
      })
      expect(snapshot.loaded.sourceFiles?.execution).toBe(origin)
      expect(snapshot.readableRoots.includes(f.external)).toBe(
        trust.projectReadableRoots,
      )
    })

  test('ancestor discovery trust does not grant an ancestor execution declaration authority', () => {
    const f = fixture()
    const origin = f.write(path.join(f.root, 'openbuff.json'), {
      execution: nativeDeclaration(),
    })
    const snapshot = f.capture({
      trust: { ancestorConfig: true, projectReadableRoots: true },
    })
    expect(snapshot.loaded.config.execution).toEqual(nativeDeclaration())
    expect(snapshot.executionOrigin).toEqual({
      filePath: origin,
      trusted: false,
    })
  })

  test('discovered project override wins over global execution without silently restoring trusted fallback', () => {
    const f = fixture()
    f.write(path.join(f.global, 'openbuff.json'), {
      execution: nativeDeclaration(),
    })
    const origin = f.write(path.join(f.project, 'openbuff.json'), {
      execution: portableDeclaration,
    })
    const snapshot = f.capture()
    expect(snapshot.loaded.config.execution).toEqual(portableDeclaration)
    expect(snapshot.executionOrigin).toEqual({
      filePath: origin,
      trusted: false,
    })
    expect(snapshot.loaded.sourceFiles?.execution).toBe(origin)
    expect(snapshot.loaded.config.execution?.native).toBeUndefined()
  })
})
