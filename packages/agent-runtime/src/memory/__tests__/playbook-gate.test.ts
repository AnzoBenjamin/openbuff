import { MemoryPlaybookSchema } from '@codebuff/common/types/memory-playbook'
import { describe, expect, test } from 'bun:test'

import { evaluatePlaybookGate, resolvePlaybookGateMode } from '../playbook-gate'
import {
  createSessionEvidenceLog,
  recordSessionEvidence,
  SESSION_EVIDENCE_LOG_MAX_ENTRIES,
  sessionEvidenceMatches,
} from '../session-evidence-log'

import type {
  MemoryPlaybook,
  MemoryPlaybook as MemoryPlaybookType,
} from '@codebuff/common/types/memory-playbook'
import type { SessionEvidenceLog } from '../session-evidence-log'

const NOW = 1_000_000_000
const DEFAULT_ENV: Record<string, string | undefined> = {}
const BLOCK_ENV: Record<string, string | undefined> = {
  OPENBUFF_PLAYBOOK_GATE: 'block',
}
const WITHIN_MS = 30 * 60 * 1_000

/**
 * Build a schema-valid playbook fixture. Parsing through MemoryPlaybookSchema
 * keeps the fixtures honest about the (final) common types instead of
 * hand-rolling a shape that could drift.
 */
const makePlaybook = (overrides: {
  trigger: MemoryPlaybookType['trigger']
  enforcement?: MemoryPlaybookType['enforcement']
  status?: MemoryPlaybookType['status']
  expiresAt?: number
  title?: string
  instruction?: string
}): MemoryPlaybook =>
  MemoryPlaybookSchema.parse({
    schemaVersion: 1,
    playbookId: 'pb-1',
    workspaceId: 'ws-1',
    title:
      overrides.title ?? 'Run local CI before spawning the git committer',
    instruction:
      overrides.instruction ?? 'Run `npm run check:ci-local` and fix failures.',
    trigger: overrides.trigger,
    scope: { repos: [] },
    status: overrides.status ?? 'active',
    enforcement: overrides.enforcement ?? 'warn',
    counters: {
      fired: 0,
      blocked: 0,
      compliedAfterBlock: 0,
      falsePositives: 0,
      bypassed: 0,
    },
    provenance: {
      origin: 'derived',
      recordedBy: 'test',
      sourceEventIds: [],
      metadata: {},
    },
    triggerSignature: 'sig-1',
    ...(overrides.expiresAt !== undefined
      ? { expiresAt: overrides.expiresAt }
      : {}),
    createdAt: 1,
    updatedAt: 2,
  })

/** The seeded-style playbook: prove local CI ran before committing. */
const seededCommitterPlaybook = (params?: {
  enforcement?: MemoryPlaybookType['enforcement']
  withinMs?: number
}): MemoryPlaybook =>
  makePlaybook({
    enforcement: params?.enforcement,
    trigger: {
      tool: 'spawn_agents',
      spawnAgentType: 'git-committer',
      requireEvidence: [
        {
          kind: 'toolSucceeded',
          tool: 'run_terminal_command',
          commandPattern: '*check:ci-local*',
          withinMs: params?.withinMs ?? WITHIN_MS,
        },
      ],
    },
  })

const spawnCommitterInput: Record<string, unknown> = {
  agents: [{ agent_type: 'git-committer', prompt: 'commit the change' }],
}

const emptyLog = (): SessionEvidenceLog => createSessionEvidenceLog()

const logWithCiSuccess = (atMs: number): SessionEvidenceLog => {
  const log = createSessionEvidenceLog()
  recordSessionEvidence(log, {
    toolName: 'run_terminal_command',
    commandText: 'npm run check:ci-local',
    atMs,
  })
  return log
}

describe('resolvePlaybookGateMode', () => {
  test('defaults to warn and never upgrades past the env mode', () => {
    expect(resolvePlaybookGateMode({})).toBe('warn')
    expect(resolvePlaybookGateMode({ OPENBUFF_PLAYBOOK_GATE: '  ' })).toBe(
      'warn',
    )
    expect(resolvePlaybookGateMode({ OPENBUFF_PLAYBOOK_GATE: ' BLOCK ' })).toBe(
      'block',
    )
    expect(resolvePlaybookGateMode({ OPENBUFF_PLAYBOOK_GATE: 'off' })).toBe(
      'off',
    )
    // An unrecognized value falls back to warn, never to a hard block.
    expect(
      resolvePlaybookGateMode({ OPENBUFF_PLAYBOOK_GATE: 'block-everything' }),
    ).toBe('warn')
  })
})

