import { describe, expect, test } from 'bun:test'

import { createBase2 } from '../base2/base2'
import { gitDisciplineSection } from '../base2/quality-prompt-section'
import {
  BASE2_PROGRAMMATIC_TOOL_NAMES,
  SPAWN_CONTRACT_DELEGATED_PARAMS,
  buildSpawnContractClauses,
  deriveSpawnParamSummary,
  getSpawnContractClauseCoverage,
} from '../base2/spawn-contract'
import basher from '../basher'
import dependencyManager from '../dependency-manager/dependency-manager'
import generalAgent from '../general-agent/general-agent'
import librarian from '../librarian/librarian'

// The retired hand-written paragraph from base2's system prompt (D17). The
// derived builder must reproduce it byte-for-byte, so pin it here and assert
// equality — a drifting fallback clause fails here without touching any prompt
// snapshot.
const EXPECTED_SPAWN_CONTRACT_PARAGRAPH = [
  'basher needs `params.command` (a shell string)',
  'general-agent needs prompt + params.filePaths/directoryPaths (not files)',
  'thinker needs prompt packet (params only depth/outputSchemaHint)',
  'dependency-manager needs params.manager+params.operation from manifest evidence',
  'architect/advisory needs prompt+files (snapshot_id optional)',
  'reviewer-family manual spawns omit params.snapshot_id (security-reviewer needs changed_files+snapshot_fingerprint)',
].join('; ')

type InputParamsLike = {
  required?: unknown
  properties?: Record<string, unknown>
}

function inputParamsOf(definition: unknown): InputParamsLike | undefined {
  if (typeof definition !== 'object' || definition === null) return undefined
  const inputSchema = (definition as Record<string, unknown>).inputSchema
  if (typeof inputSchema !== 'object' || inputSchema === null) return undefined
  const params = (inputSchema as Record<string, unknown>).params
  if (typeof params !== 'object' || params === null) return undefined
  return params as InputParamsLike
}

function requiredParamKeys(definition: unknown): string[] {
  const required = inputParamsOf(definition)?.required
  return Array.isArray(required)
    ? required.filter((key): key is string => typeof key === 'string')
    : []
}

function declaredParamType(definition: unknown, key: string): string {
  const property = inputParamsOf(definition)?.properties?.[key]
  const type = (property as { type?: unknown } | undefined)?.type
  return typeof type === 'string' ? type : 'value'
}

