import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { initializeThemeStore } from '../../../hooks/use-theme'
import { chatThemes } from '../../../utils/theme-system'
import { getToolComponent, renderToolComponent } from '../registry'

import type { ToolBlock } from '../types'

initializeThemeStore()

/**
 * Behavioral tests for the renderers that replaced raw-JSON fallbacks.
 *
 * Each case asserts the human-facing contract the user asked for: the JSON
 * envelope never reaches the view, the header names the tool in plain words,
 * and the body carries the real result rather than a bare verdict glyph.
 * Field names mirror the published tool outputs in `sdk/src/tools/*`.
 */

const renderOptions = {
  availableWidth: 80,
  indentationOffset: 0,
  labelWidth: 0,
}

function makeBlock(
  toolName: string,
  input: Record<string, unknown>,
  outputRaw: unknown,
): ToolBlock {
  return {
    type: 'tool',
    toolName,
    toolCallId: `tool-${toolName}`,
    input,
    outputRaw,
  } as ToolBlock
}

function render(
  toolName: string,
  input: Record<string, unknown>,
  outputRaw: unknown,
): string {
  const config = renderToolComponent(
    makeBlock(toolName, input, outputRaw),
    chatThemes.dark,
    renderOptions,
  )
  return renderToStaticMarkup(config?.content as React.ReactElement)
}

