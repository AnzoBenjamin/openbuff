import { describe, expect, mock, test } from 'bun:test'

import { loopAgentSteps } from '@codebuff/agent-runtime/run-agent-step'
import { getToolSet } from '@codebuff/agent-runtime/tools/prompts'
import { getEffectiveAgentToolNames } from '@codebuff/agent-runtime/util/agent-tool-names'
import {
  BASE2_CORE_TOOL_NAMES,
  BASE2_TIER_TOOL_NAMES,
  filterByUnlockedTiers,
} from '@codebuff/agent-runtime/util/base2-tool-tiers'
import { countTokensJson } from '@codebuff/agent-runtime/util/token-counter'
import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { createTestAgentRuntimeParams } from '@codebuff/common/testing/fixtures/agent-runtime'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { promptSuccess } from '@codebuff/common/util/error'
import {
  assistantMessage,
  userMessage,
} from '@codebuff/common/util/messages'

import {
  createBase2,
  getPublishUnlockedToolTiers,
  getPublishUnlockedToolTiersWithCanary,
} from '../base2/base2'
import {
  AUDIT_TOOLS,
  CORE_TOOLS,
  deriveIntentSignals,
  IMPLEMENT_TOOLS,
  isEnvFlagEnabled,
  isProgressiveToolDisclosureEnvEnabled,
  JOB_EXTRA_TOOLS,
  MEDIA_3D_TOOLS,
  resolveModelToolNames,
  resolveUnlockedTiersForPhase,
  type ToolTier,
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
] as const

const CORE_ALWAYS = [
  'spawn_agents',
  'query_index',
  'read_files',
  'read_outline',
  'read_subtree',
  'list_directory',
  'glob',
  'code_search',
  'skill',
  'suggest_followups',
  'list_jobs',
  'check_job',
  'check_background_agent',
  'read_logs',
] as const

const IMPLEMENT_SAMPLE = [
  'edit_transaction',
  'create_plan',
  'update_plan_status',
  'inspect_workspace',
  'inspect_environment',
  'get_affected_tests',
  'get_build_targets',
] as const

const AUDIT_SAMPLE = [
  'inspect_codebase_structure',
  'inspect_feature_completeness',
  'evaluate_audit_coverage',
  'get_change_review_bundle',
  'get_task',
] as const

