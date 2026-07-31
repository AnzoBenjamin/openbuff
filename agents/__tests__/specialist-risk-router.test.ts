import { describe, expect, test } from 'bun:test'

import { selectSpecialistReviewers } from '../base2/specialist-risk-router'

describe('specialist risk router', () => {
  test('routes artifact risks deterministically in stable order', () => {
    expect(
      selectSpecialistReviewers({
        files: ['package.json', 'src/migrations/001.sql', 'src/public-api.ts'],
        requirements:
          'Preserve backward compatibility and make the retry state machine idempotent.',
      }),
    ).toEqual([
      'dependency-reviewer',
      'migration-reviewer',
      'compatibility-reviewer',
      'reliability-reviewer',
    ])
  })

  test('routes UI specialists only when requirements identify their risk', () => {
    const files = ['src/components/Dialog.tsx']
    expect(
      selectSpecialistReviewers({ files, requirements: 'Rename a prop.' }),
    ).toEqual([])
    expect(
      selectSpecialistReviewers({
        files,
        requirements:
          'Verify keyboard focus, screen-reader semantics, responsive layout, and screenshot hierarchy.',
      }),
    ).toEqual(['accessibility-reviewer', 'ux-visual-reviewer'])
  })

  test('routes product and evaluator review from explicit requirements', () => {
    expect(
      selectSpecialistReviewers({
        files: ['cli/src/chat.tsx'],
        requirements:
          'Check the user-facing end-to-end flow and independently evaluate requirement coverage.',
      }),
    ).toEqual(['product-reviewer', 'evaluator'])
  })

  test('does not route reliability from plan session STATE.json alone', () => {
    expect(
      selectSpecialistReviewers({
        files: [
          '.agents/sessions/read-tool-unification-2026-07/STATE.json',
          '.agents/sessions/read-tool-unification-2026-07/EVENTS.jsonl',
        ],
        requirements: 'Commit remaining work.',
      }),
    ).toEqual([])
  })

  test('routes reliability for real session/state code directories and retry requirements', () => {
    expect(
      selectSpecialistReviewers({
        files: ['src/session/store.ts'],
        requirements: 'Rename a prop.',
      }),
    ).toEqual(['reliability-reviewer'])
    expect(
      selectSpecialistReviewers({
        files: ['src/foo.ts'],
        requirements: 'Make the retry state machine idempotent.',
      }),
    ).toEqual(['reliability-reviewer'])
  })
})
