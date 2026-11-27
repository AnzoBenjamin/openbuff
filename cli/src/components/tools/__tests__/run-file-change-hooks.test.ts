import { describe, expect, it } from 'bun:test'

import {
  formatHookRunHeader,
  isHookResultFailed,
} from '../run-file-change-hooks'

describe('run_file_change_hooks header', () => {
  it('counts a producer-shaped rejected preflight as failure without an exit code', () => {
    const rejected = {
      hookName: 'diagnostic-delta',
      validationStatus: 'diagnostic_delta_rejected',
    }
    expect(isHookResultFailed(rejected)).toBe(true)
    expect(
      formatHookRunHeader([{ hookName: 'tests', exitCode: 0 }, rejected]),
    ).toBe('Hooks (1 passed, 1 failed)')
  })

  it('keeps passed preflight and skipped hooks distinct', () => {
    expect(
      formatHookRunHeader([
        {
          hookName: 'diagnostic-delta',
          validationStatus: 'diagnostic_delta_passed',
        },
        { validationStatus: 'hooks_skipped' },
      ]),
    ).toBe('Hooks (1 passed, 1 skipped)')
  })
  it('does not present an all-skipped run as a passing validation', () => {
    expect(
      formatHookRunHeader([
        {
          validationStatus: 'hooks_skipped',
          message:
            'Configured file-change hooks were skipped because none matched.',
        },
      ]),
    ).toBe('Validation skipped')
  })
})
