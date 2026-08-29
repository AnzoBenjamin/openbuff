import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { createRequire } from 'module'
import { Readable } from 'stream'

import { describe, expect, test } from 'bun:test'

const repoRoot = path.resolve(__dirname, '../../..')
const require = createRequire(import.meta.url)
const wrappers = [
  ['release', 'cli/release/index.js'],
  ['release-staging', 'cli/release-staging/index.js'],
] as const
type WrapperName = (typeof wrappers)[number][0]
const wrapperVersions: Record<WrapperName, string> = {
  release: JSON.parse(
    readFileSync(path.join(repoRoot, 'cli/release/package.json'), 'utf8'),
  ).version,
  'release-staging': JSON.parse(
    readFileSync(
      path.join(repoRoot, 'cli/release-staging/package.json'),
      'utf8',
    ),
  ).version,
}

function runWrapperWithTarBlocked(wrapperPath: string, flag: string) {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'openbuff-release-wrapper-'))
  const preloadPath = path.join(tempDir, 'block-tar.cjs')

  writeFileSync(
    preloadPath,
    `const Module = require('module')\n` +
      `const originalLoad = Module._load\n` +
      `Module._load = function(request, parent, isMain) {\n` +
      `  if (request === 'tar') throw new Error('tar should not be required for version flags')\n` +
      `  return originalLoad.apply(this, arguments)\n` +
      `}\n`,
  )

  try {
    return spawnSync(
      process.execPath,
      ['--require', preloadPath, wrapperPath, flag],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: '',
        },
      },
    )
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function getWrapperBinaryName(wrapperName: WrapperName) {
  return wrapperName === 'release' ? 'openbuff' : 'codecane'
}

function getWrapperMetadataName(wrapperName: WrapperName) {
  return wrapperName === 'release'
    ? 'openbuff-metadata.json'
    : 'codecane-metadata.json'
}

function writeValidTreeSitterAssets(configDir: string) {
  const files = [
    'tree-sitter.wasm',
    'tree-sitter-c-sharp.wasm',
    'tree-sitter-cpp.wasm',
    'tree-sitter-go.wasm',
    'tree-sitter-java.wasm',
    'tree-sitter-javascript.wasm',
    'tree-sitter-python.wasm',
    'tree-sitter-ruby.wasm',
    'tree-sitter-rust.wasm',
    'tree-sitter-typescript.wasm',
    'tree-sitter-tsx.wasm',
    'tree-sitter-kotlin.wasm',
    'tree-sitter-php.wasm',
    'tree-sitter-swift.wasm',
    'tree-sitter-gdscript.wasm',
  ]
  const hashes: Record<string, string> = {}
  for (const name of files) {
    const bytes = Buffer.from(name)
    writeFileSync(path.join(configDir, name), bytes)
    hashes[name] = createHash('sha256').update(bytes).digest('hex')
  }
  writeFileSync(
    path.join(configDir, 'tree-sitter-manifest.json'),
    JSON.stringify({ schemaVersion: 1, files: hashes }),
  )
}

function createDownloadHarness(tempDir: string, wrapperName: WrapperName) {
  const binaryName = getWrapperBinaryName(wrapperName)
  return {
    config: {
      configDir: tempDir,
      binaryName,
      binaryPath: path.join(tempDir, binaryName),
      metadataPath: path.join(tempDir, getWrapperMetadataName(wrapperName)),
      tempDownloadDir: path.join(tempDir, '.download-temp-test'),
    },
    fileName: `${binaryName}-linux-x64.tar.gz`,
  }
}

function mockResponse(bytes: Buffer) {
  return Object.assign(Readable.from([bytes]), {
    headers: { 'content-length': String(bytes.length) },
    statusCode: 200,
  })
}

function createMockHttpGet(
  fileName: string,
  archive: Buffer,
  checksum?: string,
) {
  const digest = checksum || createHash('sha256').update(archive).digest('hex')
  return async (url: string) =>
    url.endsWith('/SHA256SUMS')
      ? mockResponse(Buffer.from(`${digest}  ${fileName}\n`))
      : mockResponse(archive)
}

function extractValidRelease(cwd: string, binaryName: string) {
  writeFileSync(path.join(cwd, binaryName), 'installed-binary')
  writeValidTreeSitterAssets(cwd)
}

