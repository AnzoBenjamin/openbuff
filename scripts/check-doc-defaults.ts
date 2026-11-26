import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')

async function read(relativePath: string): Promise<string> {
  return readFile(resolve(root, relativePath), 'utf8')
}

function captureNumber(source: string, pattern: RegExp, label: string): number {
  const match = source.match(pattern)
  if (!match) throw new Error(`Could not find source value for ${label}`)
  return Number(match[1])
}

function requireText(source: string, value: string, label: string): void {
  if (!source.includes(value)) {
    throw new Error(`Documentation is missing ${label}: ${value}`)
  }
}

const [
  hookSource,
  providerConfig,
  readFilesSource,
  filesystemSource,
  base2Source,
  configDoc,
  environmentDoc,
  agentsDoc,
  editDoc,
] = await Promise.all([
  read('sdk/src/tools/file-change-hooks.ts'),
  read('sdk/src/provider-config.ts'),
  read('common/src/tools/params/tool/read-files.ts'),
  read('common/src/tools/results/filesystem.ts'),
  read('agents/base2/base2.ts'),
  read('docs/configuration.md'),
  read('docs/environment-variables.md'),
  read('docs/agents-and-tools.md'),
  read('docs/deterministic-edit-system.md'),
])

const hookTimeout = captureNumber(
  hookSource,
  /const HOOK_DEFAULT_TIMEOUT_SECONDS = (-?\d+)/,
  'hook timeout',
)
const maxHookTimeout = captureNumber(
  providerConfig,
  /timeoutSeconds:\s*z\s*\.union\(\[[\s\S]*?z\.number\(\)\.int\(\)\.positive\(\)\.max\((\d+)\)/,
  'maximum hook timeout',
)
const defaultWindowSize = captureNumber(
  readFilesSource,
  /const DEFAULT_WINDOW_SIZE = (\d+)/,
  'read window size',
)
const maxWindowSize = captureNumber(
  readFilesSource,
  /export const MAX_WINDOW_SIZE = (\d+)/,
  'maximum read window size',
)
const defaultContextLines = captureNumber(
  readFilesSource,
  /const DEFAULT_CONTEXT_LINES = (\d+)/,
  'read context lines',
)
const maxContextLines = captureNumber(
  readFilesSource,
  /export const MAX_CONTEXT_LINES = (\d+)/,
  'maximum read context lines',
)
const blockContentMiB = captureNumber(
  filesystemSource,
  /export const READ_FILES_BLOCK_CONTENT_MAX_BYTES = (\d+)\s*\*\s*1024\s*\*\s*1024/,
  'read block content bytes',
)
const wholeFileContentMiB = captureNumber(
  filesystemSource,
  /export const FILESYSTEM_RESULT_CONTENT_MAX_BYTES = (\d+)\s*\*\s*1024\s*\*\s*1024/,
  'whole-file result bytes',
)

if (!hookSource.includes('captured?.autoFileChangeHooks === true')) {
  throw new Error(
    'Hook inference no longer matches the documented explicit opt-in contract',
  )
}
if (
  !/autoFileChangeHooks:\s*z\.boolean\(\)\.optional\(\)/.test(providerConfig)
) {
  throw new Error(
    'Expected autoFileChangeHooks to remain optional in provider config',
  )
}
if (!/progressiveToolDisclosureOption\s*\?\?\s*true/.test(base2Source)) {
  throw new Error('Base2 progressive tool disclosure no longer defaults on')
}
if (
  !/unlockedTiersOption\s*\?\?\s*\(progressiveToolDisclosure\s*\?\s*\[\]\s*:\s*undefined\)/.test(
    base2Source,
  )
) {
  throw new Error('Base2 no longer starts progressive tool disclosure at CORE')
}
requireText(
  configDoc,
  'Only when a trusted project explicitly sets `autoFileChangeHooks: true`',
  'the trusted-project hook opt-in',
)
requireText(
  configDoc,
  'It defaults to `true`: base2 starts with its core tool',
  'the core-first base2 default',
)
requireText(
  environmentDoc,
  '`progressiveToolDisclosure: false` restores the full static tool surface',
  'the progressive tool disclosure opt-out',
)
if (configDoc.includes('When `autoFileChangeHooks` is unset or `true`')) {
  throw new Error('Documentation incorrectly enables inferred hooks when unset')
}
requireText(
  configDoc,
  hookTimeout === -1
    ? 'Omitting `timeoutSeconds` adds no local timeout'
    : `Omitting \`timeoutSeconds\` applies a ${hookTimeout}-second local timeout`,
  'the default hook timeout',
)
requireText(
  configDoc,
  `capped at ${maxHookTimeout.toLocaleString('en-US')} seconds`,
  'the maximum hook timeout',
)
requireText(
  agentsDoc,
  hookTimeout === -1
    ? 'file-change hooks and terminal commands default to no local time cap'
    : `default to a ${hookTimeout}-second local cap`,
  'the agent/tool hook timeout',
)
requireText(
  editDoc,
  `default \`windowSize\` ${defaultWindowSize}, maximum ${maxWindowSize}`,
  'the read window size defaults',
)
requireText(
  editDoc,
  `default ${defaultContextLines}, maximum ${maxContextLines}`,
  'the read context line defaults',
)
requireText(
  editDoc,
  `capped at ${blockContentMiB} MiB`,
  'the read block content byte cap',
)
requireText(
  editDoc,
  `capped at ${wholeFileContentMiB} MiB`,
  'the whole-file result byte cap',
)

console.log(
  `Documentation defaults match code: hooks ${hookTimeout}s/${maxHookTimeout}s; read windows ${defaultWindowSize}/${maxWindowSize}; context ${defaultContextLines}/${maxContextLines}; blocks ${blockContentMiB} MiB; whole-file ${wholeFileContentMiB} MiB.`,
)
