import { readFileSync } from 'node:fs'

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

import { createBase2 } from '../base2/base2'
import {
  AUDIT_TOOLS,
  CORE_TOOLS,
  deriveIntentSignals,
  IMPLEMENT_TOOLS,
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
  test('flag default off / omit option equals explicit false full surface', () => {
    const implicit = createBase2('default')
    const explicit = createBase2('default', {
      progressiveToolDisclosure: false,
    })
    expect(implicit.toolNames).toEqual(explicit.toolNames)
    expect(implicit.toolNames).toEqual(
      resolveModelToolNames({
        mode: 'default',
        progressiveToolDisclosure: false,
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
    expect([...BASE2_CORE_TOOL_NAMES]).toEqual([...CORE_TOOLS])
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

// RF-3 sync guard: base2's handleSteps is serialized via .toString() + new
// Function(...), so publishUnlockedToolTiers re-implements
// deriveIntentSignals/resolveUnlockedTiersForPhase with hand-copied regexes
// and phase lists. A future edit to the tool-tiers.ts helpers would silently
// diverge from the inlined copy. These assertions extract the inlined copy
// from the live base2.ts source and compare its behavior to the canonical
// helpers across a matrix of representative
// {phase, pendingGateFileCount, hasOpenReviewerBlockers, lastUserPrompt}
// inputs, so a one-sided edit fails loudly.
describe('publishUnlockedToolTiers — inline copy matches canonical helpers', () => {
  type PublishUnlockedToolTiers = () => void

  function extractInlineFunctionSource(
    source: string,
    functionName: string,
  ): string {
    const declarationStart = source.indexOf(`function ${functionName}(`)
    if (declarationStart < 0) {
      throw new Error(`Unable to find inline ${functionName} declaration`)
    }
    const bodyStart = source.indexOf('{', declarationStart)
    if (bodyStart < 0) {
      throw new Error(`Unable to find inline ${functionName} body`)
    }
    let depth = 0
    for (let index = bodyStart; index < source.length; index += 1) {
      const character = source[index]
      if (character === '{') depth += 1
      if (character === '}') depth -= 1
      if (depth === 0) {
        return source.slice(declarationStart, index + 1)
      }
    }
    throw new Error(`Unable to find end of inline ${functionName} declaration`)
  }

  /**
   * Run the inlined publishUnlockedToolTiers extracted from base2.ts with
   * controlled closure state, returning the tiers it publishes onto
   * mutableAgentState (or undefined when the canary is off / it returns early).
   */
  function runInlinePublishUnlockedToolTiers(input: {
    phase: string
    pendingGateFileCount: number
    hasOpenReviewerBlockers: boolean
    lastUserPrompt?: string
    progressiveToolDisclosure?: boolean
    initialUnlockedToolTiers?: string[]
  }): string[] | undefined {
    const base2Source = readFileSync(
      new URL('../base2/base2.ts', import.meta.url),
      'utf8',
    )
    const transpiler = new Bun.Transpiler({ loader: 'ts' })
    const base2JavaScript = transpiler.transformSync(base2Source)
    const functionSource = extractInlineFunctionSource(
      base2JavaScript,
      'publishUnlockedToolTiers',
    )

    const activeWorkState = {
      currentPhase: input.phase,
      pendingGateFiles: Array.from(
        { length: input.pendingGateFileCount },
        (_, index) => `src/pending-${index}.ts`,
      ),
      openReviewerBlockers: input.hasOpenReviewerBlockers
        ? ['blocking finding']
        : [],
    }
    const mutableAgentState: { unlockedToolTiers?: string[] } = {}
    if (input.initialUnlockedToolTiers !== undefined) {
      mutableAgentState.unlockedToolTiers = [...input.initialUnlockedToolTiers]
    }
    const buildPublish = new Function(
      'config',
      'activeWorkState',
      'prompt',
      'mutableAgentState',
      `"use strict";\n${functionSource}\nreturn publishUnlockedToolTiers`,
    ) as (
      config: { progressiveToolDisclosure: boolean },
      activeWorkState: unknown,
      prompt: string | undefined,
      mutableAgentState: { unlockedToolTiers?: string[] },
    ) => PublishUnlockedToolTiers

    const publish = buildPublish(
      {
        progressiveToolDisclosure: input.progressiveToolDisclosure ?? true,
      },
      activeWorkState,
      input.lastUserPrompt,
      mutableAgentState,
    )
    publish()
    return mutableAgentState.unlockedToolTiers
  }

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

  test('inline published tiers match resolveUnlockedTiersForPhase(deriveIntentSignals(...)) across the matrix', () => {
    for (const input of MATRIX) {
      const expectedSignals = deriveIntentSignals({
        phase: input.phase,
        pendingGateFileCount: input.pendingGateFileCount,
        hasOpenReviewerBlockers: input.hasOpenReviewerBlockers,
        lastUserPrompt: input.lastUserPrompt,
      })
      const expectedTiers = resolveUnlockedTiersForPhase(expectedSignals)

      const inlineTiers = runInlinePublishUnlockedToolTiers(input)

      expect(
        inlineTiers,
        `inline publishUnlockedToolTiers diverged from tool-tiers.ts helpers for input ${JSON.stringify(input)}`,
      ).toEqual(expectedTiers)
    }
  })

  test('canary-off clears stale non-empty unlockedToolTiers for resume hygiene', () => {
    const remaining = runInlinePublishUnlockedToolTiers({
      phase: 'idle',
      pendingGateFileCount: 0,
      hasOpenReviewerBlockers: false,
      lastUserPrompt: 'please implement this feature',
      progressiveToolDisclosure: false,
      initialUnlockedToolTiers: ['implement', 'audit'],
    })
    expect(remaining).toBeUndefined()
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
