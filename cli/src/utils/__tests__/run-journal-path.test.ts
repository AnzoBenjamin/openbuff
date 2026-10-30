import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createRunJournal } from '@codebuff/agent-runtime/util/run-journal'
import { describe, expect, it } from 'bun:test'

import {
  RUN_JOURNAL_DEFAULT_MAINTENANCE,
  RUN_JOURNAL_DEFAULT_RETENTION,
  RUN_JOURNAL_MAINTENANCE_TRIGGER_BYTES,
  maintainRunJournalIfNeeded,
  openRunJournalForRun,
} from '../run-journal-path'

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

  it('passes RUN_JOURNAL_DEFAULT_RETENTION to createRunJournal (write-side cap)', async () => {
    const seen: Parameters<typeof createRunJournal>[0][] = []

    // Injectable factory seam: record the params, then delegate to the real
    // createRunJournal so the wiring is exercised end-to-end (:memory:
    // keeps it hermetic).
    const journal = openRunJournalForRun({
      path: ':memory:',
      warn: () => {},
      createRunJournal: (params) => {
        seen.push(params)
        return createRunJournal(params)
      },
    })
    expect(journal).toBeDefined()
    expect(seen).toEqual([
      { path: ':memory:', retention: RUN_JOURNAL_DEFAULT_RETENTION },
    ])
    await journal!.close()
  })

  it('forwards an explicit retention override to createRunJournal', async () => {
    const seen: Parameters<typeof createRunJournal>[0][] = []
    const retention = { maxEvents: 5 }

    const journal = openRunJournalForRun({
      path: ':memory:',
      warn: () => {},
      retention,
      createRunJournal: (params) => {
        seen.push(params)
        return createRunJournal(params)
      },
    })
    expect(journal).toBeDefined()
    expect(seen).toEqual([{ path: ':memory:', retention }])
    await journal!.close()
  })
})

