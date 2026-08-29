import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, test, expect } from 'bun:test'

import {
  HISTORY_UNAVAILABLE_MESSAGE,
  deriveLoadedPrompts,
  filterAndScorePrompts,
  getEmptyResultsMessage,
  reanchorFocusForReload,
  reanchorFocusedPrompt,
  readPromptHistoryForDisplay,
  retryUnavailablePromptHistory,
} from '../prompt-history-search-screen'
import { fuzzyMatch } from '../../utils/fuzzy-match'
import {
  MESSAGE_HISTORY_MAX_RETRY_ATTEMPTS,
  MESSAGE_HISTORY_RETRY_COOLDOWN_MS,
  getMessageHistoryPath,
  getSessionHistoryRetry,
  getUnpersistedMessageHistory,
  setSessionHistoryRetry,
  setUnpersistedMessageHistory,
} from '../../utils/message-history'

import type { MessageHistoryLoadOutcome } from '../../utils/message-history'

/** The budget a session starts from: nothing spent, never attempted. */
const IDLE_SESSION_RETRY = {
  attempts: 0,
  lastAttemptMs: Number.NEGATIVE_INFINITY,
}

/**
 * Reset the two process-wide session stores message-history keeps (memory-only
 * prompts and the retry budget), which retryUnavailablePromptHistory and
 * readPromptHistoryForDisplay read and spend.
 *
 * Registered as hooks rather than called from test bodies: a test that throws
 * before its own cleanup would otherwise leak memory-only prompts and a spent
 * retry budget into every later test sharing this module instance.
 */
const resetSessionHistoryState = (): void => {
  setUnpersistedMessageHistory([])
  setSessionHistoryRetry(IDLE_SESSION_RETRY)
}

beforeEach(resetSessionHistoryState)
afterEach(resetSessionHistoryState)

describe('filterAndScorePrompts', () => {
  test('empty query returns all items capped at the limit', () => {
    const prompts = [
      'first prompt',
      'second prompt',
      'third prompt',
      '!ls -la',
      'fix the bug in auth',
    ]
    const result = filterAndScorePrompts(prompts, '', 3)
    // Empty query preserves input order (most-recent-first) and caps at limit.
    expect(result).toEqual(['first prompt', 'second prompt', 'third prompt'])

    // Limit larger than the list returns everything.
    const all = filterAndScorePrompts(prompts, '', 200)
    expect(all).toEqual(prompts)
  })

  test('a query that is a subsequence filters and scores correctly (best match first)', () => {
    const prompts = [
      'fix the authentication bug',
      'fix bug',
      'refactor the utils module',
      'fix the broken auth tests',
    ]
    // 'fix auth' is a subsequence of several prompts. The most compact,
    // best-scoring match ('fix the broken auth tests' or
    // 'fix the authentication bug') should rank ahead of 'fix bug' which
    // does not contain 'auth' at all and is filtered out.
    const result = filterAndScorePrompts(prompts, 'fix auth', 10)

    // 'fix bug' has no 'auth' -> excluded.
    expect(result).not.toContain('fix bug')
    // 'refactor the utils module' has no 'fix'/'auth' subsequence -> excluded.
    expect(result).not.toContain('refactor the utils module')

    // Remaining two both match; best score comes first.
    expect(result).toHaveLength(2)
    expect(result).toContain('fix the authentication bug')
    expect(result).toContain('fix the broken auth tests')

    // Verify ordering: the first result has a better (lower) fuzzyMatch score.
    const firstScore = fuzzyMatch(result[0], 'fix auth')!.score
    const secondScore = fuzzyMatch(result[1], 'fix auth')!.score
    expect(firstScore).toBeLessThanOrEqual(secondScore)
  })

  test('a query matching no prompts returns an empty list', () => {
    const prompts = ['hello world', 'fix the bug', 'run tests']
    const result = filterAndScorePrompts(prompts, 'zzzqqqxxx', 10)
    expect(result).toEqual([])
  })

  test('respects the limit when there are more matches than the cap', () => {
    const prompts = Array.from({ length: 50 }, (_, i) => `prompt ${i}`)
    const result = filterAndScorePrompts(prompts, 'prompt', 5)
    expect(result).toHaveLength(5)
  })

  test('query is case-insensitive', () => {
    const prompts = ['Fix The Bug', 'run tests']
    const lower = filterAndScorePrompts(prompts, 'fix', 10)
    const upper = filterAndScorePrompts(prompts, 'FIX', 10)
    expect(lower).toEqual(upper)
    expect(lower).toContain('Fix The Bug')
  })

  test('handles prompts with bash command prefix as-is', () => {
    const prompts = ['!git status', '!ls -la', 'normal prompt']
    const result = filterAndScorePrompts(prompts, 'git', 10)
    expect(result).toEqual(['!git status'])
  })
})

