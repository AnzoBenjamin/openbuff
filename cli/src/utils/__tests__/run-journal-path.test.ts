import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'bun:test'

import { openRunJournalForRun } from '../run-journal-path'

describe('openRunJournalForRun (P2-T7 live-run journal opener)', () => {
  it('opens a real journal at an injected path and journals + closes it', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'run-journal-path-'))
    try {
      const dbPath = path.join(parent, 'run-journal.db')
      const warnings: string[] = []

      const journal = openRunJournalForRun({
        path: dbPath,
        warn: (message) => warnings.push(message),
      })

      expect(journal).toBeDefined()
      expect(warnings).toEqual([])
      journal!.append('run-1', {
        eventType: 'step_boundary',
        stepNumber: 0,
        correlation: 's0',
        payload: { status: 'completed' },
      })
      // The created journal carries the P2-T7 runIds dash extension.
      expect(journal!.runIds()).toEqual(['run-1'])
      await journal!.close()
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('fails open: an unopenable path warns once and returns undefined', () => {
    const warnings: string[] = []

    const journal = openRunJournalForRun({
      path: '/nonexistent-root-dir-for-openbuff-tests/nope/run-journal.db',
      warn: (message) => warnings.push(message),
    })

    // Fail-open: the caller gets undefined (run proceeds WITHOUT journaling)
    // and exactly one warning — never a throw.
    expect(journal).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('run journal unavailable')
    expect(warnings[0]).toContain('continuing without journaling')
  })
})
