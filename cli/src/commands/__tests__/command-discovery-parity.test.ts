import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import { COMMAND_REGISTRY, findCommand } from '../command-registry'
import { filterSlashCommands } from '../../hooks/use-suggestion-engine'
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

  test('the executable registry follows the canonical discoverable metadata order', () => {
    expect(
      COMMAND_REGISTRY.filter(({ name }) => !hiddenRoutes.has(name)).map(
        ({ name }) => name,
      ),
    ).toEqual(
      SLASH_COMMANDS.filter((item) => !item.insertText).map(({ id }) => id),
    )
  })

  test('every non-insertion menu command reaches the registered local router', () => {
    for (const command of SLASH_COMMANDS) {
      if (command.insertText) continue
      expect(findCommand(command.id)?.name, command.id).toBe(command.id)
    }
  })

  test('the public slash-command reference lists every static command and alias exactly once', () => {
    const docs = readFileSync(
      new URL('../../../../docs/agents-and-tools.md', import.meta.url),
      'utf8',
    )
    const section = docs
      .split('\n### Registered commands\n')[1]
      ?.split('\n### ')[0]
    expect(section).toBeDefined()
    const table = section!
      .split('\n')
      .filter((line) => line.startsWith('|'))
      .join('\n')
    const documented = Array.from(
      table.matchAll(/`\/([^`\s]+)`/g),
      (match) => match[1],
    )
    const expected = SLASH_COMMANDS.flatMap(({ id, aliases }) => [
      id,
      ...(aliases ?? []),
    ])
    expect(documented.sort()).toEqual(expected.sort())
  })

  test('inline fuzzy suggestions retain usage hints and resolve to the local command', () => {
    const matches = filterSlashCommands(SLASH_COMMANDS, 'plu')
    const plan = matches.find((item) => item.id === 'plan-use')
    expect(plan).toMatchObject({
      labelHighlightIndices: [0, 1, 5],
      description: expect.stringContaining('/plan-use <slug>'),
    })
    expect(findCommand(plan!.id)?.name).toBe('plan-use')
    expect(filterSlashCommands(SLASH_COMMANDS, 'plan-act')[0]?.id).toBe(
      'plan-use',
    )
    expect(filterSlashCommands(SLASH_COMMANDS, 'pl')[0]?.id).toBe('plans')
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
