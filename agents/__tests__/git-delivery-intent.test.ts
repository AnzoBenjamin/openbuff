import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

/**
 * `hasExplicitGitDeliveryIntent` is declared INLINE inside `createBase2`'s
 * `handleSteps` generator: `handleSteps` is serialized via `toString()` and
 * reconstructed with `new Function(...)`, so the classifier cannot live in a
 * module and cannot be exported. This test therefore transpiles `base2.ts`,
 * slices the function source with a brace-depth scan, and rebuilds it — the
 * same technique used by `gate-paths-parity.test.ts`.
 */
type GitDeliveryIntentHelpers = {
  hasExplicitGitDeliveryIntent: (value: unknown) => boolean
}

type InlineHelperFactory = () => GitDeliveryIntentHelpers

const INLINE_HELPER_NAME = 'hasExplicitGitDeliveryIntent'

function extractInlineFunctionSource(
  source: string,
  functionName: string,
): string {
  const declarationStart = source.indexOf(`function ${functionName}(`)
  if (declarationStart < 0) {
    throw new Error(`Unable to find inline ${functionName} declaration`)
  }

  const bodyStart = source.indexOf('{', declarationStart)
  if (bodyStart < 0) {
    throw new Error(`Unable to find inline ${functionName} body`)
  }

  let depth = 0
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index]
    if (character === '{') depth += 1
    if (character === '}') depth -= 1
    if (depth === 0) {
      return source.slice(declarationStart, index + 1)
    }
  }

  throw new Error(`Unable to find end of inline ${functionName} declaration`)
}

function loadInlineGitDeliveryIntent(): GitDeliveryIntentHelpers {
  const base2Source = readFileSync(
    new URL('../base2/base2.ts', import.meta.url),
    'utf8',
  )
  const transpiler = new Bun.Transpiler({ loader: 'ts' })
  const base2JavaScript = transpiler.transformSync(base2Source)
  const helperSource = extractInlineFunctionSource(
    base2JavaScript,
    INLINE_HELPER_NAME,
  )
  const buildHelpers = new Function(
    `"use strict";\n${helperSource}\nreturn { ${INLINE_HELPER_NAME} }`,
  ) as InlineHelperFactory

  return buildHelpers()
}

describe('hasExplicitGitDeliveryIntent (inline base2 classifier)', () => {
  test('the inline declaration is found and reconstructed', () => {
    const { hasExplicitGitDeliveryIntent } = loadInlineGitDeliveryIntent()
    expect(typeof hasExplicitGitDeliveryIntent).toBe('function')
    // Sanity anchor: a trivially explicit request must classify as delivery.
    expect(hasExplicitGitDeliveryIntent('commit our changes')).toBe(true)
  })

  test('explicit delivery phrasings, including stacked determiners', () => {
    const { hasExplicitGitDeliveryIntent } = loadInlineGitDeliveryIntent()
    const expected = true
    for (const input of [
      // Anchored branch ("^commit").
      'Commit and push all our current changes then.',
      'commit and push our current changes',
      'push all our current changes',
      'commit all changes',
      'push our changes',
      'stage all my pending files',
      // Leading-keyword branch.
      'Please commit the changes',
      'now push the working tree',
      // Mid-sentence fallback with three stacked determiners
      // (all + our + current). This is the case the bounded {0,3}
      // determiner repetition fixes: neither the anchored nor the
      // leading-keyword branch matches it.
      'Go ahead and push all our current changes',
      // Same stacked-determiner clause, reached through the fallback even
      // though the leading verb is typo'd: the sentence still contains a
      // standalone "push all our current changes" delivery clause.
      'Ccommit and push all our current changes then.',
    ]) {
      expect(hasExplicitGitDeliveryIntent(input)).toBe(expected)
    }
  })

  test('bypass phrase, negations, advisory questions, and empty input', () => {
    const { hasExplicitGitDeliveryIntent } = loadInlineGitDeliveryIntent()
    const expected = false
    for (const input of [
      // The exact standalone bypass phrase authorizes a commit; matching it
      // here would re-arm the gate and block that commit.
      'COMMIT ANYWAY',
      'commit anyway',
      // Advisory questions.
      'Should I commit changes?',
      'How do I commit changes?',
      // Negated phrasings.
      'do not commit these changes',
      'without committing',
      'no need to push our work',
      'Check the full validation gate for our current changes, but do not commit',
      // No git verb at all.
      'Do all the suggested followups.',
      // Word boundaries keep a typo'd verb from matching: there is no
      // boundary inside "Ccommit", and this sentence has no other git verb.
      'Ccommit our current changes then.',
      '',
      '   ',
    ]) {
      expect(hasExplicitGitDeliveryIntent(input)).toBe(expected)
    }
  })

  test('non-string inputs are never delivery intents', () => {
    const { hasExplicitGitDeliveryIntent } = loadInlineGitDeliveryIntent()
    const expected = false
    for (const input of [undefined, null, 42, {}] as unknown[]) {
      expect(hasExplicitGitDeliveryIntent(input)).toBe(expected)
    }
  })
})
