import { EventEmitter } from 'node:events'
import { expect, test } from 'bun:test'

import { createLspMultiplexer, LspExecutionError } from '../services/lsp-multiplexer'
import { executionFixture } from './toolchain-execution-fixture'
import type { LspChildHandle, LspResourceFacade, LspResourceFactory } from '../services/lsp-multiplexer'
import type { UsePermit } from '@codebuff/common/types/contracts/execution-context'

function peer() {
  const events = new EventEmitter()
  const output = new EventEmitter()
  const methods: string[] = []
  let kills = 0
  const child: LspChildHandle = {
    stdin: { write(frame) {
      const request = JSON.parse(frame.slice(frame.indexOf('\r\n\r\n') + 4))
      methods.push(request.method)
      if (request.id !== undefined) {
        const body = JSON.stringify({ jsonrpc: '2.0', id: request.id, result: request.method === 'initialize' ? { capabilities: {} } : request.method === 'textDocument/hover' ? { contents: 'fixture hover' } : [] })
        output.emit('data', Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`))
      }
    }, end() {} },
    stdout: { on(event, listener) { output.on(event, listener) } },
    on: ((event: string, listener: (...args: unknown[]) => void) => { events.on(event, listener) }) as LspChildHandle['on'],
    kill() { kills++ },
  }
  return { child, methods, crash() { events.emit('exit', 1, null) }, get kills() { return kills } }
}

function setup(options: { admissionWait?: Promise<void>; restartWait?: Promise<void>; useWait?: Promise<void>; refuseRestart?: boolean } = {}) {
  const fixture = executionFixture({ wait: options.admissionWait })
  const request = { execution: fixture.context.execution }
  const generations: number[] = []
  const maintenance: Array<{ generation: number; reason: string }> = []
  const peers: ReturnType<typeof peer>[] = []
  let uses = 0
  let releases = 0
  const makeResource = (generation: number): LspResourceFacade => {
    const facade: LspResourceFacade = {
    async admitSpawn(spec) {
      if (this !== facade) return { ok: false, reason: 'unavailable', cause: 'Incorrect resource receiver' }
      if (generation > 0) await options.restartWait
      if (generation === 1 && options.refuseRestart) return { ok: false, reason: 'denied', cause: 'injected restart refusal' }
      const prepared = fixture.context.execution.prepareTarget({ target: {
        executable: spec.argv[0], argv: spec.argv.slice(1), cwd: spec.cwd,
        projectRoot: '/repo', allowedPaths: ['/repo'], mode: 'assistant', processType: 'BACKGROUND',
        profile: fixture.context.profile, family: 'lsp', branchId: generation ? 'lsp.crash-restart' : 'lsp.cold-start', adapterOptions: { runtime: 'node' },
      } })
      if (!prepared.ok) return prepared
      const admitted = await prepared.value.admit()
      if (!admitted.ok) return admitted
      generations.push(generation)
      return { ok: true, value: { launch: prepared.value, permit: admitted.value.permit } }
    },
    nextGeneration(reason) { maintenance.push({ generation, reason }); return { ok: true, value: makeResource(generation + 1) } },
    request() {
      let used = false
      const permit = {} as UsePermit
      return { ok: true, value: {
        prepareLaunch() { return { ok: false, reason: 'unavailable', cause: 'Use-only test lease' } },
        async admitUse() { await options.useWait; return { ok: true, value: permit } },
        useNow(token, use) {
          if (used || token !== permit) return { ok: false, reason: 'already-consumed', cause: 'Fixture use consumed' }
          used = true; uses++
          return { ok: true, value: use() }
        },
        release() { releases++; return { ok: true, value: undefined } },
      } }
    },
    }
    return facade
  }
  const resourceFactory: LspResourceFactory = () => ({ ok: true, value: makeResource(0) })
  const mux = createLspMultiplexer({ resourceFactory, rootResolver: () => '/repo', requestTimeoutMs: 500,
    spawner(_spec, admitted) {
      const dispatched = admitted.launch.dispatchNow(admitted.permit, () => {
        const current = peer(); peers.push(current); return current.child
      })
      if (!dispatched.ok) throw new LspExecutionError(dispatched)
      return dispatched.value.handle
    } })
  return { mux, request, fixture, generations, maintenance, peers, get uses() { return uses }, get releases() { return releases } }
}

const query = { filePath: '/repo/a.ts', position: { line: 0, character: 0 } }

test('LSP start awaits the actual admission callback before calling the spawner', async () => {
  let release!: () => void
  const state = setup({ admissionWait: new Promise<void>(resolve => { release = resolve }) })
  const pending = state.mux.definition(query, state.request)
  await Promise.resolve(); await Promise.resolve()
  expect(state.peers).toHaveLength(0)
  release()
  expect(await pending).toEqual([])
  expect(state.generations).toEqual([0])
  expect(state.fixture.observations).toEqual([]) // Mock LSP handles never claim observed processes.
  await state.mux.dispose()
})

test('warm LSP reuse admits each request and does not spawn again', async () => {
  const state = setup()
  await state.mux.definition(query, state.request)
  await state.mux.hover(query, state.request)
  await state.mux.workspaceSymbol('name', undefined, state.request)
  expect(state.peers).toHaveLength(1)
  expect(state.uses).toBe(3)
  expect(state.releases).toBe(3)
  expect(state.peers[0].methods).toContain('workspace/symbol')
  await state.mux.dispose()
})

test('an aborted requester does not cancel another requester or the run resource', async () => {
  const state = setup()
  await state.mux.definition(query, state.request)
  const cancelled = new AbortController(); cancelled.abort(new Error('request A ended'))
  await expect(state.mux.hover(query, { ...state.request, signal: cancelled.signal })).rejects.toThrow('request A ended')
  expect(await state.mux.hover(query, state.request)).toEqual({ contents: 'fixture hover' })
  expect(state.peers).toHaveLength(1)
  expect(state.peers[0].kills).toBe(0)
  await state.mux.dispose()
})

test('crash restart uses a new immutable generation and maintenance reason', async () => {
  const state = setup()
  await state.mux.definition(query, state.request)
  state.peers[0].crash()
  expect(await state.mux.definition(query, state.request)).toEqual([])
  expect(state.generations).toEqual([0, 1])
  expect(state.maintenance).toEqual([{ generation: 0, reason: 'observed-adapter-failure' }])
  await state.mux.dispose()
})

test('reacquire after a failed replacement uses the failed generation, not stale original authority', async () => {
  const state = setup({ refuseRestart: true })
  await state.mux.definition(query, state.request)
  state.peers[0].crash()
  expect(await state.mux.definition(query, state.request)).toEqual([])
  expect(state.generations).toEqual([0, 2])
  expect(state.maintenance).toEqual([
    { generation: 0, reason: 'observed-adapter-failure' },
    { generation: 1, reason: 'dead-entry-reacquire' },
  ])
  await state.mux.dispose()
})

test('missing LSP execution context cannot reach a spawner', async () => {
  let starts = 0
  const mux = createLspMultiplexer({ spawner() { starts++; return peer().child } })
  await expect(mux.definition(query)).rejects.toBeInstanceOf(LspExecutionError)
  expect(starts).toBe(0)
  await mux.dispose()
})

test('caller A can abort a cold start wait while caller B continues on the same resource', async () => {
  let release!: () => void
  const state = setup({ admissionWait: new Promise<void>(resolve => { release = resolve }) })
  const cancelled = new AbortController()
  const first = state.mux.definition(query, { ...state.request, signal: cancelled.signal })
  const firstCheck = first.then(() => undefined, error => error as Error)
  const second = state.mux.definition(query, state.request)
  cancelled.abort(new Error('A stopped waiting'))
  expect((await firstCheck)?.message).toBe('A stopped waiting')
  release()
  expect(await second).toEqual([])
  expect(state.peers).toHaveLength(1)
  expect(state.peers[0].kills).toBe(0)
  await state.mux.dispose()
})

test('aborting during use admission never writes the request and releases its lease', async () => {
  let release!: () => void
  const state = setup({ useWait: new Promise<void>(resolve => { release = resolve }) })
  const cancelled = new AbortController()
  const pending = state.mux.definition(query, { ...state.request, signal: cancelled.signal })
  const checked = pending.then(() => undefined, error => error as Error)
  await new Promise(resolve => setTimeout(resolve, 10))
  cancelled.abort(new Error('use wait cancelled'))
  expect((await checked)?.message).toBe('use wait cancelled')
  release()
  await Promise.resolve()
  expect(state.peers[0].methods).not.toContain('textDocument/definition')
  expect(state.uses).toBe(0)
  expect(state.releases).toBe(1)
  await state.mux.dispose()
})

test('disposal during restart backoff never launches a replacement', async () => {
  const state = setup()
  await state.mux.definition(query, state.request)
  state.peers[0].crash()
  await state.mux.dispose()
  await new Promise(resolve => setTimeout(resolve, 250))
  expect(state.peers).toHaveLength(1)
  expect(state.generations).toEqual([0])
})

test('disposal while a replacement awaits admission stops that pending connection', async () => {
  let release!: () => void
  const state = setup({ restartWait: new Promise<void>(resolve => { release = resolve }) })
  await state.mux.definition(query, state.request)
  state.peers[0].crash()
  await new Promise(resolve => setTimeout(resolve, 250))
  await state.mux.dispose()
  release()
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(state.peers).toHaveLength(1)
  expect(state.fixture.dispatches).toBe(1)
})
