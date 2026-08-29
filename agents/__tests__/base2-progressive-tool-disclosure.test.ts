import { describe, expect, mock, test } from 'bun:test'

import { loopAgentSteps } from '@codebuff/agent-runtime/run-agent-step'
import { getToolSet } from '@codebuff/agent-runtime/tools/prompts'
import { getEffectiveAgentToolNames } from '@codebuff/agent-runtime/util/agent-tool-names'
import {
  ALLOW_ALL_TIER_TOOLS,
  BASE2_CORE_TOOL_NAMES,
  BASE2_TIER_TOOL_NAMES,
  filterByUnlockedTiers,
} from '@codebuff/agent-runtime/util/base2-tool-tiers'
import { countTokensJson } from '@codebuff/agent-runtime/util/token-counter'
import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { createTestAgentRuntimeParams } from '@codebuff/common/testing/fixtures/agent-runtime'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { promptSuccess } from '@codebuff/common/util/error'
import { assistantMessage, userMessage } from '@codebuff/common/util/messages'

import { createBase2 } from '../base2/base2'
import {
  resolveModelToolNames,
  type UnlockedToolTier,
} from '../base2/tool-tiers'

import type { AgentTemplate } from '@codebuff/agent-runtime/templates/types'
import type { StepGenerator } from '@codebuff/common/types/agent-template'
import type { SkillsMap } from '@codebuff/common/types/skill'
import type { AgentState } from '@codebuff/common/types/session-state'

const PROGRAMMATIC_TOOL_NAMES = [
  'spawn_agent_inline',
  'git_status',
  'run_file_change_hooks',
  'inspect_codebase_structure',
  'get_change_review_bundle',
  'inspect_environment',
  'get_affected_tests',
  'get_build_targets',
] as const

function buildRepresentativeSkills(count: number): SkillsMap {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => {
      const name = `skill-${index}`
      return [
        name,
        {
          name,
          description: `Representative skill ${index}: ${'detailed capability guidance '.repeat(12)}`,
          content: `# ${name}`,
          filePath: `/skills/${name}/SKILL.md`,
        },
      ]
    }),
  )
}

async function toolSurfaceTokenCount(toolNames: string[]): Promise<number> {
  const tools = await getToolSet({
    toolNames,
    additionalToolDefinitions: async () => ({}),
    agentTools: {},
    skills: buildRepresentativeSkills(40),
  })
  const tokenShape = Object.entries(tools).map(([name, tool]) => {
    const inputSchema = (tool as { inputSchema?: unknown }).inputSchema
    return {
      name,
      ...(tool.description && { description: tool.description }),
      ...(inputSchema ? { input_schema: inputSchema } : {}),
    }
  })
  return countTokensJson(tokenShape)
}

