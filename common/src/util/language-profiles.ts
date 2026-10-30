import {
  LANGUAGE_CAPABILITY_REGISTRY,
  SUPPORTED_LANGUAGE_IDS,
  type LanguageCapability,
  type SupportedLanguageId,
} from './language-capabilities'

import type { FileTreeNode } from './file'
import * as path from 'path'

export {
  LANGUAGE_CAPABILITY_REGISTRY,
  SUPPORTED_LANGUAGE_IDS,
  getLanguageCapability,
} from './language-capabilities'
export type {
  LanguageCapability,
  LanguageToolMetadata,
  LanguageToolRole,
  LanguageValidationMetadata,
  LanguageValidationStage,
  SupportedLanguageId,
} from './language-capabilities'

/** Backwards-compatible name for callers that only need prompt fields. */
export type LanguageProfile = LanguageCapability

export type LanguageProfileSelection = {
  fileTree: FileTreeNode[]
  /** Files the task is expected to read or modify. */
  targetPaths?: readonly string[]
  /** Natural-language task text used only for explicit language signals. */
  taskText?: string
  /** Optional output cap after applying stable registry order. */
  maxProfiles?: number
}

type LanguageLookupMaps = {
  extension: ReadonlyMap<string, SupportedLanguageId>
  manifestName: ReadonlyMap<string, SupportedLanguageId>
  manifestExtension: ReadonlyMap<string, SupportedLanguageId>
}

function buildUniqueLookup(
  entries: ReadonlyArray<readonly [string, SupportedLanguageId]>,
  label: string,
): ReadonlyMap<string, SupportedLanguageId> {
  const lookup = new Map<string, SupportedLanguageId>()
  for (const [signal, languageId] of entries) {
    const existing = lookup.get(signal)
    if (existing && existing !== languageId) {
      throw new Error(
        `Duplicate ${label} language signal ${signal}: ${existing}, ${languageId}`,
      )
    }
    lookup.set(signal, languageId)
  }
  return lookup
}

function buildLanguageLookups(): LanguageLookupMaps {
  const extensionEntries: Array<readonly [string, SupportedLanguageId]> = []
  const manifestNameEntries: Array<readonly [string, SupportedLanguageId]> = []
  const manifestExtensionEntries: Array<
    readonly [string, SupportedLanguageId]
  > = []

  for (const languageId of SUPPORTED_LANGUAGE_IDS) {
    const capability = LANGUAGE_CAPABILITY_REGISTRY[languageId]
    for (const extension of capability.extensions) {
      extensionEntries.push([extension.toLowerCase(), languageId])
    }
    for (const manifestName of capability.manifestNames) {
      manifestNameEntries.push([manifestName, languageId])
    }
    for (const extension of capability.manifestExtensions) {
      manifestExtensionEntries.push([extension.toLowerCase(), languageId])
    }
  }

  return {
    extension: buildUniqueLookup(extensionEntries, 'source extension'),
    manifestName: buildUniqueLookup(manifestNameEntries, 'manifest name'),
    manifestExtension: buildUniqueLookup(
      manifestExtensionEntries,
      'manifest extension',
    ),
  }
}

const LANGUAGE_LOOKUPS = buildLanguageLookups()

function getBaseName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

function getFileExtension(name: string): string {
  const baseName = getBaseName(name)
  const index = baseName.lastIndexOf('.')
  if (index <= 0) return ''
  return baseName.slice(index).toLowerCase()
}

/**
 * Pinned language-family extension sets, allocated once at module load instead
 * of rebuilding five array literals per getLanguageFamily invocation. That
 * function runs inside the call-graph caller-edge nested loops (per call and
 * per candidate), so hoisting keeps allocations from scaling with total
 * candidate edges in large/polyglot repos.
 */
const TYPESCRIPT_FAMILY_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts'])
const JAVASCRIPT_FAMILY_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs'])
const C_FAMILY_EXTENSIONS = new Set(['.c', '.h'])
const CPP_FAMILY_EXTENSIONS = new Set([
  '.cc',
  '.cpp',
  '.cxx',
  '.hpp',
  '.hh',
  '.hxx',
])
const KOTLIN_FAMILY_EXTENSIONS = new Set(['.kt', '.kts'])

