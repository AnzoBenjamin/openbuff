import { describe, expect, test } from 'bun:test'
import { getInitialAgentState } from '@codebuff/common/types/session-state'
import { validateSingleAgent } from '@codebuff/common/templates/agent-validation'
import { createAgentState } from '../tools/handlers/tool/spawn-agent-utils'
import { buildChildAgentState } from '../supervision/child-entry'
import { selectAgentStepBudget } from '@codebuff/common/util/agent-limits'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'

const template = (maxSteps?: number): AgentTemplate => ({
  id: 'step-budget-child',
  displayName: 'Step budget child',
  toolNames: [],
  spawnableAgents: [],
  mcpServers: {},
  systemPrompt: '',
  instructionsPrompt: '',
  stepPrompt: '',
  inputSchema: {},
  includeMessageHistory: false,
  inheritParentSystemPrompt: false,
  outputMode: 'last_message',
  ...(maxSteps === undefined ? {} : { maxSteps }),
})
describe('child inference-step budget propagation', () => {
  for (const [maxSteps, expected] of [
    [undefined, -1],
    [2, 2],
    [70, 70],
    [-1, -1],
  ] as const)
    test(`child construction selects ${expected} for template maxSteps ${maxSteps}`, () => {
      const parent = getInitialAgentState()
      const child = createAgentState(
        'step-budget-child',
        template(maxSteps),
        parent,
        {},
      )
      expect(child.stepsRemaining).toBe(expected)
      expect(parent.stepsRemaining).toBe(-1)
    })
  for (const stepsRemaining of [0, 2, 40, -1])
    test(`supervised state keeps its captured ${stepsRemaining} inference-step budget`, () => {
      const state = buildChildAgentState({
        agentType: 'step-budget-child',
        prompt: '',
        spawnParams: undefined,
        ancestorRunIds: ['parent-run'],
        child: { agentId: 'child', stepsRemaining },
      })
      expect(state.stepsRemaining).toBe(stepsRemaining)
    })
  test('an omitted or explicitly unlimited template never refills a tighter or exhausted budget', () => {
    for (const child of [false, true]) {
      for (const declared of [undefined, -1, 70]) {
        expect(selectAgentStepBudget(0, declared, child)).toBe(0)
        expect(selectAgentStepBudget(2, declared, child)).toBe(2)
      }
      expect(selectAgentStepBudget(-1, undefined, child)).toBe(-1)
      expect(selectAgentStepBudget(10, 2, child)).toBe(2)
    }
  })

  test('template validation retains finite maxSteps and rejects invalid values', () => {
    for (const maxSteps of [1, 40, -1]) {
      const parsed = validateSingleAgent({ template: template(maxSteps) })
      expect(parsed.success).toBe(true)
      expect(parsed.agentTemplate?.maxSteps).toBe(maxSteps)
    }
    for (const maxSteps of [0, -2, 1.5, Infinity, NaN])
      expect(
        validateSingleAgent({ template: template(maxSteps) }).success,
      ).toBe(false)
  })
})
