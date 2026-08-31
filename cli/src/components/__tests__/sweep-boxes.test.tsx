import { describe, test, expect } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { initializeThemeStore } from '../../hooks/use-theme'
import { CompactionBox } from '../renderers/compaction-box'
import { ContextBox } from '../renderers/context-box'
import { InfoBox } from '../renderers/info-box'
import { DoctorBox } from '../renderers/doctor-box'
import { IndexStatusBox } from '../renderers/index-status-box'
import { PlanStatusBox } from '../renderers/plan-status-box'

import type {
  CompactionContentBlock,
  ContextContentBlock,
  InfoContentBlock,
  DoctorContentBlock,
  IndexStatusContentBlock,
  PlanStatusContentBlock,
} from '../../types/chat'
import { CLI_LIVE_SESSION_ID } from '../../types/chat'

initializeThemeStore()

const compactionBlock = (
  overrides: Partial<CompactionContentBlock> = {},
): CompactionContentBlock => ({
  type: 'compaction',
  action: 'semantic_compaction',
  beforeTokens: 190_000,
  afterTokens: 120_000,
  beforeMessages: 20,
  afterMessages: 12,
  reductionPercent: 37,
  retainedKnowledgeMemory: true,
  recovery: 'Re-read exact files before editing.',
  categoryDeltas: [
    { category: 'toolResults', beforeTokens: 60_000, afterTokens: 10_000 },
    { category: 'fileReads', beforeTokens: 30_000, afterTokens: 8_000 },
  ],
  ...overrides,
})

