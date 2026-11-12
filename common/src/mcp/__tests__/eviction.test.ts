import { afterEach, expect, spyOn, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  captureMcpConfig,
  callMCPTool,
  closeMCPClient,
  getMCPClient,
  getMCPClientCapacity,
  getMCPClientGeneration,
  getPendingMCPClientCleanupCount,
  getMediatedMCPClient,
  listMCPTools,
  listMCPToolCatalog,
  McpClientCapacityError,
  retryMCPClientCleanup,
  getCapturedMCPClient,
} from '../client'
import { executionFixture, value } from './execution-fixture'
import { OwnedStdioTransport } from '../stdio-transport'

const ids: string[] = []
const settleHandoffs = () => new Promise((resolve) => setTimeout(resolve, 0))
async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 2000
  while (!predicate() && performance.now() < deadline) await settleHandoffs()
  expect(predicate()).toBe(true)
}

const configuration = (slug: string, index: number) => ({
  type: 'stdio' as const,
  command: 'fixture',
  args: [`${slug}-${index}`],
  env: {},
})

function fixtureTarget(
  context: ReturnType<ReturnType<typeof executionFixture>['context']>,
  index = 0,
) {
  return {
    executable: process.execPath,
    argv: [String(index)],
    cwd: process.cwd(),
    projectRoot: context.projectRoot,
    allowedPaths: context.allowedPaths,
    mode: context.mode,
    processType: 'BACKGROUND' as const,
    profile: context.profile,
    family: 'mcp-stdio' as const,
    branchId: 'mcp.discovery-start',
    environmentOverlay: {},
    adapterOptions: {
      runtime: 'node',
      detached: process.platform === 'linux',
      scopeTier:
        process.platform === 'linux' ? 'posix-owned-group' : 'direct-child',
      shell: false,
      stdio: 'pipe,pipe,ignore',
      windowsHide: false,
    },
  }
}
afterEach(async () => {
  await Promise.all(ids.splice(0).map((id) => closeMCPClient(id)))
})

test('a mediated request holds its transport until the request lease is released', async () => {
  const connected: Client[] = []
  const closed: Client[] = []
  const originalClose = Client.prototype.close
  const connect = spyOn(Client.prototype, 'connect').mockImplementation(
    async function (this: Client, transport: Transport) {
      connected.push(this)
      transport.close = () => this.close()
      Object.assign(transport, { retryCleanup: transport.close })
    },
  )
  const close = spyOn(Client.prototype, 'close').mockImplementation(
    async function (this: Client) {
      closed.push(this)
      if (!connected.includes(this)) await originalClose.call(this)
    },
  )
  const fixture = executionFixture()
  const context = fixture.context()
  const target = {
    executable: process.execPath,
    argv: [],
    cwd: process.cwd(),
    projectRoot: context.projectRoot,
    allowedPaths: context.allowedPaths,
    mode: context.mode,
    processType: 'BACKGROUND' as const,
    profile: context.profile,
    family: 'mcp-stdio' as const,
    branchId: 'mcp.discovery-start',
    environmentOverlay: {},
    adapterOptions: {
      runtime: 'node',
      shell: false,
      stdio: 'pipe,pipe,ignore',
      windowsHide: false,
    },
  }
  const captured = captureMcpConfig(
    { type: 'stdio', command: process.execPath, args: [], env: {} },
    { origin: 'project', environment: {} },
  )
  try {
    const request = await getMediatedMCPClient(captured, {
      resource: value(fixture.resources(target)),
      execution: context.execution,
    })
    ids.push(request.id)
    for (let i = 0; i < 63; i++) {
      ids.push(
        await getMCPClient({
          type: 'stdio',
          command: 'fixture',
          args: [`lease-${i}`],
          env: {},
        }),
      )
    }
    await settleHandoffs()
    ids.push(
      await getMCPClient({
        type: 'stdio',
        command: 'fixture',
        args: ['lease-63'],
        env: {},
      }),
    )
    expect(closed.filter((client) => connected.includes(client))).toEqual([
      connected[1],
    ])
    expect(getMCPClientGeneration(request.id)).toBeDefined()
    request.release()
    expect(getMCPClientGeneration(request.id)).toBeDefined()
  } finally {
    await Promise.all(ids.splice(0).map((id) => closeMCPClient(id)))
    fixture.close()
    close.mockRestore()
    connect.mockRestore()
  }
})

