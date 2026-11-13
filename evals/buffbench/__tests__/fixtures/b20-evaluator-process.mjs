import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [mode, root, variant = 'redirected'] = process.argv.slice(2)
const fixturePath = fileURLToPath(import.meta.url)
const readyPath = join(root, 'ready.json')
const markerPath = join(root, 'late-marker')
const stat = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch {
    return null
  }
}
const announce = (extra = {}) =>
  writeFileSync(
    readyPath,
    JSON.stringify({
      leaderPid: process.pid,
      leaderStat: stat(process.pid),
      runtime: {
        node: process.versions.node,
        bun: process.versions.bun ?? null,
      },
      readyAtMs: performance.now(),
      ...extra,
    }),
  )

if (mode === 'normal') {
  process.stdout.write('first\n')
  process.stderr.write('first-stderr\n')
  announce()
  const finish = setInterval(() => {
    if (!existsSync(join(root, 'go'))) return
    clearInterval(finish)
    process.stdout.write('last-é✅\n')
    process.stderr.write('last-stderr-é✅\n')
  }, 2)
} else if (mode === 'wait' || mode === 'quota' || mode === 'abort-output') {
  process.on('SIGTERM', () => {
    writeFileSync(join(root, 'term-observed'), String(performance.now()))
    if (mode === 'abort-output') {
      process.stdout.write(Buffer.alloc(11 * 1024 * 1024, 120))
    }
  })
  announce()
  setTimeout(() => writeFileSync(markerPath, 'owned writer survived'), 900)
  if (mode === 'quota') {
    const chunk = Buffer.alloc(64 * 1024, 120)
    setInterval(() => {
      if (existsSync(join(root, 'go'))) process.stdout.write(chunk)
    }, 2)
  } else {
    setInterval(() => {}, 1_000)
  }
} else if (mode === 'descendant') {
  process.on('SIGTERM', () =>
    writeFileSync(join(root, 'descendant-term'), String(performance.now())),
  )
  writeFileSync(
    join(root, 'descendant-ready.json'),
    JSON.stringify({
      descendantPid: process.pid,
      descendantStat: stat(process.pid),
    }),
  )
  setTimeout(() => writeFileSync(markerPath, 'descendant survived'), 900)
  setInterval(() => {
    if (variant === 'inherited') process.stdout.write('descendant-write\n')
  }, 10)
} else if (
  mode === 'early-leader' ||
  mode === 'normal-leader' ||
  mode === 'failed-leader'
) {
  const descendant = spawn(
    process.execPath,
    [
      ...(process.versions.bun ? ['--no-env-file'] : []),
      fixturePath,
      'descendant',
      root,
      variant,
    ],
    {
      stdio:
        variant === 'inherited' ? ['ignore', 'inherit', 'inherit'] : 'ignore',
      env: process.env,
    },
  )
  descendant.unref()
  process.on('SIGTERM', () => {
    writeFileSync(join(root, 'leader-term'), String(performance.now()))
    process.stdout.write('leader-final\n', () => process.exit(0))
  })
  const wait = setInterval(() => {
    const descendantReady = join(root, 'descendant-ready.json')
    if (!existsSync(descendantReady)) return
    clearInterval(wait)
    announce(JSON.parse(readFileSync(descendantReady, 'utf8')))
    if (mode !== 'early-leader') {
      process.stdout.write('leader-final\n', () => {
        setTimeout(() => process.exit(mode === 'failed-leader' ? 2 : 0), 20)
      })
    }
  }, 2)
  if (mode === 'early-leader') setInterval(() => {}, 1_000)
} else {
  throw new Error(`Unknown evaluator fixture mode: ${mode}`)
}