describe('maintainRunJournalIfNeeded (write-side file-level maintenance)', () => {
  it('exports the documented trigger and default maintenance parameters', () => {
    expect(RUN_JOURNAL_MAINTENANCE_TRIGGER_BYTES).toBe(512 * 1024 * 1024)
    expect(RUN_JOURNAL_DEFAULT_MAINTENANCE).toEqual({
      keepRuns: 10,
      vacuum: true,
    })
  })

  it('under the trigger: returns without opening the db (seam never invoked)', async () => {
    const seen: Parameters<typeof createRunJournal>[0][] = []
    const result = await maintainRunJournalIfNeeded({
      path: ':memory:',
      statFn: () => ({ size: RUN_JOURNAL_MAINTENANCE_TRIGGER_BYTES - 1 }),
      createRunJournal: (params) => {
        seen.push(params)
        return createRunJournal(params)
      },
    })
    expect(result).toEqual({ maintained: false, reason: 'under-trigger' })
    expect(seen).toEqual([])
  })

  it('a missing file returns { maintained: false, reason: "missing" } without opening the db', async () => {
    const seen: Parameters<typeof createRunJournal>[0][] = []
    const result = await maintainRunJournalIfNeeded({
      // No statFn injected: the default fs.statSync throws ENOENT for the
      // missing file, which must map to reason "missing" (never a throw).
      path: path.join(
        tmpdir(),
        'openbuff-run-journal-path-test-missing',
        'run-journal.db',
      ),
      createRunJournal: (params) => {
        seen.push(params)
        return createRunJournal(params)
      },
    })
    expect(result).toEqual({ maintained: false, reason: 'missing' })
    expect(seen).toEqual([])
  })

  it('over the trigger: opens via the seam, runs maintain with the expected params, and closes the journal', async () => {
    const seen: Parameters<typeof createRunJournal>[0][] = []
    const maintainCalls: Array<{
      keepRuns?: number
      vacuum?: boolean
    } | undefined> = []
    let closeCount = 0
    const result = await maintainRunJournalIfNeeded({
      path: ':memory:',
      statFn: () => ({ size: RUN_JOURNAL_MAINTENANCE_TRIGGER_BYTES + 1 }),
      maintenance: { keepRuns: 3, vacuum: false },
      createRunJournal: (params) => {
        seen.push(params)
        const real = createRunJournal(params)
        return {
          ...real,
          maintain: (
            m?: { keepRuns?: number; vacuum?: boolean },
          ): { prunedRunCount: number; vacuumed: boolean } => {
            maintainCalls.push(m)
            return real.maintain(m)
          },
          close: async () => {
            closeCount += 1
            await real.close()
          },
        }
      },
    })
    expect(result).toEqual({
      maintained: true,
      prunedRunCount: 0,
      vacuumed: false,
    })
    // The seam got the resolved path plus the default write-side retention
    // (mirroring openRunJournalForRun; readers never delete).
    expect(seen).toEqual([
      { path: ':memory:', retention: RUN_JOURNAL_DEFAULT_RETENTION },
    ])
    expect(maintainCalls).toEqual([{ keepRuns: 3, vacuum: false }])
    expect(closeCount).toBe(1)
  })

  it('over the trigger: yields BEFORE the expensive work — the create seam is not invoked in the caller tick', async () => {
    const seen: Parameters<typeof createRunJournal>[0][] = []
    const promise = maintainRunJournalIfNeeded({
      path: ':memory:',
      statFn: () => ({ size: RUN_JOURNAL_MAINTENANCE_TRIGGER_BYTES + 1 }),
      createRunJournal: (params) => {
        seen.push(params)
        return createRunJournal(params)
      },
    })
    // The async pass must not block its caller: the db open (and every
    // heavy step after it — maintain's per-run DELETEs, the VACUUM, the
    // post-pass marker write) stays deferred past the caller's
    // synchronous tick, so a fire-and-forget boot kick can never freeze
    // the terminal before the first frame paints.
    expect(seen).toEqual([])
    const result = await promise
    expect(result.maintained).toBe(true)
    expect(seen).toHaveLength(1)
  })

  it('forwards RUN_JOURNAL_DEFAULT_MAINTENANCE when no maintenance params are injected', async () => {
    const maintainCalls: Array<{
      keepRuns?: number
      vacuum?: boolean
    } | undefined> = []
    const result = await maintainRunJournalIfNeeded({
      path: ':memory:',
      // Exactly at the trigger is NOT under it: the file sits at the bound
      // the retention documents, so maintenance fires.
      statFn: () => ({ size: RUN_JOURNAL_MAINTENANCE_TRIGGER_BYTES }),
      createRunJournal: (params) => {
        const real = createRunJournal(params)
        return {
          ...real,
          maintain: (
            m?: { keepRuns?: number; vacuum?: boolean },
          ): { prunedRunCount: number; vacuumed: boolean } => {
            maintainCalls.push(m)
            return real.maintain(m)
          },
        }
      },
    })
    expect(result.maintained).toBe(true)
    expect(maintainCalls).toEqual([RUN_JOURNAL_DEFAULT_MAINTENANCE])
  })

  it('fail-open: a createRunJournal seam that throws returns { maintained: false } and never throws', async () => {
    const result = await maintainRunJournalIfNeeded({
      path: ':memory:',
      statFn: () => ({ size: RUN_JOURNAL_MAINTENANCE_TRIGGER_BYTES + 1 }),
      createRunJournal: () => {
        throw new Error('injected open failure')
      },
    })
    expect(result.maintained).toBe(false)
    expect(result.reason).toContain('run journal maintenance unavailable')
    expect(result.reason).toContain('injected open failure')
  })

  it('fail-open: a throwing statFn degrades to { maintained: false } and never throws', async () => {
    const seen: Parameters<typeof createRunJournal>[0][] = []
    const result = await maintainRunJournalIfNeeded({
      path: ':memory:',
      statFn: () => {
        throw new Error('injected stat failure')
      },
      createRunJournal: (params) => {
        seen.push(params)
        return createRunJournal(params)
      },
    })
    // A stat failure is indistinguishable from a missing file at this seam
    // — there is nothing observable to maintain — so the pass is a no-op,
    // never a throw.
    expect(result).toEqual({ maintained: false, reason: 'missing' })
    expect(seen).toEqual([])
  })

  it('marker hysteresis: a recorded size >= the current size skips WITHOUT opening the db', async () => {
    // In-memory marker double (hermetic): stands in for the sidecar
    // `<journalPath>.maintained` file so the marker cases never touch the
    // real filesystem.
    const markers = new Map<string, number>([
      [':memory:', RUN_JOURNAL_MAINTENANCE_TRIGGER_BYTES + 100],
    ])
    const seen: Parameters<typeof createRunJournal>[0][] = []
    const readMaintenanceMarker = (journalPath: string): number | undefined =>
      markers.get(journalPath)
    const writeMaintenanceMarker = (
      journalPath: string,
      sizeInBytes: number,
    ): void => {
      markers.set(journalPath, sizeInBytes)
    }
    const result = await maintainRunJournalIfNeeded({
      path: ':memory:',
      statFn: () => ({ size: RUN_JOURNAL_MAINTENANCE_TRIGGER_BYTES + 1 }),
      createRunJournal: (params) => {
        seen.push(params)
        return createRunJournal(params)
      },
      readMaintenanceMarker,
      writeMaintenanceMarker,
    })
    expect(result).toEqual({
      maintained: false,
      reason: 'unchanged-since-maintenance',
    })
    // The createRunJournal seam was NOT invoked (the db was never opened)
    // and the skip did not rewrite the marker.
    expect(seen).toEqual([])
    expect(markers.get(':memory:')).toBe(
      RUN_JOURNAL_MAINTENANCE_TRIGGER_BYTES + 100,
    )
  })

  it('marker hysteresis: a journal that GREW past the recorded size runs the pass and records the post-pass size', async () => {
    const markers = new Map<string, number>([
      [':memory:', RUN_JOURNAL_MAINTENANCE_TRIGGER_BYTES + 1],
    ])
    const seen: Parameters<typeof createRunJournal>[0][] = []
    const readMaintenanceMarker = (journalPath: string): number | undefined =>
      markers.get(journalPath)
    const writeMaintenanceMarker = (
      journalPath: string,
      sizeInBytes: number,
    ): void => {
      markers.set(journalPath, sizeInBytes)
    }
    const invoke = () =>
      maintainRunJournalIfNeeded({
        path: ':memory:',
        // The journal GREW past the recorded marker size.
        statFn: () => ({ size: RUN_JOURNAL_MAINTENANCE_TRIGGER_BYTES + 100 }),
        createRunJournal: (params) => {
          seen.push(params)
          return createRunJournal(params)
        },
        readMaintenanceMarker,
        writeMaintenanceMarker,
      })
    const first = await invoke()
    expect(first.maintained).toBe(true)
    expect(seen).toHaveLength(1)
    // The pass recorded the POST-PASS size (the re-stat the helper runs
    // after maintain), so the next unchanged boot compares against what
    // this pass left behind...
    expect(markers.get(':memory:')).toBe(
      RUN_JOURNAL_MAINTENANCE_TRIGGER_BYTES + 100,
    )
    // ...and skips WITHOUT opening the db again.
    const second = await invoke()
    expect(second).toEqual({
      maintained: false,
      reason: 'unchanged-since-maintenance',
    })
    expect(seen).toHaveLength(1)
  })

  it('fail-open: a corrupt marker is ignored (pass runs) and a fresh marker is written via the default seams', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'run-journal-marker-'))
    try {
      const dbPath = path.join(parent, 'run-journal.db')
      // Corrupt marker content: the DEFAULT read seam must degrade to
      // undefined — never throw — so the pass runs.
      await writeFile(`${dbPath}.maintained`, 'not-a-number', 'utf8')
      const seen: Parameters<typeof createRunJournal>[0][] = []
      const result = await maintainRunJournalIfNeeded({
        path: dbPath,
        // The real db file need not exist: the injected statFn reports an
        // over-trigger size while the DEFAULT marker seams operate on the
        // real sidecar path in the temp dir.
        statFn: () => ({ size: RUN_JOURNAL_MAINTENANCE_TRIGGER_BYTES + 1 }),
        createRunJournal: (params) => {
          seen.push(params)
          return createRunJournal(params)
        },
      })
      expect(result).toEqual({
        maintained: true,
        prunedRunCount: 0,
        vacuumed: false,
      })
      expect(seen).toHaveLength(1)
      // The pass overwrote the corrupt marker with the post-pass size.
      expect(await readFile(`${dbPath}.maintained`, 'utf8')).toBe(
        String(RUN_JOURNAL_MAINTENANCE_TRIGGER_BYTES + 1),
      )
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('fail-open: throwing marker read/write seams never break the pass', async () => {
    // A throwing READ is absorbed — the marker cannot gate the pass — ...
    const seen: Parameters<typeof createRunJournal>[0][] = []
    const readResult = await maintainRunJournalIfNeeded({
      path: ':memory:',
      statFn: () => ({ size: RUN_JOURNAL_MAINTENANCE_TRIGGER_BYTES + 1 }),
      createRunJournal: (params) => {
        seen.push(params)
        return createRunJournal(params)
      },
      readMaintenanceMarker: () => {
        throw new Error('injected marker read failure')
      },
    })
    expect(readResult.maintained).toBe(true)
    expect(seen).toHaveLength(1)
    // ...and a throwing WRITE still returns the successful pass result.
    const writeResult = await maintainRunJournalIfNeeded({
      path: ':memory:',
      statFn: () => ({ size: RUN_JOURNAL_MAINTENANCE_TRIGGER_BYTES + 1 }),
      createRunJournal: (params) => createRunJournal(params),
      writeMaintenanceMarker: () => {
        throw new Error('injected marker write failure')
      },
    })
    expect(writeResult.maintained).toBe(true)
    expect(writeResult.prunedRunCount).toBe(0)
  })
})
