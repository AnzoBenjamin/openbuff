import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { runSupervisionSdkControl, supervisionControls } from './fixtures/b19-supervision-sdk-branch-controls'
import type { SupervisionControl } from './fixtures/b19-supervision-sdk-branch-controls'

describe('B19 sdk.supervision actual OpenbuffClient.run producer', () => {
  for (const branch of ['initial', 'retry'] as const) {
    const controls: readonly SupervisionControl[] = [...supervisionControls, 'exhausted-before-admission', 'failed-child-receipt',
      ...(branch === 'retry' ? ['exhausted-before-retry', 'retry-budget-exhausted'] as const : [])]
    for (const control of controls) {
      test(`supervised.source.${branch}: ${control}`, async () => {
        let capturedFixture: Awaited<ReturnType<typeof runSupervisionSdkControl>> | undefined
        let passed = false, assertionError: unknown
        try {
          const f = await runSupervisionSdkControl(branch, control)
          capturedFixture = f
          console.log('B19_SDK_SUPERVISION', JSON.stringify({ targetBranch: f.targetBranch, control, artifactDir: f.artifactDir }))
          expect(f.networkCalls).toBe(0)
          const facts = f.events.filter(event => 'facts' in event && event.facts.family === 'supervised-child')
          const target = f.boundaries.filter(boundary => boundary.branch === f.targetBranch)
          if (control === 'literal-zero') {
            // Literal scalar zero is rejected by run() before any host, action or
            // supervision factory exists. It cannot establish an earlier retry.
            expect(f.boundaries).toHaveLength(0)
            expect(f.attempts).toHaveLength(0)
            expect(f.factoryCalls).toHaveLength(0)
            expect(f.hostSnapshots).toHaveLength(0)
            expect(String(f.error) + JSON.stringify(f.error ?? f.result)).toMatch(/deadline|zero|exhaust/i)
            passed = true
            return
          }
          expect(f.hostSnapshots).toHaveLength(1)
          expect(f.factoryCalls).toHaveLength(1)
          expect(f.factoryCalls[0]).toMatchObject({ restart: { maxAttempts: 3 }, handlerKind: 'function', executionResolver: true,
            seed: { nodeEnv: 'test', passthroughEnv: { LANG: 'C.UTF-8' } } })
          expect(JSON.stringify(f.factoryCalls[0]!.seed)).not.toContain('sentinel')
          expect(f.runtimeCalls).toEqual([{ processSupervision: true, hasSpawn: true, snapshotId: f.hostSnapshots[0] }])
          expect(f.actionStarts.some(start => (start as { toolName?: string }).toolName === 'spawn_agent_inline')).toBe(true)
          expect(f.resolverCalls.length).toBeGreaterThan(0)
          for (const call of f.resolverCalls) {
            expect(call.snapshotId).toBe(f.hostSnapshots[0])
            expect(call.registration).toMatchObject({ ok: true, value: { correlation: { kind: 'action' } } })
            expect(call.identity).toMatchObject({ actionId: expect.any(String), attemptId: expect.any(String), basisId: expect.any(String) })
          }
          const expected = control === 'retry-budget-exhausted' ? 4
            : (branch === 'retry' ? 1 : 0) + (control === 'happy' || control === 'failed-child-receipt' ? 1 : 0)
          expect(f.boundaries).toHaveLength(expected)
          expect(target).toHaveLength(control === 'retry-budget-exhausted' ? 3 : control === 'happy' || control === 'failed-child-receipt' ? 1 : 0)
          expect(f.attempts.length).toBe(control === 'retry-budget-exhausted' ? 4 : branch === 'retry' ? 2 : 1)
          expect(new Set(f.attempts.map(attempt => attempt.cwd)).size).toBe(f.attempts.length)
          expect(new Set(f.attempts.map(attempt => attempt.request.rpcBridgeNonce)).size).toBe(f.attempts.length)
          expect(f.removedSandboxes.every(sandbox => sandbox.removed)).toBe(true)
          for (const attempt of f.attempts) {
            expect(attempt.mode).toBe(0o700)
            expect(attempt.requestMode).toBe(0o600)
            expect(JSON.stringify(attempt.bridgeReply)).toContain('captured SDK parent bridge')
            expect(attempt.request.executionIdentity).toEqual(f.attempts[0]!.request.executionIdentity)
            expect(attempt.request.ancestorRunIds).toEqual(f.attempts[0]!.request.ancestorRunIds)
          }
          for (const boundary of f.boundaries) {
            expect(boundary.cmd[0]).toBe(process.execPath)
            expect(boundary.cmd.slice(1, 3)).toEqual(['--no-env-file', 'run'])
            expect(boundary.env.PROJECT_VALUE).toBe('supervision-captured-public')
            expect(boundary.env.OPENAI_API_KEY).toBeUndefined()
            expect(boundary.env.CUSTOM_PROVIDER_KEY).toBeUndefined()
            expect(boundary.env.OPENBUFF_API_KEY).toBeUndefined()
          }
          expect(new Set(f.boundaries.map(boundary => boundary.launchId)).size).toBe(f.boundaries.length)
          const policies = f.policies.filter(policy => policy.facts.family === 'supervised-child')
          for (const policy of policies) {
            expect(policy.facts.correlation.kind).toBe('action')
            expect(policy.facts.correlation).toEqual(policies[0]!.facts.correlation)
            expect(policy.facts.deadlines.action).toEqual(policies[0]!.facts.deadlines.action)
            for (const deadline of Object.values(policy.facts.deadlines)) {
              expect(deadline).toMatchObject({ kind: 'finite', expiresAtMs: 60_100 })
            }
          }
          if (control === 'happy' || control === 'failed-child-receipt') {
            expect(f.error).toBeUndefined()
            expect(f.settledResults).toHaveLength(1)
            expect(f.settledResults[0]).toMatchObject({ outcome: 'ok', exitCode: 0,
              receipt: { status: control === 'failed-child-receipt' ? 'failed' : 'completed' } })
            expect(facts.filter(event => event.phase === 'spawn-observed')).toHaveLength(1)
          } else if (control === 'retry-budget-exhausted') {
            expect(f.settledResults[0]).toMatchObject({ outcome: 'crashed', crashReason: 'spawn_failed' })
            expect(facts.filter(event => event.phase === 'spawn-observed')).toHaveLength(0)
          } else {
            expect(f.attempts.at(-1)?.result?.executionRefusal).toMatchObject({ ok: false })
            expect(facts.filter(event => event.phase === 'spawn-observed')).toHaveLength(0)
            if (control === 'denied' || control === 'unavailable')
              expect(f.attempts.at(-1)?.result?.executionRefusal).toMatchObject({ reason: control })
            if (control === 'pre-aborted' || control === 'delayed-cancel')
              expect(f.attempts.at(-1)?.result?.executionRefusal).toMatchObject({ reason: 'cancelled' })
          }
          for (const event of facts) if (event.phase === 'no-launch') expect(event.facts.profile.active).toBeNull()
          if (control.startsWith('exhausted')) {
            expect(f.clockTransitions).toEqual([{ before: 100, after: 60_101, previousBoundaries: branch === 'retry' ? 1 : 0 }])
            expect(f.attempts.at(-1)?.result?.executionRefusal).toMatchObject({ reason: 'deadline-exhausted' })
          }
          passed = true
        } catch (error) { assertionError = error; throw error }
        finally {
          const f = capturedFixture
          if (f) {
            const casePath = path.join(f.artifactDir, 'case.json')
            writeFileSync(path.join(f.artifactDir, 'assertion-result.json'), JSON.stringify({
              schemaVersion: 1, targetBranch: f.targetBranch, control, casePath,
              caseSha256: createHash('sha256').update(readFileSync(casePath)).digest('hex'),
              assertionStatus: passed ? 'passed' : 'failed', error: assertionError instanceof Error
                ? { name: assertionError.name, message: assertionError.message, stack: assertionError.stack } : assertionError,
            }, null, 2) + '\n', { flag: 'wx' })
          }
        }
      }, 15_000)
    }
  }
})