describe('deriveLoadedPrompts', () => {
  test('reverses the persisted order so the newest prompt is listed first', () => {
    // loadMessageHistorySafe returns most-recent-last; the list renders
    // most-recent-first, and filterAndScorePrompts caps an empty query by
    // relying on that order.
    const { prompts } = deriveLoadedPrompts(
      ['oldest', 'middle', 'newest'],
      false,
    )
    expect(prompts).toEqual(['newest', 'middle', 'oldest'])
  })

  test('leaves the loaded array untouched', () => {
    // The array belongs to the caller, so reversing it in place would corrupt
    // the history it read.
    const history = ['a', 'b']
    deriveLoadedPrompts(history, false)
    expect(history).toEqual(['a', 'b'])
  })

  test('selects the load state from the unavailability report', () => {
    // The mount effect leaves 'loading' behind for exactly one of these two, and
    // a degraded/busy read must not be collapsed into a genuinely empty load.
    expect(deriveLoadedPrompts([], false).loadState).toBe('loaded')
    expect(deriveLoadedPrompts([], true).loadState).toBe('unavailable')
    // A partial read still contributes its entries.
    expect(deriveLoadedPrompts(['partial'], true)).toEqual({
      prompts: ['partial'],
      loadState: 'unavailable',
    })
  })

  test('an unavailable load still reports an unavailable empty list', () => {
    expect(
      getEmptyResultsMessage('', deriveLoadedPrompts([], true).loadState),
    ).toBe(HISTORY_UNAVAILABLE_MESSAGE)
    expect(
      getEmptyResultsMessage('', deriveLoadedPrompts([], false).loadState),
    ).toBe('No prompt history yet')
  })
})

describe('getEmptyResultsMessage', () => {
  test('reports a not-yet-loaded history as loading, never as empty', () => {
    // The history is read from an effect, so the list genuinely renders before
    // the load resolves; reporting "no prompt history yet" there would claim a
    // state that has not been observed.
    expect(getEmptyResultsMessage('', 'loading')).toBe(
      'Loading prompt history...',
    )
    // Loading outranks the no-matches message too: nothing was searched yet.
    expect(getEmptyResultsMessage('zzz', 'loading')).toBe(
      'Loading prompt history...',
    )
  })

  test('reports genuinely empty history when the load succeeded', () => {
    expect(getEmptyResultsMessage('', 'loaded')).toBe('No prompt history yet')
  })

  test('reports no matches for a non-empty query when the load succeeded', () => {
    expect(getEmptyResultsMessage('  zzz  ', 'loaded')).toBe(
      'No prompts matching "zzz"',
    )
  })

  test('reports an unavailable history when the load failed or degraded', () => {
    // A busy lock or an unreadable history must not be misreported as empty
    // history, and it outranks the no-matches message because nothing was ever
    // searched. Asserting the exported constant keeps this from passing against
    // a stale copy of the string.
    expect(getEmptyResultsMessage('', 'unavailable')).toBe(
      HISTORY_UNAVAILABLE_MESSAGE,
    )
    expect(getEmptyResultsMessage('zzz', 'unavailable')).toBe(
      HISTORY_UNAVAILABLE_MESSAGE,
    )
    // The wording itself is pinned once, so a silent reword stays visible.
    expect(HISTORY_UNAVAILABLE_MESSAGE).toBe(
      'History unavailable — locked by another Openbuff process or unreadable',
    )
  })
})

