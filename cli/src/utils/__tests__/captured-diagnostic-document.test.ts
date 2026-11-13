import { expect, test } from 'bun:test'
import {
  capturedDiagnosticDocument,
  createCommandDiagnosticDocument,
} from '../captured-diagnostic-document'
import { collectOutputEntries } from '../output-catalog'
import { createJsonDocument } from '../output-document'

const doctor = {
  type: 'doctor',
  projectRoot: '/project',
  providerStatus: 'Configured provider\nConfigured model',
  agentsTrusted: true,
  skillsTrusted: true,
  skillCount: 1,
  mcpCount: 0,
  diagnostics: [{ agentId: 'base', message: 'Ready' }],
  capabilities: [{ label: 'Tools', value: 'Ready', rows: ['Read files'] }],
}
const memory = {
  type: 'memory',
  state: 'status',
  revision: 1,
  updatedAt: 1_700_000_000_000,
  goal: null,
  goalPreview: 'No goal captured',
  isGoalTruncated: false,
  counts: {
    decisions: 0,
    requirements: 0,
    editsMade: 0,
    validationResults: 0,
    blockers: 0,
    nextActions: 0,
  },
  evidence: { fresh: 1, stale: 0, total: 1 },
  stalePaths: [],
  totalStaleCount: 0,
}

test('valid command reports retain semantic views, including a memory status without a goal', () => {
  for (const source of [
    doctor,
    { type: 'context', ledgerText: null, gateBudgetsText: '' },
    { type: 'info', version: '1.0', workspace: '/project' },
    memory,
  ]) {
    const document = createCommandDiagnosticDocument('valid', 'Report', source)!
    expect(document.kind).toBe('text')
    expect(document.text).toContain('Raw captured fields')
    expect(document.detail?.(document.rowCount! - 1)?.text).toBe(
      createJsonDocument('raw', 'Report', source).text,
    )
  }
})

const malformed: Array<[string, object]> = [
  ['doctor diagnostics null', { ...doctor, diagnostics: null }],
  ['doctor nested diagnostic null', { ...doctor, diagnostics: [null] }],
  ['doctor diagnostic message', { ...doctor, diagnostics: [{ message: {} }] }],
  [
    'doctor diagnostic identity',
    { ...doctor, diagnostics: [{ message: 'Issue', filePath: 42 }] },
  ],
  ['doctor capabilities null', { ...doctor, capabilities: null }],
  ['doctor nested capability null', { ...doctor, capabilities: [null] }],
  [
    'doctor capability label',
    { ...doctor, capabilities: [{ label: [], value: 'Ready' }] },
  ],
  [
    'doctor capability value',
    { ...doctor, capabilities: [{ label: 'Tools', value: {} }] },
  ],
  [
    'doctor capability rows',
    {
      ...doctor,
      capabilities: [{ label: 'Tools', value: 'Ready', rows: [42] }],
    },
  ],
  ['doctor provider status', { ...doctor, providerStatus: { model: 'saved' } }],
  [
    'context ledger',
    { type: 'context', ledgerText: {}, gateBudgetsText: 'Retained gate' },
  ],
  [
    'context gate',
    { type: 'context', ledgerText: 'Retained ledger', gateBudgetsText: [] },
  ],
  ['info version missing', { type: 'info', workspace: '/project' }],
  ['info workspace missing', { type: 'info', version: '1.0' }],
  ['memory counts null', { ...memory, counts: null }],
  [
    'memory count invalid',
    { ...memory, counts: { ...memory.counts, decisions: 'many' } },
  ],
  ['memory evidence null', { ...memory, evidence: null }],
  [
    'memory evidence invalid',
    { ...memory, evidence: { ...memory.evidence, stale: {} } },
  ],
  ['memory v2 lines', { ...memory, v2Lines: [null] }],
  ['memory stale paths', { ...memory, stalePaths: [42] }],
  [
    'memory health',
    { ...memory, memoryV2Status: { toString: () => 'healthy' } },
  ],
]

