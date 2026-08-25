import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'

import {
  MESSAGE_HISTORY_COMPACT_THRESHOLD_BYTES,
  MESSAGE_HISTORY_LOCK_MAX_ATTEMPTS,
  MESSAGE_HISTORY_MAX_RETRY_ATTEMPTS,
  MESSAGE_HISTORY_MAX_UNPERSISTED,
  MESSAGE_HISTORY_READ_MAX_BYTES,
  MESSAGE_HISTORY_RETRY_COOLDOWN_MS,
  MESSAGE_HISTORY_RETRY_REFUND_MS,
  MESSAGE_HISTORY_UI_LOCK_MAX_ATTEMPTS,
  appendMessageHistory,
  clearMessageHistory,
  foldUnpersistedMessageHistory,
  getMessageHistoryJournalPath,
  getMessageHistoryPath,
  getSessionHistoryRetry,
  getUnpersistedMessageHistory,
  historyRetryNowMs,
  loadMessageHistory,
  loadMessageHistorySafe,
  loadSessionMessageHistory,
  messageHistoryLockBudgetMs,
  reconcileHistoryIndex,
  reconcileHistoryNavigation,
  recordHistoryRetryAttempt,
  recordSessionHistoryRetryAttempt,
  reloadMessageHistoryAfterAppend,
  resolveDegradedMessageHistory,
  resolveNavigationDraftText,
  retryUnavailableHistoryNavigation,
  saveMessageHistory,
  setSessionHistoryRetry,
  setUnpersistedMessageHistory,
  shouldRetryUnavailableHistory,
} from '../message-history'

import type { MessageHistoryLoadOutcome } from '../message-history'

/** The budget a session starts from: nothing spent, never attempted. */
const IDLE_SESSION_RETRY = {
  attempts: 0,
  lastAttemptMs: Number.NEGATIVE_INFINITY,
}

/**
 * Reset the two process-wide session stores message-history keeps (memory-only
 * prompts and the retry budget).
 *
 * Registered as file-scoped hooks below rather than called from test bodies:
 * these stores are shared by every test in this process, so a test that mutates
 * them and then throws before its own cleanup would otherwise leak memory-only
 * prompts and a spent retry budget into every later test. Hooks run on the
 * failure path too, and covering the whole file means a test added outside the
 * describes below inherits the same isolation.
 */
const resetSessionHistoryState = (): void => {
  setUnpersistedMessageHistory([])
  setSessionHistoryRetry(IDLE_SESSION_RETRY)
}

beforeEach(resetSessionHistoryState)
afterEach(resetSessionHistoryState)

