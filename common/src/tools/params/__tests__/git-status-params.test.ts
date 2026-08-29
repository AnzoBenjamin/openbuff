import { describe, expect, it } from 'bun:test'

import { gitStatusParams } from '../tool/git-status'

describe('git_status params', () => {
  describe('description', () => {
    it('documents the suppressed { unchanged: true, note } variant', () => {
      expect(gitStatusParams.description).toContain('{ unchanged: true, note }')
      expect(gitStatusParams.description).toContain(
        'no status/diff/branch fields',
      )
    })
  })

  describe('outputSchema', () => {
    it('accepts a full status payload', () => {
      const parsed = gitStatusParams.outputSchema.safeParse([
        {
          type: 'json',
          value: {
            branch: 'main',
            status: ' M src/file.ts',
            diff: 'diff --git a/src/file.ts b/src/file.ts',
            truncated: false,
          },
        },
      ])
      expect(parsed.success).toBe(true)
    })

    it('accepts a status-only payload', () => {
      const parsed = gitStatusParams.outputSchema.safeParse([
        {
          type: 'json',
          value: {
            status: '',
          },
        },
      ])
      expect(parsed.success).toBe(true)
    })

    it('accepts an errorMessage payload', () => {
      const parsed = gitStatusParams.outputSchema.safeParse([
        {
          type: 'json',
          value: {
            errorMessage: 'not a git repository',
          },
        },
      ])
      expect(parsed.success).toBe(true)
    })

    it('accepts the suppressed variant when unchanged is exactly true', () => {
      const parsed = gitStatusParams.outputSchema.safeParse([
        {
          type: 'json',
          value: {
            unchanged: true,
            note: 'Worktree unchanged since last git_status this turn.',
          },
        },
      ])
      expect(parsed.success).toBe(true)
    })

    it('rejects the suppressed variant when unchanged is not the literal true', () => {
      for (const unchanged of [false, 'true', 1, undefined]) {
        const parsed = gitStatusParams.outputSchema.safeParse([
          {
            type: 'json',
            value: {
              ...(unchanged === undefined ? {} : { unchanged }),
              note: 'Worktree unchanged since last git_status this turn.',
            },
          },
        ])
        expect(parsed.success).toBe(false)
      }
    })

    it('rejects a payload that matches neither union branch', () => {
      // note alone is not a full observation (missing status) and is not the
      // suppressed variant (missing unchanged: true).
      const neitherBranch = gitStatusParams.outputSchema.safeParse([
        {
          type: 'json',
          value: { note: 'n' },
        },
      ])
      expect(neitherBranch.success).toBe(false)

      const emptyObject = gitStatusParams.outputSchema.safeParse([
        { type: 'json', value: {} },
      ])
      expect(emptyObject.success).toBe(false)
    })
  })
})
