#!/usr/bin/env node

const { execFileSync, spawn } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const https = require('https')
const os = require('os')
const path = require('path')

const { createReleaseHttpClient } = require('./http')

// npm package name — used for registry version checks (auto-update).
// Distinct from binaryName below: the npm package is scoped (@openbuff/cli)
// but the compiled binary and command users type is still `openbuff`.
const npmPackageName = '@openbuff/cli'
const binaryName = 'openbuff'
const MIN_LEGACY_MACOS_MAJOR = 11
const MIN_SUPPORTED_MACOS_MAJOR = 13
const OLD_BINARY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const OLD_BINARY_MAX_COUNT = 2
const TREE_SITTER_MANIFEST = 'tree-sitter-manifest.json'
const REQUIRED_TREE_SITTER_ASSETS = [
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

function resolveConfigDir(env, platform, homeDir) {
  if (env.OPENBUFF_CONFIG_DIR) return env.OPENBUFF_CONFIG_DIR
  if (platform === 'win32' && env.APPDATA) {
    return path.join(env.APPDATA, 'openbuff')
  }
  if (env.XDG_CONFIG_HOME) {
    return path.join(env.XDG_CONFIG_HOME, 'openbuff')
  }
  return path.join(homeDir, '.config', 'openbuff')
}

function getManagedSiblingNames(tempDir) {
  const extracted = fs.existsSync(tempDir) ? fs.readdirSync(tempDir) : []
  const wasmSiblings = extracted.filter(
    (name) =>
      name === 'tree-sitter.wasm' ||
      /^tree-sitter-[a-z0-9-]+\.wasm$/i.test(name),
  )
  return [
    ...new Set([
      ...wasmSiblings,
      ...(extracted.includes(TREE_SITTER_MANIFEST)
        ? [TREE_SITTER_MANIFEST]
        : []),
      'libopentui.dylib',
      'rg',
    ]),
  ]
}

function getTreeSitterAssetProblems(dir) {
  const manifestPath = path.join(dir, TREE_SITTER_MANIFEST)
  if (!fs.existsSync(manifestPath)) return [TREE_SITTER_MANIFEST]
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    return [`${TREE_SITTER_MANIFEST}:invalid`]
  }
  if (
    manifest?.schemaVersion !== 1 ||
    !manifest.files ||
    typeof manifest.files !== 'object'
  ) {
    return [`${TREE_SITTER_MANIFEST}:invalid`]
  }
  const problems = []
  for (const required of REQUIRED_TREE_SITTER_ASSETS) {
    if (!(required in manifest.files)) problems.push(`${required}:unlisted`)
  }
  for (const [name, expectedHash] of Object.entries(manifest.files)) {
    if (!/^tree-sitter(?:-[a-z0-9-]+)?\.wasm$/i.test(name)) {
      problems.push(`${name}:invalid-name`)
      continue
    }
    const filePath = path.join(dir, name)
    if (!fs.existsSync(filePath)) {
      problems.push(name)
      continue
    }
    const actualHash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(filePath))
      .digest('hex')
    if (actualHash !== expectedHash) problems.push(`${name}:checksum`)
  }
  return problems
}

function cleanupOldBinaryBackups(binaryPath, now = Date.now()) {
  const dir = path.dirname(binaryPath)
  const prefix = `${path.basename(binaryPath)}.old.`
  if (!fs.existsSync(dir)) return []
  const backups = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .map((name) => ({
      name,
      timestamp: Number(name.slice(prefix.length)),
    }))
    .filter((item) => Number.isFinite(item.timestamp))
    .sort((a, b) => b.timestamp - a.timestamp)
  const removed = []
  for (const [index, backup] of backups.entries()) {
    if (
      index < OLD_BINARY_MAX_COUNT &&
      now - backup.timestamp <= OLD_BINARY_MAX_AGE_MS
    ) {
      continue
    }
    const backupPath = path.join(dir, backup.name)
    try {
      fs.unlinkSync(backupPath)
      removed.push(backupPath)
    } catch {
      // Locked backups are retried on the next launch.
    }
  }
  return removed
}

/**
 * Terminal escape sequences to reset terminal state after the child process exits.
 * When the binary is SIGKILL'd, it can't clean up its own terminal state.
 * The wrapper (this process) survives and must reset these modes.
 *
 * Keep in sync with TERMINAL_RESET_SEQUENCES in cli/src/utils/renderer-cleanup.ts
 */
const TERMINAL_RESET_SEQUENCES =
  '\x1b[?1049l' + // Exit alternate screen buffer
  '\x1b[?1000l' + // Disable X10 mouse mode
  '\x1b[?1002l' + // Disable button event mouse mode
  '\x1b[?1003l' + // Disable any-event mouse mode (all motion)
  '\x1b[?1006l' + // Disable SGR extended mouse mode
  '\x1b[?1004l' + // Disable focus reporting
  '\x1b[?2004l' + // Disable bracketed paste mode
  '\x1b[?25h' // Show cursor

function resetTerminal() {
  try {
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      process.stdin.setRawMode(false)
    }
  } catch {
    // stdin may be closed
  }
  try {
    if (process.stdout.isTTY) {
      process.stdout.write(TERMINAL_RESET_SEQUENCES)
    }
  } catch {
    // stdout may be closed
  }
}

function createConfig(binName) {
  const homeDir = os.homedir()
  const configDir = resolveConfigDir(process.env, process.platform, homeDir)
  const resolvedBinaryName =
    process.platform === 'win32' ? `${binName}.exe` : binName

  return {
    homeDir,
    configDir,
    binaryName: resolvedBinaryName,
    binaryPath: path.join(configDir, resolvedBinaryName),
    metadataPath: path.join(configDir, 'openbuff-metadata.json'),
    tempDownloadDir: path.join(configDir, '.download-temp'),
    userAgent: `${binName}-cli`,
    requestTimeout: 20000,
  }
}

const CONFIG = createConfig(binaryName)
const { getProxyUrl, httpGet } = createReleaseHttpClient({
  env: process.env,
  userAgent: CONFIG.userAgent,
  requestTimeout: CONFIG.requestTimeout,
})

