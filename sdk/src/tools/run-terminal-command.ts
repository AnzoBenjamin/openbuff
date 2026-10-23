import { spawn } from 'child_process'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { StringDecoder } from 'string_decoder'

import {
  stripColors,
  truncateStringWithMessage,
} from '../../../common/src/util/string'
import { getChildProcessEnv, scrubChildProcessEnv } from '../env'
import {
  isProcessTreeAlive,
  killBackgroundJob,
  startBackgroundJob,
  terminateProcessTree,
} from './background-jobs'
import { throwIfAborted } from './concurrency'
import { resolveFilePathForOperation } from './path-utils'
import { runGit } from './git-status'
import {
  evaluateTerminalCommandPolicy,
  type TerminalPermissionProfile,
} from './terminal-command-policy'
import {
  classifyTerminalHarnessAction,
  type ClassifiedHarnessAction,
} from '../services/harness-enforcement'

import type { CodebuffToolOutput } from '../../../common/src/tools/list'

const COMMAND_OUTPUT_LIMIT = 50_000
/**
 * Byte budget for one safety spawn's TOTAL output. It bounds how much of a diff
 * the preflight is willing to inspect at all — an over-budget stream fails the
 * check closed rather than being read truncated — and it is NOT how much of that
 * output is retained: neither spawn keeps its stdout (`runGitForSafety` hands
 * each chunk straight to a streaming observer, and the `--check` reader keeps
 * only a bounded head), so the peak one spawn holds is a few KB regardless of
 * this number.
 */
const GIT_SAFETY_OUTPUT_LIMIT = 2_000_000
/**
 * Ceiling for one preflight `git diff --cached` spawn. A local diff over a
 * staged index returns in well under a second; anything past this bound is a
 * stall, and the spawn is killed so the preflight fails closed (inspection
 * failure) instead of hanging the tool call.
 */
const GIT_SAFETY_SPAWN_TIMEOUT_MS = 10_000
/**
 * Shape of a `git diff --cached --check` diagnostic, as opposed to a git
 * failure.
 *
 * `--check` reports each offending line as `<path>:<line>: trailing whitespace.`
 * (or `space before tab`, etc.). Everything else git writes on a non-zero exit is
 * a FATAL error — `fatal: not a git repository`, an index lock, a spawn problem —
 * which means the check never ran. Telling the two apart by "did it print
 * anything" conflated them and reported an unreadable repository to the caller as
 * a whitespace policy violation.
 */
const WHITESPACE_DIAGNOSTIC = /:\d+: [a-z]/m
/**
 * Bytes of the `--check` thread of output the preflight retains.
 *
 * `--check` emits one diagnostic line per offending line, so a monorepo-sized
 * staged diff can produce megabytes of them — and the old reader accumulated all
 * of it (`stdout += chunk.toString('utf8')`) up to GIT_SAFETY_OUTPUT_LIMIT while
 * the -U0 scan accumulated its own tables beside it. Only the FIRST diagnostic
 * line (or, on a fatal error, a short explanation) is ever reported, so the
 * reader below stops at the first `WHITESPACE_DIAGNOSTIC` match and otherwise
 * keeps at most this many bytes, cut on a line boundary.
 */
const GIT_SAFETY_WHITESPACE_HEAD_BYTES = 4 * 1_024
/**
 * How many staged paths the -U0 scanner retains.
 *
 * The caller only ever asks `find` for the first sensitive name, so the table
 * does not need to describe the whole staged set. Renames contribute two
 * entries, so the worst case is this many names plus the runner-up of the last
 * rename's header, and the scanner records the truncation rather than silently
 * reporting a partial list as complete.
 */
const GIT_SAFETY_MAX_STAGED_NAMES = 4_096
const SENSITIVE_STAGED_PATH =
  /(^|\/)(\.env($|\.)|id_rsa|id_ed25519|credentials(?:\.(?:json|ya?ml))?|.*\.(?:pem|p12|pfx))$/i
const SENSITIVE_STAGED_CONTENT =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}/i
// `git diff` emits one of these per staged path. It is the only place the file
// list appears in a -U0 diff, so the staged names are read from these headers
// instead of paying for a second `--name-only` diff over the same index.
const STAGED_DIFF_HEADER_PREFIX = 'diff --git '

/**
 * Bound on how much staged-diff text the sensitive-content scan holds at once.
 * Only the unscanned remainder of the current line is carried across chunks, and
 * both sensitive patterns are single-line tokens, so a multi-megabyte patch is
 * scanned line by line instead of being materialised: the old accumulator kept
 * TWO decoded copies of the patch as it streamed (`current + chunk.toString()`)
 * and handed the whole thing to one regex.
 */
const GIT_SAFETY_SCAN_WINDOW_CHARS = 16_384
/**
 * Tail carried over when a single line is longer than the window. Both sensitive
 * patterns are shorter than this (the longest is ~40 chars), so a marker
 * straddling the scanned/dropped boundary is still matched by the next scan.
 */
const GIT_SAFETY_SCAN_OVERLAP_CHARS = 256
/**
 * Characters ONE bounded scan slice may decode and match. The staged patch can
 * be up to GIT_SAFETY_OUTPUT_LIMIT bytes and arrives through back-to-back chunk
 * callbacks on the same event loop the TUI renders on, so the whole patch must
 * not be scanned in one pass: slicing it keeps any single tick's CPU work
 * bounded instead of landing a multi-megabyte regex pass inside a render frame.
 */
const GIT_SAFETY_SCAN_SLICE_CHARS = 64 * 1024

type GitSafetyResult = { exitCode: number; stdout: string; stderr: string }

type StagedDiffScan = {
  /**
   * Paths named by the diff's `diff --git` headers, in stream order, capped at
   * GIT_SAFETY_MAX_STAGED_NAMES entries.
   */
  names: string[]
  /**
   * Whether the diff named MORE paths than `names` holds. The retained prefix is
   * still complete as a prefix, so a sensitive path inside it is still found; a
   * diff large enough to truncate is reported as an inspection failure instead
   * of being cleared as if every staged path had been checked.
   */
  namesTruncated: boolean
  /** Whether any scanned line matched the sensitive-content pattern. */
  sensitiveContent: boolean
  /**
   * Whether any `diff --git` header carried a quoted path this scanner could
   * not decode. Such a path was never checked against the sensitive-name
   * patterns, so the preflight must fail closed (as an inspection failure, not
   * a policy verdict) rather than clearing the commit.
   */
  headerDecodeFailed: boolean
}

/**
 * One scanner's scan bookkeeping.
 *
 * PER SCANNER, not module-global: `createStagedDiffScanner()` is per invocation,
 * and two overlapping commit preflights (a SYNC command plus a backgrounded job,
 * or two `validateStagedCommit` callers) used to interleave into the same
 * globals. `enqueueDecodedBytes` is derived as `parkedBytes - drainDecodedBytes`,
 * and across live scanners a byte parked by one could be cancelled out by a
 * decode performed by another — so the invariant that must stay 0 reported the
 * race instead of the invariant. Keeping the counters on the scanner makes the
 * difference meaningful again.
 */
type StagedDiffScanStats = {
  slices: number
  maxSliceChars: number
  parkedBytes: number
  drainDecodedBytes: number
  /** Names the scanner retained; the retained-state half of the bound. */
  retainedNames: number
}

/**
 * Snapshots of primitive counters, most recent last. Only the seam aggregates
 * them, and only per instance — a byte parked by one scanner can never be
 * decoded by another, so summing the derived difference per scanner is the only
 * aggregation that preserves the never-decoded invariant.
 *
 * Bounded: a long session runs one scanner per commit preflight, so the ring
 * retains the most recent few instead of every scan the process ever made.
 *
 * DETACHED from the scanner, and that is not incidental. The scanner's own
 * `scanStats` object lives in a scope that closes over `queued` (the parked
 * `Buffer` chunks), `parkedText` and the `StringDecoder` — so pushing THAT object
 * into a module-level ring kept up to GIT_SAFETY_OUTPUT_LIMIT bytes of an
 * already-finished commit preflight's patch reachable for the next sixteen
 * preflights. Only the plain counters are copied out (see `snapshotStats`), so
 * a retained entry is a handful of integers with no reference to scanner state.
 */
const STAGED_DIFF_RETAINED_SCANNERS = 16
const stagedDiffScannerStats: StagedDiffScanStats[] = []

