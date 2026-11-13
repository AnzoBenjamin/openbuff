import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'
import { runTerminalCommand } from '../tools/run-terminal-command'
import { getBackgroundJob, killBackgroundJob, pruneSettledJobs } from '../tools/background-jobs'
import { createTerminalExecutionFixture, createRealExecutionProcessRecorder } from './fixtures/b19-terminal-execution'
import type { CleanupResult } from '@codebuff/common/types/contracts/process-scope'

const node = Bun.which('node')
if (!node) throw new Error('Real B20 scope tests require Node')
const treeFixture = path.resolve(import.meta.dir, '../../../scripts/body-fixtures/b20-process-tree.mjs')
const evidence = process.env.B20_ROOT_EVIDENCE_DIR
async function waitFor(predicate: () => boolean, timeout = 2_000) {
  const until = performance.now() + timeout
  while (!predicate() && performance.now() < until) await Bun.sleep(5)
  if (!predicate()) throw new Error('B20 fixture did not reach its declared ready/cleanup state')
}
describe.skipIf(process.platform !== 'linux')('real cooperative SDK process scope cleanup', () => {
  test.each(['normal', 'deadline', 'owner-cancel', 'inherited-pipe', 'leader-exit', 'quota'])(
    'SYNC %s joins observed scope cleanup before returning', async mode => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b20-sync-scope-'))
      const abort = new AbortController()
      const recorder = createRealExecutionProcessRecorder()
      const host = createTerminalExecutionFixture({ projectRoot: directory, signal: abort.signal, spawn: recorder.spawn })
      const before = performance.now()
      let cleanup: CleanupResult | undefined
      try {
        const command = `exec ${JSON.stringify(node)} ${JSON.stringify(treeFixture)} ${JSON.stringify(directory)} ${JSON.stringify(mode)}`
        const pending = runTerminalCommand({ command, process_type: 'SYNC', cwd: directory, projectRoot: directory,
          timeout_seconds: mode === 'deadline' ? 0.25 : -1, executionContext: host.context,
          terminalShell: { executable: '/bin/bash', args: ['-c'] }, getTerminalLaunchMetadata: host.getTerminalLaunchMetadata })
        if (mode === 'owner-cancel' || mode === 'inherited-pipe') {
          await waitFor(() => fs.existsSync(path.join(directory, 'descendant.json')))
          abort.abort(new Error('B20 cancel after real descendant ready'))
        }
        const output = (await pending)[0].value as { stdout?: string; stderr?: string; processCleanup?: CleanupResult; timedOut?: boolean }
        cleanup = output.processCleanup
        expect(cleanup).toBeDefined()
        expect(cleanup?.status).toBe('complete')
        expect(cleanup?.selectedTier).toBe('posix-owned-group')
        expect(cleanup?.finalObservation.leader).toBe('exited-reaped')
        expect(cleanup?.finalObservation.membershipComplete).toBe(true)
        expect(cleanup?.finalObservation.members.some(member => member.disposition === 'living')).toBe(false)
        expect(cleanup?.cleanupAuthorityRetained).toBe(false)
        if (mode === 'normal') {
          expect(output.stdout).toBe('last stdout é✅')
          expect(output.stderr).toBe('last stderr é✅')
        } else if (mode === 'deadline') {
          expect(output.timedOut).toBe(true)
          expect(performance.now() - before).toBeLessThan(1_650)
        } else if (mode === 'quota') {
          expect(cleanup?.output.retainedBytes).toBeLessThanOrEqual(10 * 1024 * 1024)
          expect(cleanup?.output.droppedBytes).toBeGreaterThan(0)
          expect(cleanup?.output.complete).toBe(false)
        }
        await Bun.sleep(700)
        const lateMarker = fs.existsSync(path.join(directory, 'late-marker'))
        const receipt = { mode, elapsedMs: performance.now() - before, cleanup, output,
          leader: fs.existsSync(path.join(directory, 'leader.json')) ? JSON.parse(fs.readFileSync(path.join(directory, 'leader.json'), 'utf8')) : null,
          descendant: fs.existsSync(path.join(directory, 'descendant.json')) ? JSON.parse(fs.readFileSync(path.join(directory, 'descendant.json'), 'utf8')) : null,
          lateMarker, oracleBeforeTeardown: true }
        if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, `sync-${mode}.json`), JSON.stringify(receipt, null, 2)) }
        expect(lateMarker).toBe(false)
      } finally {
        // Captured after the oracle; teardown never supplies acceptance credit.
        for (const call of recorder.calls) if (call.child.pid && call.options.detached) {
          try { process.kill(-call.child.pid, 'SIGKILL') } catch { /* already absent */ }
        }
        host.dispose(); fs.rmSync(directory, { recursive: true, force: true })
      }
    }, 10_000,
  )
  test.each(['owner-cancel', 'leader-exit', 'quota'])('BACKGROUND %s retains management until cleanup', async mode => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'b20-background-scope-'))
    const abort = new AbortController()
    const recorder = createRealExecutionProcessRecorder()
    const host = createTerminalExecutionFixture({ projectRoot: directory, signal: abort.signal, spawn: recorder.spawn })
    let jobId: string | undefined
    try {
      const output = await runTerminalCommand({
        command: `exec ${JSON.stringify(node)} ${JSON.stringify(treeFixture)} ${JSON.stringify(directory)} ${JSON.stringify(mode)}`,
        process_type: 'BACKGROUND', cwd: directory, projectRoot: directory, timeout_seconds: -1,
        executionContext: host.context, terminalShell: { executable: '/bin/bash', args: ['-c'] }, getTerminalLaunchMetadata: host.getTerminalLaunchMetadata,
      })
      jobId = (output[0].value as { jobId: string }).jobId
      if (mode === 'owner-cancel') {
        await waitFor(() => fs.existsSync(path.join(directory, 'descendant.json')))
        abort.abort(new Error('B20 background cancel'))
        await Bun.sleep(20)
        expect(getBackgroundJob(jobId)?.status).toBe('stopping')
        pruneSettledJobs(Date.now() + 24 * 60 * 60 * 1_000)
        expect(getBackgroundJob(jobId)).toBeDefined()
        expect(killBackgroundJob(jobId, 'SIGKILL')).toMatchObject({ killed: true })
      }
      await waitFor(() => getBackgroundJob(jobId!)?.processCleanup?.status === 'complete')
      const job = getBackgroundJob(jobId)!
      expect(job.processCleanup?.finalObservation.members.some(member => member.disposition === 'living')).toBe(false)
      expect(fs.statSync(job.logFile).size).toBeLessThanOrEqual(10 * 1024 * 1024)
      if (mode === 'quota') expect(job.failureReason).toContain('quota')
      await Bun.sleep(700)
      const lateMarker = fs.existsSync(path.join(directory, 'late-marker'))
      if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, `background-${mode}.json`),
        JSON.stringify({ mode, cleanup: job.processCleanup, status: job.status, failureReason: job.failureReason, lateMarker, oracleBeforeTeardown: true }, null, 2)) }
      expect(lateMarker).toBe(false)
    } finally {
      if (jobId) killBackgroundJob(jobId, 'SIGKILL')
      for (const call of recorder.calls) if (call.child.pid && call.options.detached) {
        try { process.kill(-call.child.pid, 'SIGKILL') } catch { /* teardown only */ }
      }
      host.dispose(); fs.rmSync(directory, { recursive: true, force: true })
    }
  }, 10_000)
})
