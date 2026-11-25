import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDirectHostExecution } from '../host-execution'
import { loadHostConfigSnapshot, nodeConfigReadFs } from '../host-config'
import { runTerminalCommand } from '../tools/run-terminal-command'
import {
  clearProviderConfigCacheForTest,
  loadProviderConfigSync,
} from '../provider-config'
import type { HostConfigurationInputs } from '../host-config'

const roots: string[] = []
afterEach(() => {
  clearProviderConfigCacheForTest()
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-policy-provenance-')),
  )
  roots.push(root)
  const project = path.join(root, 'project'),
    global = path.join(root, 'global')
  fs.mkdirSync(project)
  fs.mkdirSync(global)
  const inputs: HostConfigurationInputs = {
    environment: {},
    platform: process.platform,
    invocationCwd: project,
    projectRoot: project,
    home: { kind: 'path', path: root },
    globals: { kind: 'directory', path: global },
    selection: { kind: 'discover' },
    trust: {
      ancestorConfig: false,
      projectReadableRoots: false,
      projectConfig: 'untrusted',
    },
  }
  const user = path.join(global, 'user-policy.json'),
    untrusted = path.join(project, 'project-policy.json'),
    config = path.join(global, 'openbuff.json')
  fs.writeFileSync(
    user,
    JSON.stringify({
      terminalTimeoutPolicy: {
        maxSeconds: 7,
        defaultSyncSeconds: 2,
        allowUnbounded: false,
      },
    }),
  )
  fs.writeFileSync(
    untrusted,
    JSON.stringify({
      terminalTimeoutPolicy: {
        maxSeconds: 700,
        defaultSyncSeconds: 120,
        allowUnbounded: true,
      },
    }),
  )
  fs.writeFileSync(config, JSON.stringify({ include: [user, untrusted] }))
  return { root, project, global, user, untrusted, config, inputs }
}

for (const explicit of [false, true])
  test(`an included repository policy cannot inherit user authority (explicit selection ${explicit})`, () => {
    const f = fixture()
    const inputs: HostConfigurationInputs = explicit
      ? {
          ...f.inputs,
          selection: { kind: 'explicit', path: f.config, required: true },
        }
      : f.inputs
    const result = loadHostConfigSnapshot({ inputs, fs: nodeConfigReadFs })
    if (result.status !== 'complete') throw new Error(result.cause)
    expect(result.snapshot.loaded.config.terminalTimeoutPolicy).toEqual({
      maxSeconds: 7,
      defaultSyncSeconds: 2,
      allowUnbounded: false,
    })
  })

test('an untrusted top-level project cannot replay an earlier user declaration', () => {
  const f = fixture()
  const earlier = path.join(f.global, 'provider-config.json')
  fs.writeFileSync(
    earlier,
    JSON.stringify({ terminalTimeoutPolicy: { maxSeconds: 7 } }),
  )
  fs.writeFileSync(
    f.config,
    JSON.stringify({ terminalTimeoutPolicy: { maxSeconds: 3 } }),
  )
  fs.writeFileSync(
    path.join(f.project, 'openbuff.json'),
    JSON.stringify({ include: earlier }),
  )
  const result = loadHostConfigSnapshot({
    inputs: f.inputs,
    fs: nodeConfigReadFs,
  })
  if (result.status !== 'complete') throw new Error(result.cause)
  expect(result.snapshot.loaded.config.terminalTimeoutPolicy).toEqual({
    maxSeconds: 3,
  })
})

test('an included untrusted requester cannot replay a user declaration through a user parent', () => {
  const f = fixture()
  fs.writeFileSync(
    f.user,
    JSON.stringify({ terminalTimeoutPolicy: { maxSeconds: 7 } }),
  )
  const tighter = path.join(f.global, 'tighter.json')
  fs.writeFileSync(
    tighter,
    JSON.stringify({ terminalTimeoutPolicy: { maxSeconds: 3 } }),
  )
  fs.writeFileSync(f.untrusted, JSON.stringify({ include: f.user }))
  fs.writeFileSync(
    f.config,
    JSON.stringify({ include: [f.user, tighter, f.untrusted] }),
  )
  const result = loadHostConfigSnapshot({
    inputs: f.inputs,
    fs: nodeConfigReadFs,
  })
  if (result.status !== 'complete') throw new Error(result.cause)
  expect(result.snapshot.loaded.config.terminalTimeoutPolicy).toEqual({
    maxSeconds: 3,
  })
  expect(result.snapshot.loaded.projectTrust?.files).toContain(f.untrusted)
})

