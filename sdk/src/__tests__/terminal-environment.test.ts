import { authenticatedHostFixture } from './authenticated-host-fixture'
import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { getBackgroundJob, killBackgroundJob } from '../tools/background-jobs'
import { checkJob } from '../tools/check-job'
import { runTerminalCommand } from '../tools/run-terminal-command'

test('replacement environments hide controller variables in real sync and background commands', async () => {
  const name = 'OPENBUFF_TEST_CONTROLLER_SENTINEL'
  const previous = process.env[name]
  const root = mkdtempSync(path.join(tmpdir(), 'openbuff-terminal-env-'))
  const home = path.join(root, 'home')
  mkdirSync(home)
  process.env[name] = 'controller-only'
  const owner = {
    clientSessionId: 'env-fixture',
    rootRunId: 'env-run',
    parentRunId: 'env-run',
    parentAgentId: 'env-agent',
  }
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: home,
    OPENBUFF_TEST_SELECTED_VALUE: 'selected',
  }
  const command =
    'printf "%s|%s|%s" "$OPENBUFF_TEST_CONTROLLER_SENTINEL" "$OPENBUFF_TEST_SELECTED_VALUE" "$HOME"'
  const jobs: string[] = []
  const capturedEnvironment = { ...env, [name]: 'controller-only' }
  const inheritedHost = authenticatedHostFixture(root, { environment: capturedEnvironment, env })
  const replacementHost = authenticatedHostFixture(root, { environment: capturedEnvironment, env, inheritEnv: false })
  try {
    const inherited = await runTerminalCommand({
      command,
      process_type: 'SYNC',
      cwd: root,
      projectRoot: root,
      timeout_seconds: 5,
      env,
      owner,
      executionContext: inheritedHost.context,
      terminalShell: inheritedHost.host.terminalShell,
    })
    expect(inherited[0].value).toMatchObject({
      exitCode: 0,
      stdout: `controller-only|selected|${home}`,
    })
    const replacement = await runTerminalCommand({
      command,
      process_type: 'SYNC',
      cwd: root,
      projectRoot: root,
      timeout_seconds: 5,
      env,
      inheritEnv: false,
      owner,
      executionContext: replacementHost.context,
      terminalShell: replacementHost.host.terminalShell,
    })
    expect(replacement[0].value).toMatchObject({
      exitCode: 0,
      stdout: `|selected|${home}`,
    })
    const background = await runTerminalCommand({
      command,
      process_type: 'BACKGROUND',
      cwd: root,
      projectRoot: root,
      timeout_seconds: 5,
      env,
      inheritEnv: false,
      owner,
      executionContext: replacementHost.context,
      terminalShell: replacementHost.host.terminalShell,
    })
    const jobId = (background[0].value as { jobId: string }).jobId
    expect(jobId).toBeString()
    jobs.push(jobId)
    const job = getBackgroundJob(jobId)!
    if (job.status === 'running')
      await new Promise<void>((resolve) =>
        job.child.once('close', () => resolve()),
      )
    const observed = await checkJob({
      jobId,
      owner,
      wait_for: '.*',
      timeout_seconds: 1,
    })
    expect(JSON.stringify(observed)).toContain(`|selected|${home}`)
    expect(JSON.stringify(observed)).not.toContain('controller-only')
    expect(process.env[name]).toBe('controller-only')
  } finally {
    for (const jobId of jobs) killBackgroundJob(jobId, 'SIGKILL')
    inheritedHost.close()
    replacementHost.close()
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
    rmSync(root, { recursive: true, force: true })
  }
})