describe('base2 progressive tool disclosure (M1)', () => {
  test('the default surface is the full mode-resolved surface', () => {
    const agent = createBase2('default')
    // Explicit expected surface rather than a re-derivation via
    // resolveModelToolNames (createBase2 calls that same function with these
    // same defaults, so comparing against it could never fail). CORE order
    // first, then implement/audit/media_3d/job_extra in canonical tier order,
    // minus run_terminal_command (execute-plan only, and default mode is not
    // executePlan). Any change to CORE, the tier map, or the mode gates must
    // fail loudly here.
    expect(agent.toolNames).toEqual([
      'spawn_agents',
      'query_index',
      'read_files',
      'read_outline',
      'read_subtree',
      'list_directory',
      'glob',
      'code_search',
      'ask_user',
      'skill',
      'suggest_followups',
      'write_todos',
      'list_jobs',
      'check_job',
      'check_background_agent',
      'read_logs',
      'edit_transaction',
      'create_plan',
      'update_plan_status',
      'inspect_workspace',
      'inspect_environment',
      'get_affected_tests',
      'get_build_targets',
      'run_targeted_validation',
      'inspect_codebase_structure',
      'inspect_feature_completeness',
      'evaluate_audit_coverage',
      'get_change_review_bundle',
      'get_task',
      'read_image',
      'inspect_3d_asset',
      'render_3d_preview',
      'edit_3d_asset',
      'kill_job',
    ])
  })

  test('mode gates apply across every gate combination', () => {
    // Exercise every mode-gate combination: each surface stays within the
    // derived CORE + tier set, and the mode-gated tools appear exactly when
    // their gate allows them.
    const derived = new Set<string>([
      ...BASE2_CORE_TOOL_NAMES,
      ...Object.values(BASE2_TIER_TOOL_NAMES).flat(),
    ])
    for (const planOnly of [false, true]) {
      for (const executePlan of [false, true]) {
        for (const noAskUser of [false, true]) {
          for (const mode of ['default', 'fast'] as const) {
            const label = `${mode} planOnly=${planOnly} executePlan=${executePlan} noAskUser=${noAskUser}`
            const surface = resolveModelToolNames({
              mode,
              planOnly,
              executePlan,
              noAskUser,
            })
            const names = new Set<string>(surface)
            expect(surface.length, label).toBe(names.size)
            for (const name of surface) {
              expect(derived.has(name), `${label}:${name}`).toBe(true)
            }
            expect(names.has('ask_user'), label).toBe(!noAskUser)
            expect(names.has('write_todos'), label).toBe(
              mode !== 'fast' && !planOnly,
            )
            expect(names.has('edit_transaction'), label).toBe(!planOnly)
            expect(names.has('run_targeted_validation'), label).toBe(!planOnly)
            expect(names.has('run_terminal_command'), label).toBe(
              !planOnly && executePlan,
            )
          }
        }
      }
    }
  })

  test('createBase2 unlockedTiers passthrough narrows the shipped surface', () => {
    // `unlockedTiers` is the only control that narrows what createBase2 ships.
    const coreOnly = createBase2('default', { unlockedTiers: [] })
    // Explicit expected CORE-only surface (same reason as above: comparing
    // against resolveModelToolNames with the identical arguments createBase2
    // already used cannot fail). Default mode keeps both mode-gated CORE
    // tools (ask_user, write_todos).
    expect(coreOnly.toolNames).toEqual([
      'spawn_agents',
      'query_index',
      'read_files',
      'read_outline',
      'read_subtree',
      'list_directory',
      'glob',
      'code_search',
      'ask_user',
      'skill',
      'suggest_followups',
      'write_todos',
      'list_jobs',
      'check_job',
      'check_background_agent',
      'read_logs',
    ])
    // The dormant runtime ceiling is deliberately NOT narrowed with it: it is
    // the default (all non-core tiers) mode-resolved surface, so flipping
    // progressiveToolDisclosure on could still unlock a tier instead of being
    // stuck CORE-only. The caller's narrowing lives in toolNames above, and
    // progressiveToolDisclosure: false keeps the ceiling unused today.
    expect(
      coreOnly.programmaticConfig?.fullToolSurface as string[] | undefined,
    ).toContain('edit_transaction')

    const implementOnly =
      createBase2('default', { unlockedTiers: ['implement'] }).toolNames ?? []
    expect(implementOnly).toContain('edit_transaction')
    expect(implementOnly).not.toContain('read_image')
    expect(implementOnly).not.toContain('kill_job')
  })

  test('fullToolSurface publishes the default mode-resolved ceiling, not the narrowed surface', () => {
    // The runtime ceiling is only ever membership-tested (agent-tool-names.ts
    // builds a Set from it), and it is dormant while
    // progressiveToolDisclosure is pinned false. It is derived from the
    // DEFAULT (all non-core tiers) mode-resolved surface — the same list the
    // identical mode options WITHOUT `unlockedTiers` ship as toolNames — so a
    // caller-narrowed surface cannot leave behind a ceiling that can never
    // unlock a tier. It is also its own array, so an in-place mutation by
    // either consumer cannot silently move the other.
    const cases: Array<{
      label: string
      options?: Parameters<typeof createBase2>[1]
      // Same mode gates, no caller narrowing: its toolNames IS the ceiling.
      ceilingOptions?: Parameters<typeof createBase2>[1]
    }> = [
      { label: 'defaults' },
      { label: 'core-only narrowing', options: { unlockedTiers: [] } },
      {
        label: 'implement-only narrowing',
        options: { unlockedTiers: ['implement'] },
      },
      {
        label: 'plan-only',
        options: { planOnly: true },
        ceilingOptions: { planOnly: true },
      },
      {
        label: 'execute-plan',
        options: { executePlan: true },
        ceilingOptions: { executePlan: true },
      },
    ]
    for (const { label, options, ceilingOptions } of cases) {
      const agent = createBase2('default', options)
      const ceiling = agent.programmaticConfig?.fullToolSurface
      const expectedCeiling = createBase2('default', ceilingOptions).toolNames
      expect(ceiling, label).toEqual(expectedCeiling)
      expect(ceiling, label).not.toBe(expectedCeiling)
      expect(ceiling, label).not.toBe(agent.toolNames)
    }
  })

  test('planOnly withholds the mutation/execution tools', () => {
    const tools = createBase2('default', { planOnly: true }).toolNames ?? []
    expect(tools).not.toContain('edit_transaction')
    expect(tools).not.toContain('edit_3d_asset')
    expect(tools).not.toContain('run_terminal_command')
    expect(tools).not.toContain('write_todos')
    expect(tools).not.toContain('run_targeted_validation')
  })

  test('planOnly + unlock implement: still no edit_transaction', () => {
    const tools = resolveModelToolNames({
      mode: 'default',
      planOnly: true,
      unlockedTiers: ['implement'],
    })
    expect(tools).toContain('create_plan')
    expect(tools).toContain('inspect_workspace')
    expect(tools).not.toContain('edit_transaction')
    expect(tools).not.toContain('run_targeted_validation')
    expect(tools).not.toContain('run_terminal_command')
    expect(tools).not.toContain('write_todos')
  })

  test('token budget: always-on full tool surface is under 22.5k', async () => {
    // The deliberate new default is the full 34-tool surface (measured ~21.4k
    // tokens). This is a regression ceiling for that decision, not a
    // core-only budget. Kept tight (~5% headroom) so an accidental surface
    // expansion trips it instead of growing silently.
    const tools = createBase2('default').toolNames ?? []
    expect(await toolSurfaceTokenCount(tools)).toBeLessThan(22_500)
  })

  test('programmaticToolNames unchanged vs today', () => {
    for (const options of [
      undefined,
      { unlockedTiers: [] as UnlockedToolTier[] },
      { planOnly: true },
    ]) {
      expect(createBase2('default', options).programmaticToolNames).toEqual([
        ...PROGRAMMATIC_TOOL_NAMES,
      ])
    }
  })
})

