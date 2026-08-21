import { describe, expect, test } from 'bun:test'

import { selectSpecialistReviewers } from '../base2/specialist-risk-router'

describe('specialist risk router', () => {
  test('defaults omitted requirements to empty instead of throwing', () => {
    expect(selectSpecialistReviewers({ files: [] })).toEqual([])
    expect(
      selectSpecialistReviewers({ files: ['src/session/store.ts'] }),
    ).toEqual(['reliability-reviewer'])
  })

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

  test('routes reliability from exact code filename stems without directory signals', () => {
    // Widened vocabulary: a code file whose basename stem EXACTLY equals a
    // concurrency/runtime noun routes even outside a matching directory.
    expect(
      selectSpecialistReviewers({
        files: ['src/scheduler.ts'],
        requirements: '',
      }),
    ).toEqual(['reliability-reviewer'])
    expect(
      selectSpecialistReviewers({
        files: ['src/state.ts'],
        requirements: '',
      }),
    ).toEqual(['reliability-reviewer'])
    // Compound stems never match: substring containment is not enough.
    expect(
      selectSpecialistReviewers({
        files: ['src/retry-policy.ts'],
        requirements: '',
      }),
    ).toEqual([])
    // Non-code extensions (data/doc files) never match either.
    expect(
      selectSpecialistReviewers({ files: ['src/state.json'], requirements: '' }),
    ).toEqual([])
    // Directory-segment routing is unchanged. Note index.ts additionally
    // matches the pre-existing compatibility-reviewer path rule.
    expect(
      selectSpecialistReviewers({
        files: ['src/cache/index.ts'],
        requirements: '',
      }),
    ).toEqual(['compatibility-reviewer', 'reliability-reviewer'])
  })

  test('routes UI specialists for widened widget/layout/feature surfaces', () => {
    const keywords = 'Check keyboard focus and visual hierarchy.'
    expect(
      selectSpecialistReviewers({
        files: ['src/widgets/Chart.astro'],
        requirements: keywords,
      }),
    ).toEqual(['accessibility-reviewer', 'ux-visual-reviewer'])
    expect(
      selectSpecialistReviewers({
        files: ['src/features/dashboard/page.html'],
        requirements: keywords,
      }),
    ).toEqual(['accessibility-reviewer', 'ux-visual-reviewer'])
    // A UI-ish file alone still routes nothing without matching keywords.
    expect(
      selectSpecialistReviewers({
        files: ['src/widgets/Chart.astro'],
        requirements: 'Rename a prop.',
      }),
    ).toEqual([])
  })

  test('routes keyword prefix stems across inflections', () => {
    // Stem keywords match any word continuation: idempotent/idempotency,
    // concurrency/concurrent, deprecated/deprecate, migrations, profiling.
    expect(
      selectSpecialistReviewers({
        files: [],
        requirements: 'Make the upload handler idempotent.',
      }),
    ).toEqual(['reliability-reviewer'])
    expect(
      selectSpecialistReviewers({
        files: [],
        requirements: 'Fix the concurrency bug.',
      }),
    ).toEqual(['reliability-reviewer'])
    expect(
      selectSpecialistReviewers({
        files: [],
        requirements: 'Deprecate the feature flag.',
      }),
    ).toEqual(['compatibility-reviewer'])
    expect(
      selectSpecialistReviewers({
        files: [],
        requirements: 'Run the pending migrations.',
      }),
    ).toEqual(['migration-reviewer'])
    expect(
      selectSpecialistReviewers({
        files: [],
        requirements: 'Add profiling to the release build.',
      }),
    ).toEqual(['performance-specialist'])
  })

  test('normalizes path separators, casing, and dotfiles before matching', () => {
    // Backslash separators are normalized to '/' before path matching.
    expect(
      selectSpecialistReviewers({
        files: ['src\\session\\store.ts'],
        requirements: '',
      }),
    ).toEqual(['reliability-reviewer'])
    // Paths are lowercased before matching.
    expect(
      selectSpecialistReviewers({
        files: ['SRC/SESSION/STORE.TS'],
        requirements: '',
      }),
    ).toEqual(['reliability-reviewer'])
    // Dotfiles take the dot <= 0 stem branch: the whole basename becomes the
    // stem, which never equals a reliability code stem.
    expect(
      selectSpecialistReviewers({ files: ['.gitignore'], requirements: '' }),
    ).toEqual([])
  })
})
