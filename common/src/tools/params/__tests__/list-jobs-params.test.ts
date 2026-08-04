import { describe, expect, it } from 'bun:test'

import { listJobsParams } from '../tool/list-jobs'

describe('list_jobs params', () => {
  describe('description', () => {
    it('documents the suppressed { unchanged: true, note } variant', () => {
      expect(listJobsParams.description).toContain('{ unchanged: true, note }')
      expect(listJobsParams.description).toContain('no jobs field')
    })
  })

  describe('outputSchema', () => {
    it('accepts a full digest payload with jobs and note', () => {
      const parsed = listJobsParams.outputSchema.safeParse([
        {
          type: 'json',
          value: {
            jobs: [
              {
                jobId: 'job-1',
                kind: 'process',
                command: 'bun test',
                status: 'running',
                startedAt: 123,
                pending: '<10',
                gap: false,
              },
            ],
            note: 'No action required unless you need this output.',
          },
        },
      ])
      expect(parsed.success).toBe(true)
    })

    it('accepts the suppressed variant when unchanged is exactly true', () => {
      const parsed = listJobsParams.outputSchema.safeParse([
        {
          type: 'json',
          value: {
            unchanged: true,
            note: 'No action required unless you need this output.',
          },
        },
      ])
      expect(parsed.success).toBe(true)
    })

    it('rejects the suppressed variant when unchanged is not the literal true', () => {
      for (const unchanged of [false, 'true', 1, undefined]) {
        const parsed = listJobsParams.outputSchema.safeParse([
          {
            type: 'json',
            value: {
              ...(unchanged === undefined ? {} : { unchanged }),
              note: 'No action required unless you need this output.',
            },
          },
        ])
        expect(parsed.success).toBe(false)
      }
    })

    it('rejects a payload that matches neither union branch', () => {
      // A jobs-bearing payload missing required row fields fails the digest
      // branch, and a payload with neither `jobs` nor `unchanged` matches no
      // branch at all. Note `{ unchanged: true, note, jobs: [] }` is NOT such
      // a case: an empty `jobs` array is a valid digest, so the union accepts
      // it (the extra `unchanged` key is stripped).
      const missingRowFields = listJobsParams.outputSchema.safeParse([
        { type: 'json', value: { jobs: [{}], note: 'n' } },
      ])
      expect(missingRowFields.success).toBe(false)

      const neitherBranch = listJobsParams.outputSchema.safeParse([
        {
          type: 'json',
          value: { note: 'n' },
        },
      ])
      expect(neitherBranch.success).toBe(false)
    })
  })
})
