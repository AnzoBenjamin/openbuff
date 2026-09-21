import { describe, expect, test } from 'bun:test'

import { clientToolCallSchema } from '../list'

describe('clientToolCallSchema run_terminal_command approval_receipt_id', () => {
  test('keeps approval_receipt_id on parsed input', () => {
    const parsed = clientToolCallSchema.parse({
      toolName: 'run_terminal_command',
      input: {
        command: 'git status',
        mode: 'assistant',
        permission_profile: 'full-access',
        approval_receipt_id: 'rcpt-1',
      },
    })
    expect(parsed.toolName).toBe('run_terminal_command')
    expect(parsed.input.approval_receipt_id).toBe('rcpt-1')
  })

  test('parses when approval_receipt_id is omitted', () => {
    const parsed = clientToolCallSchema.parse({
      toolName: 'run_terminal_command',
      input: {
        command: 'git status',
        mode: 'assistant',
        permission_profile: 'full-access',
      },
    })
    expect(parsed.toolName).toBe('run_terminal_command')
    expect(parsed.input.approval_receipt_id).toBeUndefined()
  })
})
