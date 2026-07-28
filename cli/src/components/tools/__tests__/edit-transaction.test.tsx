import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { initializeThemeStore } from '../../../hooks/use-theme'
import { chatThemes } from '../../../utils/theme-system'
import { renderToolComponent } from '../registry'
import type { ToolBlock } from '../types'

initializeThemeStore()

test('[ERR-M06] transaction renders per-action rollback and failure detail', () => {
  const block = {
    type: 'tool',
    toolName: 'edit_transaction',
    toolCallId: 'tx-1',
    input: { edits: [] },
    outputRaw: [
      {
        type: 'json',
        value: {
          kind: 'file_mutation_result',
          version: 1,
          operationId: 'op-1',
          outcome: 'rollback_incomplete',
          authorityTier: 'portable_path',
          receiptId: 'r-1',
          actions: [
            {
              actionId: 'a',
              index: 0,
              action: 'update',
              path: 'src/a.ts',
              outcome: 'rollback_incomplete',
              beforeHash: 'before',
              afterHash: 'after',
              rollback: { attempted: true, succeeded: false },
              error: {
                code: 'rollback_incomplete',
                message: 'restore failed',
                retryable: true,
                recovery: 'inspect_rollback',
              },
            },
          ],
          errors: [],
          freshCapabilities: [],
        },
      },
    ],
  } as ToolBlock
  const rendered = renderToolComponent(block, chatThemes.dark, {
    availableWidth: 80,
    indentationOffset: 0,
    labelWidth: 0,
  })
  const markup = renderToStaticMarkup(rendered?.content as React.ReactElement)
  expect(markup).toContain('1. src/a.ts')
  expect(markup).not.toContain('0. src/a.ts')
  expect(markup).toContain('rollback_incomplete')
  expect(markup).toContain('rollback failed')
  expect(markup).toContain('restore failed')
})

test('move actions render source and destination paths', () => {
  const block = {
    type: 'tool',
    toolName: 'edit_transaction',
    toolCallId: 'tx-move',
    input: { edits: [] },
    outputRaw: [
      {
        type: 'json',
        value: {
          kind: 'file_mutation_result',
          version: 1,
          operationId: 'op-move',
          outcome: 'applied',
          authorityTier: 'portable_path',
          receiptId: 'r-move',
          actions: [
            {
              actionId: 'move',
              index: 0,
              action: 'move',
              path: 'src/old.ts',
              destinationPath: 'src/new.ts',
              outcome: 'applied',
              beforeHash: 'before',
              afterHash: 'after',
            },
          ],
          errors: [],
          freshCapabilities: [],
        },
      },
    ],
  } as ToolBlock
  const rendered = renderToolComponent(block, chatThemes.dark, {
    availableWidth: 80,
    indentationOffset: 0,
    labelWidth: 0,
  })
  const markup = renderToStaticMarkup(rendered?.content as React.ReactElement)
  expect(markup).toContain('src/old.ts → src/new.ts')
})

test('renders receipt-correlated post-edit hashes without leaking capabilities or content', () => {
  const readCapability = 'cap.v3.sensitive-full-token'
  const afterContent = 'SENSITIVE_POST_EDIT_BODY'
  const afterHash =
    'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
  const block = {
    type: 'tool',
    toolName: 'edit_transaction',
    toolCallId: 'tx-anchor',
    input: { edits: [] },
    outputRaw: [
      {
        type: 'json',
        value: {
          kind: 'file_mutation_result',
          version: 1,
          operationId: 'op-anchor',
          outcome: 'applied',
          authorityTier: 'portable_path',
          receiptId: 'r-anchor',
          actions: [
            {
              actionId: 'anchored',
              index: 0,
              action: 'update',
              path: 'src/anchored.ts',
              outcome: 'applied',
              afterHash,
              editAnchor: {
                startLine: 1,
                endLine: 8,
                contentHash: afterHash,
                readCapability,
                afterContent,
              },
            },
          ],
          errors: [],
          freshCapabilities: [],
          authorityReceipt: {
            kind: 'commit_receipt',
            version: 1,
            operationId: 'op-anchor',
            receiptId: 'r-anchor',
            callId: 'call-anchor',
            authorityTier: 'portable_path',
            status: 'committed',
            actions: [
              {
                actionId: 'anchored',
                index: 0,
                action: 'update',
                path: 'src/anchored.ts',
                status: 'committed',
                afterHash,
              },
            ],
            finalHashes: { 'src/anchored.ts': afterHash },
          },
        },
      },
    ],
  } as ToolBlock
  const rendered = renderToolComponent(block, chatThemes.dark, {
    availableWidth: 80,
    indentationOffset: 0,
    labelWidth: 0,
  })
  const markup = renderToStaticMarkup(rendered?.content as React.ReactElement)

  expect(markup).toContain('post-edit 1234567890abcdef')
  expect(markup.match(/fresh capability available/g)).toHaveLength(1)
  expect(markup).not.toContain(readCapability)
  expect(markup).not.toContain(afterContent)
  expect(markup).not.toContain(
    '1234567890abcdef1234567890abcdef1234567890abcdef',
  )
})