/**
 * Copies the scanner's LIVE counters into a fresh plain object.
 *
 * Called on every publish rather than once at construction, because the entry
 * the ring holds must track the scanner's current numbers (the seam aggregates
 * them) while sharing no identity with the scanner's mutable object. A copy per
 * slice is a handful of integer writes; it is the price of not pinning the
 * parked patch bytes in a module-level ring.
 */
function snapshotStats(stats: StagedDiffScanStats): StagedDiffScanStats {
  return {
    slices: stats.slices,
    maxSliceChars: stats.maxSliceChars,
    parkedBytes: stats.parkedBytes,
    drainDecodedBytes: stats.drainDecodedBytes,
    retainedNames: stats.retainedNames,
  }
}

/**
 * Test seam: how many bounded scan slices the staged-diff scanners have drained,
 * the largest number of characters any single one of them scanned, and how the
 * parked patch bytes were decoded. Scanning must stay decoupled from the stdout
 * `data` handler — draining there would put the whole patch's CPU pass inside
 * render frames — and these counters are what make that bound observable rather
 * than only documented.
 *
 * `enqueueDecodedBytes` is derived, not stored: it is the number of parked bytes
 * the drain loop never decoded, i.e. bytes that could only have been decoded
 * inside the stdout `data` handler. It must stay 0. Decoding in the handler was
 * the actual behavior this seam is meant to forbid (the previous
 * `queued.push(chunk.toString('utf8'))` did exactly that), and a slice counter
 * alone cannot see it: per-chunk decoding keeps every slice bound intact while
 * moving the cost into the render frame and splitting multi-byte sequences that
 * straddle a chunk boundary into replacement characters.
 */
export function __getStagedDiffScanStatsForTest(): {
  slices: number
  maxSliceChars: number
  maxRetainedNames: number
  enqueueDecodedBytes: number
  drainDecodedBytes: number
} {
  let slices = 0
  let maxSliceChars = 0
  let maxRetainedNames = 0
  let enqueueDecodedBytes = 0
  let drainDecodedBytes = 0
  for (const stats of stagedDiffScannerStats) {
    slices += stats.slices
    maxSliceChars = Math.max(maxSliceChars, stats.maxSliceChars)
    maxRetainedNames = Math.max(maxRetainedNames, stats.retainedNames)
    enqueueDecodedBytes += stats.parkedBytes - stats.drainDecodedBytes
    drainDecodedBytes += stats.drainDecodedBytes
  }
  return {
    slices,
    maxSliceChars,
    maxRetainedNames,
    enqueueDecodedBytes,
    drainDecodedBytes,
  }
}

/** Reset the scan counters so a test can attribute its slices to one commit. */
export function __resetStagedDiffScanStatsForTest(): void {
  stagedDiffScannerStats.length = 0
}

/**
 * Test seam: the keys of every retained ring entry.
 *
 * The ring is bounded and now holds detached counter snapshots, so the thing
 * worth pinning is that a retained entry carries ONLY primitive counters — no
 * reference that could reach the scanner scope (and with it `queued`,
 * `parkedText` or the `StringDecoder`) outliving the preflight that owned it.
 * A shared `scanStats` object would show up here as an own property the snapshot
 * type does not declare.
 */
export function __getStagedDiffRetainedStatsKeysForTest(): string[][] {
  return stagedDiffScannerStats.map((stats) => Object.keys(stats).sort())
}

/**
 * The scanner's surface. Raw chunks are only PARKED by `enqueue` — as Buffers,
 * undecoded; they are decoded with a `StringDecoder` and then matched when the
 * preflight's own loop drains them, so no decode or scan work runs inside the
 * stdout `data` callback.
 */
type StagedDiffScanner = {
  enqueue: (chunk: Buffer) => void
  /**
   * Scan at most `maxChars` characters, leaving the rest parked. Returns whether
   * scanning work remains, so the drain loop knows to yield again or to wait.
   */
  drainSlice: (maxChars: number) => boolean
  /** Resolves once a chunk is parked or the drain loop is woken by the caller. */
  waitForWork: () => Promise<void>
  /** Wake a waiting drain loop; the spawn settled or was over budget. */
  wake: () => void
  /** Scan everything still parked; used once the spawn has settled. */
  drainAll: () => void
  result: () => StagedDiffScan
  /** This scanner's own scan bookkeeping; the seam aggregates per instance. */
  stats: () => StagedDiffScanStats
}

/**
 * Both path sides of a `diff --git a/<old> b/<new>` header line, or undefined
 * for any other line. Two forms, because git quotes a path whose bytes need
 * escaping (non-ASCII under the default `core.quotePath=true`, control chars,
 * quotes): the raw `a/<old> b/<new>` form, and the C-quoted
 * `"a/<old>" "b/<new>"` form. The raw form's split is anchored on the LAST
 * ` b/` separator so a rename whose paths themselves contain ` b/` still yields
 * both names; the quoted form's split is anchored on the last `" "b/`
 * separator for the same reason. A header-shaped line whose quoted path cannot
 * be decoded is `{ unparsable: true }`, NOT undefined, so the caller can fail
 * closed instead of silently skipping the path it names.
 */
function parseStagedDiffHeader(
  line: string,
): { names: [string, string] } | { unparsable: true } | undefined {  if (!line.startsWith(STAGED_DIFF_HEADER_PREFIX)) return undefined
  const body = line.slice(STAGED_DIFF_HEADER_PREFIX.length)
  if (body.startsWith('"')) {
    const separator = body.lastIndexOf('" "b/')
    if (separator === -1) return { unparsable: true }
    // git quotes each side WITH its a/ b/ prefix, so the prefix is checked and
    // stripped only after the quotes come off — an unquoted side that does not
    // start with the expected prefix is not a header git produced.
    const oldQuoted = unquoteGitPath(body.slice(0, separator + 1))
    const newQuoted = unquoteGitPath(body.slice(separator + 2))
    if (!oldQuoted.startsWith('a/') || !newQuoted.startsWith('b/')) {
      return { unparsable: true }
    }
    const oldPath = oldQuoted.slice(2)
    const newPath = newQuoted.slice(2)
    if (!oldPath || !newPath) return { unparsable: true }
    return { names: [oldPath, newPath] }
  }
  const separator = body.lastIndexOf(' b/')
  if (!body.startsWith('a/') || separator <= 0) return undefined
  const oldPath = body.slice(2, separator)
  const newPath = body.slice(separator + 3)
  if (!oldPath || !newPath) return undefined
  return { names: [oldPath, newPath] }
}

/**
 * Decode one side of a git diff header path. A quoted value is git's
 * `quote_c_style` encoding: surrounding double quotes, backslash escapes for
 * `\\ \" \a \b \f \n \r \t \v`, and up to three octal digits per byte for
 * everything else (that is how a UTF-8 path appears under the default
 * `core.quotePath=true` — `café` as `caf\303\251`). Octal bytes accumulate and
 * decode as UTF-8 as a group, so a multi-byte sequence split across escapes
 * reassembles. Returns '' for a value that starts a quote but cannot be
 * decoded (unterminated, lone backslash, unknown escape, byte > 0xff): the
 * caller treats that as an unparsable header and fails closed rather than
 * checking the still-escaped text — the sensitive-name patterns match DECODED
 * paths, so an undecoded path is an unchecked path.
 */
function unquoteGitPath(value: string): string {
  if (!value.startsWith('"')) return value
  if (value.length < 2 || !value.endsWith('"')) return ''
  const inner = value.slice(1, -1)
  let out = ''
  const pendingBytes: number[] = []
  const flushBytes = () => {
    if (pendingBytes.length > 0) {
      out += Buffer.from(pendingBytes).toString('utf8')
      pendingBytes.length = 0
    }
  }
  let i = 0
  while (i < inner.length) {
    const ch = inner[i]
    if (ch !== '\\') {
      flushBytes()
      out += ch
      i += 1
      continue
    }
    const escaped = inner[i + 1]
    if (escaped === undefined) return ''
    if (escaped >= '0' && escaped <= '7') {
      let octal = ''
      let j = i + 1
      while (
        j < inner.length &&
        octal.length < 3 &&
        inner[j] >= '0' &&
        inner[j] <= '7'
      ) {
        octal += inner[j]
        j += 1
      }
      const byte = parseInt(octal, 8)
      if (Number.isNaN(byte) || byte > 0xff) return ''
      pendingBytes.push(byte)
      i = j
      continue
    }
    flushBytes()
    switch (escaped) {
      case '\\':
        out += '\\'
        break
      case '"':
        out += '"'
        break
      case 'a':
        out += '\x07'
        break
      case 'b':
        out += '\b'
        break
      case 'f':
        out += '\f'
        break
      case 'n':
        out += '\n'
        break
      case 'r':
        out += '\r'
        break
      case 't':
        out += '\t'
        break
      case 'v':
        out += '\v'
        break
      default:
        // git's quote_c_style emits only the escapes above; anything else
        // means this is not a header path git produced.
        return ''
    }
    i += 2
  }
  flushBytes()
  return out
}

