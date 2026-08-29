import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

import { createBase2 } from '../base2/base2'
import { isTestCoverageReviewerFinding } from '../base2/gate-reviewer'
import { createReviewer } from '../reviewer/code-reviewer'
import { createSpecialist } from '../specialists/create-specialist'
import { editReceipt } from './helpers/base2-step-fixtures'
import {
  extractInlineFunctionSource,
  findMatchingDelimiterEnd,
} from './helpers/extract-inline-function-source'

// SECURITY_SENSITIVE_* mirror the production base2 handleSteps constants that
// `selectAuxRelevantFiles` closes over. They feed the reconstructed inline
// helper preamble AND are parity-guarded against the live base2.ts source (see
// the 'SECURITY_SENSITIVE_* mirror matches production' test below), so a new
// sensitive glob/name added in base2.ts fails the test instead of silently
// using a stale mirror.
const SECURITY_SENSITIVE_GLOBS: string[] = [
  'auth',
  'oauth',
  'credentials',
  'session',
  'crypto',
  'keys',
  'secrets',
  'vault',
  'billing',
  'payment',
  'stripe',
  'permissions',
  'rbac',
  'policy',
]

const SECURITY_SENSITIVE_NAME_SUBSTRINGS: string[] = [
  'secret',
  'token',
  'apikey',
]

/**
 * Extract a top-level `const NAME = [...]` string-array literal (balanced
 * brackets) from base2.ts source so the test can parity-check its
 * SECURITY_SENSITIVE_* mirror against production.
 */
