import { describe, expect, test } from 'bun:test'

import { describeRunConfigForLog } from '../run-config-digest'

describe('describeRunConfigForLog', () => {
  test('reports scalar byte lengths and shallow collection counts', () => {
    const digest = describeRunConfigForLog({
      prompt: 'Build a widget',
      agent: 'base',
      previousRun: {
        sessionState: {
          mainAgentState: {
            messageHistory: Array.from({ length: 64 }, () => 'y'.repeat(256)),
          },
        },
      },
      maxAgentSteps: 200,
      agents: [{ id: 'one' }, { id: 'two' }],
      handleEvent: () => {},
      signal: undefined,
    })

    expect(digest.prompt).toBe(Buffer.byteLength('Build a widget', 'utf8'))
    expect(digest.agent).toBe(Buffer.byteLength('base', 'utf8'))
    expect(digest.previousRunFields).toBe(1)
    expect(digest.agentsItems).toBe(2)
    expect(digest.maxAgentSteps).toBe(String(200).length)
    // Closures and absent values never enter the digest.
    expect(digest.handleEvent).toBeUndefined()
    expect(digest.signal).toBeUndefined()
  })

  test('never stringifies a transcript-bearing config body into the digest', () => {
    const transcriptBody = {
      sessionState: {
        mainAgentState: {
          messageHistory: [{ content: 'x'.repeat(8192) }],
        },
      },
    }
    const digest = describeRunConfigForLog({
      previousRun: transcriptBody,
      prompt: 'Build a widget',
    })
    const digestJson = JSON.stringify(digest)

    // The digest is a handful of numbers; transcript bodies are not visited.
    expect(digestJson.length).toBeLessThan(128)
    expect(digestJson).not.toContain('x'.repeat(64))
  })

  test('circular fields are counted without serializing them', () => {
    const circular: Record<string, unknown> = {}
    circular['self'] = circular

    const digest = describeRunConfigForLog({ previousRun: circular })

    expect(digest.previousRun).toBeUndefined()
    expect(digest).toEqual({ previousRunFields: 1 })
  })

  test('never reads nested values or invokes their JSON serializers', () => {
    const previousRun = {
      get sessionState() {
        throw new Error('transcript was traversed')
      },
      toJSON() {
        throw new Error('transcript was serialized')
      },
    }
    expect(describeRunConfigForLog({ previousRun })).toEqual({
      previousRunFields: 2,
    })
  })

  test('non-object configs yield an empty digest', () => {
    expect(describeRunConfigForLog(null)).toEqual({})
    expect(describeRunConfigForLog(undefined)).toEqual({})
    expect(describeRunConfigForLog(['a'])).toEqual({})
    expect(describeRunConfigForLog('run-config')).toEqual({})
  })
})
