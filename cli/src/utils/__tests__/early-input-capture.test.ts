import { describe, test, expect, afterEach, spyOn } from 'bun:test'
import { EventEmitter } from 'events'

import {
  consumeCapturedEarlyInput,
  discardEarlyInputCapture,
  extractPrintableText,
  setEarlyInputExitHook,
  splitIncompleteEscapeTail,
  startEarlyInputCapture,
  stopEarlyInputCapture,
} from '../early-input-capture'

/**
 * Hermetic fake stdin: startEarlyInputCapture takes the stream as a
 * dependency-injected argument, so these tests never touch (or mock.module)
 * the real process.stdin.
 */
class FakeStdin extends EventEmitter {
  isTTY = true
  isRaw: boolean | null = false
  readableFlowing: boolean | null = false
  readonly rawModeCalls: boolean[] = []
  pauseCount = 0

  setRawMode(mode: boolean): void {
    this.isRaw = mode
    this.rawModeCalls.push(mode)
  }

  pause(): void {
    this.pauseCount++
  }

  resume(): void {
    this.readableFlowing = true
  }

  emitData(chunk: string | Buffer): void {
    this.emit(
      'data',
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'),
    )
  }

  dataListenerCount(): number {
    return this.listenerCount('data')
  }
}

const asStdin = (fake: FakeStdin): NodeJS.ReadStream =>
  fake as unknown as NodeJS.ReadStream

afterEach(() => {
  discardEarlyInputCapture()
  setEarlyInputExitHook(null)
})

// ============================================================================
// extractPrintableText Tests
// ============================================================================

describe('extractPrintableText', () => {
  test('keeps bracketed-paste content and strips the markers', () => {
    expect(extractPrintableText('\x1b[200~hello world\x1b[201~')).toBe(
      'hello world',
    )
  })

  test('strips CSI sequences', () => {
    expect(extractPrintableText('\x1b[A\x1b[1;2Dleft')).toBe('left')
    expect(extractPrintableText('\x1b[?1049h\x1b[?2004h')).toBe('')
  })

  test('strips OSC sequences terminated by BEL', () => {
    expect(extractPrintableText('\x1b]11;rgb:ff/00/80\x07ok')).toBe('ok')
  })

  test('strips OSC sequences terminated by ST', () => {
    expect(extractPrintableText('\x1b]0;title\x1b\\ok')).toBe('ok')
  })

  test('maps carriage returns to newlines', () => {
    expect(extractPrintableText('a\rb')).toBe('a\nb')
  })

  test('keeps tabs', () => {
    expect(extractPrintableText('a\tb')).toBe('a\tb')
  })

  test('drops other control bytes', () => {
    expect(extractPrintableText('a\x00b\x07c\x0bd\x0ce\x7f')).toBe('abcde')
  })

  test('drops a stray ESC byte but keeps the following text', () => {
    expect(extractPrintableText('\x1bhi')).toBe('hi')
  })

  test('strips a tmux DCS passthrough wrapped around an OSC reply', () => {
    // Shape pinned by the OSC tests ("handles tmux passthrough response"): the
    // doubled ESCs hide the inner OSC, so without DCS handling the
    // passthrough's own text would land in the input box.
    const raw =
      '\x1bPtmux;\x1b\x1b]11;rgb:1e/1e/2e\x1b\x1b\\\x1b\\'
    expect(extractPrintableText(raw)).toBe('')
  })

  test('strips a bare ST terminator left behind by a passthrough', () => {
    expect(extractPrintableText('a\x1b\\b')).toBe('ab')
  })

  test('keeps printable ASCII and UTF-8 text', () => {
    expect(extractPrintableText('hello — 你好 🎉')).toBe('hello — 你好 🎉')
  })

  test('extracts typed text out of a mixed boot chunk', () => {
    // The OSC probe response and a bracketed paste can share a single read.
    const raw = '\x1b]11;rgb:1c1c/1c1c/1e1e\x07\x1b[200~fix the bug\x1b[201~'
    expect(extractPrintableText(raw)).toBe('fix the bug')
  })
})

// ============================================================================
// splitIncompleteEscapeTail Tests
// ============================================================================