test('evicts one oldest idle transport and refuses before launch when every remaining client is active', async () => {
  const connected: Client[] = []
  const closed: Client[] = []
  const originalClose = Client.prototype.close
  const pending = new Map<Client, () => void>()
  const connect = spyOn(Client.prototype, 'connect').mockImplementation(
    async function (this: Client, transport: Transport) {
      connected.push(this)
      transport.close = () => this.close()
      Object.assign(transport, { retryCleanup: transport.close })
    },
  )
  const close = spyOn(Client.prototype, 'close').mockImplementation(
    async function (this: Client) {
      closed.push(this)
      if (!connected.includes(this)) await originalClose.call(this)
    },
  )
  const list = spyOn(Client.prototype, 'listTools').mockImplementation(
    function (this: Client) {
      return new Promise((resolve) =>
        pending.set(this, () => resolve({ tools: [] })),
      )
    },
  )
  try {
    const open = async (n: number) => {
      const id = await getMCPClient({
        type: 'stdio',
        command: 'fixture',
        args: [String(n)],
        env: {},
      })
      ids.push(id)
      return id
    }
    for (let i = 0; i < 64; i++) await open(i)
    await settleHandoffs()
    const first = listMCPTools(ids[0])
    await open(64)
    expect(closed.filter((client) => connected.includes(client))).toEqual([
      connected[1],
    ])
    expect(getMCPClientGeneration(ids[0])).toBeDefined()
    expect(getMCPClientGeneration(ids[1])).toBeUndefined()

    const active = [first]
    for (let i = 2; i <= 64; i++) active.push(listMCPTools(ids[i]))
    await expect(open(65)).rejects.toBeInstanceOf(McpClientCapacityError)
    expect(getMCPClientCapacity().occupied).toBe(64)
    expect(connected).toHaveLength(65)
    expect(closed.filter((client) => connected.includes(client))).toEqual([
      connected[1],
    ])
    pending.get(connected[0])!()
    await first
    // Once the use settles, a new connection may claim this oldest idle slot.
    await open(65)
    expect(closed.filter((client) => connected.includes(client))).toEqual([
      connected[1],
      connected[0],
    ])
    for (const resolve of pending.values()) resolve()
    await Promise.all(active)
  } finally {
    await Promise.all(ids.splice(0).map((id) => closeMCPClient(id)))
    list.mockRestore()
    close.mockRestore()
    connect.mockRestore()
  }
})

test('concurrent connection registrations retain each new client until its caller receives it', async () => {
  const releases: (() => void)[] = []
  const connected = new Set<Client>()
  const originalClose = Client.prototype.close
  let deferClose = false
  const connect = spyOn(Client.prototype, 'connect').mockImplementation(
    async function (this: Client, transport: Transport) {
      connected.add(this)
      transport.close = () => this.close()
    },
  )
  const close = spyOn(Client.prototype, 'close').mockImplementation(function (
    this: Client,
  ) {
    if (!connected.has(this)) return originalClose.call(this)
    return deferClose
      ? new Promise<void>((resolve) => releases.push(resolve))
      : Promise.resolve()
  })
  const open = async (n: number) => {
    const id = await getMCPClient({
      type: 'stdio',
      command: 'fixture',
      args: [`race-${n}`],
      env: {},
    })
    ids.push(id)
    return id
  }
  try {
    for (let i = 0; i < 64; i++) await open(i)
    await settleHandoffs()
    deferClose = true
    const first = open(64)
    const second = open(65)
    while (releases.length < 2)
      await new Promise((resolve) => setTimeout(resolve, 0))
    deferClose = false
    for (const release of releases) release()
    const [firstId, secondId] = await Promise.all([first, second])
    expect(getMCPClientGeneration(firstId)).toBeDefined()
    expect(getMCPClientGeneration(secondId)).toBeDefined()
  } finally {
    deferClose = false
    for (const release of releases) release()
    await Promise.all(ids.splice(0).map((id) => closeMCPClient(id)))
    close.mockRestore()
    connect.mockRestore()
  }
}, 10_000)

