import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { StringDecoder } from 'string_decoder'

import {
  stripColors,
  truncateStringWithMessage,
} from '../../../common/src/util/string'
import {
  killBackgroundJob,
  startBackgroundJob,
} from './background-jobs'
import { resolveFilePathForOperation } from './path-utils'
import { runGit } from './git-status'
import { prepareHarnessGitReadArgv } from '../services/harness-enforcement'
import { MAX_TERMINAL_SPOOL_BYTES, TerminalOutputSpool } from './terminal-output-spool'
import { processCleanupSchema } from '@codebuff/common/tools/params/process-cleanup'
import { registerPreparedNativeLaunch } from '../services/native-host-execution'
import {
  evaluateTerminalCommandPolicy,
  type TerminalPermissionProfile,
} from './terminal-command-policy'
import {
  admitNodeLaunch,
  captureNodeTarget,
  deriveExecutionContext,
  dispatchNodeLaunch,
  executionLimitMs,
  executionLimitSeconds,
  executionRefusal,
  ExecutionRefusalError,
  isExecutionRefusalError,
  prepareNodeLaunch,
  refusalForSignal,
  scheduleNodeDeadline,
  trustedNodeSpawn,
} from '../services/execution-launch'

import type { CodebuffToolOutput } from '../../../common/src/tools/list'
import type { ClassifiedHarnessAction } from '../services/harness-enforcement'
import type {
  ClassifiedEffect, ExecutionAdapterContext, Family, PreparedLaunch,
  Refusal, Result, TargetDescription,
} from '@codebuff/common/types/contracts/execution-context'

const COMMAND_OUTPUT_LIMIT = 50_000

/** Execution-time bound for a SYNC command whose caller omitted `timeout_seconds`. */
export const DEFAULT_SYNC_TIMEOUT_SECONDS = 120
/** Silence after which a SYNC result carries a "waiting for input?" hint. The command keeps running. */
export const IDLE_OUTPUT_HINT_MS = 30_000

/**
 * Host/user limits on model-supplied terminal timeouts. Model input never
 * supplies this policy; the trusted host does.
 */
export type TerminalTimeoutPolicy = Readonly<{
  /** Replaces DEFAULT_SYNC_TIMEOUT_SECONDS for SYNC commands that omit a timeout. */
  defaultSyncSeconds?: number
  /** Upper bound applied to every finite or unbounded (-1) request. */
  maxSeconds?: number
  /** `false` turns a SYNC `-1` request into the default bound. Defaults to `true`. */
  allowUnbounded?: boolean
}>

export type TerminalTimeoutResolution = Readonly<{
  /** Captured local limit; -1 leaves only the parent deadline in force. */
  localSeconds: number
  /** Execution-time default that starts at dispatch, after any approval wait. */
  defaultExecutionMs?: number
}>

/**
 * An omitted SYNC timeout becomes an execution-time default (120 s) that starts
 * after admission, so an approval wait never consumes it. Explicit values keep
 * their documented meaning (including approval waits). A finite parent deadline
 * always still applies through the derived execution context.
 */
export function resolveTerminalTimeout(
  requested: number | undefined,
  processType: 'SYNC' | 'BACKGROUND',
  policy: TerminalTimeoutPolicy = {},
): TerminalTimeoutResolution {
  const cap = policy.maxSeconds !== undefined && policy.maxSeconds > 0 ? policy.maxSeconds : undefined
  const syncDefault = Math.min(policy.defaultSyncSeconds ?? DEFAULT_SYNC_TIMEOUT_SECONDS, cap ?? Infinity)
  const defaulted = (): TerminalTimeoutResolution => processType === 'SYNC'
    ? { localSeconds: -1, defaultExecutionMs: Math.round(syncDefault * 1000) }
    : { localSeconds: cap ?? -1 }
  if (requested === undefined) return defaulted()
  if (requested === -1) {
    if (cap !== undefined) return { localSeconds: cap }
    return policy.allowUnbounded === false ? defaulted() : { localSeconds: -1 }
  }
  return { localSeconds: cap !== undefined && requested > cap ? cap : requested }
}

export type TerminalIdleOutputHint = Readonly<{ idleMs: number; stdoutBytes: number; stderrBytes: number }>

function idleOutputHintText(idleMs: number): string {
  return `No output for ${Math.round(idleMs / 1000)} s. stdin is closed, so a command waiting for interactive input ` +
    `(a /dev/tty prompt, pager or editor) will never get it: rerun it non-interactively (--yes, CI=1, --no-pager) ` +
    `or as BACKGROUND if it is long-running.`
}

export type CapturedTerminalLaunchMetadata = Readonly<{
  requiresCommitSafety?: boolean
  approvalReceiptId?: string
  harnessAction?: string
  harnessTarget?: string
  harnessEffects?: readonly ClassifiedEffect[]
  harnessParseStatus?: 'complete' | 'unsupported' | 'malformed'
  executionContextHash?: string
  executionBindingVersion?: 2
  executionBindingDigest?: string
}>
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