test('malformed receipt envelopes and ambiguous action keys hide post-edit anchors', () => {
  const afterHash =
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const createMutation = () => ({
    kind: 'file_mutation_result',
    version: 1,
    operationId: 'op-adversarial',
    outcome: 'applied',
    authorityTier: 'portable_path',
    receiptId: 'r-adversarial',
    actions: [
      {
        actionId: 'anchored',
        index: 0,
        action: 'update',
        path: 'src/anchored.ts',
        outcome: 'applied',
        afterHash,
        editAnchor: {
          startLine: 1,
          endLine: 2,
          contentHash: afterHash,
          readCapability: 'cap.v3.adversarial-secret',
        },
      },
    ],
    errors: [],
    freshCapabilities: [],
    authorityReceipt: {
      kind: 'commit_receipt',
      version: 1,
      operationId: 'op-adversarial',
      receiptId: 'r-adversarial',
      callId: 'call-adversarial',
      authorityTier: 'portable_path',
      status: 'committed',
      actions: [
        {
          actionId: 'anchored',
          index: 0,
          action: 'update',
          path: 'src/anchored.ts',
          status: 'committed',
          afterHash,
        },
      ],
      finalHashes: { 'src/anchored.ts': afterHash },
    },
  })
  const cases: Array<
    [string, (mutation: ReturnType<typeof createMutation>) => void]
  > = [
    [
      'missing callId',
      (mutation) => {
        Reflect.deleteProperty(mutation.authorityReceipt, 'callId')
      },
    ],
    [
      'missing authorityTier',
      (mutation) => {
        Reflect.deleteProperty(mutation.authorityReceipt, 'authorityTier')
      },
    ],
    [
      'empty callId',
      (mutation) => {
        mutation.authorityReceipt.callId = ''
      },
    ],
    [
      'empty authorityTier',
      (mutation) => {
        mutation.authorityReceipt.authorityTier = ''
      },
    ],
    [
      'mismatched authorityTier',
      (mutation) => {
        mutation.authorityReceipt.authorityTier = 'workspace'
      },
    ],
    [
      'duplicate index',
      (mutation) => {
        mutation.authorityReceipt.actions.push({
          ...mutation.authorityReceipt.actions[0],
          actionId: 'other-action',
        })
      },
    ],
    [
      'duplicate actionId',
      (mutation) => {
        mutation.authorityReceipt.actions.push({
          ...mutation.authorityReceipt.actions[0],
          index: 1,
        })
      },
    ],
  ]

  for (const [name, mutate] of cases) {
    const mutation = createMutation()
    mutate(mutation)
    const block = {
      type: 'tool',
      toolName: 'edit_transaction',
      toolCallId: `tx-${name}`,
      input: { edits: [] },
      outputRaw: [{ type: 'json', value: mutation }],
    } as ToolBlock
    const rendered = renderToolComponent(block, chatThemes.dark, {
      availableWidth: 80,
      indentationOffset: 0,
      labelWidth: 0,
    })
    const markup = renderToStaticMarkup(
      rendered?.content as React.ReactElement,
    )

    expect(markup).not.toContain('fresh capability available')
    expect(markup).not.toContain('post-edit')
    expect(markup).not.toContain('cap.v3.adversarial-secret')
  }
})

