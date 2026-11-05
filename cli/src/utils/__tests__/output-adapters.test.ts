import { expect, test } from 'bun:test'
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createJsonDocument } from '../output-document'
import { collectOutputEntries, documentForTool } from '../output-catalog'
import { outcomeForTool } from '../output-outcome'
import {
  capturedArtifacts,
  recoverCapturedArtifact,
  OUTPUT_ARTIFACT_BYTE_LIMIT,
} from '../output-artifact'
import type { ToolContentBlock, ChatMessage } from '../../types/chat'

const tool = (
  name: ToolContentBlock['toolName'],
  value: unknown,
  lifecycle?: ToolContentBlock['lifecycle'],
): ToolContentBlock => ({
  type: 'tool',
  toolName: name,
  toolCallId: `t-${name}`,
  input: {},
  outputRaw: [{ type: 'json', value }],
  lifecycle,
})
const message = (block: ToolContentBlock): ChatMessage => ({
  id: 'm',
  content: '',
  variant: 'ai',
  timestamp: '',
  blocks: [block],
})

test('current job state/events retain timeout, loss and full event payload beyond four-row preview', () => {
  const events = Array.from({ length: 7 }, (_, index) => ({
    sequence: index,
    payload: {
      type: 'agent_chunk',
      chunkType: 'text',
      data: `progress ${index}\nfull retained line`,
    },
  }))
  const block = tool(
    'check_background_agent',
    {
      state: 'running',
      events,
      timedOut: true,
      dropped: 3,
      truncated: true,
      nextCursor: 7,
    },
    'succeeded',
  )
  const document = documentForTool(block)
  expect(document.kind).toBe('job')
  expect(document.rowCount).toBe(7)
  expect(document.row?.(6)?.value).toBe(events[6])
  expect(document.detail?.(6)?.text).toContain(
    'progress 6\\nfull retained line',
  )
  expect(document.detail?.(6)).toBe(document.detail?.(6))
  expect(document.availability).toBe('limited')
  expect(document.notice).toContain('3 events dropped')
  expect(document.outcome?.label).toBe('wait timed out')
  const envelope = collectOutputEntries([message(block)]).find((entry) =>
    entry.id.endsWith(':result'),
  )!
  expect(envelope.read().text).toContain('nextCursor')
  expect(envelope.read()).toBe(envelope.read())
  expect(envelope.messageId).toBe('m')
  expect(envelope.toolCallId).toBe(block.toolCallId)
})

test('current canonical read preserves source range and exact source without using a current-file path', () => {
  const block = tool('read_files', {
    kind: 'read_files_result',
    version: 1,
    status: 'partial',
    results: [
      {
        path: '/does/not/exist/current.ts',
        selector: 'range',
        startLine: 401,
        endLine: 403,
        status: 'partial',
        sourceContent: 'captured\n  exact source\nlast line',
      },
    ],
  })
  const source = collectOutputEntries([message(block)])
    .find((entry) => entry.id.includes(':read:'))!
    .read()
  expect(source.copyLine(1)).toBe('  exact source')
  expect(source.provenance).toEqual({
    source: 'capture',
    identity: '/does/not/exist/current.ts',
    freshness: 'captured',
    exact: true,
    startLine: 401,
  })
  expect(source.availability).toBe('limited')
  expect(source.notice).toContain('401–403')
})

test('documentation selected library and long hover use retained Markdown rather than JSON escapes', () => {
  const documentation = documentForTool(
    tool('read_docs', {
      documentation: '# Title\n\nretained documentation',
      library: { title: 'Actual library', id: '/lib/actual', branch: 'v2' },
    }),
  )
  expect(documentation.kind).toBe('markdown')
  expect(documentation.title).toBe('Actual library')
  expect(documentation.notice).toContain('/lib/actual')
  expect(documentation.landmarks[0].label).toBe('Title')
  const text = 'a'.repeat(700) + '\nEND_OF_RETAINED_TYPE'
  const hover = documentForTool(
    tool('hover_type', {
      hover: { contents: { kind: 'markdown', value: text } },
    }),
  )
  expect(hover.copyLine(1)).toBe('END_OF_RETAINED_TYPE')
})

test('literal terminal stdout, quiet exit and independent stream bytes are retained', () => {
  const stdout = '  {"stdout":"literal JSON"}\n'
  const stderr = '  separate stderr\n'
  const document = documentForTool(
    tool('run_terminal_command', { stdout, stderr, exitCode: 1 }),
  )
  expect(document.text).toBe(stdout + stderr)
  expect(document.copyLine(0)).toBe('  {"stdout":"literal JSON"}')
  expect(document.notice).toContain('original interleaving not captured')
  expect(document.outcome?.tone).toBe('bad')
  const quiet = documentForTool(
    tool('run_terminal_command', { stdout: '', stderr: '', exitCode: 0 }),
  )
  expect(quiet.availability).toBe('retained')
  expect(quiet.outcome?.label).toBe('exit 0')
})

