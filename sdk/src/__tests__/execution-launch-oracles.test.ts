import * as childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { OwnedStdioTransport } from '@codebuff/common/mcp/stdio-transport'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'

import {
  runToolchainSync,
  ToolchainExecutionError,
} from '../services/toolchain-execution'
import {
  dispatchOracleChild,
  oracleHost,
  ORACLE_PROFILE,
  RETRY_OUTCOMES,
  runConcurrentSdkScopes,
  runFreshHighImpactRetries,
  target,
  temporaryRoot,
  value,
} from './fixtures/b19-launch-oracles'

import type {
  LaunchEvent,
  ResourceRequestPort,
} from '@codebuff/common/types/contracts/execution-context'

const REPO = path.resolve(import.meta.dir, '../../..')
const EVIDENCE = path.join(
  REPO,
  'docs/execution/body-roadmap/evidence/B19/continuation-20261111/sdk-oracle-controls',
)
const SOURCES = [
  'sdk/src/__tests__/execution-launch-oracles.test.ts',
  'sdk/src/__tests__/fixtures/b19-launch-oracles.ts',
  'sdk/src/client.ts',
  'sdk/src/run.ts',
  'sdk/src/custom-tool.ts',
  'sdk/src/host-execution.ts',
  'sdk/src/host-config.ts',
  'sdk/src/provider-config.ts',
  'sdk/src/impl/agent-runtime.ts',
  'sdk/src/impl/model-provider.ts',
  'sdk/src/services/execution-launch.ts',
  'sdk/src/services/toolchain-execution.ts',
  'sdk/src/services/harness-enforcement.ts',
  'sdk/src/services/local-harness-store.ts',
  'sdk/src/tools/run-terminal-command.ts',
  'sdk/src/tools/node-filesystem.ts',
  'common/src/mcp/stdio-transport.ts',
  'common/src/util/execution-context.ts',
  'common/src/types/contracts/execution-context.ts',
  'packages/agent-runtime/src/run-programmatic-step.ts',
  'packages/agent-runtime/src/run-agent-step.ts',
  'packages/agent-runtime/src/tools/tool-executor.ts',
] as const
const hash = (file: string) =>
  createHash('sha256').update(readFileSync(file)).digest('hex')
