import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, spyOn } from 'bun:test'

import { jobRegistry } from '@codebuff/common/util/job-registry'
import { getOwnedTempRoots } from '@codebuff/common/util/project-path-containment'

import {
  __clearJobsForTest,
  getBackgroundJob,
  killBackgroundJob,
  startBackgroundJob,
} from '../tools/background-jobs'
import {
  __getStagedDiffRetainedStatsKeysForTest,
  __getStagedDiffScanStatsForTest,
  __parseStagedDiffHeaderForTest,
  __resetStagedDiffScanStatsForTest,
  findWindowsBash,
  listDirtyPaths,
  runTerminalCommand,
} from '../tools/run-terminal-command'
import {
  createControlledExecutionClock,
  createExecutionProcessRecorder,
  createRealExecutionProcessRecorder,
  createTerminalExecutionFixture,
  executionValue,
} from './fixtures/b19-terminal-execution'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import { executionLimitSeconds } from '../services/execution-launch'

const executionHosts: ReturnType<typeof createTerminalExecutionFixture>[] = []
const fixtureTempRoot = os.tmpdir()
afterEach(() => { for (const host of executionHosts.splice(0)) host.dispose() })

function runMediatedTerminal(
  params: Parameters<typeof runTerminalCommand>[0],
  options: Parameters<typeof createTerminalExecutionFixture>[0] = {},
) {
  const host = createTerminalExecutionFixture({
    projectRoot: params.projectRoot ?? process.cwd(),
    scratchRoot: fixtureTempRoot,
    allowedPaths: params.allowed_paths,
    policy: params.permission_profile ?? 'workspace-write',
    mode: params.mode ?? 'assistant',
    signal: params.signal,
    owner: params.owner,
    inheritEnv: params.inheritEnv,
    ...(params.detach ? { transferLimit: executionValue(executionLimitSeconds(params.timeout_seconds)) } : {}),
    ...options,
  })
  executionHosts.push(host)
  return runTerminalCommand({
    ...params,
    executionContext: host.context,
    terminalShell: { executable: '/bin/bash', args: ['-c'] },
    getTerminalLaunchMetadata: host.getTerminalLaunchMetadata,
    ...(params.detach ? { prepareTransferredLaunch: host.prepareTransferredLaunch } : {}),
  })
}

