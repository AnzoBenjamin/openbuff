import { describe, expect, test } from 'bun:test'
import {
  previewTurnRestore,
  restorePreviewedTurn,
  TURN_SNAPSHOT_REF,
  type GitRunner,
} from '../turn-snapshots'

const sha = 'a'.repeat(40)
function fixture() {
  const commands: string[][] = []
  let patch = 'diff --git a/a.ts b/a.ts\n-old\n+new\n'
  let untracked = ''
  const runGit: GitRunner = async (args) => {
    commands.push(args)
    if (args[0] === 'log')
      return { stdout: `${sha} 1730000000 turn\n`, stderr: '' }
    if (args[0] === 'ls-tree') return { stdout: 'a.ts\0', stderr: '' }
    if (args[0] === 'ls-files') return { stdout: untracked, stderr: '' }
    if (args[0] === 'diff')
      return {
        stdout: args.includes('--name-only') ? 'a.ts\0' : patch,
        stderr: '',
      }
    if (args[0] === 'rev-parse') return { stdout: sha + '\n', stderr: '' }
    if (args[0] === 'merge-base') return { stdout: '', stderr: '' }
    return { stdout: '', stderr: '' }
  }
  return {
    commands,
    deps: { runGit },
    changePatch: () => {
      patch += '+intervening edit\n'
    },
    collide: () => {
      untracked = 'a.ts\0'
    },
  }
}

describe('snapshot restore evidence', () => {
  test('preview reads tracked differences and never performs checkout', async () => {
    const f = fixture()
    const preview = await previewTurnRestore(
      sha.slice(0, 12),
      { projectRoot: '/injected/project' },
      f.deps,
    )
    expect(preview.status).toBe('ready')
    if (preview.status !== 'ready') throw new Error('preview unavailable')
    expect(preview.sha).toBe(sha)
    expect(preview.files).toEqual(['a.ts'])
    expect(preview.diff).toContain('+new')
    expect(
      f.commands.some((args) =>
        ['read-tree', 'checkout-index', 'update-ref'].includes(args[0]!),
      ),
    ).toBe(false)
  })
  test('changed working-tree content invalidates a displayed apply action', async () => {
    const f = fixture()
    const preview = await previewTurnRestore(
      sha,
      { projectRoot: '/injected/project' },
      f.deps,
    )
    if (preview.status !== 'ready') throw new Error('preview unavailable')
    f.changePatch()
    const result = await restorePreviewedTurn(preview, f.deps)
    expect(result.status).toBe('error')
    if (result.status !== 'error') throw new Error('expected freshness failure')
    expect(result.message).toContain('changed after this preview')
    expect(f.commands.some((args) => args[0] === 'checkout-index')).toBe(false)
  })
  test('untracked collisions prevent preview and restore', async () => {
    const f = fixture()
    f.collide()
    const preview = await previewTurnRestore(
      sha,
      { projectRoot: '/injected/project' },
      f.deps,
    )
    expect(preview.status).toBe('error')
    expect(f.commands.some((args) => args[0] === 'checkout-index')).toBe(false)
  })
})
