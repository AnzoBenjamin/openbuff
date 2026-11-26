import { expect, test } from 'bun:test'
import { execFile, execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { setProjectRoot } from '../../project-files'
import { useChatStore } from '../../state/chat-store'
import {
  createTurnSnapshot,
  TURN_SNAPSHOT_REF,
} from '../../utils/turn-snapshots'
import { runBashCommand } from '../router'

const run = promisify(execFile)

test('a second actual shell dispatch cannot write before a pending turn snapshot samples the tree', async () => {
  const cwd = process.cwd()
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), 'openbuff-b04-dispatch-')),
  )
  const file = path.join(root, 'tracked.txt')
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  let held!: () => void
  const atAdd = new Promise<void>((resolve) => {
    held = resolve
  })
  let release!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  let capture: ReturnType<typeof createTurnSnapshot> | undefined
  try {
    git('init', '-q')
    writeFileSync(file, 'committed\n')
    git('add', 'tracked.txt')
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'baseline',
    )
    writeFileSync(file, 'first turn\n')
    process.chdir(root)
    setProjectRoot(root)
    useChatStore.getState().reset()
    capture = createTurnSnapshot(
      { projectRoot: root, label: 'first turn' },
      {
        runGit: async (args, options) => {
          if (args[0] === 'add' && args[1] === '-u') {
            held()
            await barrier
          }
          return run('git', args, { ...options, encoding: 'utf8' })
        },
      },
    )
    await Promise.race([
      atAdd,
      capture.then((outcome) => {
        throw new Error(
          `Snapshot did not reach the owned barrier: ${JSON.stringify(outcome)}`,
        )
      }),
    ])

    // Use the production shell router and SDK terminal dispatcher, not a mock
    // of the mutation. The original path would run this before Git samples.
    const mutation = "printf '%s\\n' 'second dispatch' > tracked.txt"
    await runBashCommand(mutation)
    const beforeRelease = readFileSync(file, 'utf8')
    const refused = JSON.stringify(useChatStore.getState().messages)
    release()
    expect((await capture).status).toBe('created')
    const captured = git('show', `${TURN_SNAPSHOT_REF}:tracked.txt`)
    expect(beforeRelease).toBe('first turn\n')
    expect(captured).toBe('first turn\n')
    expect(refused).toMatch(
      /another snapshot or bisection owns the repository gate/i,
    )

    // The same command is available once the conflicting capture settles.
    await runBashCommand(mutation)
    expect(readFileSync(file, 'utf8')).toBe('second dispatch\n')
    console.log(
      JSON.stringify({
        b04: 'pre-add-u-shell-dispatch-refusal',
        beforeRelease,
        captured,
        mutationAfterRelease: readFileSync(file, 'utf8'),
      }),
    )
  } finally {
    release()
    await capture
    process.chdir(cwd)
    setProjectRoot(cwd)
    useChatStore.getState().reset()
    rmSync(root, { recursive: true, force: true })
  }
}, 15_000)