describe('CompactionBox', () => {
  test('renders headline counts, per-category rows and the retained-memory line', () => {
    const markup = renderToStaticMarkup(
      <CompactionBox
        block={compactionBlock({
          reason: 'Approaching the trigger budget.',
          resolvedContextWindowTokens: 200_000,
          triggerBudgetTokens: 176_000,
          targetBudgetTokens: 150_000,
        })}
      />,
    )

    expect(markup).toContain('Context compacted')
    expect(markup).toContain('190k → 120k tokens (−37%)')
    expect(markup).toContain('20 → 12 messages')
    expect(markup).toContain('tool results  60k → 10k')
    expect(markup).toContain('file reads  30k → 8k')
    expect(markup).toContain('Knowledge memory retained')
    expect(markup).toContain('Window 200k · trigger 176k · target 150k')
    expect(markup).toContain('Approaching the trigger budget.')
    expect(markup).toContain('Re-read exact files before editing.')
    // Raw category keys never leak into the rendered output.
    expect(markup).not.toContain('toolResults')
    expect(markup).not.toContain('fileReads')
  })

  test('renders a pending pass as a live compacting state without result lines', () => {
    const markup = renderToStaticMarkup(
      <CompactionBox
        block={compactionBlock({
          status: 'pending',
          liveSessionId: CLI_LIVE_SESSION_ID,
          action: 'mechanical_trim',
          beforeTokens: 152_000,
          afterTokens: 0,
          beforeMessages: 0,
          afterMessages: 0,
          reductionPercent: 0,
          retainedKnowledgeMemory: false,
          recovery: '',
          categoryDeltas: [],
          resolvedContextWindowTokens: 200_000,
          triggerBudgetTokens: 150_000,
          targetBudgetTokens: 70_000,
        })}
      />,
    )

    expect(markup).toContain('Compacting context…')
    expect(markup).toContain('152k tokens → target 70k')
    // The unknown result fields never render as a settled outcome.
    expect(markup).not.toContain('tokens (−0%)')
    expect(markup).not.toContain('0 → 0 messages')
    expect(markup).not.toContain('No knowledge memory retained')
    expect(markup).not.toContain('Knowledge memory retained')
    // A pass owned by this process is live, not interrupted.
    expect(markup).not.toContain('Compaction interrupted')
    // A pending mechanical action still keeps the emergency title out.
    expect(markup).not.toContain('Context trimmed (emergency)')
    // The budget line is unchanged when both bounds are reported.
    expect(markup).toContain('Window 200k · trigger 150k · target 70k')
  })

  test('renders a replayed pending block as an interrupted pass, never as live', () => {
    // Persisted blocks are replayed on reload. A pass the user aborted
    // mid-compaction was written by an earlier process, so its liveSessionId
    // cannot match this one (and an older CLI wrote none at all).
    for (const liveSessionId of [
      undefined,
      'some-earlier-process-1700000000',
    ]) {
      const markup = renderToStaticMarkup(
        <CompactionBox
          block={compactionBlock({
            status: 'pending',
            ...(liveSessionId === undefined ? {} : { liveSessionId }),
            beforeTokens: 152_000,
            afterTokens: 0,
            beforeMessages: 0,
            afterMessages: 0,
            reductionPercent: 0,
            retainedKnowledgeMemory: false,
            recovery: 'Re-read exact files before editing.',
            categoryDeltas: [],
            targetBudgetTokens: 70_000,
          })}
        />,
      )

      expect(markup).toContain('Compaction interrupted')
      expect(markup).toContain(
        'Interrupted before this pass reported a result.',
      )
      // Never presented as still running.
      expect(markup).not.toContain('Compacting context…')
      // The unknown result fields still never render as a settled outcome.
      expect(markup).toContain('152k tokens → target 70k')
      expect(markup).not.toContain('tokens (−0%)')
      expect(markup).not.toContain('0 → 0 messages')
      expect(markup).not.toContain('No knowledge memory retained')
      expect(markup).not.toContain('Re-read exact files before editing.')
    }
  })

  test('renders an explicitly interrupted block as an interrupted pass', () => {
    // The abort/teardown path rewrites a pass that never reported a result to
    // this terminal status, so it is the primary interrupted path: no
    // liveSessionId is involved at all.
    const markup = renderToStaticMarkup(
      <CompactionBox
        block={compactionBlock({
          status: 'interrupted',
          beforeTokens: 152_000,
          afterTokens: 0,
          beforeMessages: 0,
          afterMessages: 0,
          reductionPercent: 0,
          retainedKnowledgeMemory: false,
          recovery: 'Re-read exact files before editing.',
          categoryDeltas: [],
          targetBudgetTokens: 70_000,
        })}
      />,
    )

    expect(markup).toContain('Compaction interrupted')
    expect(markup).toContain('Interrupted before this pass reported a result.')
    expect(markup).toContain('152k tokens → target 70k')
    // Never presented as still running, and the unknown result fields never
    // render as a settled outcome.
    expect(markup).not.toContain('Compacting context…')
    expect(markup).not.toContain('tokens (−0%)')
    expect(markup).not.toContain('0 → 0 messages')
    expect(markup).not.toContain('No knowledge memory retained')
    expect(markup).not.toContain('Re-read exact files before editing.')
  })

  test('omits the target clause of a pending line when no target budget is reported', () => {
    const markup = renderToStaticMarkup(
      <CompactionBox
        block={compactionBlock({
          status: 'pending',
          liveSessionId: CLI_LIVE_SESSION_ID,
          beforeTokens: 152_000,
          categoryDeltas: [],
          recovery: '',
        })}
      />,
    )

    expect(markup).toContain('152k tokens')
    expect(markup).not.toContain('target')
  })

  test('renders the emergency title, shortfall line and missing-memory line', () => {
    const markup = renderToStaticMarkup(
      <CompactionBox
        block={compactionBlock({
          action: 'mechanical_trim',
          retainedKnowledgeMemory: false,
          fitsBudget: false,
          shortfallTokens: 12_400,
        })}
      />,
    )

    expect(markup).toContain('Context trimmed (emergency)')
    expect(markup).toContain('Still over budget by 12.4k tokens')
    expect(markup).toContain('No knowledge memory retained')
  })

  test('omits the shortfall count when shortfallTokens is missing', () => {
    const markup = renderToStaticMarkup(
      <CompactionBox block={compactionBlock({ fitsBudget: false })} />,
    )

    expect(markup).toContain('Still over budget')
    expect(markup).not.toContain('Still over budget by')
  })

  test('renders the thrash line at two consecutive low-yield passes', () => {
    const markup = renderToStaticMarkup(
      <CompactionBox
        block={compactionBlock({ consecutiveNoProgressCompactions: 2 })}
      />,
    )

    expect(markup).toContain(
      'Compaction is not reclaiming space (2 consecutive low-yield passes)',
    )

    const single = renderToStaticMarkup(
      <CompactionBox
        block={compactionBlock({ consecutiveNoProgressCompactions: 1 })}
      />,
    )
    expect(single).not.toContain('Compaction is not reclaiming space')
  })

  test('omits the budget line unless both trigger and target are present', () => {
    const markup = renderToStaticMarkup(
      <CompactionBox
        block={compactionBlock({
          resolvedContextWindowTokens: 200_000,
          triggerBudgetTokens: 176_000,
        })}
      />,
    )

    expect(markup).not.toContain('trigger')
  })

  test('does not throw on a degenerate replayed block', () => {
    // Zero tokens, no category deltas, no optional fields and garbage numbers:
    // exactly what a persisted/partially-populated block can replay as.
    expect(() =>
      renderToStaticMarkup(
        <CompactionBox
          block={{
            type: 'compaction',
            action: 'semantic_compaction',
            beforeTokens: 0,
            afterTokens: 0,
            beforeMessages: 0,
            afterMessages: 0,
            reductionPercent: 0,
            retainedKnowledgeMemory: false,
            recovery: '',
            categoryDeltas: [],
          }}
        />,
      ),
    ).not.toThrow()

    const garbage = renderToStaticMarkup(
      <CompactionBox
        block={compactionBlock({
          beforeTokens: Number.NaN,
          afterTokens: -5,
          beforeMessages: Number.POSITIVE_INFINITY,
          afterMessages: -1,
          reductionPercent: 4000,
          categoryDeltas: [],
        })}
      />,
    )
    expect(garbage).not.toContain('NaN')
    expect(garbage).not.toContain('Infinity')
    expect(garbage).toContain('0 → 0 tokens (−100%)')
  })
})

