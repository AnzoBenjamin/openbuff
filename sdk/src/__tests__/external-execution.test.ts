import { describe, expect, test, spyOn } from 'bun:test'
import * as childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { executionFixture } from '../../../common/src/mcp/__tests__/execution-fixture'
import {
  browserLogs,
  detectPipeSupport,
  resolveChromeExecutable,
} from '../tools/browser-logs'
import {
  inspect3dAsset,
  render3dPreview,
  edit3dAsset,
} from '../tools/3d-assets'
import { createNodeFileSystem } from '../tools/node-filesystem'
import { hashFileContent } from '../tools/filesystem-authority'
import { inspect3dAssetParams, render3dPreviewParams, edit3dAssetParams } from '@codebuff/common/tools/params/tool/3d-assets'
import { browserLogsParams } from '@codebuff/common/tools/params/tool/browser-logs'

/** DI boundary recorder: synthetic PID is not actual-process evidence. */
function recordedChild(output = ''): ChildProcess {
  const child = new EventEmitter() as ChildProcess
  Object.assign(child, {
    pid: 12345,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    stdio: [],
    kill: () => true,
  })
  queueMicrotask(() => {
    child.emit('spawn')
    child.stdout?.emit('data', Buffer.from(output))
    child.emit('close', 0)
  })
  return child
}

