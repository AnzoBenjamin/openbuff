#!/usr/bin/env bun
/**
 * Docs↔code citation drift check.
 *
 * Extracts backtick-quoted file paths from docs/*.md and verifies each cited
 * path exists in the repository, so documentation citations cannot silently
 * drift away from the tree (the failure mode behind the `openbuff.d/*.json`
 * audit finding, where the config docs cited a directory that never shipped).
 *
 * A backtick span is treated as a verifiable repo citation only when it is
 * conservatively path-like:
 *
 * - its FIRST path segment names a top-level repository entry (computed from
 *   the repo root) and it contains `/`. This one rule excludes everything
 *   that intentionally should not be checked: bare config filenames cited as
 *   user-facing names (`openbuff.json`, `codebuff.json`), model/agent ids
 *   (`codex/gpt-5.5`, `openbuff/file-picker@1.0.0`), user-home and absolute
 *   paths, package specifiers (`@codebuff/common/env`), relative import
 *   shorthands (`./x`), runtime artifacts under dot-directories
 *   (`.openbuff/ci-local.lock`, `.agents/ACTIVE_SESSION`), and command spans
 *   that merely contain a path (`bun scripts/tmux/tmux-viewer/index.tsx`).
 *   Because every intentionally-hypothetical citation is already excluded
 *   structurally, no path allowlist is needed.
 * - it contains no whitespace, glob/placeholder characters, or `..`.
 *
 * Fenced code blocks (example payloads) are skipped. Anchor (`#section`) and
 * symbol (`:symbolName`) suffixes are stripped before the existence check.
 *
 * Run: bun scripts/check-doc-citations.ts — exits 1 when any citation is
 * missing from the repository.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = dirname(SCRIPT_DIR)
export const DOCS_DIR = join(REPO_ROOT, 'docs')

const UNCHECKABLE_CHARS = /[\s*<>{}$"'\\]/

/**
 * Names of the non-hidden top-level files and directories of `repoRoot`.
 * A citation is only treated as repo-rooted when its first path segment is
 * one of these names.
 */
export function getTopLevelEntries(repoRoot: string): ReadonlySet<string> {
  const names = new Set<string>()
  for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith('.')) {
      names.add(entry.name)
    }
  }
  return names
}

/**
 * True when a backtick span looks like a repository-relative file path this
 * script can verify. Deliberately conservative: a span that is not clearly a
 * repo-rooted path is ignored rather than reported.
 */
export function isCheckableCandidate(
  raw: string,
  repoTopLevel: ReadonlySet<string>,
): boolean {
  const candidate = raw.trim()
  if (!candidate.includes('/')) return false
  if (candidate.endsWith('/')) return false
  if (candidate.startsWith('/') || candidate.startsWith('~')) return false
  if (candidate.startsWith('./') || candidate.startsWith('../')) return false
  if (candidate.startsWith('@')) return false
  if (UNCHECKABLE_CHARS.test(candidate)) return false
  if (candidate.includes('..')) return false
  const [firstSegment] = candidate.split('/')
  return repoTopLevel.has(firstSegment)
}

/**
 * Strip anchor (`#section`) and symbol (`:symbolName`) suffixes so citations
 * like `docs/config.md#anchor` or `sdk/src/env.ts:getApiKey` resolve to the
 * file that carries them.
 */
export function normalizeCandidate(raw: string): string {
  let normalized = raw.trim()
  const hash = normalized.indexOf('#')
  if (hash > 0) normalized = normalized.slice(0, hash)
  const colon = normalized.indexOf(':')
  if (colon > 0) normalized = normalized.slice(0, colon)
  return normalized.replace(/\.$/, '')
}

/**
 * Extract deduplicated backtick-cited repo paths from one Markdown document,
 * skipping fenced code blocks and reporting the 1-indexed line of the first
 * occurrence of each citation.
 */
export function extractCheckableCitations(
  content: string,
  repoTopLevel: ReadonlySet<string>,
): Array<{ line: number; citedPath: string }> {
  const citations: Array<{ line: number; citedPath: string }> = []
  const seen = new Set<string>()
  let inFence = false

  content.split('\n').forEach((text, index) => {
    // Tolerate list-indented fences (up to 8 spaces) on open and close.
    if (/^[ \t]{0,8}`{3,}/.test(text)) {
      inFence = !inFence
      return
    }
    if (inFence) return

    // Odd-index segments of a backtick split are inline-code spans.
    const spans = text.split('`').filter((_, i) => i % 2 === 1)
    for (const span of spans) {
      if (!isCheckableCandidate(span, repoTopLevel)) continue
      const citedPath = normalizeCandidate(span)
      if (!citedPath || seen.has(citedPath)) continue
      seen.add(citedPath)
      citations.push({ line: index + 1, citedPath })
    }
  })

  return citations
}

function pathExists(repoRoot: string, relativePath: string): boolean {
  try {
    statSync(join(repoRoot, relativePath))
    return true
  } catch {
    return false
  }
}

export type MissingCitation = { doc: string; line: number; citedPath: string }

/**
 * Check every top-level *.md file under `docsDir` for backtick-cited repo
 * paths that do not exist under `repoRoot`.
 */
export function checkCitations(
  docsDir: string,
  repoRoot: string = REPO_ROOT,
): {
  docsChecked: string[]
  citationsChecked: number
  missing: MissingCitation[]
} {
  const repoTopLevel = getTopLevelEntries(repoRoot)
  const missing: MissingCitation[] = []
  const docsChecked: string[] = []
  let citationsChecked = 0

  const entries = readdirSync(docsDir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    docsChecked.push(entry.name)
    const content = readFileSync(join(docsDir, entry.name), 'utf8')
    for (const { line, citedPath } of extractCheckableCitations(
      content,
      repoTopLevel,
    )) {
      citationsChecked++
      if (!pathExists(repoRoot, citedPath)) {
        missing.push({ doc: entry.name, line, citedPath })
      }
    }
  }

  return { docsChecked, citationsChecked, missing }
}

if (import.meta.main) {
  const { docsChecked, citationsChecked, missing } = checkCitations(DOCS_DIR)
  for (const m of missing) {
    console.error(`✗ ${m.doc}:${m.line} cites missing path: ${m.citedPath}`)
  }
  if (missing.length > 0) {
    console.error(
      `\n${missing.length} of ${citationsChecked} citation(s) across ${docsChecked.length} doc file(s) point at paths that do not exist in the repo.`,
    )
    process.exit(1)
  }
  console.log(
    `✅ ${citationsChecked} doc citation(s) across ${docsChecked.length} files all resolve on disk.`,
  )
}
