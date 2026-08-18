import { describe, expect, test } from 'bun:test'

import {
  formatIndexStatusChip,
  shouldForceStatusLineForIndex,
} from '../index-status'

describe('formatIndexStatusChip', () => {
  test('hides the chip when status is missing, disabled, or empty', () => {
    expect(formatIndexStatusChip(null)).toBeNull()
    expect(
      formatIndexStatusChip({ state: 'disabled', refreshing: false }),
    ).toBeNull()
    expect(
      formatIndexStatusChip({ state: 'empty', refreshing: false }),
    ).toBeNull()
  })

  test('shows building even when a refresh is also in flight', () => {
    expect(
      formatIndexStatusChip({ state: 'building', refreshing: true }),
    ).toEqual({
      label: 'idx building',
      tone: 'warning',
    })
    expect(
      formatIndexStatusChip({ state: 'building', refreshing: false }),
    ).toEqual({
      label: 'idx building',
      tone: 'warning',
    })
  })

  test('shows refreshing when a snapshot exists and a refresh is running', () => {
    expect(
      formatIndexStatusChip({ state: 'ready', refreshing: true }),
    ).toEqual({
      label: 'idx refreshing',
      tone: 'warning',
    })
    expect(
      formatIndexStatusChip({ state: 'degraded', refreshing: true }),
    ).toEqual({
      label: 'idx refreshing',
      tone: 'warning',
    })
  })

  test('shows stale and failed chips, hides ready and degraded', () => {
    expect(
      formatIndexStatusChip({ state: 'stale', refreshing: false }),
    ).toEqual({
      label: 'idx stale',
      tone: 'warning',
    })
    expect(
      formatIndexStatusChip({ state: 'failed', refreshing: false }),
    ).toEqual({
      label: 'idx failed',
      tone: 'error',
    })
    expect(
      formatIndexStatusChip({ state: 'ready', refreshing: false }),
    ).toBeNull()
    expect(
      formatIndexStatusChip({ state: 'degraded', refreshing: false }),
    ).toBeNull()
  })
})

describe('shouldForceStatusLineForIndex', () => {
  test('keeps the status line open for building, refreshing, and failed', () => {
    expect(
      shouldForceStatusLineForIndex({ state: 'building', refreshing: false }),
    ).toBe(true)
    expect(
      shouldForceStatusLineForIndex({ state: 'ready', refreshing: true }),
    ).toBe(true)
    expect(
      shouldForceStatusLineForIndex({ state: 'failed', refreshing: false }),
    ).toBe(true)
  })

  test('does not force the status line for a quiet ready chip', () => {
    expect(shouldForceStatusLineForIndex(null)).toBe(false)
    expect(
      shouldForceStatusLineForIndex({ state: 'ready', refreshing: false }),
    ).toBe(false)
    expect(
      shouldForceStatusLineForIndex({ state: 'stale', refreshing: false }),
    ).toBe(false)
  })
})