describe('splitIncompleteEscapeTail', () => {
  test('flushes everything when no escape sequence is pending', () => {
    expect(splitIncompleteEscapeTail('hello')).toEqual({
      flushable: 'hello',
      remainder: '',
    })
  })

  test('holds back a CSI sequence missing its final byte', () => {
    expect(splitIncompleteEscapeTail('a\x1b[20')).toEqual({
      flushable: 'a',
      remainder: '\x1b[20',
    })
  })

  test('holds back an OSC sequence missing its terminator', () => {
    expect(splitIncompleteEscapeTail('a\x1b]11;rgb')).toEqual({
      flushable: 'a',
      remainder: '\x1b]11;rgb',
    })
  })

  test('flushes complete CSI and OSC sequences', () => {
    expect(splitIncompleteEscapeTail('a\x1b[200~b')).toEqual({
      flushable: 'a\x1b[200~b',
      remainder: '',
    })
    expect(splitIncompleteEscapeTail('a\x1b]0;t\x07b')).toEqual({
      flushable: 'a\x1b]0;t\x07b',
      remainder: '',
    })
  })

  test('holds back a lone trailing ESC', () => {
    expect(splitIncompleteEscapeTail('a\x1b')).toEqual({
      flushable: 'a',
      remainder: '\x1b',
    })
  })

  test('holds back a truncated tmux DCS passthrough', () => {
    // The DCS body contains ESC bytes, so the hold must start at the ESC P
    // introducer, not at the trailing ESC inside the body.
    expect(splitIncompleteEscapeTail('abc\x1bPtmux;\x1b')).toEqual({
      flushable: 'abc',
      remainder: '\x1bPtmux;\x1b',
    })
  })

  test('flushes a terminated DCS passthrough', () => {
    const dcs =
      '\x1bPtmux;\x1b\x1b]11;rgb:1e/1e/2e\x1b\x1b\\\x1b\\'
    expect(splitIncompleteEscapeTail(`a${dcs}`)).toEqual({
      flushable: `a${dcs}`,
      remainder: '',
    })
  })
})

// ============================================================================
// Capture lifecycle Tests
// ============================================================================

describe('early input capture lifecycle', () => {
  test('no-ops without a TTY', () => {
    const fake = new FakeStdin()
    fake.isTTY = false
    startEarlyInputCapture(asStdin(fake))
    expect(fake.dataListenerCount()).toBe(0)
    expect(fake.rawModeCalls).toEqual([])
    expect(stopEarlyInputCapture()).toBeUndefined()
  })

  test('is idempotent while a capture is active', () => {
    const fake = new FakeStdin()
    startEarlyInputCapture(asStdin(fake))
    startEarlyInputCapture(asStdin(new FakeStdin()))
    expect(fake.dataListenerCount()).toBe(1)
    expect(fake.rawModeCalls).toEqual([true])
  })

  test('captures printable text, stops cleanly, and never pauses stdin', () => {
    const fake = new FakeStdin()
    startEarlyInputCapture(asStdin(fake))
    expect(fake.isRaw).toBe(true)
    fake.emitData('hello')
    const captured = stopEarlyInputCapture()
    expect(captured).toBe('hello')
    expect(fake.dataListenerCount()).toBe(0)
    expect(fake.pauseCount).toBe(0)
    // Raw mode restored to the pre-capture (off) state.
    expect(fake.rawModeCalls).toEqual([true, false])
  })

  test('restores the prior raw state when capture started with raw mode on', () => {
    const fake = new FakeStdin()
    fake.isRaw = true
    startEarlyInputCapture(asStdin(fake))
    stopEarlyInputCapture()
    expect(fake.rawModeCalls).toEqual([true, true])
  })

  test('ignores data that arrives after stop', () => {
    const fake = new FakeStdin()
    startEarlyInputCapture(asStdin(fake))
    fake.emitData('abc')
    stopEarlyInputCapture()
    fake.emitData('def')
    expect(consumeCapturedEarlyInput()).toBe('abc')
    expect(fake.pauseCount).toBe(0)
  })

  test('consume is one-shot', () => {
    const fake = new FakeStdin()
    startEarlyInputCapture(asStdin(fake))
    fake.emitData('abc')
    stopEarlyInputCapture()
    expect(consumeCapturedEarlyInput()).toBe('abc')
    expect(consumeCapturedEarlyInput()).toBeUndefined()
  })

  test('discard stops the capture and drops the text', () => {
    const fake = new FakeStdin()
    startEarlyInputCapture(asStdin(fake))
    fake.emitData('abc')
    discardEarlyInputCapture()
    expect(fake.dataListenerCount()).toBe(0)
    expect(consumeCapturedEarlyInput()).toBeUndefined()
  })

  test('stop is safe when no capture is active', () => {
    expect(stopEarlyInputCapture()).toBeUndefined()
  })

  test('reassembles a bracketed-paste marker split across reads', () => {
    const fake = new FakeStdin()
    startEarlyInputCapture(asStdin(fake))
    fake.emitData('\x1b[20')
    fake.emitData('0~pasted')
    fake.emitData('\x1b[201~')
    stopEarlyInputCapture()
    expect(consumeCapturedEarlyInput()).toBe('pasted')
  })

  test('decodes multi-byte UTF-8 split across reads', () => {
    const bytes = Buffer.from('héllo', 'utf8')
    const fake = new FakeStdin()
    startEarlyInputCapture(asStdin(fake))
    fake.emitData(bytes.subarray(0, 2))
    fake.emitData(bytes.subarray(2))
    expect(consumeCapturedEarlyInput()).toBe('héllo')
  })

  test('strips an OSC response that shares the boot window', () => {
    const fake = new FakeStdin()
    startEarlyInputCapture(asStdin(fake))
    fake.emitData('\x1b]11;rgb:1c1c/1c1c/1e1e\x07')
    fake.emitData('typed')
    stopEarlyInputCapture()
    expect(consumeCapturedEarlyInput()).toBe('typed')
  })

  test('reassembles a tmux-wrapped OSC reply split across reads', () => {
    const fake = new FakeStdin()
    startEarlyInputCapture(asStdin(fake))
    fake.emitData('\x1bPtmux;')
    fake.emitData(
      '\x1b\x1b]11;rgb:1e/1e/2e\x1b\x1b\\\x1b\\',
    )
    fake.emitData('typed')
    stopEarlyInputCapture()
    expect(consumeCapturedEarlyInput()).toBe('typed')
  })

  test('drops a still-incomplete escape tail when capture stops', () => {
    const fake = new FakeStdin()
    startEarlyInputCapture(asStdin(fake))
    fake.emitData('hi')
    fake.emitData('\x1b[2')
    stopEarlyInputCapture()
    expect(consumeCapturedEarlyInput()).toBe('hi')
  })
})