describe('tier resolution helpers (M1-T3)', () => {
  describe('getEffectiveAgentToolNames — unlockedToolTiers empty semantics', () => {
    const fullSurfaceTemplate = {
      id: 'tiered',
      displayName: 'Tiered',
      model: 'test-model',
      inputSchema: {},
      outputMode: 'last_message',
      includeMessageHistory: true,
      inheritParentSystemPrompt: false,
      mcpServers: {},
      toolNames: ['spawn_agents', 'read_files', 'edit_transaction', 'kill_job'],
      spawnableAgents: [],
      systemPrompt: 'Test system prompt',
      instructionsPrompt: 'Test instructions prompt',
      stepPrompt: 'Test step prompt',
      programmaticConfig: {
        fullToolSurface: [
          'spawn_agents',
          'read_files',
          'edit_transaction',
          'create_plan',
          'kill_job',
        ],
      },
    } as AgentTemplate

    test('absent unlockedToolTiers leaves the template surface unchanged', () => {
      expect(getEffectiveAgentToolNames(fullSurfaceTemplate)).toEqual([
        'spawn_agents',
        'read_files',
        'edit_transaction',
        'kill_job',
      ])
    })

    test('empty unlockedToolTiers leaves the template surface unchanged (resume/checkpoint contract)', () => {
      // Persisted empty must NOT CORE-filter a full-surface template.
      expect(
        getEffectiveAgentToolNames(fullSurfaceTemplate, {
          unlockedToolTiers: [],
        }),
      ).toEqual(['spawn_agents', 'read_files', 'edit_transaction', 'kill_job'])
    })

    test('non-empty unlockedToolTiers expands CORE + tiers for progressive steps', () => {
      const coreOnlyTemplate = {
        ...fullSurfaceTemplate,
        toolNames: ['spawn_agents', 'read_files'],
      } as AgentTemplate
      const result = getEffectiveAgentToolNames(coreOnlyTemplate, {
        unlockedToolTiers: ['implement'],
      })
      expect(result).toContain('spawn_agents')
      expect(result).toContain('read_files')
      expect(result).toContain('edit_transaction')
      expect(result).toContain('create_plan')
      expect(result).not.toContain('kill_job')
    })

    test('execute-time projection: template.toolNames alone (no agentState) matches progressive surface', () => {
      // Mirrors run-agent-step projecting effective names onto agentTemplate
      // before processStream → executeToolCall, which gates without agentState.
      const coreOnlyTemplate = {
        ...fullSurfaceTemplate,
        toolNames: ['spawn_agents', 'read_files'],
      } as AgentTemplate
      const projected = {
        ...coreOnlyTemplate,
        toolNames: getEffectiveAgentToolNames(coreOnlyTemplate, {
          unlockedToolTiers: ['implement'],
        }),
      } as AgentTemplate
      expect(getEffectiveAgentToolNames(projected)).toContain(
        'edit_transaction',
      )
      expect(getEffectiveAgentToolNames(projected)).not.toContain('kill_job')
    })

    test('canary-off ignores stale non-empty unlockedToolTiers (resume/canary-off contract)', () => {
      // Persisted unlocks from a prior canary-on run must NOT re-activate
      // progressive CORE+tiers filtering when the live template has
      // progressiveToolDisclosure explicitly off (would shrink the surface).
      const canaryOffTemplate = {
        ...fullSurfaceTemplate,
        programmaticConfig: {
          ...fullSurfaceTemplate.programmaticConfig,
          progressiveToolDisclosure: false,
        },
      } as AgentTemplate
      expect(
        getEffectiveAgentToolNames(canaryOffTemplate, {
          unlockedToolTiers: ['implement'],
        }),
      ).toEqual(['spawn_agents', 'read_files', 'edit_transaction', 'kill_job'])
    })

    test('a progressive template omitting fullToolSurface fails closed (no tier tool is appended)', () => {
      // Fail-open-by-omission guard: without a published ceiling there is no
      // mode gate to preserve, so no unlocked tier tool may be appended.
      // Allow-all must be requested explicitly (see the next test).
      const noCeilingTemplate = {
        ...fullSurfaceTemplate,
        toolNames: ['spawn_agents', 'read_files'],
        programmaticConfig: {},
      } as AgentTemplate
      const result = getEffectiveAgentToolNames(noCeilingTemplate, {
        unlockedToolTiers: ['implement'],
      })
      expect(result).toEqual(['spawn_agents', 'read_files'])
      expect(result).not.toContain('edit_transaction')
      expect(result).not.toContain('run_terminal_command')
    })

    test('fullToolSurface: ALLOW_ALL_TIER_TOOLS opts into appending every unlocked tier tool', () => {
      const allowAllTemplate = {
        ...fullSurfaceTemplate,
        toolNames: ['spawn_agents', 'read_files'],
        programmaticConfig: { fullToolSurface: ALLOW_ALL_TIER_TOOLS },
      } as AgentTemplate
      const result = getEffectiveAgentToolNames(allowAllTemplate, {
        unlockedToolTiers: ['implement'],
      })
      expect(result).toContain('edit_transaction')
      expect(result).toContain('run_terminal_command')
    })
  })

  describe('filterByUnlockedTiers', () => {
    test('empty unlockedTiers returns CORE-only tools from the input list', () => {
      // Low-level helper: empty tiers mean CORE-only of the *input* list.
      // getEffectiveAgentToolNames deliberately does NOT call this for
      // absent/empty agentState.unlockedToolTiers (persisted empty = template
      // surface); see packages/agent-runtime/src/util/base2-tool-tiers.ts.
      const result = filterByUnlockedTiers(
        ['spawn_agents', 'read_files', 'edit_transaction', 'kill_job'],
        [],
        // The ceiling is a required parameter; these input lists carry no mode
        // gates, so the tests opt into allow-all explicitly.
        () => true,
      )
      expect(result).toEqual(['spawn_agents', 'read_files'])
    })

    test('ALLOW_ALL_TIER_TOOLS admits every unlocked tier tool (explicit allow-all opt-out)', () => {
      // Pins the explicit-sentinel branch. Allow-all is only ever reachable by
      // passing ALLOW_ALL_TIER_TOOLS: a caller with no ceiling to pass (e.g. a
      // progressive template omitting programmaticConfig.fullToolSurface) must
      // fail closed instead of unlocking run_terminal_command by omission.
      const result = filterByUnlockedTiers(
        ['spawn_agents', 'read_files'],
        ['implement'],
        ALLOW_ALL_TIER_TOOLS,
      )
      expect(result).toEqual([
        'spawn_agents',
        'read_files',
        'edit_transaction',
        'create_plan',
        'update_plan_status',
        'inspect_workspace',
        'inspect_environment',
        'get_affected_tests',
        'get_build_targets',
        'run_targeted_validation',
        'run_terminal_command',
      ])
      // Same result as an explicit allow-all predicate: the sentinel does not
      // narrow.
      expect(result).toEqual(
        filterByUnlockedTiers(
          ['spawn_agents', 'read_files'],
          ['implement'],
          () => true,
        ),
      )
    })

    test("unlockedTiers ['implement'] keeps CORE tools plus implement tools", () => {
      const result = filterByUnlockedTiers(
        ['spawn_agents', 'read_files'],
        ['implement'],
        () => true,
      )
      expect(result).toEqual([
        'spawn_agents',
        'read_files',
        'edit_transaction',
        'create_plan',
        'update_plan_status',
        'inspect_workspace',
        'inspect_environment',
        'get_affected_tests',
        'get_build_targets',
        'run_targeted_validation',
        'run_terminal_command',
      ])
    })

    test("unlockedTiers ['implement', 'audit'] keeps CORE + implement + audit tools", () => {
      const result = filterByUnlockedTiers(
        ['spawn_agents', 'read_files'],
        ['implement', 'audit'],
        () => true,
      )
      expect(result).toEqual([
        'spawn_agents',
        'read_files',
        'edit_transaction',
        'create_plan',
        'update_plan_status',
        'inspect_workspace',
        'inspect_environment',
        'get_affected_tests',
        'get_build_targets',
        'run_targeted_validation',
        'run_terminal_command',
        'inspect_codebase_structure',
        'inspect_feature_completeness',
        'evaluate_audit_coverage',
        'get_change_review_bundle',
        'get_task',
      ])
      expect(result).not.toContain('read_image')
      expect(result).not.toContain('kill_job')
    })

    test("unlockedTiers ['media_3d', 'job_extra'] keeps CORE + media + kill_job", () => {
      const result = filterByUnlockedTiers(
        ['spawn_agents', 'read_files', 'edit_transaction'],
        ['media_3d', 'job_extra'],
        () => true,
      )
      expect(result).toEqual([
        'spawn_agents',
        'read_files',
        'read_image',
        'inspect_3d_asset',
        'render_3d_preview',
        'edit_3d_asset',
        'kill_job',
      ])
    })

    test('all four tiers unlocked keeps the full surface', () => {
      const result = filterByUnlockedTiers(
        ['spawn_agents', 'read_files'],
        ['implement', 'audit', 'media_3d', 'job_extra'],
        () => true,
      )
      expect(result).toEqual([
        'spawn_agents',
        'read_files',
        'edit_transaction',
        'create_plan',
        'update_plan_status',
        'inspect_workspace',
        'inspect_environment',
        'get_affected_tests',
        'get_build_targets',
        'run_targeted_validation',
        'run_terminal_command',
        'inspect_codebase_structure',
        'inspect_feature_completeness',
        'evaluate_audit_coverage',
        'get_change_review_bundle',
        'get_task',
        'read_image',
        'inspect_3d_asset',
        'render_3d_preview',
        'edit_3d_asset',
        'kill_job',
      ])
    })

    test('templateAllows prevents adding tier tools outside the full surface', () => {
      // Plan-only style ceiling: edit_transaction is not in the full surface.
      const fullSurface = ['spawn_agents', 'read_files', 'create_plan']
      const result = filterByUnlockedTiers(
        ['spawn_agents', 'read_files'],
        ['implement'],
        (name) => fullSurface.includes(name),
      )
      expect(result).toEqual(['spawn_agents', 'read_files', 'create_plan'])
      expect(result).not.toContain('edit_transaction')
    })

    test('preserves template order for tools already in the input list', () => {
      const result = filterByUnlockedTiers(
        ['create_plan', 'read_files', 'edit_transaction'],
        ['implement'],
        () => true,
      )
      expect(result).toEqual([
        'create_plan',
        'read_files',
        'edit_transaction',
        'update_plan_status',
        'inspect_workspace',
        'inspect_environment',
        'get_affected_tests',
        'get_build_targets',
        'run_targeted_validation',
        'run_terminal_command',
      ])
    })

    test('does not duplicate tools already present', () => {
      const result = filterByUnlockedTiers(
        ['spawn_agents', 'edit_transaction'],
        ['implement'],
        () => true,
      )
      const occurrences = result.filter((name) => name === 'edit_transaction')
      expect(occurrences).toHaveLength(1)
    })

    test('sanitizes persisted unlockedTiers: non-string, core, unknown, dupes', () => {
      // unlockedTiers carries persisted AgentState.unlockedToolTiers, so it is
      // untrusted: non-string entries, the unconditional 'core' pseudo-tier,
      // unknown tier names, and repeated entries must all be ignored without
      // widening or duplicating the surface.
      const result = filterByUnlockedTiers(
        ['spawn_agents', 'read_files'],
        [null, 42, 'core', 'nope', 'implement', 'implement'],
        () => true,
      )
      expect(result).toEqual([
        'spawn_agents',
        'read_files',
        'edit_transaction',
        'create_plan',
        'update_plan_status',
        'inspect_workspace',
        'inspect_environment',
        'get_affected_tests',
        'get_build_targets',
        'run_targeted_validation',
        'run_terminal_command',
      ])
      // The bogus 'nope' tier contributed nothing, and the duplicated
      // 'implement' entry unlocked its tools exactly once.
      expect(new Set(result).size).toBe(result.length)
    })

    test('templateAllows gates only the append path, never the keep path', () => {
      // Documented asymmetry: a tier tool the template already lists is KEPT
      // even when the mode ceiling rejects it (the static toolNames list is
      // already mode-resolved), while the same tool is never APPENDED.
      const rejectsEdits = (name: string) => name !== 'edit_transaction'
      const kept = filterByUnlockedTiers(
        ['spawn_agents', 'edit_transaction'],
        ['implement'],
        rejectsEdits,
      )
      expect(kept).toContain('edit_transaction')
      expect(kept.indexOf('edit_transaction')).toBe(1)

      const notAppended = filterByUnlockedTiers(
        ['spawn_agents'],
        ['implement'],
        rejectsEdits,
      )
      expect(notAppended).not.toContain('edit_transaction')
    })
  })
})