describe('base2 spawn contract (D17)', () => {
  test('BASE2_PROGRAMMATIC_TOOL_NAMES is the exact 8-name programmatic list', () => {
    expect(BASE2_PROGRAMMATIC_TOOL_NAMES).toEqual([
      'spawn_agent_inline',
      'git_status',
      'run_file_change_hooks',
      'inspect_codebase_structure',
      'get_change_review_bundle',
      'inspect_environment',
      'get_affected_tests',
      'get_build_targets',
    ])
  })

  test('createBase2 publishes the shared list, fresh per call', () => {
    const first = createBase2('default')
    const second = createBase2('default')
    expect(first.programmaticToolNames).toEqual([
      ...BASE2_PROGRAMMATIC_TOOL_NAMES,
    ])
    // Each call owns its own array, so an in-place mutation by one consumer
    // cannot move another's (the inline literal this constant replaced had
    // the same per-call property).
    expect(first.programmaticToolNames).not.toBe(second.programmaticToolNames)
  })

  test('derived clause emission is byte-identical to the retired prose', () => {
    expect(buildSpawnContractClauses()).toBe(EXPECTED_SPAWN_CONTRACT_PARAGRAPH)
  })

  test('base2 embeds the derived paragraph at the original sentence position in every mode', () => {
    const agents = [
      createBase2('default'),
      createBase2('fast'),
      createBase2('default', { planOnly: true }),
    ]
    for (const agent of agents) {
      expect(agent.systemPrompt).toContain(
        `or the spawn fails: ${EXPECTED_SPAWN_CONTRACT_PARAGRAPH}; put these in`,
      )
    }
  })

  test('emitted clauses cover every agent in the default spawnable roster', () => {
    const roster = (createBase2('default').spawnableAgents ?? []) as string[]
    const covered = new Set<string>()
    for (const segment of getSpawnContractClauseCoverage()) {
      for (const id of segment.agentIds) covered.add(id)
    }
    for (const id of Object.keys(SPAWN_CONTRACT_DELEGATED_PARAMS)) {
      covered.add(id)
    }
    const uncovered = roster.filter((id) => !covered.has(id))
    expect(uncovered).toEqual([])
  })

  test('emitted clauses name the schema-required params (derivation, not prose-sync)', () => {
    const coverage = getSpawnContractClauseCoverage()
    const clauseFor = (id: string): string => {
      const segment = coverage.find((entry) => entry.agentIds.includes(id))
      expect(segment).toBeDefined()
      return segment?.clause ?? ''
    }

    // basher: inputSchema.params.required = ['command'].
    expect(requiredParamKeys(basher)).toEqual(['command'])
    expect(clauseFor('basher')).toContain('params.command')
    expect(deriveSpawnParamSummary(basher)).toBe(
      `params.command (${declaredParamType(basher, 'command')})`,
    )

    // dependency-manager: required = ['manager', 'operation']; the derived
    // summary order follows the schema's required order.
    expect(requiredParamKeys(dependencyManager)).toEqual([
      'manager',
      'operation',
    ])
    const dependencyClause = clauseFor('dependency-manager')
    expect(dependencyClause).toContain('params.manager')
    expect(dependencyClause).toContain('params.operation')
    expect(deriveSpawnParamSummary(dependencyManager)).toBe(
      requiredParamKeys(dependencyManager)
        .map((key) =>
          `params.${key} (${declaredParamType(dependencyManager, key)})`,
        )
        .join(', '),
    )

    // general-agent's inputSchema.params declares properties but NO required
    // array, so derivation yields no clause and the legacy fallback wording
    // carries the contract — it must still track the params the schema
    // declares as properties.
    expect(inputParamsOf(generalAgent)?.required).toBeUndefined()
    expect(deriveSpawnParamSummary(generalAgent)).toBe('')
    const generalClause = clauseFor('general-agent')
    expect(generalClause).toContain('params.filePaths')
    expect(generalClause).toContain('directoryPaths')
    for (const key of ['filePaths', 'directoryPaths']) {
      expect(inputParamsOf(generalAgent)?.properties).toHaveProperty(key)
    }
  })

  test('deriveSpawnParamSummary derives summaries from inputSchema.required', () => {
    expect(
      deriveSpawnParamSummary({
        inputSchema: {
          params: {
            properties: { alpha: { type: 'string' }, beta: { type: 'array' } },
            required: ['alpha', 'beta'],
          },
        },
      }),
    ).toBe('params.alpha (string), params.beta (array)')
    // No required params / no params schema / no inputSchema -> no clause.
    expect(
      deriveSpawnParamSummary({ inputSchema: { params: { required: [] } } }),
    ).toBe('')
    expect(deriveSpawnParamSummary({ inputSchema: {} })).toBe('')
    expect(deriveSpawnParamSummary({})).toBe('')
    expect(deriveSpawnParamSummary(undefined)).toBe('')
  })

  test('delegated required params are documented on their owning surfaces', () => {
    // git-committer: owned_paths guidance is owned by gitDisciplineSection
    // (which base2 also interpolates), so the clause list stays byte-identical
    // to the retired prose.
    expect(gitDisciplineSection).toContain('owned_paths')
    // librarian: repoUrl is documented on the spawn catalog line.
    expect(librarian.spawnerPrompt).toContain('repoUrl')
    for (const note of Object.values(SPAWN_CONTRACT_DELEGATED_PARAMS)) {
      expect(note.length).toBeGreaterThan(0)
    }
  })

  test('clause emission is deterministic', () => {
    expect(buildSpawnContractClauses()).toBe(buildSpawnContractClauses())
    expect(getSpawnContractClauseCoverage()).toEqual(
      getSpawnContractClauseCoverage(),
    )
  })
})
