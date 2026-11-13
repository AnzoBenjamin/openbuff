import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { captureLinuxProcessGroup } from '../linux-process-scope'

import type { LinuxProcessScopeDependencies } from '../linux-process-scope'

const leaderPid = 123
const memberPid = 456
const namespace = 'pid:[4026531836]'
const receipts: Record<string, unknown>[] = []
afterAll(() => {
  const directory = process.env.B20_LINUX_DRIVER_EVIDENCE_DIR
  if (!directory) return
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'controls.json'), JSON.stringify({
    proofTier: 'dependency-injected-production-linux-driver',
    realSignals: 0, realProcessesLaunched: 0, controls: receipts,
  }, null, 2) + '\n')
})

function errno(code: string) { return Object.assign(new Error(code), { code }) }
function stat(pid: number, state = 'S', startTime = '100', pgid = leaderPid, sid = leaderPid) {
  return `${pid} (name with spaces) and closing parens)) ${[
    state, '1', String(pgid), String(sid), ...Array(15).fill('0'), startTime,
  ].join(' ')}`
}
function fixture() {
  const stats = new Map<number, string | Error>([[leaderPid, stat(leaderPid)]])
  const namespaces = new Map<number, string | Error>([[leaderPid, namespace]])
  let names: readonly string[] = [String(leaderPid)]
  const calls: { operation: string; pid?: number; signal?: 0 | 'SIGTERM' | 'SIGKILL' }[] = []
  const signals: { pid: number; signal: 'SIGTERM' | 'SIGKILL' }[] = []
  let probeError: Error | undefined
  let signalError: Error | undefined
  let listError: Error | undefined
  const read = (values: Map<number, string | Error>, pid: number) => {
    const value = values.get(pid)
    if (value instanceof Error) throw value
    if (value === undefined) throw errno('ENOENT')
    return value
  }
  const dependencies: LinuxProcessScopeDependencies = {
    readStat(pid) { calls.push({ operation: 'stat', pid }); return read(stats, pid) },
    readNamespace(pid) { calls.push({ operation: 'namespace', pid }); return read(namespaces, pid) },
    listPids() { calls.push({ operation: 'list' }); if (listError) throw listError; return names },
    kill(pid, signal) {
      // Every signal, including existence probes, terminates here. Never call
      // process.kill or launch an OS process from this injected control.
      expect(pid).toBe(-leaderPid)
      calls.push({ operation: 'kill', pid, signal })
      if (signal === 0) { if (probeError) throw probeError }
      else { signals.push({ pid, signal }); if (signalError) throw signalError }
    },
  }
  const group = captureLinuxProcessGroup(leaderPid, dependencies)
  return { stats, namespaces, calls, signals, group, dependencies,
    names: (value: readonly string[]) => { names = value },
    probeError: (value?: Error) => { probeError = value },
    signalError: (value?: Error) => { signalError = value },
    listError: (value?: Error) => { listError = value },
    member(state = 'S', memberNamespace: string | Error = namespace) {
      stats.delete(leaderPid)
      namespaces.delete(leaderPid)
      stats.set(memberPid, stat(memberPid, state))
      namespaces.set(memberPid, memberNamespace)
      names = [String(memberPid)]
    },
    record(name: string, observations: unknown) {
      receipts.push({ name, observations, calls: [...calls], signals: [...signals] })
    },
  }
}

