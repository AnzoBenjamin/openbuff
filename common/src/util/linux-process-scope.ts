import { readFileSync, readdirSync, readlinkSync } from 'node:fs'

import type { ProcessIdentity, ScopeObservation, SignalObservation } from '../types/contracts/process-scope'

/** Trusted host DI seam. Injected observations do not establish OS proof. */
export type LinuxProcessScopeDependencies = Readonly<{
  readStat(pid: number): string
  readNamespace(pid: number): string
  listPids(): readonly string[]
  kill(pid: number, signal: 0 | 'SIGTERM' | 'SIGKILL'): void
}>
const linuxProcessScopeDependencies: LinuxProcessScopeDependencies = {
  readStat: pid => readFileSync(`/proc/${pid}/stat`, 'utf8'),
  readNamespace: pid => readlinkSync(`/proc/${pid}/ns/pid`),
  listPids: () => readdirSync('/proc'),
  kill: (pid, signal) => { process.kill(pid, signal) },
}

/** Linux stat's comm field may itself contain spaces and closing parentheses. */
export function parseProcStat(text: string): { identity: Omit<ProcessIdentity, 'pidNamespace'>; state: string } {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  const pid = Number(text.slice(0, open).trim())
  const fields = text.slice(close + 1).trim().split(/\s+/)
  const pgid = Number(fields[2])
  const sid = Number(fields[3])
  const startTime = fields[19]
  if (open < 0 || close <= open || !Number.isSafeInteger(pid) || pid <= 0 ||
    !Number.isSafeInteger(pgid) || pgid < 0 || !Number.isSafeInteger(sid) || sid < 0 ||
    !startTime || !/^\d+$/.test(startTime) || fields[0]?.length !== 1) throw new Error('Malformed Linux process stat')
  return { identity: { pid, pgid, sid, startTime }, state: fields[0] }
}
function gone(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT' || (error as NodeJS.ErrnoException)?.code === 'ESRCH'
}
export function readLinuxProcessIdentity(pid: number, dependencies = linuxProcessScopeDependencies): ProcessIdentity {
  return { ...parseProcStat(dependencies.readStat(pid)).identity,
    pidNamespace: dependencies.readNamespace(pid) }
}

/**
 * A captured cooperative group, not an atomic kernel handle. Identity checks
 * refuse observed recycling; the check-to-signal race and setsid escapes remain.
 * This module imports no runtime-specific process handle, so Bun can consume it.
 */
export function captureLinuxProcessGroup(pid: number, dependencies = linuxProcessScopeDependencies) {
  let captured: ProcessIdentity | undefined
  try { captured = readLinuxProcessIdentity(pid, dependencies) } catch { /* unknown is not authority */ }
  const valid = !!captured && captured.pgid === pid && captured.sid === pid
  let extinct = false
  const observe = (): Pick<ScopeObservation, 'scopePresence' | 'members' | 'membershipComplete' | 'identity'> => {
    if (!valid || !captured) return { scopePresence: 'unknown', members: [], membershipComplete: false, identity: 'unknown' }
    if (extinct) return { scopePresence: 'absent', members: [], membershipComplete: true, identity: 'verified' }
    const members: ScopeObservation['members'][number][] = []
    let complete = true
    try {
      try {
        // Known stat replacement must win even if the following namespace
        // read disappears or is denied. Do not discard a mismatch with it.
        const current = parseProcStat(dependencies.readStat(pid)).identity
        if (current.pid !== captured.pid || current.startTime !== captured.startTime || current.pgid !== captured.pgid ||
          current.sid !== captured.sid) {
          return { scopePresence: 'unknown', members: [], membershipComplete: false, identity: 'mismatch' }
        }
        if (dependencies.readNamespace(pid) !== captured.pidNamespace) {
          return { scopePresence: 'unknown', members: [], membershipComplete: false, identity: 'mismatch' }
        }
      } catch (error) { if (!gone(error)) complete = false }
      try { dependencies.kill(-pid, 0) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          return { scopePresence: 'absent', members: [], membershipComplete: true, identity: 'verified' }
        }
        return { scopePresence: 'unknown', members: [], membershipComplete: false, identity: 'verified' }
      }
      const names = dependencies.listPids().filter(name => /^\d+$/.test(name))
      if (names.length > 16_384) complete = false
      for (const name of names.slice(0, 16_384)) {
        try {
          const process = parseProcStat(dependencies.readStat(Number(name)))
          if (process.identity.pgid !== captured.pgid || process.identity.sid !== captured.sid) continue
          // Linux removes namespace symlinks for zombies. Preserve that member
          // as a zombie with unavailable namespace, rather than skipping it as
          // if it disappeared. Its state establishes no living work.
          let namespace: string | null
          try { namespace = dependencies.readNamespace(Number(name)) }
          catch (error) {
            if ((process.state === 'Z' || process.state === 'X' || process.state === 'x') && gone(error)) namespace = null
            else throw error
          }
          if (namespace !== null && namespace !== captured.pidNamespace) continue
          const disposition = process.state === 'Z' ? 'zombie' : process.state === 'X' || process.state === 'x' ? 'exited'
            : 'RSDTtWIP'.includes(process.state) ? 'living' : 'unknown'
          if (members.length >= 1_024) { complete = false; continue }
          members.push({ identity: { ...process.identity, pidNamespace: namespace }, state: process.state, disposition })
        } catch {
          // A listed process that loses stat or its required living namespace
          // was not reconciled. Racing disappearance cannot certify an empty
          // inventory; the zombie/dead namespace exception is handled above.
          complete = false
        }
      }
    } catch { complete = false }
    const living = members.some(member => member.disposition === 'living')
    const unknown = members.some(member => member.disposition === 'unknown')
    const scopePresence = living ? 'living' : !complete || unknown ? 'unknown' : members.length ? 'zombie-only' : 'absent'
    // Extinction is sticky only after actual direct-child wait plus complete
    // reconciliation is confirmed by the adapter (seal()).
    return { scopePresence, members, membershipComplete: complete, identity: 'verified' }
  }
  const signal = (name: 'SIGTERM' | 'SIGKILL'): Omit<SignalObservation, 'atMs'> => {
    const base = { signal: name, targetTier: 'posix-owned-group' as const }
    const observation = observe()
    if (observation.identity !== 'verified') return { ...base, result: 'refused-identity' }
    if (extinct) return { ...base, result: 'already-absent' }
    // Even a complete empty inventory is sampled; kill(0) separately validates
    // absence, and errors other than ESRCH cannot become cleanup evidence.
    try { dependencies.kill(-pid, name); return { ...base, result: 'delivered' } }
    catch (error) {
      const errorCode = (error as NodeJS.ErrnoException).code
      return { ...base, result: errorCode === 'ESRCH' ? 'already-absent' : 'unknown', ...(errorCode ? { errorCode } : {}) }
    }
  }
  return { identity: captured ?? null, observe, signal,
    /** Adapter-only: call after actual leader reap and complete zero-living reconciliation. */
    seal: () => { extinct = true } }
}
