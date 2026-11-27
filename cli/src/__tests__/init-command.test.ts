import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { describe, expect, test } from 'bun:test'

import { isRendererCommand, parseCliArgs } from '../cli-args'

const entry = path.resolve(import.meta.dir, '../binary-entry.ts')

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-root-init-'))
  const project = path.join(root, 'project')
  fs.mkdirSync(project)
  const env: NodeJS.ProcessEnv = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    USER: process.env.USER,
    NODE_ENV: 'test',
    OPENBUFF_TELEMETRY: '0',
    DO_NOT_TRACK: '1',
    OPENBUFF_CONFIG_DIR: path.join(root, 'config'),
    OPENBUFF_PROVIDER_CONFIG: path.join(
      root,
      'intentionally-missing-provider-config.json',
    ),
    NEXT_PUBLIC_CODEBUFF_APP_URL: 'http://localhost:3000',
  }
  return { root, project, env }
}

function run(f: ReturnType<typeof fixture>, args: string[] = []) {
  return spawnSync(
    process.execPath,
    ['--no-env-file', entry, 'init', ...args],
    { cwd: f.project, env: f.env, encoding: 'utf8', timeout: 15_000 },
  )
}

describe('root local init', () => {
  test('parses init as a non-renderer command, not a model prompt', () => {
    const args = parseCliArgs(
      ['bun', 'openbuff', 'init', '--cwd', '/fixture'],
      { version: 'test', exitOverride: true },
    )
    expect(args.init).toEqual({ cwd: '/fixture' })
    expect(args.initialPrompt).toBeNull()
    expect(isRendererCommand(args)).toBe(false)
    expect(() =>
      parseCliArgs(['bun', 'openbuff', 'init', 'unexpected'], {
        version: 'test',
        exitOverride: true,
      }),
    ).toThrow()
  })

  test('creates local starters without reading providers or opening a run journal and never overwrites', () => {
    const f = fixture()
    try {
      const result = run(f)
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('Created `knowledge.md`')
      expect(result.stdout).not.toContain('Using environment:')
      expect(result.stderr).not.toContain('provider config')
      expect(
        fs.readFileSync(path.join(f.project, 'knowledge.md'), 'utf8'),
      ).toContain('# Project knowledge')
      for (const name of ['agent-definition.ts', 'tools.ts', 'util-types.ts'])
        expect(
          fs.statSync(path.join(f.project, '.agents', 'types', name)).size,
        ).toBeGreaterThan(0)
      expect(
        fs.existsSync(
          path.join(f.root, 'config', 'state', 'harness', 'run-journal.db'),
        ),
      ).toBe(false)
      fs.writeFileSync(path.join(f.project, 'knowledge.md'), 'USER KNOWLEDGE')
      const repeated = run(f)
      expect(repeated.status).toBe(0)
      expect(repeated.stdout).toContain('already exists')
      expect(
        fs.readFileSync(path.join(f.project, 'knowledge.md'), 'utf8'),
      ).toBe('USER KNOWLEDGE')
      expect(
        fs.readdirSync(f.project).some((name) => name.endsWith('.tmp')),
      ).toBe(false)
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true })
    }
  }, 30_000)

  test('rejects symlinked agent output directories without writing outside the project', () => {
    const f = fixture()
    const outside = path.join(f.root, 'outside')
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(f.project, '.agents'), 'dir')
    try {
      const result = run(f)
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/symlink/i)
      expect(fs.readdirSync(outside)).toEqual([])
      expect(fs.existsSync(path.join(f.project, 'knowledge.md'))).toBe(false)
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true })
    }
  }, 20_000)

  test('honors --cwd without initializing the invocation directory', () => {
    const f = fixture()
    const selected = path.join(f.root, 'selected')
    fs.mkdirSync(selected)
    try {
      const result = run(f, ['--cwd', selected])
      expect(result.status, result.stderr).toBe(0)
      expect(fs.existsSync(path.join(selected, 'knowledge.md'))).toBe(true)
      expect(fs.existsSync(path.join(f.project, 'knowledge.md'))).toBe(false)
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true })
    }
  }, 20_000)

  test('a missing project returns nonzero without creating it', () => {
    const f = fixture()
    const selected = path.join(f.root, 'absent')
    try {
      const result = run(f, ['--cwd', selected])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('openbuff init:')
      expect(fs.existsSync(selected)).toBe(false)
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true })
    }
  }, 20_000)
})
