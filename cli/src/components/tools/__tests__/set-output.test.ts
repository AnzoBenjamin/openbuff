import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { extractReceiptCore, SetOutputComponent } from '../set-output'
import { summarizeSpawnResult, SpawnAgentsComponent } from '../spawn-agents'
import { CheckBackgroundAgentComponent } from '../check-background-agent'
import { getToolRendererDisposition } from '../registry'
import { chatThemes } from '../../../utils/theme-system'
import { initializeThemeStore } from '../../../hooks/use-theme'

initializeThemeStore()

describe('extractReceiptCore', () => {
  test('distills a reviewer receipt: verdict, message, findings, coverage', () => {
    const core = extractReceiptCore({
      data: {
        schemaVersion: 1,
        verdict: 'LOOKS_GOOD',
        snapshotFingerprint: 'v3:9f4a551b99ee04eb',
        reviewedFiles: ['a.ts', 'b.ts'],
        findings: [],
        requirementCoverage: [
          { status: 'satisfied' },
          { status: 'satisfied' },
          { status: 'missing_evidence' },
        ],
        dimensions: {},
      },
    })
    expect(core.outcome).toBe('LOOKS_GOOD')
    expect(core.outcomeKind).toBe('good')
    expect(core.reviewedFileCount).toBe(2)
    expect(core.coverage).toEqual({ satisfied: 2, total: 3 })
    expect(core.footer).toContain('schema v1')
    expect(core.footer).toContain('fp 9f4a551b99ee')
  })

  test('distills a dependency-manager receipt: partial status with message', () => {
    const core = extractReceiptCore({
      data: {
        schemaVersion: 2,
        status: 'partial',
        message: 'verification FAILED (guard exited non-zero)',
        verification: { filesChanged: [], guards: [] },
      },
    })
    expect(core.outcome).toBe('partial')
    expect(core.outcomeKind).toBe('warn')
    expect(core.message).toContain('verification FAILED')
  })

  test('accepts a stringified data payload', () => {
    const core = extractReceiptCore({
      data: JSON.stringify({ status: 'failed', summary: 'boom' }),
    })
    expect(core.outcome).toBe('failed')
    expect(core.outcomeKind).toBe('bad')
    expect(core.message).toBe('boom')
  })

  test('retains finding titles including reviewer text fields', () => {
    const core = extractReceiptCore({
      data: {
        status: 'success',
        findings: [
          { title: 'one' },
          { summary: 'two' },
          'three',
          { detail: 'four' },
          { message: 'five' },
          { title: 'six' },
          { text: 'seventh finding' },
        ],
      },
    })
    expect(core.findings).toEqual([
      'one',
      'two',
      'three',
      'four',
      'five',
      'six',
      'seventh finding',
    ])
  })

  test('presents advisories and nested dimensions without stringified JSON', () => {
    const core = extractReceiptCore({
      data: {
        verdict: 'NON_BLOCKING',
        advisories: '["first advisory", "second advisory"]',
        dimensions: {
          reliability: 'inspect retry path',
          performance: 'limit allocations',
        },
        findings: [{ text: 'fix the retry loop' }],
      },
    })
    expect(core.outcomeKind).toBe('warn')
    expect(core.advisories).toEqual(['first advisory', 'second advisory'])
    expect(core.findings).toEqual(['fix the retry loop'])
    expect(core.fields).toContainEqual({
      label: 'dimensions · reliability',
      value: 'inspect retry path',
    })
    expect(core.fields).toContainEqual({
      label: 'dimensions · performance',
      value: 'limit allocations',
    })
  })

  test('renders stringified findings and reviewer coverage from the original call', () => {
    const core = extractReceiptCore({
      findings: '[{"text":"repair timeout","correction":"add a deadline"}]',
      requirementCoverage: '[{"status":"satisfied"}]',
      reviewedFiles: '["src/a.ts"]',
    })
    expect(core.findings).toEqual(['repair timeout\nFix: add a deadline'])
    expect(core.coverage).toEqual({ satisfied: 1, total: 1 })
    expect(core.reviewedFileCount).toBe(1)
  })

  test('includes the evidence and correction from a reviewer finding', () => {
    const core = extractReceiptCore({
      findings: [
        {
          text: 'retry loses an error',
          severity: 'high',
          evidence: ['src/retry.ts:12'],
          correction: 'preserve the cause',
        },
      ],
    })
    expect(core.findings).toEqual([
      'HIGH: retry loses an error\nEvidence: src/retry.ts:12\nFix: preserve the cause',
    ])
  })

  test('does not hide a structured result or incomplete requirements', () => {
    const core = extractReceiptCore({
      result: { path: 'src/a.ts' },
      requirementCoverage: [{ requirement: 'retry', status: 'missing' }],
    })
    expect(core.fields).toContainEqual({
      label: 'result · path',
      value: 'src/a.ts',
    })
    expect(core.fields).toContainEqual({
      label: 'requirement coverage 1 · status',
      value: 'missing',
    })
  })

  test('an unrecognized envelope degrades to a neutral one-liner', () => {
    const core = extractReceiptCore({ data: { anything: 'else' } })
    expect(core.outcomeKind).toBe('neutral')
    expect(core.findings).toEqual([])
  })
})

