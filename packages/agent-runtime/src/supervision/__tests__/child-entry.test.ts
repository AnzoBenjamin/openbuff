/**
 * P2-T8: child-entry contract tests.
 *
 *  - The child emits EXACTLY ONE newline-terminated JSON envelope that
 *    validates against `agentReceiptSchema`, exit 0.
 *  - Missing argv / corrupt request file → exit 1 with NO envelope written.
 *  - Honest degradation: every request yields the structured
 *    'unsupported-deps' FAILED receipt (never a crash, never a half-run).
 *  - Real-process + default-seam end-to-end (skipIf no Bun.spawn).
 */
import { agentReceiptSchema } from '@codebuff/common/types/agent-handoff'

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildUnsupportedDepsReceipt,
  missingChildCallbackDeps,
  runChildEntryMain,
  runSupervisedChildEntry,
} from '../child-entry'
import { buildDefaultSpawnSupervised } from '../supervised-spawn'

import type { AgentReceipt } from '@codebuff/common/types/agent-handoff'
import type { SupervisedSpawnRequest } from '@codebuff/common/types/contracts/agent-runtime'

const canSpawn =
  typeof Bun !== 'undefined' && typeof Bun.spawn === 'function'

function captureWrite(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = []
  return { lines, write: (line) => { lines.push(line) } }
}

function makeRequest(
  overrides: Partial<SupervisedSpawnRequest> = {},
): SupervisedSpawnRequest {
  return {
    agentType: 'thinker',
    prompt: 'Probe',
    spawnParams: undefined,
    child: { agentId: 'child-entry-agent-1' },
    ...overrides,
  }
}

describe('child-entry honest degradation (P2-T8)', () => {
  it('every request yields a schema-valid FAILED receipt with code unsupported-deps', () => {
    const receipt = runSupervisedChildEntry(makeRequest())
    const parsed = agentReceiptSchema.safeParse(receipt)
    expect(parsed.success).toBe(true)
    expect(receipt.status).toBe('failed')
    expect(receipt.outcome).toBe('crashed')
    expect(receipt.agentId).toBe('child-entry-agent-1')
    expect(receipt.errors).toHaveLength(1)
    expect(receipt.errors[0]?.code).toBe('unsupported-deps')
    expect(receipt.errors[0]?.message).toContain('thinker')
  })

  it('the missing-deps gate fails closed: all callback deps are reported missing', () => {
    const missing = missingChildCallbackDeps()
    expect(missing.length).toBeGreaterThan(0)
    expect(missing).toContain('promptAiSdkStream')
    expect(missing).toContain('sendAction')
    expect(missing).toContain('requestToolCall')
    const receipt = buildUnsupportedDepsReceipt({
      agentType: 'thinker',
      agentId: 'agent-1',
      missing,
    })
    expect(agentReceiptSchema.safeParse(receipt).success).toBe(true)
  })
})

describe('child-entry process contract (P2-T8)', () => {
  it('writes EXACTLY ONE newline-terminated JSON envelope and exits 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'child-entry-test-'))
    try {
      const requestPath = join(dir, 'request.json')
      writeFileSync(requestPath, JSON.stringify(makeRequest()))
      const { lines, write } = captureWrite()
      const exitCode = await runChildEntryMain(
        ['bun', 'child-entry.ts', requestPath],
        write,
      )
      expect(exitCode).toBe(0)
      expect(lines).toHaveLength(1)
      expect(lines[0].endsWith('\n')).toBe(true)
      const parsed = agentReceiptSchema.safeParse(JSON.parse(lines[0]))
      expect(parsed.success).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('missing request-file argv: exit 1, no envelope written', async () => {
    const { lines, write } = captureWrite()
    const exitCode = await runChildEntryMain(['bun', 'child-entry.ts'], write)
    expect(exitCode).toBe(1)
    expect(lines).toHaveLength(0)
  })

  it('corrupt request file: exit 1, no envelope written (crash classification upstream)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'child-entry-test-'))
    try {
      const requestPath = join(dir, 'request.json')
      writeFileSync(requestPath, 'not json at all')
      const { lines, write } = captureWrite()
      const exitCode = await runChildEntryMain(
        ['bun', 'child-entry.ts', requestPath],
        write,
      )
      expect(exitCode).toBe(1)
      expect(lines).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!canSpawn)(
    'real child process: exactly one newline-terminated envelope on stdout, exit 0',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'child-entry-proc-'))
      try {
        const requestPath = join(dir, 'request.json')
        writeFileSync(requestPath, JSON.stringify(makeRequest()))
        const proc = Bun.spawn(
          [
            process.execPath,
            'run',
            join(import.meta.dir, '../child-entry.ts'),
            requestPath,
          ],
          { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        )
        const stdout = await new Response(proc.stdout).text()
        const exitCode = await proc.exited
        expect(exitCode).toBe(0)
        expect(stdout.endsWith('\n')).toBe(true)
        const lines = stdout.split('\n').filter((line) => line.trim().length > 0)
        expect(lines).toHaveLength(1)
        const parsed = agentReceiptSchema.safeParse(JSON.parse(lines[0]))
        expect(parsed.success).toBe(true)
        expect(
          (parsed.data as AgentReceipt).errors[0]?.code,
        ).toBe('unsupported-deps')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(!canSpawn)(
    'default seam end-to-end: the supervised child degrades honestly with an unsupported-deps receipt',
    async () => {
      const seam = buildDefaultSpawnSupervised({
        openbuffApiKey: 'sk-supervised-test',
      })
      const settled = await seam(makeRequest())
      // The child reported its honest degradation; the supervisor settles a
      // valid envelope as 'ok' at the transport level and preserves the
      // child-declared failed receipt untouched.
      expect(settled.outcome).toBe('ok')
      expect(settled.exitCode).toBe(0)
      const receipt = settled.receipt as AgentReceipt
      expect(receipt.status).toBe('failed')
      expect(receipt.errors[0]?.code).toBe('unsupported-deps')
      expect(receipt.agentId).toBe('child-entry-agent-1')
    },
  )
})