describe('retryUnavailablePromptHistory', () => {
  const loadOk = (history: string[]) => (): MessageHistoryLoadOutcome => ({
    history,
    unavailable: false,
  })

  test('recovers the screen when a retry finally reads the history', () => {
    // The busy lock another Openbuff process held is gone: the overlay must
    // leave HISTORY_UNAVAILABLE_MESSAGE without being closed and reopened.
    const retried = retryUnavailablePromptHistory({
      loadState: 'unavailable',
      nowMs: 1_000,
      load: loadOk(['oldest', 'newest']),
    })
    expect(retried).toBeDefined()
    expect(retried!.loadState).toBe('loaded')
    // Still most-recent-first for display.
    expect(retried!.prompts).toEqual(['newest', 'oldest'])
    // A trustworthy read clears the shared retry budget, for every consumer.
    expect(getSessionHistoryRetry()).toEqual({
      attempts: 0,
      lastAttemptMs: 1_000,
    })
    expect(getEmptyResultsMessage('', retried!.loadState)).toBe(
      'No prompt history yet',
    )
  })

  test('does not read at all for a load that was not unavailable', () => {
    let calls = 0
    const load = (): MessageHistoryLoadOutcome => {
      calls++
      return { history: [], unavailable: false }
    }
    for (const loadState of ['loading', 'loaded'] as const) {
      expect(
        retryUnavailablePromptHistory({
          loadState,
          nowMs: 1_000,
          load,
        }),
      ).toBeUndefined()
    }
    expect(calls).toBe(0)
    expect(getSessionHistoryRetry()).toEqual(IDLE_SESSION_RETRY)
  })

  test('the process-wide retry budget bounds how often an unreadable history is re-read', () => {
    let calls = 0
    const load = (): MessageHistoryLoadOutcome => {
      calls++
      return { history: [], unavailable: true }
    }
    // Inside the cooldown nothing is read, so a poll tick cannot pay a blocking
    // lock acquisition per tick.
    setSessionHistoryRetry({ attempts: 1, lastAttemptMs: 1_000 })
    expect(
      retryUnavailablePromptHistory({
        loadState: 'unavailable',
        nowMs: 1_000 + MESSAGE_HISTORY_RETRY_COOLDOWN_MS - 1,
        load,
      }),
    ).toBeUndefined()
    // The attempt cap stops retrying entirely once the budget is spent — and
    // because the budget is process-wide, attempts another consumer (the
    // navigation hook, an earlier open of this overlay) already spent count
    // against this mount instead of giving it a fresh allowance.
    setSessionHistoryRetry({
      attempts: MESSAGE_HISTORY_MAX_RETRY_ATTEMPTS,
      lastAttemptMs: 1_000,
    })
    expect(
      retryUnavailablePromptHistory({
        loadState: 'unavailable',
        nowMs: 1_000 + MESSAGE_HISTORY_RETRY_COOLDOWN_MS,
        load,
      }),
    ).toBeUndefined()
    expect(calls).toBe(0)

    // A due retry that stays unavailable spends one attempt of the shared
    // budget and keeps the screen reporting unavailability.
    setSessionHistoryRetry({ attempts: 1, lastAttemptMs: 1_000 })
    const retried = retryUnavailablePromptHistory({
      loadState: 'unavailable',
      nowMs: 1_000 + MESSAGE_HISTORY_RETRY_COOLDOWN_MS,
      load,
    })
    expect(calls).toBe(1)
    expect(retried!.loadState).toBe('unavailable')
    expect(getSessionHistoryRetry()).toEqual({
      attempts: 2,
      lastAttemptMs: 1_000 + MESSAGE_HISTORY_RETRY_COOLDOWN_MS,
    })
  })

  test('a still-degraded retry grows the list but never shrinks it', () => {
    // The shared session read owns the never-shrink rule, so the screen adopts
    // whatever it resolves to: a partial read that saw more entries...
    const grown = retryUnavailablePromptHistory({
      loadState: 'unavailable',
      nowMs: 1_000,
      load: () => ({ history: ['partial', 'more'], unavailable: true }),
    })
    expect(grown!.prompts).toEqual(['more', 'partial'])
    expect(grown!.loadState).toBe('unavailable')

    // ...and one that resolved back to the retained view keeps every prompt.
    setSessionHistoryRetry(IDLE_SESSION_RETRY)
    const retained = retryUnavailablePromptHistory({
      loadState: 'unavailable',
      nowMs: 1_000,
      load: () => ({ history: ['oldest', 'newest'], unavailable: true }),
    })
    expect(retained!.prompts).toEqual(['newest', 'oldest'])
  })
})