function runWrapperWithMockPlatform({
  arch,
  cpuInfo,
  hardwareArch,
  macOSVersion,
  platform = 'darwin',
  platformKey,
  wrapperName,
  wrapperPath,
}: {
  arch: string
  cpuInfo?: string
  hardwareArch: string
  macOSVersion?: string
  platform?: NodeJS.Platform
  platformKey: string
  wrapperName: WrapperName
  wrapperPath: string
}) {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'openbuff-release-wrapper-'))
  const preloadPath = path.join(tempDir, 'mock-platform.cjs')
  const configDir = path.join(tempDir, '.config', 'openbuff')
  const binaryName = getWrapperBinaryName(wrapperName)

  mkdirSync(configDir, { recursive: true })
  writeValidTreeSitterAssets(configDir)
  writeFileSync(
    path.join(configDir, getWrapperMetadataName(wrapperName)),
    JSON.stringify({ version: wrapperVersions[wrapperName], platformKey }),
  )
  writeFileSync(
    path.join(configDir, binaryName),
    `#!/usr/bin/env node\nprocess.kill(process.pid, 'SIGILL')\n`,
  )
  chmodSync(path.join(configDir, binaryName), 0o755)

  writeFileSync(
    preloadPath,
    `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} })\n` +
      `Object.defineProperty(process, 'arch', { value: ${JSON.stringify(arch)} })\n`,
  )

  try {
    return spawnSync(
      process.execPath,
      ['--require', preloadPath, wrapperPath],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: tempDir,
          OPENBUFF_CONFIG_DIR: configDir,
          NODE_OPTIONS: '',
          OPENBUFF_TEST_HARDWARE_ARCH: hardwareArch,
          ...(cpuInfo !== undefined ? { OPENBUFF_TEST_CPU_INFO: cpuInfo } : {}),
          ...(macOSVersion
            ? { OPENBUFF_TEST_MACOS_VERSION: macOSVersion }
            : {}),
        },
      },
    )
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

describe('release wrapper version flags', () => {
  test.each(wrappers)(
    '%s --version exits before requiring tar',
    (wrapperName, wrapperPath) => {
      const result = runWrapperWithTarBlocked(wrapperPath, '--version')

      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout.trim()).toBe(wrapperVersions[wrapperName])
    },
  )

  test.each(wrappers)(
    '%s -v exits before requiring tar',
    (wrapperName, wrapperPath) => {
      const result = runWrapperWithTarBlocked(wrapperPath, '-v')

      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout.trim()).toBe(wrapperVersions[wrapperName])
    },
  )
})