type GitSafetyResult = { exitCode: number; stdout: string; stderr: string; executionRefusal?: Refusal }

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
): { names: [string, string] } | { unparsable: true } | undefined {
  if (!line.startsWith(STAGED_DIFF_HEADER_PREFIX)) return undefined
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
 * Async Git adapter for the staged-commit safety preflight. Its streaming
 * scanner inspects the patch without materializing ordinary Git output, and
 * refuses more than GIT_SAFETY_OUTPUT_LIMIT bytes. It uses the same captured
 * environment and lifetime mediation as the other Node launchers.
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
async function runGitForSafety(
  args: string[],
  cwd: string,
  observeStdout?: (chunk: Buffer) => void,
  options?: {
    signal?: AbortSignal
    timeoutMs?: number
    env?: NodeJS.ProcessEnv
    executionContext?: ExecutionAdapterContext
    branchId?: string
  },
): Promise<GitSafetyResult> {
  const refuse = (refusal: Refusal): GitSafetyResult => ({
    exitCode: -1, stdout: '', stderr: refusal.cause, executionRefusal: refusal,
  })
  if (options?.signal?.aborted) return refuse(refusalForSignal(options.signal))
  const limit = executionLimitMs(options?.timeoutMs ?? GIT_SAFETY_SPAWN_TIMEOUT_MS)
  if (!limit.ok) return refuse(limit)
  const context = deriveExecutionContext(options?.executionContext, `git-safety:${options?.branchId ?? ''}`, limit.value)
  if (!context.ok) return refuse(context)
  const launch = prepareNodeLaunch({
    executionContext: context.value,
    executable: 'git', argv: prepareHarnessGitReadArgv(args), cwd,
    branchId: options?.branchId ?? '',
    environmentOverlay: { ...options?.env, GIT_OPTIONAL_LOCKS: '0' },
    adapterOptions: { stdio: 'ignore-pipe-pipe', shell: false, detached: false, windowsHide: false,
      maxRetainedOutputBytes: 2 * GIT_SAFETY_OUTPUT_LIMIT },
  })
  if (!launch.ok) return refuse(launch)
  const admitted = await admitNodeLaunch(launch.value, context.value.signal ?? options?.signal)
  if (!admitted.ok) return refuse(admitted)
  const spawn = trustedNodeSpawn(context.value)
  const dispatched = dispatchNodeLaunch(admitted.value, (input) => spawn(input.executable, input.argv, {
    cwd: input.cwd, env: input.env, signal: input.resourceSignal,
    stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: false, windowsHide: false,
  }))
  if (!dispatched.ok) return refuse(dispatched)
  const node = dispatched.value
  const resourceSignal = node.input.resourceSignal
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
    const child = node.child
    let lifetimeRefusal: Refusal | undefined
    const settle = (exitCode: number) => {
      if (settled) return
      settled = true
      cancelSpawnTimer()
      resourceSignal.removeEventListener('abort', onAbort)
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
      const observation = node.observation()
      const refusal = lifetimeRefusal ?? node.resourceRefusal() ?? (!observation.ok ? observation : undefined)
      resolve({
        exitCode: overflowed || aborted || refusal ? -1 : exitCode,
        stdout,
        stderr: stderr || refusal?.cause || '',
        ...(refusal ? { executionRefusal: refusal } : {}),
      })
    }
    /**
     * A local `git diff --cached` is fast; one that has not produced a result
     * within this bound is stuck (hung index, NFS stall, pathological repo) and
     * is killed so the preflight fails closed instead of hanging the tool call
     * forever — the tool's own timeout does not bound a preflight the caller
     * never sees.
     */
    const cancelSpawnTimer = scheduleNodeDeadline(node.remainingResourceMs, () => {
      aborted = true
      lifetimeRefusal = node.resourceRefusal() ?? (resourceSignal.aborted ? refusalForSignal(resourceSignal)
        : executionRefusal('deadline-exhausted', 'Git safety resource deadline exhausted'))
      settle(-1)
    })
    let aborted = false
    const onAbort = (): void => {
      aborted = true
      lifetimeRefusal = refusalForSignal(resourceSignal)
      settle(-1)
    }
    resourceSignal.addEventListener('abort', onAbort, { once: true })
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
      stderr = firstLineBreak === -1 ? tail : tail.slice(firstLineBreak + 1)
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return
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
      if (settled) return
      stderrBytes += chunk.byteLength
      if (!withinBudget(stderrBytes)) return
      appendStderrTail(chunk.toString('utf8'))
    })
    child.on('error', (error) => {
      appendStderrTail(error.message)
      settle(-1)
    })
    child.on('close', async (code) => {
      const native = await node.nativeResult
      if (native && !native.ok) { lifetimeRefusal = native; settle(-1); return }
      settle(native?.ok ? native.value.exitCode ?? -1 : code ?? -1)
    })
    if (resourceSignal.aborted) onAbort()
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
  | { kind: 'inspectionFailed'; detail: string; executionRefusal?: Refusal }
  | undefined

