import { describe, expect, test } from 'bun:test'
import stringWidth from 'string-width'

import { formatQueuedPreview } from '../helpers'

describe('queue preview', () => {
  test('identifies the FIFO head, its mode and its attachments', () => {
    const preview = formatQueuedPreview(
      [
        { content: 'Review first', agentMode: 'PLAN', attachments: [{}, {}] },
        { content: 'Run later', agentMode: 'EXECUTE_PLAN', attachments: [] },
      ],
      80,
    )
    expect(preview).toBe('Next · Plan · 2 attachments: Review first (+1)')
    expect(preview).not.toContain('Run later')
  })

  test('attachment-only queued work has a visible identity', () => {
    expect(
      formatQueuedPreview([
        { content: '', agentMode: 'DEFAULT', attachments: [{}] },
      ]),
    ).toBe('Next · Default · 1 attachment')
  })

  test('wide and combined glyphs fit the terminal cell budget', () => {
    const preview = formatQueuedPreview(
      [{ content: '界界界界界界界界界界 👩‍💻 é', agentMode: 'PLAN' }],
      25,
    )
    expect(stringWidth(preview)).toBeLessThanOrEqual(25)
    expect(preview).toEndWith('…')
    expect(preview).not.toContain('\ufffd')
  })

  test('clipping the next prompt retains the remaining queue count', () => {
    const preview = formatQueuedPreview(
      [
        {
          content: 'A very long prompt that cannot fit in the preview',
          agentMode: 'PLAN',
        },
        { content: 'Second' },
        { content: 'Third' },
      ],
      30,
    )
    expect(stringWidth(preview)).toBeLessThanOrEqual(30)
    expect(preview).toEndWith('… (+2)')
  })
})