describe('sweep renderers', () => {
  test('ContextBox renders without throwing and contains Context title', () => {
    const block: ContextContentBlock = {
      type: 'context',
      ledgerText: 'Ledger header\nLedger detail\nmore ledger',
      gateBudgetsText:
        'Gate budgets line 1\nGate repair budgets detail\nbudget row',
    }
    const markup = renderToStaticMarkup(<ContextBox block={block} />)
    expect(markup).toContain('Context')
    expect(markup).toContain('Ledger header')
    expect(markup).toContain('Gate budgets')
  })

  test('ContextBox handles null ledgerText', () => {
    const block: ContextContentBlock = {
      type: 'context',
      ledgerText: null,
      gateBudgetsText: 'Gate budgets: ok',
    }
    const markup = renderToStaticMarkup(<ContextBox block={block} />)
    expect(markup).toContain('Context')
    expect(markup).toContain('Gate budgets: ok')
  })

  test('ContextBox renders sub-headings and drops the redundant ledger heading', () => {
    const block: ContextContentBlock = {
      type: 'context',
      ledgerText:
        'Context Budget Breakdown\n------------------------\ntoolResults      1000    1.0%\ntotal            2000    2.0%\nwindow         200000\n(recorded before the last /compact; system-prompt blocks remain accurate)',
      gateBudgetsText: 'Gate budgets\nbudget row',
    }
    const markup = renderToStaticMarkup(<ContextBox block={block} />)

    expect(markup).toContain('Budget ledger')
    expect(markup).toContain('Gate budgets')
    expect(markup).not.toContain('Context Budget Breakdown')
    expect(markup).not.toContain('------------------------')
    expect(markup).toContain('toolResults')
    expect(markup).toContain('total')
    expect(markup).toContain('window')
    expect(markup).toContain('(recorded before the last /compact')
  })

  test('InfoBox renders version, workspace and Auth', () => {
    const block: InfoContentBlock = {
      type: 'info',
      version: '1.2.3',
      workspace: '/tmp/ws',
    }
    const markup = renderToStaticMarkup(<InfoBox block={block} />)
    expect(markup).toContain('CLI Diagnostic Info')
    expect(markup).toContain('Version:')
    expect(markup).toContain('1.2.3')
    expect(markup).toContain('Workspace:')
    expect(markup).toContain('/tmp/ws')
    expect(markup).toContain('Auth:')
    expect(markup).toContain('Local/BYOK Mode')
  })

  test('DoctorBox renders project root, agents/skills badges and counts', () => {
    const block: DoctorContentBlock = {
      type: 'doctor',
      projectRoot: '/home/user/project',
      agentsTrusted: true,
      skillsTrusted: false,
      skillCount: 3,
      mcpCount: 2,
      diagnostics: [{ filePath: '/a/b.ts', message: 'oops' }],
      providerStatus: 'provider ok\nline2',
    }
    const markup = renderToStaticMarkup(<DoctorBox block={block} />)
    expect(markup).toContain('Doctor')
    expect(markup).toContain('Project root:')
    expect(markup).toContain('/home/user/project')
    expect(markup).toContain('Project agents:')
    expect(markup).toContain('trusted and enabled')
    expect(markup).toContain('Project skills:')
    expect(markup).toContain('disabled with project-agent trust policy')
    expect(markup).toContain('Loaded skills:')
    expect(markup).toContain('3')
    expect(markup).toContain('Loaded MCP servers:')
    expect(markup).toContain('Agent diagnostics:')
    expect(markup).toContain('/a/b.ts: oops')
    expect(markup).toContain('provider ok')
  })

  test('DoctorBox disabled agents badge', () => {
    const block: DoctorContentBlock = {
      type: 'doctor',
      projectRoot: '/root',
      agentsTrusted: false,
      skillsTrusted: true,
      skillCount: 0,
      mcpCount: 0,
      diagnostics: [],
      providerStatus: '',
    }
    const markup = renderToStaticMarkup(<DoctorBox block={block} />)
    expect(markup).toContain('disabled (use --trust-project-agents to enable)')
    expect(markup).toContain('trusted and enabled') // skills trusted
  })

  test('IndexStatusBox renders title, corpus, age, vector and hint/coverage', () => {
    const block: IndexStatusContentBlock = {
      type: 'index-status',
      statusLine: 'Index ready.',
      messageLine: 'all good',
      corpusLine: 'corpus xyz',
      ageLine: '2h ago',
      vectorLine: 'vectors ok',
      hintLine: 'hint: run reindex',
      coverageLine: 'coverage low',
      diagnosticsLines: ['diag 1', 'diag 2'],
      lines: [],
    }
    const markup = renderToStaticMarkup(<IndexStatusBox block={block} />)
    expect(markup).toContain('Index ready')
    expect(markup).toContain('all good')
    expect(markup).toContain('Corpus:')
    expect(markup).toContain('corpus xyz')
    expect(markup).toContain('Age:')
    expect(markup).toContain('2h ago')
    expect(markup).toContain('Vector:')
    expect(markup).toContain('vectors ok')
    expect(markup).toContain('hint: run reindex')
    expect(markup).toContain('coverage low')
    expect(markup).toContain('Diagnostics (2)')
    expect(markup).toContain('diag 1')
  })

  test('IndexStatusBox derives default title when empty statusLine', () => {
    const block: IndexStatusContentBlock = {
      type: 'index-status',
      statusLine: '   ',
      messageLine: '',
      corpusLine: 'c',
      ageLine: 'a',
      vectorLine: 'v',
      hintLine: '',
      lines: [],
    }
    const markup = renderToStaticMarkup(<IndexStatusBox block={block} />)
    expect(markup).toContain('Index status')
  })

  test('PlanStatusBox status mode renders reportText', () => {
    const block: PlanStatusContentBlock = {
      type: 'plan-status',
      mode: 'status',
      reportText: 'Plan status report\ncurrent: do thing\n[active] session-a',
      isStatusReport: true,
    }
    const markup = renderToStaticMarkup(<PlanStatusBox block={block} />)
    expect(markup).toContain('Plan status')
    expect(markup).toContain('Plan status report')
    expect(markup).toContain('current: do thing')
  })

  test('PlanStatusBox list mode renders sessions with badges', () => {
    const block: PlanStatusContentBlock = {
      type: 'plan-status-list',
      mode: 'list',
      reportText: 'fallback report',
      sessions: [
        {
          slug: 'my-session',
          status: 'active',
          isActive: true,
          progress: { done: 2, total: 5 },
          currentTask: 'implement feature',
        } as any,
        {
          slug: 'old-session',
          status: 'completed',
          isActive: false,
          progress: { done: 0, total: 0 },
          currentTask: undefined,
        } as any,
      ],
      isStatusReport: false,
    }
    const markup = renderToStaticMarkup(<PlanStatusBox block={block} />)
    expect(markup).toContain('Plan sessions')
    expect(markup).toContain('my-session')
    expect(markup).toContain('[active]')
    expect(markup).toContain('2/5 done')
    expect(markup).toContain('current: &quot;implement feature&quot;')
    expect(markup).toContain('[completed]')
    expect(markup).toContain('old-session')
  })

  test('each sweep box renders without throwing on minimal input', () => {
    expect(() =>
      renderToStaticMarkup(
        <ContextBox
          block={{ type: 'context', ledgerText: null, gateBudgetsText: '' }}
        />,
      ),
    ).not.toThrow()
    expect(() =>
      renderToStaticMarkup(
        <InfoBox block={{ type: 'info', version: '0.0.0', workspace: '' }} />,
      ),
    ).not.toThrow()
    expect(() =>
      renderToStaticMarkup(
        <DoctorBox
          block={{
            type: 'doctor',
            projectRoot: '',
            agentsTrusted: false,
            skillsTrusted: false,
            skillCount: 0,
            mcpCount: 0,
            diagnostics: [],
            providerStatus: '',
          }}
        />,
      ),
    ).not.toThrow()
    expect(() =>
      renderToStaticMarkup(
        <IndexStatusBox
          block={{
            type: 'index-status',
            statusLine: '',
            messageLine: '',
            corpusLine: '',
            ageLine: '',
            vectorLine: '',
            hintLine: '',
            lines: [],
          }}
        />,
      ),
    ).not.toThrow()
    expect(() =>
      renderToStaticMarkup(
        <PlanStatusBox
          block={{
            type: 'plan-status',
            mode: 'status',
            reportText: '',
            isStatusReport: true,
          }}
        />,
      ),
    ).not.toThrow()
  })
})