/**
 * Test seam for the header parser: both quote forms and the fail-closed
 * unparsable verdict are pure functions of one line, so the quoted-path
 * behavior is pinnable without driving a real `git diff` per case.
 */
export function __parseStagedDiffHeaderForTest(line: string) {
  return parseStagedDiffHeader(line)
}

/**
 * Incremental reader for `git diff --cached -U0` that answers both safety
 * questions the commit preflight asks of the staged paths — which files are
 * staged, and whether the patch carries private-key/access-key material —
 * without buffering the patch. Both questions are answered per line, so a huge
 * diff costs one regex pass per line instead of a full string concatenation
 * plus a second full scan.
 *
 * RETAINED STATE IS BOUNDED, not just the scan window. Peak retention is one
 * scan window (pending + parkedText + parked Buffers) PLUS the staged-name
 * table, capped at GIT_SAFETY_MAX_STAGED_NAMES names with a truncation flag
 * rather than one entry per `diff --git` header. Combined with the bounded
 * `--check` head reader in `runGitForSafety`, the whole `Promise.all` preflight
 * holds a few tens of KB, so raising either constant is a visible review change
 * to a stated bound instead of an unbounded growth path.
 *
 * Scanning is DECOUPLED from the `data` handler. `enqueue` only parks a chunk;
 * the caller's awaited drain loop decodes and matches it in bounded slices, and
 * yields between slices. Up to GIT_SAFETY_OUTPUT_LIMIT of patch arrives through
 * back-to-back chunk callbacks on the same loop the TUI renders on, so scanning
 * inside that callback would put a whole multi-megabyte patch's CPU pass inside
 * render frames — the exact cost the asynchronous spawn was adopted to avoid.
 * Parked text is drained every slice, so what is held between ticks is one
 * slice plus whatever arrived during it, and the byte budget still bounds the
 * total.
 */
function createStagedDiffScanner(): StagedDiffScanner {
  const scanStats: StagedDiffScanStats = {
    slices: 0,
    maxSliceChars: 0,
    parkedBytes: 0,
    drainDecodedBytes: 0,
    retainedNames: 0,
  }
  // The ring's slot holds a DETACHED copy, never `scanStats` itself: this
  // scanner's scope owns the parked patch bytes, and the ring outlives it.
  let retainedStats = snapshotStats(scanStats)
  stagedDiffScannerStats.push(retainedStats)
  if (stagedDiffScannerStats.length > STAGED_DIFF_RETAINED_SCANNERS) {
    stagedDiffScannerStats.shift()
  }
  /**
   * Republishes this scanner's counters into its own ring slot.
   *
   * The slot is REPLACED with a fresh plain-object copy rather than mutated in
   * place, so a retained entry is always a detached snapshot: the object the
   * ring holds shares no reference with `scanStats`, and therefore cannot reach
   * `queued`, `parkedText` or `decoder`. `indexOf` finds the slot by the
   * identity of the copy this scanner published last, and answers -1 once
   * sixteen newer scanners have evicted it — at which point nothing this
   * scanner does can reach the ring at all.
   */
  const publishStats = (): void => {
    const slot = stagedDiffScannerStats.indexOf(retainedStats)
    if (slot === -1) return
    retainedStats = snapshotStats(scanStats)
    stagedDiffScannerStats[slot] = retainedStats
  }
  const names: string[] = []
  const seenNames = new Set<string>()
  let namesTruncated = false
  let sensitiveContent = false
  let headerDecodeFailed = false
  /** Decoded but not yet scanned: the trailing, still-growing line. */
  let pending = ''
  /**
   * Raw, UNDECODED chunks parked by `enqueue`. Decoding lives in the drain loop
   * below for two reasons: a decode inside the `data` callback would run the
   * whole patch's UTF-8 conversion in the render frame the async spawn exists to
   * keep clear, and a per-chunk `toString('utf8')` splits a code point whose
   * bytes straddle a chunk boundary into replacement characters, so line and
   * pattern matching would see corrupted text for those bytes.
   */
  const queued: Buffer[] = []
  /**
   * Stateful UTF-8 decoder for the parked chunks: it holds the trailing partial
   * sequence across chunk boundaries, which is what reassembles a split code
   * point instead of emitting U+FFFD for it.
   */
  const decoder = new StringDecoder('utf8')
  /** Decoded text from the head chunk that did not fit a tick's cap. */
  let parkedText = ''
  let wakeUp: (() => void) | undefined

  /** Decodes one parked chunk, inside the drain loop and nowhere else. */
  const decodeParkedChunk = (chunk: Buffer): string => {
    scanStats.drainDecodedBytes += chunk.byteLength
    return decoder.write(chunk)
  }

  const wake = (): void => {
    const resolve = wakeUp
    wakeUp = undefined
    resolve?.()
  }

  const scanLine = (line: string) => {
    const header = parseStagedDiffHeader(line)
    if (header) {
      if ('unparsable' in header) {
        // A quoted header git produced but this scanner cannot decode. The
        // sensitive-name patterns match DECODED paths, so silently dropping
        // the header would leave the path it names unchecked — the caller
        // fails closed on this flag instead.
        headerDecodeFailed = true
        return
      }
      // Both sides of a header: a rename stages the old and the new name, and
      // testing only one could miss a sensitive rename target.
      for (const name of header.names) {
        if (seenNames.has(name)) continue
        if (names.length >= GIT_SAFETY_MAX_STAGED_NAMES) {
          // The table is a bounded PREFIX of the staged set. Further headers are
          // counted as truncation and dropped: the caller only calls `find`, so
          // retaining the tail would cost O(staged paths) to answer nothing new.
          namesTruncated = true
          continue
        }
        seenNames.add(name)
        names.push(name)
      }
      scanStats.retainedNames = names.length
    }
    if (SENSITIVE_STAGED_CONTENT.test(line)) sensitiveContent = true
  }

  const hasWork = (): boolean =>
    queued.length > 0 || parkedText.length > 0 || pending.includes('\n')

  /**
   * Appends parked text to `pending` until it holds `cap` characters. A chunk
   * that would overshoot is split instead of appended whole, so a single tick
   * never pulls an unbounded stretch of a multi-megabyte patch into the scan's
   * indexing path: the bound is on the WORK a tick does, not just on how much
   * memory the accumulator retains.
   */
  const appendQueued = (cap: number): void => {
    while (queued.length > 0 || parkedText.length > 0) {
      // Decode the next parked chunk only once the text already decoded has
      // been handed over, so no chunk is decoded twice and the decode cost of a
      // tick is bounded by the text that tick actually consumes.
      if (parkedText.length === 0) {
        parkedText = decodeParkedChunk(queued.shift()!)
        // A chunk that ends mid-code-point decodes to nothing yet; the decoder
        // holds those bytes for the next chunk, so loop instead of stalling.
        continue
      }
      const room = cap - pending.length
      if (room <= 0) return
      if (parkedText.length <= room) {
        pending += parkedText
        parkedText = ''
      } else {
        pending += parkedText.slice(0, room)
        parkedText = parkedText.slice(room)
        return
      }
    }
  }

  /**
   * Scans at most `maxChars` characters of `pending` and returns how many it
   * consumed. Zero means no complete line is available yet.
   */
  const scanAvailable = (maxChars: number): number => {
    let offset = 0
    while (offset < maxChars) {
      const newline = pending.indexOf('\n', offset)
      if (newline === -1) break
      scanLine(pending.slice(offset, newline))
      offset = newline + 1
    }
    if (offset > 0) {
      pending = pending.slice(offset)
      return offset
    }
    if (pending.length < GIT_SAFETY_SCAN_WINDOW_CHARS) return 0
    // A single line longer than the window (a minified bundle, a generated
    // lockfile): scan what is buffered and keep only a short overlap so the
    // accumulator stays bounded instead of buffering the whole line. The whole
    // buffered stretch is reported as consumed, which keeps the slice-size
    // counter describing the real per-tick work.
    const scanned = pending.length
    scanLine(pending)
    pending = pending.slice(-GIT_SAFETY_SCAN_OVERLAP_CHARS)
    return scanned
  }

  return {
    enqueue: (chunk) => {
      // Park only. The decode happens in `appendQueued`/`drainAll`, so this data
      // callback costs one push regardless of the patch's size.
      scanStats.parkedBytes += chunk.byteLength
      queued.push(chunk)
      wake()
    },
    drainSlice: (maxChars) => {
      if (!hasWork()) return false
      scanStats.slices += 1
      let scanned = 0
      while (scanned < maxChars) {
        appendQueued(maxChars - scanned)
        const progressed = scanAvailable(maxChars - scanned)
        if (progressed === 0) break
        scanned += progressed
      }
      if (scanned > scanStats.maxSliceChars) {
        scanStats.maxSliceChars = scanned
      }
      publishStats()
      return hasWork()
    },
    waitForWork: () => {
      if (queued.length > 0 || parkedText.length > 0) {
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => {
        wakeUp = resolve
      })
    },
    wake,
    drainAll: () => {
      pending += parkedText
      parkedText = ''
      while (queued.length > 0) {
        pending += decodeParkedChunk(queued.shift()!)
      }
      // Flush the decoder's held partial sequence, exactly as a stream consumer
      // does at end: a patch that ends mid-code-point still scans its final
      // bytes instead of dropping them.
      pending += decoder.end()
      while (scanAvailable(Number.MAX_SAFE_INTEGER) > 0) {
        // Exhaust the complete lines; the flush is bounded by what is left.
      }
      // SETTLE. Everything the diff produced has now been scanned, so none of
      // the parked bytes will be read again: drop them here so the scanner's
      // scope stops holding up to GIT_SAFETY_OUTPUT_LIMIT of patch once the
      // preflight that owned it has finished. The ring entry this scanner
      // published is a detached copy of the counters only, so releasing the
      // bytes changes nothing the seam reports.
      queued.length = 0
      parkedText = ''
      pending = ''
      publishStats()
    },
    result: () => {
      // The trailing line arrives without its newline; scan it so the last
      // staged path is never dropped.
      if (pending.length > 0) scanLine(pending)
      pending = ''
      return { names, namesTruncated, sensitiveContent, headerDecodeFailed }
    },
    stats: () => scanStats,
  }
}

