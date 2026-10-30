import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

// Importing this module is side-effect free: main() only runs under
// `if (import.meta.main)`, so a static import is safe under bun test.
import { isProcessRunning, isTrackedServiceProcess } from '../start-services'

// Larger than any allocatable PID on every supported platform (Linux caps
// pid_max at 2^22), so no live process can ever occupy it.
const DEAD_PID = 2 ** 31 - 1

/**
 * Read a live process's start time the same way start-services.ts does
 * (Linux /proc/<pid>/stat field 22, elsewhere `ps -o lstart=`), so the
 * recorded value fed to isTrackedServiceProcess matches what the module's
 * own identity read produces. Test-side helper only — the module's
 * readProcessStartTime is not exported and is not refactored here.
 */
function readLiveStartTime(pid: number): string | null {
  if (process.platform === 'linux' && existsSync(`/proc/${pid}/stat`)) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
      const afterComm = stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(' ')
      return afterComm[19] ?? null
    } catch {
      return null
    }
  }
  try {
    const lstart = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    }).trim()
    return lstart.length > 0 ? lstart : null
  } catch {
    return null
  }
}

const EXECUTABLE_NAME = basename(process.execPath).replace(/\.exe$/, '')
const EXECUTABLE_IS_TRACKED_KIND =
  EXECUTABLE_NAME === 'bun' || EXECUTABLE_NAME === 'node'
const CAN_SPAWN_TRACKED_FIXTURE =
  process.platform !== 'win32' && EXECUTABLE_IS_TRACKED_KIND

let tmpRoot: string
let child: ChildProcess | null = null

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'svc-ownership-'))
  mkdirSync(join(tmpRoot, 'sdk'), { recursive: true })
  writeFileSync(
    join(tmpRoot, 'sdk', 'package.json'),
    JSON.stringify(
      { name: 'fixture-sdk', version: '0.0.0', scripts: { build: 'sleep 2' } },
      null,
      2,
    ),
  )
})

afterEach(() => {
  // Only this test's own spawned fixture child is ever signalled.
  if (child) {
    try {
      child.kill('SIGKILL')
    } catch {
      // Ignore: the child may have already exited.
    }
    child = null
  }
  if (existsSync(tmpRoot)) {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** Spawn the exact tracked argv (`bun run --cwd sdk build`) rooted at the
 * fixture sdk package whose build script only sleeps — nothing real is
 * built, and terminateProcess is never invoked anywhere in this file. */
function spawnTrackedBuild(): ChildProcess {
  child = spawn(process.execPath, ['run', '--cwd', 'sdk', 'build'], {
    cwd: tmpRoot,
    stdio: 'ignore',
  })
  return child
}

describe('isProcessRunning', () => {
  test('returns true for the current process', () => {
    expect(isProcessRunning(process.pid)).toBe(true)
  })

  test('returns false for a PID no live process can occupy', () => {
    expect(isProcessRunning(DEAD_PID)).toBe(false)
  })

  // The EPERM branch (a live process we lack permission to signal must count
  // as running) cannot be fabricated portably in a test: it would require a
  // live process owned by another user, so it is left untested rather than
  // mocked.
})

describe('isTrackedServiceProcess fails closed', () => {
  test('rejects this test process, whose argv is not the tracked build', () => {
    expect(isTrackedServiceProcess(process.pid, 'any start time')).toBe(false)
  })

  test('rejects a dead PID', () => {
    expect(isTrackedServiceProcess(DEAD_PID, 'any start time')).toBe(false)
  })
})

describe('isTrackedServiceProcess ownership checks', () => {
  test.skipIf(!CAN_SPAWN_TRACKED_FIXTURE)(
    'accepts a live process running the tracked argv with the recorded start time',
    async () => {
      const tracked = spawnTrackedBuild()
      await waitFor(
        () =>
          isProcessRunning(tracked.pid!) &&
          readLiveStartTime(tracked.pid!) !== null,
      )

      const startTime = readLiveStartTime(tracked.pid!)
      expect(startTime).not.toBeNull()
      expect(isTrackedServiceProcess(tracked.pid!, startTime)).toBe(true)
    },
  )

  test.skipIf(!CAN_SPAWN_TRACKED_FIXTURE)(
    'rejects the tracked argv when the recorded start time does not match',
    async () => {
      const tracked = spawnTrackedBuild()
      await waitFor(() => isProcessRunning(tracked.pid!))

      expect(
        isTrackedServiceProcess(tracked.pid!, 'not the recorded start time'),
      ).toBe(false)
    },
  )

  test.skipIf(!CAN_SPAWN_TRACKED_FIXTURE)(
    'rejects the tracked argv when no start time was recorded (fails closed)',
    async () => {
      const tracked = spawnTrackedBuild()
      await waitFor(() => isProcessRunning(tracked.pid!))

      expect(isTrackedServiceProcess(tracked.pid!, null)).toBe(false)
    },
  )
})