/**
 * Canonical extension -> language-family map shared by code-map and the
 * indexer. Accepts either a leading-dot extension or a file path (extension is
 * derived via path.extname). Returns 'typescript'/'javascript'/'c'/'cpp'/
 * 'kotlin' for the pinned families, otherwise the normalized extension (with
 * dot; '' when there is none). undefined input yields '' so callers passing an
 * optional extension typecheck without casts.
 *
 * Deliberately NOT derived from LANGUAGE_CAPABILITY_REGISTRY: that registry
 * conflates js into typescript and c into cpp, which would collapse the
 * ts-vs-js and c-vs-cpp separation pinned by the code-map buildTokenCallers
 * tests and the indexer call-navigation suite.
 */
export function getLanguageFamily(
  filePathOrExtension: string | undefined,
): string {
  if (filePathOrExtension === undefined) return ''
  // path.extname resolves the extension for real paths, including files that
  // live inside a dot-directory (e.g. '.storybook/main.ts', '.config/foo.ts').
  // It returns '' for a bare leading-dot token like '.ts', so treat a
  // separator-free leading-dot input as a candidate extension only for the
  // pinned-family checks below. That keeps '.ts'->typescript / '.jsx'->
  // javascript bare-token resolution working without echoing a dotfile name
  // like '.env' verbatim: a dotfile has no extension per path.extname, so it
  // falls through to the documented '' result.
  const extnameResult = path.extname(filePathOrExtension).toLowerCase()
  const bareDotToken =
    !extnameResult &&
    filePathOrExtension.startsWith('.') &&
    !/[\\/]/.test(filePathOrExtension)
      ? filePathOrExtension.toLowerCase()
      : ''
  const candidate = extnameResult || bareDotToken
  if (TYPESCRIPT_FAMILY_EXTENSIONS.has(candidate)) return 'typescript'
  if (JAVASCRIPT_FAMILY_EXTENSIONS.has(candidate)) return 'javascript'
  if (C_FAMILY_EXTENSIONS.has(candidate)) return 'c'
  if (CPP_FAMILY_EXTENSIONS.has(candidate)) return 'cpp'
  if (KOTLIN_FAMILY_EXTENSIONS.has(candidate)) return 'kotlin'
  return extnameResult
}

export function detectLanguageIdForPath(
  filePath: string,
): SupportedLanguageId | undefined {
  const baseName = getBaseName(filePath)
  if (
    [
      'build.gradle',
      'build.gradle.kts',
      'settings.gradle',
      'settings.gradle.kts',
      'gradle.properties',
    ].includes(baseName)
  ) {
    return undefined
  }
  const extension = getFileExtension(baseName)

  return (
    LANGUAGE_LOOKUPS.manifestName.get(baseName) ??
    LANGUAGE_LOOKUPS.manifestExtension.get(extension) ??
    LANGUAGE_LOOKUPS.extension.get(extension)
  )
}

function profilesForIds(
  detected: ReadonlySet<SupportedLanguageId>,
  maxProfiles?: number,
): LanguageProfile[] {
  const ordered = SUPPORTED_LANGUAGE_IDS.filter((id) => detected.has(id)).map(
    (id) => LANGUAGE_CAPABILITY_REGISTRY[id],
  )
  if (maxProfiles === undefined) return ordered
  return ordered.slice(0, Math.max(0, Math.floor(maxProfiles)))
}

export function detectLanguageProfilesFromPaths(
  filePaths: readonly string[],
): LanguageProfile[] {
  const detected = new Set<SupportedLanguageId>()
  for (const filePath of filePaths) {
    const languageId = detectLanguageIdForPath(filePath)
    if (languageId) detected.add(languageId)
  }
  return profilesForIds(detected)
}

export function escapeRegexForLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function taskAliasRegexp(alias: string): RegExp {
  const startsWithWord = /^\w/.test(alias)
  const endsWithWord = /\w$/.test(alias)
  const pattern = `${startsWithWord ? '\\b' : ''}${escapeRegexForLiteral(alias)}${endsWithWord ? '\\b' : ''}`
  return new RegExp(pattern, 'i')
}

function pathSignalRegexp(signal: string): RegExp {
  return new RegExp(`${escapeRegexForLiteral(signal)}(?=$|[\\s\`'"),:;])`, 'i')
}

type LanguageSignalRegexps = {
  aliases: RegExp[]
  manifests: RegExp[]
  manifestExtensions: RegExp[]
  sourceExtensions: RegExp[]
}

/**
 * Per-language signal regexes compiled once at module load instead of
 * rebuilding (languages × aliases × signal kinds) RegExp objects inside
 * detectLanguageProfilesFromTask on every language-step call.
 */