function getPostHogConfig() {
  const apiKey =
    process.env.CODEBUFF_POSTHOG_API_KEY ||
    process.env.NEXT_PUBLIC_POSTHOG_API_KEY
  const host =
    process.env.CODEBUFF_POSTHOG_HOST ||
    process.env.NEXT_PUBLIC_POSTHOG_HOST_URL

  if (!apiKey || !host) {
    return null
  }

  return { apiKey, host }
}

const UPDATE_ERROR_CATEGORIES = new Set([
  'platform_check',
  'checksum_manifest',
  'http_download',
  'checksum_verify',
  'extraction',
])

function getUpdateFailureProperties(version, context = {}) {
  const category = UPDATE_ERROR_CATEGORIES.has(context.stage)
    ? context.stage
    : 'unknown'
  return {
    distinct_id: 'anonymous-openbuff-release',
    error: category,
    version: version || 'unknown',
    platform: process.platform,
    arch: process.arch,
    ...(category === 'http_download' && Number.isInteger(context.statusCode)
      ? { statusCode: context.statusCode }
      : {}),
  }
}

/**
 * Track update failure event to PostHog.
 * Fire-and-forget - errors are silently ignored.
 */
function trackUpdateFailed(_errorMessage, version, context = {}) {
  try {
    const posthogConfig = getPostHogConfig()
    if (!posthogConfig) {
      return
    }

    const payload = JSON.stringify({
      api_key: posthogConfig.apiKey,
      event: 'cli.update_openbuff_failed',
      properties: getUpdateFailureProperties(version, context),
      timestamp: new Date().toISOString(),
    })

    const parsedUrl = new URL(`${posthogConfig.host}/capture/`)
    const isHttps = parsedUrl.protocol === 'https:'
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }

    const transport = isHttps ? https : http
    const req = transport.request(options)
    req.on('error', () => {}) // Silently ignore errors
    req.write(payload)
    req.end()
  } catch (e) {
    // Silently ignore any tracking errors
  }
}

// Binary tarball asset filenames on the GitHub Release. The binary is named
// `openbuff` (see binaryName above) regardless of the scoped npm package name.
const PLATFORM_TARGETS = {
  'linux-x64': `${binaryName}-linux-x64.tar.gz`,
  'linux-arm64': `${binaryName}-linux-arm64.tar.gz`,
  'darwin-x64': `${binaryName}-darwin-x64.tar.gz`,
  'darwin-x64-legacy': `${binaryName}-darwin-x64-legacy.tar.gz`,
  'darwin-arm64-legacy': `${binaryName}-darwin-arm64-legacy.tar.gz`,
  'darwin-arm64': `${binaryName}-darwin-arm64.tar.gz`,
  'win32-x64': `${binaryName}-win32-x64.tar.gz`,
}

function normalizeHardwareArch(arch) {
  if (arch === 'x86_64') return 'x64'
  if (arch === 'aarch64') return 'arm64'
  return arch
}