describe('reanchorFocusedPrompt', () => {
  test('follows the focused prompt when a background reload grows the list', () => {
    // The overlay listed two prompts (most-recent-first) with the older one
    // focused; the retry read the full history, which prepends a newer prompt.
    // A stationary index would leave the cursor on 'b' and Enter would select
    // the wrong prompt.
    expect(
      reanchorFocusedPrompt({
        focusedIndex: 1,
        displayedPrompts: ['b', 'a'],
        reloadedPrompts: ['c', 'b', 'a'],
      }),
    ).toBe(2)
  })

  test('leaves the cursor alone when the reload changed nothing', () => {
    // Every reload allocates a fresh array, so an unchanged list must not move
    // the cursor — including onto another verbatim duplicate.
    expect(
      reanchorFocusedPrompt({
        focusedIndex: 1,
        displayedPrompts: ['b', 'a'],
        reloadedPrompts: ['b', 'a'],
      }),
    ).toBe(1)
    expect(
      reanchorFocusedPrompt({
        focusedIndex: 2,
        displayedPrompts: ['dup', 'x', 'dup'],
        reloadedPrompts: ['dup', 'x', 'dup'],
      }),
    ).toBe(2)
  })

  test('anchors a verbatim repeat to the newest matching occurrence', () => {
    // Display order is most-recent-first, so the newest 'dup' is the one the
    // user was focused on and the one the cursor must follow.
    expect(
      reanchorFocusedPrompt({
        focusedIndex: 0,
        displayedPrompts: ['dup', 'x', 'dup'],
        reloadedPrompts: ['new', 'dup', 'x', 'dup'],
      }),
    ).toBe(1)
  })

  test('clamps into range when the focused prompt is gone', () => {
    expect(
      reanchorFocusedPrompt({
        focusedIndex: 1,
        displayedPrompts: ['b', 'a'],
        reloadedPrompts: ['b'],
      }),
    ).toBe(0)
  })

  test('re-anchors from the cursor the list actually rendered', () => {
    // The raw focus state can sit past the end (the query shrank the list), so
    // the rendered/clamped cursor — 'a' — is what gets re-anchored.
    expect(
      reanchorFocusedPrompt({
        focusedIndex: 9,
        displayedPrompts: ['b', 'a'],
        reloadedPrompts: ['c', 'b', 'a'],
      }),
    ).toBe(2)
  })

  test('focuses the newest prompt when there is nothing to anchor to', () => {
    // No draft to fall back to, unlike up/down navigation: an empty reload or a
    // first load must leave a usable cursor rather than -1.
    expect(
      reanchorFocusedPrompt({
        focusedIndex: 3,
        displayedPrompts: ['b', 'a'],
        reloadedPrompts: [],
      }),
    ).toBe(0)
    expect(
      reanchorFocusedPrompt({
        focusedIndex: 0,
        displayedPrompts: [],
        reloadedPrompts: ['c', 'b', 'a'],
      }),
    ).toBe(0)
  })

  test('a retry that grows the list still selects the prompt the user focused', () => {
    // End-to-end shape of the finding: the overlay opened on a degraded read
    // that saw two prompts, the user focused the older one, and the retry read
    // the full history.
    const displayedPrompts = deriveLoadedPrompts(
      ['older', 'newer'],
      true,
    ).prompts
    const focusedPrompt = displayedPrompts[1]

    const retried = retryUnavailablePromptHistory({
      loadState: 'unavailable',
      nowMs: 1_000,
      load: () => ({
        history: ['older', 'newer', 'newest'],
        unavailable: false,
      }),
    })!
    const reloadedPrompts = filterAndScorePrompts(retried.prompts, '', 200)
    const reanchored = reanchorFocusedPrompt({
      focusedIndex: 1,
      displayedPrompts,
      reloadedPrompts,
    })

    expect(reloadedPrompts[reanchored]).toBe(focusedPrompt)
    // Clamping alone kept index 1, which now points at a different prompt.
    expect(reloadedPrompts[1]).not.toBe(focusedPrompt)
  })
})