function extractStringArrayFromSource(
  source: string,
  constantName: string,
): string[] {
  const declarationStart = source.indexOf(`const ${constantName} = `)
  if (declarationStart < 0) {
    throw new Error(`Unable to find ${constantName} in base2 source`)
  }
  const bodyStart = source.indexOf('[', declarationStart)
  if (bodyStart < 0) {
    throw new Error(`Unable to find array body for ${constantName}`)
  }
  // Reuse the shared quote/comment-aware bracket-balance helper (the same
  // primitive the inline-function extraction uses) instead of re-implementing
  // a parallel walk here.
  const end = findMatchingDelimiterEnd(source, bodyStart, '[', ']')
  if (end < 0) {
    throw new Error(`Unable to find end of ${constantName} array`)
  }
  const body = source.slice(bodyStart + 1, end)
  // The naive `','` split below would silently split a quoted value that
  // itself contains a comma into two tokens, silently weakening the parity
  // guard (a future SECURITY_SENSITIVE_* glob containing a comma would be
  // observed as two separate tokens and pass even though the mirror no longer
  // matched production). Detect a comma inside a quoted string and fail
  // loudly instead, so this check can never silently weaken.
  let bodyQuote: string | null = null
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]
    if (character === '\\') {
      index += 1
      continue
    }
    if (character === '"' || character === "'") {
      bodyQuote = bodyQuote === character ? null : character
    } else if (character === ',' && bodyQuote) {
      throw new Error(
        `${constantName} value contains a comma; update extractStringArrayFromSource to a quote-delimited tokenizer`,
      )
    }
  }
  const tokens: string[] = []
  for (const raw of body.split(',')) {
    const token = raw.trim().replace(/^['"]|['"]$/g, '')
    if (token) tokens.push(token)
  }
  return tokens
}

/**
 * Build the JSON-safe preamble injected ahead of the reconstructed inline
 * helpers, derived from the named SECURITY_SENSITIVE_* constants (the same
 * values the parity test asserts against production).
 */
function buildConstantsPreamble(): string {
  const globsBody = SECURITY_SENSITIVE_GLOBS.map((glob) => `  '${glob}',`).join(
    '\n',
  )
  const substrsBody = SECURITY_SENSITIVE_NAME_SUBSTRINGS.map(
    (substr) => `'${substr}'`,
  ).join(', ')
  return `\nconst SECURITY_SENSITIVE_GLOBS = [\n${globsBody}\n];\nconst SECURITY_SENSITIVE_NAME_SUBSTRINGS = [${substrsBody}];\n`
}

type WriterTargetHelpers = {
  selectTestWriterTargets: (files: string[]) => {
    groups: Array<{
      targetFiles: string[]
      testCommand: string
      candidateTests: string[]
      packageRoot: string
    }>
  }
  selectDocWriterTargets: (files: string[]) => string[]
  selectAuxRelevantFiles: (files: string[]) => string[]
  testWriterScopePatterns: (packageRoot: string) => string[]
  docWriterScopePatterns: (sourceFiles: string[]) => string[]
  isNonTestSourceFile: (filePath: string) => boolean
  isPublicApiSourceFile: (filePath: string) => boolean
  inferPackageTestCommand: (filePath: string) => string | null
}

/**
 * Reconstruct the serialized handleSteps writer-selection helpers so tests pin
 * the live spawn predicates without exporting production internals.
 */
function loadInlineWriterTargetHelpers(): WriterTargetHelpers {
  const base2Source = readFileSync(
    new URL('../base2/base2.ts', import.meta.url),
    'utf8',
  )
  const names = [
    'normalizeGateFilePath',
    'inferPackageTestCommand',
    'isNonTestSourceFile',
    'isPublicApiSourceFile',
    'inferWorkspaceRootFromPath',
    'selectTestWriterTargets',
    'selectDocWriterTargets',
    'testWriterScopePatterns',
    'docWriterScopePatterns',
    // selectAuxRelevantFiles closes over matchesSecuritySensitiveGlob helpers.
    'isAlnumChar',
    'basenameContainsSensitiveName',
    'matchesSecuritySensitiveGlob',
    'selectAuxRelevantFiles',
  ] as const

  // SECURITY_SENSITIVE_* are local constants closed over by the inline helpers.
  // Reconstruct them from the parity-guarded named constants above so the
  // mirror stays authoritative against base2.ts.
  const constantsPreamble = buildConstantsPreamble()
  // NOTE: unlike loadInlineGateRepairHelpers (gate-repair-parity) and
  // loadProductionGateFileContentMarker (e2e), which first transpile base2.ts to
  // JS before extractInlineFunctionSource, this site extracts from the RAW TS
  // source on purpose: these writer-selection helpers are simple and TS-tolerant,
  // and the transpile-to-JS step is unnecessary here. Do not "normalize" this
  // call site to match the others without verifying it still extracts correctly.
  const helperSource = names
    .map((functionName) =>
      extractInlineFunctionSource(base2Source, functionName),
    )
    .join('\n\n')
  const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' })
  const combinedJs = transpiler.transformSync(
    `${constantsPreamble}\n${helperSource}\nreturn {\n  selectTestWriterTargets,\n  selectDocWriterTargets,\n  selectAuxRelevantFiles,\n  testWriterScopePatterns,\n  docWriterScopePatterns,\n  isNonTestSourceFile,\n  isPublicApiSourceFile,\n  inferPackageTestCommand,\n}`,
  )
  const buildHelpers = new Function(
    `"use strict";\n${combinedJs}`,
  ) as () => WriterTargetHelpers
  return buildHelpers()
}

function advanceToPostEditGitStatus(
  gen: Generator<any, any, any>,
  editedFile: string,
) {
  // Code-intent prompts may start with query_index; drain until git_status.
  let step = gen.next().value as any
  let guard = 0
  while (step?.toolName !== 'git_status' && guard++ < 8) {
    if (step?.toolName === 'query_index') {
      step = gen.next({ toolResult: [{ type: 'json', value: [] }] } as any)
        .value as any
      continue
    }
    if (step?.toolName === 'add_message') {
      step = gen.next().value as any
      continue
    }
    step = gen.next({ toolResult: [{ type: 'json', value: {} }] } as any)
      .value as any
  }
  expect(step).toMatchObject({ toolName: 'git_status' })
  expect(
    gen.next({ toolResult: [{ type: 'json', value: { status: '' } }] } as any)
      .value,
  ).toMatchObject({
    toolName: 'spawn_agent_inline',
  })
  expect(gen.next().value).toBe('STEP')
  expect(
    gen.next({
      stepsComplete: true,
      toolResult: [{ type: 'json', value: editReceipt(editedFile) }],
    } as any).value,
  ).toMatchObject({ toolName: 'git_status' })
}

describe('base2 writer spawn roster availability', () => {
  test('default implementation mode keeps editor, repair-editor, test-writer, and doc-writer spawnable', () => {
    const spawnable = createBase2('default').spawnableAgents ?? []
    for (const agent of [
      'editor',
      'repair-editor',
      'test-writer',
      'doc-writer',
    ]) {
      expect(spawnable).toContain(agent)
    }
  })

  test('fast mode drops editor/repair-editor but keeps test-writer and doc-writer', () => {
    const spawnable = createBase2('fast').spawnableAgents ?? []
    expect(spawnable).toContain('test-writer')
    expect(spawnable).toContain('doc-writer')
    expect(spawnable).not.toContain('editor')
    expect(spawnable).not.toContain('repair-editor')
  })

  test('plan mode withholds mutation writers and editors', () => {
    const spawnable =
      createBase2('default', { planOnly: true }).spawnableAgents ?? []
    for (const agent of [
      'editor',
      'repair-editor',
      'test-writer',
      'doc-writer',
    ]) {
      expect(spawnable).not.toContain(agent)
    }
  })
})

describe('base2 writer target selection predicates', () => {
  const helpers = loadInlineWriterTargetHelpers()

  test('selectTestWriterTargets groups non-test source by package test command', () => {
    const selection = helpers.selectTestWriterTargets([
      'agents/base2/base2.ts',
      'agents/__tests__/base2.test.ts',
      'docs/readme.md',
      'common/src/util/array.ts',
      'notes.txt',
    ])
    expect(selection.groups).toHaveLength(2)
    const agentsGroup = selection.groups.find((group) =>
      group.targetFiles.includes('agents/base2/base2.ts'),
    )
    const commonGroup = selection.groups.find((group) =>
      group.targetFiles.includes('common/src/util/array.ts'),
    )
    expect(agentsGroup?.testCommand).toBe(
      'cd agents && bun run typecheck && bun test',
    )
    expect(agentsGroup?.packageRoot).toBe('agents')
    expect(commonGroup?.testCommand).toBe(
      'cd common && bun run typecheck && bun test',
    )
    expect(commonGroup?.packageRoot).toBe('common')
  })

  test('selectTestWriterTargets returns no groups for empty, test-only, or non-source files', () => {
    expect(helpers.selectTestWriterTargets([]).groups).toEqual([])
    expect(
      helpers.selectTestWriterTargets([
        'agents/__tests__/base2.test.ts',
        'docs/guide.md',
        'package.json',
      ]).groups,
    ).toEqual([])
  })

  test('selectDocWriterTargets admits public API source across packages, not only one file type', () => {
    expect(
      helpers.selectDocWriterTargets([
        'agents/base2/base2.ts',
        'common/src/util/array.ts',
        'packages/agent-runtime/src/tools/edit.ts',
        'agents/__tests__/base2.test.ts',
        'docs/guide.md',
        'README.md',
      ]),
    ).toEqual([
      'agents/base2/base2.ts',
      'common/src/util/array.ts',
      'packages/agent-runtime/src/tools/edit.ts',
    ])
  })

  test('docWriterScopePatterns expands package roots so docs can update across the repo', () => {
    expect(
      helpers.docWriterScopePatterns([
        'agents/base2/base2.ts',
        'common/src/util/array.ts',
      ]),
    ).toEqual(
      expect.arrayContaining([
        'agents/docs/**',
        'agents/**/*.md',
        'common/docs/**',
        'common/**/*.md',
      ]),
    )
  })

  test('testWriterScopePatterns stays package-scoped to existing test locations', () => {
    expect(helpers.testWriterScopePatterns('agents')).toEqual([
      'agents/**/*.test.*',
      'agents/**/*.spec.*',
      'agents/**/__tests__/**',
      'agents/**/test/**',
      'agents/**/tests/**',
    ])
    expect(helpers.testWriterScopePatterns('.')).toEqual([
      '**/*.test.*',
      '**/*.spec.*',
      '**/__tests__/**',
      '**/test/**',
      '**/tests/**',
    ])
  })

  test('selectAuxRelevantFiles keeps writer outputs from re-arming aux gates forever', () => {
    expect(
      helpers.selectAuxRelevantFiles([
        'agents/base2/base2.ts',
        'agents/__tests__/base2.test.ts',
        'docs/state.md',
        'packages/sdk/src/__tests__/cache.test.ts',
      ]),
    ).toEqual(['agents/base2/base2.ts'])
  })

  test('selectAuxRelevantFiles reconstruction fails LOUDLY when a closed-over helper or constant is missing', () => {
    // selectAuxRelevantFiles closes over multiple local helpers
    // (isNonTestSourceFile / inferPackageTestCommand / isPublicApiSourceFile /
    // matchesSecuritySensitiveGlob) plus the SECURITY_SENSITIVE_* constants that
    // loadInlineWriterTargetHelpers reconstructs from its names list + preamble.
    // If production adds a NEW helper/constant reference inside
    // selectAuxRelevantFiles that is NOT added to that names list or preamble,
    // the reconstruction must throw a ReferenceError at call time (fail
    // closed) instead of silently producing wrong aux-relevance output that
    // re-arms the gate loop. Build selectAuxRelevantFiles standalone (no helper
    // closures / constants) and assert invoking it throws — pinning the
    // fail-closed guarantee.
    const base2Source = readFileSync(
      new URL('../base2/base2.ts', import.meta.url),
      'utf8',
    )
    const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' })
    const helperSource = extractInlineFunctionSource(
      base2Source,
      'selectAuxRelevantFiles',
    )
    const combinedJs = transpiler.transformSync(helperSource)
    const buildHelper = new Function(
      `"use strict";\n${combinedJs}\nreturn selectAuxRelevantFiles`,
    ) as () => (files: string[]) => string[]
    const selectAuxStandalone = buildHelper()
    expect(() => selectAuxStandalone(['agents/base2/base2.ts'])).toThrow(
      ReferenceError,
    )
  })

  test('SECURITY_SENSITIVE_* mirror matches production base2 constants', () => {
    // Parity guard: the inline-helper preamble mirrors the production
    // SECURITY_SENSITIVE_GLOBS / SECURITY_SENSITIVE_NAME_SUBSTRINGS constants
    // that selectAuxRelevantFiles closes over. If base2.ts adds a sensitive
    // glob/name, this assertion fails so the mirror is updated deliberately
    // instead of silently weakening security-sensitive aux relevance coverage.
    const base2Source = readFileSync(
      new URL('../base2/base2.ts', import.meta.url),
      'utf8',
    )
    expect(
      extractStringArrayFromSource(base2Source, 'SECURITY_SENSITIVE_GLOBS'),
    ).toEqual(SECURITY_SENSITIVE_GLOBS)
    expect(
      extractStringArrayFromSource(
        base2Source,
        'SECURITY_SENSITIVE_NAME_SUBSTRINGS',
      ),
    ).toEqual(SECURITY_SENSITIVE_NAME_SUBSTRINGS)
  })
})

describe('findMatchingDelimiterEnd line-comment-at-expression-start heuristic (pinned)', () => {
  // Pinned behavior for findMatchingDelimiterEnd, which is shared by three
  // call sites (extractInlineFunctionSource, extractStringArrayFromSource, and
  // the reviewer-spawn-conditions e2e). isRegexStart is narrowed so that `//`
  // is ALWAYS treated as the start of a line comment (a regex literal can never
  // begin with an unescaped `/`), even at an expression-start position where
  // the previous significant char is an operator/opener such as `=` or `{`.
  // Without that narrowing, a `//` comment directly after `=` would be consumed
  // as an empty regex and a `}` inside the comment text would terminate the
  // balance walk early.
  //
  // These assertions PIN the corrected behavior so a future change to the
  // regex/comment heuristic cannot silently alter the extracted slice without a
  // deliberate, reviewed update to this test. Cross-referenced from the header
  // doc comment in helpers/extract-inline-function-source.ts.
  test('a // comment directly after = is treated as a comment; the walk ends at the real closer', () => {
    // `}` at index 26 lives inside the `//` comment text. isRegexStart no longer
    // misreads `//` as a regex after `=` (a regex whose first char is '/' would
    // need to be written escaped), so the comment branch handles it and the
    // in-comment `}` is skipped. The walk reaches the real body-closing `}` at
    // the end instead of terminating early at index 26.
    const src = '{ foo = // comment with a } brace\n  bar: "x" }'
    const end = findMatchingDelimiterEnd(src, 0, '{', '}')
    expect(src[end]).toBe('}')
    // The walk must NOT terminate at the comment's `}` (index 26); it continues
    // to the final real closing brace.
    expect(end).toBe(src.lastIndexOf('}'))
    expect(end).toBeGreaterThan(26)
  })
})

describe('isRegexStart keyword-aware expression positions (pinned)', () => {
  // Pinned behavior for the keyword-aware isRegexStart check (RF-2-dae01659):
  // a regex literal directly after an expression-preceding keyword
  // (`return /{…}/`, `typeof /…/`) must be consumed as a regex literal so its
  // braces cannot terminate or unbalance the delimiter walk. The earlier
  // char-only check saw the identifier tail (`n` of `return`, `f` of `typeof`)
  // and misread the `/` as division, leaving the regex's own `}` live for the
  // balance walk.
  test('a regex directly after `return` is skipped; the walk ends at the real closer', () => {
    // Without the keyword check, the `/` after `return` would be read as
    // division and the regex's own `}` would close the walk early.
    const src = '{ x = return /}/g\n }'
    const end = findMatchingDelimiterEnd(src, 0, '{', '}')
    expect(src[end]).toBe('}')
    expect(end).toBe(src.lastIndexOf('}'))
  })

  test('a regex directly after `typeof` is skipped; the walk ends at the real closer', () => {
    const src = '{ t = typeof /{a}/g\n }'
    const end = findMatchingDelimiterEnd(src, 0, '{', '}')
    expect(src[end]).toBe('}')
    expect(end).toBe(src.lastIndexOf('}'))
  })
})

describe('base2 writer request predicates and sequential aux gates', () => {
  test('test-writer spawns only when the user prompt asks for tests', () => {
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2-custom' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Make the requested change now please',
      params: {},
      config: base2.programmaticConfig,
    } as any)

    advanceToPostEditGitStatus(gen, 'src/a.ts')
    const next = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any).value as any
    // No explicit test request -> skip inspect_environment writer path and go
    // straight to validation hooks / later gates.
    expect(next.toolName).not.toBe('inspect_environment')
    expect(next).toMatchObject({ toolName: 'run_file_change_hooks' })
  })

  test('negated test phrasing does not spawn test-writer', () => {
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2-custom' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Update the parser without tests',
      params: {},
      config: base2.programmaticConfig,
    } as any)

    advanceToPostEditGitStatus(gen, 'src/a.ts')
    const next = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any).value as any
    expect(next.toolName).not.toBe('inspect_environment')
    expect(next.toolName).not.toBe('spawn_agent_inline')
  })

  test('explicit test request spawns test-writer with package-scoped handoff', () => {
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2-custom' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Add tests for the new gate behavior',
      params: {},
      config: base2.programmaticConfig,
    } as any)

    advanceToPostEditGitStatus(gen, 'agents/base2/base2.ts')
    expect(
      gen.next({
        toolResult: [
          {
            type: 'json',
            value: { status: ' M agents/base2/base2.ts' },
          },
        ],
      } as any).value,
    ).toMatchObject({
      toolName: 'inspect_environment',
    })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: {} }] } as any).value,
    ).toMatchObject({ toolName: 'get_affected_tests' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: {} }] } as any).value,
    ).toMatchObject({ toolName: 'get_build_targets' })
    const testWriterSpawn = gen.next({
      toolResult: [{ type: 'json', value: {} }],
    } as any).value as any
    expect(testWriterSpawn).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'test-writer' },
    })
    expect(testWriterSpawn.input.params.target_files).toEqual([
      'agents/base2/base2.ts',
    ])
    expect(testWriterSpawn.input.params.test_command).toBe(
      'cd agents && bun run typecheck && bun test',
    )
    expect(testWriterSpawn.input.handoff.permissions.writablePaths).toEqual(
      expect.arrayContaining(['agents/**/*.test.*', 'agents/**/__tests__/**']),
    )
    // Inline spawn is sequential/blocking; writers are not launched via
    // spawn_agents batching that would run in parallel with each other.
    expect(testWriterSpawn.toolName).toBe('spawn_agent_inline')
  })

  test('doc request spawns doc-writer after optional test gate with multi-root write scope', () => {
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2-custom' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Document the public API for this change',
      params: {},
      config: base2.programmaticConfig,
    } as any)

    advanceToPostEditGitStatus(gen, 'common/src/util/array.ts')
    expect(
      gen.next({
        toolResult: [
          {
            type: 'json',
            value: { status: ' M common/src/util/array.ts' },
          },
        ],
      } as any).value,
    ).toMatchObject({
      toolName: 'inspect_environment',
    })
    // Docs-only request still inspects environment, but skips get_affected_tests
    // (tests gate is off). test-writer then skips silently because
    // requestRequiresTests is false, and doc-writer fires on the same iteration.
    const docWriterSpawn = gen.next({
      toolResult: [{ type: 'json', value: {} }],
    } as any).value as any
    expect(docWriterSpawn).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'doc-writer' },
    })
    expect(docWriterSpawn.input.params.source_files).toEqual([
      'common/src/util/array.ts',
    ])
    expect(docWriterSpawn.input.handoff.permissions.writablePaths).toEqual(
      expect.arrayContaining(['common/docs/**', 'common/**/*.md']),
    )
    expect(docWriterSpawn.input.handoff.permissions.readablePaths).toEqual([
      '**/*',
    ])
  })

  test('combined test+docs request runs writers sequentially, not in parallel', () => {
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2-custom' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Add tests and update documentation for the public API',
      params: {},
      config: base2.programmaticConfig,
    } as any)

    advanceToPostEditGitStatus(gen, 'agents/base2/base2.ts')
    expect(
      gen.next({
        toolResult: [
          {
            type: 'json',
            value: { status: ' M agents/base2/base2.ts' },
          },
        ],
      } as any).value,
    ).toMatchObject({
      toolName: 'inspect_environment',
    })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: {} }] } as any).value,
    ).toMatchObject({ toolName: 'get_affected_tests' })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: {} }] } as any).value,
    ).toMatchObject({ toolName: 'get_build_targets' })
    const testWriterSpawn = gen.next({
      toolResult: [{ type: 'json', value: {} }],
    } as any).value as any
    expect(testWriterSpawn).toMatchObject({
      toolName: 'spawn_agent_inline',
      input: { agent_type: 'test-writer' },
    })
    // Only one writer is active at a time: completing test-writer may open
    // basher validation, then the next writer gate, never a dual spawn_agents
    // batch of test-writer + doc-writer together.
    expect(testWriterSpawn.toolName).toBe('spawn_agent_inline')
    expect(testWriterSpawn.input.agents).toBeUndefined()
  })
})

