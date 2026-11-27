import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const cliRoot = path.resolve(import.meta.dir, '../..')

function runEntry(...args: string[]) {
  return spawnSync(process.execPath, ['run', 'src/binary-entry.ts', ...args], {
    cwd: cliRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEBUFF_CLI_VERSION: 'test-version',
    },
  })
}

test('version exits before initializing the CLI environment', () => {
  const result = runEntry('--version')

  expect(result.status).toBe(0)
  expect(result.stdout.trim()).toBe('test-version')
  expect(result.stdout).not.toContain('Using environment:')
  expect(result.stderr).toBe('')
})

test('help uses the normal command definitions without initializing the TUI', () => {
  const result = runEntry('--help')

  expect(result.status).toBe(0)
  expect(result.stdout).toContain('Usage: openbuff')
  expect(result.stdout).toContain('Commands:')
  expect(result.stdout).not.toContain('Using environment:')
})

test('ordinary commands continue to the main entry', async () => {
  const { runFastCliPath } = await import('../fast-cli')

  await expect(runFastCliPath(['bun', 'openbuff', 'a prompt'])).resolves.toBe(
    false,
  )
})