function getHardwareArch() {
  if (process.env.OPENBUFF_TEST_HARDWARE_ARCH) {
    return normalizeHardwareArch(process.env.OPENBUFF_TEST_HARDWARE_ARCH)
  }

  if (process.platform !== 'darwin') {
    return normalizeHardwareArch(process.arch)
  }

  try {
    return normalizeHardwareArch(
      execFileSync('uname', ['-m'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || process.arch,
    )
  } catch {
    return normalizeHardwareArch(process.arch)
  }
}

function getMacOSVersion() {
  if (process.env.OPENBUFF_TEST_MACOS_VERSION) {
    return process.env.OPENBUFF_TEST_MACOS_VERSION
  }
  if (process.platform !== 'darwin') return null
  try {
    return execFileSync('sw_vers', ['-productVersion'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

function parseLinuxCpuInfo(cpuInfo) {
  if (typeof cpuInfo !== 'string') {
    return { model: null, avx2: null }
  }

  const model = cpuInfo.match(/^model name\s*:\s*(.+)$/im)?.[1]?.trim() ?? null
  const flagsText = cpuInfo.match(/^flags\s*:\s*(.+)$/im)?.[1]
  if (!flagsText) {
    return { model, avx2: null }
  }

  const flags = new Set(flagsText.toLowerCase().split(/\s+/).filter(Boolean))
  return { model, avx2: flags.has('avx2') }
}

function getCpuCompatibilityInfo(platformKey = getPlatformKey()) {
  const fallbackModel = os.cpus()?.[0]?.model?.trim() || null
  const avx2Applicable = platformKey.split('-').includes('x64')
  if (!avx2Applicable) {
    return { model: fallbackModel, avx2: null, avx2Applicable: false }
  }
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    return { model: fallbackModel, avx2: null, avx2Applicable: true }
  }

  try {
    const cpuInfo =
      process.env.OPENBUFF_TEST_CPU_INFO !== undefined
        ? process.env.OPENBUFF_TEST_CPU_INFO
        : fs.readFileSync('/proc/cpuinfo', 'utf8')
    const parsed = parseLinuxCpuInfo(cpuInfo)
    return {
      model: parsed.model ?? fallbackModel,
      avx2: parsed.avx2,
      avx2Applicable: true,
    }
  } catch {
    return { model: fallbackModel, avx2: null, avx2Applicable: true }
  }
}

function getIllegalInstructionGuidance({ avx2, avx2Applicable = true }) {
  const lines = [
    'The binary attempted to execute an instruction that the CPU or runtime rejected.',
  ]

  if (!avx2Applicable) {
    lines.push(
      'The selected release is not an x64 build, so AVX2 does not apply.',
      'This may indicate a binary, native dependency, virtualization, or runtime compatibility defect.',
    )
  } else if (avx2 === true) {
    lines.push(
      'This CPU reports AVX2 support, so a missing AVX2 instruction set is not the likely cause.',
      'This may indicate a binary, native dependency, virtualization, or runtime compatibility defect.',
    )
  } else if (avx2 === false) {
    lines.push(
      'This CPU does not report AVX2 support, so CPU instruction compatibility may be the cause.',
      'The crash may also come from a native dependency or runtime compatibility defect.',
    )
  } else {
    lines.push(
      'Openbuff could not determine whether this CPU supports AVX2.',
      'This may indicate an unsupported CPU instruction or a binary, native dependency, virtualization, or runtime defect.',
    )
  }

  return lines
}

function assertSupportedPlatform() {
  if (process.platform !== 'darwin') return
  const version = getMacOSVersion()
  const major = Number.parseInt(version?.split('.')[0] ?? '', 10)
  if (!Number.isFinite(major) || major >= MIN_SUPPORTED_MACOS_MAJOR) return
  if (major < MIN_LEGACY_MACOS_MAJOR) {
    console.error(
      `❌ Openbuff requires macOS ${MIN_LEGACY_MACOS_MAJOR} or newer; this Mac is running macOS ${version}.`,
    )
    console.error('Upgrade macOS, then reinstall or run openbuff again.')
    console.error('')
    process.exit(1)
  }
  const hardwareArch = getHardwareArch()
  if (
    (hardwareArch === 'x64' && process.arch === 'x64') ||
    (hardwareArch === 'arm64' && ['x64', 'arm64'].includes(process.arch))
  ) {
    return
  }

  console.error(
    `❌ Openbuff does not have a compatible macOS ${major} binary for architecture ${hardwareArch}/${process.arch}.`,
  )
  console.error('Upgrade macOS, then reinstall or run openbuff again.')
  console.error('')
  process.exit(1)
}

function getPlatformKey() {
  if (process.platform === 'darwin') {
    const major = Number.parseInt(getMacOSVersion()?.split('.')[0] ?? '', 10)
    if (
      Number.isFinite(major) &&
      major >= MIN_LEGACY_MACOS_MAJOR &&
      major < MIN_SUPPORTED_MACOS_MAJOR
    ) {
      const hardwareArch = getHardwareArch()
      if (hardwareArch === 'arm64') return 'darwin-arm64-legacy'
      if (process.arch === 'x64' && hardwareArch === 'x64') {
        return 'darwin-x64-legacy'
      }
    }
  }

  if (
    process.platform === 'darwin' &&
    process.arch === 'x64' &&
    getHardwareArch() === 'arm64'
  ) {
    return 'darwin-arm64'
  }

  return `${process.platform}-${process.arch}`
}

const term = {
  clearLine: () => {
    if (process.stderr.isTTY) {
      process.stderr.write('\r\x1b[K')
    }
  },
  write: (text) => {
    term.clearLine()
    process.stderr.write(text)
  },
  writeLine: (text) => {
    term.clearLine()
    process.stderr.write(text + '\n')
  },
}

function logUpdateDebug(...args) {
  if (!process.env.OPENBUFF_UPDATE_DEBUG) return
  console.error('[openbuff-update]', ...args)
}

function extractSemverLine(output) {
  if (!output) return null
  for (const line of String(output).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (/^\d+(\.\d+)*(?:-[0-9A-Za-z.-]+)?$/.test(trimmed)) return trimmed
  }
  return null
}

/**
 * Probe the installed binary's version without blocking the event loop. The
 * child is spawned asynchronously with a hard timeout so a hung or slow
 * binary (or a slow AV scan) can never stall a launch.
 */
function probeBinaryVersion(config = CONFIG, timeoutMs = 2000) {
  if (!fs.existsSync(config.binaryPath)) {
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    let settled = false
    let output = ''
    const finish = (version) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(version)
    }
    const child = spawn(config.binaryPath, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      logUpdateDebug('binary version probe timed out')
      child.kill()
      finish(null)
    }, timeoutMs)
    const collect = (chunk) => {
      output += chunk
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', (error) => {
      logUpdateDebug('binary version probe failed:', error?.message)
      finish(null)
    })
    child.on('close', () => {
      const version = extractSemverLine(output)
      if (!version) {
        logUpdateDebug('binary version probe returned no semver version line')
        finish(null)
        return
      }
      finish(version)
    })
  })
}

async function getLatestVersion() {
  try {
    const res = await httpGet(
      `https://registry.npmjs.org/${npmPackageName}/latest`,
    )

    if (res.statusCode !== 200) return null

    const body = await streamToString(res)
    const packageData = JSON.parse(body)

    return packageData.version || null
  } catch (error) {
    logUpdateDebug('latest version lookup failed:', error?.message)
    return null
  }
}

function getLocalPackageVersion() {
  const packageJsonPaths = [
    path.join(__dirname, 'package.json'),
    path.join(__dirname, '..', 'package.json'),
  ]

  for (const packageJsonPath of packageJsonPaths) {
    try {
      if (!fs.existsSync(packageJsonPath)) continue
      const packageData = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
      if (packageData.version) return packageData.version
    } catch (error) {
      // Try the next local source.
    }
  }

  return null
}

function getMetadataVersion() {
  try {
    if (!fs.existsSync(CONFIG.metadataPath)) {
      return null
    }
    const metadata = JSON.parse(fs.readFileSync(CONFIG.metadataPath, 'utf8'))
    return metadata.version || null
  } catch (error) {
    return null
  }
}

function getPendingUpdateVersion() {
  try {
    if (!fs.existsSync(CONFIG.metadataPath)) return null
    const metadata = JSON.parse(fs.readFileSync(CONFIG.metadataPath, 'utf8'))
    return metadata.pendingVersion || null
  } catch {
    return null
  }
}

/**
 * Metadata writes use a per-pid temp file plus atomic rename under a
 * single-writer assumption: concurrent launches may race, but the last rename
 * wins with a coherent snapshot. Keys mapped to undefined are dropped.
 */
function writeMetadataPatch(metadataPath, patch) {
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true })
  let metadata = {}
  try {
    if (fs.existsSync(metadataPath)) {
      metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
    }
  } catch {
    metadata = {}
  }
  const next = { ...metadata, ...patch }
  for (const key of Object.keys(next)) {
    if (next[key] === undefined) delete next[key]
  }
  const tempPath = `${metadataPath}.tmp-${process.pid}`
  fs.writeFileSync(tempPath, JSON.stringify(next, null, 2))
  try {
    fs.renameSync(tempPath, metadataPath)
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error.code)) throw error
    fs.unlinkSync(metadataPath)
    fs.renameSync(tempPath, metadataPath)
  }
}

