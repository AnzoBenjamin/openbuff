/**
 * P1-T7: terminal notifications (OSC 9 / OSC 777) for approval-needed and
 * turn-done events. Pure sequence builders + a capability gate; nothing here
 * touches a real TTY — `notifyTerminal` takes an injected write seam so the
 * module is hermetic in tests and the wiring layer points it at the
 * controlling TTY (never stdout, which is reserved for the protocol wire).
 *
 * Everything is best-effort and fail-closed: an unsupported terminal yields
 * 'none' and `notifyTerminal` writes nothing.
 */

import { getCliEnv } from './env'

import type { CliEnv } from '../types/env'

/** The OSC notification flavor a terminal supports. */
export type OscNotifyKind = 'osc9' | 'osc777' | 'none'

/**
 * C0/C1 control characters (including ESC and BEL, which could terminate or
 * forge an escape sequence), bidi marks, and zero-width/invisible characters
 * that must never reach an OSC payload.
 */
const OSC_FORBIDDEN_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g

/**
 * SEC: sanitize untrusted notification text (e.g. an approval-needed body
 * carrying `request.target`) BEFORE it is interpolated into an escape
 * sequence. Control characters could terminate the OSC payload and forge
 * arbitrary terminal escapes; bidi/zero-width characters could spoof what
 * the user sees. Forbidden characters are dropped (not replaced) so the
 * emitted payload stays a plain, single-OSC text run.
 */
export function sanitizeOscText(text: string): string {
  return text.replace(OSC_FORBIDDEN_CHARACTERS, '')
}

/** OSC 9 (iTerm2/kitty/WezTerm): ESC ] 9 ; <body> BEL. Body is sanitized. */
export function buildOsc9Notification(body: string): string {
  return `\x1b]9;${sanitizeOscText(body)}\x07`
}

/**
 * OSC 777 (kitty/foot): ESC ] 777 ; notify ; <title> ; <body> BEL. Title and
 * body are both sanitized.
 */
export function buildOsc777Notification(title: string, body: string): string {
  return `\x1b]777;notify;${sanitizeOscText(title)};${sanitizeOscText(body)}\x07`
}

/**
 * Which OSC notification flavor the terminal supports, from TERM_PROGRAM/TERM.
 * kitty + foot speak OSC 777; iTerm2 + WezTerm speak OSC 9. Anything else
 * (including tmux/screen without a known inner terminal, and non-TTY) is
 * 'none' so the caller writes nothing.
 */
export function terminalSupportsOscNotify(
  env: Pick<CliEnv, 'TERM_PROGRAM' | 'TERM'> = getCliEnv(),
): OscNotifyKind {
  const termProgram = env.TERM_PROGRAM ?? ''
  const term = env.TERM ?? ''

  if (termProgram === 'iTerm.app' || termProgram === 'WezTerm') return 'osc9'
  if (term === 'xterm-kitty' || term.includes('kitty')) return 'osc777'
  if (term.includes('foot')) return 'osc777'

  return 'none'
}

export type NotifyTerminalDeps = {
  /** Injected write seam (the wiring layer points this at the TTY). */
  write: (sequence: string) => void
  /** Optional env override for tests; defaults to the live CLI env. */
  env?: Pick<CliEnv, 'TERM_PROGRAM' | 'TERM'>
}

/**
 * Emit a terminal notification for an approval-needed / turn-done event.
 * Writes ONLY when the terminal supports an OSC notification flavor; on an
 * unsupported terminal this is a no-op. Never throws.
 */
export function notifyTerminal(
  opts: { body: string; title?: string },
  deps: NotifyTerminalDeps,
): void {
  const kind = terminalSupportsOscNotify(deps.env ?? getCliEnv())
  if (kind === 'none') return
  try {
    if (kind === 'osc9') {
      deps.write(buildOsc9Notification(opts.body))
    } else {
      deps.write(buildOsc777Notification(opts.title ?? 'openbuff', opts.body))
    }
  } catch {
    // Fail closed: a notification write error must never break the TUI.
  }
}
