/**
 * Early stdin input capture.
 *
 * Keystrokes typed during boot (before the chat input is live) were silently
 * dropped: in that window the only stdin `data` listener is the OSC theme
 * probe, which swallows early bytes into a throwaway response buffer, and the
 * OpenTUI renderer starts consuming stdin before the Chat input component
 * mounts. main() uses this module to capture stdin bytes from the very start
 * of the renderer path, stop the capture immediately before the renderer is
 * created, and let Chat replay the captured printable text into the input box
 * once it mounts (see consumeCapturedEarlyInput).
 *
 * Deliberately React-free: main() runs it before any renderer exists and the
 * Chat mount effect consumes it, so importing React here would pull rendering
 * code into the boot path.
 */

import { TERMINAL_RESET_SEQUENCES } from './renderer-cleanup'

/** Upper bound on extracted characters kept for replay; overflow is dropped. */
const MAX_CAPTURED_CHARS = 4096

/** Byte a terminal sends for Ctrl+C. Raw mode disables ISIG, so it arrives here as data instead of raising SIGINT. */
const CTRL_C_BYTE = 0x03

/** SIGINT-style exit code (128 + 2), matching the shell convention for Ctrl+C deaths. */
const CTRL_C_EXIT_CODE = 130

/** OSC sequence: ESC ] body (no BEL/ESC bytes) then an optional BEL or ST (ESC backslash) terminator. */
const OSC_SEQUENCE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g

/**
 * DCS sequence: ESC P body terminated by ST (ESC backslash). tmux forwards the
 * OSC replies it passes through wrapped in a passthrough whose body contains
 * ESC bytes, so the body is matched with a tempered scan up to the first ST
 * rather than a plain negated character class.
 */
const DCS_SEQUENCE = /\x1bP(?!\x1b\\)(?:(?!\x1b\\)[\s\S])*\x1b\\/g

/** Bare ST (ESC backslash) left over after the OSC/DCS that owned it was stripped. */
const ST_SEQUENCE = /\x1b\\/g