const MEDIA_SAMPLE = [
  'read_image',
  'inspect_3d_asset',
  'render_3d_preview',
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
  test('flag default on / omit option equals explicit true core-only surface', () => {
    const implicit = createBase2('default')
    const explicitOn = createBase2('default', {
      progressiveToolDisclosure: true,
    })
    const explicitOff = createBase2('default', {
      progressiveToolDisclosure: false,
    })
    // Default flipped ON: implicit is core-only, explicit false is full surface
    expect(implicit.toolNames).toEqual(explicitOn.toolNames)
    expect(implicit.toolNames).not.toEqual(explicitOff.toolNames)
    expect(implicit.toolNames).toEqual(
      resolveModelToolNames({
        mode: 'default',
        progressiveToolDisclosure: true,
      }),
    )
  })

  test('flag off explicit: full surface contains implement/audit/media/job tools', () => {
    const tools = createBase2('default', {
      progressiveToolDisclosure: false,
    }).toolNames ?? []
    expect(tools).toContain('edit_transaction')
    expect(tools).toContain('inspect_codebase_structure')
    expect(tools).toContain('inspect_feature_completeness')
    expect(tools).toContain('kill_job')
    expect(tools).toContain('read_image')
    expect(tools).toContain('edit_3d_asset')
    expect(tools).toContain('create_plan')
    expect(tools).toContain('run_targeted_validation')
    expect(tools).toContain('code_search')
  })

  test('CORE_TOOLS includes root content-search tool', () => {
    expect(CORE_TOOLS).toContain('code_search')
  })

  test('flag on core-only: CORE present; IMPLEMENT/AUDIT/MEDIA/JOB_EXTRA absent', () => {
    const tools = createBase2('default', {
      progressiveToolDisclosure: true,
    }).toolNames ?? []

    for (const name of CORE_ALWAYS) {
      expect(tools).toContain(name)
    }
    expect(tools).toContain('ask_user')
    expect(tools).toContain('write_todos')

    for (const name of IMPLEMENT_SAMPLE) {
      expect(tools).not.toContain(name)
    }
    expect(tools).not.toContain('run_targeted_validation')
    expect(tools).not.toContain('run_terminal_command')
    for (const name of AUDIT_SAMPLE) {
      expect(tools).not.toContain(name)
    }
    for (const name of MEDIA_SAMPLE) {
      expect(tools).not.toContain(name)
    }
    expect(tools).not.toContain('edit_3d_asset')
    expect(tools).not.toContain('kill_job')
  })

  test('flag on + all unlocked tiers exposes gated tools', () => {
    const unlockedTiers: ToolTier[] = [
      'implement',
      'audit',
      'media_3d',
      'job_extra',
    ]
    const tools = resolveModelToolNames({
      mode: 'default',
      executePlan: true,
      progressiveToolDisclosure: true,
      unlockedTiers,
    })

    expect(tools).toContain('edit_transaction')
    expect(tools).toContain('create_plan')
    expect(tools).toContain('run_targeted_validation')
    expect(tools).toContain('run_terminal_command')
    expect(tools).toContain('inspect_codebase_structure')
    expect(tools).toContain('inspect_feature_completeness')
    expect(tools).toContain('read_image')
    expect(tools).toContain('edit_3d_asset')
    expect(tools).toContain('kill_job')
  })

  test('planOnly + progressive off: still no edit_transaction', () => {
    const tools = createBase2('default', {
      planOnly: true,
      progressiveToolDisclosure: false,
    }).toolNames ?? []
    expect(tools).not.toContain('edit_transaction')
    expect(tools).not.toContain('edit_3d_asset')
    expect(tools).not.toContain('run_terminal_command')
    expect(tools).not.toContain('write_todos')
    expect(tools).not.toContain('run_targeted_validation')
  })

  test('planOnly + progressive on + unlock implement: still no edit_transaction', () => {
    const tools = resolveModelToolNames({
      mode: 'default',
      planOnly: true,
      progressiveToolDisclosure: true,
      unlockedTiers: ['implement'],
    })
    expect(tools).toContain('create_plan')
    expect(tools).toContain('inspect_workspace')
    expect(tools).not.toContain('edit_transaction')
    expect(tools).not.toContain('run_targeted_validation')
    expect(tools).not.toContain('run_terminal_command')
    expect(tools).not.toContain('write_todos')
  })

  test('env canary on when option omitted enables progressive (core-only)', () => {
    const previous = process.env.OPENBUFF_PROGRESSIVE_TOOL_DISCLOSURE
    try {
      process.env.OPENBUFF_PROGRESSIVE_TOOL_DISCLOSURE = 'true'
      const tools = createBase2('default').toolNames ?? []
      expect(tools).toContain('spawn_agents')
      expect(tools).not.toContain('edit_transaction')
      expect(tools).not.toContain('kill_job')
      expect(tools).not.toContain('read_image')
    } finally {
      if (previous === undefined) {
        delete process.env.OPENBUFF_PROGRESSIVE_TOOL_DISCLOSURE
      } else {
        process.env.OPENBUFF_PROGRESSIVE_TOOL_DISCLOSURE = previous
      }
    }
  })

  test('explicit false overrides env canary on', () => {
    const previous = process.env.OPENBUFF_PROGRESSIVE_TOOL_DISCLOSURE
    try {
      process.env.OPENBUFF_PROGRESSIVE_TOOL_DISCLOSURE = '1'
      const tools = createBase2('default', {
        progressiveToolDisclosure: false,
      }).toolNames ?? []
      expect(tools).toContain('edit_transaction')
      expect(tools).toContain('kill_job')
      expect(tools).toContain('read_image')
    } finally {
      if (previous === undefined) {
        delete process.env.OPENBUFF_PROGRESSIVE_TOOL_DISCLOSURE
      } else {
        process.env.OPENBUFF_PROGRESSIVE_TOOL_DISCLOSURE = previous
      }
    }
  })

  test('token budget: progressive on core-only tool surface is under 12k', async () => {
    const tools = createBase2('default', {
      progressiveToolDisclosure: true,
    }).toolNames ?? []
    expect(await toolSurfaceTokenCount(tools)).toBeLessThan(12_000)
  })

  test('programmaticToolNames unchanged vs today', () => {
    const agent = createBase2('default')
    expect(agent.programmaticToolNames).toEqual([...PROGRAMMATIC_TOOL_NAMES])
    const progressive = createBase2('default', {
      progressiveToolDisclosure: true,
    })
    expect(progressive.programmaticToolNames).toEqual([
      ...PROGRAMMATIC_TOOL_NAMES,
    ])
    const explicitOff = createBase2('default', {
      progressiveToolDisclosure: false,
    })
    expect(explicitOff.programmaticToolNames).toEqual([
      ...PROGRAMMATIC_TOOL_NAMES,
    ])
  })
})