describe('humanized renderers replace raw-JSON fallbacks', () => {
  test('recall_context renders archived matches, not the envelope', () => {
    const markup = render('recall_context', {}, {
      matches: [
        { step: 12, toolName: 'read_files', snippet: 'an eviction note' },
        { step: 40, toolName: 'code_search', snippet: 'a budget note' },
      ],
      consolidations: 2,
    })

    expect(markup).toContain('Recall')
    expect(markup).toContain('2 matches')
    expect(markup).toContain('step 12')
    expect(markup).toContain('read_files')
    expect(markup).toContain('an eviction note')
    expect(markup).toContain('2 consolidations')
    // The machine envelope is gone: no camelCase keys and no JSON braces.
    expect(markup).not.toContain('toolName')
    expect(markup).not.toContain('snippet')
    expect(markup).not.toContain('{')
  })

  test('recall_context reports an empty archive in prose', () => {
    const markup = render('recall_context', {}, {
      matches: [],
      message: 'No archived transcript text matched.',
    })

    expect(markup).toContain('0 matches')
    expect(markup).toContain('No archived transcript text matched.')
  })

  test('rename_symbol renders the target symbol and applied files', () => {
    const markup = render(
      'rename_symbol',
      {
        path: 'sdk/src/run.ts',
        line: 10,
        character: 4,
        new_name: 'runMainLoop',
      },
      {
        applied: true,
        results: [
          { path: 'sdk/src/run.ts', applied: true },
          { path: 'cli/src/app.tsx', applied: true },
        ],
      },
    )

    expect(markup).toContain('Rename')
    expect(markup).toContain('runMainLoop')
    expect(markup).toContain('sdk/src/run.ts')
    expect(markup).toContain('applied')
    expect(markup).toContain('2 of 2 files')
    // The raw LSP input shape stays out of the view.
    expect(markup).not.toContain('new_name')
    expect(markup).not.toContain('character')
    expect(markup).not.toContain('results')
  })

  test('rename_symbol surfaces a service failure as a readable error', () => {
    const markup = render(
      'rename_symbol',
      { path: 'sdk/src/run.ts', line: 10, character: 4, new_name: 'renamed' },
      { error: 'No language server available for this file.' },
    )

    expect(markup).toContain('No language server available for this file.')
    expect(markup).not.toContain('new_name')
    expect(markup).not.toContain('character')
  })

  test('rename_symbol reports a partial apply honestly', () => {
    const markup = render(
      'rename_symbol',
      { path: 'sdk/src/run.ts', line: 10, character: 4, new_name: 'renamed' },
      {
        applied: true,
        results: [
          { path: 'sdk/src/run.ts', applied: true },
          {
            path: 'cli/src/app.tsx',
            applied: false,
            errorMessage: 'symbol not found in file',
          },
        ],
      },
    )

    expect(markup).toContain('1 of 2 files')
    expect(markup).toContain('not applied')
    expect(markup).toContain('symbol not found in file')
  })

  test('inspect_workspace renders branch and dirty counts, not JSON keys', () => {
    const markup = render('inspect_workspace', {}, {
      branch: 'feature/audit',
      defaultBranch: 'main',
      headCommit: 'abc1234567890def',
      canonicalRoot: '/home/ben/Code/CLI/openbuff',
      status: ' M cli/src/index.ts\n?? sdk/src/run.ts',
    })

    expect(markup).toContain('Workspace')
    expect(markup).toContain('feature/audit')
    expect(markup).toContain('2 uncommitted')
    expect(markup).not.toContain('dirtyPaths')
    expect(markup).not.toContain('repositoryRoot')
    expect(markup).not.toContain('canonicalRoot')
  })

  test('get_change_review_bundle counts changed files and findings', () => {
    const markup = render('get_change_review_bundle', { max_chars: 50000 }, {
      snapshotId: 'abc123',
      files: ['cli/src/a.ts', 'cli/src/b.ts'],
      findings: [{ id: 'f1' }],
      validation: [{ id: 'v1' }, { id: 'v2' }],
    })

    expect(markup).toContain('Change bundle')
    expect(markup).toContain('2 files changed')
    expect(markup).toContain('1 record')
    expect(markup).toContain('2 records')
    expect(markup).not.toContain('max_chars')
  })

  test('get_affected_tests maps a changed file to its test candidates', () => {
    const markup = render('get_affected_tests', {
      files: ['cli/src/index.ts'],
    }, {
      impact: [
        {
          source: 'cli/src/index.ts',
          candidates: [{ path: 'cli/src/__tests__/index.test.ts' }],
        },
      ],
    })

    expect(markup).toContain('Affected tests')
    expect(markup).toContain('cli/src/index.ts')
    expect(markup).toContain('cli/src/__tests__/index.test.ts')
    expect(markup).toContain('1 test path')
  })

  test('get_build_targets lists package roots and their commands', () => {
    const markup = render('get_build_targets', {
      files: ['cli/src/index.ts'],
    }, {
      targets: [
        { packageRoot: 'cli', manager: 'bun', commands: ['typecheck', 'test'] },
      ],
    })

    expect(markup).toContain('Build targets')
    expect(markup).toContain('1 package')
    expect(markup).toContain('typecheck')
    expect(markup).not.toContain('packageRoot')
  })

  test('create_plan renders the written artifact path', () => {
    const markup = render(
      'create_plan',
      { path: '.agents/sessions/audit/SPEC.md' },
      {
        message: 'Plan artifact written.',
        path: '.agents/sessions/audit/SPEC.md',
      },
    )

    expect(markup).toContain('Plan')
    expect(markup).toContain('.agents/sessions/audit/SPEC.md')
  })

  test('update_plan_status reports matched and unmatched task lines', () => {
    const markup = render(
      'update_plan_status',
      { path: '.agents/sessions/audit/PLAN.md' },
      {
        sessionStatus: 'executing',
        message: '1 task line updated.',
        updates: [{ taskId: 'P0-1' }],
        unmatchedTasks: ['no such task'],
      },
    )

    expect(markup).toContain('Plan status')
    expect(markup).toContain('executing')
    expect(markup).toContain('1 task line')
    expect(markup).toContain('no such task')
    expect(markup).not.toContain('taskId')
  })

  test('record_decision renders the kind and evidence count', () => {
    const markup = render(
      'record_decision',
      {
        decision: 'Keep the shared helper as the single choke point.',
        rationale: 'One module keeps the family consistent.',
      },
      { kind: 'decision', evidenceCount: 4, message: 'Decision recorded.' },
    )

    expect(markup).toContain('Decision')
    expect(markup).toContain('4 paths')
    expect(markup).not.toContain('evidenceCount')
  })

  test('git_branch renders creation and switch state', () => {
    const markup = render(
      'git_branch',
      { branch_name: 'audit/humanize', branch_switch: true },
      {
        branch: 'audit/humanize',
        created: true,
        switched: true,
        previousBranch: 'main',
      },
    )

    expect(markup).toContain('Branch')
    expect(markup).toContain('audit/humanize')
    expect(markup).toContain('created and switched')
    expect(markup).not.toContain('previousBranch')
  })

  test('read_outline renders symbol rows and an honest overflow note', () => {
    const outline = Array.from(
      { length: 14 },
      (_unused, index) => `  function helper${index}()`,
    ).join('\n')
    const markup = render('read_outline', { path: 'sdk/src/run.ts' }, {
      outline,
    })

    expect(markup).toContain('Outline')
    expect(markup).toContain('14 symbols')
    expect(markup).toContain('function helper0()')
    expect(markup).toContain('omitted from this view')
  })

  test('run_targeted_validation renders status and bounded failures', () => {
    const markup = render('run_targeted_validation', {
      files: ['cli/src/index.ts'],
    }, {
      status: 'failed',
      summary: 'Validation failed for 1 file.',
      files: ['cli/src/index.ts'],
      results: [{ errorMessage: 'typecheck exited non-zero' }],
    })

    expect(markup).toContain('Validation')
    expect(markup).toContain('failed')
    expect(markup).toContain('typecheck exited non-zero')
    expect(markup).not.toContain('errorMessage')
  })

  test('every renderer in this family is registered (no fallback)', () => {
    for (const toolName of [
      'recall_context',
      'rename_symbol',
      'code_action',
      'extract_symbol',
      'rewrite_symbol',
      'inspect_workspace',
      'get_change_review_bundle',
      'get_task',
      'inspect_environment',
      'get_affected_tests',
      'get_build_targets',
      'create_plan',
      'update_plan_status',
      'record_decision',
      'write_audit_findings',
      'git_branch',
      'read_outline',
      'web_search',
      'inspect_codebase_structure',
      'inspect_feature_completeness',
      'evaluate_audit_coverage',
      'run_targeted_validation',
    ] as const) {
      expect(getToolComponent(toolName)).toBeDefined()
    }
  })
})
