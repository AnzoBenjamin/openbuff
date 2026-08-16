import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import React from 'react'

import { SHEEN_INTERVAL_MS } from '../../components/logo-constants'
import { useSheenAnimation } from '../use-sheen-animation'

/**
 * Tests for useSheenAnimation hook
 *
 * NOTE: Tests install a minimal React dispatcher so hooks can run without a renderer.
 */

describe('useSheenAnimation', () => {
  type ReactInternals = {
    H: {
      useState: <T>(value: T) => [T, () => void]
      useCallback: <T>(callback: T) => T
      useEffect: (effect: () => void | (() => void)) => void
    }
  }
  const reactInternals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: ReactInternals
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  let originalSetInterval: typeof setInterval
  let originalClearInterval: typeof clearInterval
  let intervals: { id: number; ms: number; fn: () => void; cleared: boolean }[]
  let nextId: number
  let originalDispatcher: ReactInternals['H'] | undefined

  beforeEach(() => {
    originalDispatcher = reactInternals.H
    reactInternals.H = {
      useState: <T>(value: T) => [value, () => {}],
      useCallback: <T>(callback: T) => callback,
      useEffect: (effect: () => void | (() => void)) => {
        effect()
      },
    }

    intervals = []
    nextId = 1
    originalSetInterval = globalThis.setInterval
    originalClearInterval = globalThis.clearInterval

    globalThis.setInterval = ((fn: () => void, ms?: number) => {
      const id = nextId++
      intervals.push({ id, ms: Number(ms ?? 0), fn, cleared: false })
      return id as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval

    globalThis.clearInterval = ((id?: ReturnType<typeof clearInterval>) => {
      const interval = intervals.find((t) => t.id === (id as unknown as number))
      if (interval) interval.cleared = true
    }) as typeof clearInterval
  })

  afterEach(() => {
    reactInternals.H = originalDispatcher!
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
  })

  const baseParams = {
    logoColor: '#fff',
    accentColor: '#9EFC62',
    blockColor: '#ffffff',
    terminalWidth: 80,
    sheenPosition: 0,
  }

  test('enabled: true schedules one interval at SHEEN_INTERVAL_MS', () => {
    const setSheenPosition = mock(() => {})

    useSheenAnimation({
      ...baseParams,
      setSheenPosition,
      enabled: true,
    })

    expect(intervals.length).toBe(1)
    expect(intervals[0].ms).toBe(SHEEN_INTERVAL_MS)
  })

  test('enabled: false schedules no interval and never calls setSheenPosition', () => {
    const setSheenPosition = mock(() => {})

    useSheenAnimation({
      ...baseParams,
      setSheenPosition,
      enabled: false,
    })

    expect(intervals.length).toBe(0)
    expect(setSheenPosition).not.toHaveBeenCalled()
  })
})