describe('tier resolution helpers (M1-T3)', () => {
  describe('resolveUnlockedTiersForPhase', () => {
    test('returns [] when all intents are false', () => {
      expect(
        resolveUnlockedTiersForPhase({
          implementIntent: false,
          auditIntent: false,
          mediaIntent: false,
          jobIntent: false,
        }),
      ).toEqual([])
    })

    test("returns ['implement'] when implementIntent is true", () => {
      expect(
        resolveUnlockedTiersForPhase({
          implementIntent: true,
          auditIntent: false,
          mediaIntent: false,
          jobIntent: false,
        }),
      ).toEqual(['implement'])
    })

    test("returns ['audit'] when auditIntent is true", () => {
      expect(
        resolveUnlockedTiersForPhase({
          implementIntent: false,
          auditIntent: true,
          mediaIntent: false,
          jobIntent: false,
        }),
      ).toEqual(['audit'])
    })

    test("returns ['media_3d'] when mediaIntent is true", () => {
      expect(
        resolveUnlockedTiersForPhase({
          implementIntent: false,
          auditIntent: false,
          mediaIntent: true,
          jobIntent: false,
        }),
      ).toEqual(['media_3d'])
    })

    test("returns ['job_extra'] when jobIntent is true", () => {
      expect(
        resolveUnlockedTiersForPhase({
          implementIntent: false,
          auditIntent: false,
          mediaIntent: false,
          jobIntent: true,
        }),
      ).toEqual(['job_extra'])
    })

    test('returns all four tiers when all intents are true', () => {
      expect(
        resolveUnlockedTiersForPhase({
          implementIntent: true,
          auditIntent: true,
          mediaIntent: true,
          jobIntent: true,
        }),
      ).toEqual(['implement', 'audit', 'media_3d', 'job_extra'])
    })

    test("never returns 'core' regardless of input", () => {
      const tiers = resolveUnlockedTiersForPhase({
        implementIntent: true,
        auditIntent: true,
        mediaIntent: true,
        jobIntent: true,
      })
      expect(tiers).not.toContain('core')
    })
  })

  describe('deriveIntentSignals', () => {
    const idleBase = {
      phase: 'idle',
      pendingGateFileCount: 0,
      hasOpenReviewerBlockers: false,
    }

    test('implementIntent is true for implement-gating phases', () => {
      for (const phase of [
        'awaiting_validation',
        'repair_loop',
        'awaiting_review',
        'blocked',
      ]) {
        expect(
          deriveIntentSignals({ ...idleBase, phase }).implementIntent,
        ).toBe(true)
      }
    })

    test('implementIntent is true when pendingGateFileCount > 0 even in idle phase', () => {
      expect(
        deriveIntentSignals({ ...idleBase, pendingGateFileCount: 2 })
          .implementIntent,
      ).toBe(true)
    })

    test('implementIntent is true when hasOpenReviewerBlockers even in idle phase', () => {
      expect(
        deriveIntentSignals({ ...idleBase, hasOpenReviewerBlockers: true })
          .implementIntent,
      ).toBe(true)
    })

    test('implementIntent is true when the prompt contains implement keywords', () => {
      for (const lastUserPrompt of [
        'please implement this feature',
        'fix the failing test',
        'refactor the parser',
        'update the docs',
        'create a new endpoint',
        'add a retry loop',
      ]) {
        expect(
          deriveIntentSignals({ ...idleBase, lastUserPrompt }).implementIntent,
        ).toBe(true)
      }
    })

    test('implementIntent is false when idle with no pending files, blockers, or implement keywords', () => {
      expect(
        deriveIntentSignals({
          ...idleBase,
          lastUserPrompt: 'what does this function do?',
        }).implementIntent,
      ).toBe(false)
    })

    test('auditIntent is true when the prompt contains audit keywords', () => {
      for (const lastUserPrompt of [
        'run a full audit',
        'check the coverage',
        'verify completeness',
        'do a systematic pass',
      ]) {
        expect(
          deriveIntentSignals({ ...idleBase, lastUserPrompt }).auditIntent,
        ).toBe(true)
      }
    })

    test('auditIntent is true when phase is awaiting_review', () => {
      expect(
        deriveIntentSignals({ ...idleBase, phase: 'awaiting_review' })
          .auditIntent,
      ).toBe(true)
    })

    test('mediaIntent is true when the prompt contains media file extensions', () => {
      for (const lastUserPrompt of [
        'look at diagram.png',
        'check photo.jpg',
        'the logo.webp asset',
        'open scene.blend',
        'inspect model.obj',
        'view scene.gltf',
        'load mesh.glb',
      ]) {
        expect(
          deriveIntentSignals({ ...idleBase, lastUserPrompt }).mediaIntent,
        ).toBe(true)
      }
    })

    test('mediaIntent is false for prompts without media extensions', () => {
      expect(
        deriveIntentSignals({
          ...idleBase,
          lastUserPrompt: 'summarize the readme file',
        }).mediaIntent,
      ).toBe(false)
    })

    test('jobIntent is true when the prompt contains job-management phrasing', () => {
      for (const lastUserPrompt of [
        'run this as a background job',
        'kill the job',
        'start the dev server',
        'watch the build',
        'tail -f the output log',
        'check_job for readiness',
      ]) {
        expect(
          deriveIntentSignals({ ...idleBase, lastUserPrompt }).jobIntent,
        ).toBe(true)
      }
    })

    test('jobIntent is false for bare kill/server/logs/watch/tail tokens', () => {
      for (const lastUserPrompt of [
        'explain this function',
        'please kill the zombie metaphor in the docs',
        'is the server still up',
        'check the logs',
        'tail the output',
        'watch carefully how this works',
      ]) {
        expect(
          deriveIntentSignals({ ...idleBase, lastUserPrompt }).jobIntent,
        ).toBe(false)
      }
    })
  })

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
      toolNames: [
        'spawn_agents',
        'read_files',
        'edit_transaction',
        'kill_job',
      ],
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
      // progressiveToolDisclosure explicitly off — that would permanently
      // shrink a full-surface template on resume.
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
  })

  describe('filterByUnlockedTiers', () => {
    test('empty unlockedTiers returns CORE-only tools from the input list', () => {
      // Low-level helper: empty tiers mean CORE-only of the *input* list.
      // getEffectiveAgentToolNames deliberately does NOT call this for
      // absent/empty agentState.unlockedToolTiers (persisted empty = template surface).
      const result = filterByUnlockedTiers(
        ['spawn_agents', 'read_files', 'edit_transaction', 'kill_job'],
        [],
      )
      expect(result).toEqual(['spawn_agents', 'read_files'])
    })

    test("unlockedTiers ['implement'] keeps CORE tools plus implement tools", () => {
      const result = filterByUnlockedTiers(
        ['spawn_agents', 'read_files'],
        ['implement'],
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
      )
      const occurrences = result.filter((name) => name === 'edit_transaction')
      expect(occurrences).toHaveLength(1)
    })
  })
})