async function validateStagedCommit(
  cwd: string,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
  executionContext?: ExecutionAdapterContext,
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
    runGitForSafety(['diff', '--cached', '--check'], cwd, undefined, {
      signal,
      env,
      executionContext,
      branchId: 'terminal.safety.check',
    }),
    scanWhilePending(
      runGitForSafety(
        ['diff', '--cached', '-U0'],
        cwd,
        (chunk) => scanner.enqueue(chunk),
        { signal, env, executionContext, branchId: 'terminal.safety.diff' },
      ),
      scanner,
    ),
  ])
  const refusal = whitespace.executionRefusal ?? diff.executionRefusal
  if (refusal) return { kind: 'inspectionFailed', detail: refusal.cause, executionRefusal: refusal }
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
    return {
      kind: 'blocked',
      detail: `staged diff failed whitespace checks: ${detail}`,
    }
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
    return {
      kind: 'blocked',
      detail: `sensitive file is staged: ${sensitiveName}`,
    }
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
  env?: NodeJS.ProcessEnv,
  executionContext?: ExecutionAdapterContext,
  branchId = 'terminal.legacy-dirty',
): Promise<Set<string> | null> {
  try {
    const args = ['status', '--porcelain', '-uall']
    const result = env
      ? await runGitForSafety(args, projectRoot, undefined, { signal, env, executionContext, branchId })
      : await runGit(args, projectRoot, signal, { executionContext, branchId })
    if (result.executionRefusal) throw new ExecutionRefusalError(result.executionRefusal)
    if (result.exitCode !== 0) return null
    const paths = new Set<string>()
    for (const line of result.stdout.split('\n')) {
      if (line.trim() === '') continue
      const raw = line.slice(3).split(' -> ').at(-1)?.trim() ?? ''
      const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '').trim()
      if (normalized.length > 0) paths.add(normalized)
    }
    return paths
  } catch (error) {
    if (isExecutionRefusalError(error)) throw error
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

export async function runTerminalCommand({
  command,
  process_type,
  detach = false,
  mode: requestedMode = 'assistant',
  permission_profile: requestedPermissionProfile,
  allowed_paths: requestedAllowedPaths,
  cwd,
  projectRoot,
  timeout_seconds,
  env: requestedEnv,
  signal: requestedSignal,
  owner: requestedOwner,
  executionContext,
  terminalShell,
  getTerminalLaunchMetadata,
  prepareTransferredLaunch,
  executionFamily,
  executionBranchId,
  timeoutPolicy,
  idleOutputHintMs = IDLE_OUTPUT_HINT_MS,
  onIdleOutput,
}: {
  command: string
  process_type: 'SYNC' | 'BACKGROUND'
  detach?: boolean
  mode?: 'assistant' | 'user'
  permission_profile?: TerminalPermissionProfile
  allowed_paths?: string[]
  cwd: string
  projectRoot?: string
  /** Omitted: SYNC gets DEFAULT_SYNC_TIMEOUT_SECONDS of execution time; BACKGROUND stays unbounded. */
  timeout_seconds?: number
  env?: Record<string, string | undefined>
  /** Child inheritance is captured by the root host before this call. */
  inheritEnv?: boolean
  signal?: AbortSignal
  owner?: {
    clientSessionId: string
    rootRunId: string
    parentRunId: string
    parentAgentId: string
  }
  /** Legacy option retained as history; actual approval belongs to the v2 host. */
  authorizeHighImpactAction?: (action: ClassifiedHarnessAction) => Promise<
    | { allowed: true; approvalReceiptId?: string }
    | { allowed: false; reason: string; approvalRequired: boolean }
  >
  /** Legacy v1 objects cannot create a host target permit. */
  preApprovedAction?: {
    action: string; target: string; commandHash: string
    executionContextHash?: string; approvalReceiptId?: string
  }
  executionContext?: ExecutionAdapterContext
  terminalShell?: Readonly<{ executable: string; args: readonly string[] }>
  getTerminalLaunchMetadata?: (launchId: string) => CapturedTerminalLaunchMetadata | undefined
  prepareTransferredLaunch?: (target: TargetDescription) => Result<PreparedLaunch>
  /** SDK-only hook attribution; never accepted from model tool payloads. */
  executionFamily?: Family
  executionBranchId?: string
  /** Trusted host/user timeout limits; never read from model input. */
  timeoutPolicy?: TerminalTimeoutPolicy
  /** SYNC silence before the idle-output hint (default IDLE_OUTPUT_HINT_MS). */
  idleOutputHintMs?: number
  /** Called once per silent period of at least `idleOutputHintMs`; the command is not stopped. */
  onIdleOutput?: (hint: TerminalIdleOutputHint) => void
}): Promise<CodebuffToolOutput<'run_terminal_command'>> {
  const mode = executionContext?.mode ?? requestedMode
  const permission_profile = requestedPermissionProfile ?? (executionContext?.profile.policy as TerminalPermissionProfile | undefined) ?? 'workspace-write'
  const env = requestedEnv ? { ...requestedEnv } : undefined
  let signal = executionContext?.signal ?? requestedSignal
  const refused = (refusal: Refusal): CodebuffToolOutput<'run_terminal_command'> => [{
    type: 'json',
    value: {
      command, errorMessage: refusal.cause, executionRefusal: refusal,
      permissionProfile: permission_profile,
      ...(refusal.reason === 'denied' ? { permissionDenied: true } : {}),
      ...(refusal.reason === 'deadline-exhausted' ? { timedOut: true } : {}),
    },
  }]
  if (signal?.aborted) return refused(refusalForSignal(signal))
  const timeout = resolveTerminalTimeout(timeout_seconds, process_type, timeoutPolicy)
  const limit = executionLimitSeconds(timeout.localSeconds)
  if (!limit.ok) return refused(limit)
  const branchId = executionBranchId ?? (process_type === 'BACKGROUND'
    ? detach ? 'background.transferred' : 'background.attached'
    : 'terminal.sync')
  const context = deriveExecutionContext(executionContext, `terminal:${branchId}`, limit.value)
  if (!context.ok) return refused(context)
  signal = context.value.signal ?? signal
  if (requestedPermissionProfile && requestedPermissionProfile !== context.value.profile.policy) {
    return refused(executionRefusal('invalid-context', 'Terminal profile differs from the captured host profile'))
  }
  if (context.value.profile.policy === 'validation-diagnosis') {
    return refused(executionRefusal('unavailable', 'The terminal policy adapter does not implement validation-diagnosis'))
  }
  if (projectRoot !== undefined && path.resolve(projectRoot) !== path.resolve(context.value.projectRoot)) {
    return refused(executionRefusal('invalid-context', 'Terminal project root differs from captured execution context'))
  }
  const effectiveProjectRoot = context.value.projectRoot
  const allowed_paths = requestedAllowedPaths ? [...requestedAllowedPaths] : [...context.value.allowedPaths]
  const resolvedCwd = resolveFilePathForOperation(effectiveProjectRoot, cwd)
  if (resolvedCwd === null || resolvedCwd.scope === 'owned-temp') {
    return [{ type: 'json', value: { command, errorMessage: `Invalid cwd: Path '${cwd}' is outside the project directory.` } }]
  }
  const containedCwd = resolvedCwd.operationPath
  const policy = evaluateTerminalCommandPolicy({
    command, mode, permissionProfile: permission_profile,
    projectRoot: effectiveProjectRoot, allowedPaths: allowed_paths, cwd: containedCwd,
  })
  if (!policy.allowed) {
    return refused(executionRefusal('denied', `Command denied by ${permission_profile} terminal policy: ${policy.reason}`))
  }
  if (detach && process_type !== 'BACKGROUND') {
    return refused(executionRefusal('invalid-context', 'Ownership transfer applies only to background commands'))
  }
  const isWindows = os.platform() === 'win32'
  const shell = terminalShell
    ? { executable: terminalShell.executable, args: [...terminalShell.args] }
    : isWindows ? undefined : { executable: 'bash', args: ['-c'] }
  if (!shell) return refused(executionRefusal('unavailable', createWindowsBashNotFoundError().message))
  const target = captureNodeTarget({
    executionContext: context.value,
    executable: shell.executable, argv: [...shell.args, command], shellCommandBytes: command,
    cwd: containedCwd, branchId,
    family: executionFamily ?? (process_type === 'BACKGROUND' ? 'background-job' : 'sync-shell'),
    processType: process_type,
    environmentOverlay: env,
    adapterOptions: {
      runtime: 'node', platform: os.platform(), shell: false,
      // SYNC stdin is closed too: a prompt reads EOF instead of waiting forever.
      stdio: 'ignore-pipe-pipe',
      detached: !isWindows, windowsHide: false,
      maxRetainedOutputBytes: MAX_TERMINAL_SPOOL_BYTES,
    },
  })
  if (!target.ok) return refused(target)
  let prepared: Result<PreparedLaunch>
  try {
    prepared = detach
      ? prepareTransferredLaunch?.(target.value) ?? executionRefusal('unavailable', 'Authenticated background transfer is unavailable')
      : context.value.execution.prepareTarget({ target: target.value })
  } catch {
    return refused(executionRefusal('invalid-context', 'Terminal launch preparation failed'))
  }
  if (!prepared.ok) return refused(prepared)
  const preparedLaunch = prepared.value
  registerPreparedNativeLaunch(context.value.execution, target.value, preparedLaunch)
  const admitted = await admitNodeLaunch(preparedLaunch, signal)
  if (!admitted.ok) return refused(admitted)
  const launchFacts = preparedLaunch.facts()
  const owner = launchFacts.correlation.kind === 'action'
    ? { ...launchFacts.correlation.owner }
    : requestedOwner ? { ...requestedOwner } : undefined
  let metadata: CapturedTerminalLaunchMetadata | undefined
  try { metadata = getTerminalLaunchMetadata?.(launchFacts.launchId) }
  catch { return refused(executionRefusal('unavailable', 'Captured terminal classification metadata is unavailable')) }
  if (mode === 'assistant' && permission_profile === 'git-commit' && !metadata) {
    return refused(executionRefusal('unavailable', 'Captured commit classification is unavailable'))
  }
  const {
    requiresCommitSafety: _privateCommitSafety,
    harnessEffects: capturedEffects,
    ...capturedPublicFields
  } = metadata ?? {}
  const publicMetadata = {
    ...capturedPublicFields,
    harnessEffects: capturedEffects?.map(effect => ({
      ...effect,
      pushRisks: effect.pushRisks ? [...effect.pushRisks] : undefined,
    })),
  }
  const finalizeHarnessMetadata = async (
    result: Promise<CodebuffToolOutput<'run_terminal_command'>>,
  ): Promise<CodebuffToolOutput<'run_terminal_command'>> => {
    const output = await result
    const part = output[0]
    return [{ ...part, value: {
      ...part.value, ...publicMetadata,
      executionBindingVersion: 2,
      executionBindingDigest: preparedLaunch.facts().executionBindingDigest,
    } }]
  }
  let dirtyObservationRefusal: Refusal | undefined
  const observeDirty = async (dirtyBranchId: string) => {
    try {
      return await listDirtyPaths(effectiveProjectRoot, signal, env, context.value, dirtyBranchId)
    } catch (error) {
      if (!isExecutionRefusalError(error)) throw error
      dirtyObservationRefusal = error.refusal
      return null
    }
  }

  if (
    mode === 'assistant' &&
    permission_profile === 'git-commit' &&
    metadata?.requiresCommitSafety === true
  ) {
    const safety = await validateStagedCommit(containedCwd, signal, env, context.value)
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
              ...(safety.executionRefusal ? { executionRefusal: safety.executionRefusal } : {}),
              permissionProfile: permission_profile,
            },
          },
        ]),
      )
    }
  }

  if (process_type === 'BACKGROUND') {
    return finalizeHarnessMetadata((async () => {
      const dirtyBefore = await observeDirty('terminal.safety.dirty-before')
      let job
      try {
        job = startBackgroundJob({
          command, cwd: containedCwd, owner,
          projectRoot: effectiveProjectRoot,
          dirtyBeforePaths: dirtyBefore ? [...dirtyBefore] : undefined,
          admittedLaunch: admitted.value,
          executionContext: context.value,
          // Attached jobs end with this process; transferred jobs follow
          // their receiver lifetime.
          attached: !detach,
        })
      } catch (error) {
        if (isExecutionRefusalError(error)) return refused(error.refusal)
        throw error
      }
      const observed = await job.nodeLaunch!.started
      if (!observed.ok) {
        killBackgroundJob(job.jobId, 'SIGTERM')
        return refused(observed)
      }
      return [{
        type: 'json' as const,
        value: {
          command, processId: observed.value.pid,
          backgroundProcessStatus: 'running' as const,
          detached: detach, jobId: job.jobId, logFile: job.logFile,
          startingCwd: containedCwd,
          ...(dirtyObservationRefusal ? { dirtyObservationRefusal } : {}),
        },
      }]
    })())
  }

  // SYNC: capture pre/post dirty paths against projectRoot so cwd subdirectory
  // commands still attribute project-relative paths. Soft-fail omits touchedPaths.
  return finalizeHarnessMetadata(
    (async () => {
      const dirtyBefore = await observeDirty('terminal.safety.dirty-before')

      const commandResult = await new Promise<
        CodebuffToolOutput<'run_terminal_command'>
      >((resolve) => {
        const spawnCwd = containedCwd
        const spawn = trustedNodeSpawn(context.value)
        let stdoutSeenBytes = 0
        let stderrSeenBytes = 0
        let outputLimitExceeded = false
        let outputSpool: TerminalOutputSpool | undefined
        let spoolError: unknown
        const dispatched = dispatchNodeLaunch(admitted.value, (input) => spawn(input.executable, input.argv, {
          cwd: input.cwd, env: input.env, signal: input.resourceSignal,
          stdio: ['ignore', 'pipe', 'pipe'], detached: input.adapterOptions.detached === true, shell: false, windowsHide: false,
        }), { output: () => {
          const seen = stdoutSeenBytes + stderrSeenBytes
          const retained = outputSpool?.bytesRetained ?? Math.min(seen, COMMAND_OUTPUT_LIMIT * 4)
          return { stdoutSeenBytes, stderrSeenBytes, retainedBytes: retained,
            droppedBytes: Math.max(0, seen - retained), complete: !outputLimitExceeded && !spoolError }
        } })
        if (!dispatched.ok) {
          resolve(refused(dispatched))
          return
        }
        const node = dispatched.value
        const childProcess = node.child
        const resourceSignal = node.input.resourceSignal
        // A backend that still hands us a stdin pipe gets EOF immediately.
        try { childProcess.stdin?.end() } catch { /* already closed */ }

        // These mutable bookkeeping fields are read by `onAbort`, the timeout
        // callback, and the close/error handlers below. Declare them BEFORE
        // wiring the abort listener so `onAbort` never references a binding
        // that is still in the temporal dead zone (the JS engine hoists `let`
        // but throws on access until the declaration line runs).
        let cancelTimer: (() => void) | null = null
        let settled = false
        let completing = false
        let terminationReason: 'abort' | 'timeout' | null = null
        let defaultTimeoutFired = false
        let defaultTimeoutTimer: ReturnType<typeof setTimeout> | undefined
        // Idle-output watchdog: a hint only, never a kill.
        let lastOutputAt = performance.now()
        let maxIdleMs = 0
        let idleTimer: ReturnType<typeof setTimeout> | undefined
        const armIdle = () => {
          if (idleTimer !== undefined || !(idleOutputHintMs > 0)) return
          idleTimer = setTimeout(() => {
            idleTimer = undefined
            if (settled || completing) return
            const idleMs = performance.now() - lastOutputAt
            if (idleMs < idleOutputHintMs) { armIdle(); return }
            maxIdleMs = Math.max(maxIdleMs, idleMs)
            try { onIdleOutput?.({ idleMs, stdoutBytes: stdoutSeenBytes, stderrBytes: stderrSeenBytes }) } catch { /* observer only */ }
            // Re-armed by the next output chunk, so one hint per silent period.
          }, Math.max(1, idleOutputHintMs - (performance.now() - lastOutputAt)))
          idleTimer.unref?.()
        }
        const noteOutput = () => {
          const now = performance.now()
          maxIdleMs = Math.max(maxIdleMs, now - lastOutputAt)
          lastOutputAt = now
          armIdle()
        }
        const stopWatchdogs = () => {
          if (idleTimer !== undefined) clearTimeout(idleTimer)
          idleTimer = undefined
          if (defaultTimeoutTimer !== undefined) clearTimeout(defaultTimeoutTimer)
          defaultTimeoutTimer = undefined
          maxIdleMs = Math.max(maxIdleMs, performance.now() - lastOutputAt)
        }
        const idleFields = () => idleOutputHintMs > 0 && maxIdleMs >= idleOutputHintMs
          ? { idleOutputMs: Math.round(maxIdleMs), idleOutputHint: idleOutputHintText(maxIdleMs) } : {}
        let stdout = ''
        let stderr = ''
        const stdoutDecoder = new StringDecoder('utf8')
        const stderrDecoder = new StringDecoder('utf8')
        const spoolChunk = (name: 'stdout' | 'stderr', text: string) => {
          if (
            !outputSpool &&
            !spoolError &&
            (name === 'stdout' ? stdout : stderr).length + text.length >
              COMMAND_OUTPUT_LIMIT
          ) {
            try {
              outputSpool = new TerminalOutputSpool(stdout, stderr)
            } catch (error) {
              spoolError = error
            }
          }
          const source = childProcess[name]
          if (source) outputSpool?.append(name, text, source)
        }

        // The shared launch helper controls physical termination. These flags
        // only select the output shape and never arm another kill schedule.
        const markTermination = (reason: 'abort' | 'timeout') => {
          if (settled || terminationReason || childProcess.exitCode != null || childProcess.signalCode != null) return
          terminationReason = reason
        }
        const onAbort = () => {
          markTermination(refusalForSignal(resourceSignal).reason === 'deadline-exhausted' ? 'timeout' : 'abort')
          cancelTimer?.()
        }
        const signalAlreadyAborted = resourceSignal.aborted
        if (!signalAlreadyAborted) {
          resourceSignal.addEventListener('abort', onAbort, { once: true })
        }

        // Admission/preflight elapsed time is already deducted by the host.
        if (node.input.resourceRemainingMs !== null) {
          cancelTimer = scheduleNodeDeadline(node.remainingResourceMs, () => {
            markTermination('timeout')
          })
        }
        if (timeout.defaultExecutionMs !== undefined) {
          defaultTimeoutTimer = setTimeout(() => {
            defaultTimeoutTimer = undefined
            if (settled || completing || terminationReason) return
            markTermination('timeout')
            if (terminationReason !== 'timeout') return
            defaultTimeoutFired = true
            // SIGTERM, bounded grace, then SIGKILL of the owned process group.
            void node.scope.requestStop('deadline')
          }, timeout.defaultExecutionMs)
          defaultTimeoutTimer.unref?.()
        }
        armIdle()

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
        childProcess.stdout?.on('data', (data: Buffer) => {
          if (settled) return
          stdoutSeenBytes += data.length
          noteOutput()
          if (!outputLimitExceeded && stdoutSeenBytes + stderrSeenBytes > MAX_TERMINAL_SPOOL_BYTES) {
            outputLimitExceeded = true
            void node.scope.requestStop('output-limit')
          }
          const text = stdoutDecoder.write(data)
          spoolChunk('stdout', text)
          stdout = appendCapped(stdout, text)
        })

        // Collect stderr (same cap)
        childProcess.stderr?.on('data', (data: Buffer) => {
          if (settled) return
          stderrSeenBytes += data.length
          noteOutput()
          if (!outputLimitExceeded && stdoutSeenBytes + stderrSeenBytes > MAX_TERMINAL_SPOOL_BYTES) {
            outputLimitExceeded = true
            void node.scope.requestStop('output-limit')
          }
          const text = stderrDecoder.write(data)
          spoolChunk('stderr', text)
          stderr = appendCapped(stderr, text)
        })

        // Handle process completion
        childProcess.on('close', async (exitCode) => {
          if (completing) return
          completing = true
          stopWatchdogs()
          const native = await node.nativeResult
          if (native?.ok) exitCode = native.value.exitCode
          const nativeFields = native?.ok ? {
            executionUsage: native.value.targetUsage ?? native.value.usage,
            executionWaitStatusSource: native.value.waitStatusSource,
            ...(native.value.wrapperExitCode !== null ? { nativeWrapperExitCode: native.value.wrapperExitCode } : {}),
            ...(native.value.wrapperSignal !== null ? { nativeWrapperSignal: native.value.wrapperSignal } : {}),
            ...(native.value.signal !== null ? { executionSignal: native.value.signal } : {}),
          } : {}
          const processCleanup = processCleanupSchema.parse(await node.scope.requestStop('normal-leader-exit'))
          settled = true
          const resourceRefusal = node.resourceRefusal()
          if (resourceRefusal?.reason === 'deadline-exhausted') terminationReason = 'timeout'
          else if (resourceRefusal?.reason === 'cancelled') terminationReason = 'abort'

          cancelTimer?.()
          resourceSignal.removeEventListener('abort', onAbort)

          // Join disk writes before returning a recovery path. Inline accumulation
          // stays bounded, while the artifact contains every streamed character.
          const stdoutTail = stdoutDecoder.end()
          const stderrTail = stderrDecoder.end()
          spoolChunk('stdout', stdoutTail)
          spoolChunk('stderr', stderrTail)
          stdout = appendCapped(stdout, stdoutTail)
          stderr = appendCapped(stderr, stderrTail)
          if (terminationReason === 'abort') {
            // Cancellation keeps what the command printed, like a timeout.
            const output = refused(resourceRefusal ?? refusalForSignal(resourceSignal))[0]
            const partialStdout = truncateStringWithMessage({ str: stripColors(stdout), maxLength: COMMAND_OUTPUT_LIMIT, remove: 'MIDDLE' })
            const partialStderr = truncateStringWithMessage({ str: stripColors(stderr), maxLength: COMMAND_OUTPUT_LIMIT, remove: 'MIDDLE' })
            const partialLogFields = outputSpool
              ? await outputSpool.finish({ command, startingCwd: spawnCwd, ...(exitCode !== null ? { exitCode } : {}) })
              : spoolError ? {
                logPersisted: false as const,
                logError: 'Full command output could not be saved; only the bounded inline output remains.',
              } : {}
            resolve([{ ...output, value: { ...output.value, startingCwd: spawnCwd, processCleanup, ...nativeFields,
              ...partialLogFields, stdout: partialStdout, ...(partialStderr ? { stderr: partialStderr } : {}),
              ...idleFields(), ...(exitCode !== null ? { exitCode } : {}) } }])
            return
          }

          const observation = node.observation()
          if (native && !native.ok) {
            await outputSpool?.discard()
            const output = refused(native)[0]
            resolve([{ ...output, value: { ...output.value, processCleanup } }])
            return
          }
          if (!observation.ok) {
            await outputSpool?.discard()
            resolve(refused(observation))
            return
          }

          const fullLogFields = outputSpool
            ? await outputSpool.finish({
                command,
                startingCwd: spawnCwd,
                ...(exitCode !== null ? { exitCode } : {}),
              })
            : spoolError
              ? {
                  logPersisted: false as const,
                  logError:
                    'Full command output could not be saved; only the bounded inline output remains.',
                }
              : {}

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

          if (terminationReason === 'timeout') {
            resolve([
              {
                type: 'json',
                value: {
                  command,
                  errorMessage: defaultTimeoutFired
                    ? `Command timed out after the default ${Math.round(timeout.defaultExecutionMs! / 1000)} s SYNC timeout ` +
                      `(timeout_seconds was omitted). Pass a larger timeout_seconds for long builds or tests, or use BACKGROUND.`
                    : 'Command resource deadline exhausted',
                  timedOut: true,
                  executionRefusal: executionRefusal('deadline-exhausted', defaultTimeoutFired
                    ? 'Default SYNC command timeout exhausted' : 'Command resource deadline exhausted'),
                  startingCwd: spawnCwd,
                  processCleanup,
                  ...nativeFields,
                  ...idleFields(),
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
            processCleanup,
            ...nativeFields,
            ...(native?.ok && native.value.signal !== null ? { errorMessage: `Command terminated by signal ${native.value.signal}` } : {}),
            ...(resourceRefusal?.reason === 'unavailable' ? { errorMessage: resourceRefusal.cause } : {}),
            ...(outputLimitExceeded ? { errorMessage: 'Command exceeded the retained output quota' } : {}),
            ...(processCleanup.status !== 'complete' ? {
              errorMessage: 'Command exited but covered process cleanup remains unconfirmed',
            } : {}),
            ...idleFields(),
            ...fullLogFields,
            stdout: truncatedStdout,
            ...(truncatedStderr ? { stderr: truncatedStderr } : {}),
            ...(exitCode !== null ? { exitCode } : {}),
          }

          resolve([{ type: 'json', value: combinedOutput }])
        })

        // Handle spawn errors
        childProcess.on('error', async (error) => {
          if (completing) return
          completing = true
          stopWatchdogs()
          const processCleanup = processCleanupSchema.parse(await node.scope.requestStop('adapter-error'))
          settled = true

          cancelTimer?.()
          resourceSignal.removeEventListener('abort', onAbort)

          const observation = node.observation()
          const refusal = node.resourceRefusal() ?? (resourceSignal.aborted ? refusalForSignal(resourceSignal)
            : !observation.ok ? observation : executionRefusal('unavailable', error.message))
          let fullLogFields = {}
          if (refusal.reason === 'deadline-exhausted' || refusal.reason === 'cancelled') {
            const stdoutTail = stdoutDecoder.end()
            const stderrTail = stderrDecoder.end()
            spoolChunk('stdout', stdoutTail)
            spoolChunk('stderr', stderrTail)
            stdout = appendCapped(stdout, stdoutTail)
            stderr = appendCapped(stderr, stderrTail)
            fullLogFields = outputSpool
              ? await outputSpool.finish({ command, startingCwd: spawnCwd })
              : spoolError ? {
                logPersisted: false as const,
                logError: 'Full command output could not be saved; only the bounded inline output remains.',
              } : {}
          } else await outputSpool?.discard()
          const truncatedStdout = truncateStringWithMessage({
            str: stripColors(stdout), maxLength: COMMAND_OUTPUT_LIMIT, remove: 'MIDDLE',
          })
          const truncatedStderr = truncateStringWithMessage({
            str: stripColors(stderr), maxLength: COMMAND_OUTPUT_LIMIT, remove: 'MIDDLE',
          })
          resolve([
            {
              type: 'json',
              value: {
                command,
                errorMessage: refusal.cause,
                executionRefusal: refusal,
                ...(node.facts().profile.active === null ? { spawnFailed: true } : {}),
                ...(refusal.reason === 'deadline-exhausted' ? { timedOut: true } : {}),
                startingCwd: spawnCwd,
                processCleanup,
                ...idleFields(),
                ...fullLogFields,
                stdout: truncatedStdout,
                ...(truncatedStderr ? { stderr: truncatedStderr } : {}),
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
      if ('executionRefusal' in part.value && !('timedOut' in part.value && part.value.timedOut)) return commandResult
      const dirtyAfter = await observeDirty('terminal.safety.dirty-after')
      const touched =
        dirtyBefore && dirtyAfter ? dirtyDelta(dirtyBefore, dirtyAfter) : []
      return [
        {
          type: 'json' as const,
          value: withTouchedPaths(
            { ...part.value, ...(dirtyObservationRefusal ? { dirtyObservationRefusal } : {}) } as Record<string, unknown>,
            touched,
          ) as typeof part.value,
        },
      ]
    })(),
  )
}
