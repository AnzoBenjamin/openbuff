import { describe, expect, test } from 'bun:test'

import {
  buildOsc9Notification,
  buildOsc777Notification,
  notifyTerminal,
  sanitizeOscText,
  terminalSupportsOscNotify,
} from '../terminal-notify'

describe('terminal-notify (P1-T7)', () => {
  describe('sequence builders', () => {
    test('buildOsc9Notification emits ESC ] 9 ; body BEL', () => {
      expect(buildOsc9Notification('Done')).toBe('\x1b]9;Done\x07')
    })

    test('buildOsc777Notification emits ESC ] 777 ; notify ; title ; body BEL', () => {
      expect(buildOsc777Notification('openbuff', 'Approval needed')).toBe(
        '\x1b]777;notify;openbuff;Approval needed\x07',
      )
    })
  })

  describe('terminalSupportsOscNotify gate', () => {
    test('iTerm2 maps to osc9', () => {
      expect(terminalSupportsOscNotify({ TERM_PROGRAM: 'iTerm.app' })).toBe(
        'osc9',
      )
    })

    test('WezTerm maps to osc9', () => {
      expect(terminalSupportsOscNotify({ TERM_PROGRAM: 'WezTerm' })).toBe(
        'osc9',
      )
    })

    test('kitty maps to osc777', () => {
      expect(terminalSupportsOscNotify({ TERM: 'xterm-kitty' })).toBe('osc777')
    })

    test('foot maps to osc777', () => {
      expect(terminalSupportsOscNotify({ TERM: 'foot' })).toBe('osc777')
    })

    test('unknown terminal maps to none', () => {
      expect(terminalSupportsOscNotify({ TERM: 'xterm-256color' })).toBe('none')
      expect(terminalSupportsOscNotify({})).toBe('none')
    })
  })

  describe('notifyTerminal', () => {
    test('writes the OSC 9 sequence for iTerm2', () => {
      const writes: string[] = []
      notifyTerminal(
        { body: 'Turn complete' },
        { write: (s) => writes.push(s), env: { TERM_PROGRAM: 'iTerm.app' } },
      )
      expect(writes).toEqual(['\x1b]9;Turn complete\x07'])
    })

    test('writes the OSC 777 sequence for kitty, defaulting the title', () => {
      const writes: string[] = []
      notifyTerminal(
        { body: 'Approval needed' },
        { write: (s) => writes.push(s), env: { TERM: 'xterm-kitty' } },
      )
      expect(writes).toEqual(['\x1b]777;notify;openbuff;Approval needed\x07'])
    })

    test('writes nothing on an unsupported terminal', () => {
      const writes: string[] = []
      notifyTerminal(
        { body: 'Turn complete' },
        { write: (s) => writes.push(s), env: { TERM: 'xterm-256color' } },
      )
      expect(writes).toEqual([])
    })

    test('never throws when the write seam throws', () => {
      expect(() =>
        notifyTerminal(
          { body: 'Turn complete' },
          {
            write: () => {
              throw new Error('tty write failed')
            },
            env: { TERM_PROGRAM: 'iTerm.app' },
          },
        ),
      ).not.toThrow()
    })

    test('sanitizes untrusted body text before emission (SEC)', () => {
      // The approval-needed body carries untrusted text (request.target);
      // an embedded ESC ... BEL must never forge a second escape sequence.
      const writes: string[] = []
      notifyTerminal(
        { body: 'approval needed for \x1b]9;rm -rf /\x07' },
        { write: (s) => writes.push(s), env: { TERM_PROGRAM: 'iTerm.app' } },
      )
      expect(writes).toEqual([
        '\x1b]9;approval needed for ]9;rm -rf /\x07',
      ])
    })
  })

  describe('sanitizeOscText (SEC: OSC injection defense)', () => {
    test('drops ESC, BEL, and other C0/C1 control characters', () => {
      expect(sanitizeOscText('a\x1bb\x07c\x00d\x7fe\u009f')).toBe('abcde')
    })

    test('drops bidi and zero-width characters', () => {
      // U+202E (RLO), U+200C/200D (zero-width), U+2060, U+FEFF, U+2067 (isolate).
      expect(
        sanitizeOscText('a\u202eb\u200cc\u200dd\u2060e\ufefff\u2067'),
      ).toBe('abcdef')
    })

    test('keeps ordinary text unchanged', () => {
      expect(sanitizeOscText('plain text ✓')).toBe('plain text ✓')
    })

    test('buildOsc9Notification neutralizes an injected OSC body', () => {
      expect(buildOsc9Notification('\x1b]9;pwned\x07')).toBe(
        '\x1b]9;]9;pwned\x07',
      )
    })

    test('buildOsc777Notification sanitizes both title and body', () => {
      expect(buildOsc777Notification('\u202Eevil', 'body\x1b]0;x')).toBe(
        '\x1b]777;notify;evil;body]0;x\x07',
      )
    })
  })
})