// RF-2 sync guard: the tier membership is duplicated across
// agents/base2/tool-tiers.ts (CORE/IMPLEMENT/AUDIT/MEDIA_3D/JOB_EXTRA) and
// packages/agent-runtime/src/util/base2-tool-tiers.ts
// (BASE2_CORE_TOOL_NAMES/BASE2_TIER_TOOL_NAMES). agent-runtime cannot import
// from agents/ (wrong dependency direction), so the two lists are kept in sync
// only by a prose comment. These assertions make a one-sided edit fail loudly
// instead of silently narrowing the runtime tool surface.
describe('base2 tier membership — runtime mirror stays in sync', () => {
  test('BASE2_CORE_TOOL_NAMES equals CORE_TOOLS', () => {
    // CORE_TOOLS re-exports BASE2_CORE_TOOL_NAMES by construction, so this is
    // intentionally vacuous — it cannot catch a drift. The real progressive
    // core-only surface lives in the hand-encoded CORE buildArray inside
    // resolveModelToolNames; the tests below tie THAT copy (and the other
    // mode-gated modes) to the runtime constant so a one-sided edit fails.
    expect([...BASE2_CORE_TOOL_NAMES]).toEqual([...CORE_TOOLS])
  })

  test('progressive core-only surface matches BASE2_CORE_TOOL_NAMES exactly', () => {
    // resolveModelToolNames' progressive CORE buildArray is a SECOND copy of
    // CORE membership that no test previously exercised. In the default mode
    // (ask_user + write_todos both allowed) the surfaced set must equal the
    // runtime constant byte-for-byte, so a tool added/removed on either side
    // fails loudly instead of silently narrowing/widening the tool surface.
    const coreOnly = resolveModelToolNames({
      mode: 'default',
      progressiveToolDisclosure: true,
      unlockedTiers: [],
    })
    // Bidirectional membership over string sets — avoids the ToolName[] sort()
    // widening that would break the AllToolNames[] toEqual overload, while still
    // making a one-sided edit to either list fail loudly.
    const coreSet = new Set<string>(BASE2_CORE_TOOL_NAMES)
    expect(coreOnly.length).toBe(coreSet.size)
    for (const name of coreOnly) {
      expect(coreSet.has(name)).toBe(true)
    }
    for (const name of BASE2_CORE_TOOL_NAMES) {
      expect(coreSet.has(name)).toBe(true)
    }
  })

  test('mode-gated CORE tools stay within BASE2_CORE_TOOL_NAMES', () => {
    // fast + noAskUser drops the mode-gated CORE tools (ask_user/write_todos).
    // Every remaining surfaced name must still be a declared CORE member so
    // the mode-gated variants cannot diverge from (or exceed) the constant.
    const gated = resolveModelToolNames({
      mode: 'fast',
      noAskUser: true,
      progressiveToolDisclosure: true,
      unlockedTiers: [],
    })
    const coreSet = new Set(BASE2_CORE_TOOL_NAMES)
    for (const name of gated) {
      expect(coreSet.has(name)).toBe(true)
    }
    expect(gated).not.toContain('ask_user')
    expect(gated).not.toContain('write_todos')
  })

  test('BASE2_TIER_TOOL_NAMES.implement equals IMPLEMENT_TOOLS', () => {
    expect([...BASE2_TIER_TOOL_NAMES.implement]).toEqual([...IMPLEMENT_TOOLS])
  })

  test('BASE2_TIER_TOOL_NAMES.audit equals AUDIT_TOOLS', () => {
    expect([...BASE2_TIER_TOOL_NAMES.audit]).toEqual([...AUDIT_TOOLS])
  })

  test('BASE2_TIER_TOOL_NAMES.media_3d equals MEDIA_3D_TOOLS', () => {
    expect([...BASE2_TIER_TOOL_NAMES.media_3d]).toEqual([...MEDIA_3D_TOOLS])
  })

  test('BASE2_TIER_TOOL_NAMES.job_extra equals JOB_EXTRA_TOOLS', () => {
    expect([...BASE2_TIER_TOOL_NAMES.job_extra]).toEqual([...JOB_EXTRA_TOOLS])
  })

  test('BASE2_TIER_TOOL_NAMES covers exactly the four non-core tiers', () => {
    expect(Object.keys(BASE2_TIER_TOOL_NAMES).sort()).toEqual([
      'audit',
      'implement',
      'job_extra',
      'media_3d',
    ])
  })
})

