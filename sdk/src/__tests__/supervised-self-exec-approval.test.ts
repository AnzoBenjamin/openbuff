import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const roots: string[] = []
let binary: string
beforeAll(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-self-exec-approval-')); roots.push(root)
  binary = path.join(root, 'openbuff-fixture')
  const build = spawnSync(process.execPath, ['build', path.join(import.meta.dir, 'fixtures/self-exec-approval-entry.ts'), '--compile', '--outfile', binary],
    { cwd: path.resolve(import.meta.dir, '../../..'), encoding: 'utf8', timeout: 120_000 })
  if (build.status !== 0) throw new Error(build.stderr || build.stdout || String(build.error))
}, 120_000)
afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }) })

describe('compiled SDK subagent self-exec approval', () => {
  for (const mode of ['balanced', 'strict']) for (const scenario of ['routine', 'gated-command']) {
    test(`${mode} ${scenario}: supervisor starts freely and child effects retain their approval`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-self-exec-run-')); roots.push(root)
      const run = spawnSync(binary, [root, mode, scenario], { cwd: root, encoding: 'utf8', timeout: 20_000 })
      if (run.status !== 0) throw new Error(run.stderr || run.stdout || String(run.error))
      const line = run.stdout.split('\n').find(line => line.startsWith('SELF_EXEC_RESULT '))
      expect(line).toBeDefined()
      const result = JSON.parse(line!.slice('SELF_EXEC_RESULT '.length))
      expect(result.childStarts).toBe(1)
      expect(result.terminalStarts).toBe(0)
      expect(result.approvals).toEqual(scenario === 'routine' ? [] : ['arbitrary-code'])
      if (scenario === 'routine') expect(JSON.stringify(result.output)).toContain('worked')
    }, 25_000)
  }
})