test('all-active capacity refuses concurrent new connections without opening transports', async () => {
  const connected = new Set<Client>()
  const originalClose = Client.prototype.close
  const pending: (() => void)[] = []
  const connect = spyOn(Client.prototype, 'connect').mockImplementation(
    async function (this: Client, transport: Transport) {
      connected.add(this)
      transport.close = () => this.close()
    },
  )
  const close = spyOn(Client.prototype, 'close').mockImplementation(function (
    this: Client,
  ) {
    return connected.has(this) ? Promise.resolve() : originalClose.call(this)
  })
  const list = spyOn(Client.prototype, 'listTools').mockImplementation(
    () => new Promise((resolve) => pending.push(() => resolve({ tools: [] }))),
  )
  const open = async (n: number) => {
    const id = await getMCPClient({
      type: 'stdio',
      command: 'fixture',
      args: [`busy-${n}`],
      env: {},
    })
    ids.push(id)
    return id
  }
  try {
    for (let i = 0; i < 64; i++) await open(i)
    const uses = ids.map((id) => listMCPTools(id))
    await settleHandoffs()
    const results = await Promise.allSettled([open(64), open(65)])
    for (const result of results) {
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(McpClientCapacityError)
        expect(result.reason.reason).toBe('all-connections-busy')
      }
    }
    expect(connected.size).toBe(64)
    expect(getMCPClientCapacity().occupied).toBe(64)
    for (const resolve of pending) resolve()
    await Promise.all(uses)
  } finally {
    for (const resolve of pending) resolve()
    await Promise.all(ids.splice(0).map((id) => closeMCPClient(id)))
    list.mockRestore()
    close.mockRestore()
    connect.mockRestore()
  }
})

test('failed eviction retains the old cleanup owner and retry leaves its replacement open', async () => {
  const connected: Client[] = []
  const closed: Client[] = []
  const originalClose = Client.prototype.close
  let failOnce = true
  const connect = spyOn(Client.prototype, 'connect').mockImplementation(
    async function (this: Client, transport: Transport) {
      connected.push(this)
      transport.close = () => this.close()
      Object.assign(transport, { retryCleanup: transport.close })
    },
  )
  const close = spyOn(Client.prototype, 'close').mockImplementation(
    async function (this: Client) {
      if (!connected.includes(this)) return originalClose.call(this)
      closed.push(this)
      if (this === connected[0] && failOnce) {
        failOnce = false
        throw new Error('close failed')
      }
    },
  )
  const config = (n: number) => ({
    type: 'stdio' as const,
    command: 'fixture',
    args: [`cleanup-${n}`],
    env: {},
  })
  try {
    for (let i = 0; i < 64; i++) ids.push(await getMCPClient(config(i)))
    await settleHandoffs()
    const oldId = ids[0]
    const refusal = await getMCPClient(config(64)).catch((error) => error)
    expect(refusal).toBeInstanceOf(McpClientCapacityError)
    expect(refusal.reason).toBe('cleanup-failed')
    expect(refusal.cause.message).toBe('close failed')
    expect(getPendingMCPClientCleanupCount(oldId)).toBe(1)
    expect(getMCPClientCapacity().occupied).toBe(64)
    expect(getMCPClientCapacity().cleanupFailed).toBe(1)
    expect(connected).toHaveLength(64)
    const replacement = await getMCPClient(config(0))
    ids.push(replacement)
    const generation = getMCPClientGeneration(replacement)
    const replacementClient = connected.at(-1)!
    await retryMCPClientCleanup(oldId)
    expect(getPendingMCPClientCleanupCount(oldId)).toBe(0)
    expect(getMCPClientGeneration(replacement)).toBe(generation)
    expect(closed.filter((client) => client === connected[0])).toHaveLength(2)
    expect(closed).not.toContain(replacementClient)
    connected[0].onclose?.()
    await settleHandoffs()
    expect(getMCPClientGeneration(replacement)).toBe(generation)
    expect(getPendingMCPClientCleanupCount(oldId)).toBe(0)
    expect(getMCPClientCapacity().occupied).toBe(63)
  } finally {
    await Promise.all(ids.splice(0).map((id) => closeMCPClient(id)))
    close.mockRestore()
    connect.mockRestore()
  }
})

