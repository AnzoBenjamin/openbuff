/**
 * P2-T8: truth table for `isProcessSupervisionEnabled`. Supervision is on by
 * default; only `0`/`false`/`no`/`off` (trimmed, case-insensitive) opt out.
 * Launchability (Bun runtime, child entry on disk, platform) is checked
 * separately and covered by supervised-spawn-launchable.test.ts. The
 * function takes a plain env record, so no process.env mutation is needed.
 */
import { describe, expect, it } from 'bun:test'

import { isProcessSupervisionEnabled } from '../impl/agent-runtime'

describe('isProcessSupervisionEnabled truth table', () => {
  const cases: Array<[label: string, value: string | undefined, expected: boolean]> = [
    ['unset', undefined, true],
    ['empty string', '', true],
    ['whitespace only', '   ', true],
    ['1', '1', true],
    ['true', 'true', true],
    ['TRUE', 'TRUE', true],
    [' yes ', ' yes ', true],
    ['on', 'on', true],
    ['0', '0', false],
    ['false', 'false', false],
    ['False', 'False', false],
    [' no ', ' no ', false],
    ['OFF', 'OFF', false],
    ['garbage', 'garbage', true],
    ['nothing (not read as no)', 'nothing', true],
  ]

  for (const [label, value, expected] of cases) {
    it(`resolves ${label} => ${expected}`, () => {
      const env =
        value === undefined ? {} : { OPENBUFF_PROCESS_SUPERVISION: value }
      expect(isProcessSupervisionEnabled(env)).toBe(expected)
    })
  }
})