const LANGUAGE_SIGNAL_REGEXPS = new Map<
  SupportedLanguageId,
  LanguageSignalRegexps
>(
  SUPPORTED_LANGUAGE_IDS.map((languageId) => {
    const capability = LANGUAGE_CAPABILITY_REGISTRY[languageId]
    return [
      languageId,
      {
        aliases: capability.taskAliases.map(taskAliasRegexp),
        manifests: capability.manifestNames.map(pathSignalRegexp),
        manifestExtensions: capability.manifestExtensions.map(
          pathSignalRegexp,
        ),
        sourceExtensions: capability.extensions.map(pathSignalRegexp),
      },
    ]
  }),
)

/** Non-global, so repeated .test calls hold no lastIndex state. */
const EXPLICIT_GO_PATTERN = /\bGo\b/

/**
 * Detect explicit language signals in task text. Ambiguous lowercase "go" is
 * intentionally ignored; "Go", "Golang", .go paths, go.mod, and Go tool
 * names remain reliable signals.
 */
export function detectLanguageProfilesFromTask(
  taskText: string,
): LanguageProfile[] {
  const detected = new Set<SupportedLanguageId>()

  for (const languageId of SUPPORTED_LANGUAGE_IDS) {
    const signals = LANGUAGE_SIGNAL_REGEXPS.get(languageId)
    if (!signals) continue
    const hit =
      signals.aliases.some((pattern) => pattern.test(taskText)) ||
      signals.manifests.some((pattern) => pattern.test(taskText)) ||
      signals.manifestExtensions.some((pattern) => pattern.test(taskText)) ||
      signals.sourceExtensions.some((pattern) => pattern.test(taskText)) ||
      (languageId === 'go' && EXPLICIT_GO_PATTERN.test(taskText))

    if (hit) {
      detected.add(languageId)
    }
  }

  return profilesForIds(detected)
}

function collectDetectedLanguages(
  nodes: FileTreeNode[],
  detected: Set<SupportedLanguageId>,
): void {
  for (const node of nodes) {
    if (node.type === 'directory') {
      collectDetectedLanguages(node.children ?? [], detected)
      continue
    }

    const languageId = detectLanguageIdForPath(node.name)
    if (languageId) detected.add(languageId)
  }
}

export function detectLanguageProfiles(
  fileTree: FileTreeNode[],
): LanguageProfile[] {
  const detected = new Set<SupportedLanguageId>()
  collectDetectedLanguages(fileTree, detected)
  return profilesForIds(detected)
}

/**
 * Prefer explicit target paths and task language names over every language in
 * a polyglot repository. Repository-wide detection is the fallback when the
 * caller has no focused signal.
 */
export function selectLanguageProfiles({
  fileTree,
  targetPaths = [],
  taskText = '',
  maxProfiles,
}: LanguageProfileSelection): LanguageProfile[] {
  const focusedIds = new Set<SupportedLanguageId>()
  for (const profile of detectLanguageProfilesFromPaths(targetPaths)) {
    focusedIds.add(profile.id)
  }
  for (const profile of detectLanguageProfilesFromTask(taskText)) {
    focusedIds.add(profile.id)
  }

  if (focusedIds.size > 0) return profilesForIds(focusedIds, maxProfiles)

  const repositoryIds = new Set(
    detectLanguageProfiles(fileTree).map((profile) => profile.id),
  )
  return profilesForIds(repositoryIds, maxProfiles)
}

export function formatLanguageProfilePrompt(params: {
  profiles: LanguageProfile[]
}): string {
  const { profiles } = params
  if (profiles.length === 0) return ''

  const languages = profiles.map((profile) => profile.displayName).join(', ')
  const rows = profiles
    .map(
      (profile) =>
        `- ${profile.displayName}: ${profile.guidance} ${profile.idiomGuidance.join(' ')}`,
    )
    .join('\n')

  return `## Language profile\n\nDetected: ${languages}. Prefer repository-local compiler, framework, API, formatter, linter, and test conventions when they are more specific than this bundled guidance.\n\n${rows}\n`
}

export function formatLanguageProfilePromptForFileTree(
  fileTree: FileTreeNode[],
  scope: Omit<LanguageProfileSelection, 'fileTree'> = {},
): string {
  return formatLanguageProfilePrompt({
    profiles: selectLanguageProfiles({ fileTree, ...scope }),
  })
}