describe('summarizeSpawnResult', () => {
  test('uses producer value and preserves structured child errors', () => {
    expect(
      summarizeSpawnResult({
        agentType: 'reviewer',
        value: { verdict: 'BLOCKED', summary: 'missing test' },
      }).detail,
    ).toBe('missing test')
    expect(
      summarizeSpawnResult({
        agentType: 'editor',
        value: { errorMessage: 'cannot spawn' },
      }).color,
    ).toBe('error')
    expect(
      summarizeSpawnResult({
        agentType: 'custom',
        value: { path: 'result.md' },
      }).detail,
    ).toContain('result.md')
  })
  test('renders producer JSON envelope children without unfolding branches', () => {
    const Render = () =>
      SpawnAgentsComponent.render(
        {
          type: 'tool',
          toolName: 'spawn_agents',
          toolCallId: 's1',
          input: { agents: [{ agent_type: 'reviewer' }] },
          lifecycle: 'succeeded',
          outputRaw: [
            {
              type: 'json',
              value: [
                {
                  agentType: 'reviewer',
                  value: {
                    verdict: 'BLOCKED',
                    summary: 'retained child failure',
                  },
                },
              ],
            },
          ],
        },
        chatThemes.dark,
        { availableWidth: 80, indentationOffset: 0, labelWidth: 0 },
      ).content as React.ReactElement
    expect(renderToStaticMarkup(React.createElement(Render))).toContain(
      'retained child failure',
    )
  })
  test('good verdict with summary detail', () => {
    const summary = summarizeSpawnResult({
      agentType: 'reviewer-family/dependency-reviewer@2',
      output: { verdict: 'LOOKS_GOOD', summary: 'no new packages' },
    })
    expect(summary.name).toBe('dependency-reviewer')
    expect(summary.color).toBe('success')
    expect(summary.glyph).toBe('✓')
    expect(summary.detail).toBe('no new packages')
  })

  test('receipt errors dominate: error color with the message', () => {
    const summary = summarizeSpawnResult({
      agentType: 'editor',
      agentReceipt: {
        status: 'failed',
        errors: [{ message: 'edit rejected' }],
      },
    })
    expect(summary.color).toBe('error')
    expect(summary.glyph).toBe('✗')
    expect(summary.detail).toBe('edit rejected')
  })

  test('no result shape degrades to a neutral agent line', () => {
    expect(summarizeSpawnResult(undefined).color).toBe('muted')
    expect(summarizeSpawnResult('junk').name).toBe('agent')
  })
})

