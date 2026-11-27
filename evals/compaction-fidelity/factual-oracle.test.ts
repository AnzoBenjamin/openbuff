import { describe, expect, test } from 'bun:test'

import {
  collectFactualEvidence,
  evaluateFactualCoverage,
  FACTUAL_CORRUPTIONS,
  MEMORY_FIXTURE_FACTS,
  renderFixtureFact,
} from './factual-oracle'

const faithful = MEMORY_FIXTURE_FACTS.map((fact) => renderFixtureFact(fact))

const corrupt = (corruption: (typeof FACTUAL_CORRUPTIONS)[number]): string[] =>
  MEMORY_FIXTURE_FACTS.map((fact) =>
    renderFixtureFact(
      fact,
      fact.id === corruption.id ? corruption.values : fact.values,
    ),
  )

describe('B13 deterministic factual oracle', () => {
  test('the fixture binds the five exact facts and the decision/rationale from SPEC', () => {
    expect(MEMORY_FIXTURE_FACTS.map((fact) => fact.values)).toEqual([
      { timeoutMs: 1500 },
      {
        forcePushMainRequiresExplicitRequest: true,
        instruction: 'do not force-push main without an explicit request',
      },
      { blockerId: 'contract-consumer-v2', status: 'open' },
      { sourceRevision: 'order-schema@2' },
      { nextAction: 'verify-order-contract-before-task-acceptance' },
      {
        decision: 'represent amounts in integer minor units',
        rationale: 'avoid binary floating-point drift at the shared contract',
      },
    ])
  })

  test('complete exact claims score 1 independently of identifier coverage', () => {
    const result = evaluateFactualCoverage(faithful)
    expect(result.identifierScore).toBe(1)
    expect(result.factualScore).toBe(1)
    expect(result.facts.every((fact) => fact.covered)).toBe(true)
  })

  test('identifier-only copies keep identifier coverage but score zero factual fidelity', () => {
    const identifiers = MEMORY_FIXTURE_FACTS.map(
      (fact) => `FACT[${fact.id}][${fact.path}]`,
    )
    const result = evaluateFactualCoverage(identifiers)
    expect(result.identifierScore).toBe(1)
    expect(result.factualScore).toBe(0)
    expect(result.facts.every((fact) => !fact.covered)).toBe(true)
  })

  test('identifier substrings and unrelated path mentions are not fact claims', () => {
    const mentions = MEMORY_FIXTURE_FACTS.map(
      (fact) =>
        `Read ${fact.path}; remember ${fact.id}: ${JSON.stringify(fact.values)}`,
    )
    const result = evaluateFactualCoverage(mentions)
    expect(result.identifierScore).toBe(0)
    expect(result.factualScore).toBe(0)
  })

  test('an empty retrieval has no identifier or factual credit', () => {
    const result = evaluateFactualCoverage([])
    expect(result.identifierScore).toBe(0)
    expect(result.factualScore).toBe(0)
  })

  for (const corruption of FACTUAL_CORRUPTIONS) {
    test(`identifier-correct/value-wrong copies fail: ${corruption.name}`, () => {
      const result = evaluateFactualCoverage(corrupt(corruption))
      expect(result.identifierScore).toBe(1)
      expect(result.factualScore).toBe(5 / 6)
      const failed = result.facts.find((fact) => fact.id === corruption.id)!
      expect(failed.identifierPresent).toBe(true)
      expect(failed.covered).toBe(false)
      expect(
        [...failed.missingFields, ...failed.incorrectFields].length,
      ).toBeGreaterThan(0)
    })

    test(`a correct duplicate cannot hide a conflicting claim: ${corruption.name}`, () => {
      const changed = MEMORY_FIXTURE_FACTS.find(
        (fact) => fact.id === corruption.id,
      )!
      const contradictory = renderFixtureFact(changed, corruption.values)
      for (const evidence of [
        [...faithful, contradictory],
        [contradictory, ...faithful],
        [faithful.join('\n') + '\n' + contradictory],
      ]) {
        const result = evaluateFactualCoverage(evidence)
        expect(result.identifierScore).toBe(1)
        expect(result.factualScore).toBe(5 / 6)
        expect(
          result.facts.find((fact) => fact.id === corruption.id)!.covered,
        ).toBe(false)
      }
    })
  }

  test('identical duplicate claims are not extra credit or a contradiction', () => {
    const result = evaluateFactualCoverage([...faithful, ...faithful])
    expect(result.identifierScore).toBe(1)
    expect(result.factualScore).toBe(1)
    expect(result.facts.every((fact) => fact.claimCount === 2)).toBe(true)
  })

  test('compound fields must coexist in a complete claim, not be spliced across fragments', () => {
    const blocker = MEMORY_FIXTURE_FACTS.find((fact) => fact.id === 'blocker')!
    const result = evaluateFactualCoverage([
      ...faithful.filter((claim) => claim !== renderFixtureFact(blocker)),
      renderFixtureFact(blocker, { blockerId: 'contract-consumer-v2' }),
      renderFixtureFact(blocker, { status: 'open' }),
    ])
    expect(result.identifierScore).toBe(1)
    expect(result.factualScore).toBe(5 / 6)
    expect(result.facts.find((fact) => fact.id === 'blocker')!.covered).toBe(
      false,
    )
  })

  test('values retain their types and are not substring-matched', () => {
    const timeout = MEMORY_FIXTURE_FACTS[0]
    for (const wrong of ['1500', 15000, 'timeoutMs=1500', null]) {
      const result = evaluateFactualCoverage([
        ...faithful.slice(1),
        renderFixtureFact(timeout, { timeoutMs: wrong }),
      ])
      expect(result.identifierScore).toBe(1)
      expect(result.factualScore).toBe(5 / 6)
    }
  })

  test('duplicate JSON fields fail in either order rather than using JSON last-wins', () => {
    const timeout = MEMORY_FIXTURE_FACTS[0]
    for (const values of [
      '{"timeoutMs":0,"timeoutMs":1500}',
      '{"timeoutMs":1500,"timeoutMs":0}',
    ]) {
      const result = evaluateFactualCoverage([
        ...faithful.slice(1),
        `FACT[${timeout.id}][${timeout.path}]=${values}`,
      ])
      expect(result.identifierScore).toBe(1)
      expect(result.factualScore).toBe(5 / 6)
      expect(result.facts[0].malformedClaims).toBe(1)
    }
  })

  test('JSON key order and whitespace are not value changes', () => {
    const blocker = MEMORY_FIXTURE_FACTS.find((fact) => fact.id === 'blocker')!
    const result = evaluateFactualCoverage([
      ...faithful.filter((claim) => claim !== renderFixtureFact(blocker)),
      `  - FACT[${blocker.id}][${blocker.path}]= { "status" : "open", "blockerId" : "contract-consumer-v2" }`,
    ])
    expect(result.identifierScore).toBe(1)
    expect(result.factualScore).toBe(1)
  })

  test('malformed, truncated, extra-field and wrong-path claims cannot fill a gap', () => {
    const timeout = MEMORY_FIXTURE_FACTS[0]
    for (const claim of [
      `FACT[${timeout.id}][${timeout.path}]={"timeoutMs":1500`,
      `FACT[${timeout.id}][${timeout.path}]=not-json`,
      renderFixtureFact(timeout, { timeoutMs: 1500, ignoredContradiction: 0 }),
      renderFixtureFact({ ...timeout, path: `${timeout.path}.stale` }),
    ]) {
      const result = evaluateFactualCoverage([...faithful.slice(1), claim])
      expect(result.factualScore).toBe(5 / 6)
      expect(result.facts[0].covered).toBe(false)
    }
  })

  test('collects actual message bodies and decodes archive serialization without quoting loss', () => {
    const body = faithful.join('\n')
    const original = [
      { role: 'tool', content: [{ type: 'json', value: { output: body } }] },
    ]
    const archived = [
      {
        role: 'tool',
        content: [{ type: 'json', value: JSON.stringify({ output: body }) }],
      },
    ]
    const indexed = JSON.stringify(JSON.stringify({ output: body }))
    const summary = [{ role: 'user', content: [{ type: 'text', text: body }] }]
    for (const source of [original, archived, indexed, summary]) {
      expect(
        evaluateFactualCoverage(collectFactualEvidence(source)).factualScore,
      ).toBe(1)
    }
  })
})