const sourceHashes = Object.fromEntries(
  SOURCES.map((file) => [file, hash(path.join(REPO, file))]),
)
const roots: string[] = []
const hosts: ReturnType<typeof oracleHost>[] = []
function root() {
  const directory = temporaryRoot()
  roots.push(directory)
  return directory
}
function host(
  directory: string,
  options: Parameters<typeof oracleHost>[1] = {},
  missingAuthorizer = false,
) {
  const fixture = oracleHost(directory, options, missingAuthorizer)
  hosts.push(fixture)
  return fixture
}
afterEach(() => {
  for (const fixture of hosts.splice(0)) fixture.close()
  for (const directory of roots.splice(0))
    rmSync(directory, { recursive: true, force: true })
})
function retain(caseId: string, observation: object) {
  const directory = process.env.B19_SDK_ORACLE_EVIDENCE_DIR
  if (!directory) return
  const captureDirectory = path.resolve(directory)
  if (
    captureDirectory !== EVIDENCE &&
    !captureDirectory.startsWith(EVIDENCE + path.sep)
  )
    throw new Error(
      'SDK oracle evidence must remain in its owned B19 directory',
    )
  expect(
    Object.fromEntries(
      SOURCES.map((file) => [file, hash(path.join(REPO, file))]),
    ),
  ).toEqual(sourceHashes)
  mkdirSync(captureDirectory, { recursive: true })
  writeFileSync(
    path.join(captureDirectory, `${caseId}.json`),
    JSON.stringify(
      {
        caseId,
        status: 'passed',
        sourceHashes,
        toolchain: {
          executable: process.execPath,
          sha256: hash(process.execPath),
          bun: Bun.version,
          platform: process.platform,
        },
        observation,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  )
}

describe('B19 missing SDK launch oracles', () => {
  test('approval.missing-authorizer: identical intended target refuses at host intake while explicit allow-all launches', async () => {
    const directory = root(),
      selected = target(directory, { argv: ['--version'] })
    const missing = host(directory, {}, true)
    const allowed = host(directory)
    expect(missing).toMatchObject({
      ok: false,
      reason: 'unavailable',
      cause: 'Invalid execution host inputs',
    })
    expect(missing.policyInputs).toEqual([])
    expect(missing.events).toEqual([])
    const { context } = value(allowed)
    const prepared = value(
      context.execution.prepareTarget({ target: selected }),
    )
    const admitted = value(await prepared.admit())
    expect(allowed.policyDecisions[0]).toMatchObject({
      ok: true,
      basis: 'explicit-policy',
      decisionId: admitted.decisionId,
    })
    expect(allowed.policyInputs).toHaveLength(1)
    expect(allowed.policyInputs[0].target).toMatchObject(selected)
    const child = await dispatchOracleChild(prepared, admitted.permit).closed
    expect(child).toMatchObject({
      exitCode: 0,
      signal: null,
      errorCode: undefined,
    })
    expect(child.stdout).toMatch(/^git version /)
    expect(child.pid).toBeGreaterThan(0)
    expect(child.environment.OPENAI_API_KEY).toBeUndefined()
    expect(
      allowed.events.filter((event) => event.phase === 'spawn-observed'),
    ).toHaveLength(1)
    retain('missing-authorizer', {
      intendedTarget: selected,
      refusalStage: 'host-intake',
      missing: {
        reason: missing.ok ? undefined : missing.reason,
        cause: missing.ok ? undefined : missing.cause,
        targetPolicyCalls: missing.policyInputs.length,
        targetPermitCount: 0,
        selectedTargetDispatchCount: 0,
        events: missing.events,
      },
      explicitAllowAll: {
        policyInputs: allowed.policyInputs,
        policyDecisions: allowed.policyDecisions,
        admission: admitted,
        child,
        events: allowed.events,
      },
      limitations: [
        'The missing authorizer refuses at host construction; no target handle or admission exists in that arm.',
      ],
    })
  })

  test('real.mcp-env: owned stdio preserves missing-authorizer host-intake refusal and explicit allow-all launches', async () => {
    const directory = root()
    const selected = target(directory, {
      executable: process.execPath,
      argv: ['--no-env-file', '-e', 'process.stdin.resume()'],
      family: 'mcp-stdio',
      branchId: 'mcp.cold-start',
      processType: 'BACKGROUND',
    })
    const observations: object[] = []
    for (const missingAuthorizer of [true, false]) {
      const fixture = host(directory, {}, missingAuthorizer)
      let request: ResourceRequestPort | undefined,
        spawns = 0,
        preparations = 0
      let closed: Promise<void> | undefined
      if (fixture.ok) {
        const operation = value(fixture.value.host.directOperation())
        request = value(
          value(operation.resources(selected)).request(
            operation.executionContext.execution,
          ),
        )
      }
      const transport = new OwnedStdioTransport({
        prepareLaunch: () => {
          preparations++
          return fixture.ok ? request!.prepareLaunch() : fixture
        },
        spawn: (command, argv, options) => {
          spawns++
          const child = childProcess.spawn(command, argv ?? [], options ?? {})
          closed = new Promise((resolve) =>
            child.once('close', () => resolve()),
          )
          return child
        },
      })
      try {
        if (missingAuthorizer) {
          await expect(transport.start()).rejects.toMatchObject({
            name: 'ExecutionAdmissionError',
            executionRefusal: {
              ok: false,
              reason: 'unavailable',
              cause: 'Invalid execution host inputs',
            },
          })
          expect(spawns).toBe(0)
          expect(transport.pid).toBeNull()
          expect(fixture.events).toEqual([])
          expect(fixture.policyInputs).toEqual([])
        } else {
          await transport.start()
          expect(spawns).toBe(1)
          expect(transport.pid).toBeGreaterThan(0)
          expect(fixture.policyInputs[0].target).toMatchObject(selected)
          expect(
            fixture.events.filter((event) => event.phase === 'spawn-observed'),
          ).toHaveLength(1)
          expect(
            fixture.events.find((event) => event.phase === 'spawn-observed')
              ?.facts.profile.active?.backend,
          ).toBe('portable-ts')
        }
        expect(preparations).toBe(1)
        observations.push({
          missingAuthorizer,
          intendedTarget: selected,
          refusalStage: missingAuthorizer ? 'host-intake' : null,
          spawns,
          preparations,
          pid: transport.pid,
          policyInputs: fixture.policyInputs,
          events: fixture.events,
        })
      } finally {
        await transport.close()
        await closed
        request?.release()
      }
    }
    retain('mcp-missing-authorizer', {
      transport: 'OwnedStdioTransport',
      observations,
      limitations: [
        'The missing-authorizer transport propagates host-intake unavailable; its resource cannot be constructed. The allowed transport starts a real local stdio child.',
      ],
    })
  })

  test('sync.limit and review.admission.sync: real legacy adapter refuses required cooperative cancellation before spawnSync', () => {
    const directory = root()
    const required = host(directory, {
      profile: {
        ...ORACLE_PROFILE,
        required: ['exact-env', 'cooperative-cancellation'],
      },
    })
    const positive = host(directory)
    const spawnSync = childProcess.spawnSync
    const calls: Array<{
      command: string
      argv: readonly string[]
      env: NodeJS.ProcessEnv | undefined
    }> = []
    const spy = spyOn(childProcess, 'spawnSync').mockImplementation(((
      command: string,
      argv?: readonly string[],
      options?: childProcess.SpawnSyncOptions,
    ) => {
      calls.push({ command, argv: argv ?? [], env: options?.env })
      return spawnSync(command, argv ?? [], options)
    }) as typeof childProcess.spawnSync)
    try {
      const input = {
        branchId: 'build.sync-legacy.cargo',
        argv: ['/usr/bin/git', '--version'],
        cwd: directory,
        timeoutMs: 2000,
        maxBufferBytes: 1024,
      }
      let refusal: ToolchainExecutionError | undefined
      try {
        runToolchainSync({ ...input, context: value(required).context })
      } catch (error) {
        if (!(error instanceof ToolchainExecutionError)) throw error
        refusal = error
      }
      expect(refusal?.refusal).toEqual({
        ok: false,
        reason: 'unavailable',
        cause: 'Synchronous runtime cannot provide cooperative cancellation',
      })
      expect(calls).toHaveLength(0)
      expect(required.policyInputs).toHaveLength(0)
      expect(required.events.map((event) => event.phase)).toEqual([
        'planned',
        'no-launch',
      ])
      expect(
        required.events.every(
          (event) => 'facts' in event && event.facts.profile.active === null,
        ),
      ).toBe(true)
      const result = runToolchainSync({
        ...input,
        context: value(positive).context,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toMatch(/^git version /)
      expect(calls).toHaveLength(1)
      expect(calls[0].env?.OPENAI_API_KEY).toBeUndefined()
      const observed = positive.events.find(
        (event) => event.phase === 'spawn-observed',
      )
      expect(observed).toMatchObject({ phase: 'spawn-observed' })
      if (observed?.phase !== 'spawn-observed')
        throw new Error('Real legacy child start observation is required')
      expect(observed.pid).toBeGreaterThan(0)
      retain('sync-required-cooperative-cancellation', {
        refusal: refusal?.refusal,
        selectedTargetDispatchCount: 0,
        requiredPolicyInputs: required.policyInputs,
        requiredEvents: required.events,
        positive: { calls, result, events: positive.events },
        input,
      })
    } finally {
      spy.mockRestore()
    }
  })

  test('review.config.isolation: two simultaneous SDK strategies read no ambient configuration', async () => {
    const observed = await runConcurrentSdkScopes()
    expect(observed.overlap).toEqual([['a', 'b']])
    expect(observed.networkAttempts).toBe(0)
    expect(observed.unattributedAmbientReads).toBe(0)
    expect(observed.ambientConfigReadCounters).toEqual({ a: 0, b: 0 })
    expect(JSON.parse(observed.ambientPoisonBytes).defaultModel).toBe(
      'ambient/poison',
    )
    expect(
      new Set(
        observed.scopes.map(
          (scope) =>
            scope.events.find((event) => event.phase === 'planned')?.facts
              .configurationSnapshotId,
        ),
      ).size,
    ).toBe(2)
    const selectedOwnerIds = new Set<string>()
    for (const scope of observed.scopes) {
      const planned = scope.events.find((event) => event.phase === 'planned')
      if (!planned) throw new Error('Actual SDK host has no planned launch')
      expect(scope.ambientConfigReads).toEqual([])
      expect(new Set(scope.explicitConfigReads)).toEqual(
        new Set([scope.configFile]),
      )
      expect(scope.entries).toHaveLength(1)
      expect(scope.entries[0]).toMatchObject({
        label: scope.label,
        asynchronousScope: scope.label,
        activeScopes: ['a', 'b'],
        snapshotId: planned.facts.configurationSnapshotId,
        snapshotSources: [scope.configFile],
        capturedDefaultModel: `provider-${scope.label}/selected`,
        resolvedWindow: scope.windowTokens,
        effectiveModel: `provider-${scope.label}/selected`,
        provider: `provider-${scope.label}`,
        capturedEnvironment: `captured-${scope.label}`,
      })
      expect(scope.result?.runOutcome?.termination).toBe('completed')
      expect(scope.result?.output).toMatchObject({
        type: 'structuredOutput',
        value: {
          terminal: [
            {
              type: 'json',
              value: { stdout: `captured-${scope.label}`, exitCode: 0 },
            },
          ],
        },
      })
      const launches = scope.events.filter(
        (event) =>
          event.phase === 'spawn-observed' &&
          event.facts.branchId === 'terminal.sync',
      )
      expect(launches).toHaveLength(1)
      const launch = launches[0]
      if (launch.phase !== 'spawn-observed')
        throw new Error('Actual SDK selected child has no start observation')
      expect(launch.facts.configurationSnapshotId).toBe(
        planned.facts.configurationSnapshotId,
      )
      selectedOwnerIds.add(launch.facts.ownerId)
      expect(scope.boundaries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            signalPresent: true,
            cwd: scope.root,
            env: expect.objectContaining({
              PROJECT_VALUE: `captured-${scope.label}`,
            }),
          }),
        ]),
      )
      expect(
        scope.boundaries.every(
          (boundary) =>
            !JSON.stringify(boundary).includes(`scope-${scope.label}-secret`),
        ),
      ).toBe(true)
    }
    expect(selectedOwnerIds.size).toBe(2)
    retain('concurrent-sdk-isolation', observed)
  }, 20000)

  test.each(RETRY_OUTCOMES)(
    'review.authority.v2-and-retry: fresh high-impact approval after %s preserves target grants through preflight',
    async (outcome) => {
      const observed = await runFreshHighImpactRetries(outcome)
      expect(observed.decisions).toHaveLength(2)
      expect(observed.declinedPrompts).toBe(1)
      expect(
        new Set(observed.decisions.map((decision) => decision.grantId)).size,
      ).toBe(2)
      expect(
        new Set(observed.requests.map((request) => request.bindingDigest)).size,
      ).toBe(3)
      expect(
        new Set(observed.requests.map((request) => request.binding.commandHash))
          .size,
      ).toBe(1)
      expect(
        observed.requests.every((request) =>
          request.classification.effects.some(
            (effect) => effect.action === 'commit',
          ),
        ),
      ).toBe(true)
      expect(observed.attempts[0].admission).toMatchObject({
        ok: true,
        value: { decisionId: observed.decisions[0].grantId },
      })
      expect(observed.attempts[1].admission).toMatchObject({
        ok: false,
        reason: 'denied',
        cause: 'The user declined this operation.',
      })
      expect(observed.attempts[1].child).toBeUndefined()
      expect(observed.attempts[2].admission).toMatchObject({
        ok: true,
        value: { decisionId: observed.decisions[1].grantId },
      })
      expect(
        observed.policyDecisions.filter(
          (decision) =>
            decision.ok && decision.basis === 'exact-action-approval',
        ),
      ).toHaveLength(2)
      expect(observed.oldAdmission).toMatchObject({
        ok: false,
        reason: 'already-consumed',
      })
      expect(observed.oldDispatch).toMatchObject({
        ok: false,
        reason: 'already-consumed',
      })
      expect(observed.repeatedDispatchCount).toBe(0)
      expect(observed.oldGrantError).toContain('already consumed')
      expect(observed.oldBindingError).toContain('execution authority v2')
      expect(observed.oldBindingGrant?.consumedAt).toBeUndefined()
      expect(observed.oldBindingGrant?.revision).toBe(0)
      expect(
        observed.grants.every(
          (grant) =>
            grant?.revision === 1 && typeof grant.consumedAt === 'string',
        ),
      ).toBe(true)
      expect(observed.preflights).toHaveLength(2)
      for (const preflight of observed.preflights) {
        expect(preflight.before).toMatchObject({
          id: preflight.grantId,
          revision: 0,
        })
        expect(preflight.after).toEqual(preflight.before)
        expect(preflight.result).toMatchObject({
          exitCode: 0,
          stdout: expect.stringMatching(/^git version /),
        })
        expect(
          observed.requests.some(
            (request) => request.facts.launchId === preflight.launchId,
          ),
        ).toBe(false)
      }
      const selectedDispatches = observed.events.filter(
        (event): event is Extract<LaunchEvent, { phase: 'dispatched' }> =>
          event.phase === 'dispatched' &&
          event.facts.branchId === 'terminal.sync',
      )
      expect(selectedDispatches).toHaveLength(2)
      expect(selectedDispatches.map((event) => event.facts.launchId)).toEqual([
        observed.attempts[0].facts.launchId,
        observed.attempts[2].facts.launchId,
      ])
      const starts = observed.events.filter(
        (event) =>
          event.phase === 'spawn-observed' &&
          event.facts.branchId === 'terminal.sync',
      )
      for (const attempt of [observed.attempts[0], observed.attempts[2]]) {
        expect(attempt.child?.environment.OPENAI_API_KEY).toBeUndefined()
        if (outcome === 'ENOENT') {
          expect(attempt.child?.errorCode).toBe('ENOENT')
          expect(attempt.facts.profile.active).toBeNull()
        } else {
          expect(attempt.child?.exitCode).toBe(128)
          expect(attempt.child?.stderr).toContain('not a git repository')
          expect(attempt.child?.pid).toBeGreaterThan(0)
        }
      }
      expect(starts).toHaveLength(outcome === 'failing-child' ? 2 : 0)
      if (outcome === 'unobserved-child')
        expect(
          observed.attempts.every(
            (attempt) => attempt.facts.profile.active === null,
          ),
        ).toBe(true)
      retain(`fresh-retry-${outcome}`, observed)
    },
    20000,
  )
})
