import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { setProjectRootResolver } from '@codebuff/common/util/plan-artifacts'

let mockProjectRoot = ''
let mockChatDir = ''

// Full stub: do not import.meta.require('../../project-files') inside this
// mock factory (bun deadlocks on a self-require). setProjectRoot still wires
// the plan-artifact resolver so command-args / plan-timeline in the same
// process keep working.
mock.module('../../project-files', () => ({
  setProjectRoot: (dir: string) => {
    mockProjectRoot = dir
    setProjectRootResolver(() => mockProjectRoot)
    return dir
  },
  getProjectRoot: () => {
    if (!mockProjectRoot) {
      throw new Error('Project root not set')
    }
    return mockProjectRoot
  },
  getCurrentChatDir: () => {
    if (mockChatDir) return mockChatDir
    if (!mockProjectRoot) {
      throw new Error('Project root not set')
    }
    return path.join(mockProjectRoot, 'chat')
  },
  getProjectDataDir: () => mockProjectRoot,
  getProjectStorageKey: (root: string) => path.basename(root) || 'project',
  getCurrentChatId: () => 'logger-test-chat',
  setCurrentChatId: (chatId: string) => chatId,
  startNewChat: () => 'logger-test-chat',
  getMostRecentChatDir: () => null,
}))

import { setProjectRoot } from '../../project-files'
import {
  LOG_MAX_BYTES,
  clearLogFile,
  endPreviousPinoDestination,
  getLivePinoDestinationFd,
  resetLogStream,
  rotateLogIfNeeded,
} from '../logger'

let tempDir: string

function writeSizedFile(filePath: string, size: number, contents?: string) {
  fs.writeFileSync(filePath, contents ?? '')
  fs.truncateSync(filePath, size)
}

function setupLoggerTempDir() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-logger-'))
  mockChatDir = path.join(tempDir, 'chat')
  fs.mkdirSync(mockChatDir, { recursive: true })
  setProjectRoot(tempDir)
}

function teardownLoggerTempDir() {
  clearLogFile()
  mockChatDir = ''
  fs.rmSync(tempDir, { recursive: true, force: true })
}

describe('rotateLogIfNeeded', () => {
  beforeEach(setupLoggerTempDir)
  afterEach(teardownLoggerTempDir)

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

  test('resetLogStream dest-fail leaves fd undefined then reopens after path is restored', () => {
    // Force dest-open failure via the filesystem: parent path is a file so
    // mkdir / pino.destination cannot create the log. Do not spyOn destination;
    // that spy does not intercept on CI bun and leaks across the process.
    // Under IS_TEST/IS_CI, sendAnalyticsAndLog returns before dest I/O, so
    // logger.info cannot prove recovery — assert resetLogStream + fd only.
    const logDir = path.join(tempDir, 'dest-fail-dir')
    fs.mkdirSync(logDir, { recursive: true })
    const livePath = path.join(logDir, 'log.jsonl')
    // Pin dest first so we can prove close + failed reopen leave fd undefined.
    resetLogStream(livePath)
    expect(typeof getLivePinoDestinationFd()).toBe('number')
    endPreviousPinoDestination()
    fs.rmSync(logDir, { recursive: true, force: true })
    fs.writeFileSync(logDir, 'i-am-a-file')

    expect(() => resetLogStream(livePath)).not.toThrow()
    expect(getLivePinoDestinationFd()).toBeUndefined()

    fs.unlinkSync(logDir)
    fs.mkdirSync(logDir, { recursive: true })
    expect(() => resetLogStream(livePath)).not.toThrow()
    expect(typeof getLivePinoDestinationFd()).toBe('number')
  })

  test('helper prod sequence on debug path: close dest, rotate oversized file, resetLogStream reopens dest', () => {
    const debugLog = path.join(tempDir, 'debug', 'cli.jsonl')
    fs.mkdirSync(path.dirname(debugLog), { recursive: true })
    // Pin dest first so resetLogStream cannot recreate/truncate a 0-byte file
    // and skip rotation. Size the live file after the dest is open.
    // This is the helper prod sequence (debug path): close + rotate + reset.
    // logger.info is a no-throw no-op under IS_TEST/IS_CI and is not used here.
    resetLogStream(debugLog)
    writeSizedFile(debugLog, LOG_MAX_BYTES, 'pre-rotate-debug')
    const leftoverFd = getLivePinoDestinationFd()
    expect(typeof leftoverFd).toBe('number')

    endPreviousPinoDestination()
    rotateLogIfNeeded(debugLog)
    expect(() => resetLogStream(debugLog)).not.toThrow()
    expect(typeof getLivePinoDestinationFd()).toBe('number')

    expect(fs.existsSync(`${debugLog}.1`)).toBe(true)
    expect(fs.readFileSync(`${debugLog}.1`, 'utf8')).toContain('pre-rotate-debug')
    expect(fs.existsSync(debugLog)).toBe(true)
    expect(fs.statSync(debugLog).size).toBeLessThan(LOG_MAX_BYTES)
    fs.appendFileSync(debugLog, 'post-rotate-debug\n')
    expect(fs.readFileSync(debugLog, 'utf8')).toContain('post-rotate-debug')
  })
})

describe('clearLogFile', () => {
  beforeEach(setupLoggerTempDir)
  afterEach(teardownLoggerTempDir)

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
