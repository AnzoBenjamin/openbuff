import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { captureRootDeadline } from '@codebuff/common/util/execution-context'
import * as hosts from '../host-execution'
import { loadHostConfigSnapshot, nodeConfigReadFs } from '../host-config'
import { ExecutionRefusalError } from '../services/execution-launch'
import { NotGitRepositoryError, resolveWorkspaceIdentity } from '../services/repository-identity'
import { resolveBootstrapWorkspaceIdentity } from '../services/workspace-bootstrap'
import { WorkspaceJournalService } from '../services/workspace-journal'
import { WorkspaceMutationBroker } from '../services/workspace-mutation-broker'

import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import type { ProfileRequest, Result } from '@codebuff/common/types/contracts/execution-context'
import type { HostConfigurationInputs } from '../host-config'

const roots: string[] = []
const stops: AbortController[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop.abort(new Error('Workspace bootstrap test closed'))
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
const value = <T>(result: Result<T>): T => { if (!result.ok) throw new Error(result.cause); return result.value }

function fixture(options: { git?: boolean; script?: string; profile?: ProfileRequest } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-bootstrap-')); roots.push(root)
  const cwd = path.join(root, 'workspace'), stateDir = path.join(root, 'state')
  fs.mkdirSync(cwd); fs.mkdirSync(stateDir)
  const env: Record<string, string> = { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }
  if (options.git) {
    const initialized = spawnSync('/usr/bin/git', ['init', '--quiet', cwd], { env, encoding: 'utf8' })
    if (initialized.status !== 0) throw new Error(initialized.stderr)
  }
  if (options.script) {
    const bin = path.join(root, 'bin'); fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\n' + options.script, { mode: 0o755 })
    env.PATH = `${bin}:/usr/bin:/bin`
  }
  const inputs: HostConfigurationInputs = { environment: env, platform: 'linux', invocationCwd: cwd, projectRoot: cwd,
    home: { kind: 'none' }, globals: { kind: 'disabled' }, selection: { kind: 'none' }, trust: { ancestorConfig: false, projectReadableRoots: false } }
  const snapshot = loadHostConfigSnapshot({ inputs, fs: nodeConfigReadFs })
  if (snapshot.status !== 'complete') throw new Error(snapshot.cause)
  const stop = new AbortController(); stops.push(stop)
  const clock = { domainId: `workspace-bootstrap:${root}`, nowMs: () => performance.now() }
  let launches = 0
  const launch: CodebuffSpawn = (command, argv, options) => { launches++; return spawn(command, [...argv ?? []], options ?? {}) }
  const host = value(hosts.createHostExecutionServices({ snapshot: snapshot.snapshot,
    boundary: value(captureRootDeadline({ clock, limit: { kind: 'unbounded' } })), clock, signal: stop.signal,
    childInheritanceEnvironment: env, profile: options.profile, spawn: launch }))
  return { root, cwd, stateDir, inputs, host, launches: () => launches }
}

describe('B19 typed workspace bootstrap provenance', () => {
  test('observed non-Git failure alone produces filesystem identity in both persistence services', async () => {
    const f = fixture()
    const error = await resolveWorkspaceIdentity({ cwd: f.cwd, executionContext: f.host.bootstrap }).then(() => undefined, error => error)
    expect(error).toBeInstanceOf(NotGitRepositoryError)
    const identity = await resolveBootstrapWorkspaceIdentity({ cwd: f.cwd, executionContext: f.host.bootstrap })
    const journal = await WorkspaceJournalService.create({ cwd: f.cwd, rootDir: f.stateDir, executionContext: f.host.bootstrap })
    const broker = await WorkspaceMutationBroker.create({ cwd: f.cwd, stateDir: f.stateDir, executionContext: f.host.bootstrap })
    expect(identity.identitySource).toBe('filesystem-not-git')
    expect(journal.identitySource).toBe(identity.identitySource)
    expect(broker.identitySource).toBe(identity.identitySource)
    expect(journal.repositoryId).toBe(identity.repositoryId)
    expect(broker.repositoryId).toBe(identity.repositoryId)
    expect(f.host.events.filter(event => event.phase === 'spawn-observed')).toHaveLength(8)
  })

  test('legacy broker/journal capture one direct host before awaits and retain explicit Git IDs', async () => {
    const f = fixture({ git: true })
    const explicit = await resolveBootstrapWorkspaceIdentity({ cwd: f.cwd, executionContext: f.host.bootstrap })
    const original = hosts.createDirectHostExecution
    const capture = spyOn(hosts, 'createDirectHostExecution').mockImplementation(options =>
      original({ ...options, hostConfiguration: f.inputs, configReadFs: nodeConfigReadFs }))
    try {
      const brokerOptions = { cwd: f.cwd, stateDir: f.stateDir }
      const brokerPending = WorkspaceMutationBroker.create(brokerOptions)
      expect(capture).toHaveBeenCalledTimes(1)
      brokerOptions.cwd = path.join(f.root, 'late-invalid-cwd')
      const broker = await brokerPending
      const journalPending = WorkspaceJournalService.create({ cwd: f.cwd, rootDir: f.stateDir })
      expect(capture).toHaveBeenCalledTimes(2)
      const journal = await journalPending
      expect(capture).toHaveBeenCalledTimes(2)
      expect(explicit.identitySource).toBe('git-observed')
      for (const observed of [broker, journal]) {
        expect(observed.identitySource).toBe('git-observed')
        expect(observed.repositoryId).toBe(explicit.repositoryId)
        expect(observed.workspaceId).toBe(explicit.workspaceId)
      }
    } finally { capture.mockRestore() }
  }, 10_000)

  test.each([
    ['generic failure', 'printf "fatal: generic Git failure\\n" >&2\nexit 1\n', 'generic Git failure'],
    ['permission failure', 'printf "fatal: permission denied opening repository\\n" >&2\nexit 128\n', 'permission denied'],
    ['empty success', 'exit 0\n', 'identity response is empty'],
    ['mixed not-Git and permission', 'case "$*" in *--show-toplevel*) printf "fatal: not a git repository\\n" >&2;; *) printf "fatal: permission denied\\n" >&2;; esac\nexit 128\n', 'not a git repository'],
  ])('%s cannot become a filesystem identity', async (_name, script, message) => {
    const f = fixture({ script })
    for (const operation of [
      () => resolveBootstrapWorkspaceIdentity({ cwd: f.cwd, executionContext: f.host.bootstrap }),
      () => WorkspaceJournalService.create({ cwd: f.cwd, rootDir: f.stateDir, executionContext: f.host.bootstrap }),
      () => WorkspaceMutationBroker.create({ cwd: f.cwd, stateDir: f.stateDir, executionContext: f.host.bootstrap }),
    ]) {
      const error = await operation().then(() => undefined, error => error)
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(NotGitRepositoryError)
      expect(error.message).toContain(message)
    }
    expect(f.host.events.filter(event => event.phase === 'spawn-observed')).toHaveLength(6)
  })

  test('an unavailable required backend stays a typed refusal across identity, broker and journal', async () => {
    const f = fixture({ profile: { policy: 'workspace-write', preferredBackend: 'native-exec', required: ['exact-env'], allowBackendFallback: false } })
    for (const operation of [
      () => resolveBootstrapWorkspaceIdentity({ cwd: f.cwd, executionContext: f.host.bootstrap }),
      () => WorkspaceJournalService.create({ cwd: f.cwd, rootDir: f.stateDir, executionContext: f.host.bootstrap }),
      () => WorkspaceMutationBroker.create({ cwd: f.cwd, stateDir: f.stateDir, executionContext: f.host.bootstrap }),
    ]) expect(await operation().then(() => undefined, error => error)).toBeInstanceOf(ExecutionRefusalError)
    expect(f.launches()).toBe(0)
    expect(f.host.events.some(event => event.phase === 'dispatched')).toBe(false)
    expect(fs.readdirSync(f.stateDir)).toEqual([])
  })
})