test.each(malformed)(
  '%s keeps original fields through direct inspection',
  (_name, source) => {
    expect(
      createCommandDiagnosticDocument('invalid', 'Report', source),
    ).toBeUndefined()
    const expected = createJsonDocument('expected', 'Report', source).text
    const captured = capturedDiagnosticDocument('malformed', 'Report', source)
    expect(captured.kind).toBe('json')
    expect(captured.text).toBe(expected)
    const fromCatalog = collectOutputEntries([
      {
        id: 'malformed',
        variant: 'ai',
        timestamp: '',
        content: '',
        blocks: [source],
      },
    ] as never)[0]!.read()
    expect(fromCatalog.kind).toBe('json')
    expect(fromCatalog.text).toBe(expected)
  },
)

test('oversized collections and aggregate report text fall back before eager formatting', () => {
  const diagnostics = new Array(150_000)
  Object.defineProperty(diagnostics, 0, {
    enumerable: true,
    get: () => {
      throw new Error('oversized diagnostic read')
    },
  })
  const laterRows = new Array(60_000)
  Object.defineProperty(laterRows, 0, {
    enumerable: true,
    get: () => {
      throw new Error('aggregate capability tail read')
    },
  })
  for (const source of [
    { ...doctor, diagnostics },
    { ...doctor, providerStatus: 'x'.repeat(8_000_001) },
    {
      ...doctor,
      capabilities: [
        {
          label: 'First',
          value: 'Ready',
          rows: Array(60_000).fill('retained'),
        },
        { label: 'Second', value: 'Ready', rows: laterRows },
      ],
    },
    {
      type: 'context',
      ledgerText: 'line\n'.repeat(100_001),
      gateBudgetsText: '',
    },
    { ...memory, stalePaths: new Array(150_000) },
  ]) {
    expect(
      createCommandDiagnosticDocument('large', 'Report', source),
    ).toBeUndefined()
    const raw = capturedDiagnosticDocument('large', 'Report', source)
    expect(raw.kind).toBe('json')
    expect(raw.availability).toBe('limited')
    expect(raw.lineCount).toBeLessThanOrEqual(100_000)
  }
})

test('semantic preflight leaves accessor evidence available without invoking getters', () => {
  const throwing = () => {
    throw new Error('accessor evaluated')
  }
  const sourceAccessor = { ...doctor }
  Object.defineProperty(sourceAccessor, 'diagnostics', {
    enumerable: true,
    get: throwing,
  })
  const nestedAccessor = {
    ...doctor,
    diagnostics: [
      {
        get message() {
          return throwing()
        },
      },
    ],
  }
  const rows = ['retained']
  Object.defineProperty(rows, 0, { enumerable: true, get: throwing })
  const methodAccessor = ['retained']
  Object.defineProperty(methodAccessor, Symbol.iterator, { get: throwing })
  const constructorAccessor = [{ message: 'Ready' }]
  Object.defineProperty(constructorAccessor, 'constructor', { get: throwing })
  for (const source of [
    sourceAccessor,
    nestedAccessor,
    { ...doctor, capabilities: [{ label: 'Tools', value: 'Ready', rows }] },
    { ...memory, stalePaths: methodAccessor },
    { ...doctor, diagnostics: constructorAccessor },
  ]) {
    expect(
      createCommandDiagnosticDocument('accessor', 'Report', source),
    ).toBeUndefined()
    const raw = capturedDiagnosticDocument('accessor', 'Report', source)
    expect(raw.kind).toBe('json')
    const fromCatalog = collectOutputEntries([
      {
        id: 'accessor',
        variant: 'ai',
        timestamp: '',
        content: '',
        blocks: [source],
      },
    ] as never)[0]!.read()
    expect(fromCatalog.text).toBe(raw.text)
  }
})