/** CSI sequence: ESC [ parameter/intermediate bytes (0x20-0x3f) then a final byte (0x40-0x7e). */
const CSI_SEQUENCE = /\x1b\[[\x20-\x3f]*[\x40-\x7e]/g

/** Remaining C0 controls and DEL to drop. \n (0x0a) and \t (0x09) are excluded; \r is mapped to \n first. */
const DROPPED_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

/**
 * Extract the printable text a user meant to type from decoded stdin bytes.
 *
 * Strips CSI sequences (including the \x1b[200~ / \x1b[201~ bracketed-paste
 * markers — the pasted content BETWEEN them is kept), OSC sequences (BEL or ST
 * terminated), DCS sequences (tmux wraps the OSC replies it passes through in
 * one), and every other C0 control except \n (\r is mapped to \n, \t is kept).
 * Printable ASCII and UTF-8 text is preserved.
 *
 * Pure: exported so the extraction rules are testable without a stdin.
 */
export function extractPrintableText(decoded: string): string {
  return decoded
    .replace(OSC_SEQUENCE, '')
    .replace(DCS_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(/\r/g, '\n')
    // A passthrough whose doubled ESCs hid its terminator from the patterns
    // above can leave a bare ST behind; an ST can only ever be a terminator,
    // so strip it before the C0 pass drops just its ESC half.
    .replace(ST_SEQUENCE, '')
    .replace(DROPPED_CONTROLS, '')
}

/**
 * Split `raw` at a trailing escape sequence that may be incomplete because the
 * terminal's bytes were split across stdin reads. The returned `remainder` stays
 * buffered until more bytes arrive, so a \x1b[200~ paste marker split across two
 * reads is never mistaken for the printable text "200~".
 *
 * @internal Exported for testing
 */
export function splitIncompleteEscapeTail(raw: string): {
  flushable: string
  remainder: string
} {
  // A DCS body contains ESC bytes (tmux doubles the ESCs it passes through), so
  // a truncated DCS is held back from its own ESC P introducer — the last-ESC
  // rule below would hold only the trailing ESC inside its body and let the
  // body's own text through. Only an unterminated LAST DCS matters: a
  // terminated one leaves nothing incomplete for that rule to mis-split.
  const lastDcs = raw.lastIndexOf('\x1bP')
  if (lastDcs !== -1 && !raw.slice(lastDcs).includes('\x1b\\')) {
    return { flushable: raw.slice(0, lastDcs), remainder: raw.slice(lastDcs) }
  }

  const lastEsc = raw.lastIndexOf('\x1b')
  if (lastEsc === -1) {
    return { flushable: raw, remainder: '' }
  }
  const tail = raw.slice(lastEsc)

  if (tail.startsWith('\x1b[')) {
    const hasFinalByte = /^[\x20-\x3f]*[\x40-\x7e]/.test(tail.slice(2))
    return hasFinalByte
      ? { flushable: raw, remainder: '' }
      : { flushable: raw.slice(0, lastEsc), remainder: tail }
  }

  if (tail.startsWith('\x1b]')) {
    const body = tail.slice(2)
    const hasTerminator = body.includes('\x07') || body.includes('\x1b\\')
    return hasTerminator
      ? { flushable: raw, remainder: '' }
      : { flushable: raw.slice(0, lastEsc), remainder: tail }
  }

  // Any other escape introducer is a single byte plus a single following byte.
  if (tail.length >= 2) {
    return { flushable: raw, remainder: '' }
  }
  return { flushable: raw.slice(0, lastEsc), remainder: tail }
}

let captureStdin: NodeJS.ReadStream | null = null
let decoder: TextDecoder | null = null
let dataListener: ((chunk: Buffer) => void) | null = null
let wasRawMode = false
let pendingRaw = ''
let capturedText = ''

/** Seam for tests: invoked instead of process.exit once the terminal is restored. */
export type EarlyInputExitHook = (exitCode: number) => void

const defaultExitHook: EarlyInputExitHook = (exitCode) => {
  process.exit(exitCode)
}

let exitHook: EarlyInputExitHook = defaultExitHook

/**
 * Inject the exit hook used by the Ctrl+C path so tests observe the exit code
 * instead of dying. Pass null to restore the default process.exit behavior.
 */
export function setEarlyInputExitHook(hook: EarlyInputExitHook | null): void {
  exitHook = hook ?? defaultExitHook
}

/** Append extracted text, silently dropping anything past the capture cap. */
function appendExtracted(raw: string): void {
  if (!raw) return
  const remaining = MAX_CAPTURED_CHARS - capturedText.length
  if (remaining <= 0) return
  const extracted = extractPrintableText(raw)
  capturedText +=
    extracted.length > remaining ? extracted.slice(0, remaining) : extracted
}

/**
 * Ctrl+C while raw mode has ISIG disabled arrives as the 0x03 byte instead of
 * SIGINT, so without this handler the process would swallow it. Restore the
 * terminal BEFORE exiting, or the user's terminal is left in raw mode with the
 * renderer's modes still set, then exit with the SIGINT convention (130).
 */
function handleCtrlC(): void {
  try {
    if (captureStdin?.isTTY && captureStdin.setRawMode) {
      captureStdin.setRawMode(false)
    }
  } catch {
    // stdin may already be closed
  }
  try {
    // Best effort and unconditional: the reset must reach the user's terminal
    // even when stdout's TTY flag is unreliable mid-shutdown, and the
    // sequences are a no-op outside an alternate screen.
    process.stdout.write(TERMINAL_RESET_SEQUENCES)
  } catch {
    // stdout may already be closed
  }
  exitHook(CTRL_C_EXIT_CODE)
}

/**
 * Start capturing stdin bytes for the pre-render boot window.
 *
 * Idempotent while a capture is active, and a no-op unless stdin is a TTY (so
 * the non-renderer command paths never get a listener attached or raw mode
 * toggled). Records the prior raw mode state so stopEarlyInputCapture can
 * restore it, enables raw mode so keystrokes arrive byte-by-byte instead of
 * line-buffered, and attaches a 'data' listener (which itself starts flowing
 * mode) feeding a module-level TextDecoder in stream mode.
 */
export function startEarlyInputCapture(
  stdin: NodeJS.ReadStream = process.stdin,
): void {
  if (captureStdin) return
  if (!stdin.isTTY) return

  captureStdin = stdin
  decoder = new TextDecoder()
  pendingRaw = ''
  capturedText = ''
  wasRawMode = stdin.isRaw ?? false
  if (stdin.setRawMode) {
    try {
      stdin.setRawMode(true)
    } catch {
      // Continue without raw mode: a partial capture still beats dropping input
    }
  }

  dataListener = (chunk: Buffer) => {
    if (chunk.includes(CTRL_C_BYTE)) {
      handleCtrlC()
      return
    }
    if (!decoder) return
    const decoded = decoder.decode(chunk, { stream: true })
    if (capturedText.length >= MAX_CAPTURED_CHARS) {
      // Keep draining (the listener stays attached) but drop the overflow.
      return
    }
    pendingRaw += decoded
    const { flushable, remainder } = splitIncompleteEscapeTail(pendingRaw)
    pendingRaw = remainder
    appendExtracted(flushable)
  }
  stdin.on('data', dataListener)
}

/**
 * Stop the capture and return the printable text extracted so far (undefined
 * when nothing was captured).
 *
 * Removes the listener, restores the raw mode state recorded at start, and
 * flushes the bytes the decoder held for a multi-byte sequence split across
 * reads. NEVER pauses stdin — the renderer takes over immediately after — and
 * the captured text STAYS available for consumeCapturedEarlyInput, which is
 * how the Chat mount effect reads it. Safe when no capture is active.
 */
export function stopEarlyInputCapture(): string | undefined {
  if (dataListener && captureStdin) {
    try {
      captureStdin.removeListener('data', dataListener)
    } catch {
      // Never throw from cleanup
    }
  }
  if (captureStdin && captureStdin.isTTY && captureStdin.setRawMode) {
    try {
      captureStdin.setRawMode(wasRawMode)
    } catch {
      // Ignore errors restoring raw mode
    }
  }
  if (decoder) {
    // Final decode flush: emit the bytes the decoder buffered for a
    // multi-byte sequence split across reads.
    pendingRaw += decoder.decode()
    decoder = null
  }
  // The stream is over, so a still-incomplete escape tail can never complete:
  // extract only its flushable prefix. Held-back bytes always start at a
  // sequence introducer, so dropping the tail loses no typed text.
  appendExtracted(splitIncompleteEscapeTail(pendingRaw).flushable)
  pendingRaw = ''
  dataListener = null
  captureStdin = null
  return capturedText.length > 0 ? capturedText : undefined
}

/** Stop the capture and drop the captured text. */
export function discardEarlyInputCapture(): void {
  stopEarlyInputCapture()
  capturedText = ''
  pendingRaw = ''
}

/**
 * One-shot take of the captured text for the Chat mount replay. Stops the
 * capture if it is somehow still active (never leaves the listener attached
 * once the text has been handed off) and clears the module state, so Chat
 * remounts (chatKey changes) can never double-replay.
 */
export function consumeCapturedEarlyInput(): string | undefined {
  if (captureStdin) {
    stopEarlyInputCapture()
  }
  const text = capturedText.length > 0 ? capturedText : undefined
  capturedText = ''
  return text
}