// RF-3 budget sync guard: the SEMANTIC_* / MODEL_CONTEXT_* constants are
// duplicated between packages/agent-runtime/src/util/context-pruning.ts
// (SEMANTIC_COMPACTION_* / MODEL_CONTEXT_*) and agents/context-pruner.ts
// (SEMANTIC_* / MODEL_CONTEXT_* inside serialized handleSteps). agent-runtime
// cannot import from agents/ and handleSteps cannot import at runtime, so the
// lists are kept in sync only by a prose comment. This readFileSync guard
// extracts the numeric literal for each constant from both files and asserts
// equality so a one-sided budget edit fails loudly. The existing RF-3 tier
// tests above cover the TOOL_TIERS mirroring; this covers the BUDGET side.
describe('context-pruner budget constants — mirrors stay in sync (RF-3)', () => {
  function extractNumericLiteral(
    source: string,
    declarationName: string,
  ): number {
    // Matches e.g. "const SEMANTIC_TRIGGER_FRACTION = 0.70" inside handleSteps
    // or "export const SEMANTIC_COMPACTION_TRIGGER_FRACTION = 0.70". Capture
    // the numeric literal only; whitespace/comments around "=" are tolerated.
    const escaped = declarationName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(
      `(?:^|\\n)\\s*(?:export\\s+)?const\\s+${escaped}\\s*=\\s*([0-9]*\\.?[0-9]+(?:e[+-]?[0-9]+)?)`,
      'm',
    )
    const match = source.match(pattern)
    if (!match) throw new Error(`Unable to find ${declarationName} in source`)
    const value = Number(match[1])
    if (!Number.isFinite(value))
      throw new Error(`Non-finite value for ${declarationName}: ${match[1]}`)
    return value
  }

  // Map from canonical (agent-runtime) name to pruner inline name
  const BUDGET_PAIRS: Array<[string, string]> = [
    // Semantic compaction budget
    ['SEMANTIC_COMPACTION_TRIGGER_FRACTION', 'SEMANTIC_TRIGGER_FRACTION'],
    ['SEMANTIC_COMPACTION_TARGET_FRACTION', 'SEMANTIC_TARGET_FRACTION'],
    ['SEMANTIC_COMPACTION_HEADROOM_FRACTION', 'SEMANTIC_HEADROOM_FRACTION'],
    ['SEMANTIC_COMPACTION_MIN_HEADROOM_TOKENS', 'SEMANTIC_MIN_HEADROOM_TOKENS'],
    ['SEMANTIC_COMPACTION_MAX_HEADROOM_TOKENS', 'SEMANTIC_MAX_HEADROOM_TOKENS'],
    ['SEMANTIC_COMPACTION_MIN_TARGET_TOKENS', 'SEMANTIC_MIN_TARGET_TOKENS'],
    ['SEMANTIC_COMPACTION_MAX_TARGET_TOKENS', 'SEMANTIC_MAX_TARGET_TOKENS'],
    [
      'SEMANTIC_COMPACTION_SMALL_WINDOW_THRESHOLD_TOKENS',
      'SEMANTIC_SMALL_WINDOW_THRESHOLD_TOKENS',
    ],
    [
      'SEMANTIC_COMPACTION_SMALL_WINDOW_MIN_HEADROOM_TOKENS',
      'SEMANTIC_SMALL_WINDOW_MIN_HEADROOM_TOKENS',
    ],
    ['DEFAULT_SEMANTIC_COMPACTION_TRIGGER_TOKENS', 'DEFAULT_MAX_CONTEXT_LENGTH'],
    ['DEFAULT_SEMANTIC_COMPACTION_TARGET_TOKENS', 'DEFAULT_TARGET_CONTEXT_LENGTH'],
    // Model reserve
    ['MODEL_CONTEXT_MIN_RESERVED_TOKENS', 'MODEL_CONTEXT_MIN_RESERVED_TOKENS'],
    ['MODEL_CONTEXT_MAX_RESERVED_TOKENS', 'MODEL_CONTEXT_MAX_RESERVED_TOKENS'],
    ['MODEL_CONTEXT_RESERVED_FRACTION', 'MODEL_CONTEXT_RESERVED_FRACTION'],
    [
      'MODEL_CONTEXT_MAX_RESERVED_FRACTION',
      'MODEL_CONTEXT_MAX_RESERVED_FRACTION',
    ],
  ]

  test('every mirrored budget constant matches between agent-runtime and context-pruner', async () => {
    const pruningSource = await Bun.file(
      new URL('../../packages/agent-runtime/src/util/context-pruning.ts', import.meta.url),
    ).text()
    const prunerSource = await Bun.file(
      new URL('../context-pruner.ts', import.meta.url),
    ).text()
    for (const [canonicalName, prunerName] of BUDGET_PAIRS) {
      const canonicalValue = extractNumericLiteral(pruningSource, canonicalName)
      const prunerValue = extractNumericLiteral(prunerSource, prunerName)
      expect(
        prunerValue,
        `budget drift: ${prunerName} (${prunerValue}) !== ${canonicalName} (${canonicalValue})`,
      ).toBe(canonicalValue)
    }
  })
})

