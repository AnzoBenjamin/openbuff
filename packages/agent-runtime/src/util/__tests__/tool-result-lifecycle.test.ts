import { describe, expect, it } from 'bun:test'

import {
  DEFAULT_FULL_TOOL_RESULTS_TO_KEEP,
  TOOL_RESULT_IMPORTANCE_HIGH_TAG,
  TOOL_RESULT_IMPORTANCE_NORMAL_TAG,
  TOOL_RESULT_LIFECYCLE_TAG,
  isProtectedToolResult,
  lifecycleTagsForToolResult,
  shouldKeepFullToolResult,
} from '../tool-result-lifecycle'

describe('lifecycleTagsForToolResult', () => {
  it('tags query_index and read_files as normal lifecycle tools', () => {
    for (const toolName of ['query_index', 'read_files'] as const) {
      expect(lifecycleTagsForToolResult(toolName)).toEqual([
        TOOL_RESULT_LIFECYCLE_TAG,
        TOOL_RESULT_IMPORTANCE_NORMAL_TAG,
      ])
    }
  })

  it('tags spawn_agents as high importance', () => {
    expect(lifecycleTagsForToolResult('spawn_agents')).toEqual([
      TOOL_RESULT_LIFECYCLE_TAG,
      TOOL_RESULT_IMPORTANCE_HIGH_TAG,
    ])
  })

  it('returns empty tags for non-verbose tools', () => {
    expect(lifecycleTagsForToolResult('write_file')).toEqual([])
    expect(lifecycleTagsForToolResult('str_replace')).toEqual([])
  })
})

describe('isProtectedToolResult', () => {
  it('protects keepDuringTruncation', () => {
    expect(isProtectedToolResult({ keepDuringTruncation: true })).toBe(true)
  })

  it('protects high importance and pinned tags', () => {
    expect(
      isProtectedToolResult({
        tags: [TOOL_RESULT_IMPORTANCE_HIGH_TAG],
      }),
    ).toBe(true)
    expect(isProtectedToolResult({ tags: ['pinned'] })).toBe(true)
    expect(isProtectedToolResult({ tags: ['pinned_active_work'] })).toBe(true)
  })

  it('does not protect normal lifecycle tags alone', () => {
    expect(
      isProtectedToolResult({
        tags: [TOOL_RESULT_LIFECYCLE_TAG, TOOL_RESULT_IMPORTANCE_NORMAL_TAG],
      }),
    ).toBe(false)
  })
})

describe('shouldKeepFullToolResult', () => {
  it('never compresses protected results even when keep budget is exhausted', () => {
    expect(
      shouldKeepFullToolResult({
        toolName: 'run_terminal_command',
        keepDuringTruncation: true,
        numFullKeptSoFar: 99,
        maxFullToKeep: DEFAULT_FULL_TOOL_RESULTS_TO_KEEP,
      }),
    ).toBe(true)

    expect(
      shouldKeepFullToolResult({
        toolName: 'run_terminal_command',
        tags: [TOOL_RESULT_IMPORTANCE_HIGH_TAG],
        numFullKeptSoFar: 99,
      }),
    ).toBe(true)
  })

  it('keeps the newest normal result full and compresses the next', () => {
    expect(
      shouldKeepFullToolResult({
        toolName: 'run_terminal_command',
        tags: [TOOL_RESULT_LIFECYCLE_TAG, TOOL_RESULT_IMPORTANCE_NORMAL_TAG],
        numFullKeptSoFar: 0,
      }),
    ).toBe(true)

    expect(
      shouldKeepFullToolResult({
        toolName: 'run_terminal_command',
        tags: [TOOL_RESULT_LIFECYCLE_TAG, TOOL_RESULT_IMPORTANCE_NORMAL_TAG],
        numFullKeptSoFar: 1,
      }),
    ).toBe(false)
  })
})