test('well-formed anchors from rolled-back or receipt-mismatched actions stay hidden', () => {
  const rolledBackCapability = 'cap.v3.rolled-back-secret'
  const mismatchedCapability = 'cap.v3.mismatched-secret'
  const rolledBackHash =
    'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  const mismatchedHash =
    'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
  const block = {
    type: 'tool',
    toolName: 'edit_transaction',
    toolCallId: 'tx-untrusted-anchors',
    input: { edits: [] },
    outputRaw: [
      {
        type: 'json',
        value: {
          kind: 'file_mutation_result',
          version: 1,
          operationId: 'op-untrusted-anchors',
          outcome: 'partial',
          authorityTier: 'portable_path',
          receiptId: 'r-untrusted-anchors',
          actions: [
            {
              actionId: 'rolled-back',
              index: 0,
              action: 'update',
              path: 'src/rolled-back.ts',
              outcome: 'rolled_back',
              afterHash: rolledBackHash,
              editAnchor: {
                startLine: 1,
                endLine: 2,
                contentHash: rolledBackHash,
                readCapability: rolledBackCapability,
                afterContent: 'ROLLED_BACK_CONTENT',
              },
            },
            {
              actionId: 'mismatched',
              index: 1,
              action: 'move',
              path: 'src/old.ts',
              destinationPath: 'src/new.ts',
              outcome: 'applied',
              afterHash: mismatchedHash,
              editAnchor: {
                startLine: 1,
                endLine: 3,
                contentHash: mismatchedHash,
                readCapability: mismatchedCapability,
                afterContent: 'MISMATCHED_CONTENT',
              },
            },
          ],
          errors: [],
          freshCapabilities: [],
          authorityReceipt: {
            kind: 'commit_receipt',
            version: 1,
            operationId: 'op-untrusted-anchors',
            receiptId: 'r-untrusted-anchors',
            callId: 'call-untrusted-anchors',
            authorityTier: 'portable_path',
            status: 'committed',
            actions: [
              {
                actionId: 'rolled-back',
                index: 0,
                action: 'update',
                path: 'src/rolled-back.ts',
                status: 'committed',
                afterHash: rolledBackHash,
              },
              {
                actionId: 'different-action-id',
                index: 1,
                action: 'move',
                path: 'src/old.ts',
                destinationPath: 'src/new.ts',
                status: 'committed',
                afterHash: mismatchedHash,
              },
            ],
            finalHashes: {
              'src/rolled-back.ts': rolledBackHash,
              'src/new.ts': mismatchedHash,
            },
          },
        },
      },
    ],
  } as ToolBlock
  const rendered = renderToolComponent(block, chatThemes.dark, {
    availableWidth: 80,
    indentationOffset: 0,
    labelWidth: 0,
  })
  const markup = renderToStaticMarkup(rendered?.content as React.ReactElement)

  expect(markup).not.toContain('fresh capability available')
  expect(markup).not.toContain('post-edit')
  expect(markup).not.toContain(rolledBackCapability)
  expect(markup).not.toContain(mismatchedCapability)
  expect(markup).not.toContain('ROLLED_BACK_CONTENT')
  expect(markup).not.toContain('MISMATCHED_CONTENT')
})

test('malformed post-edit anchors do not claim a fresh capability', () => {
  const block = {
    type: 'tool',
    toolName: 'edit_transaction',
    toolCallId: 'tx-malformed-anchor',
    input: { edits: [] },
    outputRaw: [
      {
        type: 'json',
        value: {
          kind: 'file_mutation_result',
          version: 1,
          operationId: 'op-malformed-anchor',
          outcome: 'applied',
          authorityTier: 'portable_path',
          actions: [
            {
              actionId: 'bad',
              index: 0,
              action: 'update',
              path: 'src/bad.ts',
              outcome: 'applied',
              editAnchor: {
                contentHash: 'sha256:abc',
                readCapability: 'cap.v3.secret',
              },
            },
          ],
          errors: [],
          freshCapabilities: [],
        },
      },
    ],
  } as ToolBlock
  const rendered = renderToolComponent(block, chatThemes.dark, {
    availableWidth: 80,
    indentationOffset: 0,
    labelWidth: 0,
  })
  const markup = renderToStaticMarkup(rendered?.content as React.ReactElement)

  expect(markup).not.toContain('fresh capability available')
  expect(markup).not.toContain('cap.v3.secret')
})