// RF-3/RF-4 sync guard: the exported pure helper `getPublishUnlockedToolTiers`
// must stay in sync with the serialized `publishUnlockedToolTiers` inline copy
// inside base2's handleSteps (which is inlined via .toString() + new Function).
// Previously this test readFileSync + Bun.Transpiler + new Function'd the
// inline source — brittle to formatting. Now it imports the pure helper directly
// and keeps the serialized-copy drift check as a lightweight behavioral guard.
describe('publishUnlockedToolTiers — inline copy matches canonical helpers', () => {

  const MATRIX: Array<{
    phase: string
    pendingGateFileCount: number
    hasOpenReviewerBlockers: boolean
    lastUserPrompt?: string
  }> = [
    // Idle with no signals.
    {
      phase: 'idle',
      pendingGateFileCount: 0,
      hasOpenReviewerBlockers: false,
      lastUserPrompt: 'what does this function do?',
    },
    // Idle with no prompt at all.
    {
      phase: 'idle',
      pendingGateFileCount: 0,
      hasOpenReviewerBlockers: false,
    },
    // Implement-gating phases.
    {
      phase: 'awaiting_validation',
      pendingGateFileCount: 0,
      hasOpenReviewerBlockers: false,
      lastUserPrompt: '',
    },
    {
      phase: 'repair_loop',
      pendingGateFileCount: 0,
      hasOpenReviewerBlockers: false,
      lastUserPrompt: '',
    },
    // awaiting_review triggers both implement and audit intent.
    {
      phase: 'awaiting_review',
      pendingGateFileCount: 0,
      hasOpenReviewerBlockers: false,
      lastUserPrompt: '',
    },
    {
      phase: 'blocked',
      pendingGateFileCount: 0,
      hasOpenReviewerBlockers: false,
      lastUserPrompt: '',
    },
    // Pending gate files force implement intent even in idle phase.
    {
      phase: 'idle',
      pendingGateFileCount: 3,
      hasOpenReviewerBlockers: false,
      lastUserPrompt: '',
    },
    // Open reviewer blockers force implement intent.
    {
      phase: 'idle',
      pendingGateFileCount: 0,
      hasOpenReviewerBlockers: true,
      lastUserPrompt: '',
    },
    // Implement keyword in the prompt.
    {
      phase: 'idle',
      pendingGateFileCount: 0,
      hasOpenReviewerBlockers: false,
      lastUserPrompt: 'please implement and fix this feature',
    },
    // Audit keyword in the prompt.
    {
      phase: 'idle',
      pendingGateFileCount: 0,
      hasOpenReviewerBlockers: false,
      lastUserPrompt: 'run a full audit of the coverage',
    },
    // Media path in the prompt.
    {
      phase: 'idle',
      pendingGateFileCount: 0,
      hasOpenReviewerBlockers: false,
      lastUserPrompt: 'look at diagram.png and scene.gltf',
    },
    // Job-management phrasing in the prompt.
    {
      phase: 'idle',
      pendingGateFileCount: 0,
      hasOpenReviewerBlockers: false,
      lastUserPrompt: 'kill the job and tail -f the logs',
    },
    // Combined signals: implement phase + audit/media/job prompt keywords.
    {
      phase: 'awaiting_review',
      pendingGateFileCount: 2,
      hasOpenReviewerBlockers: true,
      lastUserPrompt: 'audit the coverage, check logo.webp, and kill the job',
    },
  ]

  test('pure helper mirrors deriveIntentSignals+resolveUnlockedTiersForPhase across the matrix (no file read / transpiler)', () => {
    for (const input of MATRIX) {
      const expectedSignals = deriveIntentSignals({
        phase: input.phase,
        pendingGateFileCount: input.pendingGateFileCount,
        hasOpenReviewerBlockers: input.hasOpenReviewerBlockers,
        lastUserPrompt: input.lastUserPrompt,
      })
      const expectedTiers = resolveUnlockedTiersForPhase(expectedSignals)
      expect(
        getPublishUnlockedToolTiers(input),
        `getPublishUnlockedToolTiers diverged from tool-tiers.ts helpers for input ${JSON.stringify(input)}`,
      ).toEqual(expectedTiers)
    }
  })

  test('canary-off wrapper clears stale non-empty unlockedToolTiers for resume hygiene (pure helper)', () => {
    expect(
      getPublishUnlockedToolTiersWithCanary({
        phase: 'idle',
        pendingGateFileCount: 0,
        hasOpenReviewerBlockers: false,
        lastUserPrompt: 'please implement this feature',
        progressiveToolDisclosure: false,
        initialUnlockedToolTiers: ['implement', 'audit'],
      }),
    ).toBeUndefined()
    // Canary on: same input delegates to the pure helper.
    expect(
      getPublishUnlockedToolTiersWithCanary({
        phase: 'idle',
        pendingGateFileCount: 0,
        hasOpenReviewerBlockers: false,
        lastUserPrompt: 'please implement and fix this feature',
        progressiveToolDisclosure: true,
      }),
    ).toEqual(['implement'])
  })

  test('generic isEnvFlagEnabled aliases the progressive-tool disclosure flag (RF-1)', () => {
    // RF-1: the prompt-disclosure path reused a tool-specific name for a generic
    // truthy check. The canonical name is now `isEnvFlagEnabled`; the old name
    // remains as an alias.
    for (const truthy of ['1', 'true', 'yes', 'on', '  TRUE  ', 'On']) {
      expect(isEnvFlagEnabled(truthy)).toBe(true)
      expect(isProgressiveToolDisclosureEnvEnabled(truthy)).toBe(true)
    }
    for (const falsy of ['', '0', 'false', 'no', 'off', undefined]) {
      expect(isEnvFlagEnabled(falsy as string | undefined)).toBe(false)
      expect(
        isProgressiveToolDisclosureEnvEnabled(falsy as string | undefined),
      ).toBe(false)
    }
    expect(isEnvFlagEnabled).toBe(isProgressiveToolDisclosureEnvEnabled)
  })
})

