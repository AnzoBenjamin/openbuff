import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const [mode, directory] = process.argv.slice(2)
const writerPidFile = path.join(directory, 'writer.pid')
const writerTermFile = path.join(directory, 'writer-term.json')
const leaderExitFile = path.join(directory, 'leader-exit.json')

if (mode === 'writer') {
  process.on('SIGTERM', () => {
    writeFileSync(
      writerTermFile,
      JSON.stringify({ pid: process.pid, atMs: performance.now() }),
    )
  })
  writeFileSync(writerPidFile, String(process.pid))
  // Fixed-size overwrites keep the hostile fixture's redirected storage bounded.
  let writes = 0
  setInterval(() => {
    if (writes++ < 128) process.stdout.write('still-writing\n')
  }, 20)
  setInterval(
    () =>
      writeFileSync(
        path.join(directory, 'heartbeat'),
        String(performance.now()),
      ),
    20,
  )
} else {
  const output = openSync(path.join(directory, 'writer.log'), 'w')
  const writer = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), 'writer', directory],
    {
      stdio: ['ignore', output, output],
      detached: false,
    },
  )
  closeSync(output)
  writer.unref()
  const until = performance.now() + 1_000
  while (!existsSync(writerPidFile) && performance.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  if (!existsSync(writerPidFile))
    throw new Error('Writer did not report a genuine launch')
  const exit = (reason) => {
    writeFileSync(
      leaderExitFile,
      JSON.stringify({ pid: process.pid, reason, atMs: performance.now() }),
    )
    // Exercise the gap between announcing exit and the OS observing it.
    if (mode === 'ready-delayed-exit') setTimeout(() => process.exit(0), 50)
    else process.exit(0)
  }
  process.on('SIGTERM', () => exit('SIGTERM'))
  const reader = readline.createInterface({
    input: process.stdin,
    terminal: false,
  })
  reader.on('line', (line) => {
    const message = JSON.parse(line)
    if (message.method === 'initialize' && mode !== 'handshake-hang') {
      process.stdout.write(
        `${JSON.stringify({ id: message.id, result: { protocolVersion: '1.0.0' } })}\n`,
      )
    } else if (message.method === 'ping') {
      process.stdout.write(
        `${JSON.stringify({ id: message.id, result: 'pong' })}\n`,
      )
    } else if (message.method === 'exit-clean') exit('normal')
  })
  setInterval(() => {}, 1_000)
}