test('cache hit reserves its client while its ID is delivered', async () => {
  const connected = new Set<Client>()
  const originalClose = Client.prototype.close
  const connect = spyOn(Client.prototype, 'connect').mockImplementation(
    async function (this: Client, transport: Transport) {
      connected.add(this)
      transport.close = () => this.close()
    },
  )
  const close = spyOn(Client.prototype, 'close').mockImplementation(function (
    this: Client,
  ) {
    return connected.has(this) ? Promise.resolve() : originalClose.call(this)
  })
  const config = (n: number) => ({
    type: 'stdio' as const,
    command: 'fixture',
    args: [`cached-${n}`],
    env: {},
  })
  try {
    for (let i = 0; i < 64; i++) ids.push(await getMCPClient(config(i)))
    await settleHandoffs()
    const reused = getMCPClient(config(0))
    const added = getMCPClient(config(64))
    const oldId = await reused
    expect(getMCPClientGeneration(oldId)).toBeDefined()
    ids.push(await added)
    expect(getMCPClientGeneration(oldId)).toBeDefined()
    expect(getMCPClientGeneration(ids[1])).toBeUndefined()
  } finally {
    await Promise.all(ids.splice(0).map((id) => closeMCPClient(id)))
    close.mockRestore()
    connect.mockRestore()
  }
})

test('failed close retries the retained transport even after SDK loses its transport', async () => {
  let attempts = 0
  const connect = spyOn(Client.prototype, 'connect').mockImplementation(
    async function (this: Client, transport: Transport) {
      const protocol = this as unknown as { _transport?: Transport }
      protocol._transport = transport
      transport.onclose = () => {
        protocol._transport = undefined
      }
      transport.close = async () => {
        attempts++
        if (attempts === 1) {
          transport.onclose?.()
          throw new Error('transport close failed after onclose')
        }
      }
      Object.assign(transport, { retryCleanup: transport.close })
    },
  )
  const config = {
    type: 'stdio' as const,
    command: 'fixture',
    args: ['detached'],
    env: {},
  }
  let id: string | undefined
  try {
    id = await getMCPClient(config)
    await expect(closeMCPClient(id)).rejects.toThrow('transport close failed')
    expect(getPendingMCPClientCleanupCount(id)).toBe(1)
    await retryMCPClientCleanup(id)
    expect(attempts).toBe(2)
    expect(getPendingMCPClientCleanupCount(id)).toBe(0)
  } finally {
    if (id) await retryMCPClientCleanup(id)
    connect.mockRestore()
  }
})

test('connecting reservations cap physical starts before any handshake completes', async () => {
  const connected: Client[] = []
  const releases: (() => void)[] = []
  const snapshots: number[] = []
  const connect = spyOn(Client.prototype, 'connect').mockImplementation(
    function (this: Client, transport: Transport) {
      connected.push(this)
      snapshots.push(getMCPClientCapacity().occupied)
      transport.close = async () => {}
      return new Promise<void>((resolve) => releases.push(resolve))
    },
  )
  const openings = Array.from({ length: 64 }, (_, index) =>
    getMCPClient(configuration('connecting', index)).then((id) => {
      ids.push(id)
      return id
    }),
  )
  const reused = getMCPClient(configuration('connecting', 0))
  try {
    await until(() => connected.length === 64)
    expect(getMCPClientCapacity()).toMatchObject({
      occupied: 64,
      connecting: 64,
      live: 0,
    })
    await expect(
      getMCPClient(configuration('connecting', 64)),
    ).rejects.toBeInstanceOf(McpClientCapacityError)
    expect(connected).toHaveLength(64)
    for (const release of releases) release()
    const opened = await Promise.all(openings)
    expect(await reused).toBe(opened[0])
    expect(Math.max(...snapshots)).toBe(64)
    expect(getMCPClientCapacity()).toMatchObject({
      occupied: 64,
      connecting: 0,
      live: 64,
    })
  } finally {
    for (const release of releases) release()
    await Promise.allSettled(openings)
    await reused.catch(() => {})
    await Promise.all(ids.splice(0).map((id) => closeMCPClient(id)))
    connect.mockRestore()
  }
})