describe('release wrapper platform selection', () => {
  test.each(wrappers)(
    '%s rejects Intel macOS versions older than 11',
    (wrapperName, wrapperPath) => {
      const result = runWrapperWithMockPlatform({
        arch: 'x64',
        hardwareArch: 'x64',
        macOSVersion: '10.15.7',
        platformKey: 'darwin-x64',
        wrapperName,
        wrapperPath,
      })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('requires macOS 11 or newer')
      expect(result.stderr).toContain('running macOS 10.15.7')
      expect(result.stderr).not.toContain('System info:')
    },
  )

  test.each(wrappers)(
    '%s selects the isolated Intel legacy binary on macOS 11',
    (wrapperName, wrapperPath) => {
      const result = runWrapperWithMockPlatform({
        arch: 'x64',
        hardwareArch: 'x86_64',
        macOSVersion: '11.7.10',
        platformKey: 'darwin-x64-legacy',
        wrapperName,
        wrapperPath,
      })

      expect(result.status).toBe(1)
      expect(result.stderr).not.toContain('requires macOS 13 or newer')
      expect(result.stderr).toContain('macOS:    11.7.10')
      expect(result.stderr).toContain(
        `Target:   darwin-x64-legacy (${getWrapperBinaryName(wrapperName)}-darwin-x64-legacy.tar.gz)`,
      )
    },
  )

  test.each(wrappers)(
    '%s normalizes aarch64 when selecting the legacy Apple Silicon binary',
    (wrapperName, wrapperPath) => {
      const result = runWrapperWithMockPlatform({
        arch: 'arm64',
        hardwareArch: 'aarch64',
        macOSVersion: '12.7.6',
        platformKey: 'darwin-arm64-legacy',
        wrapperName,
        wrapperPath,
      })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Hardware: arm64')
      expect(result.stderr).toContain(
        `Target:   darwin-arm64-legacy (${getWrapperBinaryName(wrapperName)}-darwin-arm64-legacy.tar.gz)`,
      )
    },
  )

  test.each(wrappers)(
    '%s selects the legacy Apple Silicon binary on macOS 11',
    (wrapperName, wrapperPath) => {
      const result = runWrapperWithMockPlatform({
        arch: 'arm64',
        hardwareArch: 'arm64',
        macOSVersion: '11.7.10',
        platformKey: 'darwin-arm64-legacy',
        wrapperName,
        wrapperPath,
      })

      expect(result.status).toBe(1)
      expect(result.stderr).not.toContain('requires macOS 13 or newer')
      expect(result.stderr).toContain('macOS:    11.7.10')
      expect(result.stderr).toContain(
        `Target:   darwin-arm64-legacy (${getWrapperBinaryName(wrapperName)}-darwin-arm64-legacy.tar.gz)`,
      )
    },
  )

  test.each(wrappers)(
    '%s selects the legacy Apple Silicon binary under Rosetta on macOS 12',
    (wrapperName, wrapperPath) => {
      const result = runWrapperWithMockPlatform({
        arch: 'x64',
        hardwareArch: 'arm64',
        macOSVersion: '12.7.6',
        platformKey: 'darwin-arm64-legacy',
        wrapperName,
        wrapperPath,
      })

      expect(result.status).toBe(1)
      expect(result.stderr).not.toContain('requires macOS 13 or newer')
      expect(result.stderr).toContain('Hardware: arm64')
      expect(result.stderr).toContain(
        `Target:   darwin-arm64-legacy (${getWrapperBinaryName(wrapperName)}-darwin-arm64-legacy.tar.gz)`,
      )
    },
  )

  test.each(wrappers)(
    '%s allows macOS 13 Intel to launch the native binary',
    (wrapperName, wrapperPath) => {
      const result = runWrapperWithMockPlatform({
        arch: 'x64',
        hardwareArch: 'x64',
        macOSVersion: '13.0',
        platformKey: 'darwin-x64',
        wrapperName,
        wrapperPath,
      })

      expect(result.status).toBe(1)
      expect(result.stderr).not.toContain('requires macOS 13 or newer')
      expect(result.stderr).toContain('macOS:    13.0')
      expect(result.stderr).toContain(
        `Target:   darwin-x64 (${getWrapperBinaryName(wrapperName)}-darwin-x64.tar.gz)`,
      )
    },
  )

  test.each(wrappers)(
    '%s selects darwin-arm64 on Apple Silicon running x64 Node under Rosetta',
    (wrapperName, wrapperPath) => {
      const result = runWrapperWithMockPlatform({
        arch: 'x64',
        hardwareArch: 'arm64',
        platformKey: 'darwin-arm64',
        wrapperName,
        wrapperPath,
      })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Platform: darwin x64')
      expect(result.stderr).toContain('Hardware: arm64')
      expect(result.stderr).toContain(
        `Target:   darwin-arm64 (${getWrapperBinaryName(wrapperName)}-darwin-arm64.tar.gz)`,
      )
      expect(result.stderr).toContain(
        'The selected release is not an x64 build, so AVX2 does not apply.',
      )
      expect(result.stderr).toContain('AVX2:     not applicable')
    },
  )

  test.each(wrappers)(
    '%s keeps darwin-x64 for Intel Macs running x64 Node',
    (wrapperName, wrapperPath) => {
      const result = runWrapperWithMockPlatform({
        arch: 'x64',
        hardwareArch: 'x64',
        platformKey: 'darwin-x64',
        wrapperName,
        wrapperPath,
      })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Platform: darwin x64')
      expect(result.stderr).toContain('Hardware: x64')
      expect(result.stderr).toContain(
        `Target:   darwin-x64 (${getWrapperBinaryName(wrapperName)}-darwin-x64.tar.gz)`,
      )
    },
  )

  test.each(wrappers)(
    '%s keeps darwin-arm64 for Apple Silicon running arm64 Node',
    (wrapperName, wrapperPath) => {
      const result = runWrapperWithMockPlatform({
        arch: 'arm64',
        hardwareArch: 'arm64',
        platformKey: 'darwin-arm64',
        wrapperName,
        wrapperPath,
      })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Platform: darwin arm64')
      expect(result.stderr).toContain('Hardware: arm64')
      expect(result.stderr).toContain(
        `Target:   darwin-arm64 (${getWrapperBinaryName(wrapperName)}-darwin-arm64.tar.gz)`,
      )
    },
  )
})

describe('release wrapper illegal-instruction diagnostics', () => {
  test.each(wrappers)(
    '%s does not blame AVX2 when the Linux CPU reports support',
    (wrapperName, wrapperPath) => {
      const result = runWrapperWithMockPlatform({
        arch: 'x64',
        cpuInfo:
          'model name : Test Ryzen CPU\nflags : fpu sse sse2 avx avx2 bmi1 bmi2\n',
        hardwareArch: 'x64',
        platform: 'linux',
        platformKey: 'linux-x64',
        wrapperName,
        wrapperPath,
      })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain(
        'This CPU reports AVX2 support, so a missing AVX2 instruction set is not the likely cause.',
      )
      expect(result.stderr).toContain('CPU:      Test Ryzen CPU')
      expect(result.stderr).toContain('AVX2:     supported')
      expect(result.stderr).toContain(
        `Wrapper:  ${wrapperVersions[wrapperName]}`,
      )
      expect(result.stderr).toContain(
        `Installed: ${wrapperVersions[wrapperName]}`,
      )
      expect(result.stderr).not.toContain(
        'Unfortunately, this binary is not compatible with your system.',
      )
    },
  )

  test.each(wrappers)(
    '%s reports missing AVX2 as one possible cause',
    (wrapperName, wrapperPath) => {
      const result = runWrapperWithMockPlatform({
        arch: 'x64',
        cpuInfo: 'model name : Baseline CPU\nflags : fpu sse sse2\n',
        hardwareArch: 'x64',
        platform: 'linux',
        platformKey: 'linux-x64',
        wrapperName,
        wrapperPath,
      })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain(
        'This CPU does not report AVX2 support, so CPU instruction compatibility may be the cause.',
      )
      expect(result.stderr).toContain('AVX2:     not reported')
      expect(result.stderr).toContain(
        'The crash may also come from a native dependency or runtime compatibility defect.',
      )
    },
  )

  test.each(wrappers)(
    '%s keeps the cause open when CPU feature detection is inconclusive',
    (wrapperName, wrapperPath) => {
      const result = runWrapperWithMockPlatform({
        arch: 'x64',
        cpuInfo: 'model name : Hidden Features CPU\n',
        hardwareArch: 'x64',
        platform: 'linux',
        platformKey: 'linux-x64',
        wrapperName,
        wrapperPath,
      })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain(
        'Openbuff could not determine whether this CPU supports AVX2.',
      )
      expect(result.stderr).toContain('AVX2:     unknown')
    },
  )
})