describe('reanchorFocusForReload', () => {
  const LIMIT = 200

  test('derives both filtered lists from the query that is live now', () => {
    // The cursor addresses the *filtered* list, so a reload has to be
    // re-anchored between two lists filtered by the same query.
    const displayedAllPrompts = ['fix b', 'other', 'fix a']
    const reloadedAllPrompts = ['newest', 'fix b', 'other', 'fix a']
    const focusedPrompt = filterAndScorePrompts(
      displayedAllPrompts,
      'fix',
      LIMIT,
    )[1]

    const reanchored = reanchorFocusForReload({
      focusedIndex: 1,
      query: 'fix',
      displayedAllPrompts,
      reloadedAllPrompts,
      limit: LIMIT,
    })

    expect(
      filterAndScorePrompts(reloadedAllPrompts, 'fix', LIMIT)[reanchored],
    ).toBe(focusedPrompt)
  })

  test('a query the render has not observed yet still anchors correctly', () => {
    // The exact race: the retry tick lands between the keystroke that set the
    // query and the next render. Re-anchoring against the query published then
    // (rather than a lagging post-render mirror) keeps the highlight on the
    // focused prompt; the previous query resolves somewhere else entirely.
    const displayedAllPrompts = ['fix b', 'other', 'fix a']
    const reloadedAllPrompts = ['newest', 'fix b', 'other', 'fix a']
    const filteredReload = filterAndScorePrompts(
      reloadedAllPrompts,
      'fix',
      LIMIT,
    )

    const withLiveQuery = reanchorFocusForReload({
      focusedIndex: 1,
      query: 'fix',
      displayedAllPrompts,
      reloadedAllPrompts,
      limit: LIMIT,
    })
    expect(filteredReload[withLiveQuery]).toBe('fix a')

    const withStaleQuery = reanchorFocusForReload({
      focusedIndex: 1,
      query: '',
      displayedAllPrompts,
      reloadedAllPrompts,
      limit: LIMIT,
    })
    expect(withStaleQuery).not.toBe(withLiveQuery)
    expect(filteredReload[withStaleQuery]).not.toBe('fix a')
  })

  test('an empty query re-anchors over the raw lists', () => {
    expect(
      reanchorFocusForReload({
        focusedIndex: 1,
        query: '',
        displayedAllPrompts: ['b', 'a'],
        reloadedAllPrompts: ['c', 'b', 'a'],
        limit: LIMIT,
      }),
    ).toBe(2)
  })

  test('applies the render cap to both lists', () => {
    // The rendered list is capped, so the reloaded list has to be capped the
    // same way or the cursor would anchor onto a row that is never shown.
    expect(
      reanchorFocusForReload({
        focusedIndex: 0,
        query: '',
        displayedAllPrompts: ['b', 'a'],
        reloadedAllPrompts: ['c', 'b', 'a'],
        limit: 2,
      }),
    ).toBe(1)
  })

  test('re-anchoring is not idempotent, so a reload must apply it once', () => {
    // Pins why the screen mirrors the focus index in a ref and computes the
    // next cursor outside the setFocusedIndex updater: the helper follows the
    // focused prompt, so applying it to its own result (a state updater React
    // invoked twice under StrictMode) moves the highlight onto the neighbour.
    const displayedAllPrompts = ['dup', 'x', 'dup']
    const reloadedAllPrompts = ['new', 'dup', 'x', 'dup']
    const once = reanchorFocusForReload({
      focusedIndex: 0,
      query: '',
      displayedAllPrompts,
      reloadedAllPrompts,
      limit: LIMIT,
    })
    expect(once).toBe(1)
    expect(reloadedAllPrompts[once]).toBe(displayedAllPrompts[0])

    const twice = reanchorFocusForReload({
      focusedIndex: once,
      query: '',
      displayedAllPrompts,
      reloadedAllPrompts,
      limit: LIMIT,
    })
    expect(twice).toBe(2)
    expect(reloadedAllPrompts[twice]).not.toBe(displayedAllPrompts[0])

    // Re-anchoring between two identical lists is stable, which is what makes
    // re-running the screen's load step (rather than the helper) harmless.
    expect(
      reanchorFocusForReload({
        focusedIndex: once,
        query: '',
        displayedAllPrompts: reloadedAllPrompts,
        reloadedAllPrompts,
        limit: LIMIT,
      }),
    ).toBe(once)
  })
})

