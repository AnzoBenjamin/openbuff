import { describe, expect, test } from 'bun:test'

import {
  READ_ONLY_BROWSER_ACTIONS,
  browserActionBlockedMessage,
  isBrowserActionAllowed,
} from '@codebuff/common/tools/browser-policy'

describe('isBrowserActionAllowed', () => {
  test('read-only permits the documented non-mutating actions', () => {
    for (const action of [
      'navigate',
      'snapshot',
      'screenshot',
      'design_tokens',
      'wait_for',
      'scroll',
      'pdf',
      'pixel_diff',
      'diagnose',
      'tab',
      'stop',
    ]) {
      expect(isBrowserActionAllowed(action, 'read-only')).toBe(true)
    }
  })

  test('read-only blocks every mutating action, fail-closed on unknown', () => {
    for (const action of [
      'click',
      'type',
      'key',
      'mouse',
      'hover',
      'drag',
      'select',
      'upload',
      'evaluate',
      'cookie',
      'storage',
      'network',
      'viewport',
      'recording',
      'not-a-real-action',
      '',
    ]) {
      expect(isBrowserActionAllowed(action, 'read-only')).toBe(false)
    }
    // Unknown/absent action types fail closed under read-only.
    expect(isBrowserActionAllowed(undefined, 'read-only')).toBe(false)
    expect(isBrowserActionAllowed(42, 'read-only')).toBe(false)
  })

  test('any other policy value allows everything (schema default contract)', () => {
    expect(isBrowserActionAllowed('click', 'allow-interactions')).toBe(true)
    expect(isBrowserActionAllowed('evaluate', undefined)).toBe(true)
    expect(isBrowserActionAllowed('click', 'typo-value')).toBe(true)
  })

  test('the allowlist matches the browser-use prompt taxonomy exactly', () => {
    // navigate/snapshot/screenshot/design_tokens/wait_for/scroll/pdf/
    // pixel_diff/diagnose/tab(list|switch)/stop — from the agent's own
    // read-only guardrail text.
    expect(READ_ONLY_BROWSER_ACTIONS.size).toBe(11)
  })
})

describe('browserActionBlockedMessage', () => {
  test('names the action and the remediation', () => {
    const message = browserActionBlockedMessage('click')
    expect(message).toContain('"click"')
    expect(message).toContain('read-only')
    expect(message).toContain('allow-interactions')
  })

  test('tolerates a missing action type', () => {
    expect(browserActionBlockedMessage(undefined)).toContain('(missing type)')
  })
})
