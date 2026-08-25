import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { initializeThemeStore } from '../../hooks/use-theme'
import { MemoryBox } from '../renderers/memory-box'
import { formatAge } from '../../commands/memory-command'

import type { MemoryContentBlock } from '../../types/chat'

initializeThemeStore()

const FIXED_NOW = 1_700_000_000_000
let originalNow: () => number

beforeEach(() => {
  originalNow = Date.now
  Date.now = () => FIXED_NOW
})

afterEach(() => {
  Date.now = originalNow
})

const makeStatusBlock = (
  overrides: Partial<Extract<MemoryContentBlock, { state: 'status' }>> = {},
): Extract<MemoryContentBlock, { state: 'status' }> => ({
  type: 'memory',
  state: 'status',
  revision: 7,
  updatedAt: FIXED_NOW - 45_000, // 45s ago
  goal: 'Build a cool feature for users',
  goalPreview: 'Build a cool feature for users',
  isGoalTruncated: false,
  counts: {
    decisions: 1,
    requirements: 2,
    editsMade: 3,
    validationResults: 4,
    blockers: 5,
    nextActions: 6,
  },
  evidence: {
    fresh: 3,
    stale: 1,
    total: 4,
  },
  stalePaths: ['src/old.ts', 'src/old2.ts'],
  totalStaleCount: 2,
  ...overrides,
})

