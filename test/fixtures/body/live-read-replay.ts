import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const batches = [['first.txt'], ['second.txt']]
const shaFile = (file: string) =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const writeJson = (file: string, value: unknown) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  })
globalThis.fetch = Object.assign(
  async () => {
    throw new Error('Read replay fixture attempted a network request')
  },
  { preconnect() {} },
) as typeof fetch

const packaged = process.env.OPENBUFF_LIVE_READ_ARTIFACT === 'esm'
const { OpenbuffClient, openReplayableReadJournal } = (
  packaged
    ? await import('../../../sdk/dist/index.mjs')
    : await import('../../../sdk/src/index')
) as typeof import('../../../sdk/src/index')
const { verifyReadPlanPrefix } =
  await import('../../../packages/agent-runtime/src/util/read-plan-replay')
const options = (root: string) => ({
  cwd: path.join(root, 'project'),
  handleEvent() {},
  logger: { debug() {}, info() {}, warn() {}, error() {} },
})

async function worker(root: string) {
  const journal = openReplayableReadJournal(path.join(root, 'journal.sqlite'))
  const durable = journal.appendDurable.bind(journal)
  journal.appendDurable = async (runId, event) => {
    await durable(runId, event)
    if (event.eventType === 'tool_result') {
      process.stdout.write(
        'READ_REPLAY_PAUSED ' + JSON.stringify({ runId }) + '\n',
      )
      await new Promise<never>(() => {
        setInterval(() => {}, 1_000)
      })
    }
  }
  try {
    const result = await new OpenbuffClient(options(root)).runReplayableReads({
      batches,
      journal,
    })
    throw new Error(
      'Live plan did not stop after the first result: ' +
        JSON.stringify(result.output),
    )
  } finally {
    await journal.close()
  }
}

async function resumeWorker(root: string, runId: string) {
  const journal = openReplayableReadJournal(path.join(root, 'journal.sqlite'))
  try {
    const result = await new OpenbuffClient(options(root)).runReplayableReads({
      batches,
      journal,
      resumeRunId: runId,
    })
    process.stdout.write(
      'READ_REPLAY_RESULT ' +
        JSON.stringify({
          output: result.output,
          runOutcome: result.runOutcome,
          runId: result.sessionState?.mainAgentState.runId,
        }) +
        '\n',
    )
  } finally {
    await journal.close()
  }
}