test('pending/cancelled/custom outcomes and confirmed mutation remain distinct', () => {
  const absent = {
    type: 'tool',
    toolName: 'read_files',
    toolCallId: 'absent',
    input: {},
  } as ToolContentBlock
  expect(documentForTool(absent).availability).toBe('unavailable')
  expect(outcomeForTool({ ...absent, lifecycle: 'succeeded' }).tone).toBe(
    'neutral',
  )
  expect(
    documentForTool(tool('set_output', { status: 'success' }, 'running'))
      .outcome?.label,
  ).toBe('running')
  expect(
    outcomeForTool(tool('read_files', { status: 'ok' }, 'cancelled')).label,
  ).toBe('cancelled')
  expect(
    outcomeForTool(
      tool(
        'edit_transaction',
        { kind: 'file_mutation_result', outcome: 'applied', actions: [] },
        'cancelled',
      ),
    ).label,
  ).toBe('applied')
  expect(
    outcomeForTool(
      tool('read_files', { payload: { error: 'ordinary data' } }, 'succeeded'),
    ).tone,
  ).toBe('neutral')
})

test('bounded JSON projection does not eagerly read an array tail or invoke accessors', () => {
  const values = new Array(1_000_000)
  Object.defineProperty(values, 100_001, {
    enumerable: true,
    get: () => {
      throw new Error('tail evaluated')
    },
  })
  const document = createJsonDocument(
    'huge',
    'Huge retained collection',
    values,
  )
  expect(document.availability).toBe('limited')
  expect(document.lineCount).toBeLessThanOrEqual(100_000)
  const withAccessor = {
    plain: 'retained',
    get dangerous() {
      throw new Error('getter evaluated')
    },
  }
  expect(createJsonDocument('accessor', 'Custom', withAccessor).text).toContain(
    'accessor not evaluated',
  )
  const scalar = 'x'.repeat(9000) + '\nretained tail'
  const long = createJsonDocument('scalar', 'Long scalar', scalar)
  expect(long.copyLine(0)).toBe(scalar)
  expect(long.availability).toBe('limited')
})

test('document revisions survive reopening and invalidate replaced live captures', () => {
  const block = tool('run_terminal_command', { stdout: 'old', exitCode: 0 })
  const first = documentForTool(block)
  expect(documentForTool(block).revision).toBe(first.revision)
  block.outputRaw = [{ type: 'json', value: { stdout: 'new', exitCode: 0 } }]
  expect(documentForTool(block).revision).not.toBe(first.revision)
  expect(documentForTool(block).text).toBe('new')
  const plain: ChatMessage = {
    id: 'plain',
    variant: 'ai',
    content: 'retained plain message',
    timestamp: '',
  }
  expect(collectOutputEntries([plain])[0].read().revision).toBe(
    collectOutputEntries([plain])[0].read().revision,
  )
})

test('receipt submitted fields remain available alongside bounded acknowledgment', () => {
  const block = tool(
    'set_output',
    {
      salvaged: true,
      persisted: false,
      message: 'Complete runtime output unavailable',
    },
    'succeeded',
  )
  block.input = {
    status: 'BLOCKING',
    findings: Array.from({ length: 13 }, (_, index) => ({
      title: `finding ${index + 1}`,
    })),
  } as never
  const document = documentForTool(block)
  expect(document.kind).toBe('receipt')
  expect(document.text).toContain('finding 13')
  expect(document.text).toContain('acknowledgment')
  expect(document.availability).toBe('limited')
})

