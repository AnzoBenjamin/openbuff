import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DOCS_DIR,
  REPO_ROOT,
  checkCitations,
  extractCheckableCitations,
  isCheckableCandidate,
  normalizeCandidate,
} from '../check-doc-citations'

const FIXTURE_TOP_LEVEL = new Set([
  'sdk',
  'docs',
  'common',
  'agents',
  'packages',
  'cli',
  'scripts',
  'evals',
])

describe('isCheckableCandidate', () => {
  test('accepts repository-relative file paths rooted at a top-level entry', () => {
    expect(isCheckableCandidate('sdk/src/run.ts', FIXTURE_TOP_LEVEL)).toBe(true)
    expect(
      isCheckableCandidate('docs/architecture.md', FIXTURE_TOP_LEVEL),
    ).toBe(true)
    // Directories are checkable too (they must exist on disk).
    expect(
      isCheckableCandidate('common/src/tools', FIXTURE_TOP_LEVEL),
    ).toBe(true)
  })

  test('rejects spans that are not verifiable repo paths', () => {
    const check = (raw: string) => isCheckableCandidate(raw, FIXTURE_TOP_LEVEL)
    expect(check('tools')).toBe(false) // bare identifier, no slash
    expect(check('base2.ts')).toBe(false) // bare filename, no slash
    expect(check('agents/guides/*.md')).toBe(false) // glob
    expect(check('.agents/sessions/<slug>')).toBe(false) // placeholder chars
    expect(check('~/.config/openbuff/openbuff.json')).toBe(false) // user-home
    expect(check('/tmp/log.txt')).toBe(false) // absolute
    expect(check('./file-walker')).toBe(false) // relative import
    expect(check('@codebuff/common/env')).toBe(false) // package specifier
    expect(check('common/src/')).toBe(false) // directory prefix span
    expect(check('agents/sessions/...')).toBe(false) // elision
    expect(check('bun scripts/tmux/tmux-viewer/index.tsx')).toBe(false) // command span
    expect(check('codex/gpt-5.5')).toBe(false) // model id, not repo-rooted
    expect(check('openbuff/file-picker@1.0.0')).toBe(false) // agent id
    expect(check('unknown-root/src/a.ts')).toBe(false) // no such top-level entry
  })
})

describe('normalizeCandidate', () => {
  test('strips symbol and anchor suffixes', () => {
    expect(normalizeCandidate('sdk/src/env.ts:getApiKey')).toBe('sdk/src/env.ts')
    expect(normalizeCandidate('docs/config.md#anchor')).toBe('docs/config.md')
    expect(normalizeCandidate('sdk/src/run.ts')).toBe('sdk/src/run.ts')
  })
})

describe('extractCheckableCitations', () => {
  test('skips fenced blocks and non-path spans, keeps real citations with line numbers', () => {
    const markdown = [
      '# Title',
      '',
      'Cite `sdk/src/run.ts` but not `base2.ts` or `tools`.',
      'Skip `agents/guides/*.md`, `~/.config/openbuff/openbuff.json`, and `codex/gpt-5.5`.',
      '',
      '```json',
      '{ "path": "does/not/exist.json" }',
      '```',
      '',
      'Back after the fence: `common/src/util/error.ts`.',
    ].join('\n')

    expect(extractCheckableCitations(markdown, FIXTURE_TOP_LEVEL)).toEqual([
      { line: 3, citedPath: 'sdk/src/run.ts' },
      { line: 10, citedPath: 'common/src/util/error.ts' },
    ])
  })
})

describe('checkCitations', () => {
  const writeFixture = (docName: string, lines: string[]): string => {
    const root = mkdtempSync(join(tmpdir(), 'doc-citations-'))
    mkdirSync(join(root, 'sdk', 'src'), { recursive: true })
    writeFileSync(join(root, 'sdk', 'src', 'run.ts'), 'export {}\n')
    const docsDir = join(root, 'docs')
    mkdirSync(docsDir)
    writeFileSync(join(docsDir, docName), `${lines.join('\n')}\n`)
    return root
  }

  test('reports cited paths that do not exist, naming doc and line', () => {
    const root = writeFixture('a.md', [
      '# Fixture',
      '',
      'Real: `sdk/src/run.ts`.',
      'Missing: `sdk/src/removed.ts`.',
      '',
      '```text',
      'ignored/inside-fence.ts',
      '```',
    ])
    try {
      const result = checkCitations(join(root, 'docs'), root)
      expect(result.citationsChecked).toBe(2)
      expect(result.missing).toEqual([
        { doc: 'a.md', line: 4, citedPath: 'sdk/src/removed.ts' },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('ignores intentionally-hypothetical and non-path citations', () => {
    const root = writeFixture('b.md', [
      'Config name: `openbuff.json`.',
      'Model id: `codex/gpt-5.5`.',
      'Command: `bun run scripts/generate-x.ts --write a/b.ts`.',
      'Runtime artifact: `.openbuff/ci-local.lock`.',
    ])
    try {
      const result = checkCitations(join(root, 'docs'), root)
      expect(result.missing).toEqual([])
      expect(result.citationsChecked).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('every backtick-cited path in the real docs/ resolves in this repo', () => {
    const result = checkCitations(DOCS_DIR, REPO_ROOT)
    expect(result.missing).toEqual([])
    expect(result.docsChecked).toContain('agents-and-tools.md')
    expect(result.docsChecked.length).toBeGreaterThan(5)
    expect(result.citationsChecked).toBeGreaterThan(10)
  })
})