// Tier membership needs no list-equality tests: agents/base2/tool-tiers.ts
// CONSUMES the runtime lists directly (BASE2_CORE_TOOL_NAMES /
// BASE2_TIER_TOOL_NAMES from
// packages/agent-runtime/src/util/base2-tool-tiers.ts), and
// resolveModelToolNames DERIVES its surface from those constants, so a tier
// added there flows into the surfaced set automatically. These tests pin the
// derivation itself.
describe('base2 tier membership — resolveModelToolNames stays in sync', () => {
  test('progressive core-only surface matches BASE2_CORE_TOOL_NAMES exactly', () => {
    // In the default mode (ask_user + write_todos both allowed) the CORE-only
    // surface must equal the runtime constant, so a tool added or removed on
    // either side fails loudly instead of silently changing the surface.
    const coreOnly = resolveModelToolNames({
      mode: 'default',
      unlockedTiers: [],
    })
    // Bidirectional membership over string sets — avoids the ToolName[] sort()
    // widening that would break the AllToolNames[] toEqual overload, while still
    // making a one-sided edit to either list fail loudly. Each direction is
    // checked against the OTHER list's set so neither loop is vacuous.
    const coreSet = new Set<string>(BASE2_CORE_TOOL_NAMES)
    const surfacedSet = new Set<string>(coreOnly)
    expect(coreOnly.length).toBe(coreSet.size)
    for (const name of coreOnly) {
      expect(coreSet.has(name)).toBe(true)
    }
    for (const name of BASE2_CORE_TOOL_NAMES) {
      expect(surfacedSet.has(name)).toBe(true)
    }
  })

  test('mode-gated CORE tools stay within BASE2_CORE_TOOL_NAMES', () => {
    // fast + noAskUser drops the mode-gated CORE tools (ask_user/write_todos).
    // Every remaining surfaced name must still be a declared CORE member so
    // the mode-gated variants cannot diverge from (or exceed) the constant.
    const gated = resolveModelToolNames({
      mode: 'fast',
      noAskUser: true,
      unlockedTiers: [],
    })
    const coreSet = new Set<string>(BASE2_CORE_TOOL_NAMES)
    for (const name of gated) {
      expect(coreSet.has(name)).toBe(true)
    }
    expect(gated).not.toContain('ask_user')
    expect(gated).not.toContain('write_todos')
  })

  test('every runtime tier contributes its tools to the default surface', () => {
    // Derivation guard: the default unlock set is Object.keys of the runtime
    // tier map, so a newly added fifth tier must contribute tools here instead
    // of silently contributing none.
    const surface = new Set<string>(
      resolveModelToolNames({
        mode: 'default',
        executePlan: true,
      }),
    )
    for (const [tier, toolNames] of Object.entries(BASE2_TIER_TOOL_NAMES)) {
      for (const name of toolNames) {
        expect(surface.has(name), `${tier}:${name}`).toBe(true)
      }
    }
  })

  test('plan mode excludes every mutation/execution tool enumerated from the tier map', () => {
    // Mode-sensitivity guard for the hardcoded modeAllowsTool switch in
    // agents/base2/tool-tiers.ts. Enumerate every CORE/tier tool whose name
    // marks it as a mutation or execution surface (`edit_*`, `run_*`,
    // `write_*`, `apply_*`, `delete_*`) and assert plan mode withholds all of
    // them, so a future tool like `write_file` / `apply_patch` / `delete_path`
    // added to BASE2_TIER_TOOL_NAMES without extending modeAllowsTool fails
    // here instead of silently becoming always-on in plan mode.
    //
    // `create_*` is deliberately outside the pattern: create_plan is the one
    // plan-mode-legal writer (authoring a plan is the point of plan mode), so
    // matching it would make this guard fail on intended behavior.
    const mutationOrExecution = /^(?:edit_|run_|write_|apply_|delete_)/
    const mutationTools = [
      ...BASE2_CORE_TOOL_NAMES,
      ...Object.values(BASE2_TIER_TOOL_NAMES).flat(),
    ].filter((name) => mutationOrExecution.test(name))
    // Non-vacuous: the lists currently declare edit_transaction,
    // run_targeted_validation, run_terminal_command, edit_3d_asset (tiers) and
    // write_todos (CORE).
    expect(mutationTools).toContain('edit_transaction')
    expect(mutationTools).toContain('run_terminal_command')
    expect(mutationTools).toContain('write_todos')
    expect(mutationTools.length).toBeGreaterThanOrEqual(5)
    // The documented exception stays explicit: create_plan is a writer that
    // plan mode intentionally keeps.
    expect(mutationTools).not.toContain('create_plan')

    // executePlan is deliberately on: planOnly must win over it, so even
    // run_terminal_command stays withheld.
    const planSurface = new Set<string>(
      resolveModelToolNames({
        mode: 'default',
        planOnly: true,
        executePlan: true,
      }),
    )
    for (const name of mutationTools) {
      expect(planSurface.has(name), name).toBe(false)
    }
    // write_todos is CORE and matched via the `write_` prefix above; pin it
    // explicitly too so the CORE side of the gate cannot regress even if the
    // prefix pattern is narrowed later.
    expect(planSurface.has('write_todos')).toBe(false)
    // create_plan is excluded from the pattern on purpose, so pin the intended
    // behavior directly: plan mode keeps it.
    expect(planSurface.has('create_plan')).toBe(true)
  })
})

