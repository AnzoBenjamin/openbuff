import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const [directory, mode, role] = process.argv.slice(2)
const identity = () => ({ pid: process.pid, stat: readFileSync(`/proc/${process.pid}/stat`, 'utf8') })
if (role === 'descendant') {
  process.on('SIGTERM', () => {})
  writeFileSync(path.join(directory, 'descendant.json'), JSON.stringify(identity()))
  setTimeout(() => writeFileSync(path.join(directory, 'late-marker'), 'owned late write'), 650)
  setInterval(() => {}, 1_000)
} else {
  writeFileSync(path.join(directory, 'leader.json'), JSON.stringify(identity()))
  if (mode === 'normal') {
    process.stdout.write('last stdout é✅')
    process.stderr.write('last stderr é✅')
  } else if (mode === 'quota') {
    process.on('SIGTERM', () => {})
    process.stdout.write('x'.repeat(12 * 1024 * 1024))
    setTimeout(() => writeFileSync(path.join(directory, 'late-marker'), 'quota late write'), 650)
    setInterval(() => {}, 1_000)
  } else {
    spawn(process.execPath, [new URL(import.meta.url).pathname, directory, mode, 'descendant'], {
      stdio: mode === 'inherited-pipe' ? ['ignore', 'inherit', 'inherit'] : 'ignore',
    })
    if (mode === 'leader-exit') setTimeout(() => process.exit(0), 100)
    else { process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1_000) }
  }
}