describe('message history compaction', () => {
  let tempDir: string
  let originalConfigDir: string | undefined

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-history-'))
    originalConfigDir = process.env.OPENBUFF_CONFIG_DIR
    process.env.OPENBUFF_CONFIG_DIR = tempDir
  })

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.OPENBUFF_CONFIG_DIR
    else process.env.OPENBUFF_CONFIG_DIR = originalConfigDir
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  // Bounded, non-throwing marker wait: returns undefined when the marker never
  // appears. Retry loops need this so a missed cross-process handoff re-arms
  // the next attempt instead of aborting the whole test from inside the loop.
  const tryWaitForMarker = async (
    markerPath: string,
    timeoutMs = 5_000,
  ): Promise<string | undefined> => {
    const deadline = Date.now() + timeoutMs
    while (!fs.existsSync(markerPath)) {
      if (Date.now() > deadline) return undefined
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    return fs.readFileSync(markerPath, 'utf8')
  }

  const waitForMarker = async (
    markerPath: string,
    timeoutMs = 5_000,
  ): Promise<string> => {
    const contents = await tryWaitForMarker(markerPath, timeoutMs)
    if (contents === undefined)
      throw new Error(`Timed out waiting for ${markerPath}`)
    return contents
  }

  // Holds the history lock, then releases it shortly after the waiter signals
  // (hard-capped at 3s) — lets us prove that a concurrent appendMessageHistory
  // waits for release instead of giving up. The signal-based handoff keeps the
  // release inside the interactive acquisition budget
  // (MESSAGE_HISTORY_UI_LOCK_MAX_ATTEMPTS * 10ms ≈ 100ms) instead of racing a
  // fixed millisecond timer, but the post-signal release delay still leaves
  // only ~70ms of scheduling slack, so a descheduled holder can push the
  // release past the budget. The test therefore re-arms a fresh holder and
  // retries a bounded number of times rather than treating one contended
  // attempt as a failure.
  const HOLDER_SCRIPT = [
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    'const dir = process.env.MH_DIR',
    "const lockPath = path.join(dir, 'message-history.lock')",
    "const signalPath = path.join(dir, 'waiter.waiting')",
    "fs.writeFileSync(lockPath, '', { flag: 'wx' })",
    "fs.writeFileSync(path.join(dir, 'holder.ready'), 'held')",
    'const sleep = (ms) =>',
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)',
    'const deadline = Date.now() + 3000',
    'while (Date.now() < deadline && !fs.existsSync(signalPath)) sleep(5)',
    'setTimeout(() => { try { fs.unlinkSync(lockPath) } catch {} }, 25)',
  ].join('\n')

  // Appends one message through the real module in a separate process.
  // appendMessageHistory deliberately swallows internal errors (including
  // transient "busy" lock contention), so a bare call cannot distinguish
  // success from a silently dropped entry. Each child therefore verifies its
  // own entry landed, retries briefly, and exits non-zero with diagnostics
  // when it never persists — converting silent drops into loud failures
  // instead of a green exit code hiding lost data.
  const CHILD_APPEND_SCRIPT = [
    "const fs = require('node:fs')",
    'const { appendMessageHistory, loadMessageHistory } =',
    '  require(process.env.MH_MODULE)',
    "fs.writeFileSync(process.env.MH_STARTED_MARKER, 'ok')",
    'const sleep = (ms) =>',
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)',
    'for (let attempt = 0; attempt < 10; attempt++) {',
    '  appendMessageHistory(process.env.MH_MESSAGE)',
    '  let landed = false',
    '  try {',
    '    landed = loadMessageHistory().includes(process.env.MH_MESSAGE)',
    '  } catch {',
    '    landed = false',
    '  }',
    '  if (landed) process.exit(0)',
    '  sleep(50)',
    '}',
    'console.error(',
    "  `child append never persisted ${process.env.MH_MESSAGE}` +",
    "    '; final history: ' + JSON.stringify(loadMessageHistory()),",
    ')',
    'process.exit(1)',
  ].join('\n')

  // Holds a fresh lock briefly, then — the moment the queued main-process
  // append creates its own lock — swaps in a successor lock while the main
  // process is still inside its critical section. Proves lock release checks
  // inode identity instead of blindly unlinking whatever sits at the path.
  // The initial hold stays well inside the interactive append budget (≈100ms)
  // so the queued append acquires rather than giving up busy; the swap itself
  // waits for the successor lock to appear instead of racing a timer.
  // The wait for the main-process lock is deadline-bounded (5s): if the append
  // gave up busy — or the runner died before kill() ran — the child stops
  // spinning, reports 'missed' through swapper.done and exits, so it can never
  // become an orphan burning CPU and the parent's bounded retry always gets a
  // terminal signal to re-arm on.
  const SWAPPER_SCRIPT = [
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    'const dir = process.env.MH_DIR',
    "const lockPath = path.join(dir, 'message-history.lock')",
    "const donePath = path.join(dir, 'swapper.done')",
    'const sleep = (ms) =>',
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)',
    'const finish = (outcome) => {',
    '  fs.writeFileSync(donePath, outcome)',
    '  process.exit(0)',
    '}',
    "const fd = fs.openSync(lockPath, 'wx', 0o600)",
    'fs.closeSync(fd)',
    "fs.writeFileSync(path.join(dir, 'swapper.ready'), 'held')",
    'sleep(40)',
    'try {',
    '  fs.unlinkSync(lockPath)',
    '} catch {}',
    'const deadline = Date.now() + 5000',
    'while (!fs.existsSync(lockPath)) {',
    "  if (Date.now() > deadline) finish('missed')",
    '  sleep(1)',
    '}',
    'try {',
    '  fs.unlinkSync(lockPath)',
    "  const successorFd = fs.openSync(lockPath, 'wx', 0o600)",
    "  fs.writeFileSync(successorFd, 'successor-lock')",
    '  fs.closeSync(successorFd)',
    '} catch {',
    "  finish('missed')",
    '}',
    "finish('swapped')",
  ].join('\n')

  test('compacts an oversized journal into a bounded snapshot', () => {
    const entries = Array.from(
      { length: 1100 },
      (_, index) => `${index}:${'x'.repeat(300)}`,
    )
    fs.writeFileSync(
      getMessageHistoryJournalPath(),
      entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    )

    appendMessageHistory('latest')

    const loaded = loadMessageHistory()
    expect(loaded).toHaveLength(1000)
    expect(loaded.at(-1)).toBe('latest')
    expect(
      JSON.parse(fs.readFileSync(getMessageHistoryPath(), 'utf8')),
    ).toHaveLength(1000)
    expect(fs.readFileSync(getMessageHistoryJournalPath(), 'utf8')).toBe('')
  })

  test('recovers a stale lock left by a crashed process', () => {
    const lockPath = path.join(tempDir, 'message-history.lock')
    fs.writeFileSync(lockPath, '')
    const staleTime = new Date(Date.now() - 60_000)
    fs.utimesSync(lockPath, staleTime, staleTime)

    appendMessageHistory('after-crash')

    expect(loadMessageHistory()).toEqual(['after-crash'])
    expect(fs.existsSync(lockPath)).toBe(false)
  })

  test.skipIf(process.platform === 'win32')(
    'creates a missing config directory owner-only',
    () => {
      const nestedConfigDir = path.join(tempDir, 'nested', 'openbuff')
      process.env.OPENBUFF_CONFIG_DIR = nestedConfigDir
      expect(fs.existsSync(nestedConfigDir)).toBe(false)

      appendMessageHistory('mode-check')

      // Defensively-created config dirs hold user prompts: they must not be
      // group/world-readable.
      expect(fs.statSync(nestedConfigDir).mode & 0o777).toBe(0o700)
    },
  )

  test('ignores a persisted snapshot larger than the size bound', () => {
    // Valid JSON that parses to one huge entry: without the size sanity-check
    // the snapshot loads (unbounded memory); with it, the snapshot is treated
    // as corrupt and skipped while the journal still replays.
    fs.writeFileSync(
      getMessageHistoryPath(),
      JSON.stringify(['x'.repeat(MESSAGE_HISTORY_READ_MAX_BYTES)]),
    )
    fs.writeFileSync(
      getMessageHistoryJournalPath(),
      `${JSON.stringify('from-journal')}\n`,
    )

    expect(loadMessageHistory()).toEqual(['from-journal'])
  })

  test('reads a bounded tail of an oversized journal instead of discarding it', () => {
    // Per-line valid JSON, but the leading line alone exceeds the read bound.
    // Skipping the whole journal would throw away every recent prompt, so the
    // last MESSAGE_HISTORY_READ_MAX_BYTES are read and the first (partial) line
    // of that window is dropped; the newest entries survive.
    fs.writeFileSync(
      getMessageHistoryJournalPath(),
      [
        JSON.stringify('x'.repeat(MESSAGE_HISTORY_READ_MAX_BYTES)),
        JSON.stringify('recent-1'),
        JSON.stringify('recent-2'),
        '',
      ].join('\n'),
    )
    fs.writeFileSync(getMessageHistoryPath(), JSON.stringify(['from-snapshot']))

    expect(loadMessageHistory()).toEqual([
      'from-snapshot',
      'recent-1',
      'recent-2',
    ])
  })

  test('appends to journal and merges snapshot + journal on load', () => {
    fs.writeFileSync(
      getMessageHistoryPath(),
      JSON.stringify(['snapshot-1', 'snapshot-2']),
    )
    fs.writeFileSync(
      getMessageHistoryJournalPath(),
      `${JSON.stringify('journal-1')}\n`,
    )

    appendMessageHistory('journal-2')

    const loaded = loadMessageHistory()
    expect(loaded).toEqual([
      'snapshot-1',
      'snapshot-2',
      'journal-1',
      'journal-2',
    ])
    // Journal should still contain entries until compaction threshold
    const journalContents = fs.readFileSync(
      getMessageHistoryJournalPath(),
      'utf8',
    )
    expect(journalContents).toContain('"journal-1"')
    expect(journalContents).toContain('"journal-2"')
  })

  test('terminates a torn journal line instead of swallowing the next append', () => {
    // A crash mid-append can leave the journal without its final newline.
    // O_APPEND would glue the next entry onto that fragment into one
    // unparseable line, losing both the torn entry and the fresh prompt while
    // the append still reported success (true) — which is exactly the signal
    // the input history hook uses to decide a prompt reached disk.
    fs.writeFileSync(getMessageHistoryPath(), JSON.stringify(['snap']))
    const tornFragment = JSON.stringify('torn-mid-write').slice(0, 8)
    fs.writeFileSync(
      getMessageHistoryJournalPath(),
      `${JSON.stringify('intact')}\n${tornFragment}`,
    )

    expect(appendMessageHistory('after-torn')).toBe(true)

    // The damage stays confined to the line that was already torn: it remains
    // its own malformed (skipped) line and the new entry lands intact.
    expect(fs.readFileSync(getMessageHistoryJournalPath(), 'utf8')).toBe(
      `${JSON.stringify('intact')}\n${tornFragment}\n${JSON.stringify({
        s: 1,
        t: 'after-torn',
      })}\n`,
    )
    expect(loadMessageHistory()).toEqual(['snap', 'intact', 'after-torn'])

    // A journal that already ends in a newline gets no extra separator, so
    // ordinary appends never leave blank lines behind.
    expect(appendMessageHistory('next')).toBe(true)
    expect(
      fs.readFileSync(getMessageHistoryJournalPath(), 'utf8'),
    ).not.toContain('\n\n')
    expect(loadMessageHistory()).toEqual([
      'snap',
      'intact',
      'after-torn',
      'next',
    ])
  })

  test('saveMessageHistory truncates journal via truncateJournal helper', () => {
    fs.writeFileSync(
      getMessageHistoryJournalPath(),
      `${JSON.stringify('old-journal')}\n`,
    )
    saveMessageHistory(['a', 'b', 'c'])
    expect(JSON.parse(fs.readFileSync(getMessageHistoryPath(), 'utf8'))).toEqual(
      ['a', 'b', 'c'],
    )
    expect(fs.readFileSync(getMessageHistoryJournalPath(), 'utf8')).toBe('')
  })

  test('clearMessageHistory deletes snapshot and journal under lock', () => {
    fs.writeFileSync(getMessageHistoryPath(), JSON.stringify(['x']))
    fs.writeFileSync(getMessageHistoryJournalPath(), `${JSON.stringify('y')}\n`)
    clearMessageHistory()
    expect(fs.existsSync(getMessageHistoryPath())).toBe(false)
    expect(fs.existsSync(getMessageHistoryJournalPath())).toBe(false)
    // Subsequent load returns empty without error
    expect(loadMessageHistory()).toEqual([])
  })

  test('handles malformed legacy JSON file gracefully', () => {
    fs.writeFileSync(getMessageHistoryPath(), '{ not valid json')
    fs.writeFileSync(getMessageHistoryJournalPath(), `${JSON.stringify('valid')}\n`)
    const loaded = loadMessageHistory()
    // Malformed snapshot ignored, journal still loaded
    expect(loaded).toEqual(['valid'])
  })

  test('ignores non-array legacy file and filters non-string entries', () => {
    fs.writeFileSync(getMessageHistoryPath(), JSON.stringify({ not: 'array' }))
    expect(loadMessageHistory()).toEqual([])

    fs.writeFileSync(
      getMessageHistoryPath(),
      JSON.stringify(['ok', 123, null, 'ok2']),
    )
    expect(loadMessageHistory()).toEqual(['ok', 'ok2'])
  })

  test('ignores malformed journal lines and non-string journal entries', () => {
    fs.writeFileSync(
      getMessageHistoryJournalPath(),
      [
        JSON.stringify('good-1'),
        '{ malformed json',
        JSON.stringify(12345),
        JSON.stringify({ obj: true }),
        JSON.stringify('good-2'),
        '',
      ].join('\n'),
    )
    expect(loadMessageHistory()).toEqual(['good-1', 'good-2'])
  })

  test('interactive acquisition budget is much shorter than the non-interactive one', () => {
    // The blocking Atomics.wait design is only safe on the TUI thread because
    // interactive callers (input submit append, history screen loads) use a
    // deliberately short budget: ≈100ms rather than ≈500ms per acquisition.
    expect(MESSAGE_HISTORY_UI_LOCK_MAX_ATTEMPTS).toBeLessThan(
      MESSAGE_HISTORY_LOCK_MAX_ATTEMPTS,
    )
    expect(MESSAGE_HISTORY_UI_LOCK_MAX_ATTEMPTS).toBe(10)
    // The budget the acquisition loop enforces as a wall-clock deadline.
    expect(
      messageHistoryLockBudgetMs(MESSAGE_HISTORY_UI_LOCK_MAX_ATTEMPTS),
    ).toBe(100)
    expect(messageHistoryLockBudgetMs(MESSAGE_HISTORY_LOCK_MAX_ATTEMPTS)).toBe(
      500,
    )
  })

  test('interactive callers give up quickly instead of blocking the event loop', () => {
    // Fresh foreign lock held for the whole call: both interactive entry points
    // must return within their own short budget (plus slack for slow runners),
    // never the ≈500ms non-interactive budget.
    fs.writeFileSync(path.join(tempDir, 'message-history.lock'), '')

    const appendStart = Date.now()
    appendMessageHistory('interactive-append')
    expect(Date.now() - appendStart).toBeLessThan(400)

    const loadStart = Date.now()
    expect(loadMessageHistorySafe()).toEqual([])
    expect(Date.now() - loadStart).toBeLessThan(400)
  })

  test('bounds an interactive lock wait in wall-clock time, not just attempts', () => {
    // Every retry also pays stat syscalls on the lock path. When those dominate
    // the poll interval, an attempt-count-only bound would block this
    // interactive append for ≈10 * (100ms + 10ms) on the TUI thread. The loop
    // enforces the ≈100ms budget as a deadline, so it gives up after the first
    // slow attempt instead.
    const lockPath = path.join(tempDir, 'message-history.lock')
    fs.writeFileSync(lockPath, '')

    const slowStatMs = 100
    const realStatSync = fs.statSync.bind(fs)
    let lockStatCalls = 0
    const statSpy = spyOn(fs, 'statSync').mockImplementation(((
      target: Parameters<typeof fs.statSync>[0],
    ) => {
      if (String(target) === lockPath) {
        lockStatCalls += 1
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          slowStatMs,
        )
      }
      return realStatSync(target)
    }) as typeof fs.statSync)

    const start = Date.now()
    try {
      expect(appendMessageHistory('slow-filesystem')).toBe(false)
    } finally {
      statSpy.mockRestore()
    }

    // Comfortably under the ~1.1s an attempt-count-only bound would have cost.
    expect(Date.now() - start).toBeLessThan(
      messageHistoryLockBudgetMs(MESSAGE_HISTORY_UI_LOCK_MAX_ATTEMPTS) +
        slowStatMs * 3,
    )
    // The deadline, not the attempt count, ended the wait.
    expect(lockStatCalls).toBeLessThan(MESSAGE_HISTORY_UI_LOCK_MAX_ATTEMPTS)
    // The fresh foreign lock is untouched and nothing was persisted.
    expect(fs.existsSync(lockPath)).toBe(true)
    expect(fs.existsSync(getMessageHistoryJournalPath())).toBe(false)
  })

  test('releases a lock we own when fstat fails during acquisition', () => {
    // Without dropping the lock on this path, lockIno stays undefined, the
    // inode-guarded release skips the unlink, and the orphaned lock blocks
    // every history operation until the 30s staleness horizon.
    const lockPath = path.join(tempDir, 'message-history.lock')
    const fstatSpy = spyOn(fs, 'fstatSync').mockImplementation(() => {
      throw Object.assign(new Error('simulated fstat failure'), { code: 'EIO' })
    })
    try {
      appendMessageHistory('during-fstat-failure')
    } finally {
      fstatSpy.mockRestore()
    }

    // The lock we created was released, so the very next operation succeeds
    // instead of waiting out the staleness horizon.
    expect(fs.existsSync(lockPath)).toBe(false)
    appendMessageHistory('after-fstat-failure')
    expect(loadMessageHistory()).toEqual(['after-fstat-failure'])
  })

  test('releases a lock we own when closing its descriptor fails', () => {
    // A throwing close must not skip the inode-checked unlink: the lock is
    // still ours, so skipping the release would orphan it and block every
    // history read/write until the 30s staleness horizon.
    const lockPath = path.join(tempDir, 'message-history.lock')
    const closeSpy = spyOn(fs, 'closeSync').mockImplementation(() => {
      throw Object.assign(new Error('simulated close failure'), { code: 'EIO' })
    })
    try {
      expect(appendMessageHistory('during-close-failure')).toBe(true)
    } finally {
      closeSpy.mockRestore()
    }

    expect(fs.existsSync(lockPath)).toBe(false)
    // The entry landed and the next operation acquires the lock immediately.
    expect(loadMessageHistory()).toEqual(['during-close-failure'])
    appendMessageHistory('after-close-failure')
    expect(loadMessageHistory()).toEqual([
      'during-close-failure',
      'after-close-failure',
    ])
  })

  test('reconcileHistoryIndex re-anchors a cursor onto a reloaded history', () => {
    // A reload mid-navigation can shorten or shift the list; the focused entry
    // follows to its new position instead of leaving the cursor past the end.
    expect(
      reconcileHistoryIndex(2, ['a', 'b', 'c'], ['x', 'y', 'a', 'b', 'c']),
    ).toBe(4)
    // Focused entry gone from a shorter list: clamp into range so the very next
    // keypress moves instead of silently no-opping.
    expect(reconcileHistoryIndex(4, ['a', 'b', 'c', 'd', 'e'], ['a', 'b'])).toBe(
      1,
    )
    // Stale index that was already out of range for the previous list.
    expect(reconcileHistoryIndex(7, ['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(2)
    // Verbatim repeats: the newest occurrence is the one navigation walks back
    // from.
    expect(reconcileHistoryIndex(1, ['a', 'dup'], ['dup', 'a', 'dup'])).toBe(2)
    // An empty reload resets navigation to the draft.
    expect(reconcileHistoryIndex(1, ['a', 'b'], [])).toBe(-1)
    // Not navigating: nothing to re-anchor.
    expect(reconcileHistoryIndex(-1, ['a'], ['a', 'b'])).toBe(-1)
  })

  test('reconcileHistoryIndex leaves the cursor put on a content-identical reload', () => {
    // Every reload allocates a fresh array, so identity says nothing about
    // change. Re-anchoring an unchanged list by content equality is what keeps
    // a cursor sitting on an earlier duplicate from jumping to the later one
    // and making the next up-arrow skip entries.
    const previous = ['dup', 'b', 'dup']
    const reloaded = [...previous]
    expect(reloaded).not.toBe(previous)
    expect(reconcileHistoryIndex(0, previous, reloaded)).toBe(0)
    expect(reconcileHistoryIndex(1, previous, reloaded)).toBe(1)
    expect(reconcileHistoryIndex(2, previous, reloaded)).toBe(2)
    // An identical reload still clamps an index that was already out of range.
    expect(reconcileHistoryIndex(9, previous, reloaded)).toBe(2)
  })

  test('reconcileHistoryNavigation reports when the draft must be restored', () => {
    // A trustworthy empty reload ends navigation: the cursor is back at -1
    // while the input still shows a history entry, so the caller has to put the
    // saved draft back or it becomes unreachable.
    expect(reconcileHistoryNavigation(1, ['a', 'b'], [])).toEqual({
      index: -1,
      restoreDraft: true,
    })
    // Was not navigating: nothing was shown from history, nothing to restore.
    expect(reconcileHistoryNavigation(-1, ['a'], [])).toEqual({
      index: -1,
      restoreDraft: false,
    })
    // Still navigating after the swap: the cursor follows its entry.
    expect(
      reconcileHistoryNavigation(2, ['a', 'b', 'c'], ['x', 'a', 'b', 'c']),
    ).toEqual({ index: 3, restoreDraft: false })
    // Content-identical reload: cursor unchanged, draft untouched.
    expect(
      reconcileHistoryNavigation(0, ['dup', 'b', 'dup'], ['dup', 'b', 'dup']),
    ).toEqual({ index: 0, restoreDraft: false })
  })

  test('an unreadable snapshot does not poison the journal sequence tag', () => {
    // A directory at the snapshot path makes the read fail with EISDIR while
    // the file "exists": the snapshot length is unknown, so tagging the append
    // s=0 would get it dropped as crash-replay overlap on the next good load.
    fs.mkdirSync(getMessageHistoryPath())

    appendMessageHistory('during-outage')

    // Untagged (legacy-shaped) line: load always replays these.
    expect(fs.readFileSync(getMessageHistoryJournalPath(), 'utf8').trim()).toBe(
      JSON.stringify('during-outage'),
    )

    // Once the snapshot is readable again the entry survives instead of being
    // silently classified as already folded in.
    fs.rmSync(getMessageHistoryPath(), { recursive: true })
    fs.writeFileSync(getMessageHistoryPath(), JSON.stringify(['a', 'b', 'c']))
    expect(loadMessageHistory()).toEqual(['a', 'b', 'c', 'during-outage'])
  })

  test('does not compact over an unreadable snapshot', () => {
    // Compacting here would rewrite the snapshot from a read that never saw its
    // entries and then truncate the journal, destroying history we merely
    // failed to read.
    const unitLine = `${JSON.stringify('z'.repeat(250))}\n`
    fs.writeFileSync(
      getMessageHistoryJournalPath(),
      unitLine.repeat(
        Math.ceil(
          (MESSAGE_HISTORY_COMPACT_THRESHOLD_BYTES + 1) / unitLine.length,
        ),
      ),
    )
    fs.mkdirSync(getMessageHistoryPath())

    appendMessageHistory('no-compaction')

    const journal = fs.readFileSync(getMessageHistoryJournalPath(), 'utf8')
    expect(journal).not.toBe('')
    expect(journal).toContain('"no-compaction"')
    // The snapshot path was left untouched (still the unreadable directory).
    expect(fs.statSync(getMessageHistoryPath()).isDirectory()).toBe(true)
  })

  test('loadMessageHistorySafe reports an unreadable history as unavailable', () => {
    // An unavailable history must be distinguishable from a genuinely empty
    // one, including when the lock was acquired fine but a file could not be
    // read.
    fs.mkdirSync(getMessageHistoryPath())
    fs.writeFileSync(
      getMessageHistoryJournalPath(),
      `${JSON.stringify('from-journal')}\n`,
    )

    let reported: unknown
    expect(
      loadMessageHistorySafe((error) => {
        reported = error
      }),
    ).toEqual(['from-journal'])
    expect((reported as Error).message).toContain('could not be read completely')

    // A readable, genuinely empty history reports no unavailability.
    fs.rmSync(getMessageHistoryPath(), { recursive: true })
    fs.rmSync(getMessageHistoryJournalPath())
    let calls = 0
    expect(
      loadMessageHistorySafe(() => {
        calls += 1
      }),
    ).toEqual([])
    expect(calls).toBe(0)
  })

  test('reloadMessageHistoryAfterAppend keeps the last good history when the reload is unavailable', () => {
    // A single busy-lock reload must not wipe a session's up/down navigation
    // history: the caller's last good snapshot is preserved and the just-
    // appended entry is folded in memory.
    const lockPath = path.join(tempDir, 'message-history.lock')
    fs.writeFileSync(lockPath, '')

    let reported: unknown
    expect(
      reloadMessageHistoryAfterAppend({
        lastGood: ['old-1', 'old-2'],
        appended: 'new-1',
        onUnavailable: (error) => {
          reported = error
        },
      }),
    ).toEqual({
      history: ['old-1', 'old-2', 'new-1'],
      unpersisted: [],
    })
    expect((reported as Error).message).toContain(
      'busy in another Openbuff process',
    )

    // Once the lock is released the reload takes disk as the source of truth
    // (picking up other terminals) instead of the in-memory fallback.
    fs.unlinkSync(lockPath)
    fs.writeFileSync(
      getMessageHistoryPath(),
      JSON.stringify(['from-other-terminal']),
    )
    expect(
      reloadMessageHistoryAfterAppend({
        lastGood: ['old-1', 'old-2'],
        appended: 'new-1',
      }),
    ).toEqual({ history: ['from-other-terminal'], unpersisted: [] })
  })

  test('appendMessageHistory reports whether the entry reached disk', () => {
    // A swallowed failure used to be indistinguishable from success, so a
    // prompt whose append failed while the reload succeeded vanished from
    // in-session up/down navigation.
    expect(appendMessageHistory('persisted')).toBe(true)

    const lockPath = path.join(tempDir, 'message-history.lock')
    fs.writeFileSync(lockPath, '')
    expect(appendMessageHistory('never-persisted')).toBe(false)

    fs.unlinkSync(lockPath)
    expect(loadMessageHistory()).toEqual(['persisted'])
  })

  test('reloadMessageHistoryAfterAppend folds in an entry whose append failed but whose reload succeeded', () => {
    // Partial failure: the disk read is trustworthy, yet it cannot contain the
    // prompt because the append itself failed. The entry must still be
    // navigable in this session, and it stays pending so later reloads re-fold
    // it.
    fs.writeFileSync(getMessageHistoryPath(), JSON.stringify(['on-disk']))

    let calls = 0
    const folded = reloadMessageHistoryAfterAppend({
      lastGood: ['on-disk'],
      appended: 'append-failed',
      onUnavailable: () => {
        calls += 1
      },
      appendPersisted: false,
    })
    expect(folded).toEqual({
      history: ['on-disk', 'append-failed'],
      unpersisted: ['append-failed'],
    })
    // The reload was fine; only the append failed, so nothing is reported as
    // unavailable.
    expect(calls).toBe(0)

    // The next submit's successful reload must not drop the memory-only entry:
    // the pending list is carried forward and re-folded.
    const next = reloadMessageHistoryAfterAppend({
      lastGood: folded.history,
      appended: 'later-prompt',
      unpersisted: folded.unpersisted,
    })
    expect(next).toEqual({
      history: ['on-disk', 'append-failed'],
      unpersisted: ['append-failed'],
    })

    // Idempotent: a late failure reported after the journal line already landed
    // must not duplicate the entry, and it stops being carried.
    fs.writeFileSync(
      getMessageHistoryPath(),
      JSON.stringify(['on-disk', 'append-failed']),
    )
    expect(
      reloadMessageHistoryAfterAppend({
        lastGood: ['on-disk'],
        appended: 'append-failed',
        appendPersisted: false,
        unpersisted: ['append-failed'],
      }),
    ).toEqual({
      history: ['on-disk', 'append-failed'],
      unpersisted: [],
    })
  })

  test('reloadMessageHistoryAfterAppend keeps pending entries across a degraded reload', () => {
    // A degraded reload proves nothing about disk, so a memory-only entry must
    // stay pending instead of being retired against a partial read.
    const lockPath = path.join(tempDir, 'message-history.lock')
    fs.writeFileSync(lockPath, '')

    expect(
      reloadMessageHistoryAfterAppend({
        lastGood: ['on-disk', 'append-failed'],
        appended: 'also-failed',
        appendPersisted: false,
        unpersisted: ['append-failed'],
      }),
    ).toEqual({
      history: ['on-disk', 'append-failed', 'also-failed'],
      unpersisted: ['append-failed', 'also-failed'],
    })
  })

  test('reloadMessageHistoryAfterAppend resolves a degraded reload through the shared resolver', () => {
    // A post-submit degraded reload used to collapse to [...lastGood, appended],
    // which could disagree with what the Ctrl+R overlay resolves for the same
    // read. Both now go through resolveDegradedMessageHistory: a partial read
    // may grow the retained view and may never shrink it.
    // An unreadable snapshot (a directory at its path) plus a readable journal
    // is a degraded read that still returns entries.
    fs.mkdirSync(getMessageHistoryPath())
    fs.writeFileSync(
      getMessageHistoryJournalPath(),
      ['old', 'submitted', 'from-other-terminal']
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(''),
    )

    let reported = 0
    expect(
      reloadMessageHistoryAfterAppend({
        lastGood: ['old'],
        appended: 'submitted',
        onUnavailable: () => {
          reported += 1
        },
      }),
    ).toEqual({
      history: ['old', 'submitted', 'from-other-terminal'],
      unpersisted: [],
    })
    expect(reported).toBe(1)
    // Entry-for-entry what the overlay's shared read resolves for that state.
    expect(
      resolveDegradedMessageHistory(
        ['old', 'submitted'],
        loadMessageHistorySafe(),
        [],
      ),
    ).toEqual(['old', 'submitted', 'from-other-terminal'])

    // And a partial read that saw less still cannot shrink the retained view.
    expect(
      reloadMessageHistoryAfterAppend({
        lastGood: ['old', 'submitted', 'from-other-terminal'],
        appended: 'newer',
      }).history,
    ).toEqual(['old', 'submitted', 'from-other-terminal', 'newer'])
  })

  test('foldUnpersistedMessageHistory re-folds memory-only entries and bounds them', () => {
    // Memory-only entries sort after the persisted ones: a prompt that failed
    // to persist stays this session's newest for up/down navigation.
    expect(
      foldUnpersistedMessageHistory(['a', 'b'], ['failed-1', 'failed-2']),
    ).toEqual({
      history: ['a', 'b', 'failed-1', 'failed-2'],
      unpersisted: ['failed-1', 'failed-2'],
    })
    // An entry that turns out to be on disk (late failure, or another terminal
    // wrote the same text) is neither duplicated nor carried further.
    expect(
      foldUnpersistedMessageHistory(['a', 'failed-1'], ['failed-1']),
    ).toEqual({ history: ['a', 'failed-1'], unpersisted: [] })
    // Nothing pending: the persisted view passes through unchanged.
    expect(foldUnpersistedMessageHistory(['a'], [])).toEqual({
      history: ['a'],
      unpersisted: [],
    })
    // The pending list is bounded, so a long session with broken persistence
    // cannot grow it without limit.
    let pending: string[] = []
    for (let i = 0; i < MESSAGE_HISTORY_MAX_UNPERSISTED + 5; i++) {
      pending = reloadMessageHistoryAfterAppend({
        lastGood: [],
        appended: `failed-${i}`,
        appendPersisted: false,
        unpersisted: pending,
      }).unpersisted
    }
    expect(pending).toHaveLength(MESSAGE_HISTORY_MAX_UNPERSISTED)
    expect(pending.at(-1)).toBe(
      `failed-${MESSAGE_HISTORY_MAX_UNPERSISTED + 4}`,
    )
  })

  test('duplicated memory-only prompts resolve the same way on both read paths', () => {
    // A session that submits the same prompt twice with both appends failing has
    // two navigable entries, so a trustworthy read and a degraded one must not
    // disagree about how many.
    expect(foldUnpersistedMessageHistory(['on-disk'], ['dup', 'dup'])).toEqual({
      history: ['on-disk', 'dup', 'dup'],
      unpersisted: ['dup', 'dup'],
    })
    // Degraded path, same persisted view: entry-for-entry the fold's result.
    expect(resolveDegradedMessageHistory([], ['on-disk'], ['dup', 'dup'])).toEqual(
      foldUnpersistedMessageHistory(['on-disk'], ['dup', 'dup']).history,
    )
    // And a degraded read that saw nothing new keeps both repeats too, instead
    // of collapsing the view it already held.
    expect(
      resolveDegradedMessageHistory(
        ['on-disk', 'dup', 'dup'],
        [],
        ['dup', 'dup'],
      ),
    ).toEqual(['on-disk', 'dup', 'dup'])
    // Both paths still retire a repeat whose text is on disk without
    // duplicating it.
    expect(foldUnpersistedMessageHistory(['dup', 'extra'], ['dup', 'dup'])).toEqual({
      history: ['dup', 'extra'],
      unpersisted: [],
    })
    expect(
      resolveDegradedMessageHistory(['dup'], ['dup', 'extra'], ['dup', 'dup']),
    ).toEqual(['dup', 'extra'])
  })

  test('loadSessionMessageHistory folds session memory-only prompts for every consumer', () => {
    // The session store is what makes a prompt whose append failed visible in
    // both consumers of a history load (up/down navigation and the Ctrl+R
    // overlay), instead of only in whichever one happened to own the list.
    fs.writeFileSync(getMessageHistoryPath(), JSON.stringify(['on-disk']))
    setUnpersistedMessageHistory(['append-failed'])

    const first = loadSessionMessageHistory([])
    expect(first).toEqual({
      history: ['on-disk', 'append-failed'],
      unavailable: false,
    })
    // Re-folded on every load, so a second consumer reading the same history
    // sees the same entries.
    expect(loadSessionMessageHistory(first.history)).toEqual({
      history: ['on-disk', 'append-failed'],
      unavailable: false,
    })
    expect(getUnpersistedMessageHistory()).toEqual(['append-failed'])

    // A trustworthy load that proves the entry landed retires it.
    fs.writeFileSync(
      getMessageHistoryPath(),
      JSON.stringify(['on-disk', 'append-failed']),
    )
    expect(loadSessionMessageHistory(first.history).history).toEqual([
      'on-disk',
      'append-failed',
    ])
    expect(getUnpersistedMessageHistory()).toEqual([])

    // The store is bounded exactly like the pending list carried across
    // reloads.
    setUnpersistedMessageHistory(
      Array.from(
        { length: MESSAGE_HISTORY_MAX_UNPERSISTED + 5 },
        (_, i) => `failed-${i}`,
      ),
    )
    expect(getUnpersistedMessageHistory()).toHaveLength(
      MESSAGE_HISTORY_MAX_UNPERSISTED,
    )
    expect(getUnpersistedMessageHistory().at(-1)).toBe(
      `failed-${MESSAGE_HISTORY_MAX_UNPERSISTED + 4}`,
    )
  })

  test('loadSessionMessageHistory keeps the retained view and pending entries on a degraded read', () => {
    // A busy lock held by another Openbuff process: the partial read may only
    // grow the caller's view, and proves nothing about what reached disk.
    fs.writeFileSync(path.join(tempDir, 'message-history.lock'), '')
    setUnpersistedMessageHistory(['append-failed'])

    expect(loadSessionMessageHistory(['on-disk'])).toEqual({
      history: ['on-disk', 'append-failed'],
      unavailable: true,
    })
    expect(getUnpersistedMessageHistory()).toEqual(['append-failed'])
  })

  test('the retry budget is process-wide, so every consumer shares one bounded allowance', () => {
    // A budget owned by each consumer bounded nothing in aggregate: the
    // navigation hook and every open/remount of the Ctrl+R overlay could each
    // pay MESSAGE_HISTORY_MAX_RETRY_ATTEMPTS blocking lock acquisitions of their
    // own. One shared budget is what makes that bound hold per process.
    expect(recordSessionHistoryRetryAttempt(0, true)).toEqual({
      attempts: 1,
      lastAttemptMs: 0,
    })
    expect(getSessionHistoryRetry()).toEqual({ attempts: 1, lastAttemptMs: 0 })

    // Spend the rest of the shared allowance from "another" consumer.
    for (
      let attempt = 1;
      attempt < MESSAGE_HISTORY_MAX_RETRY_ATTEMPTS;
      attempt++
    )
      recordSessionHistoryRetryAttempt(
        attempt * MESSAGE_HISTORY_RETRY_COOLDOWN_MS,
        true,
      )
    const spentAtMs =
      (MESSAGE_HISTORY_MAX_RETRY_ATTEMPTS - 1) *
      MESSAGE_HISTORY_RETRY_COOLDOWN_MS
    expect(getSessionHistoryRetry()).toEqual({
      attempts: MESSAGE_HISTORY_MAX_RETRY_ATTEMPTS,
      lastAttemptMs: spentAtMs,
    })
    // A consumer that never retried itself is refused too, inside the refund
    // window.
    expect(
      shouldRetryUnavailableHistory(
        getSessionHistoryRetry(),
        spentAtMs + MESSAGE_HISTORY_RETRY_COOLDOWN_MS,
      ),
    ).toBe(false)

    // A trustworthy read by any consumer clears it for all of them.
    expect(
      recordSessionHistoryRetryAttempt(
        spentAtMs + MESSAGE_HISTORY_RETRY_COOLDOWN_MS,
        false,
      ),
    ).toEqual({
      attempts: 0,
      lastAttemptMs: spentAtMs + MESSAGE_HISTORY_RETRY_COOLDOWN_MS,
    })
  })

  test('shouldRetryUnavailableHistory bounds retries by cooldown and attempt cap', () => {
    const now = 1_000_000
    // First retry after an unavailable load is allowed.
    expect(
      shouldRetryUnavailableHistory({ attempts: 0, lastAttemptMs: 0 }, now),
    ).toBe(true)
    // A retry inside the cooldown is refused, so a persistently unreadable or
    // contended history cannot pay a blocking lock acquisition per keypress.
    expect(
      shouldRetryUnavailableHistory(
        {
          attempts: 1,
          lastAttemptMs: now - MESSAGE_HISTORY_RETRY_COOLDOWN_MS + 1,
        },
        now,
      ),
    ).toBe(false)
    expect(
      shouldRetryUnavailableHistory(
        { attempts: 1, lastAttemptMs: now - MESSAGE_HISTORY_RETRY_COOLDOWN_MS },
        now,
      ),
    ).toBe(true)
    // The attempt cap stops retrying entirely once the budget is spent, for the
    // whole refund window (the later refund case is covered separately).
    expect(
      shouldRetryUnavailableHistory(
        {
          attempts: MESSAGE_HISTORY_MAX_RETRY_ATTEMPTS,
          lastAttemptMs: now - MESSAGE_HISTORY_RETRY_REFUND_MS + 1,
        },
        now,
      ),
    ).toBe(false)
  })

  test('resolveDegradedMessageHistory keeps a degraded-but-non-empty load', () => {
    // The prompt history search screen renders exactly this partial list, so
    // arrow-key navigation must not report an empty history for it.
    expect(resolveDegradedMessageHistory([], ['partial'])).toEqual(['partial'])
    // A degraded load must not shrink an existing good history.
    expect(resolveDegradedMessageHistory(['good-1', 'good-2'], [])).toEqual([
      'good-1',
      'good-2',
    ])
    expect(
      resolveDegradedMessageHistory(['good-1', 'good-2'], ['good-1']),
    ).toEqual(['good-1', 'good-2'])
  })

  test('resolveDegradedMessageHistory adopts a later, larger degraded read', () => {
    // A session pinned to its first partial read could never recover entries
    // within its bounded retry budget, however much a later degraded read saw.
    expect(
      resolveDegradedMessageHistory(['partial'], ['partial', 'more']),
    ).toEqual(['partial', 'more'])

    // Memory-only prompts survive that replacement: they are re-folded after
    // the persisted entries, so a prompt whose append never reached disk stays
    // navigable (and stays this session's newest).
    expect(
      resolveDegradedMessageHistory(
        ['partial', 'append-failed'],
        ['partial', 'more'],
        ['append-failed'],
      ),
    ).toEqual(['partial', 'more', 'append-failed'])

    // Once such a prompt shows up in the degraded read it is not duplicated.
    expect(
      resolveDegradedMessageHistory(
        ['partial', 'append-failed'],
        ['partial', 'append-failed', 'more'],
        ['append-failed'],
      ),
    ).toEqual(['partial', 'append-failed', 'more'])

    // The pending entries folded into the current view must not make a larger
    // degraded read look no better than it is.
    expect(
      resolveDegradedMessageHistory(
        ['disk-1', 'failed-1', 'failed-2'],
        ['disk-1', 'disk-2'],
        ['failed-1', 'failed-2'],
      ),
    ).toEqual(['disk-1', 'disk-2', 'failed-1', 'failed-2'])
  })

  test('resolveDegradedMessageHistory never shrinks the view when a pending text also exists on disk', () => {
    // Discounting every current-view entry whose text matches a pending one
    // overshoots: 'dup' is a memory-only prompt whose text is also on disk, so
    // it was discounted once per matching entry and a strictly smaller degraded
    // read could replace — and shrink — the retained history.
    expect(
      resolveDegradedMessageHistory(['dup', 'dup', 'dup'], ['later'], ['dup']),
    ).toEqual(['dup', 'dup', 'dup'])
    // One duplicate is enough to break the invariant for an equally sized read.
    expect(
      resolveDegradedMessageHistory(['dup', 'disk-2'], ['later'], ['dup']),
    ).toEqual(['dup', 'disk-2'])
    // Growth still happens when the degraded read genuinely saw more entries.
    expect(
      resolveDegradedMessageHistory(
        ['dup', 'disk-2'],
        ['disk-2', 'disk-3', 'disk-4'],
        ['dup'],
      ),
    ).toEqual(['disk-2', 'disk-3', 'disk-4', 'dup'])
  })

  test('resolveDegradedMessageHistory refuses a longer degraded read that lost retained entries', () => {
    // Length alone is not enough: a strictly longer partial read that dropped an
    // entry the retained view held would still shrink what is navigable, so the
    // candidate must keep every retained entry to win.
    expect(
      resolveDegradedMessageHistory(
        ['disk-1', 'disk-2'],
        ['disk-2', 'disk-3', 'disk-4'],
      ),
    ).toEqual(['disk-1', 'disk-2'])
    // Duplicates count as their own navigable entries, so keeping only one of
    // two identical prompts loses one of them.
    expect(
      resolveDegradedMessageHistory(['dup', 'dup'], ['dup', 'other', 'more']),
    ).toEqual(['dup', 'dup'])
    // A superset of the retained view is still adopted.
    expect(
      resolveDegradedMessageHistory(
        ['disk-1', 'disk-2'],
        ['disk-1', 'disk-2', 'disk-3'],
      ),
    ).toEqual(['disk-1', 'disk-2', 'disk-3'])
  })

  test('a growing degraded history keeps memory-only prompts navigable and unduplicated', () => {
    // Mirrors the input history hook's readHistory across two degraded loads
    // followed by a trustworthy one.
    const pending = ['append-failed']
    const first = resolveDegradedMessageHistory([], ['disk-1'], pending)
    expect(first).toEqual(['disk-1', 'append-failed'])

    const second = resolveDegradedMessageHistory(
      first,
      ['disk-1', 'disk-2'],
      pending,
    )
    expect(second).toEqual(['disk-1', 'disk-2', 'append-failed'])

    // The prompt finally appears on disk (a late failure, or another terminal):
    // it is folded once, not duplicated, and stops being carried.
    expect(
      foldUnpersistedMessageHistory(
        ['disk-1', 'disk-2', 'append-failed'],
        pending,
      ),
    ).toEqual({
      history: ['disk-1', 'disk-2', 'append-failed'],
      unpersisted: [],
    })
  })

  test('shouldRetryUnavailableHistory refunds a spent budget after a long idle stretch', () => {
    const now = 1_000_000
    // Without the refund the budget is spent for the whole session: a history
    // contended for the first few keypresses would never regain up/down
    // navigation, however long it has been free since.
    expect(
      shouldRetryUnavailableHistory(
        {
          attempts: MESSAGE_HISTORY_MAX_RETRY_ATTEMPTS,
          lastAttemptMs: now - MESSAGE_HISTORY_RETRY_REFUND_MS,
        },
        now,
      ),
    ).toBe(true)
    // Just inside the refund window the cap still holds.
    expect(
      shouldRetryUnavailableHistory(
        {
          attempts: MESSAGE_HISTORY_MAX_RETRY_ATTEMPTS,
          lastAttemptMs: now - MESSAGE_HISTORY_RETRY_REFUND_MS + 1,
        },
        now,
      ),
    ).toBe(false)
    // The refund interval is a multiple of the cooldown, so a refunded retry is
    // never cheaper than a normal one.
    expect(MESSAGE_HISTORY_RETRY_REFUND_MS).toBeGreaterThan(
      MESSAGE_HISTORY_RETRY_COOLDOWN_MS,
    )
  })

  test('the retry budget runs on a monotonic clock, not the wall clock', () => {
    // historyRetryNowMs must not be affected by a system clock adjustment: a
    // backwards jump used to leave lastAttemptMs in the future, which made
    // shouldRetryUnavailableHistory refuse every retry for the length of the
    // jump and stranded the session on an unavailable history.
    const wallClock = spyOn(Date, 'now').mockReturnValue(0)
    try {
      const first = historyRetryNowMs()
      // A backwards wall-clock jump of an hour.
      wallClock.mockReturnValue(-3_600_000)
      const second = historyRetryNowMs()
      expect(second).toBeGreaterThanOrEqual(first)
    } finally {
      wallClock.mockRestore()
    }

    // A timestamp that appears to be in the future (a state carried across a
    // clock domain change) counts as fully idle rather than as "the cooldown
    // has not elapsed", so the retry happens now instead of waiting the jump
    // out — and it starts from a refunded budget.
    const now = 1_000
    const fromTheFuture = {
      attempts: MESSAGE_HISTORY_MAX_RETRY_ATTEMPTS,
      lastAttemptMs: now + 3_600_000,
    }
    expect(shouldRetryUnavailableHistory(fromTheFuture, now)).toBe(true)
    expect(recordHistoryRetryAttempt(fromTheFuture, now, true)).toEqual({
      attempts: 1,
      lastAttemptMs: now,
    })

    // The retry composition uses the same rule, so a future timestamp does not
    // block the mid-navigation retry either.
    expect(
      retryUnavailableHistoryNavigation({
        history: [],
        index: -1,
        retry: fromTheFuture,
        nowMs: now,
        load: () => ({ history: ['recovered'], unavailable: false }),
      }),
    ).toEqual({
      history: ['recovered'],
      unavailable: false,
      retry: { attempts: 0, lastAttemptMs: now },
      index: -1,
      restoreDraft: false,
    })
  })

  test('recordHistoryRetryAttempt spends, clears and refunds the retry budget', () => {
    const now = 1_000_000
    // A failed attempt spends one unit of budget.
    expect(
      recordHistoryRetryAttempt(
        { attempts: 1, lastAttemptMs: now - MESSAGE_HISTORY_RETRY_COOLDOWN_MS },
        now,
        true,
      ),
    ).toEqual({ attempts: 2, lastAttemptMs: now })
    // A trustworthy load clears it entirely.
    expect(
      recordHistoryRetryAttempt(
        { attempts: MESSAGE_HISTORY_MAX_RETRY_ATTEMPTS, lastAttemptMs: 0 },
        now,
        false,
      ),
    ).toEqual({ attempts: 0, lastAttemptMs: now })
    // An attempt made after a long idle stretch starts from a refunded budget.
    expect(
      recordHistoryRetryAttempt(
        {
          attempts: MESSAGE_HISTORY_MAX_RETRY_ATTEMPTS,
          lastAttemptMs: now - MESSAGE_HISTORY_RETRY_REFUND_MS,
        },
        now,
        true,
      ),
    ).toEqual({ attempts: 1, lastAttemptMs: now })
  })

  test('retryUnavailableHistoryNavigation reloads, re-anchors the cursor and restores the draft', () => {
    const now = 1_000_000
    const affordable = {
      attempts: 1,
      lastAttemptMs: now - MESSAGE_HISTORY_RETRY_COOLDOWN_MS,
    }

    // A longer, trustworthy reload: the focused entry keeps the cursor, which
    // follows it to its new position instead of parking past the end where
    // up/down silently do nothing.
    let loads = 0
    expect(
      retryUnavailableHistoryNavigation({
        history: ['b', 'c'],
        index: 1,
        retry: affordable,
        nowMs: now,
        load: () => {
          loads += 1
          return { history: ['a', 'b', 'c'], unavailable: false }
        },
      }),
    ).toEqual({
      history: ['a', 'b', 'c'],
      unavailable: false,
      retry: { attempts: 0, lastAttemptMs: now },
      index: 2,
      restoreDraft: false,
    })
    expect(loads).toBe(1)

    // A trustworthy but empty reload ends navigation, so the caller is told to
    // put its saved draft back — otherwise the draft is unreachable, since
    // down-arrow returns early at index -1 and up-arrow on the empty history.
    expect(
      retryUnavailableHistoryNavigation({
        history: ['b', 'c'],
        index: 1,
        retry: affordable,
        nowMs: now,
        load: () => ({ history: [], unavailable: false }),
      }),
    ).toEqual({
      history: [],
      unavailable: false,
      retry: { attempts: 0, lastAttemptMs: now },
      index: -1,
      restoreDraft: true,
    })

    // A refused retry does not load at all: that is what keeps a contended
    // history from paying a blocking lock acquisition per keypress.
    let refusedLoads = 0
    expect(
      retryUnavailableHistoryNavigation({
        history: ['b', 'c'],
        index: 1,
        retry: { attempts: 1, lastAttemptMs: now },
        nowMs: now,
        load: () => {
          refusedLoads += 1
          return { history: [], unavailable: false }
        },
      }),
    ).toBeUndefined()
    expect(refusedLoads).toBe(0)

    // A still-degraded reload keeps the caller unavailable, spends one more
    // attempt and leaves the cursor where it was.
    expect(
      retryUnavailableHistoryNavigation({
        history: ['b', 'c'],
        index: 1,
        retry: affordable,
        nowMs: now,
        load: () => ({ history: ['b', 'c'], unavailable: true }),
      }),
    ).toEqual({
      history: ['b', 'c'],
      unavailable: true,
      retry: { attempts: 2, lastAttemptMs: now },
      index: 1,
      restoreDraft: false,
    })
  })

  test('resolveNavigationDraftText strips the bash draft prefix only', () => {
    // A bash draft is stored with the '!' its input never shows.
    expect(resolveNavigationDraftText('!git status', true)).toBe('git status')
    // A default-mode draft keeps its text even when it starts with '!'.
    expect(resolveNavigationDraftText('!git status', false)).toBe('!git status')
    expect(resolveNavigationDraftText('', true)).toBe('')
    expect(resolveNavigationDraftText('npm test', true)).toBe('npm test')
  })

  test('gives up with a busy error after exhausting attempts on a fresh foreign lock', () => {
    const lockPath = path.join(tempDir, 'message-history.lock')
    // Fresh foreign lock: it stays under the 30s staleness horizon for the
    // whole poll budget, so every acquisition attempt hits EEXIST.
    fs.writeFileSync(lockPath, '')

    appendMessageHistory('should-not-append')

    // Fresh lock (age < 30s) must not have been unlinked by stale-lock recovery.
    expect(fs.existsSync(lockPath)).toBe(true)
    // Every acquisition attempt failed, so nothing was persisted anywhere.
    expect(fs.existsSync(getMessageHistoryPath())).toBe(false)
    expect(fs.existsSync(getMessageHistoryJournalPath())).toBe(false)
    // Release the foreign lock; history then loads empty.
    fs.unlinkSync(lockPath)
    expect(loadMessageHistory()).toEqual([])
  })

  test('loadMessageHistory rejects with a busy error while a fresh foreign lock is held', () => {
    const lockPath = path.join(tempDir, 'message-history.lock')
    // Fresh foreign lock: it stays under the 30s staleness horizon for the
    // whole ~500ms non-interactive poll budget. Unlike the swallowing writers,
    // loadMessageHistory deliberately propagates the busy failure — its UI
    // callers (prompt history search screen, input history hook) must catch it
    // or degrade to [], so a held lock can never throw inside an input
    // handler or render pass.
    fs.writeFileSync(lockPath, '')

    expect(() => loadMessageHistory()).toThrow(
      'Message history is busy in another Openbuff process',
    )

    // Fresh foreign lock untouched by stale-lock recovery.
    expect(fs.existsSync(lockPath)).toBe(true)
  })

  test('loadMessageHistorySafe degrades to [] on a busy lock while loadMessageHistory throws', () => {
    // Single shared degradation path for every UI caller (input history hook
    // mount + navigation retry, prompt history search screen mount): if the
    // wrapper's catch is removed this test throws instead of returning [].
    fs.writeFileSync(getMessageHistoryPath(), JSON.stringify(['would-load']))
    const lockPath = path.join(tempDir, 'message-history.lock')
    fs.writeFileSync(lockPath, '')

    expect(() => loadMessageHistory()).toThrow(
      'Message history is busy in another Openbuff process',
    )

    let reported: unknown
    expect(
      loadMessageHistorySafe((error) => {
        reported = error
      }),
    ).toEqual([])
    // The failure is surfaced to the caller so the UI can distinguish an
    // unavailable history from a genuinely empty one.
    expect((reported as Error).message).toContain(
      'busy in another Openbuff process',
    )

    // The empty result really is degradation, not an empty history: once the
    // foreign lock is released the same call loads the snapshot.
    fs.unlinkSync(lockPath)
    expect(loadMessageHistorySafe()).toEqual(['would-load'])
  })

  test('drops journal entries already folded into the snapshot after a crash between snapshot write and journal truncation', () => {
    // Crash window: 'b' and 'c' were appended while the snapshot held a single
    // entry ('a'), then compaction wrote the snapshot ['a','b','c'] but crashed
    // before truncating the journal. Their recorded snapshot length (1) is below
    // the current snapshot length (3), so they were already folded in.
    fs.writeFileSync(getMessageHistoryPath(), JSON.stringify(['a', 'b', 'c']))
    fs.writeFileSync(
      getMessageHistoryJournalPath(),
      `${JSON.stringify({ s: 1, t: 'b' })}\n${JSON.stringify({ s: 1, t: 'c' })}\n`,
    )
    expect(loadMessageHistory()).toEqual(['a', 'b', 'c'])

    // Entries appended after the crash carry the current snapshot length and
    // are kept; only the replayed window is dropped.
    appendMessageHistory('d')
    expect(loadMessageHistory()).toEqual(['a', 'b', 'c', 'd'])
  })

  test('preserves repeated prompts that are not crash-replay overlap', () => {
    // Repeats appended at the current snapshot length are legitimate history.
    fs.writeFileSync(getMessageHistoryPath(), JSON.stringify(['a']))
    fs.writeFileSync(
      getMessageHistoryJournalPath(),
      `${JSON.stringify({ s: 1, t: 'x' })}\n${JSON.stringify({ s: 1, t: 'x' })}\n`,
    )
    expect(loadMessageHistory()).toEqual(['a', 'x', 'x'])
  })

  test('preserves a verbatim repeat submitted right after a compaction', () => {
    // Content-equality dedupe silently lost this: the snapshot's trailing entry
    // and the fresh journal entry are the same text. Sequence tagging keeps it
    // because the repeat was appended at the current snapshot length.
    saveMessageHistory(['npm test'])
    appendMessageHistory('npm test')

    expect(loadMessageHistory()).toEqual(['npm test', 'npm test'])
  })

  test('keeps legacy bare-string journal lines written before sequence tagging', () => {
    // Backward compatibility: pre-existing journals carry no sequence tag, so
    // their entries must all still replay on top of the snapshot.
    fs.writeFileSync(getMessageHistoryPath(), JSON.stringify(['snap']))
    fs.writeFileSync(
      getMessageHistoryJournalPath(),
      `${JSON.stringify('legacy-1')}\n${JSON.stringify('legacy-2')}\n`,
    )
    expect(loadMessageHistory()).toEqual(['snap', 'legacy-1', 'legacy-2'])
  })

  test('limits history to MAX_HISTORY_SIZE (1000) on load', () => {
    const entries = Array.from({ length: 1500 }, (_, i) => `msg-${i}`)
    fs.writeFileSync(getMessageHistoryPath(), JSON.stringify(entries))
    const loaded = loadMessageHistory()
    expect(loaded).toHaveLength(1000)
    expect(loaded[0]).toBe('msg-500')
    expect(loaded[999]).toBe('msg-1499')
  })

  test('compacts only when the journal reaches MESSAGE_HISTORY_COMPACT_THRESHOLD_BYTES', () => {
    const unitLine = `${JSON.stringify('x'.repeat(250))}\n`
    // Below the threshold: append goes through without compaction.
    fs.writeFileSync(
      getMessageHistoryJournalPath(),
      unitLine.repeat(
        Math.floor(
          (MESSAGE_HISTORY_COMPACT_THRESHOLD_BYTES - 1) / unitLine.length,
        ),
      ),
    )
    appendMessageHistory('below-threshold')
    expect(
      fs.readFileSync(getMessageHistoryJournalPath(), 'utf8'),
    ).toContain('"below-threshold"')
    expect(fs.existsSync(getMessageHistoryPath())).toBe(false)

    // Just past the threshold: the same append path now compacts.
    fs.writeFileSync(
      getMessageHistoryJournalPath(),
      unitLine.repeat(
        Math.ceil(
          (MESSAGE_HISTORY_COMPACT_THRESHOLD_BYTES + 1) / unitLine.length,
        ),
      ),
    )
    appendMessageHistory('above-threshold')
    expect(fs.readFileSync(getMessageHistoryJournalPath(), 'utf8')).toBe('')
    const snapshot = JSON.parse(
      fs.readFileSync(getMessageHistoryPath(), 'utf8'),
    ) as unknown[]
    expect(snapshot).toHaveLength(1000)
    expect(snapshot.at(-1)).toBe('above-threshold')
  })

  test('appendMessageHistory waits for a concurrently held lock and succeeds after release', async () => {
    const lockPath = path.join(tempDir, 'message-history.lock')
    const holderReady = path.join(tempDir, 'holder.ready')
    const waiterSignal = path.join(tempDir, 'waiter.waiting')
    let holder: ReturnType<typeof spawn> | undefined
    try {
      // The holder releases ~25ms after the signal, inside the interactive
      // acquisition budget (≈100ms) — but only by ~70ms, which a descheduled
      // child on a loaded runner can consume. A busy append returns false
      // without writing anything, which is correct behaviour under real
      // contention rather than a bug, so retry the whole scenario with a
      // freshly armed holder (as the other multi-process tests here do) and
      // fail only when the wait never succeeds. HOLDER_SCRIPT exits after
      // releasing, so each retry stops the dead child, clears the
      // ready/signal markers and any lock left at the path, and resets the
      // history files so the exact-history assertion below still holds.
      let appended = false
      for (let attempt = 0; attempt < 3 && !appended; attempt++) {
        if (attempt > 0) {
          holder?.kill()
          fs.rmSync(holderReady, { force: true })
          fs.rmSync(waiterSignal, { force: true })
          fs.rmSync(lockPath, { force: true })
          fs.rmSync(getMessageHistoryJournalPath(), { force: true })
          fs.rmSync(getMessageHistoryPath(), { force: true })
        }
        holder = spawn(process.execPath, ['-e', HOLDER_SCRIPT], {
          env: { ...process.env, MH_DIR: tempDir },
          stdio: 'ignore',
        })
        await tryWaitForMarker(holderReady)
        // The child provably holds the lock right now and releases it shortly
        // after the signal below (hard-capped at 3s). A child that died before
        // claiming the lock leaves no lock here, so re-arm instead of asserting.
        if (!fs.existsSync(lockPath)) continue

        // Signal the holder so release lands deterministically soon after the
        // append starts contending, rather than racing a fixed timer.
        fs.writeFileSync(waiterSignal, 'go')
        // The return value is the only signal that separates "waited, then
        // persisted" from "gave up busy and dropped the entry".
        appended = appendMessageHistory('after-holder-release')
      }

      // The waiter acquired the lock after release instead of dropping the entry.
      expect(appended).toBe(true)
      expect(loadMessageHistory()).toEqual(['after-holder-release'])
      expect(fs.existsSync(lockPath)).toBe(false)
    } finally {
      holder?.kill()
    }
  })

  test('serializes concurrent appendMessageHistory calls from separate processes', async () => {
    const runChildAppend = (
      message: string,
      startedMarker: string,
    ): { started: Promise<void>; exited: Promise<number> } => {
      const child = spawn(process.execPath, ['-e', CHILD_APPEND_SCRIPT], {
        env: {
          ...process.env,
          OPENBUFF_CONFIG_DIR: tempDir,
          MH_MODULE: path.join(import.meta.dir, '..', 'message-history.ts'),
          MH_MESSAGE: message,
          MH_STARTED_MARKER: startedMarker,
        },
        stdio: ['ignore', 'ignore', 'inherit'],
      })
      return {
        started: waitForMarker(startedMarker).then(() => undefined),
        exited: new Promise<number>((resolve, reject) => {
          child.on('error', reject)
          child.on('exit', (code) => resolve(code ?? -1))
        }),
      }
    }

    // Each child writes its own marker before touching appendMessageHistory.
    // Awaiting both markers before awaiting exits guarantees their critical
    // sections overlap, so only the file lock can serialize them.
    const childA = runChildAppend(
      'concurrent-a',
      path.join(tempDir, 'child-a.started'),
    )
    const childB = runChildAppend(
      'concurrent-b',
      path.join(tempDir, 'child-b.started'),
    )
    await Promise.all([childA.started, childB.started])
    const codes = await Promise.all([childA.exited, childB.exited])

    expect(codes).toEqual([0, 0])
    const loaded = loadMessageHistory()
    expect(loaded).toContain('concurrent-a')
    expect(loaded).toContain('concurrent-b')
    expect(
      fs.existsSync(path.join(tempDir, 'message-history.lock')),
    ).toBe(false)
  })

  test('lock release verifies inode identity and preserves a successor lock installed mid-operation', async () => {
    // A multi-threshold journal keeps compaction inside the append busy long
    // enough for the swapper to install its successor while the lock is held.
    const fillerLine = `${JSON.stringify('y'.repeat(255))}\n`
    const fillOversizedJournal = (): void => {
      fs.writeFileSync(
        getMessageHistoryJournalPath(),
        fillerLine.repeat(
          Math.ceil(
            (MESSAGE_HISTORY_COMPACT_THRESHOLD_BYTES * 8) / fillerLine.length,
          ),
        ),
      )
    }

    let swapper: ReturnType<typeof spawn> | undefined
    try {
      const lockPath = path.join(tempDir, 'message-history.lock')
      const swapperReady = path.join(tempDir, 'swapper.ready')
      const swapperDone = path.join(tempDir, 'swapper.done')
      // The swapper provably holds a fresh lock right now; each attempt below
      // queues behind it (~40ms), acquires, then spends a longer stretch
      // compacting the oversized journal — the swap lands mid-operation. On a
      // heavily loaded runner the append can instead give up busy, or the swap
      // can land too late; SWAPPER_SCRIPT then reports 'missed' rather than
      // spinning forever. Every wait here is non-throwing, so any missed
      // handoff (including a child that died before writing a marker) falls
      // through to the next attempt: stop any live swapper, clear the stale
      // ready/done markers, and remove whatever lock remains at the path so
      // the new child can claim it with 'wx'. That keeps the bounded retry
      // genuinely re-armable instead of throwing out of the loop.
      let successorPreserved = false
      for (let attempt = 0; attempt < 3 && !successorPreserved; attempt++) {
        if (attempt > 0) {
          swapper?.kill()
          fs.rmSync(swapperReady, { force: true })
          fs.rmSync(swapperDone, { force: true })
          fs.rmSync(lockPath, { force: true })
        }
        swapper = spawn(process.execPath, ['-e', SWAPPER_SCRIPT], {
          env: { ...process.env, MH_DIR: tempDir },
          stdio: 'ignore',
        })
        if ((await tryWaitForMarker(swapperReady)) === undefined) continue
        fillOversizedJournal()
        appendMessageHistory('swap-test')
        // Outlives the child's own 5s swap deadline so a 'missed' report is
        // observed here rather than timing out on a child that already gave up.
        if ((await tryWaitForMarker(swapperDone, 8_000)) !== 'swapped') continue
        successorPreserved =
          fs.existsSync(lockPath) &&
          fs.readFileSync(lockPath, 'utf8') === 'successor-lock'
      }
      // Without inode-checked release, the append's cleanup would have deleted
      // the swapper's replacement lock.
      expect(successorPreserved).toBe(true)

      // Remove the successor so the locked-load assertion below can acquire.
      fs.unlinkSync(lockPath)
      const loaded = loadMessageHistory()
      expect(loaded).toHaveLength(1000)
      expect(loaded.at(-1)).toBe('swap-test')
    } finally {
      swapper?.kill()
    }
  })

  test('does not rewrite persisted history when the lock is reclaimed before the snapshot write', () => {
    // A stalled critical section (SIGSTOP/Ctrl+Z, host suspend, very slow FS)
    // can be reclaimed as stale mid-operation. Here the takeover happens while
    // compaction is still folding the journal: the snapshot it would write was
    // built from a read the successor's appends may already postdate, so
    // nothing may be overwritten at all.
    const lockPath = path.join(tempDir, 'message-history.lock')
    const journalPath = getMessageHistoryJournalPath()
    const fillerLine = `${JSON.stringify('y'.repeat(1000))}\n`
    fs.writeFileSync(
      journalPath,
      fillerLine.repeat(
        Math.ceil(
          (MESSAGE_HISTORY_COMPACT_THRESHOLD_BYTES + 1) / fillerLine.length,
        ),
      ),
    )

    const realReadFileSync = fs.readFileSync.bind(fs)
    let reclaimed = false
    const readSpy = spyOn(fs, 'readFileSync').mockImplementation(((
      target: Parameters<typeof fs.readFileSync>[0],
      options?: Parameters<typeof fs.readFileSync>[1],
    ) => {
      const contents = realReadFileSync(target, options)
      // Fires inside compaction's fold read, i.e. before it writes anything.
      if (String(target) === journalPath && !reclaimed) {
        reclaimed = true
        fs.unlinkSync(lockPath)
        fs.writeFileSync(lockPath, 'successor-lock')
      }
      return contents
    }) as typeof fs.readFileSync)

    try {
      // The journal line itself is durable; only the destructive rewrite is
      // declined.
      expect(appendMessageHistory('reclaimed')).toBe(true)
    } finally {
      readSpy.mockRestore()
    }
    expect(reclaimed).toBe(true)

    // No snapshot was written and the journal was not blanked, so every entry
    // survives for whoever holds the lock now.
    expect(fs.existsSync(getMessageHistoryPath())).toBe(false)
    expect(fs.readFileSync(journalPath, 'utf8')).toContain('"reclaimed"')

    // The successor's lock was left in place by our release; drop it so the
    // verifying load can acquire.
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('successor-lock')
    fs.unlinkSync(lockPath)
    expect(loadMessageHistory()).toContain('reclaimed')
  })

  test('preserves journal entries appended after the snapshot write instead of truncating them', () => {
    // The successor appends between the snapshot write and the truncation, so
    // the fresh snapshot cannot contain its prompt. Blanking the journal here
    // would destroy it; only the folded prefix may be retired.
    const journalPath = getMessageHistoryJournalPath()
    const snapshotPath = getMessageHistoryPath()
    const fillerLine = `${JSON.stringify('y'.repeat(1000))}\n`
    fs.writeFileSync(
      journalPath,
      fillerLine.repeat(
        Math.ceil(
          (MESSAGE_HISTORY_COMPACT_THRESHOLD_BYTES + 1) / fillerLine.length,
        ),
      ),
    )

    const realRenameSync = fs.renameSync.bind(fs)
    let successorAppended = false
    const renameSpy = spyOn(fs, 'renameSync').mockImplementation(((
      oldPath: Parameters<typeof fs.renameSync>[0],
      newPath: Parameters<typeof fs.renameSync>[1],
    ) => {
      realRenameSync(oldPath, newPath)
      if (String(newPath) === snapshotPath && !successorAppended) {
        successorAppended = true
        fs.appendFileSync(
          journalPath,
          `${JSON.stringify({ s: 0, t: 'successor-prompt' })}\n`,
        )
      }
    }) as typeof fs.renameSync)

    try {
      expect(appendMessageHistory('compact-me')).toBe(true)
    } finally {
      renameSpy.mockRestore()
    }
    expect(successorAppended).toBe(true)

    // The snapshot folded in everything it read, and exactly the appended tail
    // is left in the journal — re-emitted untagged, since its sequence tag
    // described the snapshot generation this write replaced.
    const snapshot = JSON.parse(
      fs.readFileSync(snapshotPath, 'utf8'),
    ) as string[]
    expect(snapshot.at(-1)).toBe('compact-me')
    expect(snapshot).not.toContain('successor-prompt')
    expect(fs.readFileSync(journalPath, 'utf8')).toBe(
      `${JSON.stringify('successor-prompt')}\n`,
    )

    // The successor's prompt is still navigable rather than silently erased.
    expect(loadMessageHistory().at(-1)).toBe('successor-prompt')
  })

  test('leaves the journal untouched when the appended tail exceeds the bounded read', () => {
    // The tail appended after the folded prefix is larger than
    // MESSAGE_HISTORY_READ_MAX_BYTES, so the rewrite could only see a window of
    // it. Rewriting from that window would destroy the lines between the folded
    // prefix and the window start — here the successor's prompt, which sits at
    // the very beginning of the tail — so nothing may be rewritten at all.
    const journalPath = getMessageHistoryJournalPath()
    const snapshotPath = getMessageHistoryPath()
    const fillerLine = `${JSON.stringify('y'.repeat(1000))}\n`
    fs.writeFileSync(
      journalPath,
      fillerLine.repeat(
        Math.ceil(
          (MESSAGE_HISTORY_COMPACT_THRESHOLD_BYTES + 1) / fillerLine.length,
        ),
      ),
    )

    const realRenameSync = fs.renameSync.bind(fs)
    let successorAppended = false
    const renameSpy = spyOn(fs, 'renameSync').mockImplementation(((
      oldPath: Parameters<typeof fs.renameSync>[0],
      newPath: Parameters<typeof fs.renameSync>[1],
    ) => {
      realRenameSync(oldPath, newPath)
      if (String(newPath) === snapshotPath && !successorAppended) {
        successorAppended = true
        // Oldest-first: the prompt lands before the bulk padding, so a
        // window-bounded rewrite would drop exactly this line.
        fs.appendFileSync(
          journalPath,
          `${JSON.stringify('successor-prompt')}\n`,
        )
        fs.appendFileSync(
          journalPath,
          `${JSON.stringify('p'.repeat(MESSAGE_HISTORY_READ_MAX_BYTES))}\n`,
        )
      }
    }) as typeof fs.renameSync)

    try {
      expect(appendMessageHistory('compact-me')).toBe(true)
    } finally {
      renameSpy.mockRestore()
    }
    expect(successorAppended).toBe(true)

    // The snapshot was still written, but the journal keeps every line: the
    // folded prefix (dropped as crash-replay overlap on the next load) and the
    // successor's prompt.
    expect(
      JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as string[],
    ).toContain('compact-me')
    const journal = fs.readFileSync(journalPath, 'utf8')
    expect(journal).toContain(JSON.stringify('successor-prompt'))
    expect(journal).toContain(JSON.stringify('compact-me'))
  })

  test('leaves a journal replaced mid-operation completely untouched', () => {
    // The successor compacted the journal itself (new inode) while we were
    // writing our snapshot. The folded prefix can no longer be located, so we
    // must not rewrite the journal at all.
    const journalPath = getMessageHistoryJournalPath()
    const snapshotPath = getMessageHistoryPath()
    const fillerLine = `${JSON.stringify('y'.repeat(1000))}\n`
    fs.writeFileSync(
      journalPath,
      fillerLine.repeat(
        Math.ceil(
          (MESSAGE_HISTORY_COMPACT_THRESHOLD_BYTES + 1) / fillerLine.length,
        ),
      ),
    )

    const realRenameSync = fs.renameSync.bind(fs)
    const successorJournal = `${JSON.stringify('successor-only')}\n`
    let replaced = false
    const renameSpy = spyOn(fs, 'renameSync').mockImplementation(((
      oldPath: Parameters<typeof fs.renameSync>[0],
      newPath: Parameters<typeof fs.renameSync>[1],
    ) => {
      realRenameSync(oldPath, newPath)
      if (String(newPath) === snapshotPath && !replaced) {
        replaced = true
        fs.unlinkSync(journalPath)
        fs.writeFileSync(journalPath, successorJournal)
      }
    }) as typeof fs.renameSync)

    try {
      appendMessageHistory('compact-me')
    } finally {
      renameSpy.mockRestore()
    }
    expect(replaced).toBe(true)

    expect(fs.readFileSync(journalPath, 'utf8')).toBe(successorJournal)
    expect(loadMessageHistory().at(-1)).toBe('successor-only')
  })

  test('leaves the journal untouched when the lock is reclaimed after the snapshot write', () => {
    // The reclaim lands after the snapshot write and the successor then appends.
    // Rewriting the journal down to that appended tail would itself be a
    // destructive write on a file we no longer own — the successor may be
    // appending to it right now — so it must be left completely alone.
    const journalPath = getMessageHistoryJournalPath()
    const snapshotPath = getMessageHistoryPath()
    const lockPath = path.join(tempDir, 'message-history.lock')
    const fillerLine = `${JSON.stringify('y'.repeat(1000))}\n`
    const filler = fillerLine.repeat(
      Math.ceil(
        (MESSAGE_HISTORY_COMPACT_THRESHOLD_BYTES + 1) / fillerLine.length,
      ),
    )
    fs.writeFileSync(journalPath, filler)

    const realRenameSync = fs.renameSync.bind(fs)
    let reclaimed = false
    const renameSpy = spyOn(fs, 'renameSync').mockImplementation(((
      oldPath: Parameters<typeof fs.renameSync>[0],
      newPath: Parameters<typeof fs.renameSync>[1],
    ) => {
      realRenameSync(oldPath, newPath)
      if (String(newPath) === snapshotPath && !reclaimed) {
        reclaimed = true
        // Our stalled lock is reclaimed as stale, then the successor appends.
        // Untagged line: it replays on top of whatever snapshot exists.
        fs.unlinkSync(lockPath)
        fs.writeFileSync(lockPath, 'successor-lock')
        fs.appendFileSync(journalPath, `${JSON.stringify('successor-prompt')}\n`)
      }
    }) as typeof fs.renameSync)

    try {
      expect(appendMessageHistory('compact-me')).toBe(true)
    } finally {
      renameSpy.mockRestore()
    }
    expect(reclaimed).toBe(true)

    // Neither the folded prefix nor the successor's append was rewritten away.
    expect(fs.readFileSync(journalPath, 'utf8')).toBe(
      `${filler}${JSON.stringify({ s: 0, t: 'compact-me' })}\n${JSON.stringify(
        'successor-prompt',
      )}\n`,
    )
    // The snapshot write itself happened while the lock was still ours.
    expect(
      (JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as string[]).at(-1),
    ).toBe('compact-me')

    // The successor's lock survived our release, and its prompt is navigable.
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('successor-lock')
    fs.unlinkSync(lockPath)
    expect(loadMessageHistory().at(-1)).toBe('successor-prompt')
  })

  test('saveMessageHistory preserves entries appended by a successor mid-operation', () => {
    // Same reclaim hazard on the explicit save path: the snapshot it writes
    // predates the successor's append, so the append must survive.
    const journalPath = getMessageHistoryJournalPath()
    const snapshotPath = getMessageHistoryPath()
    fs.writeFileSync(journalPath, `${JSON.stringify('folded-in')}\n`)

    const realRenameSync = fs.renameSync.bind(fs)
    let successorAppended = false
    const renameSpy = spyOn(fs, 'renameSync').mockImplementation(((
      oldPath: Parameters<typeof fs.renameSync>[0],
      newPath: Parameters<typeof fs.renameSync>[1],
    ) => {
      realRenameSync(oldPath, newPath)
      if (String(newPath) === snapshotPath && !successorAppended) {
        successorAppended = true
        fs.appendFileSync(journalPath, `${JSON.stringify('late-prompt')}\n`)
      }
    }) as typeof fs.renameSync)

    try {
      saveMessageHistory(['a', 'folded-in'])
    } finally {
      renameSpy.mockRestore()
    }
    expect(successorAppended).toBe(true)

    expect(fs.readFileSync(journalPath, 'utf8')).toBe(
      `${JSON.stringify('late-prompt')}\n`,
    )
    expect(loadMessageHistory()).toEqual(['a', 'folded-in', 'late-prompt'])
  })

  test('handles fully malformed snapshot and journal without throwing', () => {
    fs.writeFileSync(getMessageHistoryPath(), '\u0000\u0001not json at all')
    fs.writeFileSync(getMessageHistoryJournalPath(), '{broken\n\u0000\u007f\n')
    expect(loadMessageHistory()).toEqual([])
  })
})
