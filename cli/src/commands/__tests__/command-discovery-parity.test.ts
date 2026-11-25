import { describe, expect, test } from 'bun:test'

import { COMMAND_REGISTRY, findCommand } from '../command-registry'
import {
  formatCommandDirectory,
  SLASH_COMMANDS,
} from '../../data/slash-commands'

// Explicit exceptions to discoverable executable commands.
const hiddenRoutes = new Map([
  [
    'general-agent',
    'agent:general inserts @general-agent instead of executing',
  ],
  [
    'publish',
    'Legacy publishing is disabled in local/BYOK mode and returns an explicit refusal',
  ],
])

describe('static command discovery parity', () => {
  test('every routed command has menu and help metadata or an explicit hidden exemption', () => {
    const help = formatCommandDirectory()
    for (const command of COMMAND_REGISTRY) {
      if (hiddenRoutes.has(command.name)) continue
      const metadata = SLASH_COMMANDS.find((item) => item.id === command.name)
      expect(metadata, command.name).toBeDefined()
      expect(metadata?.insertText, command.name).toBeUndefined()
      expect(command.aliases, command.name).toEqual(metadata?.aliases ?? [])
      expect(help, command.name).toContain(`/${command.name}`)
      for (const alias of command.aliases) {
        expect(findCommand(alias)?.name, alias).toBe(command.name)
        expect(help, alias).toContain(`/${alias}`)
      }
    }
  })

  test('every non-insertion menu command reaches the registered local router', () => {
    for (const command of SLASH_COMMANDS) {
      if (command.insertText) continue
      expect(findCommand(command.id)?.name, command.id).toBe(command.id)
    }
  })

  test('plan commands and local feedback are described truthfully', () => {
    const help = formatCommandDirectory()
    for (const id of ['compact', 'plans', 'plan-use', 'plan-timeline'])
      expect(SLASH_COMMANDS.find((command) => command.id === id)).toBeDefined()
    expect(help).toContain('/plan-use')
    expect(help).toContain('/plan-active')
    expect(
      SLASH_COMMANDS.find((command) => command.id === 'feedback')?.description,
    ).toMatch(/local/i)
  })
})