// RF-5 traceability: small-window (<128k) branch coverage lives canonically in
// packages/agent-runtime/src/util/__tests__/context-pruning.test.ts (parameterized
// 8k/16k/32k/64k cases). This smoke case keeps the changed file's RF-5 finding
// visibly addressed without duplicating the full matrix here.
describe('RF-5 traceability — getSemanticCompactionBudget small-window coverage', () => {
  // Import lazily to avoid circular initialization at top-level; the module is
  // pure and has no side effects.
  test('8k/32k/64k small-window branch is covered (see context-pruning.test.ts)', async () => {
    const { getSemanticCompactionBudget } = await import(
      '@codebuff/agent-runtime/util/context-pruning'
    )
    for (const windowTokens of [8_000, 32_000, 64_000] as const) {
      const budget = getSemanticCompactionBudget(windowTokens)
      expect(budget.resolvedContextWindowTokens).toBe(windowTokens)
      expect(budget.triggerBudgetTokens).toBeGreaterThan(1)
      expect(budget.targetBudgetTokens).toBeGreaterThan(1)
      expect(budget.targetBudgetTokens).toBeLessThan(budget.triggerBudgetTokens)
    }
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
    const fullSurface = [...CORE_TOOLS, ...IMPLEMENT_TOOLS, 'end_turn']
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
      toolNames: [...CORE_TOOLS, 'end_turn'],
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
