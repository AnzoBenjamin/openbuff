import { expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { initializeThemeStore } from '../../../hooks/use-theme'
import { chatThemes } from '../../../utils/theme-system'
import { CodeSearchComponent, parseCodeSearchGroups } from '../code-search'
import { discoveryStatus } from '../discovery-output'
import { statusGlyph } from '../discovery-results'
import { formatCodeSearchOutput } from '@codebuff/common/util/format-code-search'
import { DiffViewer, parseDiffIntoHunks } from '../diff-viewer'
import { CheckJobComponent } from '../background-job-tools'
import { ListDirectoryComponent } from '../list-directory'
import { ReadFilesComponent } from '../read-files'
import { ReadSubtreeComponent } from '../read-subtree'
import { QueryIndexComponent } from '../query-index'
import { RecallContextComponent } from '../recall-context'
import {
  documentForTool,
  collectOutputEntries,
} from '../../../utils/output-catalog'
import { formatHookRunHeader } from '../run-file-change-hooks'
import {
  InspectCodebaseStructureComponent,
  InspectFeatureCompletenessComponent,
  EvaluateAuditCoverageComponent,
} from '../plan-intelligence-tools'
import type { ToolBlock } from '../types'

initializeThemeStore()
const options = { availableWidth: 60, indentationOffset: 0, labelWidth: 0 }
const block = (name: ToolBlock['toolName'], value?: unknown): any => ({
  type: 'tool',
  toolName: name,
  toolCallId: `test-${name}`,
  input: {},
  outputRaw: value === undefined ? undefined : [{ type: 'json', value }],
})
const markup = (content: React.ReactNode) =>
  renderToStaticMarkup(<>{content}</>)

test('canonical consolidation-only recall retains its summary and archive identity in the card and reader', () => {
  const value = {
    matches: [],
    snapshotsSearched: 1,
    archivedAt: [1700000000000],
    consolidations: [
      {
        consolidatedAt: 1700000001000,
        action: 'summarized',
        sourceArchivedAts: [1700000000000],
        coveredMessages: 12,
        summary: 'RETAINED_CONSOLIDATION_SUMMARY',
      },
    ],
  }
  const tool = block('recall_context', value)
  const rendered = RecallContextComponent.render(tool, chatThemes.dark, options)
  expect(rendered.collapsedPreview).toContain('1 match')
  expect(markup(rendered.content)).toContain('RETAINED_CONSOLIDATION_SUMMARY')
  const document = documentForTool(tool)
  expect(document.rowCount).toBe(1)
  expect(document.detail?.(0)?.text).toContain('RETAINED_CONSOLIDATION_SUMMARY')
  const full = collectOutputEntries([
    { id: 'recall', variant: 'ai', timestamp: '', content: '', blocks: [tool] },
  ])
    .find((entry) => entry.id.endsWith(':result'))!
    .read()
  expect(full.text).toContain('1700000000000')
})

test.each(['cancelled', 'failed', 'succeeded'] as const)(
  'settled %s without capture never renders an active discovery glyph',
  (lifecycle) => {
    const status = discoveryStatus({ lifecycle, hasOutput: false })
    expect(statusGlyph(status, chatThemes.dark).glyph).not.toBe('⟳')
  },
)

test('producer search roundtrip retains arbitrary source paths after ordinary preceding path', () => {
  const paths = [
    './ordinary.ts',
    './b file.ts',
    './日本語.ts',
    './a[b].ts',
    './name(x).ts',
    './colon:name.ts',
    'C:\\folder\\file.ts',
  ]
  const formatted = formatCodeSearchOutput(
    paths.map((path, index) => `${path}:${index + 1}:actual result`).join('\n'),
  )
  const groups = parseCodeSearchGroups(formatted)!
  expect(groups.map((group) => group.file)).toEqual(
    paths.map((path) => path.replace(/^\.\//, '')),
  )
  expect(groups.map((group) => group.matches[0].line)).toEqual([
    1, 2, 3, 4, 5, 6, 7,
  ])
  expect(
    parseCodeSearchGroups(
      './a.ts:\nLine 1: correct\nunknown structural content\nLine 2: wrong source',
    ),
  ).toBeNull()
})

test('files-only, bare stdout, capture cap and memory provenance summaries remain truthful', () => {
  const files = block('code_search', { stdout: 'a.ts\nb file.ts\n' })
  files.input = { pattern: 'x', flags: '-l' }
  expect(
    CodeSearchComponent.render(files, chatThemes.dark, options)
      .collapsedPreview,
  ).toContain('2 matching files')
  const raw = block('code_search', { stdout: 'a.ts:1:actual\na.ts-2-context' })
  raw.input = { pattern: 'x' }
  expect(
    CodeSearchComponent.render(raw, chatThemes.dark, options).collapsedPreview,
  ).toContain('1 match')
  const rows = block('code_search', {
    stdout:
      formatCodeSearchOutput(
        Array.from(
          { length: 251 },
          (_, index) => `./f${index}.ts:${index + 1}:x`,
        ).join('\n'),
      ) + '\n[Global limit of 251 results reached.]',
  })
  rows.input = { pattern: 'x' }
  const result = CodeSearchComponent.render(rows, chatThemes.dark, options)
  expect(result.collapsedPreview).toContain('showing 250 of 251 captured rows')
  expect(result.collapsedPreview).toContain('251 files')
  expect(markup(result.content)).toContain('Global limit')
  const memory = block('code_search', {
    stdoutExcerpt: 'verified excerpt',
    message:
      'Served from verified memory; skipped code search (2 paths fully covered).',
  })
  memory.input = { pattern: 'x' }
  expect(
    CodeSearchComponent.render(memory, chatThemes.dark, options)
      .collapsedPreview,
  ).toContain('fresh search skipped')
})

test('search preserves source indentation and trailing spaces and names folded source limits', () => {
  const source = './a.ts:1:  indented  \n./a.ts-2-\tcontext  '
  const parsed = parseCodeSearchGroups(source)!
  expect(parsed[0].matches.map((match) => match.content)).toEqual([
    '  indented  ',
    '\tcontext  ',
  ])
  const result = block('code_search', {
    stdout: `${source}\n[Global limit of 2 results reached.]\n[Per-file limit reached.]\n[Byte limit reached.]`,
  })
  expect(
    CodeSearchComponent.render(result, chatThemes.dark, options)
      .collapsedPreview,
  ).toContain('global limit, per-file limit, byte limit')
})

test('index previews disclose hidden captured details and folded stale partial state', () => {
  const result = block('query_index', {
    results: [
      {
        path: 'a.ts',
        matchedSnippets: ['first snippet', 'retained second snippet'],
        relatedFiles: [{ path: 'one.ts' }, { path: 'two.ts' }],
      },
    ],
    status: {
      state: 'ready',
      stale: true,
      coverage: { truncated: true },
      diagnostics: Array.from({ length: 7 }, (_, index) => ({
        filePath: `file${index}.ts`,
        message: `failure ${index}`,
      })),
    },
  })
  const rendered = QueryIndexComponent.render(result, chatThemes.dark, options)
  expect(rendered.collapsedPreview).toContain('stale evidence')
  expect(rendered.collapsedPreview).toContain('partial coverage')
  const content = markup(rendered.content)
  expect(content).toContain('1 of 2 captured snippets')
  expect(content).toContain('1 of 2 captured related files')
  expect(content).toContain('Showing 5 of 7 captured diagnostics')
})

test('subtree scan errors and published omitted payloads retain partial and cached scope', () => {
  const result = block('read_subtree', [
    {
      path: 'src',
      type: 'directory',
      printedTree: 'retained.ts',
      tokenCount: 1,
      truncationLevel: 'none',
      provenance: 'cached',
      errors: [{ path: 'locked', error: { message: 'Permission denied' } }],
    },
    { path: 'large.ts', type: 'file', variablesOmittedForLength: true },
  ])
  result.input = { paths: ['src', 'large.ts'] }
  const content = markup(
    ReadSubtreeComponent.render(result, chatThemes.dark, options).content,
  )
  expect(content).toContain('Subtree partial')
  expect(content).toContain('cached snapshot')
  expect(content).toContain('symbols omitted for length')
  expect(content).toContain('1 scan error')
  expect(content).not.toContain('Subtree failed')
})

test('current job poll uses state, text events and independent wait timeout/loss metadata', () => {
  const record = block('check_job', {
    state: 'completed',
    events: [{ payload: { type: 'output', data: 'finished retained output' } }],
    timedOut: true,
    dropped: 2,
    truncated: true,
    exitCode: 0,
  })
  const result = CheckJobComponent.render(record, chatThemes.dark, options)
  expect(result.collapsedPreview).toContain('completed')
  expect(result.collapsedPreview).toContain('wait timed out')
  expect(result.collapsedPreview).toContain('2 events dropped')
  expect(markup(result.content)).toContain('finished retained output')
})

test('directory page continuation and one long nested read error remain discoverable', () => {
  const directory = block('list_directory', {
    files: ['a', 'b'],
    directories: [],
    truncated: true,
    nextOffset: 12,
  })
  directory.input = { path: 'src', offset: 10, limit: 2 }
  expect(
    ListDirectoryComponent.render(directory, chatThemes.dark, options)
      .collapsedPreview,
  ).toContain('offset 10')
  expect(
    ListDirectoryComponent.render(directory, chatThemes.dark, options)
      .collapsedPreview,
  ).toContain('nextOffset 12')
  const read = block('read_files', {
    kind: 'read_files_result',
    version: 1,
    status: 'error',
    results: [
      {
        path: 'a.ts',
        status: 'error',
        error: { message: 'one\ntwo\nthree\nfour\nfive\nsix\nseven' },
      },
    ],
  })
  read.input = { paths: ['a.ts'] }
  expect(
    markup(ReadFilesComponent.render(read, chatThemes.dark, options).content),
  ).toContain('Show details')
})

test('unknown hook records are counted separately from confirmed passing checks', () => {
  expect(
    formatHookRunHeader([
      { hookName: 'missing result' },
      { hookName: 'test', exitCode: 0 },
    ]),
  ).toBe('Hooks (1 passed, 1 outcome unknown)')
})

test('multi-file diff headers stay beside their hunks and noncollapsible 81-line hunks remain visible', () => {
  const diff =
    'diff --git a/first b/first\n--- a/first\n+++ b/first\n@@ -1 +1 @@\n-FIRST_OLD\n+FIRST_NEW\ndiff --git a/second b/second\n--- a/second\n+++ b/second\n@@ -1 +1 @@\n-SECOND_OLD\n+SECOND_NEW'
  const groups = parseDiffIntoHunks(diff).headerGroups!
  expect(groups[0].beforeHunkIndex).toBe(0)
  expect(groups[1].beforeHunkIndex).toBe(1)
  const shown = markup(
    <DiffViewer diffText={diff} collapsible={false} availableWidth={60} />,
  )
  expect(shown.indexOf('FIRST_NEW')).toBeLessThan(
    shown.indexOf('diff --git a/second'),
  )
  expect(shown.indexOf('diff --git a/second')).toBeLessThan(
    shown.indexOf('SECOND_NEW'),
  )
  const large =
    '@@ -1,81 +1,81 @@\n' +
    Array.from({ length: 81 }, (_, index) => `+line ${index}`).join('\n')
  expect(
    markup(
      <DiffViewer
        diffText={large}
        collapsible={false}
        initiallyCollapsedHunks={[0]}
        availableWidth={60}
      />,
    ),
  ).toContain('+line 80')
})

test('structural numeric totals, heuristic evidence and incomplete audit status remain explicit', () => {
  expect(
    InspectCodebaseStructureComponent.render(
      block('inspect_codebase_structure', { subsystems: 42 }),
      chatThemes.dark,
      options,
    ).collapsedPreview,
  ).toContain('42 subsystems')
  const feature = InspectFeatureCompletenessComponent.render(
    block('inspect_feature_completeness', {
      feature: 'reader',
      evidenceKind: 'heuristic',
      status: 'complete',
      evidence: { failureStates: ['a.ts'] },
    }),
    chatThemes.dark,
    options,
  )
  expect(feature.collapsedPreview).toContain('heuristic evidence')
  expect(markup(feature.content)).toContain('failure states')
  expect(
    EvaluateAuditCoverageComponent.render(
      block('evaluate_audit_coverage', { complete: false, shards: [] }),
      chatThemes.dark,
      options,
    ).collapsedPreview,
  ).toContain('incomplete')
})

test('shared diff counts preserve SQL/Lua comments, ++ source, dev-null headers and streaming snippets', async () => {
  const { countCapturedDiffChanges } =
    await import('../../../utils/diff-summary')
  const { computeDiffStats } = await import('../diff-viewer')
  const { parseDiffStats } = await import('../../../utils/implementor-helpers')
  const diff =
    'diff --git a/code b/code\n--- a/code\n+++ b/code\n@@ -1,2 +1,2 @@\n--- comment\n-ordinary\n+++source\n+replacement'
  expect(countCapturedDiffChanges(diff)).toEqual({ added: 2, removed: 2 })
  expect(computeDiffStats(diff)).toEqual({ added: 2, removed: 2 })
  expect(parseDiffStats(diff)).toEqual({
    linesAdded: 2,
    linesRemoved: 2,
    hunks: 1,
  })
  expect(
    countCapturedDiffChanges(
      '--- /dev/null\n+++ b/new\n@@ -0,0 +1,1 @@\n+++source',
    ),
  ).toEqual({ added: 1, removed: 0 })
  expect(countCapturedDiffChanges('-old\n+new')).toEqual({
    added: 1,
    removed: 1,
  })
})

test('targets-only recommendations expose captured source and candidate paths without implying tests ran', async () => {
  const { GetAffectedTestsComponent } =
    await import('../harness-intelligence-tools')
  const result = GetAffectedTestsComponent.render(
    block('get_affected_tests', {
      targets: [
        {
          source: 'src/parser.ts',
          candidates: ['src/parser.test.ts'],
          packageRoot: '.',
        },
      ],
    }),
    chatThemes.dark,
    options,
  )
  expect(markup(result.content)).toContain('src/parser.test.ts')
  expect(result.collapsedPreview).toContain('recommendations')
})

test('current outline errors and placeholders do not count as symbols; heuristic/truncation markers remain explicit', async () => {
  const { ReadOutlineComponent } = await import('../plan-intelligence-tools')
  const input = block('read_outline', {
    path: 'src/a.ts',
    outline:
      '[heuristic outline: grammar unavailable]\n[No structural components found in this file]',
  })
  input.input = { path: 'src/a.ts' }
  const empty = ReadOutlineComponent.render(input, chatThemes.dark, options)
  expect(empty.collapsedPreview).toContain('0 symbols')
  expect(empty.collapsedPreview).toContain('heuristic source')
  const failed = ReadOutlineComponent.render(
    {
      ...input,
      outputRaw: [
        {
          type: 'json',
          value: {
            path: 'src/missing.ts',
            outline: 'Error: File does not exist.',
          },
        },
      ],
    },
    chatThemes.dark,
    options,
  )
  expect(failed.collapsedPreview).toContain('unavailable')
  expect(failed.collapsedPreview).not.toContain('1 symbol')
})
