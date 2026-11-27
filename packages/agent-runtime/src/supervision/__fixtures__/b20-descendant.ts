import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [mode, directory] = process.argv.slice(2)
const writerPidFile = join(directory, 'writer.pid')
const writerTermFile = join(directory, 'writer-term.json')
const leaderExitFile = join(directory, 'leader-exit.json')

if (mode === 'writer') {
  process.on('SIGTERM', () =>
    writeFileSync(
      writerTermFile,
      JSON.stringify({ pid: process.pid, atMs: performance.now() }),
    ),
  )
  writeFileSync(writerPidFile, String(process.pid))
  let writes = 0
  setInterval(() => {
    // A finite output sink plus fixed-size heartbeat overwrites bounds storage.
    if (writes++ < 128) process.stdout.write('still-writing\n')
    writeFileSync(join(directory, 'heartbeat'), String(performance.now()))
  }, 20)
  await Bun.sleep(30_000)
} else {
  writeFileSync(
    join(directory, 'leader.json'),
    JSON.stringify({ pid: process.pid }),
  )
  process.on('SIGTERM', () => {
    writeFileSync(
      leaderExitFile,
      JSON.stringify({
        pid: process.pid,
        reason: 'SIGTERM',
        atMs: performance.now(),
      }),
    )
    process.exit(0)
  })
  const writer = Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      'run',
      fileURLToPath(import.meta.url),
      'writer',
      directory,
    ],
    {
      env: {},
      stdin: 'ignore',
      stdout: mode === 'inherited' ? 'inherit' : 'ignore',
      stderr: mode === 'inherited' ? 'inherit' : 'ignore',
      detached: false,
    },
  )
  writer.unref()
  const until = performance.now() + 1_000
  while (!existsSync(writerPidFile) && performance.now() < until)
    await Bun.sleep(5)
  if (!existsSync(writerPidFile))
    throw new Error('Writer did not report a genuine launch')
  if (mode === 'normal-exit') {
    await Bun.write(
      Bun.stdout,
      `${JSON.stringify({
        schemaVersion: 1,
        receiptId: 'b20-normal-exit',
        taskId: 'b20-scope',
        role: 'specialist',
        agentId: 'b20-fixture',
        status: 'completed',
        outcome: 'ok',
        changedFiles: [],
        requirementsAddressed: [],
        acceptanceCriteriaAddressed: [],
        findingsAddressed: [],
        evidence: [],
        assumptions: [],
        unresolved: [],
        requestedValidation: [],
        artifacts: [],
        errors: [],
      })}\n`,
    )
    writeFileSync(
      leaderExitFile,
      JSON.stringify({
        pid: process.pid,
        reason: 'normal',
        atMs: performance.now(),
      }),
    )
    process.exit(0)
  }
  await Bun.sleep(30_000)
}

export {}