test('early protocol close keeps capacity and concurrent claimants each close one idle instance', async () => {
  const connected: Client[] = []
  const releases = new Map<Client, () => void>()
  const closeCalls = new Map<Client, number>()
  let deferClose = false
  const connect = spyOn(Client.prototype, 'connect').mockImplementation(
    async function (this: Client, transport: Transport) {
      connected.push(this)
      transport.close = () => {
        closeCalls.set(this, (closeCalls.get(this) ?? 0) + 1)
        // An early SDK notification is a logical disconnect only. Reentrant
        // cleanup sees the already reserved promise for this exact instance.
        this.onclose?.()
        return deferClose
          ? new Promise<void>((resolve) => releases.set(this, resolve))
          : Promise.resolve()
      }
    },
  )
  const open = async (index: number) => {
    const id = await getMCPClient(configuration('closing', index))
    ids.push(id)
    return id
  }
  try {
    for (let index = 0; index < 64; index++) await open(index)
    await settleHandoffs()
    deferClose = true
    const first = open(64)
    const second = open(65)
    await until(() => releases.size === 2)
    expect(connected).toHaveLength(64)
    expect(getMCPClientCapacity()).toMatchObject({
      occupied: 64,
      live: 62,
      closing: 2,
    })
    expect(closeCalls.get(connected[0])).toBe(1)
    expect(closeCalls.get(connected[1])).toBe(1)
    const repeated = closeMCPClient(ids[0])
    expect(closeCalls.get(connected[0])).toBe(1)
    deferClose = false
    releases.get(connected[0])!()
    const firstId = await first
    await repeated
    expect(getMCPClientGeneration(firstId)).toBeDefined()
    expect(connected).toHaveLength(65)
    expect(getMCPClientCapacity().occupied).toBe(64)
    releases.get(connected[1])!()
    const secondId = await second
    expect(getMCPClientGeneration(secondId)).toBeDefined()
    expect(getMCPClientCapacity()).toMatchObject({
      occupied: 64,
      closing: 0,
      live: 64,
    })
  } finally {
    deferClose = false
    for (const release of releases.values()) release()
    await Promise.all(ids.splice(0).map((id) => closeMCPClient(id)))
    connect.mockRestore()
  }
})

test('releasing a held lease during a catalog call leaves its instance protected until the call settles', async () => {
  const connected: Client[] = []
  const closed: Client[] = []
  let finish: (() => void) | undefined
  const connect = spyOn(Client.prototype, 'connect').mockImplementation(
    async function (this: Client, transport: Transport) {
      connected.push(this)
      const physicalClose = transport.close.bind(transport)
      if (transport instanceof OwnedStdioTransport) await transport.start()
      transport.close = async () => {
        closed.push(this)
        if (transport instanceof OwnedStdioTransport) await physicalClose()
      }
    },
  )
  const list = spyOn(Client.prototype, 'listTools').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ tools: [] })
      }),
  )
  const fixture = executionFixture()
  const context = fixture.context()
  const captured = captureMcpConfig(
    { type: 'stdio', command: process.execPath, args: [], env: {} },
    { origin: 'project', environment: {} },
  )
  try {
    const request = await getMediatedMCPClient(captured, {
      resource: value(
        fixture.resources({
          ...fixtureTarget(context),
          adapterOptions: {
            ...fixtureTarget(context).adapterOptions,
            detached: false,
            scopeTier: 'direct-child',
          },
        }),
      ),
      execution: context.execution,
      spawn: () => {
        const child = new EventEmitter() as ChildProcess
        Object.defineProperty(child, 'pid', { value: 12345 })
        child.kill = () => {
          queueMicrotask(() => child.emit('close', 0, null))
          return true
        }
        queueMicrotask(() => child.emit('spawn'))
        return child
      },
    })
    ids.push(request.id)
    for (let index = 0; index < 63; index++)
      ids.push(await getMCPClient(configuration('released-use', index)))
    await settleHandoffs()
    const pending = request.listToolCatalog()
    await until(() => finish !== undefined)
    request.release()
    ids.push(await getMCPClient(configuration('released-use', 63)))
    expect(closed).toEqual([connected[1]])
    expect(request.generation).toBeDefined()
    finish!()
    expect((await pending).complete).toBe(true)
    ids.push(await getMCPClient(configuration('released-use', 64)))
    expect(closed).toEqual([connected[1], connected[0]])
    expect(request.generation).toBeUndefined()
  } finally {
    finish?.()
    await Promise.all(ids.splice(0).map((id) => closeMCPClient(id)))
    fixture.close()
    list.mockRestore()
    connect.mockRestore()
  }
})

