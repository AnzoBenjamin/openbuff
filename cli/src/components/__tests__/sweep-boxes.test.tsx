import { describe, test, expect } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { initializeThemeStore } from '../../hooks/use-theme'
import { ContextBox } from '../renderers/context-box'
import { InfoBox } from '../renderers/info-box'
import { DoctorBox } from '../renderers/doctor-box'
import { IndexStatusBox } from '../renderers/index-status-box'
import { PlanStatusBox } from '../renderers/plan-status-box'

import type {
  ContextContentBlock,
  InfoContentBlock,
  DoctorContentBlock,
  IndexStatusContentBlock,
  PlanStatusContentBlock,
} from '../../types/chat'

initializeThemeStore()

describe('sweep renderers', () => {
  test('ContextBox renders without throwing and contains Context title', () => {
    const block: ContextContentBlock = {
      type: 'context',
      ledgerText: 'Ledger header\nLedger detail\nmore ledger',
      gateBudgetsText: 'Gate budgets line 1\nGate repair budgets detail\nbudget row',
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
        <ContextBox block={{ type: 'context', ledgerText: null, gateBudgetsText: '' }} />,
      ),
    ).not.toThrow()
    expect(() =>
      renderToStaticMarkup(<InfoBox block={{ type: 'info', version: '0.0.0', workspace: '' }} />),
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
        <PlanStatusBox block={{ type: 'plan-status', mode: 'status', reportText: '', isStatusReport: true }} />,
      ),
    ).not.toThrow()
  })
})