/**
 * Drives the scanner while the diff spawn is still running: one bounded slice
 * per tick, with an `await setImmediate` between slices so a multi-megabyte
 * staged patch can never monopolise a render frame. When nothing is parked the
 * loop parks itself on `waitForWork` instead of spinning, so the preflight does
 * not burn a core for the duration of the git run.
 */
async function scanWhilePending(
  pending: Promise<GitSafetyResult>,
  scanner: StagedDiffScanner,
): Promise<GitSafetyResult> {
  // Boxed so the flag is not narrowed across the awaits below.
  const state = { settled: false }
  // The spawn promise never rejects (it resolves a non-zero exit code instead),
  // but observing both outlets keeps a driver-side rejection from surfacing as
  // an unhandled one: the `await` below re-raises whatever it carried.
  const markSettled = (): void => {
    state.settled = true
    scanner.wake()
  }
  void pending.then(markSettled, markSettled)
  while (!state.settled) {
    if (scanner.drainSlice(GIT_SAFETY_SCAN_SLICE_CHARS)) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    } else {
      await scanner.waitForWork()
    }
  }
  const result = await pending
  // Everything the diff produced has arrived; flushing here is bounded by what
  // the last tick left parked.
  scanner.drainAll()
  return result
}

/**
 * Async git spawn for the staged-commit safety preflight. Deliberately local
 * rather than reusing git-status's `runGit`: that helper spawns with the
 * inherited agent environment (no credential scrub) and accumulates output
 * without any bound, while these checks must stay on the scrubbed child env and
 * must refuse to buffer more than GIT_SAFETY_OUTPUT_LIMIT. Spawning
 * asynchronously keeps the CLI TUI's event loop responsive while the preflight
 * runs on the same loop as rendering.
 *
 * `observeStdout` replaces stdout accumulation: the caller sees each chunk and
 * the spawn retains nothing, which is how the -U0 diff is inspected without the
 * patch ever existing as one string. Without an observer the spawn still streams:
 * stdout is decoded through a `StringDecoder` into a HEAD capped at
 * GIT_SAFETY_WHITESPACE_HEAD_BYTES, the scan stops for good at the first
 * WHITESPACE_DIAGNOSTIC match, and stderr keeps a bounded line-boundary tail — so
 * the `--check` thread of a huge staged diff holds a few KB, not the multi-megabyte
 * diagnostic list it emits. Either way the over-budget rule is a BYTE budget: it
 * bounds how much output this check will accept, and a decoded string's code-unit
 * count is not that quantity.
 */