describe('Linux process group driver with injected procfs and signals', () => {
  test('EPERM is unknown visibility and signal failure, never group absence', () => {
    const f = fixture()
    f.probeError(errno('EPERM'))
    f.signalError(errno('EPERM'))
    const observation = f.group.observe()
    expect(observation).toMatchObject({ scopePresence: 'unknown', membershipComplete: false, identity: 'verified' })
    const signal = f.group.signal('SIGKILL')
    expect(signal).toMatchObject({ result: 'unknown', errorCode: 'EPERM' })
    expect(f.signals).toEqual([{ pid: -leaderPid, signal: 'SIGKILL' }])
    expect(f.calls.some(call => call.operation === 'list')).toBe(false)
    f.record('eperm-visibility-and-signal', { observation, signal })
  })

  test('ESRCH is sampled absence; it does not seal a group before adapter reap', () => {
    const f = fixture()
    f.probeError(errno('ESRCH'))
    f.signalError(errno('ESRCH'))
    const absent = f.group.observe()
    expect(absent).toMatchObject({ scopePresence: 'absent', membershipComplete: true, identity: 'verified' })
    const signal = f.group.signal('SIGTERM')
    expect(signal).toMatchObject({ result: 'already-absent', errorCode: 'ESRCH' })
    f.probeError()
    const later = f.group.observe()
    expect(later.scopePresence).toBe('living')
    f.record('esrch-sampled-absence-not-sticky', { absent, signal, later })
  })

  for (const operation of ['stat', 'namespace'] as const) {
    for (const code of ['ENOENT', 'ESRCH', 'EPERM']) {
      test(`listed living nonleader ${operation} ${code} makes the inventory incomplete`, () => {
        const f = fixture()
        f.member()
        const values = operation === 'stat' ? f.stats : f.namespaces
        values.set(memberPid, errno(code))
        const observation = f.group.observe()
        f.record(`nonleader-${operation}-${code}`, observation)
        expect(observation).toMatchObject({ scopePresence: 'unknown', members: [], membershipComplete: false })
      })
    }
  }

  for (const [state, disposition, scopePresence] of [
    ['Z', 'zombie', 'zombie-only'], ['X', 'exited', 'zombie-only'],
    ['x', 'exited', 'zombie-only'], ['D', 'living', 'living'], ['?', 'unknown', 'unknown'],
  ] as const) {
    test(`state ${state} retains ${disposition} membership`, () => {
      const f = fixture()
      f.member(state)
      const observation = f.group.observe()
      expect(observation).toMatchObject({ scopePresence, membershipComplete: true, identity: 'verified' })
      expect(observation.members).toHaveLength(1)
      expect(observation.members[0]).toMatchObject({ state, disposition, identity: { pid: memberPid, pidNamespace: namespace } })
      f.record(`state-${state}`, observation)
    })
  }

  test('recognized running, sleeping, stopped and idle states all remain living', () => {
    const f = fixture()
    const observations = [...'RSTtWIP'].map(state => {
      f.member(state)
      const observation = f.group.observe()
      expect(observation.scopePresence).toBe('living')
      expect(observation.members[0]?.disposition).toBe('living')
      return observation
    })
    f.record('recognized-living-states', observations)
  })

  test('zombie/dead namespace disappearance retains explicit null namespace membership', () => {
    const f = fixture()
    const observations = ['Z', 'X', 'x'].flatMap(state => ['ENOENT', 'ESRCH'].map(code => {
      f.member(state, errno(code))
      const observation = f.group.observe()
      expect(observation).toMatchObject({ scopePresence: 'zombie-only', membershipComplete: true })
      expect(observation.members[0]?.identity.pidNamespace).toBeNull()
      return { state, code, observation }
    }))
    f.record('zombie-dead-missing-namespace', observations)
  })

  test('zombie namespace permission failure remains unknown', () => {
    const f = fixture()
    f.member('Z', errno('EPERM'))
    const observation = f.group.observe()
    expect(observation).toMatchObject({ scopePresence: 'unknown', membershipComplete: false })
    f.record('zombie-namespace-eperm', observation)
  })

  test('malformed listed stat and an unreadable proc inventory cannot establish extinction', () => {
    const f = fixture()
    f.member()
    f.stats.set(memberPid, 'malformed')
    const malformed = f.group.observe()
    expect(malformed).toMatchObject({ scopePresence: 'unknown', membershipComplete: false })
    f.listError(errno('EIO'))
    const unreadable = f.group.observe()
    expect(unreadable).toMatchObject({ scopePresence: 'unknown', membershipComplete: false })
    f.record('malformed-stat-and-unreadable-inventory', { malformed, unreadable })
  })

  test('member retention overflow cannot certify zero living members', () => {
    const f = fixture()
    f.member('Z')
    const pids = Array.from({ length: 1_025 }, (_, index) => 1_000 + index)
    for (const pid of pids) {
      f.stats.set(pid, stat(pid, 'Z'))
      f.namespaces.set(pid, namespace)
    }
    f.names(pids.map(String))
    const observation = f.group.observe()
    expect(observation.members).toHaveLength(1_024)
    expect(observation).toMatchObject({ scopePresence: 'unknown', membershipComplete: false })
    f.record('member-retention-overflow', observation)
  })

  test('proc inventory overflow caps scanning and cannot hide an unscanned living member', () => {
    const f = fixture()
    f.member()
    const pids = Array.from({ length: 16_384 }, (_, index) => 1_000 + index)
    for (const pid of pids) f.stats.set(pid, stat(pid, 'S', '100', 9, 9))
    f.names([...pids.map(String), String(memberPid), 'self', 'not-a-pid'])
    const before = f.calls.length
    const observation = f.group.observe()
    expect(observation).toMatchObject({ scopePresence: 'unknown', members: [], membershipComplete: false })
    expect(f.calls.slice(before).filter(call => call.operation === 'stat')).toHaveLength(16_385)
    expect(f.calls.slice(before).some(call => call.operation === 'stat' && call.pid === memberPid)).toBe(false)
    f.record('proc-inventory-overflow', observation)
  })

  for (const replacement of ['startTime', 'pgid', 'sid', 'namespace'] as const) {
    test(`leader ${replacement} replacement between TERM and escalation refuses KILL`, () => {
      const f = fixture()
      const initial = f.group.observe()
      expect(initial.scopePresence).toBe('living')
      const term = f.group.signal('SIGTERM')
      expect(term.result).toBe('delivered')
      if (replacement === 'namespace') f.namespaces.set(leaderPid, 'pid:[4026532999]')
      else f.stats.set(leaderPid, stat(leaderPid, 'S', replacement === 'startTime' ? '101' : '100',
        replacement === 'pgid' ? 999 : leaderPid, replacement === 'sid' ? 999 : leaderPid))
      const kill = f.group.signal('SIGKILL')
      expect(kill.result).toBe('refused-identity')
      expect(f.signals).toEqual([{ pid: -leaderPid, signal: 'SIGTERM' }])
      expect(f.group.observe().identity).toBe('mismatch')
      f.record(`recycled-${replacement}-before-escalation`, { initial, term, kill })
    })
  }

  for (const replacement of ['pid', 'startTime', 'pgid', 'sid'] as const) {
    for (const code of ['ENOENT', 'EPERM']) {
      test(`known leader ${replacement} mismatch dominates subsequent namespace ${code}`, () => {
        const f = fixture()
        f.stats.set(leaderPid, stat(replacement === 'pid' ? 999 : leaderPid, 'S',
          replacement === 'startTime' ? '101' : '100',
          replacement === 'pgid' ? 999 : leaderPid, replacement === 'sid' ? 999 : leaderPid))
        f.namespaces.set(leaderPid, errno(code))
        const before = f.calls.length
        const observation = f.group.observe()
        const signal = f.group.signal('SIGKILL')
        f.record(`known-${replacement}-mismatch-namespace-${code}`, { observation, signal })
        expect(observation.identity).toBe('mismatch')
        expect(signal.result).toBe('refused-identity')
        expect(f.calls.slice(before).every(call => call.operation === 'stat')).toBe(true)
        expect(f.signals).toEqual([])
      })
    }
  }

  test('missing initial identity grants no numeric probe or broadcast', () => {
    const f = fixture()
    f.stats.set(leaderPid, errno('EPERM'))
    const group = captureLinuxProcessGroup(leaderPid, f.dependencies)
    const before = f.calls.length
    const observation = group.observe()
    const signal = group.signal('SIGKILL')
    expect(group.identity).toBeNull()
    expect(observation).toMatchObject({ identity: 'unknown', scopePresence: 'unknown', membershipComplete: false })
    expect(signal.result).toBe('refused-identity')
    expect(f.calls.slice(before)).toEqual([])
    f.record('missing-initial-identity', { observation, signal })
  })

  test('complete empty inventory stays sampled until the adapter seals', () => {
    const f = fixture()
    f.stats.delete(leaderPid)
    f.names([])
    const absent = f.group.observe()
    expect(absent).toMatchObject({ scopePresence: 'absent', membershipComplete: true })
    f.member('D')
    const later = f.group.observe()
    expect(later.scopePresence).toBe('living')
    f.record('complete-empty-inventory-not-sticky', { absent, later })
  })

  test('zombie-only observation is not sticky; adapter seal disarms all subsequent numeric access', () => {
    const f = fixture()
    f.member('Z', errno('ENOENT'))
    const zombies = f.group.observe()
    expect(zombies.scopePresence).toBe('zombie-only')
    f.member('D')
    const living = f.group.observe()
    expect(living.scopePresence).toBe('living')
    f.member('Z', errno('ENOENT'))
    const reconciled = f.group.observe()
    expect(reconciled).toMatchObject({ scopePresence: 'zombie-only', membershipComplete: true, identity: 'verified' })
    // This trusted adapter call represents separately observed direct-child
    // reap. The Linux driver cannot establish the runtime's child wait itself.
    f.group.seal()
    f.stats.set(leaderPid, stat(leaderPid, 'S', '999'))
    f.namespaces.set(leaderPid, 'pid:[replacement]')
    const before = f.calls.length
    const sealed = f.group.observe()
    const signal = f.group.signal('SIGKILL')
    expect(sealed).toMatchObject({ scopePresence: 'absent', members: [], membershipComplete: true, identity: 'verified' })
    expect(signal.result).toBe('already-absent')
    expect(f.calls.slice(before)).toEqual([])
    expect(f.signals).toEqual([])
    f.record('adapter-sealed-extinction', { zombies, living, reconciled, sealed, signal })
  })
})