describe('Windows bash prerequisite', () => {
  it('honors the Openbuff-specific Git Bash override', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-bash-'))
    const bashPath = path.join(dir, 'bash.exe')
    fs.writeFileSync(bashPath, '')
    try {
      expect(findWindowsBash({ OPENBUFF_GIT_BASH_PATH: bashPath })).toBe(
        bashPath,
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('B19 terminal termination mediation', () => {
  it.each(['deadline-exhausted', 'cancelled'] as const)('%s uses one physical termination schedule', async reason => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'b19-terminal-termination-'))
    const manual = createControlledExecutionClock()
    const abort = new AbortController()
    const processes = createExecutionProcessRecorder({ autoClose: false, closeOnKill: false })
    const spawn: CodebuffSpawn = (executable, argv, options) => {
      const child = processes.spawn(executable, argv, options)
      const actual = processes.calls.find(call => call.child === child)!
      if (executable === 'git') queueMicrotask(() => actual.finish())
      return child
    }
    const host = createTerminalExecutionFixture({
      ...manual, projectRoot: cwd, spawn, signal: abort.signal,
      actionLimit: { kind: 'finite', durationMs: 100 },
    })
    executionHosts.push(host)
    try {
      const pending = runTerminalCommand({
        command: 'printf started; sleep 30', process_type: 'SYNC', cwd, projectRoot: cwd,
        timeout_seconds: reason === 'deadline-exhausted' ? 0.05 : -1,
        executionContext: host.context, terminalShell: { executable: '/bin/bash', args: ['-c'] },
        getTerminalLaunchMetadata: host.getTerminalLaunchMetadata,
      })
      for (let turn = 0; !processes.calls.some(call => call.executable === '/bin/bash') && turn < 50; turn++) {
        await new Promise(resolve => setImmediate(resolve))
      }
      const actual = processes.calls.find(call => call.executable === '/bin/bash')!
      expect(actual).toBeDefined()
      actual.child.stdout?.emit('data', Buffer.from('started'))
      if (reason === 'deadline-exhausted') manual.advance(50)
      else abort.abort(new Error('terminal requester cancelled'))
      expect(actual.signals).toEqual([reason === 'deadline-exhausted' ? 'SIGKILL' : 'SIGTERM'])
      actual.finish(undefined, reason === 'deadline-exhausted' ? 'SIGKILL' : 'SIGTERM')
      const output = await pending
      expect(output[0].value).toMatchObject({ executionRefusal: { reason } })
      if (reason === 'deadline-exhausted') expect(output[0].value).toMatchObject({ timedOut: true, stdout: 'started' })
      await new Promise(resolve => setTimeout(resolve, 60))
      expect(actual.signals).toHaveLength(1)
    } finally {
      for (const actual of processes.calls) actual.finish()
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it.each([false, true])('terminal.legacy-dirty captures real Git with explicit overlay %s', async overlay => {
    const cwd = initTempGitRepo('b19-direct-dirty-')
    const processes = createRealExecutionProcessRecorder()
    const host = createTerminalExecutionFixture({
      projectRoot: cwd, policy: 'read-only', spawn: processes.spawn,
      actionLimit: { kind: 'finite', durationMs: 10_000 },
    })
    executionHosts.push(host)
    try {
      fs.writeFileSync(path.join(cwd, 'changed.ts'), 'fixture\n')
      const env = overlay ? { PROJECT_VALUE: 'explicit-dirty-overlay', OPENAI_API_KEY: 'reinsert-attempt' } : undefined
      expect(await listDirtyPaths(cwd, undefined, env, host.context)).toEqual(new Set(['changed.ts']))
      expect(processes.calls).toHaveLength(1)
      const actual = processes.calls[0]
      expect(actual.spawnObserved).toBe(true)
      expect(actual.argv).toEqual(['--no-pager', '--no-optional-locks', '--no-lazy-fetch', '-c', 'core.fsmonitor=false',
        'status', '--porcelain', '-uall'])
      expect(actual.options.env?.PROJECT_VALUE).toBe(overlay ? 'explicit-dirty-overlay' : 'captured-value')
      expect(actual.options.env?.OPENAI_API_KEY).toBeUndefined()
      expect(actual.options.env?.CUSTOM_PROVIDER_KEY).toBeUndefined()
      expect(host.policyInputs[0].facts.branchId).toBe('terminal.legacy-dirty')
      await expect(listDirtyPaths(cwd, undefined, env)).rejects.toMatchObject({ refusal: { reason: 'unavailable' } })
      expect(processes.calls).toHaveLength(1)
    } finally { fs.rmSync(cwd, { recursive: true, force: true }) }
  })
})

describe('runTerminalCommand cwd containment', () => {
  it('stages the exact quoted-space path only when that path is allowed', async () => {
    const projectRoot = initTempGitRepo('openbuff-exact-stage-path-')
    try {
      fs.writeFileSync(path.join(projectRoot, 'a b.txt'), 'one space\n')
      fs.writeFileSync(path.join(projectRoot, 'a  b.txt'), 'two spaces\n')
      const input = {
        command: 'git add "a  b.txt"',
        process_type: 'SYNC' as const,
        permission_profile: 'git-commit' as const,
        cwd: projectRoot,
        projectRoot,
        timeout_seconds: 5,
      }
      const denied = await runMediatedTerminal({
        ...input,
        allowed_paths: ['a b.txt'],
      })
      expect(denied[0].value).toMatchObject({ permissionDenied: true })
      expect(
        spawnSync('git', ['diff', '--cached', '--name-only', '-z'], {
          cwd: projectRoot,
          encoding: 'utf8',
        }).stdout,
      ).toBe('')
      const allowed = await runMediatedTerminal({
        ...input,
        allowed_paths: ['a  b.txt'],
      })
      expect(allowed[0].value).toMatchObject({ exitCode: 0 })
      expect(
        spawnSync('git', ['diff', '--cached', '--name-only', '-z'], {
          cwd: projectRoot,
          encoding: 'utf8',
        }).stdout,
      ).toBe('a  b.txt\0')
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it('requires captured host mediation despite public pre-approval metadata', async () => {
    let legacyCalls = 0
    const result = await runTerminalCommand({
      command: 'git push -u origin feature/safe', process_type: 'SYNC',
      mode: 'assistant', permission_profile: 'git-commit',
      cwd: process.cwd(), projectRoot: process.cwd(), timeout_seconds: 5,
      preApprovedAction: { action: 'push', target: 'origin/feature/safe', commandHash: 'f'.repeat(64), approvalReceiptId: 'fabricated-v1' },
      authorizeHighImpactAction: async () => { legacyCalls++; return { allowed: true } },
    })
    expect(result[0].value).toMatchObject({ executionRefusal: { reason: 'unavailable' } })
    expect(legacyCalls).toBe(0)
  })

  it('uses the real frozen classifier for a denied captured target', async () => {
    let effect: string | undefined
    const result = await runMediatedTerminal({
      command: 'git push -u origin feature/safe', process_type: 'SYNC',
      mode: 'assistant', permission_profile: 'git-commit',
      cwd: process.cwd(), projectRoot: process.cwd(), timeout_seconds: 5,
    }, { authorize: input => {
      effect = input.classification.effects[0]?.action
      expect(Object.isFrozen(input.classification.effects)).toBe(true)
      return { ok: false, reason: 'denied', cause: 'Controlled host policy denied this target' }
    } })
    expect(effect).toBe('push')
    expect(result[0].value).toMatchObject({ permissionDenied: true, executionRefusal: { reason: 'denied' } })
    expect(executionHosts.at(-1)!.events.some(event => event.phase === 'dispatched')).toBe(false)
  })

  it('ignores matching v1 metadata and legacy callbacks when live host policy denies', async () => {
    let legacyCalls = 0
    const result = await runMediatedTerminal({
      command: 'git push origin feature-x', process_type: 'SYNC',
      mode: 'assistant', permission_profile: 'git-commit',
      cwd: process.cwd(), projectRoot: process.cwd(), timeout_seconds: 5,
      preApprovedAction: { action: 'push', target: 'origin/feature-x', commandHash: 'a'.repeat(64), approvalReceiptId: 'public-receipt' },
      authorizeHighImpactAction: async () => { legacyCalls++; return { allowed: true } },
    }, { authorize: () => ({ ok: false, reason: 'denied', cause: 'No live captured authority' }) })
    expect(legacyCalls).toBe(0)
    expect(result[0].value).toMatchObject({ executionRefusal: { reason: 'denied' } })
    expect(result[0].value).not.toHaveProperty('approvalReceiptId')
  })

  it('keeps the captured read-only permission profile enforced', async () => {
    const result = await runMediatedTerminal({
      command: 'git push origin main', process_type: 'SYNC',
      mode: 'assistant', permission_profile: 'read-only',
      cwd: process.cwd(), projectRoot: process.cwd(), timeout_seconds: 5,
    })
    expect(result[0].value).toMatchObject({ permissionDenied: true, permissionProfile: 'read-only', executionRefusal: { reason: 'denied' } })
    expect(executionHosts.at(-1)!.policyInputs).toHaveLength(0)
  })

  it('retains cancellation during captured policy admission with zero dispatch', async () => {
    const controller = new AbortController()
    const result = await runMediatedTerminal({
      command: 'git push --force origin feature', process_type: 'SYNC',
      permission_profile: 'full-access', cwd: process.cwd(), projectRoot: process.cwd(),
      timeout_seconds: 5, signal: controller.signal,
    }, { authorize: () => {
      controller.abort(new Error('cancelled during captured policy'))
      return { ok: false, reason: 'denied', cause: 'Late denial' }
    } })
    expect(result[0].value).toMatchObject({ executionRefusal: { reason: 'cancelled' } })
    expect(executionHosts.at(-1)!.events.some(event => event.phase === 'dispatched')).toBe(false)
  })

  it('dispatches a captured high-impact target once and exposes its same v2 binding', async () => {
    const projectRoot = initTempGitRepo('terminal-host-admission-')
    let terminalDecisions = 0
    let bindingDigest: string | undefined
    try {
      const result = await runMediatedTerminal({
        command: 'git push origin feature-x', process_type: 'SYNC',
        mode: 'assistant', permission_profile: 'git-commit', cwd: projectRoot,
        projectRoot, timeout_seconds: 15,
      }, { authorize: input => {
        if (input.facts.branchId === 'terminal.sync') {
          terminalDecisions++
          bindingDigest = input.bindingDigest
          expect(input.binding.format).toBe('openbuff.execution.v2')
          expect(input.classification.effects[0]?.action).toBe('push')
        }
        return { ok: true, basis: 'explicit-policy', decisionId: 'controlled-fixture-policy' }
      } })
      expect(terminalDecisions).toBe(1)
      expect(result[0].value).toMatchObject({ harnessAction: 'push', harnessTarget: 'origin/feature-x', executionBindingVersion: 2, executionBindingDigest: bindingDigest })
      expect(executionHosts.at(-1)!.events.filter(event => event.phase === 'dispatched' && event.facts.branchId === 'terminal.sync')).toHaveLength(1)
      // The fixture policy does not certify B18 stored-approval behavior.
      expect(result[0].value).not.toHaveProperty('approvalReceiptId')
    } finally { fs.rmSync(projectRoot, { recursive: true, force: true }) }
  })

  it('returns a structured timeout result with partial output', async () => {
    const projectRoot = initTempGitRepo('terminal-partial-timeout-')
    try {
      const result = await runMediatedTerminal({
        command: 'printf started; sleep 30',
        process_type: 'SYNC',
        cwd: projectRoot,
        projectRoot,
        timeout_seconds: 0.3,
      })
      const value = result[0].value as {
        timedOut?: boolean
        errorMessage?: string
        stdout?: string
      }

      expect(value.timedOut).toBe(true)
      expect(value.errorMessage).toContain('deadline exhausted')
      expect(value.stdout).toContain('started')
    } finally { fs.rmSync(projectRoot, { recursive: true, force: true }) }
  })

  it('cancels an owned background job when the request aborts', async () => {
    const controller = new AbortController()
    const owner = {
      clientSessionId: 'session-1',
      rootRunId: 'root-1',
      parentRunId: 'parent-1',
      parentAgentId: 'agent-1',
    }
    let value: { jobId?: string; detached?: boolean } | undefined
    try {
      const result = await runMediatedTerminal({
        command: 'sleep 30',
        process_type: 'BACKGROUND',
        cwd: process.cwd(),
        projectRoot: process.cwd(),
        timeout_seconds: 5,
        signal: controller.signal,
        owner,
      })
      value = result[0].value as { jobId?: string; detached?: boolean }
      expect(value.detached).toBe(false)
      expect(value.jobId).toBeDefined()

      const runningJob = getBackgroundJob(value.jobId!)
      expect(runningJob?.owner).toEqual(owner)
      expect(
        JSON.parse(fs.readFileSync(runningJob!.metadataFile, 'utf8')).owner,
      ).toEqual(owner)

      controller.abort()
      // SIGTERM delivery folds 'stopping' (M2-T4, Fix 3); the real child's
      // exit event then settles 'stopped'. Give the process a moment to exit.
      let job = getBackgroundJob(value.jobId!)
      for (let i = 0; i < 200 && job?.status === 'stopping'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        job = getBackgroundJob(value.jobId!)
      }
      // An abort-initiated kill is an intentional stop, recorded as 'stopped'
      // (distinct from an error/non-zero natural exit) once the exit event
      // lands; possibly still 'stopping' for a slow-to-die child.
      expect(job?.status === 'stopped' || job?.status === 'stopping').toBe(true)
    } finally {
      if (value?.jobId !== undefined) {
        killBackgroundJob(value.jobId, 'SIGKILL')
      }
    }
  })

  it('terminates a background job that exceeds the bounded log quota', async () => {
    const projectRoot = initTempGitRepo('terminal-background-quota-')
    let value: { jobId?: string } | undefined
    try {
      const result = await runMediatedTerminal({
        command: 'yes x | head -c 12000000; sleep 30',
        process_type: 'BACKGROUND',
        cwd: projectRoot,
        projectRoot,
        timeout_seconds: 5,
      })
      value = result[0].value as { jobId?: string }
      expect(value.jobId).toBeDefined()

      const deadline = Date.now() + 5_000
      let job = getBackgroundJob(value.jobId!)
      while (job?.status === 'running' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
        job = getBackgroundJob(value.jobId!)
      }

      expect(job?.status).toBe('error')
      expect(fs.statSync(job!.logFile).size).toBeLessThanOrEqual(
        10 * 1024 * 1024,
      )
    } finally {
      if (value?.jobId !== undefined) {
        killBackgroundJob(value.jobId, 'SIGKILL')
      }
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it('accepts the project root itself as cwd', async () => {
    const result = await runMediatedTerminal({
      command: 'pwd',
      process_type: 'SYNC',
      cwd: process.cwd(),
      projectRoot: process.cwd(),
      timeout_seconds: 5,
    })
    const value = result[0].value as { errorMessage?: string; stdout?: string }
    expect(value.errorMessage).toBeUndefined()
    expect(value.stdout).toContain(process.cwd())
  })

  it('rejects an absolute cwd outside the project with a structured error', async () => {
    const result = await runMediatedTerminal({
      command: 'echo hello',
      process_type: 'SYNC',
      cwd: '/etc',
      timeout_seconds: 5,
    })
    const value = result[0].value as { errorMessage?: string; command?: string }
    expect(value.errorMessage).toContain('Invalid cwd')
    expect(value.errorMessage).toContain('/etc')
    expect(value.errorMessage).toContain('outside the project directory')
  })

  it('rejects a parent-traversal cwd with a structured error', async () => {
    const result = await runMediatedTerminal({
      command: 'echo hello',
      process_type: 'SYNC',
      cwd: '../../outside',
      timeout_seconds: 5,
    })
    const value = result[0].value as { errorMessage?: string }
    expect(value.errorMessage).toContain('Invalid cwd')
    expect(value.errorMessage).toContain('outside the project directory')
  })

  it('rejects a BACKGROUND process whose cwd escapes the project', async () => {
    const result = await runMediatedTerminal({
      command: 'echo hello',
      process_type: 'BACKGROUND',
      cwd: '/etc',
      timeout_seconds: 5,
    })
    const value = result[0].value as { errorMessage?: string }
    expect(value.errorMessage).toContain('Invalid cwd')
    expect(value.errorMessage).toContain('outside the project directory')
  })

  it('rejects a BACKGROUND process whose cwd escapes the explicit project root', async () => {
    const result = await runMediatedTerminal({
      command: 'echo hello',
      process_type: 'BACKGROUND',
      cwd: '/etc',
      projectRoot: process.cwd(),
      timeout_seconds: 5,
    })
    const value = result[0].value as { errorMessage?: string }
    expect(value.errorMessage).toContain('Invalid cwd')
    expect(value.errorMessage).toContain('outside the project directory')
  })

  it('rejects an openbuff-owned temp directory as cwd without running the command', async () => {
    // The owned-temp exception lets tools READ openbuff's own artifacts; it
    // must never host a child process. `resolvedCwd.scope === 'owned-temp'`
    // is what refuses this, so the directory is created for real (an existing
    // path that a bad implementation could actually spawn in).
    const ownedTempDir = fs.mkdtempSync(
      path.join(getOwnedTempRoots()[0], 'openbuff-terminal-cwd-'),
    )
    const sentinel = path.join(ownedTempDir, 'executed.txt')
    try {
      const result = await runMediatedTerminal({
        command: `printf executed > '${sentinel}'`,
        process_type: 'SYNC',
        cwd: ownedTempDir,
        projectRoot: process.cwd(),
        timeout_seconds: 5,
      })
      const value = result[0].value as {
        errorMessage?: string
        stdout?: string
        exitCode?: number
      }

      expect(value.errorMessage).toContain('outside the project directory')
      // Nothing ran: no captured output, no exit code, no side effect on disk.
      expect(value.stdout).toBeUndefined()
      expect(value.exitCode).toBeUndefined()
      expect(fs.existsSync(sentinel)).toBe(false)
    } finally {
      fs.rmSync(ownedTempDir, { recursive: true, force: true })
    }
  })

  it('preserves the command field in the error result for debugging', async () => {
    const result = await runMediatedTerminal({
      command: 'rm -rf /',
      process_type: 'SYNC',
      cwd: '/etc',
      timeout_seconds: 5,
    })
    const value = result[0].value as { errorMessage?: string; command?: string }
    expect(value.command).toBe('rm -rf /')
  })

  it('runs inside the dereferenced target of an in-project cwd symlink', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-root-'))
    try {
      const realDirectory = path.join(projectRoot, 'real')
      fs.mkdirSync(realDirectory)
      fs.symlinkSync(realDirectory, path.join(projectRoot, 'link'))

      const result = await runMediatedTerminal({
        command: 'pwd -P',
        process_type: 'SYNC',
        cwd: 'link',
        projectRoot,
        timeout_seconds: 5,
      })
      const value = result[0].value as {
        errorMessage?: string
        stdout?: string
      }

      expect(value.errorMessage).toBeUndefined()
      expect(value.stdout?.trim()).toBe(fs.realpathSync(realDirectory))
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it('rejects a cwd symlink that resolves outside the project root', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-root-'))
    const outsideRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'terminal-outside-'),
    )
    try {
      fs.symlinkSync(outsideRoot, path.join(projectRoot, 'escape'))

      const result = await runMediatedTerminal({
        command: 'pwd',
        process_type: 'SYNC',
        cwd: 'escape',
        projectRoot,
        timeout_seconds: 5,
      })
      const value = result[0].value as { errorMessage?: string }

      expect(value.errorMessage).toContain('outside the project directory')
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
      fs.rmSync(outsideRoot, { recursive: true, force: true })
    }
  })
})

describe('captured terminal and background execution', () => {
  it('launches Bash with the exact captured scrubbed child environment', async () => {
    const result = await runMediatedTerminal({
      command: 'printf "%s|%s|%s" "$PROJECT_VALUE" "${OPENAI_API_KEY-unset}" "${CUSTOM_PROVIDER_KEY-unset}"',
      process_type: 'SYNC', permission_profile: 'full-access',
      cwd: process.cwd(), projectRoot: process.cwd(), timeout_seconds: 5,
      env: { PROJECT_VALUE: 'explicit-overlay', OPENAI_API_KEY: 'fixture-reinsertion' },
    })
    expect(result[0].value).toMatchObject({ exitCode: 0, stdout: 'explicit-overlay|unset|unset' })
    expect(result[0].value).toHaveProperty('executionBindingVersion', 2)
    const host = executionHosts.at(-1)!
    expect(host.events.some(event => event.phase === 'spawn-observed' && event.facts.branchId === 'terminal.sync')).toBe(true)
    expect(JSON.stringify(host.events)).not.toContain('fixture-reinsertion')
  })

  it('background jobs keep execution handles in memory and write only descriptive metadata', async () => {
    const result = await runMediatedTerminal({
      command: 'printf "%s" "$PROJECT_VALUE"; sleep 0.05', process_type: 'BACKGROUND',
      permission_profile: 'full-access', cwd: process.cwd(), projectRoot: process.cwd(), timeout_seconds: 5,
    })
    const value = result[0].value as { jobId?: string; processId?: number }
    expect(value.processId).toBeGreaterThan(0)
    const job = getBackgroundJob(value.jobId!)!
    try {
      expect(job.nodeLaunch?.input.env.PROJECT_VALUE).toBe('captured-value')
      expect(job.executionContext).toBeDefined()
      for (let tries = 0; job.status === 'running' && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 10))
      expect(fs.readFileSync(job.logFile, 'utf8')).toBe('captured-value')
      const metadata = JSON.parse(fs.readFileSync(job.metadataFile, 'utf8'))
      expect(metadata).not.toHaveProperty('executionContext')
      expect(metadata).not.toHaveProperty('nodeLaunch')
      expect(metadata).not.toHaveProperty('env')
    } finally { killBackgroundJob(job.jobId, 'SIGKILL') }
  })

  it('refuses detached execution when the host supplies no authenticated transfer', async () => {
    const host = createTerminalExecutionFixture({ projectRoot: process.cwd() })
    executionHosts.push(host)
    const result = await runTerminalCommand({
      command: 'sleep 30', process_type: 'BACKGROUND', detach: true,
      cwd: process.cwd(), projectRoot: process.cwd(), timeout_seconds: 1,
      executionContext: host.context,
    })
    expect(result[0].value).toMatchObject({ executionRefusal: { reason: 'unavailable' } })
    expect(host.events.some(event => event.phase === 'dispatched')).toBe(false)
  })

  it.each([0.3, -1])('a transferred background job retains a finite originating cap for local limit %s', async localLimit => {
    const abort = new AbortController()
    const projectRoot = initTempGitRepo('terminal-transferred-limit-')
    let jobId: string | undefined
    try {
      const result = await runMediatedTerminal({
        command: 'sleep 30', process_type: 'BACKGROUND', detach: true,
        cwd: projectRoot, projectRoot, timeout_seconds: localLimit, signal: abort.signal,
      }, { actionLimit: { kind: 'finite', durationMs: 400 } })
      const value = result[0].value as { jobId?: string; detached?: boolean }
      jobId = value.jobId
      expect(value.detached).toBe(true)
      const job = getBackgroundJob(value.jobId!)!
      expect(job.nodeLaunch!.input.resourceRemainingMs).toBeGreaterThan(0)
      expect(job.nodeLaunch!.input.resourceRemainingMs).toBeLessThanOrEqual(localLimit === -1 ? 400 : 300)
      expect(job.nodeLaunch!.facts().deadlines.resourceLifetime.kind).toBe('finite')
      abort.abort(new Error('original requester stopped waiting'))
      await new Promise(resolve => setTimeout(resolve, 15))
      expect(job.nodeLaunch!.input.resourceSignal.aborted).toBe(false)
      for (let tries = 0; !job.nodeLaunch!.resourceRefusal() && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 10))
      expect(job.nodeLaunch!.resourceRefusal()).toMatchObject({ reason: 'deadline-exhausted' })
      expect(executionHosts.at(-1)!.events.filter(event => event.phase === 'resource-transferred')).toHaveLength(1)
      // These controls observe B19 transfer/cap behavior; B20 owns death and cleanup proof.
    } finally {
      if (jobId) killBackgroundJob(jobId, 'SIGKILL')
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})

describe('runTerminalCommand staged-commit safety preflight', () => {
  // Mirrors GIT_SAFETY_SCAN_SLICE_CHARS in run-terminal-command.ts: one drain
  // tick scans at most this many characters of the staged patch, so a
  // multi-megabyte diff cannot monopolise a render frame.
  const STAGED_SCAN_SLICE_LIMIT_CHARS = 64 * 1024

  // The preflight stages-to-commit checks are async now (they used spawnSync),
  // so these tests drive the real git repo path end to end: each case proves
  // the safety verdict still matches the previous synchronous behavior.
  async function runApprovedCommit(projectRoot: string, command: string) {
    return runMediatedTerminal({
      command,
      process_type: 'SYNC',
      mode: 'assistant',
      permission_profile: 'git-commit',
      cwd: projectRoot,
      projectRoot,
      timeout_seconds: 15,
      // The fixture supplies one explicit host decision for this captured
      // commit; the same admitted launch reaches the staged-diff preflight.
    })
  }

  function stageFile(projectRoot: string, name: string, content: string): void {
    fs.writeFileSync(path.join(projectRoot, name), content)
    const added = spawnSync('git', ['add', name], {
      cwd: projectRoot,
      encoding: 'utf8',
    })
    expect(added.status).toBe(0)
  }

  it('blocks a commit whose staged diff fails whitespace checks', async () => {
    const projectRoot = initTempGitRepo('terminal-staged-whitespace-')
    try {
      stageFile(projectRoot, 'dirty.txt', 'trailing   \n')

      const result = await runApprovedCommit(
        projectRoot,
        'git commit -m "Add dirty file"',
      )
      const value = result[0].value as {
        errorMessage?: string
        permissionDenied?: boolean
      }

      expect(value.permissionDenied).toBe(true)
      expect(value.errorMessage).toContain(
        'Commit blocked by staged-diff safety policy',
      )
      expect(value.errorMessage).toContain(
        'staged diff failed whitespace checks',
      )
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it('blocks a commit that stages a sensitive file name', async () => {
    const projectRoot = initTempGitRepo('terminal-staged-secret-name-')
    try {
      stageFile(projectRoot, '.env', 'SECRET=1\n')

      const result = await runApprovedCommit(
        projectRoot,
        'git commit -m "Add environment file"',
      )
      const value = result[0].value as { errorMessage?: string }

      expect(value.errorMessage).toContain('sensitive file is staged: .env')
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it('blocks a commit whose staged content holds private-key material', async () => {
    const projectRoot = initTempGitRepo('terminal-staged-secret-content-')
    try {
      stageFile(projectRoot, 'notes.txt', '-----BEGIN RSA PRIVATE KEY-----\n')

      const result = await runApprovedCommit(
        projectRoot,
        'git commit -m "Add notes"',
      )
      const value = result[0].value as { errorMessage?: string }

      expect(value.errorMessage).toContain(
        'private-key or access-key material appears in the staged diff',
      )
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it('blocks a rename whose new staged name is sensitive', async () => {
    // The staged file list is derived from the -U0 diff's `diff --git a/<old>
    // b/<new>` headers, so both sides of a rename have to be checked: here only
    // the NEW name is sensitive, which a one-sided parse would miss.
    const projectRoot = initTempGitRepo('terminal-staged-rename-')
    try {
      fs.writeFileSync(path.join(projectRoot, 'notes.txt'), 'plain notes\n')
      expect(
        spawnSync('git', ['add', 'notes.txt'], { cwd: projectRoot }).status,
      ).toBe(0)
      expect(
        spawnSync('git', ['commit', '-m', 'add notes'], { cwd: projectRoot })
          .status,
      ).toBe(0)
      expect(
        spawnSync('git', ['mv', 'notes.txt', 'id_rsa'], { cwd: projectRoot })
          .status,
      ).toBe(0)

      const result = await runApprovedCommit(
        projectRoot,
        'git commit -m "Rename notes"',
      )
      const value = result[0].value as { errorMessage?: string }

      expect(value.errorMessage).toContain('sensitive file is staged: id_rsa')
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it('scans a large staged patch in bounded slices rather than one pass', async () => {
    // The scanner must not decode and regex the whole patch inside the stdout
    // `data` handler: up to GIT_SAFETY_OUTPUT_LIMIT of patch arrives through
    // back-to-back chunk callbacks on the same event loop the TUI renders on.
    // This ~216 KiB patch is drained by the preflight's own loop instead, so it
    // costs several bounded slices — a single-pass scan lands entirely in one
    // render frame and fails both assertions.
    const projectRoot = initTempGitRepo('terminal-staged-large-')
    try {
      stageFile(
        projectRoot,
        'large.txt',
        'sensitive-scan-filler-line-........\n'.repeat(6_000),
      )
      __resetStagedDiffScanStatsForTest()

      const result = await runApprovedCommit(
        projectRoot,
        'git commit -m "Add large file"',
      )
      const value = result[0].value as {
        errorMessage?: string
        exitCode?: number
      }

      // The scan still reaches the same verdict, and the commit is not blocked.
      expect(value.errorMessage).toBeUndefined()
      expect(value.exitCode).toBe(0)

      const stats = __getStagedDiffScanStatsForTest()
      expect(stats.slices).toBeGreaterThan(1)
      // One line may straddle a slice boundary, so the bound is the slice limit
      // plus at most one line — still far below the whole patch.
      expect(stats.maxSliceChars).toBeLessThanOrEqual(
        STAGED_SCAN_SLICE_LIMIT_CHARS * 2,
      )
      // ...and NO byte was decoded inside the stdout `data` handler: every
      // parked byte was decoded by the drain loop instead. A per-chunk
      // `chunk.toString('utf8')` in `enqueue` kept both slice assertions above
      // green while moving the whole decode into render frames.
      expect(stats.enqueueDecodedBytes).toBe(0)
      expect(stats.drainDecodedBytes).toBeGreaterThan(0)

      // The retained ring entry is a DETACHED counter snapshot: it must carry
      // only the primitive counters, never the scanner-scoped stats object whose
      // closure reaches the parked patch bytes. A shared object would leave the
      // up-to-GIT_SAFETY_OUTPUT_LIMIT parked patch reachable after the commit
      // preflight that owned it has completed.
      const retainedKeys = __getStagedDiffRetainedStatsKeysForTest()
      expect(retainedKeys.length).toBeGreaterThan(0)
      for (const keys of retainedKeys) {
        expect(keys).toEqual([
          'drainDecodedBytes',
          'maxSliceChars',
          'parkedBytes',
          'retainedNames',
          'slices',
        ])
      }
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it('bounds the staged-name table and fails closed instead of clearing an uninspectable diff', async () => {
    // The scanner retains a bounded PREFIX of the staged names rather than one
    // entry per `diff --git` header, so a monorepo-sized commit cannot grow the
    // preflight's retained state with the patch. Past the cap the diff can no
    // longer be fully inspected, so it must be reported as an inspection failure
    // — never cleared as if every staged path had been checked.
    const projectRoot = initTempGitRepo('terminal-staged-name-cap-')
    try {
      const stagedCount = 4_100
      for (let index = 0; index < stagedCount; index += 1) {
        fs.writeFileSync(
          path.join(projectRoot, `bulk-${index}.txt`),
          'bulk line\n',
        )
      }
      expect(spawnSync('git', ['add', '.'], { cwd: projectRoot }).status).toBe(
        0,
      )
      __resetStagedDiffScanStatsForTest()

      const result = await runApprovedCommit(
        projectRoot,
        'git commit -m "Add bulk files"',
      )
      const value = result[0].value as {
        errorMessage?: string
        permissionDenied?: boolean
        safetyPreflightFailed?: boolean
        exitCode?: number
      }

      // Fail closed, but on the INABILITY field: the commit was not inspected to
      // completion, which is not a policy denial.
      expect(value.exitCode).not.toBe(0)
      expect(value.permissionDenied).toBeUndefined()
      expect(value.safetyPreflightFailed).toBe(true)
      expect(value.errorMessage).toContain(
        'Commit safety preflight could not inspect the staged diff',
      )

      // The retained state is the cap, not the staged path count.
      const stats = __getStagedDiffScanStatsForTest()
      expect(stats.maxRetainedNames).toBe(4_096)
      expect(stats.maxRetainedNames).toBeLessThan(stagedCount)
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it('reassembles a multi-byte code point split across chunk boundaries', async () => {
    // Decoding per chunk turned a multi-byte sequence straddling two chunks into
    // two U+FFFD replacement characters, so a sensitive name split across a
    // chunk boundary slipped past the pattern match entirely. The scanner must
    // decode with a stateful StringDecoder instead: the header line here is
    // emitted in two halves that split the `é` of `résumé`, and the sensitive
    // path must still be recognised. `core.quotePath=false` is set explicitly
    // so this raw-UTF-8 form is what the test gets regardless of the machine's
    // or CI runner's gitconfig — the C-quoted form has its own test below.
    const projectRoot = initTempGitRepo('terminal-staged-split-chunk-')
    try {
      spawnSync('git', ['config', 'core.quotePath', 'false'], {
        cwd: projectRoot,
        encoding: 'utf8',
      })
      stageFile(projectRoot, 'résumé.pem', 'placeholder\n')

      __resetStagedDiffScanStatsForTest()
      const result = await runApprovedCommit(
        projectRoot,
        'git commit -m "Add resume file"',
      )
      const value = result[0].value as { errorMessage?: string }

      // The non-ASCII path is still a sensitive file name, so the commit is
      // blocked — which is only possible if the bytes were decoded whole.
      expect(value.errorMessage).toContain('sensitive file is staged')
      expect(value.errorMessage).toContain('résumé.pem')
      const stats = __getStagedDiffScanStatsForTest()
      expect(stats.enqueueDecodedBytes).toBe(0)
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it('catches a sensitive non-ASCII path in a C-quoted diff header', async () => {
    // The DEFAULT git configuration (`core.quotePath=true`, what CI runners and
    // stock git use) C-quotes a non-ASCII path in a diff header with octal
    // escapes: `résumé.pem` arrives as `"a/r\303\251sum\303\251.pem"`. A parser
    // that does not strip the quotes AND unescape the octal bytes never sees
    // the decoded path, so the sensitive-name check silently skipped it — this
    // test is the regression guard for that bypass. The repo-local config pins
    // the form regardless of the machine's gitconfig.
    const projectRoot = initTempGitRepo('terminal-staged-cquoted-')
    try {
      spawnSync('git', ['config', 'core.quotePath', 'true'], {
        cwd: projectRoot,
        encoding: 'utf8',
      })
      fs.mkdirSync(path.join(projectRoot, 'café'), { recursive: true })
      stageFile(projectRoot, 'café/.env', 'SECRET=1\n')

      __resetStagedDiffScanStatsForTest()
      const result = await runApprovedCommit(
        projectRoot,
        'git commit -m "Add cafe env"',
      )
      const value = result[0].value as { errorMessage?: string }

      expect(value.errorMessage).toContain('sensitive file is staged')
      expect(value.errorMessage).toContain('café/.env')
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it('parses quoted headers, renames with embedded separators, and fails closed on malformed quotes', () => {
    // Pure-parser pins for the forms the spawn-driven tests above cannot
    // fabricate: the C-quoted pair, octal reassembly of UTF-8, an escaped
    // separator inside a path, and the fail-closed verdicts for a quoted
    // header that cannot be decoded (its path is never checked, so the
    // PREFLIGHT must report an inspection failure, not skip it).
    expect(
      __parseStagedDiffHeaderForTest(
        'diff --git "a/r\\303\\251sum\\303\\251.pem" "b/r\\303\\251sum\\303\\251.pem"',
      ),
    ).toEqual({
      names: ['résumé.pem', 'résumé.pem'],
    })
    // Both sides of a rename, quoted, with the escaped-quote and the
    // `" "b/`-shaped separator inside the OLD path.
    expect(
      __parseStagedDiffHeaderForTest(
        'diff --git "a/x \\"b/y.txt" "b/renamed.txt"',
      ),
    ).toEqual({ names: ['x "b/y.txt', 'renamed.txt'] })
    // Raw form with a ` b/ ` inside the path still splits on the last one.
    expect(__parseStagedDiffHeaderForTest('diff --git a/x b/y b/z')).toEqual({
      names: ['x b/y', 'z'],
    })
    // Not a header at all.
    expect(
      __parseStagedDiffHeaderForTest('index 123..456 100644'),
    ).toBeUndefined()
    // Header-shaped but undecodable: unterminated quote, unknown escape.
    expect(
      __parseStagedDiffHeaderForTest('diff --git "a/x.txt "b/y.txt"'),
    ).toEqual({ unparsable: true })
    expect(
      __parseStagedDiffHeaderForTest('diff --git "a/x\\q.txt" "b/y.txt"'),
    ).toEqual({ unparsable: true })
  })

  it('runs a clean staged commit without a safety block', async () => {
    const projectRoot = initTempGitRepo('terminal-staged-clean-')
    try {
      stageFile(projectRoot, 'clean.txt', 'clean line\n')

      const result = await runApprovedCommit(
        projectRoot,
        'git commit -m "Add clean file"',
      )
      const value = result[0].value as {
        errorMessage?: string
        exitCode?: number
        permissionDenied?: boolean
      }

      expect(value.errorMessage).toBeUndefined()
      expect(value.permissionDenied).toBeUndefined()
      expect(value.exitCode).toBe(0)
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})

function initTempGitRepo(prefix: string): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const run = (args: string[]) =>
    spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' })
  expect(run(['init']).status).toBe(0)
  run(['config', 'user.email', 'test@example.com'])
  run(['config', 'user.name', 'Test'])
  // Optional initial commit keeps porcelain stable across git versions.
  fs.writeFileSync(path.join(projectRoot, 'README'), 'seed\n')
  run(['add', 'README'])
  run(['commit', '-m', 'seed'])
  return projectRoot
}

describe('runTerminalCommand SYNC dirty-delta touchedPaths', () => {
  it('reports newly created project files in touchedPaths', async () => {
    const projectRoot = initTempGitRepo('terminal-dirty-')
    try {
      // Pre-existing dirt must not appear in the delta.
      fs.writeFileSync(path.join(projectRoot, 'already-dirty.txt'), 'old\n')

      const result = await runMediatedTerminal({
        command: 'printf new > created-by-sync.txt',
        process_type: 'SYNC',
        cwd: projectRoot,
        projectRoot,
        timeout_seconds: 10,
      })
      const value = result[0].value as {
        errorMessage?: string
        touchedPaths?: string[]
        exitCode?: number
      }

      expect(value.errorMessage).toBeUndefined()
      expect(value.touchedPaths).toContain('created-by-sync.txt')
      expect(value.touchedPaths).not.toContain('already-dirty.txt')
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it('attributes paths relative to projectRoot when cwd is a subdirectory', async () => {
    const projectRoot = initTempGitRepo('terminal-dirty-')
    try {
      const sub = path.join(projectRoot, 'pkg')
      fs.mkdirSync(sub)

      const result = await runMediatedTerminal({
        command: 'printf nested > from-sub.txt',
        process_type: 'SYNC',
        cwd: 'pkg',
        projectRoot,
        timeout_seconds: 10,
      })
      const value = result[0].value as {
        errorMessage?: string
        touchedPaths?: string[]
      }

      expect(value.errorMessage).toBeUndefined()
      expect(value.touchedPaths).toContain('pkg/from-sub.txt')
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it('omits touchedPaths when the project is not a git repo', async () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'terminal-nongit-'),
    )
    try {
      const result = await runMediatedTerminal({
        command: 'printf x > bare.txt',
        process_type: 'SYNC',
        cwd: projectRoot,
        projectRoot,
        timeout_seconds: 10,
      })
      const value = result[0].value as {
        errorMessage?: string
        touchedPaths?: string[]
      }

      expect(value.errorMessage).toBeUndefined()
      expect(value.touchedPaths).toBeUndefined()
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})

describe('runTerminalCommand BACKGROUND dirty snapshot at start', () => {
  it('stores pre-start dirty snapshot on the job without emitting touchedPaths', async () => {
    const projectRoot = initTempGitRepo('terminal-bg-dirty-')
    let value:
      | {
          jobId?: string
          touchedPaths?: string[]
          backgroundProcessStatus?: string
        }
      | undefined
    try {
      fs.writeFileSync(path.join(projectRoot, 'already-dirty.txt'), 'old\n')

      const result = await runMediatedTerminal({
        command: 'printf new > created-by-bg.txt; sleep 30',
        process_type: 'BACKGROUND',
        cwd: projectRoot,
        projectRoot,
        timeout_seconds: 5,
      })
      value = result[0].value as {
        jobId?: string
        touchedPaths?: string[]
        backgroundProcessStatus?: string
      }

      expect(value.jobId).toBeDefined()
      expect(value.backgroundProcessStatus).toBe('running')
      // Start must never credit settlement dirt.
      expect(value.touchedPaths).toBeUndefined()

      const job = getBackgroundJob(value.jobId!)
      expect(job?.projectRoot).toBe(projectRoot)
      expect(job?.dirtyBeforePaths).toContain('already-dirty.txt')
      expect(job?.dirtyBeforePaths).not.toContain('created-by-bg.txt')
      expect(job?.settlementTouchedPaths).toBeUndefined()
    } finally {
      if (value?.jobId !== undefined) {
        killBackgroundJob(value.jobId, 'SIGKILL')
      }
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it('omits dirtyBeforePaths when the project is not a git repo', async () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'terminal-bg-nongit-'),
    )
    let value: { jobId?: string; touchedPaths?: string[] } | undefined
    try {
      const result = await runMediatedTerminal({
        command: 'sleep 30',
        process_type: 'BACKGROUND',
        cwd: projectRoot,
        projectRoot,
        timeout_seconds: 5,
      })
      value = result[0].value as {
        jobId?: string
        touchedPaths?: string[]
      }
      expect(value.jobId).toBeDefined()
      expect(value.touchedPaths).toBeUndefined()

      const job = getBackgroundJob(value.jobId!)
      expect(job?.projectRoot).toBe(projectRoot)
      expect(job?.dirtyBeforePaths).toBeUndefined()
    } finally {
      if (value?.jobId !== undefined) {
        killBackgroundJob(value.jobId, 'SIGKILL')
      }
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})

describe('runTerminalCommand BACKGROUND abort window around job start', () => {
  it('never starts a job when the run aborts during the dirty-snapshot await', async () => {
    // The pre-spawn guard runs BEFORE `await listDirtyPaths`, which folds
    // every rejection - including the abort reason - into a null snapshot.
    // Aborting inside that await window must still be observed: the post-await
    // re-check throws so no job is ever registered, where the unguarded code
    // spawned an owned `sleep 30` the cancelled run could no longer cancel.
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'terminal-bg-abort-'),
    )
    const owner = {
      clientSessionId: 'session-bg-abort-window',
      rootRunId: 'root-bg-abort-window',
      parentRunId: 'parent-bg-abort-window',
      parentAgentId: 'agent-bg-abort-window',
    }
    const controller = new AbortController()
    try {
      // runTerminalCommand executes synchronously up to the dirty-snapshot
      // await, so an abort issued right after the call lands inside it.
      const pending = runMediatedTerminal({
        command: 'sleep 30',
        process_type: 'BACKGROUND',
        cwd: projectRoot,
        projectRoot,
        timeout_seconds: 5,
        signal: controller.signal,
        owner,
      })
      controller.abort()

      const result = await pending
      expect(result[0].value).toMatchObject({ executionRefusal: { reason: 'cancelled' } })
      // ...and the aborted run owns no background job at all.
      expect(jobRegistry.list(owner)).toHaveLength(0)
      expect(jobRegistry.listRunning(owner)).toHaveLength(0)
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it('refuses background dispatch when cancellation lands during job registration', async () => {
    // The kill listener is registered AFTER startBackgroundJob, so a signal
    // that aborts inside that synchronous window (here: during
    // jobRegistry.create) can never fire 'abort' on the signal: an
    // addEventListener registration on an already-aborted signal succeeds and
    // then silently never runs. The registration-time check must kill the
    // fresh job directly instead.
    const controller = new AbortController()
    const owner = {
      clientSessionId: 'session-bg-abort-window-listener',
      rootRunId: 'root-bg-abort-window-listener',
      parentRunId: 'parent-bg-abort-window-listener',
      parentAgentId: 'agent-bg-abort-window-listener',
    }
    const realCreate = jobRegistry.create.bind(jobRegistry)
    const spy = spyOn(jobRegistry, 'create').mockImplementation((opts) => {
      const record = realCreate(opts)
      // Land the abort exactly between job creation and the kill-listener
      // wiring, the window where a listener-only design leaks the job.
      controller.abort()
      return record
    })
    let value: { jobId?: string; detached?: boolean } | undefined
    try {
      const result = await runMediatedTerminal({
        command: 'sleep 30',
        process_type: 'BACKGROUND',
        cwd: process.cwd(),
        projectRoot: process.cwd(),
        timeout_seconds: 5,
        signal: controller.signal,
        owner,
      })
      value = result[0].value as { jobId?: string; detached?: boolean }
      expect(value.jobId).toBeUndefined()
      expect(result[0].value).toMatchObject({ executionRefusal: { reason: 'cancelled' } })
      expect(jobRegistry.listRunning(owner)).toHaveLength(0)
      expect(executionHosts.at(-1)!.events.some(event => event.phase === 'dispatched' && event.facts.branchId === 'background.attached')).toBe(false)
    } finally {
      spy.mockRestore()
      if (value?.jobId !== undefined) {
        killBackgroundJob(value.jobId, 'SIGKILL')
      }
    }
  })
})

describe('startBackgroundJob failed-spawn log file preservation', () => {
  const FORCED_ID = 'job-test-forced-eexist'
  const FOREIGN_CONTENT = 'foreign log data that must survive\n'
  let foreignLogFile: string | undefined
  let createSpy: { mockRestore(): void } | undefined

  afterEach(() => {
    createSpy?.mockRestore()
    createSpy = undefined
    if (foreignLogFile !== undefined) {
      fs.rmSync(foreignLogFile, { force: true })
      foreignLogFile = undefined
    }
    __clearJobsForTest()
  })

  it('preserves a pre-existing foreign log when creation hits EEXIST', () => {
    executionHosts.push(createTerminalExecutionFixture({ projectRoot: process.cwd(), scratchRoot: fixtureTempRoot }))
    foreignLogFile = path.join(os.tmpdir(), `openbuff-${FORCED_ID}.log`)
    fs.writeFileSync(foreignLogFile, FOREIGN_CONTENT)

    // Force the registry to allocate exactly the id whose log file already
    // exists, so safeCreateJobLogFile's O_EXCL create fails with EEXIST and
    // the catch block runs before spawn is ever reached.
    const realCreate = jobRegistry.create.bind(jobRegistry)
    const spy = spyOn(jobRegistry, 'create').mockImplementation((opts) => {
      realCreate({ ...opts, jobId: FORCED_ID })
      return jobRegistry.get(FORCED_ID)!
    })
    createSpy = spy

    try {
      expect(() =>
        startBackgroundJob({
          command: 'sleep 30',
          admittedLaunch: executionHosts.at(-1)!.admitBackground('sleep 30'),
          executionContext: executionHosts.at(-1)!.context,
          owner: {
            clientSessionId: 'session-eexist',
            rootRunId: 'root-eexist',
            parentRunId: 'parent-eexist',
            parentAgentId: 'agent-eexist',
          },
        }),
      ).toThrow()
    } finally {
      spy.mockRestore()
      createSpy = undefined
    }

    // The failed-spawn cleanup must not delete a pre-existing/foreign log
    // file this spawn never created (logFileCreatedByThisSpawn guard).
    expect(fs.existsSync(foreignLogFile)).toBe(true)
    expect(fs.readFileSync(foreignLogFile, 'utf8')).toBe(FOREIGN_CONTENT)
  })
})

describe('runTerminalCommand SYNC full-output persistence on truncation', () => {
  // The inline COMMAND_OUTPUT_LIMIT is 50_000 chars; outputs here stay under
  // the 2x STREAM_ACCUMULATION_CAP so the accumulated stream itself is never
  // mid-stream truncated and the persisted artifact holds the FULL output.
  const OVER_LIMIT_BYTES = 60_000

  it('omits fullLogPath when output fits under the inline limit', async () => {
    const result = await runMediatedTerminal({
      command: `printf ${JSON.stringify('a'.repeat(1000))}`,
      process_type: 'SYNC',
      cwd: process.cwd(),
      projectRoot: process.cwd(),
      timeout_seconds: 5,
    })
    const value = result[0].value as {
      errorMessage?: string
      stdout?: string
      fullLogPath?: string
      logBytes?: number
    }

    expect(value.errorMessage).toBeUndefined()
    expect(value.stdout?.length).toBe(1000)
    expect(value.fullLogPath).toBeUndefined()
    expect(value.logBytes).toBeUndefined()
  })

  it('recovers the middle of both streams beyond the old accumulation cap', async () => {
    const result = await runMediatedTerminal({
      command:
        "head -c 150000 /dev/zero | tr '\\0' A; printf '😀MIDDLE\\n'; head -c 150000 /dev/zero | tr '\\0' Z; head -c 160000 /dev/zero | tr '\\0' B >&2",
      process_type: 'SYNC',
      permission_profile: 'full-access',
      cwd: process.cwd(),
      projectRoot: process.cwd(),
      timeout_seconds: 10,
    })
    const value = result[0].value as {
      stdout?: string
      stderr?: string
      fullLogPath?: string
      logBytes?: number
    }
    expect(value.fullLogPath).toBeDefined()
    try {
      const bytes = fs.readFileSync(value.fullLogPath!)
      const full = JSON.parse(bytes.toString('utf8'))
      expect(full.stdout).toBe(
        'A'.repeat(150_000) + '😀MIDDLE\n' + 'Z'.repeat(150_000),
      )
      expect(full.stderr).toBe('B'.repeat(160_000))
      expect(value.logBytes).toBe(bytes.byteLength)
      expect(value.stdout!.length).toBeLessThan(60_000)
      expect(value.stderr!.length).toBeLessThan(60_000)
    } finally {
      fs.rmSync(path.dirname(value.fullLogPath!), {
        recursive: true,
        force: true,
      })
    }
  })

  it('reports unavailable full logs without returning a nonexistent path', async () => {
    if (process.platform === 'win32') return
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-log-failure-'))
    const blocker = path.join(root, 'not-a-directory')
    fs.writeFileSync(blocker, 'x')
    const previous = process.env.TMPDIR
    process.env.TMPDIR = blocker
    try {
      const result = await runMediatedTerminal({
        command: 'head -c 160000 /dev/zero',
        process_type: 'SYNC',
        permission_profile: 'full-access',
        cwd: process.cwd(),
        projectRoot: process.cwd(),
        timeout_seconds: 10,
      })
      expect(result[0].value).toMatchObject({ logPersisted: false })
      expect(result[0].value).not.toHaveProperty('fullLogPath')
      expect(result[0].value).toHaveProperty('logError')
    } finally {
      if (previous === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previous
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('persists the full untruncated output and returns a pointer when stdout exceeds the limit', async () => {
    // head -c + tr produce exactly OVER_LIMIT_BYTES of stdout deterministically.
    const result = await runMediatedTerminal({
      command: `yes a | tr -d '\\n' | head -c ${OVER_LIMIT_BYTES}`,
      process_type: 'SYNC',
      cwd: process.cwd(),
      projectRoot: process.cwd(),
      timeout_seconds: 5,
    })
    const value = result[0].value as {
      errorMessage?: string
      stdout?: string
      fullLogPath?: string
      logBytes?: number
    }

    expect(value.errorMessage).toBeUndefined()
    expect(value.fullLogPath).toBeDefined()
    expect(value.logBytes).toBeGreaterThan(0)
    try {
      const fullLogPath = value.fullLogPath!
      expect(fullLogPath).toContain('openbuff-command-output')
      const persisted = JSON.parse(fs.readFileSync(fullLogPath, 'utf8')) as {
        command?: string
        stdout?: string
      }
      // The artifact holds the FULL untruncated stdout, not the 50k inline slice.
      expect(persisted.stdout).toBe('a'.repeat(OVER_LIMIT_BYTES))
      expect(persisted.command).toBe(
        `yes a | tr -d '\\n' | head -c ${OVER_LIMIT_BYTES}`,
      )
      // The inline stdout meanwhile was truncated mid-stream.
      expect(value.stdout!.length).toBeLessThan(OVER_LIMIT_BYTES)
    } finally {
      if (value.fullLogPath !== undefined) {
        fs.rmSync(value.fullLogPath, { force: true })
      }
    }
  })

  it('treats an unreadable staged diff as an inspection failure, not a denial', async () => {
    // `git diff --cached -U0` is pointed at a NON-repository directory, so the
    // preflight cannot read any staged content. That is an inability to check,
    // not a policy verdict: reporting it as `permissionDenied` told a caller that
    // retries on transient failure not to retry, and surfaced an infrastructure
    // failure as an authorization decision.
    //
    // Two gates sit in front of the preflight, and the test has to clear both or
    // it asserts against the wrong denial:
    //  - the git-commit POLICY rejects placeholder messages ("no repo here"), so
    //    the command must carry a real imperative message;
    //  - `git commit` is a high-impact action, so mode:'assistant' routes it
    //    through the harness approval policy first. Approving it (as the other
    //    approved-commit helpers do) is what lets execution reach
    //    validateStagedCommit.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-safety-'))
    try {
      __resetStagedDiffScanStatsForTest()
      const result = await runMediatedTerminal({
        command: 'git commit -m "Add staged diff inspection failure handling"',
        process_type: 'SYNC',
        mode: 'assistant',
        permission_profile: 'git-commit',
        cwd: dir,
        projectRoot: dir,
        timeout_seconds: 10,
      })
      const value = result[0].value as {
        errorMessage?: string
        permissionDenied?: boolean
        safetyPreflightFailed?: boolean
      }

      // The commit is still refused (fail closed), but under the inspection
      // field: no `permissionDenied`, and the message says the diff could not be
      // inspected rather than that a policy forbade the command.
      expect(value.permissionDenied).toBeUndefined()
      expect(value.safetyPreflightFailed).toBe(true)
      expect(value.errorMessage).toContain(
        'Commit safety preflight could not inspect the staged diff',
      )
      expect(value.errorMessage).not.toContain('permission')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('includes the pointer on a truncated, timed-out command result', async () => {
    const result = await runMediatedTerminal({
      command: `yes a | tr -d '\\n' | head -c ${OVER_LIMIT_BYTES}; sleep 30`,
      process_type: 'SYNC',
      cwd: process.cwd(),
      projectRoot: process.cwd(),
      timeout_seconds: 2,
    })
    const value = result[0].value as {
      timedOut?: boolean
      fullLogPath?: string
      stdout?: string
    }

    expect(value.timedOut).toBe(true)
    expect(value.fullLogPath).toBeDefined()
    try {
      const persisted = JSON.parse(
        fs.readFileSync(value.fullLogPath!, 'utf8'),
      ) as { stdout?: string }
      expect(persisted.stdout).toBe('a'.repeat(OVER_LIMIT_BYTES))
    } finally {
      if (value.fullLogPath !== undefined) {
        fs.rmSync(value.fullLogPath, { force: true })
      }
    }
  })
})