describe('readPromptHistoryForDisplay', () => {
  let tempDir: string
  let originalConfigDir: string | undefined

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-prompt-search-'))
    originalConfigDir = process.env.OPENBUFF_CONFIG_DIR
    process.env.OPENBUFF_CONFIG_DIR = tempDir
  })

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.OPENBUFF_CONFIG_DIR
    else process.env.OPENBUFF_CONFIG_DIR = originalConfigDir
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  const displayed = (loaded: MessageHistoryLoadOutcome): string[] =>
    deriveLoadedPrompts(loaded.history, loaded.unavailable).prompts

  test("lists this session's memory-only prompts, every time the history is read", () => {
    // A prompt whose append to disk failed is navigable with up/down, so it must
    // be searchable in the overlay too: the two consumers share one load.
    fs.writeFileSync(getMessageHistoryPath(), JSON.stringify(['on-disk']))
    setUnpersistedMessageHistory(['append-failed'])

    const loaded = readPromptHistoryForDisplay([])
    expect(loaded.unavailable).toBe(false)
    // Memory-only entries are this session's newest, so they list first.
    expect(displayed(loaded)).toEqual(['append-failed', 'on-disk'])

    // Re-folded on every read: a second load (mount of a reopened overlay, or a
    // retry) must not lose it.
    expect(
      displayed(readPromptHistoryForDisplay(['append-failed', 'on-disk'])),
    ).toEqual(['append-failed', 'on-disk'])
    expect(getUnpersistedMessageHistory()).toEqual(['append-failed'])
  })

  test('retires a memory-only prompt once disk proves it landed', () => {
    fs.writeFileSync(
      getMessageHistoryPath(),
      JSON.stringify(['on-disk', 'append-failed']),
    )
    setUnpersistedMessageHistory(['append-failed'])

    // Not duplicated, and no longer carried by the session.
    expect(displayed(readPromptHistoryForDisplay([]))).toEqual([
      'append-failed',
      'on-disk',
    ])
    expect(getUnpersistedMessageHistory()).toEqual([])
  })

  test('a degraded read keeps the displayed prompts and the memory-only ones', () => {
    // A fresh lock file makes the read report unavailability (busy lock held by
    // another Openbuff process) after the short interactive budget.
    fs.writeFileSync(path.join(tempDir, 'message-history.lock'), '')
    setUnpersistedMessageHistory(['append-failed'])

    const loaded = readPromptHistoryForDisplay(['newest', 'oldest'])
    expect(loaded.unavailable).toBe(true)
    expect(displayed(loaded)).toEqual(['append-failed', 'newest', 'oldest'])
    // A partial read proves nothing about disk, so the entry stays pending.
    expect(getUnpersistedMessageHistory()).toEqual(['append-failed'])
  })

  test('a successful retry surfaces the memory-only prompt in the overlay', () => {
    // The exact recovery path the finding calls out: the overlay opened while
    // the history was unavailable, and the retry that reads it must include the
    // prompt whose append failed this session.
    fs.writeFileSync(getMessageHistoryPath(), JSON.stringify(['on-disk']))
    setUnpersistedMessageHistory(['append-failed'])

    const retried = retryUnavailablePromptHistory({
      loadState: 'unavailable',
      nowMs: 1_000,
      load: () => readPromptHistoryForDisplay([]),
    })
    expect(retried!.loadState).toBe('loaded')
    expect(retried!.prompts).toEqual(['append-failed', 'on-disk'])
  })
})