describe('session evidence log', () => {
  test('caps at the most-recent entries', () => {
    const log = emptyLog()
    for (let i = 0; i < SESSION_EVIDENCE_LOG_MAX_ENTRIES + 50; i += 1) {
      recordSessionEvidence(log, {
        toolName: 'run_terminal_command',
        commandText: `cmd-${i}`,
        atMs: i,
      })
    }
    expect(log.entries).toHaveLength(SESSION_EVIDENCE_LOG_MAX_ENTRIES)
    expect(log.entries[0]?.commandText).toBe('cmd-50')
    expect(log.entries.at(-1)?.commandText).toBe('cmd-249')
  })

  test('matches by tool, wildcard-wrapped substring, and recency window', () => {
    const log = emptyLog()
    recordSessionEvidence(log, {
      toolName: 'run_terminal_command',
      commandText: 'npm run CHECK:ci-local',
      atMs: 1_000,
    })
    expect(
      sessionEvidenceMatches(log, {
        tool: 'run_terminal_command',
        commandPattern: '*check:ci-local*',
        nowMs: 1_000,
      }),
    ).toBe(true)
    expect(
      sessionEvidenceMatches(log, {
        tool: 'run_terminal_command',
        commandPattern: '*check:ci-local*',
        withinMs: 500,
        nowMs: 1_500,
      }),
    ).toBe(true)
    expect(
      sessionEvidenceMatches(log, {
        tool: 'run_terminal_command',
        commandPattern: '*check:ci-local*',
        withinMs: 500,
        nowMs: 1_501,
      }),
    ).toBe(false)
    expect(
      sessionEvidenceMatches(log, { tool: 'spawn_agents', nowMs: 1_000 }),
    ).toBe(false)
  })
})

