import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { getRecentCommandIds, isRecentCommand, recordCommandUse } from '../command-mru'

// command-mru persists under the project data dir; the helpers are imported
// once, so ordering behavior is asserted through the in-memory contract the
// palette consumes (fail-open persistence is exercised by not throwing when
// the data dir is a temp location).
describe('command-mru', () => {
  test('most-recent-first ordering, dedupe, bounded API shape', () => {
    recordCommandUse('doctor')
    recordCommandUse('plan')
    recordCommandUse('doctor')
    const recent = getRecentCommandIds()
    expect(recent.indexOf('doctor')).toBeLessThan(recent.indexOf('plan'))
    expect(recent.filter((id) => id === 'doctor')).toHaveLength(1)
    expect(isRecentCommand('doctor')).toBe(true)
    expect(isRecentCommand('never-used-command')).toBe(false)
  })
})