describe('set_output rendering registration', () => {
  test('pending verdict and salvaged acknowledgment cannot look like accepted success', () => {
    const render = (outputRaw?: unknown) => {
      const Render = () =>
        SetOutputComponent.render(
          {
            type: 'tool',
            toolName: 'set_output',
            toolCallId: 'o1',
            input: { data: { verdict: 'LOOKS_GOOD' } },
            lifecycle: outputRaw ? 'succeeded' : 'running',
            outputRaw,
          },
          chatThemes.dark,
          { availableWidth: 80, indentationOffset: 0, labelWidth: 0 },
        ).content as React.ReactElement
      return renderToStaticMarkup(React.createElement(Render))
    }
    expect(render()).toContain('output pending')
    expect(render()).not.toContain('LOOKS_GOOD')
    const salvage = render([
      {
        type: 'json',
        value: {
          salvaged: true,
          message:
            'Only the head and tail are inline; full payload in result.json.',
        },
      },
    ])
    expect(salvage).toContain('output retained with limits')
    expect(salvage).toContain('result.json')
    expect(salvage).not.toContain('LOOKS_GOOD')
  })
  test('set_output has a bespoke renderer (no raw-JSON fallback)', () => {
    // The audit finding: receipts fell through to the generic fallback, which
    // stringifies the whole envelope. A registered renderer closes that path.
    expect(getToolRendererDisposition('set_output')).toBe('custom')
    expect(SetOutputComponent.toolName).toBe('set_output')
  })

  test('shows validation failure instead of claiming the submitted verdict succeeded', () => {
    let preview = ''
    const block = {
      type: 'tool',
      toolName: 'set_output',
      toolCallId: '1',
      input: { data: { verdict: 'LOOKS_GOOD' } },
      lifecycle: 'failed',
      outputRaw: [
        {
          type: 'json',
          value: { errorMessage: 'advisories must be an array' },
        },
      ],
    } as const
    const Render = () => {
      const config = SetOutputComponent.render(block, chatThemes.dark, {
        availableWidth: 100,
        indentationOffset: 0,
        labelWidth: 0,
      })
      preview = config.collapsedPreview ?? ''
      return config.content as React.ReactElement
    }
    const markup = renderToStaticMarkup(React.createElement(Render))
    expect(markup).toContain('output failed')
    expect(markup).toContain('advisories must be an array')
    expect(preview).toContain('output failed')
    expect(preview).not.toContain('LOOKS_GOOD')
  })

  test('shows a structured rejection as failed even when the tool lifecycle completed', () => {
    let preview = ''
    const block = {
      type: 'tool',
      toolName: 'set_output',
      toolCallId: 'rejected',
      input: { data: { verdict: 'LOOKS_GOOD' } },
      lifecycle: 'succeeded',
      outputRaw: [
        {
          type: 'json',
          value: {
            message: 'Output validation error: verdict is required',
            errorMessage: 'Output validation error: verdict is required',
          },
        },
      ],
    } as const
    const Render = () => {
      const config = SetOutputComponent.render(block, chatThemes.dark, {
        availableWidth: 100,
        indentationOffset: 0,
        labelWidth: 0,
      })
      preview = config.collapsedPreview ?? ''
      return config.content as React.ReactElement
    }
    const markup = renderToStaticMarkup(React.createElement(Render))
    expect(markup).toContain('output failed')
    expect(markup).toContain('verdict is required')
    expect(preview).not.toContain('LOOKS_GOOD')
  })

  test('shows when a redundant receipt was ignored instead of claiming it was set', () => {
    const block = {
      type: 'tool',
      toolName: 'set_output',
      toolCallId: 'ignored',
      input: { data: { message: 'Output set' } },
      lifecycle: 'succeeded',
      outputRaw: [
        {
          type: 'json',
          value: {
            status: 'ignored',
            message: 'The previous receipt was kept.',
          },
        },
      ],
    } as const
    const Render = () => {
      const config = SetOutputComponent.render(block, chatThemes.dark, {
        availableWidth: 100,
        indentationOffset: 0,
        labelWidth: 0,
      })
      return config.content as React.ReactElement
    }
    const markup = renderToStaticMarkup(React.createElement(Render))
    expect(markup).toContain('output ignored')
    expect(markup).toContain('The previous receipt was kept.')
    expect(markup).not.toContain('Output set')
  })
})

test('background agent results render structured details without a JSON envelope', () => {
  const Render = () => {
    const config = CheckBackgroundAgentComponent.render(
      {
        type: 'tool',
        toolName: 'check_background_agent',
        toolCallId: 'job-1',
        input: { jobId: 'job-1' },
        outputRaw: [
          {
            type: 'json',
            value: {
              jobId: 'job-1',
              state: 'completed',
              result: {
                verdict: 'NON_BLOCKING',
                advisories: ['inspect retry behavior'],
              },
            },
          },
        ],
      },
      chatThemes.dark,
      { availableWidth: 100, indentationOffset: 0, labelWidth: 0 },
    )
    return config.content as React.ReactElement
  }
  const markup = renderToStaticMarkup(React.createElement(Render))
  expect(markup).toContain('NON_BLOCKING')
  expect(markup).toContain('inspect retry behavior')
  expect(markup).not.toContain('&quot;verdict&quot;')
})
