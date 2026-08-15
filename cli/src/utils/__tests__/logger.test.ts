import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { pino } from 'pino'

let mockProjectRoot = ''
let mockChatDir = ''

mock.module('../../project-files', () => ({
  getProjectRoot: () => mockProjectRoot,
  getCurrentChatDir: () => mockChatDir,
}))

mock.module('@codebuff/common/env', () => ({
  ...import.meta.require('@codebuff/common/env'),
  env: {
    ...import.meta.require('@codebuff/common/env').env,
    NEXT_PUBLIC_CB_ENVIRONMENT: 'dev',
  },
  IS_DEV: true,
  IS_TEST: false,
  IS_CI: false,
}))

import {
  LOG_MAX_BYTES,
  clearLogFile,
  endPreviousPinoDestination,
  getLivePinoDestinationFd,
  logger,
  resetLogStream,
  rotateLogIfNeeded,
} from '../logger'

let tempDir: string

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-logger-'))
  mockProjectRoot = tempDir
  mockChatDir = path.join(tempDir, 'chat')
  fs.mkdirSync(mockChatDir, { recursive: true })
})

afterEach(() => {
  // Explicitly reset the logger's module-level state for test isolation:
  // clearLogFile() closes the live pino destination (clearing pinoLogger and
  // pinoDestination) and clears the pinned logPath, so no state can leak into
  // the next test. It must not throw here — a failure should fail loudly
  // instead of being swallowed.
  clearLogFile()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function writeSizedFile(filePath: string, size: number, contents?: string) {
  fs.writeFileSync(filePath, contents ?? '')
  fs.truncateSync(filePath, size)
}

describe('rotateLogIfNeeded', () => {
  test('leaves a file smaller than LOG_MAX_BYTES in place', () => {
    const livePath = path.join(tempDir, 'log.jsonl')
    writeSizedFile(livePath, LOG_MAX_BYTES - 1, 'under-cap')
    const before = fs.readFileSync(livePath)

    rotateLogIfNeeded(livePath)

    expect(fs.existsSync(livePath)).toBe(true)
    expect(fs.existsSync(`${livePath}.1`)).toBe(false)
    expect(fs.readFileSync(livePath)).toEqual(before)
    expect(fs.statSync(livePath).size).toBe(LOG_MAX_BYTES - 1)
  })

  test('renames a file at LOG_MAX_BYTES to a .1 sibling', () => {
    const livePath = path.join(tempDir, 'log.jsonl')
    writeSizedFile(livePath, LOG_MAX_BYTES, 'at-cap')
    const before = fs.readFileSync(livePath)

    rotateLogIfNeeded(livePath)

    expect(fs.existsSync(livePath)).toBe(false)
    expect(fs.existsSync(`${livePath}.1`)).toBe(true)
    expect(fs.readFileSync(`${livePath}.1`)).toEqual(before)
    expect(fs.statSync(`${livePath}.1`).size).toBe(LOG_MAX_BYTES)
  })

  test('replaces an existing .1 when rotating a new oversized file', () => {
    const livePath = path.join(tempDir, 'log.jsonl')
    const rotatedPath = `${livePath}.1`
    fs.writeFileSync(rotatedPath, 'old-rotated')
    writeSizedFile(livePath, LOG_MAX_BYTES, 'new-live')
    const liveContents = fs.readFileSync(livePath)

    rotateLogIfNeeded(livePath)

    expect(fs.existsSync(livePath)).toBe(false)
    expect(fs.existsSync(rotatedPath)).toBe(true)
    expect(fs.readFileSync(rotatedPath)).toEqual(liveContents)
    expect(fs.readFileSync(rotatedPath, 'utf8')).not.toContain('old-rotated')
  })

  test('is a no-op for a missing path and does not throw', () => {
    const livePath = path.join(tempDir, 'missing.jsonl')

    expect(() => rotateLogIfNeeded(livePath)).not.toThrow()
    expect(fs.existsSync(livePath)).toBe(false)
    expect(fs.existsSync(`${livePath}.1`)).toBe(false)
  })

  test('never throws for an un-renamable target', () => {
    const livePath = path.join(tempDir, 'log.jsonl')
    writeSizedFile(livePath, LOG_MAX_BYTES, 'at-cap')
    const rotatedPath = `${livePath}.1`
    fs.mkdirSync(rotatedPath)
    fs.writeFileSync(path.join(rotatedPath, 'blocker'), 'cannot-replace-dir')

    expect(() => rotateLogIfNeeded(livePath)).not.toThrow()
    expect(fs.existsSync(livePath)).toBe(true)
    expect(fs.statSync(livePath).isFile()).toBe(true)
    expect(fs.statSync(rotatedPath).isDirectory()).toBe(true)
  })

  test('after rotate + resetLogStream the next write uses the live path inode', () => {
    const livePath = path.join(tempDir, 'log.jsonl')
    resetLogStream(livePath)
    writeSizedFile(livePath, LOG_MAX_BYTES, 'pre-rotate-live')
    const originalIno = fs.statSync(livePath).ino

    // Prod write path: close dest before rotate so Windows rename is not EBUSY.
    endPreviousPinoDestination()
    rotateLogIfNeeded(livePath)
    expect(fs.existsSync(livePath)).toBe(false)
    expect(fs.statSync(`${livePath}.1`).ino).toBe(originalIno)

    expect(() => resetLogStream(livePath)).not.toThrow()
    // Prove resetLogStream itself reopened a live dest: if it were a no-op
    // the path would still be missing after rotate. Do not append first —
    // that would create the file even when reset is a no-op and would not
    // prove pino's destination missed `.1`.
    expect(fs.existsSync(livePath)).toBe(true)
    const liveIno = fs.statSync(livePath).ino
    if (originalIno !== 0 && liveIno !== 0) {
      expect(liveIno).not.toBe(originalIno)
    }
    expect(fs.statSync(`${livePath}.1`).ino).toBe(originalIno)
    expect(fs.readFileSync(`${livePath}.1`, 'utf8')).toContain('pre-rotate-live')
  })

  test('prod sequence closes the live dest before rotate so rename does not need unlink-of-open-fd', () => {
    const livePath = path.join(tempDir, 'log.jsonl')
    resetLogStream(livePath)
    writeSizedFile(livePath, LOG_MAX_BYTES, 'pre-rotate-live')
    const originalIno = fs.statSync(livePath).ino
    const liveFd = getLivePinoDestinationFd()
    expect(typeof liveFd).toBe('number')
    expect(() => fs.fstatSync(liveFd!)).not.toThrow()

    // Prod write path: close dest, rotate, resetLogStream.
    expect(() => endPreviousPinoDestination()).not.toThrow()
    expect(() => fs.fstatSync(liveFd!)).toThrow()
    expect(() => endPreviousPinoDestination()).not.toThrow()

    expect(() => rotateLogIfNeeded(livePath)).not.toThrow()
    expect(fs.existsSync(livePath)).toBe(false)
    expect(fs.existsSync(`${livePath}.1`)).toBe(true)
    expect(fs.readFileSync(`${livePath}.1`, 'utf8')).toContain('pre-rotate-live')
    if (originalIno !== 0) {
      expect(fs.statSync(`${livePath}.1`).ino).toBe(originalIno)
    }

    expect(() => resetLogStream(livePath)).not.toThrow()
    expect(fs.existsSync(livePath)).toBe(true)
    const reopenedFd = getLivePinoDestinationFd()
    expect(typeof reopenedFd).toBe('number')
    // The OS may recycle the numeric fd after closeSync; prove the old dest
    // stayed closed through rotate, then a live dest is open again.
    expect(() => fs.fstatSync(reopenedFd!)).not.toThrow()
    const liveIno = fs.statSync(livePath).ino
    if (originalIno !== 0 && liveIno !== 0) {
      expect(liveIno).not.toBe(originalIno)
    }
  })

  test('IS_DEV write path does not throw when pino dest fails and never reopens SonicBoom', () => {
    const livePath = path.join(tempDir, 'log.jsonl')
    resetLogStream(livePath)
    writeSizedFile(livePath, LOG_MAX_BYTES, 'pre-rotate-live')
    const liveFd = getLivePinoDestinationFd()
    expect(typeof liveFd).toBe('number')
    expect(() => fs.fstatSync(liveFd!)).not.toThrow()

    const destSpy = spyOn(pino, 'destination').mockImplementation(() => {
      throw new Error('destination failed')
    })
    try {
      expect(() => logger.info('after-failed-reset')).not.toThrow()
      expect(getLivePinoDestinationFd()).toBeUndefined()
    } finally {
      destSpy.mockRestore()
    }

    // Dev writes via appendFileSync to debug/cli.jsonl and must not reopen pino.
    expect(() => logger.info('recovered-write')).not.toThrow()
    expect(getLivePinoDestinationFd()).toBeUndefined()
    const debugLog = path.join(tempDir, 'debug', 'cli.jsonl')
    expect(fs.existsSync(debugLog)).toBe(true)
    expect(fs.readFileSync(debugLog, 'utf8')).toContain('recovered-write')
  })

  test('IS_DEV write path rotates oversized debug/cli.jsonl without a live dest', () => {
    const debugLog = path.join(tempDir, 'debug', 'cli.jsonl')
    fs.mkdirSync(path.dirname(debugLog), { recursive: true })
    writeSizedFile(debugLog, LOG_MAX_BYTES, 'pre-rotate-debug')
    // Set up module state explicitly so this test is self-contained: pin
    // logPath to debugLog with a live destination open, exactly what a prior
    // dev session would leave behind — no reliance on state from other tests.
    resetLogStream(debugLog)
    const leftoverFd = getLivePinoDestinationFd()
    expect(typeof leftoverFd).toBe('number')

    expect(() => logger.info('post-rotate-debug')).not.toThrow()

    expect(getLivePinoDestinationFd()).toBeUndefined()
    expect(fs.existsSync(`${debugLog}.1`)).toBe(true)
    expect(fs.readFileSync(`${debugLog}.1`, 'utf8')).toContain('pre-rotate-debug')
    expect(fs.existsSync(debugLog)).toBe(true)
    expect(fs.statSync(debugLog).size).toBeLessThan(LOG_MAX_BYTES)
    expect(fs.readFileSync(debugLog, 'utf8')).toContain('post-rotate-debug')
  })
})

describe('clearLogFile', () => {
  test('removes an under-cap production log.jsonl', () => {
    const productionLog = path.join(mockChatDir, 'log.jsonl')
    writeSizedFile(productionLog, 64, 'under-cap-chat')

    clearLogFile()

    expect(fs.existsSync(productionLog)).toBe(false)
    expect(fs.existsSync(`${productionLog}.1`)).toBe(false)
  })

  test('removes an existing production .1 sibling', () => {
    const productionLog = path.join(mockChatDir, 'log.jsonl')
    fs.writeFileSync(`${productionLog}.1`, 'rotated-chat')

    clearLogFile()

    expect(fs.existsSync(`${productionLog}.1`)).toBe(false)
  })

  test('does not preserve an oversized live file as the remaining log', () => {
    const productionLog = path.join(mockChatDir, 'log.jsonl')
    writeSizedFile(productionLog, LOG_MAX_BYTES, 'oversized-live')

    clearLogFile()

    expect(fs.existsSync(productionLog)).toBe(false)
    expect(fs.existsSync(`${productionLog}.1`)).toBe(false)
  })

  test('removes debug/cli.jsonl and its .1 sibling', () => {
    const debugLog = path.join(tempDir, 'debug', 'cli.jsonl')
    fs.mkdirSync(path.dirname(debugLog), { recursive: true })
    fs.writeFileSync(debugLog, 'debug-live')
    fs.writeFileSync(`${debugLog}.1`, 'debug-rotated')

    clearLogFile()

    expect(fs.existsSync(debugLog)).toBe(false)
    expect(fs.existsSync(`${debugLog}.1`)).toBe(false)
  })

  test('unlinks an open live log after resetLogStream', () => {
    const productionLog = path.join(mockChatDir, 'log.jsonl')
    resetLogStream(productionLog)
    expect(fs.existsSync(productionLog)).toBe(true)
    const liveFd = getLivePinoDestinationFd()
    expect(typeof liveFd).toBe('number')
    expect(() => fs.fstatSync(liveFd!)).not.toThrow()

    clearLogFile()

    expect(() => fs.fstatSync(liveFd!)).toThrow()
    expect(fs.existsSync(productionLog)).toBe(false)
    expect(fs.existsSync(`${productionLog}.1`)).toBe(false)
  })
})