test('saved artifact recovery distinguishes verified, changed, missing, oversized and symlink captures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openbuff-artifact-test-'))
  try {
    const path = join(directory, 'captured.log')
    const text = '  original retained output\nlast line'
    await writeFile(path, text)
    const sha256 = createHash('sha256').update(text).digest('hex')
    const document = await recoverCapturedArtifact('artifact', {
      path,
      kind: 'log',
      sha256,
    })
    expect(document.text).toBe(text)
    expect(document.provenance?.freshness).toBe('captured')
    await writeFile(path, 'changed local artifact')
    const changed = await recoverCapturedArtifact('artifact', {
      path,
      kind: 'log',
      sha256,
    })
    expect(changed.availability).toBe('limited')
    expect(changed.notice).toContain('checksum mismatch')
    expect(changed.provenance?.exact).toBe(false)
    const missing = await recoverCapturedArtifact('missing', {
      path: join(directory, 'missing'),
      kind: 'text',
    })
    expect(missing.availability).toBe('unavailable')
    const link = join(directory, 'link')
    await symlink(path, link)
    expect(
      (await recoverCapturedArtifact('link', { path: link, kind: 'log' }))
        .availability,
    ).toBe('unavailable')
    await writeFile(path, 'x'.repeat(OUTPUT_ARTIFACT_BYTE_LIMIT + 1))
    const bounded = await recoverCapturedArtifact('bounded', {
      path,
      kind: 'log',
    })
    expect(bounded.text.length).toBe(OUTPUT_ARTIFACT_BYTE_LIMIT)
    expect(bounded.availability).toBe('limited')
    expect(bounded.coverage?.total).toBe(OUTPUT_ARTIFACT_BYTE_LIMIT + 1)
    expect(
      capturedArtifacts([
        { type: 'json', value: { path, content: 'source file' } },
      ]),
    ).toEqual([])
    expect(
      capturedArtifacts([
        { type: 'json', value: { artifactPath: path, persisted: false } },
      ]),
    ).toEqual([])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('typed local command blocks remain inspectable after their inline preview caps', () => {
  const diagnostics = Array.from({ length: 15 }, (_, index) => ({
    filePath: `src/file${index}.ts`,
    message: `DOCTOR_DIAGNOSTIC_${index}`,
  }))
  const blocks = [
    {
      type: 'doctor',
      projectRoot: '/captured/project',
      agentsTrusted: true,
      skillsTrusted: true,
      skillCount: 1,
      mcpCount: 0,
      diagnostics,
      providerStatus: '15 retained · no provider request',
    },
    {
      type: 'index-status',
      lines: ['captured index', 'INDEX_ISSUE_6'],
      statusLine: 'degraded',
    },
    {
      type: 'memory',
      state: 'report',
      title: 'Events',
      tone: 'secondary',
      lines: ['EVENT_101 · captured source'],
    },
    {
      type: 'plan-status',
      mode: 'status',
      reportText: 'retained plan report',
      isStatusReport: true,
    },
    {
      type: 'update',
      updateStatus: 'unavailable',
      current: '1.0.0',
      pending: null,
      lines: ['last checked source unavailable'],
    },
  ] as unknown as ChatMessage['blocks']
  const entries = collectOutputEntries([
    { id: 'commands', variant: 'ai', timestamp: '', content: '', blocks },
  ])
  expect(entries).toHaveLength(5)
  expect(entries[0].read().text).toContain('DOCTOR_DIAGNOSTIC_14')
  expect(entries[1].read().text).toContain('INDEX_ISSUE_6')
  expect(entries[2].read().text).toContain('EVENT_101')
  expect(entries[3].read().text).toBe('retained plan report')
  expect(entries[4].read().text).toContain('source unavailable')
})

test('in-place lifecycle, job state and interruption invalidate metadata without copying full source bytes', () => {
  const value = { state: 'running', events: [] }
  const block = tool('check_job', value)
  const first = documentForTool(block)
  value.state = 'completed'
  expect(documentForTool(block).revision).not.toBe(first.revision)
  expect(documentForTool(block).outcome?.label).toBe('completed')
  const mutation = tool('edit_transaction', {
    kind: 'file_mutation_result',
    outcome: 'applied',
    actions: [],
  })
  const before = documentForTool(mutation)
  mutation.interrupted = true
  const after = documentForTool(mutation)
  expect(after.revision).not.toBe(before.revision)
  expect(after.notice).toContain('Run interrupted')
})

test('message validation/error and pending input documents retain raw source with stable origin identities', () => {
  const message: ChatMessage = {
    id: 'errors',
    timestamp: '',
    variant: 'ai',
    content: '',
    userError: 'Captured run failure',
    validationErrors: [
      { id: 'validation', message: '{"errors":["first","RAW_SECOND_ERROR"]}' },
    ],
    blocks: [tool('render_ui', undefined)],
  }
  message.blocks![0] = {
    type: 'tool',
    toolName: 'render_ui',
    toolCallId: 'input',
    input: {
      widget: {
        type: 'button',
        text: 'Open',
        link: 'https://fixture.example/full-destination',
      },
    } as never,
  }
  const entries = collectOutputEntries([message])
  expect(
    entries.find((entry) => entry.id === 'message:errors:validation')!.read()
      .text,
  ).toContain('RAW_SECOND_ERROR')
  expect(
    entries.find((entry) => entry.id === 'message:errors:error')!.read().text,
  ).toContain('Captured run failure')
  expect(
    entries.find((entry) => entry.id === 'tool:input:input')!.read().text,
  ).toContain('full-destination')
  expect(entries.every((entry) => entry.messageId === 'errors')).toBe(true)
})