describe('release wrapper update safety', () => {
  test.each(wrappers)(
    '%s bounds stale Windows binary backups',
    (_, wrapperPath) => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'openbuff-backups-'))
      const binaryPath = path.join(tempDir, 'openbuff.exe')
      const now = Date.now()
      const recent = [now - 1_000, now - 2_000, now - 3_000]
      const old = now - 8 * 24 * 60 * 60 * 1000
      for (const timestamp of [...recent, old]) {
        writeFileSync(`${binaryPath}.old.${timestamp}`, 'backup')
      }
      writeFileSync(path.join(tempDir, 'unrelated.old.1'), 'keep')
      try {
        const { cleanupOldBinaryBackups } = require(
          path.join(repoRoot, wrapperPath),
        )
        cleanupOldBinaryBackups(binaryPath, now)

        const remaining = readdirSync(tempDir).filter((name) =>
          name.startsWith('openbuff.exe.old.'),
        )
        expect(remaining.sort()).toEqual(
          recent
            .slice(0, 2)
            .map((timestamp) => `openbuff.exe.old.${timestamp}`)
            .sort(),
        )
        expect(existsSync(path.join(tempDir, 'unrelated.old.1'))).toBe(true)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    },
  )

  test.each(wrappers)(
    '%s preserves every extracted tree-sitter grammar sibling',
    (_, wrapperPath) => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'openbuff-wasm-assets-'))
      try {
        writeFileSync(path.join(tempDir, 'tree-sitter.wasm'), 'runtime')
        writeFileSync(path.join(tempDir, 'tree-sitter-typescript.wasm'), 'ts')
        writeFileSync(path.join(tempDir, 'tree-sitter-python.wasm'), 'py')
        writeFileSync(path.join(tempDir, 'tree-sitter-manifest.json'), '{}')
        writeFileSync(path.join(tempDir, 'not-managed.wasm'), 'other')
        const { getManagedSiblingNames } = require(
          path.join(repoRoot, wrapperPath),
        )

        expect(getManagedSiblingNames(tempDir)).toContain(
          'tree-sitter-typescript.wasm',
        )
        expect(getManagedSiblingNames(tempDir)).toContain(
          'tree-sitter-python.wasm',
        )
        expect(getManagedSiblingNames(tempDir)).not.toContain(
          'not-managed.wasm',
        )
        expect(getManagedSiblingNames(tempDir)).toContain(
          'tree-sitter-manifest.json',
        )
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    },
  )

  test.each(wrappers)(
    '%s detects missing and corrupted installed grammar assets',
    (_, wrapperPath) => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'openbuff-wasm-check-'))
      try {
        writeValidTreeSitterAssets(tempDir)
        const { getTreeSitterAssetProblems } = require(
          path.join(repoRoot, wrapperPath),
        )
        expect(getTreeSitterAssetProblems(tempDir)).toEqual([])

        writeFileSync(
          path.join(tempDir, 'tree-sitter-javascript.wasm'),
          'corrupt',
        )
        expect(getTreeSitterAssetProblems(tempDir)).toEqual([
          'tree-sitter-javascript.wasm:checksum',
        ])
        rmSync(path.join(tempDir, 'tree-sitter-manifest.json'))
        expect(getTreeSitterAssetProblems(tempDir)).toEqual([
          'tree-sitter-manifest.json',
        ])
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    },
  )

  test.each(wrappers)(
    '%s resolves config overrides consistently',
    (_, wrapperPath) => {
      const { resolveConfigDir } = require(path.join(repoRoot, wrapperPath))
      expect(
        resolveConfigDir(
          { OPENBUFF_CONFIG_DIR: '/custom/openbuff' },
          'linux',
          '/home/test',
        ),
      ).toBe('/custom/openbuff')
      expect(
        resolveConfigDir(
          { XDG_CONFIG_HOME: '/xdg/config' },
          'linux',
          '/home/test',
        ),
      ).toBe('/xdg/config/openbuff')
      expect(
        resolveConfigDir(
          { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' },
          'win32',
          'C:\\Users\\test',
        ),
      ).toBe(path.join('C:\\Users\\test\\AppData\\Roaming', 'openbuff'))
    },
  )

  test.each(wrappers)(
    '%s compares SemVer prerelease boundaries',
    (_, wrapperPath) => {
      const { compareVersions } = require(path.join(repoRoot, wrapperPath))
      const cases = [
        ['1.2.4-beta.2', '1.2.4-beta.2', 0],
        ['1.2.4-beta.2', '1.2.4-beta.3', -1],
        ['1.2.4-beta.3', '1.2.4', -1],
        ['1.0.0-1', '1.0.0-alpha', -1],
        ['1.0.0-alpha', '1.0.0-1', 1],
        ['1.0.0-1abc', '1.0.0-2', 1],
        ['1.0.0-alpha', '1.0.0-alpha.1', -1],
        ['1.0.0-beta.11', '1.0.0-rc.1', -1],
      ] as const

      for (const [left, right, expected] of cases) {
        expect(compareVersions(left, right)).toBe(expected)
      }
    },
  )

  test.each(wrappers)(
    '%s verifies the selected release asset checksum',
    (_, wrapperPath) => {
      const { parseExpectedChecksum } = require(
        path.join(repoRoot, wrapperPath),
      )
      const digest = 'a'.repeat(64)

      expect(
        parseExpectedChecksum(
          `${'b'.repeat(64)}  unrelated.tar.gz\n${digest}  openbuff-linux-x64.tar.gz\n`,
          'openbuff-linux-x64.tar.gz',
        ),
      ).toBe(digest)
      expect(() =>
        parseExpectedChecksum(
          `${digest}  unrelated.tar.gz\n`,
          'openbuff-linux-x64.tar.gz',
        ),
      ).toThrow('Checksum missing')
    },
  )

  test.each(wrappers)(
    '%s installs a verified binary and every tree-sitter asset',
    async (wrapperName, wrapperPath) => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'openbuff-install-'))
      const archive = Buffer.from('release-archive')
      const { config, fileName } = createDownloadHarness(tempDir, wrapperName)
      try {
        const { downloadBinary, getTreeSitterAssetProblems } = require(
          path.join(repoRoot, wrapperPath),
        )
        await downloadBinary('2.0.0', {
          config,
          platformKey: 'linux-x64',
          httpGet: createMockHttpGet(fileName, archive),
          extractArchive: ({ cwd }: { cwd: string }) =>
            extractValidRelease(cwd, config.binaryName),
        })

        expect(readFileSync(config.binaryPath, 'utf8')).toBe('installed-binary')
        expect(getTreeSitterAssetProblems(tempDir)).toEqual([])
        expect(JSON.parse(readFileSync(config.metadataPath, 'utf8'))).toEqual({
          version: '2.0.0',
          platformKey: 'linux-x64',
        })
        expect(existsSync(config.tempDownloadDir)).toBe(false)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    },
  )

  test.each(wrappers)(
    '%s repairs missing or corrupt assets and consumes pending metadata',
    async (wrapperName, wrapperPath) => {
      for (const damage of ['missing', 'corrupt'] as const) {
        const tempDir = mkdtempSync(path.join(tmpdir(), 'openbuff-repair-'))
        const archive = Buffer.from(`repair-archive-${damage}`)
        const { config, fileName } = createDownloadHarness(tempDir, wrapperName)
        try {
          writeValidTreeSitterAssets(tempDir)
          writeFileSync(config.binaryPath, 'existing')
          const damagedAsset = path.join(tempDir, 'tree-sitter-python.wasm')
          if (damage === 'missing') rmSync(damagedAsset)
          else writeFileSync(damagedAsset, 'corrupt')
          writeFileSync(
            config.metadataPath,
            JSON.stringify({
              version: '1.0.0',
              platformKey: 'linux-x64',
              pendingVersion: '1.1.0',
            }),
          )
          const { downloadBinary, ensureBinaryExists } = require(
            path.join(repoRoot, wrapperPath),
          )
          await ensureBinaryExists({
            config,
            currentVersion: '1.0.0',
            packagedVersion: null,
            downloadBinary: (version: string) =>
              downloadBinary(version, {
                config,
                platformKey: 'linux-x64',
                httpGet: createMockHttpGet(fileName, archive),
                extractArchive: ({ cwd }: { cwd: string }) =>
                  extractValidRelease(cwd, config.binaryName),
              }),
          })

          expect(readFileSync(config.binaryPath, 'utf8')).toBe(
            'installed-binary',
          )
          expect(JSON.parse(readFileSync(config.metadataPath, 'utf8'))).toEqual(
            { version: '1.1.0', platformKey: 'linux-x64' },
          )
        } finally {
          rmSync(tempDir, { recursive: true, force: true })
        }
      }
    },
  )

  test.each(wrappers)(
    '%s repairs damaged assets when no version source requests an update',
    async (wrapperName, wrapperPath) => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'openbuff-repair-only-'))
      const archive = Buffer.from('repair-only-archive')
      const { config, fileName } = createDownloadHarness(tempDir, wrapperName)
      const downloadedVersions: string[] = []
      try {
        writeValidTreeSitterAssets(tempDir)
        writeFileSync(config.binaryPath, 'existing')
        rmSync(path.join(tempDir, 'tree-sitter-python.wasm'))
        writeFileSync(
          config.metadataPath,
          JSON.stringify({ version: '1.0.0', platformKey: 'linux-x64' }),
        )
        const {
          downloadBinary,
          ensureBinaryExists,
          getTreeSitterAssetProblems,
        } = require(path.join(repoRoot, wrapperPath))

        await ensureBinaryExists({
          config,
          currentVersion: '1.0.0',
          packagedVersion: null,
          pendingVersion: null,
          downloadBinary: async (version: string) => {
            downloadedVersions.push(version)
            await downloadBinary(version, {
              config,
              platformKey: 'linux-x64',
              httpGet: createMockHttpGet(fileName, archive),
              extractArchive: ({ cwd }: { cwd: string }) =>
                extractValidRelease(cwd, config.binaryName),
            })
          },
        })

        expect(downloadedVersions).toEqual(['1.0.0'])
        expect(getTreeSitterAssetProblems(tempDir)).toEqual([])
        expect(JSON.parse(readFileSync(config.metadataPath, 'utf8'))).toEqual({
          version: '1.0.0',
          platformKey: 'linux-x64',
        })
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    },
  )

  test.each(wrappers)(
    '%s bounds update telemetry without user paths or raw errors',
    (wrapperName, wrapperPath) => {
      const { getUpdateFailureProperties } = require(
        path.join(repoRoot, wrapperPath),
      )
      const secretUrl = 'https://user:token@mirror.example/releases'
      const properties = getUpdateFailureProperties('2.0.0', {
        stage: 'background_check',
        detail: secretUrl,
      })
      const serialized = JSON.stringify(properties)

      expect(properties.error).toBe('unknown')
      expect(properties.distinct_id).toBe(
        wrapperName === 'release'
          ? 'anonymous-openbuff-release'
          : 'anonymous-codecane-release',
      )
      expect(serialized).not.toContain(secretUrl)
      expect(serialized).not.toContain(tmpdir())
      expect(Object.keys(properties).sort()).toEqual(
        wrapperName === 'release-staging'
          ? ['arch', 'distinct_id', 'error', 'isStaging', 'platform', 'version']
          : ['arch', 'distinct_id', 'error', 'platform', 'version'],
      )
    },
  )

  test.each(wrappers)(
    '%s restores the prior installation when a sibling commit fails',
    async (wrapperName, wrapperPath) => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'openbuff-rollback-'))
      const archive = Buffer.from('rollback-archive')
      const { config, fileName } = createDownloadHarness(tempDir, wrapperName)
      try {
        writeValidTreeSitterAssets(tempDir)
        writeFileSync(config.binaryPath, 'existing-binary')
        writeFileSync(
          config.metadataPath,
          JSON.stringify({ version: '1.0.0', platformKey: 'linux-x64' }),
        )
        const installedNames = [
          config.binaryName,
          path.basename(config.metadataPath),
          ...readdirSync(tempDir).filter((name) =>
            name.startsWith('tree-sitter'),
          ),
        ]
        const before = Object.fromEntries(
          installedNames.map((name) => [
            name,
            readFileSync(path.join(tempDir, name)),
          ]),
        )
        const { downloadBinary, getTreeSitterAssetProblems } = require(
          path.join(repoRoot, wrapperPath),
        )

        await expect(
          downloadBinary('2.0.0', {
            config,
            platformKey: 'linux-x64',
            httpGet: createMockHttpGet(fileName, archive),
            extractArchive: ({ cwd }: { cwd: string }) =>
              extractValidRelease(cwd, config.binaryName),
            rename: (source: string, target: string) => {
              if (
                source.startsWith(config.tempDownloadDir) &&
                path.basename(source) === 'tree-sitter-python.wasm'
              ) {
                throw new Error('injected sibling commit failure')
              }
              renameSync(source, target)
            },
          }),
        ).rejects.toThrow('injected sibling commit failure')

        for (const [name, bytes] of Object.entries(before)) {
          expect(readFileSync(path.join(tempDir, name))).toEqual(bytes)
        }
        expect(getTreeSitterAssetProblems(tempDir)).toEqual([])
        expect(JSON.parse(readFileSync(config.metadataPath, 'utf8'))).toEqual({
          version: '1.0.0',
          platformKey: 'linux-x64',
        })
        expect(existsSync(config.tempDownloadDir)).toBe(false)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    },
  )

  test.each(wrappers)(
    '%s prints foreground install failure guidance',
    async (_, wrapperPath) => {
      const { ensureBinaryExists } = require(path.join(repoRoot, wrapperPath))
      const connectivityGuidance =
        'Please check your internet connection and try again'
      const proxyGuidance =
        'If you are behind a proxy, set the HTTPS_PROXY environment variable'
      const exit = (code: number): never => {
        throw new Error(`exit ${code}`)
      }

      for (const failure of ['version', 'download'] as const) {
        for (const proxyUrl of [null, 'http://proxy.test'] as const) {
          const errors: string[] = []
          const options = {
            currentVersion: null,
            pendingVersion: null,
            packagedVersion: null,
            getLatestVersion: async () =>
              failure === 'version' ? null : '2.0.0',
            downloadBinary: async () => {
              throw new Error('download failed')
            },
            getProxyUrl: () => proxyUrl,
            consoleError: (...args: unknown[]) =>
              errors.push(args.map(String).join(' ')),
            exit,
          }

          await expect(ensureBinaryExists(options)).rejects.toThrow('exit 1')
          expect(errors).toContain(connectivityGuidance)
          if (proxyUrl) {
            expect(errors).not.toContain(proxyGuidance)
          } else {
            expect(errors).toContain(proxyGuidance)
          }
        }
      }
    },
  )

  test.each(wrappers)(
    '%s rejects checksum failures without installing and cleans temporary state',
    async (wrapperName, wrapperPath) => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'openbuff-checksum-'))
      const archive = Buffer.from('untrusted-archive')
      const { config, fileName } = createDownloadHarness(tempDir, wrapperName)
      try {
        const { downloadBinary } = require(path.join(repoRoot, wrapperPath))
        await expect(
          downloadBinary('2.0.0', {
            config,
            platformKey: 'linux-x64',
            httpGet: createMockHttpGet(fileName, archive, '0'.repeat(64)),
            extractArchive: () => {
              throw new Error('must not extract')
            },
          }),
        ).rejects.toThrow('Checksum verification failed')

        expect(existsSync(config.binaryPath)).toBe(false)
        expect(existsSync(config.metadataPath)).toBe(false)
        expect(existsSync(config.tempDownloadDir)).toBe(false)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    },
  )

  test.each(wrappers)(
    '%s rejects symlinked managed entries without mutating the installation',
    async (wrapperName, wrapperPath) => {
      const symlinkedNames = [
        getWrapperBinaryName(wrapperName),
        'tree-sitter-manifest.json',
        'tree-sitter-python.wasm',
        'rg',
        'libopentui.dylib',
        getWrapperMetadataName(wrapperName),
      ]

      for (const symlinkedName of symlinkedNames) {
        const tempDir = mkdtempSync(path.join(tmpdir(), 'openbuff-symlink-'))
        const archive = Buffer.from(`symlink-archive-${symlinkedName}`)
        const { config, fileName } = createDownloadHarness(tempDir, wrapperName)
        const externalPath = path.join(tempDir, 'external-target')
        try {
          writeValidTreeSitterAssets(tempDir)
          writeFileSync(config.binaryPath, 'existing-binary')
          writeFileSync(
            config.metadataPath,
            JSON.stringify({ version: '1.0.0', platformKey: 'linux-x64' }),
          )
          const installedNames = [
            config.binaryName,
            path.basename(config.metadataPath),
            ...readdirSync(tempDir).filter((name) =>
              name.startsWith('tree-sitter'),
            ),
          ]
          const before = Object.fromEntries(
            installedNames.map((name) => [
              name,
              readFileSync(path.join(tempDir, name)),
            ]),
          )
          writeFileSync(externalPath, 'external-content')
          const { downloadBinary } = require(path.join(repoRoot, wrapperPath))

          await expect(
            downloadBinary('2.0.0', {
              config,
              platformKey: 'linux-x64',
              httpGet: createMockHttpGet(fileName, archive),
              extractArchive: ({ cwd }: { cwd: string }) => {
                extractValidRelease(cwd, config.binaryName)
                const symlinkPath = path.join(cwd, symlinkedName)
                rmSync(symlinkPath, { force: true })
                symlinkSync(externalPath, symlinkPath)
              },
            }),
          ).rejects.toThrow('must be a regular file')

          for (const [name, bytes] of Object.entries(before)) {
            expect(readFileSync(path.join(tempDir, name))).toEqual(bytes)
          }
          expect(readFileSync(externalPath, 'utf8')).toBe('external-content')
          expect(existsSync(config.tempDownloadDir)).toBe(false)
        } finally {
          rmSync(tempDir, { recursive: true, force: true })
        }
      }
    },
  )

  test.each(wrappers)(
    '%s cleans downloaded state when extraction fails',
    async (wrapperName, wrapperPath) => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'openbuff-extract-'))
      const archive = Buffer.from('valid-archive')
      const { config, fileName } = createDownloadHarness(tempDir, wrapperName)
      try {
        const { downloadBinary } = require(path.join(repoRoot, wrapperPath))
        await expect(
          downloadBinary('2.0.0', {
            config,
            platformKey: 'linux-x64',
            httpGet: createMockHttpGet(fileName, archive),
            extractArchive: () => {
              throw new Error('extract failed')
            },
          }),
        ).rejects.toThrow('extract failed')

        expect(existsSync(config.tempDownloadDir)).toBe(false)
        expect(existsSync(config.binaryPath)).toBe(false)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    },
  )

  test.each(wrappers)(
    '%s defers updates without terminating the active child',
    async (_, wrapperPath) => {
      const activeChild = spawn(
        process.execPath,
        ['-e', 'setTimeout(() => {}, 10_000)'],
        { stdio: 'ignore' },
      )
      const pending: string[] = []
      const { checkForUpdates } = require(path.join(repoRoot, wrapperPath))
      const isChildAlive = () => {
        if (activeChild.pid === undefined) return false
        try {
          process.kill(activeChild.pid, 0)
          return true
        } catch {
          return false
        }
      }

      try {
        expect(isChildAlive()).toBe(true)

        await checkForUpdates({
          currentVersion: '1.0.0',
          getLatestVersion: async () => '1.1.0',
          writePendingUpdateVersion: (version: string) => pending.push(version),
        })

        expect(pending).toEqual(['1.1.0'])
        expect(isChildAlive()).toBe(true)
      } finally {
        activeChild.kill()
        await new Promise<void>((resolve) => {
          if (
            activeChild.exitCode !== null ||
            activeChild.signalCode !== null
          ) {
            resolve()
          } else {
            activeChild.once('exit', () => resolve())
          }
        })
      }
    },
  )

  test("Linux x64 release builds use Bun's baseline CPU target", () => {
    const buildScript = readFileSync(
      path.join(repoRoot, 'cli/scripts/build-binary.ts'),
      'utf8',
    )
    const releaseWorkflow = readFileSync(
      path.join(repoRoot, '.github/workflows/cli-release-build.yml'),
      'utf8',
    )

    expect(buildScript).toContain("bunTarget: 'bun-linux-x64-baseline'")
    expect(releaseWorkflow).toContain('bun_target: bun-linux-x64-baseline')
  })

  test('release smoke tests run outside the repository dependency tree', () => {
    const buildScript = readFileSync(
      path.join(repoRoot, 'cli/scripts/build-binary.ts'),
      'utf8',
    )
    const cliEntry = readFileSync(
      path.join(repoRoot, 'cli/src/index.tsx'),
      'utf8',
    )
    const smokeScript = readFileSync(
      path.join(repoRoot, 'cli/scripts/smoke-binary.ts'),
      'utf8',
    )
    const releaseWorkflow = readFileSync(
      path.join(repoRoot, '.github/workflows/cli-release-build.yml'),
      'utf8',
    )

    expect(buildScript).toContain('patchOpenTuiCoreNativeLoaderForLegacy()')
    expect(buildScript).not.toContain('patchOpenTuiNativeEntryForLegacy')
    expect(releaseWorkflow).toContain('SMOKE_DIR="$(mktemp -d)"')
    expect(releaseWorkflow).toContain('cd "$SMOKE_DIR"')
    expect(releaseWorkflow).toContain(
      'SMOKE_SCRIPT="$PWD/cli/scripts/smoke-binary.ts"',
    )
    expect(releaseWorkflow).toContain('bun "$SMOKE_SCRIPT" "$BIN"')
    expect(releaseWorkflow).toContain('bun "$SMOKE_SCRIPT" "$BIN" --probe-only')
    expect(cliEntry).toContain("process.argv.includes('--smoke-opentui')")
    expect(cliEntry).toContain("console.log('opentui smoke ok')")
    expect(smokeScript).toContain("'--smoke-opentui'")
    expect(smokeScript).toContain('signal ${signal}')
  })

  test.each([
    'cli/release/postinstall.js',
    'cli/release-staging/postinstall.js',
  ])('%s preserves the cached offline binary', (postinstallPath) => {
    const source = readFileSync(path.join(repoRoot, postinstallPath), 'utf8')
    expect(source).not.toContain('unlinkSync')
  })
})