describe('MemoryBox', () => {
  test('empty renders without throwing and contains empty messages', () => {
    const block: MemoryContentBlock = { type: 'memory', state: 'empty' }
    const markup = renderToStaticMarkup(<MemoryBox block={block} />)
    expect(markup).toContain('No persisted task memory for this project yet.')
    expect(markup).toContain('It is written after your first successful run completes.')
  })

  test('status renders revision·age header', () => {
    const block = makeStatusBlock({ revision: 12, updatedAt: FIXED_NOW - 5_000 })
    const expectedAge = formatAge(FIXED_NOW - block.updatedAt) // should be "5s"
    const markup = renderToStaticMarkup(<MemoryBox block={block} />)
    expect(markup).toContain(`${block.revision} \u00B7 ${expectedAge}`)
    expect(markup).toContain('12 \u00B7')
  })

  test('status renders goalPreview', () => {
    const block = makeStatusBlock({ goalPreview: 'Ship the feature', goal: 'Ship the feature' })
    const markup = renderToStaticMarkup(<MemoryBox block={block} />)
    expect(markup).toContain('Ship the feature')
    expect(markup).toContain('Goal')
  })

  test('status renders counts', () => {
    const block = makeStatusBlock()
    const markup = renderToStaticMarkup(<MemoryBox block={block} />)
    expect(markup).toContain('Decisions: 1')
    expect(markup).toContain('Requirements: 2')
    expect(markup).toContain('Edits: 3')
    expect(markup).toContain('Validations: 4')
    expect(markup).toContain('Blockers: 5')
    expect(markup).toContain('Next actions: 6')
  })

  test('status renders evidence badge with fresh/stale/total', () => {
    const block = makeStatusBlock({ evidence: { fresh: 5, stale: 2, total: 7 } })
    const markup = renderToStaticMarkup(<MemoryBox block={block} />)
    expect(markup).toContain('Evidence:')
    expect(markup).toContain('5 fresh')
    expect(markup).toContain('2 stale')
    expect(markup).toContain('(of 7)')
  })

  test('status shows stale header button with total count', () => {
    const block = makeStatusBlock({ stalePaths: ['a.ts'], totalStaleCount: 1, evidence: { fresh: 1, stale: 1, total: 2 } })
    const markup = renderToStaticMarkup(<MemoryBox block={block} />)
    expect(markup).toContain('Stale paths (1)')
    expect(markup).toContain('\u25BE Stale paths (1)')
  })

  test('status stale overflow header reflects totalStaleCount not slice length', () => {
    const block = makeStatusBlock({
      stalePaths: ['a.ts', 'b.ts'],
      totalStaleCount: 7,
      evidence: { fresh: 0, stale: 7, total: 7 },
    })
    const markup = renderToStaticMarkup(<MemoryBox block={block} />)
    // collapsed button shows total count 7, not slice length 2
    expect(markup).toContain('Stale paths (7)')
    // overflow "+ N more" is only visible when expanded, so collapsed should NOT contain it yet but header proves overflow logic
    expect(markup).not.toContain('+ 5 more')
    // ensure stalePaths themselves are hidden when collapsed
    expect(markup).not.toContain('a.ts')
  })

  test('status shows prune button when stale > 0', () => {
    const block = makeStatusBlock({ evidence: { fresh: 1, stale: 3, total: 4 } })
    const markup = renderToStaticMarkup(<MemoryBox block={block} />)
    expect(markup).toContain('Run /memory prune to drop stale evidence entries.')
  })

  test('status hides prune button when stale === 0', () => {
    const block = makeStatusBlock({ evidence: { fresh: 4, stale: 0, total: 4 }, totalStaleCount: 0, stalePaths: [] })
    const markup = renderToStaticMarkup(<MemoryBox block={block} />)
    expect(markup).not.toContain('Run /memory prune to drop stale evidence entries.')
    expect(markup).not.toContain('Stale paths')
  })

  test('status shows Expand button when goal is truncated', () => {
    const block = makeStatusBlock({
      goal: 'a'.repeat(200),
      goalPreview: 'a'.repeat(120),
      isGoalTruncated: true,
    })
    const markup = renderToStaticMarkup(<MemoryBox block={block} />)
    expect(markup).toContain('\u25BE Expand')
    expect(markup).toContain('a'.repeat(120))
    expect(markup).not.toContain('a'.repeat(200))
  })

  test('status hides Expand button when goal is not truncated', () => {
    const block = makeStatusBlock({ isGoalTruncated: false })
    const markup = renderToStaticMarkup(<MemoryBox block={block} />)
    expect(markup).not.toContain('\u25BE Expand')
  })

  test('pruned renders with plural entries', () => {
    const block: MemoryContentBlock = { type: 'memory', state: 'pruned', removed: 2, remaining: 5 }
    const markup = renderToStaticMarkup(<MemoryBox block={block} />)
    expect(markup).toContain('Pruned 2 stale evidence entries; 5 remain.')
  })

  test('pruned renders singular entry', () => {
    const block: MemoryContentBlock = { type: 'memory', state: 'pruned', removed: 1, remaining: 9 }
    const markup = renderToStaticMarkup(<MemoryBox block={block} />)
    expect(markup).toContain('Pruned 1 stale evidence entry; 9 remain.')
  })

  test('nothing-to-prune renders correctly', () => {
    const block: MemoryContentBlock = { type: 'memory', state: 'nothing-to-prune', remaining: 4 }
    const markup = renderToStaticMarkup(<MemoryBox block={block} />)
    expect(markup).toContain('Nothing to prune: all 4 evidence entries are fresh.')
  })

  test('no-record renders correctly', () => {
    const block: MemoryContentBlock = { type: 'memory', state: 'no-record' }
    const markup = renderToStaticMarkup(<MemoryBox block={block} />)
    expect(markup).toContain('No persisted task memory to prune for this project.')
  })

  test('failed renders cause and unchanged record line', () => {
    const block: MemoryContentBlock = {
      type: 'memory',
      state: 'failed',
      reason: 'concurrent-write',
      cause: 'the record changed while pruning (a run saved task memory); re-run /memory prune',
      removed: 3,
      remaining: 2,
    }
    const markup = renderToStaticMarkup(<MemoryBox block={block} />)
    expect(markup).toContain('Memory prune failed: the record changed while pruning')
    expect(markup).toContain('The record is unchanged: 3 stale evidence entries still present (2 fresh).')
  })

  test('failed singular entry', () => {
    const block: MemoryContentBlock = {
      type: 'memory',
      state: 'failed',
      reason: 'invalid-record',
      cause: 'the pruned record failed schema validation',
      removed: 1,
      remaining: 0,
    }
    const markup = renderToStaticMarkup(<MemoryBox block={block} />)
    expect(markup).toContain('1 stale evidence entry still present (0 fresh).')
  })

  test('error renders message', () => {
    const block: MemoryContentBlock = { type: 'memory', state: 'error', message: 'Memory status failed: boom' }
    const markup = renderToStaticMarkup(<MemoryBox block={block} />)
    expect(markup).toContain('Memory status failed: boom')
  })

  test('status renders zero counts without throwing', () => {
    const block = makeStatusBlock({
      counts: { decisions: 0, requirements: 0, editsMade: 0, validationResults: 0, blockers: 0, nextActions: 0 },
      evidence: { fresh: 0, stale: 0, total: 0 },
      stalePaths: [],
      totalStaleCount: 0,
    })
    const markup = renderToStaticMarkup(<MemoryBox block={block} />)
    expect(markup).toContain('Decisions: 0')
    expect(markup).toContain('0 fresh')
  })

  test('status with null goal still shows placeholder preview', () => {
    const block = makeStatusBlock({ goal: null, goalPreview: '(none recorded)', isGoalTruncated: false })
    const markup = renderToStaticMarkup(<MemoryBox block={block} />)
    expect(markup).toContain('(none recorded)')
  })
})
