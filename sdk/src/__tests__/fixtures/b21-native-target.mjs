// Actual target workload. No native/control authority comes from these bytes.
import fs from 'node:fs'
import { fork, spawn } from 'node:child_process'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

const [scenario = 'normal', marker, extra] = process.argv.slice(2)
if (scenario === 'normal') {
  process.stdout.write(
    Buffer.concat([
      Buffer.from('{"jsonrpc":"2.0","result":"target-only"}\n'),
      Buffer.from([0, 255, 10]),
    ]),
  )
  process.stderr.write(Buffer.from([82, 65, 87, 0, 254, 10]))
  const fds = fs.readdirSync('/proc/self/fd').flatMap((fd) => {
    try {
      return [{ fd, target: fs.readlinkSync(`/proc/self/fd/${fd}`) }]
    } catch {
      return []
    }
  })
  process.stdout.write(
    JSON.stringify({
      cwd: process.cwd(),
      marker: process.env.B21_MARKER ?? null,
      credentialAbsent:
        !process.env.OPENAI_API_KEY && !process.env.CUSTOM_PROVIDER_KEY,
      fds,
    }) + '\n',
  )
} else if (scenario === 'late-marker') {
  process.on('SIGTERM', () => {})
  setTimeout(
    () => fs.writeFileSync(marker, 'escaped-lifetime'),
    Number(extra ?? 2500),
  )
  setInterval(() => {}, 1000)
} else if (scenario === 'double-fork-middle') {
  spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), 'late-marker', marker, extra],
    { detached: true, stdio: 'ignore', env: {} },
  ).unref()
} else if (scenario === 'double-fork-tree') {
  process.on('SIGTERM', () => {})
  spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), 'double-fork-middle', marker, extra],
    { detached: true, stdio: 'ignore', env: {} },
  ).unref()
  process.stdout.write('DOUBLE-FORK-READY\n')
  setInterval(() => {}, 1000)
} else if (scenario === 'rogue-native-reconnect') {
  const socket = net.connect('/.openbuff/control/socket')
  socket.once('connect', () => {
    process.stdout.write('ROGUE-SOCKET-CONNECTED\n')
    socket.destroy()
    process.exitCode = 1
  })
  socket.once('error', (error) =>
    process.stdout.write(`ROGUE-SOCKET-REFUSED:${error.code}\n`),
  )
  const rogue = spawn(
    '/.openbuff/native',
    ['exec', '--entry-stub', '/.openbuff/control/socket', 'none'],
    { env: {}, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  rogue.once('exit', (code, signal) => {
    process.stdout.write(`ROGUE-NATIVE-EXIT:${code}:${signal}\n`)
    if (code !== 125 || signal !== null) process.exitCode = 1
  })
} else if (
  scenario === 'term-resistant-tree' ||
  scenario === 'normal-leader-exit'
) {
  process.on('SIGTERM', () => {})
  spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), 'late-marker', marker, extra ?? '2500'],
    { detached: true, stdio: 'ignore' },
  ).unref()
  process.stdout.write('TREE-READY\n')
  if (scenario === 'term-resistant-tree') setInterval(() => {}, 1000)
} else if (scenario === 'network') {
  const socket = net.connect({ host: '127.0.0.1', port: Number(marker) })
  socket.once('connect', () => {
    process.stdout.write('HOST-NETWORK-REACHED\n')
    socket.end()
    process.exitCode = 1
  })
  socket.once('error', (error) =>
    process.stdout.write(`NETWORK-DENIED:${error.code}\n`),
  )
  socket.setTimeout(1000, () =>
    socket.destroy(new Error('network target timeout')),
  )
} else if (scenario === 'unix-network') {
  const socket = net.connect(marker)
  socket.once('connect', () => {
    process.stdout.write('HOST-UNIX-REACHED\n')
    socket.end()
  })
  socket.once('error', (error) =>
    process.stdout.write(`UNIX-DENIED:${error.code}\n`),
  )
  socket.setTimeout(1000, () =>
    socket.destroy(new Error('Unix target timeout')),
  )
} else if (scenario === 'ipc') {
  const child = fork(fileURLToPath(import.meta.url), ['ipc-child'], {
    env: {},
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  child.once('message', (value) => {
    process.stdout.write(`IPC:${value}\n`)
    child.disconnect()
  })
  child.once('exit', (code) => {
    process.exitCode = code
  })
} else if (scenario === 'ipc-child') {
  process.send('anonymous-stream-pair')
} else if (scenario === 'signal') {
  process.stdout.write('SIGNAL-READY\n')
  setTimeout(() => process.kill(process.pid, Number(marker)), 50)
} else if (scenario === 'exit') {
  process.exitCode = Number(marker)
} else if (scenario === 'filesystem') {
  fs.writeFileSync(marker, 'allowed-write')
  try {
    fs.readFileSync(extra)
    process.stdout.write('EXCLUDED-READ-ALLOWED\n')
    process.exitCode = 1
  } catch (error) {
    process.stdout.write(`EXCLUDED-READ-DENIED:${error.code}\n`)
  }
} else {
  throw new Error(`Unknown B21 target scenario: ${scenario}`)
}
