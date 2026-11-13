import { describe, expect, it } from 'bun:test'
import {
  captureTextDocument,
  getRawReadBasis,
} from '@codebuff/common/util/byte-text'

import { handleCreatePlan } from '../create-plan'
import {
  getFileProcessingValues,
  grantWholeFileReadAuthorization,
  hasWholeFileReadAuthorization,
  isWholeFileReadAuthorizationFresh,
  type FileProcessingState,
} from '../write-file'

import type {
  ClientToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { Logger } from '@codebuff/common/types/contracts/logger'

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

function createFileProcessingState(): FileProcessingState {
  return {
    promisesByPath: {},
    allPromises: [],
    fileChangeErrors: [],
    fileChanges: [],
    firstFileProcessed: false,
    failedEditRequiresReadByPath: {},
    consecutiveStrReplaceFailuresByPath: {},
  }
}

describe('handleCreatePlan', () => {
  it('initializes file processing state for a new plan path', async () => {
    const path = '.agents/sessions/anonymous-mental-health-app/SPEC.md'
    const plan = '# SPEC.md — Anonymous Mental Health App\n'
    const fileProcessingState = createFileProcessingState()
    const clientToolCalls: ClientToolCall<'create_plan'>[] = []

    const result = await handleCreatePlan({
      previousToolCallFinished: Promise.resolve(),
      toolCall: {
        toolCallId: 'create-plan-new-path',
        toolName: 'create_plan',
        input: { path, plan },
      },
      fileProcessingState,
      logger,
      requestClientToolCall: async (
        toolCall: ClientToolCall<'create_plan'>,
      ): Promise<CodebuffToolOutput<'create_plan'>> => {
        clientToolCalls.push(toolCall)
        return [
          {
            type: 'json',
            value: {
              file: toolCall.input.path,
              message: 'Plan written',
            },
          },
        ]
      },
      writeToClient: () => {},
    })

    expect(fileProcessingState.promisesByPath[path]).toHaveLength(1)
    expect(fileProcessingState.allPromises).toHaveLength(1)
    expect(clientToolCalls).toHaveLength(1)
    expect(clientToolCalls[0]).toMatchObject({
      toolCallId: 'create-plan-new-path',
      toolName: 'create_plan',
      input: {
        type: 'file',
        path,
        content: plan,
      },
    })
    expect(result.output).toEqual([
      {
        type: 'json',
        value: {
          file: path,
          message: 'Plan written',
        },
      },
    ])
  })
})

describe('handleWriteFile', () => {
  describe('getFileProcessingValues', () => {
    it('should copy file processing state values', () => {
      const state: FileProcessingState = {
        promisesByPath: { 'test.ts': [] },
        allPromises: [],
        fileChangeErrors: [],
        fileChanges: [],
        firstFileProcessed: true,
        failedEditRequiresReadByPath: {},
        consecutiveStrReplaceFailuresByPath: {},
      }

      const result = getFileProcessingValues(state)
      expect(result.firstFileProcessed).toBe(true)
      expect(result.promisesByPath).toEqual({ 'test.ts': [] })
    })

    it('hydrates modelVisibleReadAuthorizationHashesByPath across the copy loop', () => {
      // M2-T6: the strict-edit checks use the model-visible snapshot INSTEAD of
      // reads completed later, and getUsableWholeFileAuthorizationHash keys that
      // behavior off `!== undefined`. Hydration had to round-trip the field or
      // committed snapshot semantics silently degraded to the sticky fallback
      // across turn boundaries.
      const snapshot = {
        '/repo/src/a.ts': 'hash-a',
        '/repo/src/b.ts': 'hash-b',
      }
      const result = getFileProcessingValues({
        modelVisibleReadAuthorizationHashesByPath: snapshot,
        rawReadAuthorizationHashesByPath: snapshot,
        modelVisibleRawReadAuthorizationHashesByPath: snapshot,
      })
      expect(result.modelVisibleReadAuthorizationHashesByPath).toEqual(snapshot)
      expect(result.rawReadAuthorizationHashesByPath).toEqual(snapshot)
      expect(result.modelVisibleRawReadAuthorizationHashesByPath).toEqual(
        snapshot,
      )
    })
  })

  it('requires a complete whole basis and rejects raw-only freshness drift', () => {
    const path = 'src/a.ts'
    const content = '\uFEFFone\r\ntwo\r'
    const document = captureTextDocument(content)
    const state = createFileProcessingState()
    expect(grantWholeFileReadAuthorization(state, path, content)).toBe(false)
    expect(
      grantWholeFileReadAuthorization(
        state,
        path,
        content,
        getRawReadBasis(document, 1, document.maxCapabilityLine, 'lines'),
      ),
    ).toBe(false)
    expect(hasWholeFileReadAuthorization(state, path)).toBe(false)
    expect(
      grantWholeFileReadAuthorization(
        state,
        path,
        content,
        getRawReadBasis(document, 1, document.maxCapabilityLine, 'whole'),
      ),
    ).toBe(true)
    expect(state.readAuthorizationHashesByPath?.[path]).toBe(
      document.observationHash,
    )
    expect(state.rawReadAuthorizationHashesByPath?.[path]).toBe(
      document.rawHash,
    )
    expect(isWholeFileReadAuthorizationFresh(state, path, content)).toBe(true)
    for (const drifted of ['one\r\ntwo\r', '\uFEFFone\ntwo\r']) {
      expect(captureTextDocument(drifted).observationHash).toBe(
        document.observationHash,
      )
      expect(isWholeFileReadAuthorizationFresh(state, path, drifted)).toBe(
        false,
      )
    }
  })

  it('uses the model-visible raw snapshot after a later sticky read and through state hydration', () => {
    const path = 'src/a.ts'
    const visible = captureTextDocument('one\n')
    const later = captureTextDocument('one\r\n')
    const state = createFileProcessingState()
    expect(
      grantWholeFileReadAuthorization(
        state,
        path,
        later.rawText,
        getRawReadBasis(later, 1, later.maxCapabilityLine, 'whole'),
      ),
    ).toBe(true)
    state.modelVisibleReadAuthorizationHashesByPath = {
      [path]: visible.observationHash,
    }
    state.modelVisibleRawReadAuthorizationHashesByPath = {
      [path]: visible.rawHash,
    }
    const hydrated = getFileProcessingValues(state)
    expect(
      isWholeFileReadAuthorizationFresh(hydrated, path, visible.rawText),
    ).toBe(true)
    expect(
      isWholeFileReadAuthorizationFresh(hydrated, path, later.rawText),
    ).toBe(false)
    hydrated.modelVisibleRawReadAuthorizationHashesByPath = {}
    expect(hasWholeFileReadAuthorization(hydrated, path)).toBe(false)
  })
})