// RF-4 coverage: exercise the runtime wiring end-to-end. The pure
// filterByUnlockedTiers tests cover the helper, but not that
// loopAgentSteps/run-agent-step re-invokes it per step with the fresh agent
// state. This drives a real loopAgentSteps loop whose fake handleSteps mutates
// agentState.unlockedToolTiers between steps and asserts the ToolSet offered
// to the LLM on step 2 reflects the tiers unlocked during step 1.
describe('progressive tool disclosure — runtime wiring (loopAgentSteps)', () => {
  function buildTieredAgentTemplate(): AgentTemplate {
    // Progressive canary-on: static toolNames = CORE (+ end_turn for the final
    // step mock). fullToolSurface is the mode-resolved ceiling so non-empty
    // unlocks can re-add IMPLEMENT tools. Empty unlockedToolTiers leaves
    // toolNames unchanged (resume contract) — do not put implement tools on the
    // static surface or a step with [] published would still expose
    // edit_transaction.
    const fullSurface = [
      ...BASE2_CORE_TOOL_NAMES,
      ...BASE2_TIER_TOOL_NAMES.implement,
      'end_turn',
    ]
    return {
      id: 'tiered-agent',
      displayName: 'Tiered Agent',
      spawnerPrompt: 'Testing progressive tool disclosure wiring',
      model: 'claude-3-5-sonnet-20241022',
      inputSchema: {},
      outputMode: 'last_message',
      includeMessageHistory: true,
      inheritParentSystemPrompt: false,
      mcpServers: {},
      toolNames: [...BASE2_CORE_TOOL_NAMES, 'end_turn'],
      spawnableAgents: [],
      systemPrompt: 'Test system prompt',
      instructionsPrompt: 'Test instructions prompt',
      stepPrompt: 'Test step prompt',
      programmaticConfig: { fullToolSurface: fullSurface },
    } as AgentTemplate
  }

  test('tools offered on each step reflect tiers unlocked AND re-locked (shrink) by handleSteps across the turn', async () => {
    const agentTemplate = buildTieredAgentTemplate()

    // Same generator is resumed across loop iterations: yield STEP each time
    // so each subsequent LLM call runs after the programmatic step mutates
    // agentState.unlockedToolTiers (do not branch on a call counter and only
    // yield once — that ends the generator early).
    //
    // Covers BOTH directions of a mid-turn tier change:
    //   step 1 → core-only; programmatic unlocks implement
    //   step 2 → implement tools present; programmatic shrinks back to []
    //   step 3 → implement tools removed again (smaller rebuilt ToolSet)
    agentTemplate.handleSteps = function* ({
      agentState,
    }: {
      agentState: AgentState
    }) {
      // Step 1: core-only before first LLM call.
      agentState.unlockedToolTiers = []
      yield 'STEP'
      // Step 2: unlock implement before second LLM call (EXPAND).
      agentState.unlockedToolTiers = ['implement']
      yield 'STEP'
      // Step 3: shrink back to core-only before third LLM call (SHRINK).
      agentState.unlockedToolTiers = []
      yield 'STEP'
    } as () => StepGenerator

    const {
      agentTemplate: _defaultTemplate,
      localAgentTemplates: _defaultLocalTemplates,
      ...runtimeParams
    } = createTestAgentRuntimeParams()

    // Capture the tool names offered to the LLM on each step.
    const offeredToolNamesPerStep: string[][] = []
    let llmCallCount = 0
    runtimeParams.promptAiSdkStream = mock(async function* ({ tools }) {
      llmCallCount += 1
      offeredToolNamesPerStep.push(Object.keys(tools ?? {}))
      yield { type: 'text' as const, text: 'LLM response\n\n' }
      if (llmCallCount < 3) {
        // Steps 1 & 2: a non-ending tool call (read_files) so the loop
        // continues to the next iteration, where handleSteps changes
        // unlockedToolTiers (expand, then shrink).
        yield {
          type: 'tool-call' as const,
          toolName: 'read_files',
          toolCallId: `read-files-${llmCallCount}`,
          input: { paths: ['file1.txt'] },
        }
      } else {
        // Step 3: end the turn.
        yield {
          type: 'tool-call' as const,
          toolName: 'end_turn',
          toolCallId: `end-turn-${llmCallCount}`,
          input: {},
        }
      }
      return promptSuccess('mock-message-id')
    })

    const sessionState = getInitialSessionState(runtimeParams.fileContext)
    const agentState: AgentState = {
      ...sessionState.mainAgentState,
      agentId: 'tiered-agent-id',
      messageHistory: [
        userMessage('Initial message'),
        assistantMessage('Initial response'),
      ],
      stepsRemaining: 10,
    }

    await loopAgentSteps({
      ...runtimeParams,
      agentType: 'tiered-agent',
      agentTemplate,
      localAgentTemplates: { 'tiered-agent': agentTemplate },
      repoId: undefined,
      repoUrl: undefined,
      userInputId: 'test-user-input',
      agentState,
      prompt: 'Test prompt',
      spawnParams: undefined,
      fingerprintId: 'test-fingerprint',
      fileContext: runtimeParams.fileContext,
      userId: TEST_USER_ID,
      clientSessionId: 'test-session',
      ancestorRunIds: [],
      onResponseChunk: () => {},
      signal: new AbortController().signal,
    })

    // Three LLM steps ran (one per loop iteration before end_turn).
    expect(llmCallCount).toBe(3)

    // Step 1: core-only surface — no implement-tier tool is offered.
    const step1Tools = offeredToolNamesPerStep[0]
    expect(step1Tools).toContain('read_files')
    expect(step1Tools).not.toContain('edit_transaction')
    expect(step1Tools).not.toContain('run_terminal_command')

    // Step 2 (EXPAND): the implement tier unlocked during the step-1
    // programmatic step is now reflected in the rebuilt ToolSet.
    const step2Tools = offeredToolNamesPerStep[1]
    expect(step2Tools).toContain('read_files')
    expect(step2Tools).toContain('edit_transaction')
    expect(step2Tools).toContain('create_plan')

    // Step 3 (SHRINK ['implement'] -> []): the implement tier re-locked during
    // the step-2 programmatic step is removed from the rebuilt, smaller ToolSet.
    const step3Tools = offeredToolNamesPerStep[2]
    expect(step3Tools).toContain('read_files')
    expect(step3Tools).toContain('end_turn')
    expect(step3Tools).not.toContain('edit_transaction')
    expect(step3Tools).not.toContain('create_plan')
    expect(step3Tools).not.toContain('run_terminal_command')
    expect(step3Tools.length).toBeLessThan(step2Tools.length)
  })
})