test('legacy explicit loading also gates included repository declarations', () => {
  const f = fixture()
  const result = loadProviderConfigSync({
    env: { OPENBUFF_PROVIDER_CONFIG: f.config },
  })
  expect(result.config.terminalTimeoutPolicy).toEqual({
    maxSeconds: 7,
    defaultSyncSeconds: 2,
    allowUnbounded: false,
  })
  expect(result.projectTrust?.files).toContain(f.untrusted)
})

test('included project timeout files participate in the trust hash', () => {
  const f = fixture()
  const before = loadHostConfigSnapshot({
    inputs: f.inputs,
    fs: nodeConfigReadFs,
  })
  if (before.status !== 'complete') throw new Error(before.cause)
  expect(before.snapshot.loaded.projectTrust?.files).toContain(f.untrusted)
  fs.writeFileSync(
    f.untrusted,
    JSON.stringify({ terminalTimeoutPolicy: { maxSeconds: 701 } }),
  )
  const after = loadHostConfigSnapshot({
    inputs: f.inputs,
    fs: nodeConfigReadFs,
  })
  if (after.status !== 'complete') throw new Error(after.cause)
  expect(after.snapshot.loaded.projectTrust?.configHash).not.toBe(
    before.snapshot.loaded.projectTrust?.configHash,
  )
})

test('nested includes preserve tightening and later owned declarations', () => {
  const f = fixture()
  fs.writeFileSync(
    f.untrusted,
    JSON.stringify({ terminalTimeoutPolicy: { maxSeconds: 3 } }),
  )
  const nested = path.join(f.global, 'nested.json')
  fs.writeFileSync(nested, JSON.stringify({ include: f.untrusted }))
  fs.writeFileSync(
    f.config,
    JSON.stringify({
      include: [f.user, nested],
      terminalTimeoutPolicy: { defaultSyncSeconds: 1 },
    }),
  )
  const result = loadHostConfigSnapshot({
    inputs: f.inputs,
    fs: nodeConfigReadFs,
  })
  if (result.status !== 'complete') throw new Error(result.cause)
  expect(result.snapshot.loaded.config.terminalTimeoutPolicy).toEqual({
    maxSeconds: 3,
    defaultSyncSeconds: 1,
    allowUnbounded: false,
  })
})

describe.skipIf(process.platform === 'win32')(
  'large execution-time default',
  () => {
    test('never schedules a timeout beyond the Node timer range', async () => {
      const f = fixture()
      const host = createDirectHostExecution({
        cwd: f.project,
        hostConfiguration: {
          ...f.inputs,
          selection: { kind: 'none' },
          globals: { kind: 'disabled' },
        },
        limit: { kind: 'finite', durationMs: 3_000 },
      })
      if (!host.ok) throw new Error(host.cause)
      const timeout = globalThis.setTimeout
      const oversized: number[] = []
      const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((
        callback: (...values: any[]) => void,
        delay?: number,
        ...args: any[]
      ) => {
        if (typeof delay === 'number' && delay > 2_147_483_647)
          oversized.push(delay)
        return timeout(callback, delay, ...args)
      }) as typeof globalThis.setTimeout)
      try {
        const result = await runTerminalCommand({
          command: 'sleep 0.05; printf large-default-ok',
          process_type: 'SYNC',
          cwd: f.project,
          timeoutPolicy: { defaultSyncSeconds: 2_147_483.648 },
          executionContext: host.value.executionContext,
        })
        expect(oversized).toEqual([])
        expect(result[0].value).toMatchObject({
          exitCode: 0,
          stdout: 'large-default-ok',
        })
      } finally {
        timer.mockRestore()
      }
    })
  },
)