test('redacts capabilities from top-level transaction errors', () => {
  const token = 'cap.v3.top-level-secret'
  const block = {
    type: 'tool',
    toolName: 'edit_transaction',
    toolCallId: 'tx-top-level-redaction',
    input: { edits: [] },
    outputRaw: [
      {
        type: 'json',
        value: {
          errorMessage: `Retry with basedOnRead="${token}"`,
        },
      },
    ],
  } as ToolBlock
  const rendered = renderToolComponent(block, chatThemes.dark, {
    availableWidth: 80,
    indentationOffset: 0,
    labelWidth: 0,
  })
  const markup = renderToStaticMarkup(rendered?.content as React.ReactElement)

  expect(markup).toContain('[REDACTED]')
  expect(markup).not.toContain(token)
})

test('redacts capabilities from legacy failure rows', () => {
  const token = 'cap.v3.failure-row-secret'
  const block = {
    type: 'tool',
    toolName: 'edit_transaction',
    toolCallId: 'tx-failure-redaction',
    input: { edits: [] },
    outputRaw: [
      {
        type: 'json',
        value: {
          failures: [
            {
              editIndex: 0,
              path: 'src/secret.ts',
              errorMessage: `readCapability: ${token}`,
            },
          ],
        },
      },
    ],
  } as ToolBlock
  const rendered = renderToolComponent(block, chatThemes.dark, {
    availableWidth: 80,
    indentationOffset: 0,
    labelWidth: 0,
  })
  const markup = renderToStaticMarkup(rendered?.content as React.ReactElement)

  expect(markup).toContain('[REDACTED]')
  expect(markup).not.toContain(token)
})

test('redacts capabilities from canonical action errors', () => {
  const token = 'cap.v3.action-error-secret'
  const block = {
    type: 'tool',
    toolName: 'edit_transaction',
    toolCallId: 'tx-action-redaction',
    input: { edits: [] },
    outputRaw: [
      {
        type: 'json',
        value: {
          kind: 'file_mutation_result',
          version: 1,
          operationId: 'op-redaction',
          outcome: 'failed',
          authorityTier: 'portable_path',
          actions: [
            {
              actionId: 'secret',
              index: 0,
              action: 'update',
              path: 'src/secret.ts',
              outcome: 'failed',
              error: {
                code: 'failed',
                message: `raw token ${token}`,
                retryable: true,
                recovery: 'read_again',
              },
            },
          ],
          errors: [],
          freshCapabilities: [],
        },
      },
    ],
  } as ToolBlock
  const rendered = renderToolComponent(block, chatThemes.dark, {
    availableWidth: 80,
    indentationOffset: 0,
    labelWidth: 0,
  })
  const markup = renderToStaticMarkup(rendered?.content as React.ReactElement)

  expect(markup).toContain('[REDACTED]')
  expect(markup).not.toContain(token)
})

test('legacy transaction failures render one-based detail exactly once', () => {
  const block = {
    type: 'tool',
    toolName: 'edit_transaction',
    toolCallId: 'tx-preflight',
    input: { edits: [] },
    outputRaw: [
      {
        type: 'json',
        value: {
          errorMessage:
            'edit_transaction aborted during preflight at edit 6 of 18.',
          failures: [
            {
              editIndex: 5,
              path: 'src/page.tsx',
              errorMessage: 'oldString was not an exact match',
            },
          ],
        },
      },
    ],
  } as ToolBlock
  const rendered = renderToolComponent(block, chatThemes.dark, {
    availableWidth: 80,
    indentationOffset: 0,
    labelWidth: 0,
  })
  const markup = renderToStaticMarkup(rendered?.content as React.ReactElement)

  expect(markup).toContain('6. src/page.tsx')
  expect(markup.match(/oldString was not an exact match/g)).toHaveLength(1)
})