function runGitForSafety(
  args: string[],
  cwd: string,
  observeStdout?: (chunk: Buffer) => void,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<GitSafetyResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let overflowed = false
    /**
     * Set once the retained head already holds a whitespace diagnostic. Nothing
     * after the first match can change the verdict, so the tail of a long
     * diagnostic list is never decoded.
     */
    let stdoutComplete = false
    /** Stateful decoder, so a code point split across chunks is not corrupted. */
    const stdoutDecoder = new StringDecoder('utf8')
    const child = spawn('git', args, {
      cwd,
      // Route the preflight git spawn through the credential scrub so the
      // safety check never runs with the agent process's provider secrets.
      env: {
        ...getChildProcessEnv(),
        // These are READ-ONLY inspections, and the two remaining preflight
        // diffs run concurrently against the same index. git refreshes the
        // index opportunistically and may take index.lock to do it; two
        // concurrent refreshes can then contend and surface as a failed
        // whitespace check or 'unable to inspect staged diff content', which
        // this path treats as fail-closed and would block a legitimate
        // commit. GIT_OPTIONAL_LOCKS=0 tells git to skip that optional
        // refresh, so the parallel pair cannot contend with itself while the
        // diff output the checks read stays identical.
        GIT_OPTIONAL_LOCKS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const settle = (exitCode: number) => {
      if (settled) return
      settled = true
      clearTimeout(spawnTimer)
      options?.signal?.removeEventListener('abort', onAbort)
      // Whatever the decoder still held is part of the head: a stream that ends
      // mid-code-point must not lose the diagnostic that straddles that boundary.
      stdout += stdoutDecoder.end()
      if (stdout.length > GIT_SAFETY_WHITESPACE_HEAD_BYTES) {
        stdout = stdout.slice(0, GIT_SAFETY_WHITESPACE_HEAD_BYTES)
      }
      // An over-budget stream mirrors spawnSync's maxBuffer refusal: the
      // check fails closed instead of inspecting a truncated diff. A timeout
      // or caller abort settles the same way: a stalled or killed `git diff`
      // produced an untrustworthy partial diff, and the preflight must not
      // hang the tool call waiting for it.
      resolve({ exitCode: overflowed || aborted ? -1 : exitCode, stdout, stderr })
    }
    /**
     * A local `git diff --cached` is fast; one that has not produced a result
     * within this bound is stuck (hung index, NFS stall, pathological repo) and
     * is killed so the preflight fails closed instead of hanging the tool call
     * forever — the tool's own timeout does not bound a preflight the caller
     * never sees.
     */
    const spawnTimer = setTimeout(
      () => {
        aborted = true
        child.kill('SIGKILL')
        settle(-1)
      },
      options?.timeoutMs ?? GIT_SAFETY_SPAWN_TIMEOUT_MS,
    )
    let aborted = false
    const onAbort = (): void => {
      aborted = true
      child.kill('SIGKILL')
      settle(-1)
    }
    if (options?.signal?.aborted) {
      onAbort()
      return
    }
    options?.signal?.addEventListener('abort', onAbort)
    const withinBudget = (bytes: number): boolean => {
      if (overflowed) return false
      if (bytes <= GIT_SAFETY_OUTPUT_LIMIT) return true
      overflowed = true
      child.kill('SIGKILL')
      return false
    }
    /** Keeps `stderr` a bounded TAIL, cut on a line boundary when possible. */
    const appendStderrTail = (text: string): void => {
      if (!text) return
      const combined = stderr + text
      if (combined.length <= GIT_SAFETY_WHITESPACE_HEAD_BYTES) {
        stderr = combined
        return
      }
      const tail = combined.slice(-GIT_SAFETY_WHITESPACE_HEAD_BYTES)
      const firstLineBreak = tail.indexOf('\n')
      stderr =
        firstLineBreak === -1 ? tail : tail.slice(firstLineBreak + 1)
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength
      if (!withinBudget(stdoutBytes)) return
      if (observeStdout) {
        observeStdout(chunk)
        return
      }
      if (stdoutComplete) return
      // Head-only retention: the first diagnostic decides the verdict and the
      // remainder of the list is never retained or decoded.
      stdout += stdoutDecoder.write(chunk)
      if (WHITESPACE_DIAGNOSTIC.test(stdout)) {
        stdoutComplete = true
        const head = stdout.slice(0, GIT_SAFETY_WHITESPACE_HEAD_BYTES)
        const lastLineBreak = head.lastIndexOf('\n')
        stdout = lastLineBreak === -1 ? head : head.slice(0, lastLineBreak + 1)
      } else if (stdout.length > GIT_SAFETY_WHITESPACE_HEAD_BYTES) {
        stdout = stdout.slice(0, GIT_SAFETY_WHITESPACE_HEAD_BYTES)
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength
      if (!withinBudget(stderrBytes)) return
      appendStderrTail(chunk.toString('utf8'))
    })
    child.on('error', (error) => {
      appendStderrTail(error.message)
      settle(-1)
    })
    child.on('close', (code) => settle(code ?? -1))
  })
}

/**
 * Outcome of the staged-commit safety preflight.
 *
 * `blocked` is a POLICY verdict: the staged diff was inspected and it violates
 * the safety policy, so the commit must be refused. `inspectionFailed` is an
 * INABILITY verdict: the diff could not be read at all (spawn error, non-zero
 * git exit, over-budget patch), so nothing about the commit was decided. The two
 * are kept distinct because callers must treat them differently — a policy
 * verdict is final, while an inspection failure is transient (an index lock held
 * by another process, a spawn hiccup) and worth retrying. Undefined means the
 * preflight ran and cleared the commit.
 */
type StagedCommitSafetyResult =
  | { kind: 'blocked'; detail: string }
  | { kind: 'inspectionFailed'; detail: string }
  | undefined

async function validateStagedCommit(
  cwd: string,
  signal?: AbortSignal,
): Promise<StagedCommitSafetyResult> {
  // Two independent reads of the same index: the whitespace check and ONE -U0
  // diff that supplies both the staged names (from its `diff --git` headers)
  // and the content scan. Every `git diff --cached` recomputes the whole staged
  // diff from the index, so a separate `--name-only` run was redundant work for
  // a file list the -U0 headers already carry. Starting the two that remain
  // together keeps the preflight at one diff-computation latency; the verdicts
  // are still EVALUATED in the original order below, so the fail-closed
  // precedence is unchanged.
  const scanner = createStagedDiffScanner()
  const [whitespace, diff] = await Promise.all([
    runGitForSafety(['diff', '--cached', '--check'], cwd, undefined, { signal }),
    scanWhilePending(
      runGitForSafety(
        ['diff', '--cached', '-U0'],
        cwd,
        (chunk) => scanner.enqueue(chunk),
        { signal },
      ),
      scanner,
    ),
  ])
  if (whitespace.exitCode !== 0) {
    const detail = (whitespace.stdout || whitespace.stderr).trim()
    // A `--check` failure that produced a whitespace DIAGNOSTIC is a real
    // violation; anything else means git itself could not run the check (spawn
    // error, index contention, not a repository, over-budget output), which is
    // an inspection failure. Presence of output is not enough to distinguish
    // them: git also writes fatal errors to stderr, so `not a git repository`
    // would otherwise be reported to the caller as a whitespace violation — a
    // policy denial for a commit that was never inspected.
    if (!WHITESPACE_DIAGNOSTIC.test(detail)) {
      return {
        kind: 'inspectionFailed',
        detail: detail
          ? `git diff --cached --check failed to report a result: ${detail}`
          : 'git diff --cached --check failed to report a result',
      }
    }
    return { kind: 'blocked', detail: `staged diff failed whitespace checks: ${detail}` }
  }

  // Read the scan only once the spawn settled, so it holds every name header the
  // diff produced (up to the bounded table). A failed/over-budget diff carries no
  // trustworthy file list or content verdict, so it fails closed before either is
  // consulted — but it is reported as an INSPECTION FAILURE, not as a policy
  // denial: the commit was never examined, so nothing about it was forbidden.
  const staged = scanner.result()
  if (diff.exitCode !== 0) {
    return {
      kind: 'inspectionFailed',
      detail: 'unable to inspect staged diff content',
    }
  }
  const sensitiveName = staged.names.find((file) =>
    SENSITIVE_STAGED_PATH.test(file),
  )
  // Checked before the truncation flag so a sensitive path that IS in the
  // retained prefix still returns the more specific policy verdict.
  if (sensitiveName) {
    return { kind: 'blocked', detail: `sensitive file is staged: ${sensitiveName}` }
  }
  if (staged.sensitiveContent) {
    return {
      kind: 'blocked',
      detail: 'private-key or access-key material appears in the staged diff',
    }
  }
  // A diff that named more paths than the bounded table holds was not fully
  // inspected, so it must not be cleared as if every staged path had been
  // checked. This is an INABILITY verdict like an over-budget stream, not a
  // policy denial.
  if (staged.namesTruncated) {
    return {
      kind: 'inspectionFailed',
      detail: 'staged diff names too many paths to inspect',
    }
  }
  // A quoted header this scanner could not decode names a path that was never
  // checked — same INABILITY class as truncation, for the same reason.
  if (staged.headerDecodeFailed) {
    return {
      kind: 'inspectionFailed',
      detail: 'staged diff contains a path header that could not be decoded',
    }
  }
  return undefined
}

// Common locations where Git Bash might be installed on Windows
const GIT_BASH_COMMON_PATHS = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  'C:\\Git\\bin\\bash.exe',
]

// WSL bash paths that are often unreliable (VM may not be running, quote escaping issues)
// These are checked last as a fallback only
const WSL_BASH_PATH_PATTERNS = ['system32', 'windowsapps']

/**
 * Find bash executable on Windows.
 * Priority:
 * 1. OPENBUFF_GIT_BASH_PATH environment variable (user override)
 * 2. CODEBUFF_GIT_BASH_PATH legacy environment variable
 * 3. Common Git Bash installation locations (most reliable)
 * 4. Non-WSL bash in PATH (e.g., Git Bash added to PATH)
 * 5. WSL bash in PATH (last resort - System32, WindowsApps)
 *
 * WSL bash is deprioritized because it can fail with cryptic errors when:
 * - The WSL VM is not running
 * - Quote/argument escaping issues between Windows and Linux
 * - UTF-16 encoding mismatches
 */
export function findWindowsBash(env: NodeJS.ProcessEnv): string | null {
  // Check for user-specified path via environment variable
  const customPath = env.OPENBUFF_GIT_BASH_PATH ?? env.CODEBUFF_GIT_BASH_PATH
  if (customPath && fs.existsSync(customPath)) {
    return customPath
  }

  // Check common Git Bash installation locations first (most reliable)
  for (const commonPath of GIT_BASH_COMMON_PATHS) {
    if (fs.existsSync(commonPath)) {
      return commonPath
    }
  }

  // Fall back to bash.exe in PATH, but skip WSL paths initially
  const pathEnv = env.PATH || env.Path || ''
  const pathDirs = pathEnv.split(path.delimiter)
  const wslFallbackPaths: string[] = []

  for (const dir of pathDirs) {
    const dirLower = dir.toLowerCase()
    const isWslPath = WSL_BASH_PATH_PATTERNS.some((pattern) =>
      dirLower.includes(pattern),
    )

    const bashPath = path.join(dir, 'bash.exe')
    if (fs.existsSync(bashPath)) {
      if (isWslPath) {
        // Save WSL paths for last resort
        wslFallbackPaths.push(bashPath)
      } else {
        // Non-WSL bash in PATH (e.g., Git Bash added to PATH)
        return bashPath
      }
    }

    // Also check for just 'bash' (without .exe)
    const bashPathNoExt = path.join(dir, 'bash')
    if (fs.existsSync(bashPathNoExt)) {
      if (isWslPath) {
        wslFallbackPaths.push(bashPathNoExt)
      } else {
        return bashPathNoExt
      }
    }
  }

  // Last resort: use WSL bash if nothing else is available
  // WSL can be unreliable (VM not running, quote escaping issues, UTF-16 encoding)
  if (wslFallbackPaths.length > 0) {
    return wslFallbackPaths[0]
  }

  return null
}