test('64 held request leases refuse both compatibility and remote connects before launch', async () => {
  const connected: Client[] = []
  const connect = spyOn(Client.prototype, 'connect').mockImplementation(
    async function (this: Client, transport: Transport) {
      connected.push(this)
      transport.close = async () => {}
    },
  )
  const fixture = executionFixture()
  const requests: Awaited<ReturnType<typeof getMediatedMCPClient>>[] = []
  try {
    for (let index = 0; index < 64; index++) {
      const context = fixture.context()
      const captured = captureMcpConfig(
        {
          type: 'stdio',
          command: process.execPath,
          args: [String(index)],
          env: {},
        },
        { origin: 'project', environment: {} },
      )
      const request = await getMediatedMCPClient(captured, {
        resource: value(fixture.resources(fixtureTarget(context, index))),
        execution: context.execution,
      })
      requests.push(request)
      ids.push(request.id)
    }
    await expect(
      getMCPClient(configuration('all-held', 0)),
    ).rejects.toBeInstanceOf(McpClientCapacityError)
    const remote = captureMcpConfig(
      {
        type: 'http',
        url: 'https://mcp.example.test',
        headers: {},
        params: {},
      },
      { origin: 'project', environment: {} },
    )
    await expect(getCapturedMCPClient(remote)).rejects.toBeInstanceOf(
      McpClientCapacityError,
    )
    expect(connected).toHaveLength(64)
    expect(getMCPClientCapacity().occupied).toBe(64)
    expect(requests.every((request) => request.generation !== undefined)).toBe(
      true,
    )
  } finally {
    for (const request of requests) request.release()
    await Promise.all(ids.splice(0).map((id) => closeMCPClient(id)))
    fixture.close()
    connect.mockRestore()
  }
})

test('list, paged catalog, and call compatibility paths each protect their active physical connection', async () => {
  const connected: Client[] = []
  const closed: Client[] = []
  const complete: (() => void)[] = []
  const connect = spyOn(Client.prototype, 'connect').mockImplementation(
    async function (this: Client, transport: Transport) {
      connected.push(this)
      transport.close = async () => {
        closed.push(this)
      }
    },
  )
  const list = spyOn(Client.prototype, 'listTools').mockImplementation(
    () => new Promise((resolve) => complete.push(() => resolve({ tools: [] }))),
  )
  const call = spyOn(Client.prototype, 'request').mockImplementation(
    (() =>
      new Promise<{ content: [] }>((resolve) =>
        complete.push(() => resolve({ content: [] })),
      )) as typeof Client.prototype.request,
  )
  try {
    for (let index = 0; index < 64; index++)
      ids.push(await getMCPClient(configuration('method-uses', index)))
    await settleHandoffs()
    const uses = [
      listMCPTools(ids[0]),
      listMCPToolCatalog(ids[1]),
      callMCPTool(ids[2], { name: 'fixture' }),
    ]
    await until(() => complete.length === 3)
    ids.push(await getMCPClient(configuration('method-uses', 64)))
    expect(closed).toEqual([connected[3]])
    for (const finish of complete) finish()
    await Promise.all(uses)
    expect(
      ids.slice(0, 3).every((id) => getMCPClientGeneration(id) !== undefined),
    ).toBe(true)
  } finally {
    for (const finish of complete) finish()
    await Promise.all(ids.splice(0).map((id) => closeMCPClient(id)))
    call.mockRestore()
    list.mockRestore()
    connect.mockRestore()
  }
})