// ============================================================================
// Capture bound Tests
// ============================================================================

describe('early input capture bound', () => {
  test('caps the captured text at 4096 extracted chars', () => {
    const fake = new FakeStdin()
    startEarlyInputCapture(asStdin(fake))
    fake.emitData('a'.repeat(5000))
    stopEarlyInputCapture()
    expect(consumeCapturedEarlyInput()).toBe('a'.repeat(4096))
  })

  test('caps across multiple reads', () => {
    const fake = new FakeStdin()
    startEarlyInputCapture(asStdin(fake))
    fake.emitData('a'.repeat(3000))
    fake.emitData('b'.repeat(3000))
    stopEarlyInputCapture()
    expect(consumeCapturedEarlyInput()).toBe(
      'a'.repeat(3000) + 'b'.repeat(1096),
    )
  })

  test('keeps draining but drops overflow past the cap', () => {
    const fake = new FakeStdin()
    startEarlyInputCapture(asStdin(fake))
    fake.emitData('a'.repeat(4096))
    fake.emitData('overflow')
    stopEarlyInputCapture()
    expect(consumeCapturedEarlyInput()).toBe('a'.repeat(4096))
  })
})

// ============================================================================
// Ctrl+C Tests
// ============================================================================

describe('early input capture Ctrl+C', () => {
  test('restores the terminal, writes the reset sequences, and exits 130', () => {
    const exitCodes: number[] = []
    setEarlyInputExitHook((exitCode) => {
      exitCodes.push(exitCode)
    })
    const writeSpy = spyOn(process.stdout, 'write').mockReturnValue(true)
    try {
      const fake = new FakeStdin()
      startEarlyInputCapture(asStdin(fake))
      fake.emitData('\x03')
      expect(exitCodes).toEqual([130])
      // Raw mode off BEFORE the exit hook ran, so the terminal is left sane.
      expect(fake.rawModeCalls).toEqual([true, false])
      const written = writeSpy.mock.calls.map((call) => String(call[0])).join('')
      expect(written).toContain('\x1b[?1049l')
    } finally {
      writeSpy.mockRestore()
    }
  })

  test('still captures text typed before the Ctrl+C byte', () => {
    // The injected hook does not exit, so the capture state stays observable.
    setEarlyInputExitHook(() => {})
    const writeSpy = spyOn(process.stdout, 'write').mockReturnValue(true)
    try {
      const fake = new FakeStdin()
      startEarlyInputCapture(asStdin(fake))
      fake.emitData('before')
      fake.emitData('\x03')
      expect(stopEarlyInputCapture()).toBe('before')
    } finally {
      writeSpy.mockRestore()
    }
  })
})