/**
 * Create an error message for Windows users when bash is not available.
 */
function createWindowsBashNotFoundError(): Error {
  return new Error(
    `Bash is required but was not found on this Windows system.

To fix this, you have several options:

1. Install Git for Windows (includes bash.exe):
   Download from: https://git-scm.com/download/win

2. Use WSL (Windows Subsystem for Linux):
   Run in PowerShell (Admin): wsl --install
   Then run Openbuff inside WSL.

3. Set a custom bash path:
   Set the OPENBUFF_GIT_BASH_PATH environment variable to your bash.exe location.
   Example: set OPENBUFF_GIT_BASH_PATH=C:\\path\\to\\bash.exe`,
  )
}

/**
 * Best-effort project-relative dirty paths via `git status --porcelain -uall`.
 * Returns null when git is unavailable / not a repo so callers can omit
 * `touchedPaths` without failing the command.
 */
export async function listDirtyPaths(
  projectRoot: string,
  signal?: AbortSignal,
): Promise<Set<string> | null> {
  try {
    const result = await runGit(
      ['status', '--porcelain', '-uall'],
      projectRoot,
      signal,
    )
    if (result.exitCode !== 0) return null
    const paths = new Set<string>()
    for (const line of result.stdout.split('\n')) {
      if (line.trim() === '') continue
      const raw = line.slice(3).split(' -> ').at(-1)?.trim() ?? ''
      const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '').trim()
      if (normalized.length > 0) paths.add(normalized)
    }
    return paths
  } catch {
    return null
  }
}

export function dirtyDelta(before: Set<string>, after: Set<string>): string[] {
  const added: string[] = []
  for (const path of after) {
    if (!before.has(path)) added.push(path)
  }
  return added.sort()
}

export function withTouchedPaths<T extends Record<string, unknown>>(
  value: T,
  paths: string[],
): T {
  if (paths.length === 0) return value
  return { ...value, touchedPaths: paths }
}

let commandOutputDirEnsured: string | undefined

/**
 * Best-effort persistence of the FULL accumulated SYNC command output when the
 * inline result had to be truncated, mirroring the `persistOversizeArtifact`
 * pattern in packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:
 * content-addressed by the sha256 of the serialized payload, so the same
 * content always maps to the same scratch path (idempotent overwrite).
 * `tmpdir()` is resolved at call time so TMPDIR overrides in tests are
 * respected. Returns the artifact path, or undefined on ANY error — the
 * pointer is a pure enhancement and must never fail the command result.
 * Owner-only 0o600 permissions regardless of the process umask: these files
 * hold untruncated command output in a shared tmp directory.
 *
 * NOTE: unlike the spawn-agent artifact path, no TTL sweep is added here —
 * OS tmp cleanup suffices for this first slice.
 */
function persistFullCommandOutput(serialized: string): string | undefined {
  try {
    const dir = path.join(os.tmpdir(), 'openbuff-command-output')
    if (commandOutputDirEnsured !== dir) {
      // 0o700 regardless of umask: the directory holds untruncated command
      // output, so it must never be group/world-readable on shared hosts.
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      commandOutputDirEnsured = dir
    }
    const artifactPath = path.join(
      dir,
      `${createHash('sha256').update(serialized).digest('hex')}.json`,
    )
    fs.writeFileSync(artifactPath, serialized, { mode: 0o600 })
    return artifactPath
  } catch {
    return undefined
  }
}