function writePendingUpdateVersion(version) {
  writeMetadataPatch(CONFIG.metadataPath, { pendingVersion: version })
}

function getWrapperVersion() {
  return (
    getLocalPackageVersion() ||
    getMetadataVersion() ||
    getCurrentVersion() ||
    'dev'
  )
}

function isVersionFlag(args) {
  return args.length === 1 && (args[0] === '--version' || args[0] === '-v')
}

function isCheckUpdateFlag(args) {
  return args.length === 1 && args[0] === '--check-update'
}

function isUpdateFlag(args) {
  return args.length === 1 && (args[0] === '--update' || args[0] === '--upgrade')
}

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    let data = ''
    stream.on('data', (chunk) => (data += chunk))
    stream.on('end', () => resolve(data))
    stream.on('error', reject)
  })
}

function getCurrentVersion() {
  try {
    if (!fs.existsSync(CONFIG.metadataPath)) {
      return null
    }
    const metadata = JSON.parse(fs.readFileSync(CONFIG.metadataPath, 'utf8'))
    const platformKey = getPlatformKey()
    const nodePlatformKey = `${process.platform}-${process.arch}`
    if (metadata.platformKey && metadata.platformKey !== platformKey) {
      return null
    }
    if (!metadata.platformKey && platformKey !== nodePlatformKey) {
      return null
    }
    // Also verify the binary still exists
    if (!fs.existsSync(CONFIG.binaryPath)) {
      return null
    }
    return metadata.version || null
  } catch (error) {
    return null
  }
}

