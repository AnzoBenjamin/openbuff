import { describe, expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const wrapper = require('../../release/index.js')

describe('canonical install and update outcomes', () => {
  test('redirected progress is throttled to readable newline records and narrow TTY output fits', () => {
    const redirected: string[] = []
    let time = 0
    const write = wrapper.createProgressWriter(
      {
        isTTY: false,
        columns: 60,
        write: (text: string) => redirected.push(text),
      },
      () => time,
    )
    write('Downloading 1%')
    for (time = 100; time < 1000; time += 100) write('Downloading 2%')
    write('Downloading 100%')
    expect(redirected).toEqual(['Downloading 1%\n', 'Downloading 100%\n'])
    const tty: string[] = []
    wrapper.createProgressWriter({
      isTTY: true,
      columns: 60,
      write: (text: string) => tty.push(text),
    })('Downloading ' + wrapper.createProgressBar(80) + ' 80% 200 MB/300 MB')
    expect(tty[0]!.replace(/\r\x1b\[K/, '').length).toBeLessThan(60)
  })
  test('overshoot, malformed percentages and narrow progress never throw', () => {
    for (const percent of [110, -5, NaN, Infinity]) {
      expect(() => wrapper.createProgressBar(percent, 12)).not.toThrow()
      expect(wrapper.createProgressBar(percent, 12).length).toBe(14)
    }
    expect(wrapper.createProgressBar(110, 12)).toBe('[############]')
    expect(wrapper.formatBytes(NaN)).toBe('0 B')
    expect(wrapper.compareVersions('1.0.0-alpha-1', '1.0.0-alpha-2')).toBe(-1)
  })
  test('permission, verification and extraction receive distinct recovery classifications', () => {
    expect(
      wrapper.classifyInstallFailure(
        Object.assign(new Error('metadata write'), { code: 'EACCES' }),
      ),
    ).toBe('permission')
    expect(wrapper.classifyInstallFailure(new Error('Checksum mismatch'))).toBe(
      'verification',
    )
    expect(
      wrapper.classifyInstallFailure(
        new Error('Release archive has missing binary'),
      ),
    ).toBe('extraction')
    const advice: string[] = []
    wrapper.printInstallFailureGuidance(
      () => null,
      (line: string) => advice.push(line),
      Object.assign(new Error('metadata write'), { code: 'EACCES' }),
    )
    expect(advice.join('\n')).toContain('write permissions')
    expect(advice.join('\n')).not.toContain('internet')
  })
  test('staged checksum failure identifies verification recovery and preserves the working binary', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'openbuff-staged-checksum-'))
    const binaryPath = path.join(root, 'openbuff')
    const metadataPath = path.join(root, 'metadata.json')
    const messages: string[] = []
    try {
      writeFileSync(binaryPath, 'working binary')
      writeFileSync(
        metadataPath,
        JSON.stringify({ version: '1.0.0', pendingVersion: '2.0.0' }),
      )
      await wrapper.ensureBinaryExists({
        config: { configDir: root, binaryPath, metadataPath },
        currentVersion: '1.0.0',
        pendingVersion: '2.0.0',
        packagedVersion: null,
        getProxyUrl: () => null,
        downloadBinary: async () => {
          throw new Error('Checksum verification failed for release asset')
        },
        consoleError: (line: string) => messages.push(line),
      })
      expect(messages.join('\n')).toContain('keeping current version 1.0.0')
      expect(messages.join('\n')).toContain(
        'Release verification failed before installation',
      )
      expect(messages.join('\n')).toContain('openbuff --update')
      expect(messages.join('\n')).not.toContain('internet connection')
      expect(readFileSync(binaryPath, 'utf8')).toBe('working binary')
      expect(JSON.parse(readFileSync(metadataPath, 'utf8'))).toMatchObject({
        version: '1.0.0',
        failedPendingVersion: { version: '2.0.0' },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  test('failed crash quarantine and metadata writes produce an accurate receipt', () => {
    const logs: string[] = []
    const result = wrapper.quarantineCrashedBinary(
      {
        binaryPath: '/injected/binary',
        metadataPath: '/injected/nonexistent/metadata.json',
      },
      {
        rename: () => {
          throw new Error('denied')
        },
        writeMetadataPatch: () => {
          throw new Error('denied')
        },
        consoleError: (line: string) => logs.push(line),
      },
    )
    expect(result).toEqual({
      quarantined: false,
      recorded: false,
      exhausted: false,
    })
    expect(logs.join('\n')).toContain(
      'quarantine failed, recovery metadata failed',
    )
    expect(logs.join('\n')).not.toContain('quarantined the binary')
    expect(logs.join('\n')).toContain('openbuff --update')
  })
  test('successful and failed background checks retain truthful source freshness', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'openbuff-update-freshness-'))
    const metadataPath = path.join(root, 'metadata.json')
    try {
      const options = {
        config: { metadataPath },
        currentVersion: '1.0.0',
        writePendingUpdateVersion: () => {},
      }
      await wrapper.checkForUpdates({
        ...options,
        getLatestVersion: async () => '1.0.0',
      })
      const success = JSON.parse(readFileSync(metadataPath, 'utf8')).updateCheck
      expect(success.latestVersion).toBe('1.0.0')
      expect(success.source).toBe('npm registry')
      expect(Number.isFinite(Date.parse(success.checkedAt))).toBe(true)
      await wrapper.checkForUpdates({
        ...options,
        getLatestVersion: async () => {
          throw Object.assign(new Error('metadata permission'), {
            code: 'EACCES',
          })
        },
      })
      const failed = JSON.parse(readFileSync(metadataPath, 'utf8')).updateCheck
      expect(failed.checkedAt).toBe(success.checkedAt)
      expect(failed.failureKind).toBe('permission')
      expect(Number.isFinite(Date.parse(failed.lastFailureAt))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