describe('evaluatePlaybookGate', () => {
  test('(a) no playbooks -> no verdicts', () => {
    expect(
      evaluatePlaybookGate({
        toolName: 'spawn_agents',
        input: spawnCommitterInput,
        playbooks: [],
        evidenceLog: emptyLog(),
        nowMs: NOW,
        env: BLOCK_ENV,
      }),
    ).toEqual([])
    expect(
      evaluatePlaybookGate({
        toolName: 'spawn_agents',
        input: spawnCommitterInput,
        playbooks: undefined,
        evidenceLog: emptyLog(),
        nowMs: NOW,
        env: BLOCK_ENV,
      }),
    ).toEqual([])
  })

  test("(b) env mode 'off' -> no verdicts", () => {
    expect(
      evaluatePlaybookGate({
        toolName: 'spawn_agents',
        input: spawnCommitterInput,
        playbooks: [
          seededCommitterPlaybook({ enforcement: 'block' }),
        ],
        evidenceLog: emptyLog(),
        nowMs: NOW,
        env: { OPENBUFF_PLAYBOOK_GATE: 'off' },
      }),
    ).toEqual([])
  })

  test('(c) missing evidence warns by default and blocks under block mode', () => {
    const playbook = seededCommitterPlaybook({ enforcement: 'block' })
    const warned = evaluatePlaybookGate({
      toolName: 'spawn_agents',
      input: spawnCommitterInput,
      playbooks: [playbook],
      evidenceLog: emptyLog(),
      nowMs: NOW,
      env: DEFAULT_ENV,
    })
    expect(warned).toHaveLength(1)
    expect(warned[0]?.outcome).toBe('warned')
    if (warned[0]?.outcome !== 'warned') throw new Error('expected a warning')
    expect(warned[0].playbook.playbookId).toBe('pb-1')
    expect(warned[0].message).toContain(playbook.title)
    expect(warned[0].message).toContain(playbook.instruction)
    expect(warned[0].message).toContain(
      'a successful run_terminal_command matching *check:ci-local*',
    )

    const blocked = evaluatePlaybookGate({
      toolName: 'spawn_agents',
      input: spawnCommitterInput,
      playbooks: [playbook],
      evidenceLog: emptyLog(),
      nowMs: NOW,
      env: BLOCK_ENV,
    })
    expect(blocked).toHaveLength(1)
    expect(blocked[0]?.outcome).toBe('blocked')

    // A 'warn' enforcement can never escalate to a block.
    const downgraded = evaluatePlaybookGate({
      toolName: 'spawn_agents',
      input: spawnCommitterInput,
      playbooks: [seededCommitterPlaybook()],
      evidenceLog: emptyLog(),
      nowMs: NOW,
      env: BLOCK_ENV,
    })
    expect(downgraded[0]?.outcome).toBe('warned')
  })

  test('(d) matching evidence recorded in-session allows the call', () => {
    expect(
      evaluatePlaybookGate({
        toolName: 'spawn_agents',
        input: spawnCommitterInput,
        playbooks: [seededCommitterPlaybook({ enforcement: 'block' })],
        evidenceLog: logWithCiSuccess(NOW - 1_000),
        nowMs: NOW,
        env: BLOCK_ENV,
      }),
    ).toEqual([])
  })

  test('(e) evidence older than withinMs still warns', () => {
    const verdicts = evaluatePlaybookGate({
      toolName: 'spawn_agents',
      input: spawnCommitterInput,
      playbooks: [seededCommitterPlaybook()],
      evidenceLog: logWithCiSuccess(NOW - WITHIN_MS - 1),
      nowMs: NOW,
      env: DEFAULT_ENV,
    })
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]?.outcome).toBe('warned')
  })

  test('(f) a non-matching agent type is allowed', () => {
    const playbook = seededCommitterPlaybook({ enforcement: 'block' })
    expect(
      evaluatePlaybookGate({
        toolName: 'spawn_agents',
        input: { agents: [{ agent_type: 'editor' }] },
        playbooks: [playbook],
        evidenceLog: emptyLog(),
        nowMs: NOW,
        env: BLOCK_ENV,
      }),
    ).toEqual([])
    // A publisher-qualified, VERSION-PINNED spelling of the same agent still
    // matches: normalizeSpawnAgentType deliberately preserves the publisher
    // and `@version` suffix, so the gate compares with the shared parseAgentId
    // (agent-name segment + optional publisher/version constraints). A version
    // pin must not be a bypass of the rule that governs the underlying agent.
    expect(
      evaluatePlaybookGate({
        toolName: 'spawn_agents',
        input: { agents: [{ agent_type: 'codebuff/git-committer@1.0.0' }] },
        playbooks: [playbook],
        evidenceLog: emptyLog(),
        nowMs: NOW,
        env: BLOCK_ENV,
      })[0]?.outcome,
    ).toBe('blocked')
    // A genuinely DIFFERENT agent id under any publisher/version is allowed —
    // only the agent-name segment must match the playbook's target.
    expect(
      evaluatePlaybookGate({
        toolName: 'spawn_agents',
        input: { agents: [{ agent_type: 'codebuff/git-committer-helper' }] },
        playbooks: [playbook],
        evidenceLog: emptyLog(),
        nowMs: NOW,
        env: BLOCK_ENV,
      }),
    ).toEqual([])
    // spawn_agent_inline carries a single top-level agent_type.
    expect(
      evaluatePlaybookGate({
        toolName: 'spawn_agent_inline',
        input: { agent_type: 'git-committer' },
        playbooks: [
          makePlaybook({
            enforcement: 'block',
            trigger: {
              tool: 'spawn_agent_inline',
              spawnAgentType: 'git-committer',
              requireEvidence: [{ kind: 'toolSucceeded', tool: 'read_files' }],
            },
          }),
        ],
        evidenceLog: emptyLog(),
        nowMs: NOW,
        env: BLOCK_ENV,
      })[0]?.outcome,
    ).toBe('blocked')
  })

  test('(g) git push matches a git-push playbook and unrelated commands do not', () => {
    const pushPlaybook = makePlaybook({
      title: 'Push only after local CI',
      trigger: {
        tool: 'run_terminal_command',
        terminalAction: 'git-push',
        requireEvidence: [
          {
            kind: 'toolSucceeded',
            tool: 'run_terminal_command',
            commandPattern: '*check:ci-local*',
          },
        ],
      },
    })
    const evaluate = (command: string) =>
      evaluatePlaybookGate({
        toolName: 'run_terminal_command',
        input: { command },
        playbooks: [pushPlaybook],
        evidenceLog: emptyLog(),
        nowMs: NOW,
        env: DEFAULT_ENV,
      })

    expect(evaluate('git push -q')).toHaveLength(1)
    expect(evaluate('git -C repo push origin main')).toHaveLength(1)
    expect(evaluate('ls -la')).toEqual([])
    expect(evaluate('echo git push')).toEqual([])
    expect(evaluate('npm run check:ci-local')).toEqual([])
  })

  test('(h) retired and expired playbooks never fire', () => {
    const base = seededCommitterPlaybook({ enforcement: 'block' })
    const run = (playbook: MemoryPlaybook) =>
      evaluatePlaybookGate({
        toolName: 'spawn_agents',
        input: spawnCommitterInput,
        playbooks: [playbook],
        evidenceLog: emptyLog(),
        nowMs: NOW,
        env: BLOCK_ENV,
      })

    expect(run({ ...base, status: 'retired' })).toEqual([])
    expect(run({ ...base, status: 'candidate' })).toEqual([])
    expect(run({ ...base, expiresAt: NOW })).toEqual([])
    expect(run({ ...base, expiresAt: NOW - 1 })).toEqual([])
    expect(run({ ...base, expiresAt: NOW + 1 })).toHaveLength(1)
  })

  test('(i) unknown evidence kinds fail closed', () => {
    const playbook = makePlaybook({
      enforcement: 'block',
      trigger: {
        tool: 'run_terminal_command',
        terminalAction: 'git-commit',
        requireEvidence: [
          { kind: 'fileDigestUnchanged', path: 'src/index.ts' },
        ],
      },
    })
    const input = { command: 'git commit -m "wip"' }

    const warned = evaluatePlaybookGate({
      toolName: 'run_terminal_command',
      input,
      playbooks: [playbook],
      evidenceLog: emptyLog(),
      nowMs: NOW,
      env: DEFAULT_ENV,
    })
    expect(warned).toHaveLength(1)
    expect(warned[0]?.outcome).toBe('warned')

    const blocked = evaluatePlaybookGate({
      toolName: 'run_terminal_command',
      input,
      playbooks: [playbook],
      evidenceLog: emptyLog(),
      nowMs: NOW,
      env: BLOCK_ENV,
    })
    expect(blocked[0]?.outcome).toBe('blocked')
  })
})
