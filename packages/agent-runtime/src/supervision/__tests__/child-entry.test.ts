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
import { createInitialWorkspaceState } from '@codebuff/common/types/workspace-state'

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildChildAgentState,
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
  it('every request yields a schema-valid FAILED receipt with code unsupported-deps', async () => {
    const receipt = await runSupervisedChildEntry(makeRequest())
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
    const missing = missingChildCallbackDeps(makeRequest())
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

describe('child-state rehydration validation (json-roundtrip repair)', () => {
  it('a valid serialized child state rehydrates into the rebuilt AgentState', () => {
    const state = buildChildAgentState({
      ...makeRequest(),
      child: {
        agentId: 'child-entry-agent-1',
        messageHistory: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }], sentAt: 1234 },
        ],
        systemPrompt: 'be brief',
        taskMemory: {
          schemaVersion: 1,
          revision: 2,
          updatedAt: 5,
          checksum: 'abc123',
        },
        workspaceState: createInitialWorkspaceState(1000),
        contextTokenCount: 42,
      },
      ancestorRunIds: ['run-1'],
    })
    expect(state.agentId).toBe('child-entry-agent-1')
    expect(state.systemPrompt).toBe('be brief')
    expect(state.contextTokenCount).toBe(42)
    expect(state.ancestorRunIds).toEqual(['run-1'])
    expect(state.messageHistory).toHaveLength(1)
    expect(state.taskMemory?.revision).toBe(2)
    expect(state.workspaceState?.revision).toBe(0)
  })

  it('a messageHistory whose sentAt was coerced to an ISO string by the JSON round trip is DROPPED, not blind-cast', () => {
    // Simulates the wire: a live Date timestamp serialized to an ISO string.
    const state = buildChildAgentState({
      ...makeRequest(),
      child: {
        agentId: 'child-entry-agent-1',
        messageHistory: [
          { role: 'user', content: [], sentAt: new Date(0).toISOString() },
        ],
      },
    })
    // The fresh initial-state default stands in — the malformed field never
    // reaches loopAgentSteps under the live Message[] type.
    expect(state.messageHistory).toEqual([])
  })

  it('a taskMemory that fails its schema validation is DROPPED, not blind-cast', () => {
    const state = buildChildAgentState({
      ...makeRequest(),
      child: {
        agentId: 'child-entry-agent-1',
        // Missing the required revision/updatedAt/checksum members.
        taskMemory: { schemaVersion: 1, goal: 'x' } as unknown,
      },
    })
    expect(state.taskMemory).toBeUndefined()
  })

  it('a workspaceState whose occurredAt was coerced to an ISO string is DROPPED, not blind-cast', () => {
    const base = createInitialWorkspaceState(1000)
    // A DROPPED field leaves the fresh initial-state default standing in
    // (see the buildChildAgentState docblock), so assert against a baseline
    // request that carries no workspaceState at all.
    const baseline = buildChildAgentState({
      ...makeRequest(),
      child: { agentId: 'baseline-1' },
    })
    const state = buildChildAgentState({
      ...makeRequest(),
      child: {
        agentId: 'child-entry-agent-1',
        workspaceState: {
          ...base,
          updatedAt: '1970-01-01T00:00:01.000Z',
          changes: [
            {
              revision: 1,
              source: 'edit',
              occurredAt: '1970-01-01T00:00:01.000Z',
              actions: [],
            },
          ],
        },
      },
    })
    expect(state.workspaceState).toEqual(baseline.workspaceState)
  })

  it('a workspaceState with an invalid schemaVersion is DROPPED, not blind-cast', () => {
    const baseline = buildChildAgentState({
      ...makeRequest(),
      child: { agentId: 'baseline-1' },
    })
    const state = buildChildAgentState({
      ...makeRequest(),
      child: {
        agentId: 'child-entry-agent-1',
        workspaceState: { ...createInitialWorkspaceState(1), schemaVersion: 2 },
      },
    })
    expect(state.workspaceState).toEqual(baseline.workspaceState)
  })

  it.skipIf(!canSpawn)(
    'a non-JSON-serializable request settles a structured crashed result instead of throwing across the spawnSupervised seam',
    async () => {
      const seam = buildDefaultSpawnSupervised({ openbuffApiKey: 'sk-test' })
      // A circular child-state field makes the parent-side JSON.stringify
      // throw; the seam must encode that as outcome 'crashed' — never an
      // uncaught exception across the seam boundary.
      const circular: Record<string, unknown> = { agentId: 'circular-1' }
      circular.self = circular
      const result = await seam({
        ...makeRequest(),
        child: circular as unknown as SupervisedSpawnRequest['child'],
      })
      expect(result.outcome).toBe('crashed')
      expect(result.crashReason).toContain('not JSON-serializable')
      expect(result.exitCode).toBeNull()
    },
  )
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
        // The extended P2-T8 seed (provider-config override, proxy, TMPDIR,
        // locale, ripgrep override) flows through the default seam without
        // disturbing the child-entry contract; the supervisor forwards the
        // built allowlist verbatim.
        passthroughEnv: {
          OPENBUFF_PROVIDER_CONFIG: '/tmp/openbuff-provider.json',
          HTTPS_PROXY: 'http://proxy.test:8443',
          TMPDIR: '/tmp/child-entry-test',
          CODEBUFF_RG_PATH: '/opt/openbuff/vendor/rg',
        },
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
