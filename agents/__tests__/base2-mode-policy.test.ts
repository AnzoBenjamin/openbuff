import { describe, expect, test } from 'bun:test'

import { toolNames } from '@codebuff/common/tools/constants'

import {
  MODE_GATED_TOOL_NAMES,
  MODE_NEUTRAL_TOOL_NAMES,
  modeAllowsTool,
} from '../base2/tool-tiers'

import type { AllToolNames } from '../types/secret-agent-definition'

// M1-T6: every ToolName must have an explicit mode policy — mode-neutral or
// mode-gated. modeAllowsTool denies anything unlisted (fail closed), and this
// suite makes the omission loud instead of silent when a new tool ships.
describe('base2 mode policy coverage', () => {
  const allNames = new Set<string>(toolNames)
  const policyNames = new Set<string>([
    ...MODE_NEUTRAL_TOOL_NAMES,
    ...MODE_GATED_TOOL_NAMES,
  ])

  test('every ToolName has an explicit mode policy', () => {
    const missing = [...allNames].filter((name) => !policyNames.has(name))
    expect(missing).toEqual([])
  })

  test('no policy name is unknown to the tool registry', () => {
    const extra = [...policyNames].filter((name) => !allNames.has(name))
    expect(extra).toEqual([])
  })

  test('mode-neutral and mode-gated lists do not overlap', () => {
    const overlap = MODE_NEUTRAL_TOOL_NAMES.filter((name) =>
      (MODE_GATED_TOOL_NAMES as readonly string[]).includes(name),
    )
    expect(overlap).toEqual([])
  })

  test('unlisted tool names fail closed (denied in every mode)', () => {
    const unknown = 'definitely_not_a_registered_tool' as AllToolNames
    for (const gates of [
      { isFast: false, planOnly: false, executePlan: true, noAskUser: false },
      { isFast: true, planOnly: true, executePlan: false, noAskUser: true },
    ]) {
      expect(modeAllowsTool(unknown, gates)).toBe(false)
    }
  })

  test('mode gates still deny mutation tools outside their mode', () => {
    const planOnlyGates = {
      isFast: false,
      planOnly: true,
      executePlan: false,
      noAskUser: false,
    }
    expect(modeAllowsTool('edit_transaction', planOnlyGates)).toBe(false)
    expect(modeAllowsTool('run_terminal_command', planOnlyGates)).toBe(false)
    const executeGates = {
      isFast: false,
      planOnly: false,
      executePlan: true,
      noAskUser: false,
    }
    expect(modeAllowsTool('edit_transaction', executeGates)).toBe(true)
    expect(modeAllowsTool('run_terminal_command', executeGates)).toBe(true)
  })
})
