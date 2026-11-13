import { afterEach, describe, expect, test } from 'bun:test'
import {
  getCommandApprovalOverride,
  resolveCommandApprovalMode,
  setCommandApprovalMode,
} from '../command-approvals'
import { handlePermissionsCommand } from '../../commands/permissions'
import { ManagedOpenbuffClient } from '../codebuff-client'
import { findCommand } from '../../commands/command-registry'
import { SLASH_COMMANDS } from '../../data/slash-commands'

afterEach(() => setCommandApprovalMode(undefined))

const deps = { configuredMode: () => 'strict' as const, attached: () => false }

describe('command approval controls', () => {
  test('session override wins over config, reset returns to config', () => {
    expect(resolveCommandApprovalMode()).toBe('balanced')
    expect(resolveCommandApprovalMode('strict')).toBe('strict')
    expect(handlePermissionsCommand('allow-all', deps)).toContain(
      'allow-all (this session)',
    )
    expect(resolveCommandApprovalMode('strict')).toBe('allow-all')
    expect(handlePermissionsCommand('reset', deps)).toContain('strict (config)')
    expect(getCommandApprovalOverride()).toBeUndefined()
  })

  test('status lists the available controls without changing policy', () => {
    const status = handlePermissionsCommand('', deps)
    expect(status).toContain('strict (config)')
    for (const mode of ['balanced', 'strict', 'allow-all'])
      expect(status).toContain(`/permissions ${mode}`)
    expect(getCommandApprovalOverride()).toBeUndefined()
  })

  test('invalid arguments and attached sessions cannot change the policy', () => {
    setCommandApprovalMode('strict')
    expect(handlePermissionsCommand('allow-all extra', deps)).toContain(
      'Usage:',
    )
    expect(
      handlePermissionsCommand('allow-all', { ...deps, attached: () => true }),
    ).toContain('controlled by the attached server')
    expect(getCommandApprovalOverride()).toBe('strict')
  })

  test('command palette and handler expose the same explicit control', () => {
    expect(findCommand('permissions')?.acceptsArgs).toBe(true)
    expect(findCommand('approvals')).toBe(findCommand('permissions'))
    expect(
      SLASH_COMMANDS.find((command) => command.id === 'permissions')?.aliases,
    ).toContain('approvals')
  })

  test('all CLI client runs capture the session setting and honor explicit overrides', async () => {
    const seen: Array<string | undefined> = []
    let complete!: () => void
    const pending = new Promise<void>((resolve) => {
      complete = resolve
    })
    const client = new ManagedOpenbuffClient({}, undefined, async (options) => {
      seen.push(options.approvalMode)
      await pending
        return { output: { type: 'structuredOutput', value: { done: true } } }
    })
    setCommandApprovalMode('strict')
    const first = client.run({ agent: 'base', prompt: 'first' })
    setCommandApprovalMode('allow-all')
    const second = client.run({ agent: 'base', prompt: 'second' })
    const third = client.run({
      agent: 'base',
      prompt: 'third',
      approvalMode: 'balanced',
    })
    complete()
    await Promise.all([first, second, third])
    expect(seen).toEqual(['strict', 'allow-all', 'balanced'])
    await client.retire()
  })
})