async function parent(args: string[]) {
  assert.equal(
    args.length,
    4,
    'Usage: --manifest <file> --evidence-dir <fresh directory>',
  )
  const value = (name: string) => {
    const index = args.indexOf(name)
    assert((index === 0 || index === 2) && args[index + 1], `Missing ${name}`)
    return path.resolve(args[index + 1]!)
  }
  const pathToManifest = value('--manifest')
  const manifest = JSON.parse(fs.readFileSync(pathToManifest, 'utf8'))
  const executable = fs.realpathSync(process.execPath)
  const host = `${process.platform}-${process.arch}`
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(Bun.version, manifest.tools.bun.expectedVersion)
  assert.equal(
    shaFile(executable),
    manifest.tools.bun.expectedSha256ByHost[host],
  )
  const directory = value('--evidence-dir')
  fs.mkdirSync(directory, { mode: 0o700 })
  const root = fs.realpathSync(directory)
  fs.mkdirSync(path.join(root, 'project'))
  fs.writeFileSync(path.join(root, 'project', 'first.txt'), 'original-first\n')
  fs.writeFileSync(
    path.join(root, 'project', 'second.txt'),
    'original-second\n',
  )
  const command = [
    executable,
    '--no-env-file',
    '--no-install',
    'run',
    import.meta.path,
  ]
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: root,
    DO_NOT_TRACK: '1',
    ...(packaged ? { OPENBUFF_LIVE_READ_ARTIFACT: 'esm' } : {}),
  }
  const child = Bun.spawn([...command, '--worker', root], {
    cwd: root,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stderr = new Response(child.stderr).text()
  let line = ''
  let timeout: ReturnType<typeof setTimeout> | undefined
  const reader = child.stdout.getReader()
  let runId: string
  try {
    await Promise.race([
      (async () => {
        const decoder = new TextDecoder()
        for (;;) {
          const next = await reader.read()
          if (next.done)
            throw new Error(
              'Worker exited before a durable read: ' + (await stderr),
            )
          line += decoder.decode(next.value, { stream: true })
          if (/^READ_REPLAY_PAUSED .+\n/m.test(line)) return
        }
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('First read timed out')),
          20_000,
        )
      }),
    ])
    runId = JSON.parse(/^READ_REPLAY_PAUSED (.+)$/m.exec(line)![1]!).runId
    assert.equal(typeof runId, 'string')
    const journal = openReplayableReadJournal(path.join(root, 'journal.sqlite'))
    try {
      const alive = await new OpenbuffClient(options(root)).runReplayableReads({
        batches,
        journal,
        resumeRunId: runId,
      })
      assert.equal(alive.runOutcome?.cause?.code, 'replay_unavailable')
      assert.match(JSON.stringify(alive.output), /owner.*live/i)
    } finally {
      await journal.close()
    }
  } finally {
    if (timeout) clearTimeout(timeout)
    child.kill('SIGKILL')
    await child.exited
    reader.releaseLock()
    fs.writeFileSync(path.join(root, 'worker.stdout.log'), line)
    fs.writeFileSync(path.join(root, 'worker.stderr.log'), await stderr)
  }
  assert.equal(child.signalCode, 'SIGKILL')
  fs.writeFileSync(
    path.join(root, 'project', 'first.txt'),
    'first-changed-after-capture\n',
  )
  fs.writeFileSync(
    path.join(root, 'project', 'second.txt'),
    'second-live-after-restart\n',
  )
  const journal = openReplayableReadJournal(path.join(root, 'journal.sqlite'))
  try {
    const client = new OpenbuffClient(options(root))
    const changed = await client.runReplayableReads({
      batches: [['second.txt'], ['first.txt']],
      journal,
      resumeRunId: runId,
    })
    assert.equal(changed.runOutcome?.cause?.code, 'replay_unavailable')
    const originalRows = journal.events(runId)
    assert.deepEqual(
      originalRows.map((row) => row.eventType),
      ['read_plan_basis', 'tool_call', 'tool_result'],
    )
    const { basis } = originalRows[0]!.payload as {
      basis: Parameters<typeof verifyReadPlanPrefix>[1]
    }
    assert.throws(
      () => verifyReadPlanPrefix(originalRows.slice(0, 2), basis, batches),
      /no confirmed result/,
    )
    const alternateRoot = path.join(root, 'alternate-project')
    fs.mkdirSync(alternateRoot)
    const changedRoot = await new OpenbuffClient({
      ...options(root),
      cwd: alternateRoot,
    }).runReplayableReads({ batches, journal, resumeRunId: runId })
    assert.equal(changedRoot.runOutcome?.cause?.code, 'replay_unavailable')
    assert.deepEqual(journal.events(runId), originalRows)
    const attempt = async () => {
      const continuation = Bun.spawn(
        [...command, '--resume-worker', root, runId],
        { cwd: root, env, stdout: 'pipe', stderr: 'pipe' },
      )
      const timer = setTimeout(() => continuation.kill('SIGKILL'), 20_000)
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(continuation.stdout).text(),
          new Response(continuation.stderr).text(),
          continuation.exited,
        ])
        assert.equal(code, 0, stderr)
        return JSON.parse(/^READ_REPLAY_RESULT (.+)$/m.exec(stdout)![1]!) as {
          output: unknown
          runOutcome?: { termination: string; cause?: { code: string } }
          runId?: string
        }
      } finally {
        clearTimeout(timer)
      }
    }
    const contenders = await Promise.all([attempt(), attempt()])
    assert.equal(
      contenders.filter(
        (result) => result.runOutcome?.termination === 'completed',
      ).length,
      1,
    )
    assert.equal(
      contenders.filter(
        (result) => result.runOutcome?.cause?.code === 'replay_unavailable',
      ).length,
      1,
    )
    const resumed = contenders.find(
      (result) => result.runOutcome?.termination === 'completed',
    )!
    assert.equal(resumed.runId, runId)
    assert.match(JSON.stringify(resumed.output), /original-first/)
    assert.match(JSON.stringify(resumed.output), /second-live-after-restart/)
    assert.doesNotMatch(
      JSON.stringify(resumed.output),
      /first-changed-after-capture/,
    )
    const reads = journal.eventsOfType(runId, 'tool_call')
    assert.deepEqual(
      reads.map((event) => event.stepNumber),
      [1, 2],
    )
    assert.deepEqual(
      reads.map(
        (event) =>
          (event.payload as { input: { paths: string[] } }).input.paths,
      ),
      batches,
    )
    const duplicate = await client.runReplayableReads({
      batches,
      journal,
      resumeRunId: runId,
    })
    assert.equal(duplicate.runOutcome?.cause?.code, 'replay_unavailable')
    assert.equal(journal.eventsOfType(runId, 'tool_call').length, 2)
    writeJson(path.join(root, 'observation.json'), {
      runId,
      originalOwnerSignal: child.signalCode,
      resumed: resumed.output,
      reads,
      contenders,
      duplicate: duplicate.output,
      changed: changed.output,
      changedRoot: changedRoot.output,
      packaged,
      runtimeSha256: shaFile(executable),
      manifestSha256: shaFile(pathToManifest),
      accepted: false,
    })
    console.log(
      'Verified live read replay: original run ID, one retained read, one live read, no duplicate',
    )
  } finally {
    await journal.close()
  }
}
const args = process.argv.slice(2)
if (args[0] === '--worker') {
  assert(args[1])
  await worker(args[1])
} else if (args[0] === '--resume-worker') {
  assert(args[1] && args[2])
  await resumeWorker(args[1], args[2])
} else await parent(args)
