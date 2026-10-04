import { describe, expect, test } from 'bun:test'

import {
  getPostingCandidates,
  getPostingDocumentFrequency,
} from './query-data'
import type { MetadataIndex } from './types'

/** Minimal MetadataIndex fixture: getPostingCandidates only reads queryData.postings. */
function makeIndex(postings: Record<string, string[]>): MetadataIndex {
  return {
    version: '2',
    projectRoot: '/tmp/query-data-test',
    builtAt: 0,
    fileCount: Object.keys(postings).length,
    files: {},
    graph: { nodes: {}, edges: [] },
    queryData: {
      postings,
      documentFrequencies: Object.fromEntries(
        Object.entries(postings).map(([token, paths]) => [token, paths.length]),
      ),
      adjacency: {},
    },
  }
}

describe('getPostingCandidates', () => {
  test('returns null without query data or query tokens', () => {
    const index = makeIndex({ auth: ['src/a.ts'] })
    expect(getPostingCandidates(index, [])).toBeNull()
    const noQueryData = { ...index, queryData: undefined }
    expect(getPostingCandidates(noQueryData, ['auth'])).toBeNull()
  })

  test('returns exact posting paths for an exact token', () => {
    const index = makeIndex({ auth: ['src/a.ts'], login: ['src/b.ts'] })
    expect(getPostingCandidates(index, ['auth'])).toEqual(
      new Set(['src/a.ts']),
    )
  })

  test('normalizes query tokens before lookup', () => {
    const index = makeIndex({ auth: ['src/a.ts'] })
    expect(getPostingCandidates(index, ['  AUTH! '])).toEqual(
      new Set(['src/a.ts']),
    )
  })

  test('expands short tokens via the historical substring pass', () => {
    const index = makeIndex({
      auth: ['src/a.ts'],
      authenticate: ['src/b.ts'],
      authorization: ['src/c.ts'],
    })
    expect(getPostingCandidates(index, ['auth'])).toEqual(
      new Set(['src/a.ts', 'src/b.ts', 'src/c.ts']),
    )
  })

  test('expands reverse containment for vocabulary tokens inside the query', () => {
    // "flow" (>= 4 chars) is contained in the query token, so its posting
    // joins the union — historical behavior for typical queries.
    const index = makeIndex({ flow: ['src/flow.ts'] })
    expect(getPostingCandidates(index, ['authflowchart'])).toEqual(
      new Set(['src/flow.ts']),
    )
  })

  test('long exact tokens skip the substring expansion pass', () => {
    const index = makeIndex({
      longtoken: ['src/a.ts'],
      longtokensuffix: ['src/b.ts'],
    })
    // "longtoken" is 9 chars with an exact posting, so the vocabulary
    // substring "longtokensuffix" no longer widens the union.
    expect(getPostingCandidates(index, ['longtoken'])).toEqual(
      new Set(['src/a.ts']),
    )
  })

  test('caps the candidate union but never drops exact matches', () => {
    const postings: Record<string, string[]> = {}
    for (let i = 0; i < 5000; i++) {
      postings[`aaa${i}`] = [`src/file${i}.ts`]
    }
    postings.zzzexact = ['src/z.ts']
    const index = makeIndex(postings)
    const candidates = getPostingCandidates(index, ['aaa', 'zzzexact'])
    // The substring union caps at MAX_POSTING_CANDIDATE_PATHS (4096) and the
    // second token's exact posting is still added on top of the cap.
    expect(candidates?.size).toBe(4097)
    expect(candidates?.has('src/z.ts')).toBe(true)
    expect(candidates?.has('src/file4999.ts')).toBe(false)
  })
})

describe('getPostingDocumentFrequency', () => {
  test('reports an exact posting document frequency and uncapped union sizes', () => {
    const index = makeIndex({ auth: ['src/a.ts'], login: ['src/b.ts'] })
    // Exact posting: the persisted document frequency wins.
    expect(getPostingDocumentFrequency(index, 'auth')).toBe(1)
    // No exact posting: the substring union is below the cap, so its real
    // size is a safe document frequency.
    const expanded = makeIndex({
      auth: ['src/a.ts'],
      authenticate: ['src/b.ts'],
    })
    expect(getPostingDocumentFrequency(expanded, 'aut')).toBe(2)
  })

  test('returns undefined instead of the 4096-capped union size for frequent tokens', () => {
    const postings: Record<string, string[]> = {}
    for (let i = 0; i < 5000; i++) {
      postings[`aaa${i}`] = [`src/file${i}.ts`]
    }
    const index = makeIndex(postings)
    // The substring union for "aaa" hits MAX_POSTING_CANDIDATE_PATHS (4096);
    // reporting that truncated size as the document frequency would skew IDF,
    // so the frequency is unknown and the caller falls back to whole-corpus
    // counting (query.ts computeIdfForTokens handles undefined).
    expect(getPostingDocumentFrequency(index, 'aaa')).toBeUndefined()
  })
})