describe('editor / repair-editor / test-writer cohesion', () => {
  test('pure coverage findings route to test-writer, not repair-editor', () => {
    expect(
      isTestCoverageReviewerFinding(
        'BLOCKING: test coverage missing for changed behavior (add a case to the relevant *.test.ts)',
      ),
    ).toBe(true)

    const base2 = createBase2('default')
    const agentState = { agentId: 'base2' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    advanceToPostEditGitStatus(gen, 'src/a.ts')
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({
      toolName: 'run_file_change_hooks',
    })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: [] }] } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const reviewCall = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any).value as any
    expect(reviewCall).toMatchObject({ toolName: 'spawn_agents' })
    const prompt = String(reviewCall.input.agents[0].prompt ?? '')
    const fingerprint =
      prompt.match(/Snapshot fingerprint \(echo exactly\): ([^\n]+)/)?.[1] ?? ''
    const afterReview = gen.next({
      toolResult: [
        {
          type: 'json',
          value: [
            {
              schemaVersion: 1,
              verdict: 'NON_BLOCKING',
              snapshotFingerprint: fingerprint,
              reviewedFiles: ['src/a.ts'],
              findings: [],
              coverage: 'missing',
              dimensions: {
                correctness: 'pass',
                security: 'pass',
                tests: 'pass',
                apiCompatibility: 'pass',
                performance: 'pass',
              },
              requirementCoverage: [],
            },
          ],
        },
      ],
    } as any)
    expect(afterReview.value).toMatchObject({
      toolName: 'add_message',
      input: { role: 'user' },
    })
    const repairSpawn = gen.next().value as any
    expect(repairSpawn).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'test-writer' }] },
    })
    expect(repairSpawn.input.agents).toHaveLength(1)
    expect(repairSpawn.input.agents[0].agent_type).not.toBe('repair-editor')
  })

  test('mixed code + coverage findings keep repair-editor only (no parallel test-writer)', () => {
    const base2 = createBase2('default')
    const agentState = { agentId: 'base2' }
    const gen = base2.handleSteps!({
      agentState,
      prompt: 'Make the requested change now please',
      params: {},
    } as any)

    advanceToPostEditGitStatus(gen, 'src/a.ts')
    expect(
      gen.next({
        toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
      } as any).value,
    ).toMatchObject({
      toolName: 'run_file_change_hooks',
    })
    expect(
      gen.next({ toolResult: [{ type: 'json', value: [] }] } as any).value,
    ).toMatchObject({ toolName: 'git_status' })
    const reviewCall = gen.next({
      toolResult: [{ type: 'json', value: { status: ' M src/a.ts' } }],
    } as any).value as any
    const prompt = String(reviewCall.input.agents[0].prompt ?? '')
    const fingerprint =
      prompt.match(/Snapshot fingerprint \(echo exactly\): ([^\n]+)/)?.[1] ?? ''
    gen.next({
      toolResult: [
        {
          type: 'json',
          value: [
            {
              schemaVersion: 1,
              verdict: 'BLOCKING',
              snapshotFingerprint: fingerprint,
              reviewedFiles: ['src/a.ts'],
              findings: ['Fix the edge case.'],
              coverage: 'missing',
              dimensions: {
                correctness: 'pass',
                security: 'pass',
                tests: 'pass',
                apiCompatibility: 'pass',
                performance: 'pass',
              },
              requirementCoverage: [],
            },
          ],
        },
      ],
    } as any)
    const repairSpawn = gen.next().value as any
    expect(repairSpawn).toMatchObject({
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'repair-editor' }] },
    })
    expect(repairSpawn.input.agents).toHaveLength(1)
    expect(
      repairSpawn.input.agents.some(
        (agent: { agent_type?: string }) => agent.agent_type === 'test-writer',
      ),
    ).toBe(false)
  })

  test('code-reviewer may run in parallel with validation but cannot observe it unless results are included', () => {
    const reviewer = createReviewer('anthropic/claude-opus-4.7')
    expect(reviewer.instructionsPrompt).toContain(
      'Validation and other subagent work may be running in parallel',
    )
    expect(reviewer.instructionsPrompt).toContain(
      'You cannot observe results from parallel agents unless the prompt explicitly includes those completed results',
    )
    expect(reviewer.spawnableAgents).toEqual([])
    expect(reviewer.toolNames).toEqual(['read_files', 'set_output'])
  })

  test('createSpecialist agents never spawn editor/repair-editor/test-writer children', () => {
    const specialist = createSpecialist({
      id: 'dependency-reviewer',
      displayName: 'Dependency Reviewer',
      purpose: 'Review dependency and lockfile correctness.',
      focus: ['Manifest and lockfile correctness'],
    })
    expect(specialist.spawnableAgents).toEqual([])
    expect(specialist.toolNames).not.toContain('spawn_agents')
    expect(specialist.toolNames).not.toContain('spawn_agent_inline')
    expect(specialist.toolNames).toContain('set_output')
  })

  test('non-advisory createSpecialist requires attestable v3 snapshot_id pattern', () => {
    const specialist = createSpecialist({
      id: 'compatibility-reviewer',
      displayName: 'Compatibility Reviewer',
      purpose: 'Review API and contract compatibility.',
      focus: ['API compatibility'],
    })
    expect(specialist.inputSchema).toBeDefined()
    const paramsSchema = specialist.inputSchema!.params as {
      properties?: {
        snapshot_id?: { type?: string; pattern?: string }
      }
      required?: string[]
    }
    expect(paramsSchema.properties?.snapshot_id?.pattern).toBe(
      '^v3:[a-f0-9]{64}$',
    )
    expect(paramsSchema.required).toContain('snapshot_id')
  })
})
