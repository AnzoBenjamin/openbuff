import { describe, expect, test } from 'bun:test'

import {
  buildOsc9Notification,
  buildOsc777Notification,
  notifyTerminal,
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
  })
})