export async function runTerminalCommand({
  command,
  process_type,
  detach = false,
  mode = 'assistant',
  permission_profile = 'workspace-write',
  allowed_paths,
  cwd,
  projectRoot,
  timeout_seconds,
  env,
  signal,
  owner,
  authorizeHighImpactAction,
  preApprovedAction,
}: {
  command: string
  process_type: 'SYNC' | 'BACKGROUND'
  detach?: boolean
  mode?: 'assistant' | 'user'
  permission_profile?: TerminalPermissionProfile
  allowed_paths?: string[]
  cwd: string
  projectRoot?: string
  timeout_seconds: number
  env?: Record<string, string | undefined>
  /** Optional abort signal. Owned background jobs are cancelled unless
   * `detach` was explicitly requested. */
  signal?: AbortSignal
  owner?: {
    clientSessionId: string
    rootRunId: string
    parentRunId: string
    parentAgentId: string
  }
  authorizeHighImpactAction?: (action: ClassifiedHarnessAction) => Promise<
    | { allowed: true; approvalReceiptId?: string }
    | {
        allowed: false
        reason: string
        approvalRequired: boolean
      }
  >
  /**
   * One-shot pre-approved harness action carried on the internal
   * post-approval rerun. When the freshly classified high-impact action
   * matches it (same action+target), the rerun consumes it instead of
   * requesting approval again, so the terminal permission profile is still
   * enforced (unlike the old mode:'user' rerun which bypassed the whole
   * policy).
   */
  preApprovedAction?: {
    action: string
    target: string
    commandHash: string
    approvalReceiptId?: string
  }
}): Promise<CodebuffToolOutput<'run_terminal_command'>> {
  // The contract for `cwd` is "project root or a subdirectory of it". A
  // caller-supplied absolute path like `/etc` or a traversal like
  // `../../outside` must be rejected before we spawn a child process so the
  // tool cannot be used to read or mutate state outside the project.
  // The shared helper enforces lexical + realpath/symlink containment.
  const resolvedCwd = resolveFilePathForOperation(
    projectRoot ?? process.cwd(),
    cwd,
  )
  // The helper also honors the openbuff-owned OS temp namespace exception,
  // which exists so path-taking tools can READ openbuff's own artifacts — not
  // so a child process can be hosted there. Policy evaluation receives the
  // in-project `containedCwd` so relative `..` tokens resolve from the real
  // working directory; an owned-temp cwd would still let a policy-clean
  // relative token land in a world-writable directory. Require an in-project
  // result: the resolver's `scope` discriminator marks that exception
  // explicitly, so an owned-temp path is refused without also rejecting a
  // project root that legitimately lives under the temp dir.
  if (resolvedCwd === null || resolvedCwd.scope === 'owned-temp') {
    return Promise.resolve([
      {
        type: 'json',
        value: {
          command,
          errorMessage: `Invalid cwd: Path '${cwd}' is outside the project directory.`,
        },
      },
    ])
  }
  const containedCwd = resolvedCwd.operationPath

  const policy = evaluateTerminalCommandPolicy({
    command,
    mode,
    permissionProfile: permission_profile,
    projectRoot: projectRoot ?? process.cwd(),
    allowedPaths: allowed_paths,
    cwd: containedCwd,
  })
  if (!policy.allowed) {
    return Promise.resolve([
      {
        type: 'json',
        value: {
          command,
          errorMessage: `Command denied by ${permission_profile} terminal policy: ${policy.reason}`,
          permissionDenied: true,
          permissionProfile: permission_profile,
        },
      },
    ])
  }

  const highImpactAction =
    mode === 'assistant' ? classifyTerminalHarnessAction(command) : undefined
  // A matched one-shot pre-approval means this call is the post-approval
  // rerun for the same action+target: the profile policy already ran above,
  // so consume the pre-approval and fall through to execution instead of
  // asking for approval again (which would loop approve->rerun->approve).
  const matchedPreApproval =
    highImpactAction &&
    preApprovedAction &&
    preApprovedAction.action === highImpactAction.action &&
    preApprovedAction.target === highImpactAction.target &&
    preApprovedAction.commandHash === highImpactAction.commandHash
      ? preApprovedAction
      : undefined
  // Harness metadata threaded onto the eventual output on the matched
  // pre-approval path so callers see identical metadata whether the command
  // took one hop (old user mode) or two (assistant approve -> assistant rerun).
  const pendingHarnessMetadata =
    highImpactAction && matchedPreApproval
      ? {
          ...(matchedPreApproval.approvalReceiptId
            ? { approvalReceiptId: matchedPreApproval.approvalReceiptId }
            : {}),
          harnessAction: highImpactAction.action,
          harnessTarget: highImpactAction.target,
        }
      : undefined
  const finalizeHarnessMetadata = (
    result: Promise<CodebuffToolOutput<'run_terminal_command'>>,
  ): Promise<CodebuffToolOutput<'run_terminal_command'>> =>
    pendingHarnessMetadata
      ? result.then((output) => {
          const part = output[0]
          return [
            {
              ...part,
              value: { ...part.value, ...pendingHarnessMetadata },
            },
          ]
        })
      : result
  if (highImpactAction && !matchedPreApproval) {
    if (!authorizeHighImpactAction) {
      return Promise.resolve([
        {
          type: 'json',
          value: {
            command,
            errorMessage: `Command denied by harness approval policy: Action '${highImpactAction.action}' requires a snapshot-scoped user approval for '${highImpactAction.target}'.`,
            permissionDenied: true,
            approvalRequired: true,
            harnessAction: highImpactAction.action,
            harnessTarget: highImpactAction.target,
            permissionProfile: permission_profile,
          },
        },
      ])
    }
    return authorizeHighImpactAction(highImpactAction).then((decision) => {
      if (!decision.allowed) {
        return [
          {
            type: 'json' as const,
            value: {
              command,
              errorMessage: `Command denied by harness approval policy: ${decision.reason}`,
              permissionDenied: true,
              approvalRequired: decision.approvalRequired,
              harnessAction: highImpactAction.action,
              harnessTarget: highImpactAction.target,
              permissionProfile: permission_profile,
            },
          },
        ]
      }
      // Approved: re-run with mode unchanged (still 'assistant') and the
      // permission profile unchanged so the profile policy is STILL enforced
      // on the rerun. A one-shot preApprovedAction lets that rerun skip only
      // the harness re-authorization for this same action+target, never the
      // profile — a command that escapes its profile stays denied.
      return runTerminalCommand({
        command,
        process_type,
        detach,
        mode,
        permission_profile,
        allowed_paths,
        cwd,
        projectRoot,
        timeout_seconds,
        env,
        signal,
        owner,
        authorizeHighImpactAction,
        preApprovedAction: {
          action: highImpactAction.action,
          target: highImpactAction.target,
          commandHash: highImpactAction.commandHash,
          ...(decision.approvalReceiptId
            ? { approvalReceiptId: decision.approvalReceiptId }
            : {}),
        },
      }).then((output) => {
        const part = output[0]
        return [
          {
            ...part,
            value: {
              ...part.value,
              ...(decision.approvalReceiptId
                ? { approvalReceiptId: decision.approvalReceiptId }
                : {}),
              harnessAction: highImpactAction.action,
              harnessTarget: highImpactAction.target,
            },
          },
        ]
      })
    })
  }

  if (
    mode === 'assistant' &&
    permission_profile === 'git-commit' &&
    /^\s*git\s+commit\b/i.test(command)
  ) {
    const safety = await validateStagedCommit(containedCwd, signal)
    if (safety?.kind === 'blocked') {
      return finalizeHarnessMetadata(
        Promise.resolve([
          {
            type: 'json',
            value: {
              command,
              errorMessage: `Commit blocked by staged-diff safety policy: ${safety.detail}`,
              permissionDenied: true,
              permissionProfile: permission_profile,
            },
          },
        ]),
      )
    }
    if (safety?.kind === 'inspectionFailed') {
      // Deliberately NOT `permissionDenied`: the check could not run, so the
      // commit was never judged. Reporting this as a denial would tell a caller
      // that retries on transient failure not to retry, and would surface an
      // infrastructure failure to the user as an authorization decision.
      return finalizeHarnessMetadata(
        Promise.resolve([
          {
            type: 'json',
            value: {
              command,
              errorMessage: `Commit safety preflight could not inspect the staged diff: ${safety.detail}`,
              safetyPreflightFailed: true,
              permissionProfile: permission_profile,
            },
          },
        ]),
      )
    }
  }

  if (process_type === 'BACKGROUND') {
    // Capture pre-start dirty set (best-effort) so check_job can credit a
    // one-shot settlement dirty delta — same SYNC semantics, deferred to the
    // first settled observation. Soft-fail omits snapshot without failing start.
    return finalizeHarnessMetadata((async () => {
      if (signal?.aborted) {
        const reason = signal.reason
        throw reason instanceof Error
          ? reason
          : Object.assign(new Error('Aborted'), { name: 'AbortError' })
      }
      const isWindows = os.platform() === 'win32'
      // Merge caller overrides FIRST, then scrub the merged object so a
      // caller-supplied env cannot re-inject credential-named keys.
      const processEnv = scrubChildProcessEnv({
        ...getChildProcessEnv(),
        ...(env ?? {}),
      })

      let shell: string
      let shellArgs: string[]
      if (isWindows) {
        const bashPath = findWindowsBash(processEnv)
        if (!bashPath) {
          throw createWindowsBashNotFoundError()
        }
        shell = bashPath
        shellArgs = ['-c']
      } else {
        shell = 'bash'
        shellArgs = ['-c']
      }

      const gitRoot = projectRoot ?? containedCwd
      const dirtyBefore = await listDirtyPaths(gitRoot, signal)
      // The await above swallows aborts: listDirtyPaths resolves null on any
      // rejection, including this signal's own abort reason. Re-check so an
      // aborted run never spawns the job it would no longer own.
      throwIfAborted(signal)

      const job = startBackgroundJob({
        command,
        shell,
        shellArgs,
        cwd: containedCwd,
        env: processEnv,
        owner,
        projectRoot: gitRoot,
        dirtyBeforePaths: dirtyBefore ? [...dirtyBefore] : undefined,
      })

      if (signal && !detach) {
        const onAbort = () => {
          killBackgroundJob(job.jobId, 'SIGTERM')
        }
        const clearAbortListener = () =>
          signal.removeEventListener('abort', onAbort)
        // Mirror the SYNC pre-spawn wiring: an already-aborted signal never
        // fires 'abort' events, so a listener registered now would silently
        // never run — kill the fresh job directly instead.
        if (signal.aborted) {
          killBackgroundJob(job.jobId, 'SIGTERM')
        } else {
          signal.addEventListener('abort', onAbort, { once: true })
        }
        job.child.once('exit', clearAbortListener)
        job.child.once('error', clearAbortListener)
      }

      // Start result is jobId-only; never credit touchedPaths while running.
      return [
        {
          type: 'json' as const,
          value: {
            command,
            processId: job.child.pid ?? -1,
            backgroundProcessStatus: 'running' as const,
            detached: detach,
            jobId: job.jobId,
            logFile: job.logFile,
            startingCwd: containedCwd,
          },
        },
      ]
    })())
  }

  // SYNC: capture pre/post dirty paths against projectRoot so cwd subdirectory
  // commands still attribute project-relative paths. Soft-fail omits touchedPaths.
  return finalizeHarnessMetadata((async () => {
    const gitRoot = projectRoot ?? containedCwd
    const dirtyBefore = await listDirtyPaths(gitRoot, signal)

    const commandResult = await new Promise<
      CodebuffToolOutput<'run_terminal_command'>
    >((resolve, reject) => {
      const isWindows = os.platform() === 'win32'
      // Merge caller overrides FIRST, then scrub the merged object so a
      // caller-supplied env cannot re-inject credential-named keys.
      const processEnv = scrubChildProcessEnv({
        ...getChildProcessEnv(),
        ...(env ?? {}),
      })

      let shell: string
      let shellArgs: string[]

      if (isWindows) {
        const bashPath = findWindowsBash(processEnv)
        if (!bashPath) {
          reject(createWindowsBashNotFoundError())
          return
        }
        shell = bashPath
        shellArgs = ['-c']
      } else {
        shell = 'bash'
        shellArgs = ['-c']
      }

      // Use the already-resolved, project-contained cwd from the entry guard.
      // Local name differs from the outer `resolvedCwd` (the PATH RESOLVER
      // RESULT object) so the two are not confused: this is the cwd STRING
      // the child process spawns in.
      const spawnCwd = containedCwd

      const childProcess = spawn(shell, [...shellArgs, command], {
        cwd: spawnCwd,
        env: processEnv,
        stdio: 'pipe',
        detached: !isWindows,
      })

      // These mutable bookkeeping fields are read by `onAbort`, the timeout
      // callback, and the close/error handlers below. Declare them BEFORE
      // wiring the abort listener so `onAbort` never references a binding
      // that is still in the temporal dead zone (the JS engine hoists `let`
      // but throws on access until the declaration line runs).
      let timer: NodeJS.Timeout | null = null
      let settled = false
      let terminationReason: 'abort' | 'timeout' | null = null
      let stdout = ''
      let stderr = ''

      // Honor an external AbortSignal: SIGTERM the child on abort, with a
      // SIGKILL fallback if it doesn't exit promptly. The promise rejects
      // with the signal's reason (or a generic `AbortError`). Only applies
      // to SYNC runs — background jobs keep running and can be cleaned up
      // via `kill_job` against the returned `jobId`.
      let abortKillTimer: NodeJS.Timeout | null = null
      const requestTermination = (reason: 'abort' | 'timeout') => {
        if (settled || terminationReason) return
        terminationReason = reason
        const success = terminateProcessTree(childProcess, 'SIGTERM')
        if (!success) {
          terminateProcessTree(childProcess, 'SIGKILL')
          return
        }
        abortKillTimer = setTimeout(() => {
          if (isProcessTreeAlive(childProcess)) {
            terminateProcessTree(childProcess, 'SIGKILL')
          }
        }, 5_000)
        abortKillTimer.unref?.()
      }
      const onAbort = () => {
        requestTermination('abort')
        if (timer) clearTimeout(timer)
      }
      const signalAlreadyAborted = signal?.aborted ?? false
      if (signal && !signalAlreadyAborted) {
        signal.addEventListener('abort', onAbort, { once: true })
      }

      // Set up timeout if timeout_seconds >= 0 (infinite timeout when < 0)
      if (timeout_seconds >= 0) {
        timer = setTimeout(() => {
          requestTermination('timeout')
        }, timeout_seconds * 1000)
        // Never hold the event loop open just for the timeout: after the
        // child settles (or the run aborts) the pending timer must not keep
        // the process alive briefly.
        timer.unref?.()
      }

      // Collect stdout. Cap accumulation during streaming so a chatty process
      // can't OOM the agent runtime; final truncation at close still applies.
      // Once we exceed the cap we keep the head and tail with a truncation marker.
      const STREAM_ACCUMULATION_CAP = COMMAND_OUTPUT_LIMIT * 2
      const STREAM_TAIL_KEEP = Math.floor(COMMAND_OUTPUT_LIMIT / 4)
      const appendCapped = (current: string, chunk: string): string => {
        const next = current + chunk
        if (next.length <= STREAM_ACCUMULATION_CAP) {
          return next
        }
        // Keep head + tail to preserve both startup context and recent output.
        const head = next.slice(0, STREAM_ACCUMULATION_CAP - STREAM_TAIL_KEEP)
        const tail = next.slice(next.length - STREAM_TAIL_KEEP)
        return (
          head +
          `\n…[stream truncated ${next.length - STREAM_ACCUMULATION_CAP} chars mid-stream]\n` +
          tail
        )
      }
      childProcess.stdout.on('data', (data: Buffer) => {
        stdout = appendCapped(stdout, data.toString())
      })

      // Collect stderr (same cap)
      childProcess.stderr.on('data', (data: Buffer) => {
        stderr = appendCapped(stderr, data.toString())
      })

      // Handle process completion
      childProcess.on('close', (exitCode) => {
        if (settled) return
        settled = true

        if (timer) {
          clearTimeout(timer)
        }
        if (abortKillTimer) {
          clearTimeout(abortKillTimer)
          abortKillTimer = null
        }
        if (signal) {
          signal.removeEventListener('abort', onAbort)
        }

        // Truncation signal: truncateStringWithMessage uses remove:'MIDDLE',
        // so comparing the RAW accumulated lengths (before truncation) is the
        // only reliable way to know truncation will occur.
        const stdoutTruncated = stdout.length > COMMAND_OUTPUT_LIMIT
        const stderrTruncated = stderr.length > COMMAND_OUTPUT_LIMIT

        // When either stream was truncated inline, persist the FULL accumulated
        // output to a content-addressed scratch file and return a pointer
        // (fullLogPath) so the agent can read it back with read_logs/read_files
        // instead of re-running an expensive command. NOTE: the artifact holds
        // the ACCUMULATED stream, which is itself capped at
        // STREAM_ACCUMULATION_CAP (head+tail) — so beyond 2x the limit the
        // pointer recovers the capped stream, still far more than the 50k
        // inline slice.
        let fullLogFields: { fullLogPath?: string; logBytes?: number } = {}
        if (stdoutTruncated || stderrTruncated) {
          const serialized = JSON.stringify({
            command,
            startingCwd: spawnCwd,
            stdout: stripColors(stdout),
            ...(stderr ? { stderr: stripColors(stderr) } : {}),
            ...(exitCode !== null ? { exitCode } : {}),
          })
          const fullLogPath = persistFullCommandOutput(serialized)
          if (fullLogPath !== undefined) {
            // Byte length (not char length): the schema documents logBytes as
            // the artifact's byte size.
            fullLogFields = {
              fullLogPath,
              logBytes: Buffer.byteLength(serialized, 'utf8'),
            }
          }
        }

        // Truncate stdout to prevent excessive output
        const truncatedStdout = truncateStringWithMessage({
          str: stripColors(stdout),
          maxLength: COMMAND_OUTPUT_LIMIT,
          remove: 'MIDDLE',
        })

        const truncatedStderr = truncateStringWithMessage({
          str: stripColors(stderr),
          maxLength: COMMAND_OUTPUT_LIMIT,
          remove: 'MIDDLE',
        })

        if (terminationReason === 'abort') {
          const reason = signal?.reason
          if (reason instanceof Error) {
            reject(reason)
          } else {
            const error = new Error('Aborted')
            error.name = 'AbortError'
            reject(error)
          }
          return
        }

        if (terminationReason === 'timeout') {
          resolve([
            {
              type: 'json',
              value: {
                command,
                errorMessage: `Command timed out after ${timeout_seconds} seconds`,
                timedOut: true,
                startingCwd: spawnCwd,
                ...fullLogFields,
                stdout: truncatedStdout,
                ...(truncatedStderr ? { stderr: truncatedStderr } : {}),
                ...(exitCode !== null ? { exitCode } : {}),
              },
            },
          ])
          return
        }

        const combinedOutput = {
          command,
          startingCwd: spawnCwd,
          ...fullLogFields,
          stdout: truncatedStdout,
          ...(truncatedStderr ? { stderr: truncatedStderr } : {}),
          ...(exitCode !== null ? { exitCode } : {}),
        }

        resolve([{ type: 'json', value: combinedOutput }])
      })

      // Handle spawn errors
      childProcess.on('error', (error) => {
        if (settled) return
        settled = true

        if (timer) {
          clearTimeout(timer)
        }
        if (abortKillTimer) {
          clearTimeout(abortKillTimer)
          abortKillTimer = null
        }
        if (signal) {
          signal.removeEventListener('abort', onAbort)
        }

        resolve([
          {
            type: 'json',
            value: {
              command,
              errorMessage: `Failed to spawn command: ${error.message}`,
              spawnFailed: true,
              startingCwd: spawnCwd,
              stdout: stripColors(stdout),
              ...(stderr ? { stderr: stripColors(stderr) } : {}),
            },
          },
        ])
      })

      if (signalAlreadyAborted) {
        onAbort()
      }
    })

    const part = commandResult[0]
    if (
      part?.type !== 'json' ||
      !part.value ||
      typeof part.value !== 'object'
    ) {
      return commandResult
    }
    const dirtyAfter = await listDirtyPaths(gitRoot, signal)
    const touched =
      dirtyBefore && dirtyAfter ? dirtyDelta(dirtyBefore, dirtyAfter) : []
    return [
      {
        type: 'json' as const,
        value: withTouchedPaths(
          part.value as Record<string, unknown>,
          touched,
        ) as typeof part.value,
      },
    ]
  })())
}
