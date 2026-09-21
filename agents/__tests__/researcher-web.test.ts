import { describe, test, expect } from 'bun:test'

import researcherWeb from '../researcher/researcher-web'

import type { AgentState } from '../types/agent-definition'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockAgentState(): AgentState {
  return {
    agentId: 'researcher-web-test',
    runId: 'test-run',
    parentId: undefined,
    messageHistory: [],
    output: undefined,
    systemPrompt: '',
    toolDefinitions: {},
    contextTokenCount: 0,
  }
}

const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

/**
 * Drive the handleSteps generator to completion WITHOUT feeding tool results:
 * programmatic code must never issue web_search calls itself, so the only
 * yields should be the add_message bootstrap and the final STEP_ALL.
 * Returns all yielded values in order.
 */
function runGenerator(prompt: string, params?: Record<string, any>) {
  const generator = researcherWeb.handleSteps!({
    agentState: createMockAgentState(),
    logger: mockLogger as any,
    prompt,
    params: params ?? {},
  })

  const yields: Array<{ value: any; done: boolean | undefined }> = []
  let next = generator.next()

  while (!next.done) {
    yields.push(next as { value: any; done: boolean })
    next = generator.next({
      toolResult: undefined,
      stepsComplete: false,
      agentState: createMockAgentState(),
    })
  }

  return yields
}

// ---------------------------------------------------------------------------
// Definition contract
// ---------------------------------------------------------------------------

describe('researcher-web agent', () => {
  describe('definition contract', () => {
    test('has correct id', () => {
      expect(researcherWeb.id).toBe('researcher-web')
    })

    test('has display name', () => {
      expect(researcherWeb.displayName).toBe('Weeb')
    })

    test('toolNames includes web_search and set_output; programmaticToolNames empty', () => {
      expect(researcherWeb.toolNames).toContain('web_search')
      expect(researcherWeb.toolNames).toContain('set_output')
      expect(researcherWeb.programmaticToolNames).toEqual([])
    })

    test('has structured research output with required all-three contract', () => {
      expect(researcherWeb.outputMode).toBe('structured_output')
      expect(researcherWeb.outputSchema).toBeDefined()
      expect(researcherWeb.outputSchema?.required).toEqual([
        'questions',
        'sources',
        'skippedQuestions',
      ])
    })

    test('does not include parent message history', () => {
      expect(researcherWeb.includeMessageHistory).toBe(false)
    })

    test('has handleSteps generator', () => {
      expect(researcherWeb.handleSteps).toBeDefined()
      expect(typeof researcherWeb.handleSteps).toBe('function')
    })

    test('has spawnerPrompt mentioning web search', () => {
      expect(researcherWeb.spawnerPrompt).toContain('web')
    })

    test('handleSteps is a serialized-safe generator (self-contained helpers)', () => {
      const serialized = String(researcherWeb.handleSteps)
      expect(serialized).toContain('function*')
      expect(serialized).toContain('decomposePrompt')
      expect(serialized).toContain('stripMetaInstructions')
    })
  })

  // -----------------------------------------------------------------------
  // Bootstrap behavior: seed subquestions, then STEP_ALL
  // -----------------------------------------------------------------------

  describe('handleSteps bootstrap', () => {
    test('yields no web_search calls programmatically', () => {
      const yields = runGenerator(
        '1. How does Unity handle prefab instantiation?\n' +
          "2. What is Godot's scene tree optimization approach?",
      )
      const toolCalls = yields.filter(
        (y) =>
          y.value &&
          typeof y.value === 'object' &&
          y.value.toolName === 'web_search',
      )
      expect(toolCalls).toHaveLength(0)
    })

    test('has exactly two yields: add_message seed then STEP_ALL', () => {
      const yields = runGenerator(
        '1. Unity DOTS overview\n2. Godot scene tree architecture',
      )
      expect(yields).toHaveLength(2)
      expect(yields[0]?.value?.toolName).toBe('add_message')
      expect(yields[1]?.value).toBe('STEP_ALL')
    })

    test('seeds decomposed subquestions in the add_message payload', () => {
      const broadPrompt =
        '1. How does Unity handle prefab instantiation?\n' +
          "2. What is Godot's scene tree optimization approach?"
      const yields = runGenerator(broadPrompt)
      const message = yields[0]?.value?.input?.content as string
      expect(message).toContain('web_search')
      expect(message).toContain('Unity handle prefab instantiation')
      expect(message).toContain("Godot's scene tree optimization")
      expect(message).toContain('set_output')
    })

    test('simple prompt seeds the raw prompt as a single question', () => {
      const yields = runGenerator('What is the best Unity render pipeline for mobile?')
      const message = yields[0]?.value?.input?.content as string
      expect(message).toContain('What is the best Unity render pipeline for mobile?')
    })

    test('seed message tells the model to iterate, refine queries, and read results', () => {
      const yields = runGenerator('How does Rust ownership work?')
      const message = yields[0]?.value?.input?.content as string
      expect(message).toContain('refine')
      expect(message).toContain('include_links')
      expect(message).toContain('no hard cap')
    })

    test('seed message includes citation and honesty requirements', () => {
      const yields = runGenerator('What is Bun?')
      const message = yields[0]?.value?.input?.content as string
      expect(message).toContain('citations')
      expect(message).toContain('sources')
      expect(message).toContain('skippedQuestions')
    })

    test('completes without needing fed tool results (STEP_ALL terminates loop)', () => {
      const yields = runGenerator('')
      expect(yields[yields.length - 1]?.value).toBe('STEP_ALL')
    })
  })

  // -----------------------------------------------------------------------
  // instructionsPrompt content invariants
  // -----------------------------------------------------------------------

  describe('instructionsPrompt guidance', () => {
    const instructions = researcherWeb.instructionsPrompt ?? ''

    test('mentions adapting/refining queries based on results', () => {
      expect(instructions).toMatch(/adapt/i)
      expect(instructions).toMatch(/refine/i)
    })

    test('mentions following links via include_links', () => {
      expect(instructions).toContain('include_links')
    })

    test('mentions citing URLs and honest skipped/failed reporting', () => {
      expect(instructions).toMatch(/cite/i)
      expect(instructions).toContain('skippedQuestions')
      expect(instructions).toContain('sources')
    })

    test('mentions iterating until coverage is adequate', () => {
      expect(instructions).toMatch(/iterate/i)
    })
  })

  // -----------------------------------------------------------------------
  // Query constraint hints from params reach the seed message
  // -----------------------------------------------------------------------

  describe('params propagate into the seed message', () => {
    test('locale, dateRange, and sourceDomains become query-control hints', () => {
      const yields = runGenerator('Compare databases', {
        locale: 'en-US',
        dateRange: '2024',
        sourceDomains: ['postgresql.org', 'sqlite.org'],
      })
      const message = yields[0]?.value?.input?.content as string
      expect(message).toContain('en-US')
      expect(message).toContain('2024')
      expect(message).toContain('site:postgresql.org')
      expect(message).toContain('site:sqlite.org')
    })
  })
})