function compareVersions(v1, v2) {
  if (!v1 || !v2) return 0

  // Always update if the current version is not a valid semver
  // e.g. a local development label such as "dev"
  if (!v1.match(/^\d+(\.\d+)*(?:-[0-9A-Za-z.-]+)?$/)) {
    return -1
  }

  const parseVersion = (version) => {
    const parts = version.split('-')
    const mainParts = parts[0].split('.').map(Number)
    const prereleaseParts = parts[1] ? parts[1].split('.') : []
    return { main: mainParts, prerelease: prereleaseParts }
  }

  const p1 = parseVersion(v1)
  const p2 = parseVersion(v2)

  for (let i = 0; i < Math.max(p1.main.length, p2.main.length); i++) {
    const n1 = p1.main[i] || 0
    const n2 = p2.main[i] || 0

    if (n1 < n2) return -1
    if (n1 > n2) return 1
  }

  if (p1.prerelease.length === 0 && p2.prerelease.length === 0) {
    return 0
  } else if (p1.prerelease.length === 0) {
    return 1
  } else if (p2.prerelease.length === 0) {
    return -1
  } else {
    for (
      let i = 0;
      i < Math.max(p1.prerelease.length, p2.prerelease.length);
      i++
    ) {
      if (i >= p1.prerelease.length) return -1
      if (i >= p2.prerelease.length) return 1

      const pr1 = p1.prerelease[i]
      const pr2 = p2.prerelease[i]

      const isNum1 = /^\d+$/.test(pr1)
      const isNum2 = /^\d+$/.test(pr2)

      if (isNum1 && isNum2) {
        const num1 = Number(pr1)
        const num2 = Number(pr2)
        if (num1 < num2) return -1
        if (num1 > num2) return 1
      } else if (isNum1 && !isNum2) {
        return -1
      } else if (!isNum1 && isNum2) {
        return 1
      } else if (pr1 < pr2) {
        return -1
      } else if (pr1 > pr2) {
        return 1
      }
    }
    return 0
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

function createProgressBar(percentage, width = 30) {
  const filled = Math.round((width * percentage) / 100)
  const empty = width - filled
  return '[' + '█'.repeat(filled) + '░'.repeat(empty) + ']'
}

function getReleaseAssetBase(version) {
  const downloadBase =
    process.env.OPENBUFF_DOWNLOAD_BASE ||
    'https://github.com/AnzoBenjamin/openbuff/releases/download'
  return `${downloadBase}/v${version}`
}

async function getExpectedChecksum(version, fileName, httpGetFn = httpGet) {
  const checksumResponse = await httpGetFn(
    `${getReleaseAssetBase(version)}/SHA256SUMS`,
  )
  if (checksumResponse.statusCode !== 200) {
    checksumResponse.resume()
    throw new Error(
      `Checksum manifest download failed: HTTP ${checksumResponse.statusCode}`,
    )
  }

  return parseExpectedChecksum(await streamToString(checksumResponse), fileName)
}

function parseExpectedChecksum(checksumText, fileName) {
  for (const line of checksumText.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/)
    if (match && path.basename(match[2]) === fileName) {
      return match[1].toLowerCase()
    }
  }

  throw new Error(`Checksum missing for release asset ${fileName}`)
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

function downloadResponseToFile(response, destination, totalSize) {
  return new Promise((resolve, reject) => {
    let downloadedSize = 0
    let lastProgressTime = Date.now()
    const output = fs.createWriteStream(destination, { mode: 0o600 })

    response.on('data', (chunk) => {
      downloadedSize += chunk.length
      const now = Date.now()
      if (now - lastProgressTime < 100 && downloadedSize !== totalSize) return
      lastProgressTime = now
      if (totalSize > 0) {
        const pct = Math.round((downloadedSize / totalSize) * 100)
        term.write(
          `Downloading... ${createProgressBar(pct)} ${pct}% of ${formatBytes(totalSize)}`,
        )
      } else {
        term.write(`Downloading... ${formatBytes(downloadedSize)}`)
      }
    })
    response.on('error', reject)
    output.on('error', reject)
    output.on('finish', resolve)
    response.pipe(output)
  })
}

function assertExtractedRegularFile(extractionDir, filePath) {
  const root = path.resolve(extractionDir)
  const resolved = path.resolve(filePath)
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(
      `Release archive entry escapes extraction directory: ${filePath}`,
    )
  }

  let stat
  try {
    stat = fs.lstatSync(resolved)
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  if (!stat.isFile()) {
    throw new Error(
      `Release archive entry must be a regular file: ${path.basename(filePath)}`,
    )
  }
  return true
}

async function downloadBinary(version, options = {}) {
  const config = options.config || CONFIG
  const httpGetFn = options.httpGet || httpGet
  const extractArchive =
    options.extractArchive || ((tarOptions) => require('tar').x(tarOptions))
  const rename = options.rename || fs.renameSync
  const platformKey = options.platformKey || getPlatformKey()
  const fileName = PLATFORM_TARGETS[platformKey]

  if (!fileName) {
    const error = new Error(
      `Unsupported platform: ${process.platform} ${process.arch}`,
    )
    trackUpdateFailed(error.message, version, {
      stage: 'platform_check',
      platformKey,
    })
    throw error
  }

  const downloadUrl = `${getReleaseAssetBase(version)}/${fileName}`
  fs.mkdirSync(config.configDir, { recursive: true })
  if (fs.existsSync(config.tempDownloadDir)) {
    fs.rmSync(config.tempDownloadDir, { recursive: true })
  }
  fs.mkdirSync(config.tempDownloadDir, { recursive: true })
  term.write('Downloading...')

  try {
    let expectedChecksum
    try {
      expectedChecksum = await getExpectedChecksum(version, fileName, httpGetFn)
    } catch (error) {
      trackUpdateFailed(error.message, version, { stage: 'checksum_manifest' })
      throw error
    }

    const res = await httpGetFn(downloadUrl)
    if (res.statusCode !== 200) {
      res.resume()
      const error = new Error(`Download failed: HTTP ${res.statusCode}`)
      trackUpdateFailed(error.message, version, {
        stage: 'http_download',
        statusCode: res.statusCode,
      })
      throw error
    }

    const totalSize = parseInt(res.headers['content-length'] || '0', 10)
    const archivePath = path.join(config.tempDownloadDir, fileName)
    await downloadResponseToFile(res, archivePath, totalSize)

    const actualChecksum = await hashFile(archivePath)
    if (actualChecksum !== expectedChecksum) {
      const error = new Error(
        `Checksum verification failed for ${fileName}: expected ${expectedChecksum}, received ${actualChecksum}`,
      )
      trackUpdateFailed(error.message, version, { stage: 'checksum_verify' })
      throw error
    }

    await extractArchive({
      cwd: config.tempDownloadDir,
      file: archivePath,
      preservePaths: false,
      strict: true,
    })

    const tempBinaryPath = path.join(config.tempDownloadDir, config.binaryName)
    if (!assertExtractedRegularFile(config.tempDownloadDir, tempBinaryPath)) {
      const files = fs.readdirSync(config.tempDownloadDir)
      const error = new Error(
        `Binary not found after extraction. Expected: ${config.binaryName}, Available files: ${files.join(', ')}`,
      )
      trackUpdateFailed(error.message, version, { stage: 'extraction' })
      throw error
    }

    const managedSiblings = getManagedSiblingNames(config.tempDownloadDir)
      .map((name) => ({
        name,
        source: path.join(config.tempDownloadDir, name),
        target: path.join(path.dirname(config.binaryPath), name),
      }))
      .filter(({ source }) =>
        assertExtractedRegularFile(config.tempDownloadDir, source),
      )
    const tempMetadataPath = path.join(
      config.tempDownloadDir,
      path.basename(config.metadataPath),
    )
    assertExtractedRegularFile(config.tempDownloadDir, tempMetadataPath)

    const extractedAssetProblems = getTreeSitterAssetProblems(
      config.tempDownloadDir,
    )
    if (extractedAssetProblems.length) {
      throw new Error(
        `Release archive has incomplete tree-sitter assets: ${extractedAssetProblems.join(', ')}`,
      )
    }

    if (process.platform !== 'win32') fs.chmodSync(tempBinaryPath, 0o755)

    const installFiles = [
      { source: tempBinaryPath, target: config.binaryPath },
      ...managedSiblings,
    ]
    // Preserve the crash-heal budget: a fresh install must never reset the
    // bounded quarantine/re-download loop for a persistently crashing release.
    const previousCrashHeal = readMetadata(config.metadataPath).crashHeal
    fs.writeFileSync(
      tempMetadataPath,
      JSON.stringify(
        {
          version,
          platformKey,
          ...(previousCrashHeal ? { crashHeal: previousCrashHeal } : {}),
        },
        null,
        2,
      ),
    )
    installFiles.push({ source: tempMetadataPath, target: config.metadataPath })

    for (const file of installFiles) {
      if (process.platform !== 'win32' && file.name === 'rg') {
        fs.chmodSync(file.source, 0o755)
      }
    }

    const committed = []
    try {
      for (const [index, file] of installFiles.entries()) {
        const backup = `${file.target}.rollback-${process.pid}-${index}`
        const hadExisting = fs.existsSync(file.target)
        if (hadExisting) rename(file.target, backup)
        try {
          rename(file.source, file.target)
        } catch (error) {
          if (hadExisting && fs.existsSync(backup)) rename(backup, file.target)
          throw error
        }
        committed.push({ ...file, backup: hadExisting ? backup : null })
      }
    } catch (error) {
      for (const file of committed.reverse()) {
        if (fs.existsSync(file.target)) fs.unlinkSync(file.target)
        if (file.backup && fs.existsSync(file.backup)) {
          fs.renameSync(file.backup, file.target)
        }
      }
      throw error
    }

    for (const file of committed) {
      if (!file.backup) continue
      try {
        fs.unlinkSync(file.backup)
      } catch {
        // A stale backup is harmless and can be removed on a later launch.
      }
    }

    term.clearLine()
    console.log('Download complete! Starting Openbuff...')
  } finally {
    if (fs.existsSync(config.tempDownloadDir)) {
      fs.rmSync(config.tempDownloadDir, { recursive: true })
    }
  }
}

function printInstallFailureGuidance(resolveProxyUrl, logError) {
  logError('Please check your internet connection and try again')
  if (!resolveProxyUrl()) {
    logError(
      'If you are behind a proxy, set the HTTPS_PROXY environment variable',
    )
  }
}

async function ensureBinaryExists(options = {}) {
  const config = options.config || CONFIG
  const logError = options.consoleError || console.error
  const resolveProxyUrl = options.getProxyUrl || getProxyUrl
  const exit = options.exit || process.exit
  const currentVersionInjected = options.currentVersion !== undefined
  let currentVersion = currentVersionInjected
    ? options.currentVersion
    : getCurrentVersion()
  const binaryExists = fs.existsSync(config.binaryPath)
  const packagedVersion =
    options.packagedVersion === undefined
      ? getLocalPackageVersion()
      : options.packagedVersion

  // Self-heal: when metadata is lost or stale but the binary still runs, ask
  // the binary itself for its build version instead of trusting the wrapper's
  // own (stale) package version, which would silently downgrade the install.
  // Explicitly injected current versions (tests, --update) skip the probe
  // unless they provide a probe hook themselves.
  if (
    currentVersion === null &&
    binaryExists &&
    (options.probeBinaryVersion || !currentVersionInjected)
  ) {
    const probe =
      options.probeBinaryVersion || (async () => probeBinaryVersion(config))
    const probedVersion = await probe()
    if (probedVersion) {
      logUpdateDebug('healing metadata from binary probe:', probedVersion)
      writeMetadataPatch(config.metadataPath, {
        version: probedVersion,
        platformKey: getPlatformKey(),
      })
      currentVersion = probedVersion
    } else if (packagedVersion) {
      // Offline fallback: a probe-resistant binary plus no network must not
      // become a hard launch failure. Adopt the bundled packaged version in
      // memory only so the existing binary keeps launching without any
      // network dependency. Nothing is persisted: the binary could not be
      // verified (it may not even run on this platform), so recording a
      // version/platformKey pair would make later launches trust an
      // unverified binary instead of repairing it.
      logUpdateDebug(
        'binary probe failed; adopting packaged version in memory only:',
        packagedVersion,
      )
      currentVersion = packagedVersion
    }
  }

  const assetProblems = currentVersion
    ? getTreeSitterAssetProblems(config.configDir)
    : []
  let pendingVersion = options.pendingVersion
  if (pendingVersion === undefined) {
    try {
      pendingVersion = fs.existsSync(config.metadataPath)
        ? JSON.parse(fs.readFileSync(config.metadataPath, 'utf8'))
            .pendingVersion || null
        : null
    } catch {
      pendingVersion = null
    }
  }
  // The wrapper package version is only a fresh-install target; it must never
  // act as a downgrade floor for an existing (possibly newer) binary.
  const packagedUpdate =
    packagedVersion &&
    (currentVersion === null
      ? !binaryExists
      : compareVersions(currentVersion, packagedVersion) < 0)
      ? packagedVersion
      : null

  // A previously failed staged download is not retried for 24h so a poisoned
  // release cannot stall every launch; a successful apply clears the marker.
  let failedPending = null
  try {
    failedPending = fs.existsSync(config.metadataPath)
      ? JSON.parse(fs.readFileSync(config.metadataPath, 'utf8'))
          .failedPendingVersion || null
      : null
  } catch {
    failedPending = null
  }
  const pendingRetryable =
    !failedPending ||
    failedPending.version !== pendingVersion ||
    Date.now() - failedPending.at >= 24 * 60 * 60 * 1000
  const stagedVersion = pendingRetryable ? pendingVersion : null
  if (pendingVersion && !pendingRetryable) {
    logUpdateDebug('skipping recently failed staged update:', pendingVersion)
  }

  const requestedVersion =
    stagedVersion ||
    packagedUpdate ||
    (assetProblems.length ? currentVersion : null)

  if (currentVersion !== null && !requestedVersion) return

  if (assetProblems.length) {
    logError(
      `Repairing incomplete tree-sitter assets: ${assetProblems.join(', ')}`,
    )
  }

  const version =
    requestedVersion || (await (options.getLatestVersion || getLatestVersion)())
  if (!version) {
    logError('❌ Failed to determine latest version')
    printInstallFailureGuidance(resolveProxyUrl, logError)
    exit(1)
  }

  const download =
    options.downloadBinary ||
    ((requestedVersion) => downloadBinary(requestedVersion, { config }))
  const isStagedOrUpgradeTarget =
    version === stagedVersion || version === packagedUpdate
  const canKeepCurrentBinary =
    isStagedOrUpgradeTarget &&
    currentVersion !== null &&
    fs.existsSync(config.binaryPath)
  try {
    await download(version)
  } catch (error) {
    term.clearLine()
    if (canKeepCurrentBinary) {
      // A failed staged update must never brick the CLI: keep launching the
      // working binary and record the failure so we back off for 24h.
      logError(
        `Failed to apply update to ${version} — keeping current version ${currentVersion}. Run 'openbuff --update' to retry.`,
      )
      logUpdateDebug('staged update failed:', error.message)
      try {
        writeMetadataPatch(config.metadataPath, {
          pendingVersion: undefined,
          failedPendingVersion: { version, at: Date.now() },
        })
      } catch (writeError) {
        logUpdateDebug(
          'failed to record staged-update failure:',
          writeError?.message,
        )
      }
      return
    }
    logError('❌ Failed to download openbuff:', error.message)
    printInstallFailureGuidance(resolveProxyUrl, logError)
    exit(1)
  }
}

async function checkForUpdates(options = {}) {
  let latestVersion = null
  try {
    const currentVersion =
      options.currentVersion === undefined
        ? getCurrentVersion()
        : options.currentVersion
    latestVersion = await (options.getLatestVersion || getLatestVersion)()
    if (!latestVersion) return null

    if (
      currentVersion === null ||
      compareVersions(currentVersion, latestVersion) < 0
    ) {
      const persistPending =
        options.writePendingUpdateVersion || writePendingUpdateVersion
      persistPending(latestVersion)
    }
    return latestVersion
  } catch (error) {
    logUpdateDebug('background update check failed:', error?.message)
    trackUpdateFailed(error.message, null, { stage: 'background_check' })
    return latestVersion
  }
}

async function handleCheckUpdateCommand(options = {}) {
  const config = options.config || CONFIG
  void config
  const log = options.consoleLog || console.log
  const logError = options.consoleError || console.error
  const exit = options.exit || process.exit
  const resolveProxyUrl = options.getProxyUrl || getProxyUrl
  const getCurrent = options.getCurrentVersion || getCurrentVersion
  const getLatest = options.getLatestVersion || getLatestVersion
  const persist = options.writePendingUpdateVersion || writePendingUpdateVersion
  const compare = options.compareVersions || compareVersions

  const currentVersion =
    options.currentVersion !== undefined ? options.currentVersion : getCurrent()
  const latestVersion =
    options.latestVersion !== undefined
      ? options.latestVersion
      : await getLatest()

  if (!latestVersion) {
    logError('❌ Failed to determine latest version')
    printInstallFailureGuidance(resolveProxyUrl, logError)
    exit(1)
    return
  }

  if (
    currentVersion === null ||
    currentVersion === undefined ||
    compare(currentVersion, latestVersion) < 0
  ) {
    try {
      persist(latestVersion)
    } catch (error) {
      logError('❌ Failed to stage update:', error.message)
      printInstallFailureGuidance(resolveProxyUrl, logError)
      exit(1)
      return
    }
    log(
      `Update ${latestVersion} available (current ${currentVersion ?? 'unknown'}) \u2014 staged and will apply on next launch.`,
    )
    log('Restart to apply, or run openbuff --update now from your shell.')
  } else {
    log(`Openbuff is up to date (${currentVersion}).`)
  }
  exit(0)
}

async function handleUpdateCommand(options = {}) {
  const config = options.config || CONFIG
  const log = options.consoleLog || console.log
  const logError = options.consoleError || console.error
  const exit = options.exit || process.exit
  const resolveProxyUrl = options.getProxyUrl || getProxyUrl
  const compare = options.compareVersions || compareVersions
  const getCurrent = options.getCurrentVersion || getCurrentVersion
  const getPending = options.getPendingUpdateVersion || getPendingUpdateVersion
  const getLatest = options.getLatestVersion || getLatestVersion

  const currentVersion =
    options.currentVersion !== undefined ? options.currentVersion : getCurrent()
  const pendingVersion =
    options.pendingVersion !== undefined ? options.pendingVersion : getPending()

  const hasPendingUpdate =
    pendingVersion &&
    (currentVersion === null ||
      currentVersion === undefined ||
      compare(currentVersion, pendingVersion) < 0)

  let targetVersion = null
  if (hasPendingUpdate) {
    targetVersion = pendingVersion
  } else {
    const latestVersion =
      options.latestVersion !== undefined
        ? options.latestVersion
        : await getLatest()
    if (!latestVersion) {
      logError('❌ Failed to determine latest version')
      printInstallFailureGuidance(resolveProxyUrl, logError)
      exit(1)
      return
    }
    if (
      currentVersion !== null &&
      currentVersion !== undefined &&
      compare(currentVersion, latestVersion) >= 0
    ) {
      log(`Openbuff is up to date (${currentVersion}).`)
      exit(0)
      return
    }
    targetVersion = latestVersion
  }

  if (!targetVersion) {
    log(`Openbuff is up to date (${currentVersion ?? 'unknown'}).`)
    exit(0)
    return
  }

  try {
    if (options.downloadBinary) {
      await options.downloadBinary(targetVersion)
    } else if (options.ensureBinaryExists) {
      await options.ensureBinaryExists({
        config,
        consoleError: logError,
        exit,
        getLatestVersion: async () => targetVersion,
        currentVersion,
        pendingVersion: targetVersion,
      })
    } else {
      await downloadBinary(targetVersion, { config })
    }
    const appliedVersion = getCurrent()
    if (
      appliedVersion !== null &&
      compare(appliedVersion, targetVersion) >= 0
    ) {
      log(`Updated to ${targetVersion}.`)
      exit(0)
    } else {
      log(
        `Could not update to ${targetVersion}; kept ${appliedVersion ?? 'current version'}. Run 'openbuff --update' to retry.`,
      )
      exit(1)
      return
    }
  } catch (error) {
    term.clearLine()
    logError('❌ Failed to download openbuff:', error.message)
    printInstallFailureGuidance(resolveProxyUrl, logError)
    exit(1)
  }
}

function readMetadata(metadataPath = CONFIG.metadataPath) {
  try {
    if (!fs.existsSync(metadataPath)) return {}
    return JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
  } catch {
    return {}
  }
}

function getCrashKind(code, signal) {
  // Windows NTSTATUS codes (unsigned DWORD)
  const unsignedCode = code != null && code < 0 ? code >>> 0 : code
  if (signal === 'SIGILL') return 'illegal-instruction'
  if (process.platform === 'win32' && unsignedCode === 0xc000001d) {
    return 'illegal-instruction'
  }
  if (signal === 'SIGSEGV') return 'access-violation'
  if (process.platform === 'win32' && unsignedCode === 0xc0000005) {
    return 'access-violation'
  }
  if (signal === 'SIGBUS') return 'bus-error'
  if (signal === 'SIGABRT') return 'abort'
  if (process.platform === 'win32' && unsignedCode === 0xc0000409) {
    return 'abort'
  }
  return null
}

function isCrashExit(code, signal) {
  return getCrashKind(code, signal) !== null
}

/**
 * Self-heal for a crashing binary: quarantine it and clear the recorded
 * version so the next launch re-downloads a checksum-verified copy. The
 * crashHeal counter bounds the loop at 3 attempts per 24h so a persistently
 * incompatible release cannot download forever.
 */
function quarantineCrashedBinary(config = CONFIG) {
  const crashHeal = readMetadata(config.metadataPath).crashHeal || {
    count: 0,
    lastAt: 0,
  }
  if (
    crashHeal.count >= 3 &&
    Date.now() - crashHeal.lastAt < 24 * 60 * 60 * 1000
  ) {
    logUpdateDebug('crash-heal budget exhausted; skipping quarantine')
    return
  }
  try {
    fs.renameSync(
      config.binaryPath,
      `${config.binaryPath}.crash-quarantine-${Date.now()}`,
    )
  } catch (error) {
    logUpdateDebug('failed to quarantine crashing binary:', error?.message)
  }
  try {
    writeMetadataPatch(config.metadataPath, {
      version: undefined,
      crashHeal: { count: crashHeal.count + 1, lastAt: Date.now() },
    })
  } catch (error) {
    logUpdateDebug('failed to record crash heal:', error?.message)
  }
  console.error(
    'Openbuff crashed; quarantined the binary. The next launch will download a fresh copy.',
  )
}

function printCrashDiagnostics(code, signal) {
  const crashKind = getCrashKind(code, signal)
  if (!crashKind) return

  const exitInfo = signal ? `signal ${signal}` : `code ${code}`
  const platformKey = getPlatformKey()
  const target = PLATFORM_TARGETS[platformKey] || 'unsupported'
  const cpuInfo = getCpuCompatibilityInfo(platformKey)
  console.error('')
  console.error(`❌ ${binaryName} exited immediately (${exitInfo})`)
  console.error('')

  if (crashKind === 'illegal-instruction') {
    for (const line of getIllegalInstructionGuidance(cpuInfo)) {
      console.error(line)
    }
    console.error('')
  } else if (crashKind === 'access-violation') {
    console.error('The binary crashed with an access violation.')
    console.error('')
  } else if (crashKind === 'bus-error') {
    console.error('The binary crashed with a bus error.')
    console.error('This may indicate a platform compatibility issue.')
    console.error('')
  } else {
    console.error('The binary crashed with an abort signal.')
    console.error('')
  }

  console.error('System info:')
  console.error(`  Platform: ${process.platform} ${process.arch}`)
  console.error(`  Hardware: ${getHardwareArch()}`)
  console.error(`  CPU:      ${cpuInfo.model ?? 'unknown'}`)
  console.error(
    `  AVX2:     ${!cpuInfo.avx2Applicable ? 'not applicable' : cpuInfo.avx2 === true ? 'supported' : cpuInfo.avx2 === false ? 'not reported' : 'unknown'}`,
  )
  if (process.platform === 'darwin') {
    console.error(`  macOS:    ${getMacOSVersion() ?? 'unknown'}`)
  }
  console.error(`  Target:   ${platformKey} (${target})`)
  console.error(`  Wrapper:  ${getWrapperVersion()}`)
  console.error(`  Installed: ${getMetadataVersion() ?? 'unknown'}`)
  console.error(`  Node:     ${process.version}`)
  console.error(`  Binary:   ${CONFIG.binaryPath}`)
  console.error('')
  console.error('Please report this issue at:')
  console.error('  https://github.com/AnzoBenjamin/openbuff/issues')
  console.error('')
}

async function main() {
  const args = process.argv.slice(2)

  if (isVersionFlag(args)) {
    // Keep the historical one-line stdout contract for '--version'/'-v';
    // wrapper/binary skew notices belong on stderr at child exit.
    console.log(getWrapperVersion())
    return
  }

  if (isCheckUpdateFlag(args)) {
    await handleCheckUpdateCommand()
    return
  }

  if (isUpdateFlag(args)) {
    await handleUpdateCommand()
    return
  }

  assertSupportedPlatform()

  if (process.platform === 'win32') {
    cleanupOldBinaryBackups(CONFIG.binaryPath)
  }

  await ensureBinaryExists()

  const child = spawn(CONFIG.binaryPath, args, {
    stdio: 'inherit',
  })

  const exitListener = (code, signal) => {
    resetTerminal()
    printCrashDiagnostics(code, signal)
    try {
      const installedVersion = getMetadataVersion()
      const wrapperVersion = getLocalPackageVersion()
      if (
        installedVersion &&
        wrapperVersion &&
        compareVersions(installedVersion, wrapperVersion) > 0
      ) {
        console.error(
          `Note: the installed binary is version ${installedVersion} but this npm wrapper is ${wrapperVersion}. Update the wrapper with: npm i -g ${npmPackageName}`,
        )
      }
      if (isCrashExit(code, signal)) {
        quarantineCrashedBinary()
      }
      const pending = getPendingUpdateVersion()
      if (pending) {
        const current = getCurrentVersion()
        if (current === null || compareVersions(current, pending) < 0) {
          console.error(
            `Update ${pending} available \u2014 will apply on next launch (or run openbuff --update now).`,
          )
        }
      }
    } catch {
      // Best-effort notice only; never break normal exit.
    }
    process.exit(signal ? 1 : code || 0)
  }

  child.on('exit', exitListener)

  child.on('error', (err) => {
    console.error('Failed to start openbuff:', err.message)
    process.exit(1)
  })

  // Bounded background update check: retry twice with backoff when the npm
  // lookup fails, but never keep the wrapper process alive just for retries.
  const scheduleUpdateCheck = (delay, retriesLeft) => {
    const timer = setTimeout(() => {
      void checkForUpdates().then((latestVersion) => {
        if (
          latestVersion ||
          retriesLeft <= 0 ||
          child.exitCode !== null ||
          child.signalCode !== null
        ) {
          return
        }
        scheduleUpdateCheck(retriesLeft === 2 ? 30000 : 90000, retriesLeft - 1)
      })
    }, delay)
    timer.unref()
  }
  scheduleUpdateCheck(100, 2)
}

if (require.main === module) {
  main().catch((error) => {
    console.error('❌ Unexpected error:', error.message)
    process.exit(1)
  })
}

module.exports = {
  checkForUpdates,
  cleanupOldBinaryBackups,
  compareVersions,
  downloadBinary,
  ensureBinaryExists,
  getIllegalInstructionGuidance,
  getManagedSiblingNames,
  getPendingUpdateVersion,
  getTreeSitterAssetProblems,
  getUpdateFailureProperties,
  handleCheckUpdateCommand,
  handleUpdateCommand,
  isCheckUpdateFlag,
  isCrashExit,
  isUpdateFlag,
  parseExpectedChecksum,
  parseLinuxCpuInfo,
  probeBinaryVersion,
  resolveConfigDir,
}
