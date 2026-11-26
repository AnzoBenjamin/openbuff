import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  boundaries,
  effectProgramSha256,
  families,
  runEffectCrashChild,
  type Attempt,
  type Boundary,
  type EffectFamily,
} from './effect-crash-worker'

const digest = (data: string | Uint8Array) =>
  createHash('sha256').update(data).digest('hex')
const shaFile = (file: string) => digest(fs.readFileSync(file))
const writeJson = (file: string, value: unknown) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  })
const repo = path.resolve(import.meta.dir, '../../..')

function parseLine<T>(output: string, prefix: string): T {
  const lines = output
    .split('\n')
    .filter((line) => line.startsWith(prefix + ' '))
  assert.equal(lines.length, 1, `Expected one ${prefix} frame: ${output}`)
  return JSON.parse(lines[0]!.slice(prefix.length + 1)) as T
}

async function parent(args: string[]) {
  assert.equal(
    args.length,
    4,
    'Usage: --manifest <file> --evidence-dir <fresh directory>',
  )
  const flag = (name: string) => {
    const index = args.indexOf(name)
    assert((index === 0 || index === 2) && args[index + 1], `Missing ${name}`)
    return path.resolve(args[index + 1]!)
  }
  const manifestPath = flag('--manifest')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const host = `${process.platform}-${process.arch}`
  const bun = fs.realpathSync(process.execPath)
  const bunSha256 = shaFile(bun)
  const manifestSha256 = shaFile(manifestPath)
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.type, 'body-bootstrap-selection')
  assert.equal(Bun.version, manifest.tools.bun.expectedVersion)
  assert.equal(bunSha256, manifest.tools.bun.expectedSha256ByHost[host])
  assert.notEqual(
    process.platform,
    'win32',
    'This fixture verifies POSIX SIGKILL',
  )
  const evidenceDir = flag('--evidence-dir')
  fs.mkdirSync(evidenceDir, { mode: 0o700 })
  const inputs = [
    'test/fixtures/body/effect-crash.ts',
    'test/fixtures/body/effect-crash-worker.ts',
    'test/fixtures/body/effect-crash-transports.ts',
    'sdk/src/client.ts',
    'sdk/src/run.ts',
    'packages/agent-runtime/src/run-agent-step.ts',
    'packages/agent-runtime/src/tools/tool-executor.ts',
    'packages/agent-runtime/src/util/run-journal.ts',
    'packages/agent-runtime/src/run-programmatic-step.ts',
    'packages/agent-runtime/src/util/programmatic-replay-observation.ts',
    'packages/agent-runtime/src/util/recorded-replay-prefix.ts',
    'common/src/types/contracts/agent-runtime.ts',
  ]
  const source = () =>
    Object.fromEntries(
      inputs.map((name) => [name, shaFile(path.join(repo, name))]),
    )
  const sourceSha256 = source()
  const { createRunJournal, classifyRunResume } =
    await import('../../../packages/agent-runtime/src/util/run-journal')
  const observations: unknown[] = []
  for (const [family, boundary] of families.flatMap((family) =>
    boundaries.map((boundary) => [family, boundary] as const),
  )) {
    const root = path.join(
      fs.realpathSync(evidenceDir),
      `${family}-${boundary}`,
    )
    fs.mkdirSync(root, { mode: 0o700 })
    fs.mkdirSync(path.join(root, 'workspace'))
    fs.mkdirSync(path.join(root, 'home'))
    writeJson(path.join(root, 'provider.json'), {
      defaultModel: 'fixture/model',
      indexing: { enabled: false },
      autoFileChangeHooks: false,
      fileChangeHooks: [],
      providers: {
        fixture: {
          type: 'openai-compatible',
          baseURL: 'http://127.0.0.1:1/v1',
          models: ['model'],
        },
      },
    })
    const command = [
      bun,
      '--no-env-file',
      '--no-install',
      'run',
      import.meta.path,
    ]
    const env = {
      PATH: '/usr/bin:/bin',
      HOME: path.join(root, 'home'),
      DO_NOT_TRACK: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    }
    const spawned = Bun.spawn(
      [...command, '--worker', family, boundary, root],
      {
        cwd: root,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const diagnostics = new Response(spawned.stderr).text()
    let output = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const reader = spawned.stdout.getReader()
      try {
        await Promise.race([
          (async () => {
            const decoder = new TextDecoder()
            for (;;) {
              const chunk = await reader.read()
              if (chunk.done)
                throw new Error(
                  'Worker exited before the crash boundary: ' +
                    (await diagnostics),
                )
              output += decoder.decode(chunk.value, { stream: true })
              if (/^B15_PAUSED .+\n/m.test(output)) return
            }
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('B15 crash boundary timed out')),
              15_000,
            )
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
        spawned.kill('SIGKILL')
        await spawned.exited
        reader.releaseLock()
      }
    } finally {
      fs.writeFileSync(path.join(root, 'worker.stdout.log'), output)
      fs.writeFileSync(path.join(root, 'worker.stderr.log'), await diagnostics)
    }
    assert.equal(spawned.signalCode, 'SIGKILL')
    const frame = parseLine<
      Attempt & {
        family: EffectFamily
        boundary: Boundary
        fetchCalls: number
        peerCalls?: number
      }
    >(output, 'B15_PAUSED')
    assert.equal(frame.family, family)
    assert.equal(frame.boundary, boundary)
    assert.equal(frame.fetchCalls, 0)
    const seedFile = path.join(root, 'seed.json')
    const seedSha256 = shaFile(seedFile)
    const seedRunId = JSON.parse(fs.readFileSync(seedFile, 'utf8')).sessionState
      .mainAgentState.runId
    assert.equal(typeof seedRunId, 'string')
    assert.notEqual(frame.runId, seedRunId)
    const count = (file: string) =>
      fs.existsSync(path.join(root, file))
        ? fs.readFileSync(path.join(root, file), 'utf8').trimEnd().split('\n')
            .length
        : 0
    const effectCount = count('counter.txt')
    const finishedCount = count('finished.txt')
    assert.equal(effectCount, boundary === 'before-dispatch' ? 0 : 1)
    if (family === 'loopback-mcp') assert.equal(frame.peerCalls, effectCount)
    assert.equal(
      finishedCount,
      boundary === 'before-dispatch' || boundary === 'during-effect' ? 0 : 1,
    )

    const snapshot = () => {
      const reader = createRunJournal({ path: path.join(root, 'run.sqlite') })
      try {
        const rows = reader.events(frame.runId)
        return {
          runs: reader.runIds(),
          rows,
          verdict: classifyRunResume(reader, frame.runId),
        }
      } finally {
        void reader.close()
      }
    }
    const retained = snapshot()
    const toolRows = retained.rows.filter(
      (event) => event.correlation === frame.callId,
    )
    const programmaticObservations = retained.rows.filter(
      (event) => event.eventType === 'programmatic_observation',
    )
    const payloads = programmaticObservations.map(
      (event) =>
        event.payload as {
          kind: string
          replayPermitted: boolean
          artifact?: { kind: string; sourceSha256: string }
          ordinal?: number
        },
    )
    assert.deepEqual(
      payloads.map((item) => item.kind),
      ['basis', 'yield'],
    )
    assert(payloads.every((item) => item.replayPermitted === false))
    assert.deepEqual(payloads[0]?.artifact?.kind, 'serialized_handle_steps')
    assert.equal(payloads[0]?.artifact?.sourceSha256, effectProgramSha256)
    assert.equal(payloads[1]?.ordinal, 0)
    assert(programmaticObservations[1]!.seq < toolRows[0]!.seq)
    const confirmed = boundary === 'after-confirmation'
    assert.deepEqual(
      toolRows.map((event) => event.eventType),
      confirmed ? ['tool_call', 'tool_result'] : ['tool_call'],
    )
    for (const row of toolRows)
      assert.equal(
        (row.payload as { attemptId: string }).attemptId,
        frame.attemptId,
      )
    assert.deepEqual(
      retained.verdict,
      confirmed
        ? { kind: 'clean' }
        : { kind: 'in_flight_tool', toolCallId: frame.callId },
    )
    // A paired effect is still only a retained suffix, not permission to
    // run the generator again. Probe exact re-entry at all four boundaries.
    let reentry: unknown
    const probe = Bun.spawn(
      [...command, '--reenter', family, boundary, root, frame.runId],
      { cwd: root, env, stdout: 'pipe', stderr: 'pipe' },
    )
    let probeTimer: ReturnType<typeof setTimeout> | undefined
    try {
      probeTimer = setTimeout(() => {
        probe.kill('SIGKILL')
      }, 15_000)
      const [stdout, stderr, code] = await Promise.all([
        new Response(probe.stdout).text(),
        new Response(probe.stderr).text(),
        probe.exited,
      ])
      fs.writeFileSync(path.join(root, 'reentry.stdout.log'), stdout)
      fs.writeFileSync(path.join(root, 'reentry.stderr.log'), stderr)
      assert.equal(code, 0, stderr)
      const result = parseLine<{
        output: unknown
        termination: string
        outcomeCode?: string
        returnedRunId?: string
        effectCalls: number
        fetchCalls: number
      }>(stdout, 'B15_REENTRY')
      assert.equal(result.termination, 'failed')
      assert.equal(result.outcomeCode, 'replay_unavailable')
      assert.match(
        JSON.stringify(result.output),
        confirmed
          ? /no verified replay prefix/i
          : /previous tool outcome is unconfirmed/i,
      )
      assert.equal(result.effectCalls, 0)
      assert.equal(result.fetchCalls, 0)
      assert.equal(result.returnedRunId, frame.runId)
      assert.equal(count('counter.txt'), effectCount)
      assert.deepEqual(snapshot(), retained)
      reentry = result
    } finally {
      if (probeTimer) clearTimeout(probeTimer)
      if (probe.exitCode === null && probe.signalCode === null)
        probe.kill('SIGKILL')
      await probe.exited
    }
    const row = {
      ...frame,
      seedRunId,
      seedSha256,
      signal: spawned.signalCode,
      effectCount,
      finishedCount,
      toolRows,
      programmaticObservations,
      retainedVerdict: retained.verdict,
      reentry,
      confirmedScope: confirmed
        ? 'retained tool outcome, not a verified generator prefix'
        : undefined,
    }
    writeJson(path.join(root, 'observation.json'), row)
    // Actual local evidence stays; only this successful fixture's private
    // SDK caches and temporary session envelope are discarded.
    fs.unlinkSync(seedFile)
    fs.rmSync(path.join(root, 'home'), { recursive: true })
    observations.push(row)
    console.log(
      `${family}/${boundary}: ${effectCount} effect, ${toolRows.length} journal markers, re-entry refused`,
    )
  }
  assert.deepEqual(source(), sourceSha256)
  assert.equal(shaFile(bun), bunSha256)
  assert.equal(shaFile(manifestPath), manifestSha256)
  const report = path.join(evidenceDir, 'observations.json')
  writeJson(report, observations)
  writeJson(path.join(evidenceDir, 'receipt.json'), {
    schemaVersion: 1,
    kind: 'local-effect-crash-evidence',
    node: 'B15',
    accepted: false,
    toolchain: {
      manifestPath,
      manifestSha256,
      host,
      bun,
      bunSha256,
      version: Bun.version,
    },
    sourceSha256,
    observationsSha256: shaFile(report),
    scope:
      'Four POSIX crash phases each in the production SDK custom-tool, terminal override (joined local shell subprocesses), and owned loopback MCP paths. Fresh SDK processes probe guarded re-entry. This does not certify default terminal OS enforcement or automatic generator reconstruction.',
  })
}

const args = process.argv.slice(2)
if (args[0] === '--worker' || args[0] === '--reenter') {
  assert(args[3])
  await runEffectCrashChild(
    args[0] === '--worker' ? 'worker' : 'reenter',
    args[1] as EffectFamily,
    args[2] as Boundary,
    args[3],
    args[4],
  )
} else {
  await parent(args)
}
