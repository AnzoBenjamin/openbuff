import { describe, expect, test } from 'bun:test'

import { countCodeSearchResults } from '../code-search-summary'

describe('code search summary helpers', () => {
  test('counts formatted code search matches from stdout', () => {
    expect(
      countCodeSearchResults(`stdout: |-
  Found 2 matches
  ./message-block-helpers.ts:
    Line 13: export const getAgentBaseName = (type: string): string => {
    Line 196: getAgentBaseName(options.agentType ?? '') === 'code-searcher'`),
    ).toBe(2)
  })
})