describe('external adapter execution controls (DI)', () => {
  test('public 3D effects and internal browser effects refuse missing execution after output parsing with zero spawn', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'external-missing-context-'))
    writeFileSync(path.join(root, 'scene.blend'), 'fixture')
    writeFileSync(path.join(root, 'scene.fbx'), 'fixture')
    let launches = 0, commits = 0
    const spawn = spyOn(childProcess, 'spawn').mockImplementation(() => {
      launches++
      throw new Error('No missing-context path may spawn')
    })
    const fs = Object.assign(createNodeFileSystem(), { conditionalCommit: async () => { commits++; return { applied: true as const } } })
    const authority = executionFixture()
    try {
      const public3d = await import('../index')
      for (const assetPath of ['scene.blend', 'scene.fbx']) {
        const output = inspect3dAssetParams.outputSchema.parse(await public3d.inspect3dAsset({ path: assetPath, cwd: root, fs }))
        expect(output[0]).toMatchObject({ type: 'json', value: { executionRefusal: { ok: false, reason: 'unavailable' } } })
      }
      const preview = render3dPreviewParams.outputSchema.parse(await public3d.render3dPreview({
        path: 'scene.blend', cwd: root, fs, views: ['front'], mode: 'clay', width: 128, height: 128,
      }))
      expect(preview[0]).toMatchObject({ type: 'json', value: { executionRefusal: { ok: false, reason: 'unavailable' } } })
      const edit = edit3dAssetParams.outputSchema.parse(await public3d.edit3dAsset({ path: 'scene.blend', cwd: root, fs,
        sourceHash: hashFileContent(Buffer.from('fixture')), operations: [{ type: 'rename_object', object: 'Cube', new_name: 'Hero' }] }))
      expect(edit[0]).toMatchObject({ type: 'json', value: { outcome: 'not_applied', executionRefusal: { ok: false, reason: 'unavailable' } } })
      for (const action of [{ type: 'snapshot' as const }, { type: 'stop' as const }]) {
        const output = browserLogsParams.outputSchema.parse(await browserLogs(action, 'missing-context'))
        expect(output[0]).toMatchObject({ type: 'json', value: { success: false, result: { executionRefusal: { reason: 'unavailable' } } } })
      }
      await expect(detectPipeSupport()).rejects.toThrow('unavailable')
      await expect(detectPipeSupport({ executablePath: () => '/fixture/chrome', spawn: () => {
        launches++
        throw new Error('Missing authority must not invoke a custom probe either')
      } })).rejects.toThrow('unavailable')
      const missingFactory = browserLogsParams.outputSchema.parse(await browserLogs({ type: 'snapshot' }, 'missing-resource-factory', {
        ...authority.context(), executablePath: '/fixture/chrome', sandboxArgs: [],
      } as unknown as Parameters<typeof browserLogs>[2]))
      expect(missingFactory[0]).toMatchObject({ type: 'json', value: { success: false, result: { executionRefusal: { reason: 'unavailable' } } } })
      expect(launches).toBe(0)
      expect(commits).toBe(0)
    } finally {
      spawn.mockRestore()
      authority.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Chrome resolution uses the supplied environment and existence view', () => {
    const visited: string[] = []
    expect(
      resolveChromeExecutable(
        { CHROME_PATH: '/captured/chrome' },
        'linux',
        (candidate) => {
          visited.push(candidate)
          return candidate === '/captured/chrome'
        },
      ),
    ).toBe('/captured/chrome')
    expect(visited).toEqual(['/captured/chrome'])
  })

  test('denied Chrome probe launches nothing and cannot become port fallback', async () => {
    const fixture = executionFixture({
      authorizeAsync: async () => ({
        ok: false,
        reason: 'denied',
        cause: 'chrome denied',
      }),
    })
    let launches = 0
    try {
      const output = await browserLogs({ type: 'snapshot' }, 'denied', {
        ...fixture.context(),
        resources: fixture.resources,
        executablePath: '/fixture/chrome',
        sandboxArgs: [],
        spawn: () => {
          launches++
          throw new Error('must not launch')
        },
      })
      expect(JSON.stringify(output)).toContain('chrome denied')
      expect(launches).toBe(0)
      expect(
        fixture.events
          .filter((event) => event.phase === 'planned')
          .map((event) => event.facts.branchId),
      ).toEqual(['chrome.probe'])
    } finally {
      fixture.close()
    }
  })

  for (const supported of [true, false])
    test(`Chrome ${supported ? 'pipe' : 'port fallback'} requires its own admission`, async () => {
      const fixture = executionFixture({
        authorizeAsync: async (input) =>
          input.facts.branchId === 'chrome.probe'
            ? { ok: true, basis: 'explicit-policy', decisionId: 'probe' }
            : { ok: false, reason: 'denied', cause: 'session denied' },
      })
      const launches: SpawnOptions[] = []
      try {
        const output = await browserLogs(
          { type: 'snapshot' },
          `branch-${supported}`,
          {
            ...fixture.context(),
            resources: fixture.resources,
            executablePath: '/fixture/chrome',
            sandboxArgs: [],
            spawn: (_command, _args, options) => {
              launches.push(options ?? {})
              const child = new EventEmitter() as ChildProcess
              const readable = new PassThrough()
              const writable = new Writable({
                write(data, _encoding, done) {
                  const message = JSON.parse(data.toString().replace(/\0$/, ''))
                  const result =
                    message.method === 'Target.getTargets'
                      ? {
                          targetInfos: supported
                            ? [
                                {
                                  targetId: 'page',
                                  type: 'page',
                                  url: 'about:blank',
                                },
                              ]
                            : [],
                        }
                      : { sessionId: 'attached' }
                  queueMicrotask(() =>
                    readable.write(
                      JSON.stringify({ id: message.id, result }) + '\0',
                    ),
                  )
                  done()
                },
              })
              Object.assign(child, {
                pid: 12345,
                stdio: [null, null, null, writable, readable],
                kill: () => {
                  child.emit('exit', 0)
                  return true
                },
              })
              queueMicrotask(() => child.emit('spawn'))
              return child
            },
          },
        )
        expect(JSON.stringify(output)).toContain('session denied')
        expect(launches).toHaveLength(1)
        expect(launches[0].env).not.toHaveProperty('OPENAI_API_KEY')
        expect(launches[0].env).not.toHaveProperty('CUSTOM_PROVIDER_KEY')
        expect(
          fixture.events
            .filter((event) => event.phase === 'planned')
            .map((event) => event.facts.branchId),
        ).toEqual([
          'chrome.probe',
          supported ? 'chrome.pipe' : 'chrome.port-fallback',
        ])
      } finally {
        fixture.close()
      }
    })

  test('a refusal returned by an asynchronous probe seam is never swallowed', async () => {
    const fixture = executionFixture()
    try {
      await expect(
        detectPipeSupport({
          executablePath: () => '/refusal/chrome',
          now: () => 0,
          probeTimeoutMs: 1,
          spawn: async () => {
            throw Object.assign(new Error('refused probe'), {
              name: 'ExecutionAdmissionError',
            })
          },
        }, { ...fixture.context(), resources: fixture.resources, executablePath: '/refusal/chrome', sandboxArgs: [] }),
      ).rejects.toThrow('refused probe')
    } finally { fixture.close() }
  })

  test('request cancellation stops its wait while a fresh request reuses Chrome', async () => {
    const fixture = executionFixture()
    const controller = new AbortController()
    let launches = 0
    let enteredWait: (() => void) | undefined
    const waiting = new Promise<void>((resolve) => {
      enteredWait = resolve
    })
    const base = {
      resources: fixture.resources,
      executablePath: '/fixture/reuse-chrome',
      sandboxArgs: [],
      spawn: () => {
        launches++
        const child = new EventEmitter() as ChildProcess
        const readable = new PassThrough()
        const writable = new Writable({
          write(data, _encoding, done) {
            const message = JSON.parse(data.toString().replace(/\0$/, ''))
            if (message.params?.expression === '__wait_fixture__') {
              enteredWait?.()
              done()
              return
            }
            const result =
              message.method === 'Target.getTargets'
                ? {
                    targetInfos: [
                      { targetId: 'page', type: 'page', url: 'about:blank' },
                    ],
                  }
                : message.method === 'Target.attachToTarget'
                  ? { sessionId: 'attached' }
                  : message.method === 'Runtime.evaluate'
                    ? {
                        result: {
                          value: {
                            title: 'fixture',
                            text: 'fixture',
                            elements: [],
                          },
                        },
                      }
                    : {}
            queueMicrotask(() =>
              readable.write(JSON.stringify({ id: message.id, result }) + '\0'),
            )
            done()
          },
        })
        Object.assign(child, {
          pid: 12345,
          exitCode: null,
          signalCode: null,
          stdio: [null, null, null, writable, readable],
          kill: () => {
            Object.assign(child, { exitCode: 0 })
            child.emit('exit', 0)
            return true
          },
        })
        queueMicrotask(() => child.emit('spawn'))
        return child
      },
    }
    const first = { ...fixture.context(controller.signal), ...base }
    try {
      expect(
        JSON.stringify(await browserLogs({ type: 'snapshot' }, 'reuse', first)),
      ).toContain('fixture')
      const pending = browserLogs(
        { type: 'evaluate', script: '__wait_fixture__' },
        'reuse',
        first,
      )
      await waiting
      controller.abort(new Error('fixture request cancelled'))
      expect(JSON.stringify(await pending)).toContain(
        'fixture request cancelled',
      )
      const fresh = { ...fixture.context(), ...base }
      expect(
        JSON.stringify(await browserLogs({ type: 'snapshot' }, 'reuse', fresh)),
      ).toContain('fixture')
      expect(launches).toBe(2) // one bounded probe and one shared session
      expect(
        fixture.events.some((event) => event.phase === 'resource-reused'),
      ).toBe(true)
      await browserLogs({ type: 'stop' }, 'reuse', fresh)
    } finally {
      fixture.close()
    }
  })

  test('all five Blender branches dispatch captured env with provider credentials removed', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'external-blender-'))
    const fixture = executionFixture()
    const calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = []
    const execution = {
      ...fixture.context(),
      projectRoot: root,
      allowedPaths: [root],
      spawn: (
        _command: string,
        args?: readonly string[],
        options?: SpawnOptions,
      ) => {
        calls.push({ args: args ?? [], env: options?.env ?? {} })
        return recordedChild('OPENBUFF_3D_JSON:{"changed":[],"objects":[]}\n')
      },
    }
    const fs = Object.assign(createNodeFileSystem(), {
      mutationAuthority: 'cooperative_cas' as const,
      conditionalCommit: async () => ({ applied: true as const }),
    })
    const blend = Buffer.from('fixture')
    writeFileSync(path.join(root, 'scene.blend'), blend)
    writeFileSync(path.join(root, 'scene.fbx'), 'fixture')
    try {
      await inspect3dAsset({ path: 'scene.blend', cwd: root, fs, execution })
      await inspect3dAsset({ path: 'scene.fbx', cwd: root, fs, execution })
      await render3dPreview({
        path: 'scene.blend',
        views: ['front'],
        mode: 'clay',
        width: 10,
        height: 10,
        cwd: root,
        fs,
        execution,
      })
      await edit3dAsset({
        path: 'scene.blend',
        sourceHash: hashFileContent(blend),
        operations: [
          { type: 'rename_object', object: 'Cube', new_name: 'Hero' },
        ],
        cwd: root,
        fs,
        operationId: 'b19-fixture',
        execution,
      })
      const planned = fixture.events
        .filter((event) => event.phase === 'planned')
        .map((event) => event.facts.branchId)
      expect(planned).toEqual([
        'blender.inspect-blend',
        'blender.inspect-import',
        'blender.preview',
        'blender.edit',
        'blender.validate',
        'blender.preview',
      ])
      expect(calls).toHaveLength(6)
      for (const call of calls) {
        expect(call.args[0]).toBe('--disable-autoexec')
        expect(call.env).not.toHaveProperty('OPENAI_API_KEY')
        expect(call.env).not.toHaveProperty('CUSTOM_PROVIDER_KEY')
      }
      expect(calls[1].env.OPENBUFF_3D_SOURCE_FORMAT).toBe('fbx')
      expect(calls[2].env.OPENBUFF_3D_VIEWS).toBe('front')
      expect(calls[3].env.OPENBUFF_3D_OPERATIONS_PATH).toContain('.json')
    } finally {
      fixture.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 15_000)

  test('Blender refusal reports failure without spawn', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'external-blender-denied-'))
    writeFileSync(path.join(root, 'scene.blend'), 'fixture')
    const fixture = executionFixture({
      authorizeAsync: async () => ({
        ok: false,
        reason: 'denied',
        cause: 'blender denied',
      }),
    })
    let launches = 0
    try {
      const output = await inspect3dAsset({
        path: 'scene.blend',
        cwd: root,
        fs: createNodeFileSystem(),
        execution: {
          ...fixture.context(),
          projectRoot: root,
          allowedPaths: [root],
          spawn: () => {
            launches++
            throw new Error('must not launch')
          },
        },
      })
      expect(JSON.stringify(output)).toContain('blender denied')
      expect(launches).toBe(0)
    } finally {
      fixture.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
