import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

import { shouldAbsorbGitStatusFile } from '../base2/gate-concurrency'
import {
  creditSelfMutatedPathValue,
  publishSelfMutatedPaths,
} from '../../packages/agent-runtime/src/run-agent-step'
import type { AgentState } from '@codebuff/common/types/session-state'
import type { ToolMessage } from '@codebuff/common/types/messages/codebuff-message'

describe('shouldAbsorbGitStatusFile', () => {
  const base = {
    initialGitStatusFiles: [] as string[],
    gatePassedFiles: new Set<string>(),
    taskRelatedFiles: new Set<string>(),
  }

  test('excludes foreign dirty file (not task-related, no selfMutated)', () => {
    expect(
      shouldAbsorbGitStatusFile({
        ...base,
        file: 'foreign/other.ts',
      }),
    ).toBe(false)
  })

  test('includes task-related file', () => {
    expect(
      shouldAbsorbGitStatusFile({
        ...base,
        file: 'src/task.ts',
        taskRelatedFiles: new Set(['src/task.ts']),
      }),
    ).toBe(true)
  })

  test('excludes foreign dirty even when a terminal mutation step would have been true', () => {
    // Terminal/basher mutation no longer credits absorb on its own; foreign
    // dirty stays excluded unless task-related or selfMutatedPaths.
    expect(
      shouldAbsorbGitStatusFile({
        ...base,
        file: 'generated/out.ts',
      }),
    ).toBe(false)
  })

  test('includes selfMutatedPaths hit', () => {
    expect(
      shouldAbsorbGitStatusFile({
        ...base,
        file: 'broker/owned.ts',
        selfMutatedPaths: new Set(['broker/owned.ts']),
      }),
    ).toBe(true)
  })

  test('includes selfMutatedPaths published as string[] (runtime shape)', () => {
    // Runtime stores JSON-safe string[]; base2 normalizes to Set before has().
    const published = ['broker/owned.ts']
    expect(
      shouldAbsorbGitStatusFile({
        ...base,
        file: 'broker/owned.ts',
        selfMutatedPaths: new Set(published),
      }),
    ).toBe(true)
  })

  test('excludes already gate-passed and initial dirty files', () => {
    expect(
      shouldAbsorbGitStatusFile({
        ...base,
        file: 'src/initial.ts',
        initialGitStatusFiles: ['src/initial.ts'],
        taskRelatedFiles: new Set(['src/initial.ts']),
      }),
    ).toBe(false)

    expect(
      shouldAbsorbGitStatusFile({
        ...base,
        file: 'src/passed.ts',
        gatePassedFiles: new Set(['src/passed.ts']),
        taskRelatedFiles: new Set(['src/passed.ts']),
      }),
    ).toBe(false)
  })
})

function extractInlineFunctionSource(
  source: string,
  functionName: string,
): string {
  // Prefer a precise match so we know where the params `(` starts; fall back
  // to a looser indexOf for the common unspaced form used in production.
  const declarationMatch = source.match(
    new RegExp(`function\\s+${functionName}\\s*\\(`),
  )
  let declarationStart: number
  let paramsOpenIndex: number
  if (declarationMatch && declarationMatch.index !== undefined) {
    declarationStart = declarationMatch.index
    paramsOpenIndex = declarationStart + declarationMatch[0].length - 1
  } else {
    declarationStart = source.indexOf(`function ${functionName}(`)
    if (declarationStart < 0) {
      throw new Error(`Unable to find inline ${functionName} declaration`)
    }
    paramsOpenIndex = declarationStart + `function ${functionName}(`.length - 1
  }

  // Close the parameter list with paren depth only — braces inside object
  // param types (e.g. `params: { file: string }`) must not be treated as body.
  let parenDepth = 0
  let paramsCloseIndex = -1
  for (let index = paramsOpenIndex; index < source.length; index += 1) {
    const character = source[index]
    if (character === '(') parenDepth += 1
    if (character === ')') {
      parenDepth -= 1
      if (parenDepth === 0) {
        paramsCloseIndex = index
        break
      }
    }
  }
  if (paramsCloseIndex < 0) {
    throw new Error(`Unable to find end of inline ${functionName} params`)
  }

  let index = paramsCloseIndex + 1
  while (index < source.length && /\s/.test(source[index]!)) {
    index += 1
  }

  // Optional return type: skip until the body `{` while nested depths are 0.
  if (source[index] === ':') {
    index += 1
    let braceDepth = 0
    let returnParenDepth = 0
    let angleDepth = 0
    let bodyStart = -1
    for (; index < source.length; index += 1) {
      const character = source[index]
      if (character === '{') {
        if (braceDepth === 0 && returnParenDepth === 0 && angleDepth === 0) {
          bodyStart = index
          break
        }
        braceDepth += 1
      } else if (character === '}') {
        braceDepth -= 1
      } else if (character === '(') {
        returnParenDepth += 1
      } else if (character === ')') {
        returnParenDepth -= 1
      } else if (character === '<') {
        angleDepth += 1
      } else if (character === '>') {
        angleDepth -= 1
      }
    }
    if (bodyStart < 0) {
      throw new Error(`Unable to find inline ${functionName} body`)
    }
    index = bodyStart
  } else {
    while (index < source.length && /\s/.test(source[index]!)) {
      index += 1
    }
    if (source[index] !== '{') {
      throw new Error(`Unable to find inline ${functionName} body`)
    }
  }

  const bodyStart = index
  let depth = 0
  for (let bodyIndex = bodyStart; bodyIndex < source.length; bodyIndex += 1) {
    const character = source[bodyIndex]
    if (character === '{') depth += 1
    if (character === '}') depth -= 1
    if (depth === 0) {
      return source.slice(declarationStart, bodyIndex + 1)
    }
  }

  throw new Error(`Unable to find end of inline ${functionName} declaration`)
}

type ShouldAbsorbFn = typeof shouldAbsorbGitStatusFile

function loadInlineShouldAbsorbGitStatusFile(): ShouldAbsorbFn {
  const base2Source = readFileSync(
    new URL('../base2/base2.ts', import.meta.url),
    'utf8',
  )
  const helperSource = extractInlineFunctionSource(
    base2Source,
    'shouldAbsorbGitStatusFile',
  )
  const transpiler = new Bun.Transpiler({ loader: 'ts' })
  const helperJavaScript = transpiler.transformSync(helperSource)
  const buildHelper = new Function(
    `"use strict";\n${helperJavaScript}\nreturn shouldAbsorbGitStatusFile`,
  ) as () => ShouldAbsorbFn
  return buildHelper()
}

describe('runtime publishes selfMutatedPaths for concurrent isolation', () => {
  test('publishSelfMutatedPaths credits confirmed file_mutation_result paths', () => {
    const agentState = {
      selfMutatedPaths: ['already/owned.ts'],
    } as AgentState
    const authorityReceipt = {
      kind: 'commit_receipt' as const,
      version: 1 as const,
      receiptId: 'receipt-1',
      operationId: 'op-1',
      callId: 'call-1',
      authorityTier: 'portable_path' as const,
      status: 'committed' as const,
      actions: [
        {
          actionId: 'a1',
          index: 0,
          action: 'update' as const,
          path: 'broker/owned.ts',
          status: 'committed' as const,
          beforeHash: 'sha256:before',
          afterHash: 'sha256:after',
        },
      ],
      finalHashes: { 'broker/owned.ts': 'sha256:after' },
    }
    const mutation = {
      kind: 'file_mutation_result',
      version: 1,
      operationId: 'op-1',
      outcome: 'applied',
      authorityTier: 'portable_path',
      receiptId: 'receipt-1',
      authorityReceipt,
      actions: [
        {
          actionId: 'a1',
          index: 0,
          action: 'update',
          path: 'broker/owned.ts',
          outcome: 'applied',
          beforeHash: 'sha256:before',
          afterHash: 'sha256:after',
        },
      ],
      errors: [],
      freshCapabilities: [],
    }
    const toolResults = [
      {
        role: 'tool',
        toolName: 'write_file',
        toolCallId: 'tc-1',
        content: [
          {
            type: 'json',
            value: mutation,
          },
        ],
      } as unknown as ToolMessage,
    ]

    const published = publishSelfMutatedPaths({ agentState, toolResults })
    expect(published).toContain('already/owned.ts')
    expect(published).toContain('broker/owned.ts')
    expect(agentState.selfMutatedPaths).toEqual(published)

    // Isolation consumer credits the published path.
    expect(
      shouldAbsorbGitStatusFile({
        file: 'broker/owned.ts',
        initialGitStatusFiles: [],
        gatePassedFiles: new Set(),
        taskRelatedFiles: new Set(),
        selfMutatedPaths: new Set(published),
      }),
    ).toBe(true)
    expect(
      shouldAbsorbGitStatusFile({
        file: 'foreign/other.ts',
        initialGitStatusFiles: [],
        gatePassedFiles: new Set(),
        taskRelatedFiles: new Set(),
        selfMutatedPaths: new Set(published),
      }),
    ).toBe(false)
  })

  test('publishSelfMutatedPaths credits agent receipt changedFiles', () => {
    const agentState = {} as AgentState
    const toolResults = [
      {
        role: 'tool',
        toolName: 'spawn_agents',
        toolCallId: 'tc-spawn',
        content: [
          {
            type: 'json',
            value: {
              agentReceipt: {
                schemaVersion: 1,
                receiptId: 'receipt-1',
                changedFiles: [{ path: 'editor/batch.ts' }, 'editor/other.ts'],
              },
            },
          },
        ],
      } as unknown as ToolMessage,
    ]

    const published = publishSelfMutatedPaths({ agentState, toolResults })
    expect(published).toContain('editor/batch.ts')
    expect(published).toContain('editor/other.ts')
  })

  test('publishSelfMutatedPaths credits touchedPaths from run_terminal_command', () => {
    const agentState = {} as AgentState
    const windowsStylePath = ['pkg', 'nested.ts'].join('\\')
    const toolResults = [
      {
        role: 'tool',
        toolName: 'run_terminal_command',
        toolCallId: 'tc-term',
        content: [
          {
            type: 'json',
            value: {
              command: 'printf x > generated/out.ts',
              stdout: '',
              exitCode: 0,
              touchedPaths: ['generated/out.ts', windowsStylePath],
            },
          },
        ],
      } as unknown as ToolMessage,
    ]

    const published = publishSelfMutatedPaths({ agentState, toolResults })
    expect(published).toContain('generated/out.ts')
    // Backslash → slash normalization matches addPath.
    expect(published).toContain('pkg/nested.ts')

    expect(
      shouldAbsorbGitStatusFile({
        file: 'generated/out.ts',
        initialGitStatusFiles: [],
        gatePassedFiles: new Set(),
        taskRelatedFiles: new Set(),
        selfMutatedPaths: new Set(published),
      }),
    ).toBe(true)
    expect(
      shouldAbsorbGitStatusFile({
        file: 'foreign/other.ts',
        initialGitStatusFiles: [],
        gatePassedFiles: new Set(),
        taskRelatedFiles: new Set(),
        selfMutatedPaths: new Set(published),
      }),
    ).toBe(false)
  })

  test('publishSelfMutatedPaths credits check_job settlement touchedPaths', () => {
    // BACKGROUND settlement emits the same plain.touchedPaths field; the
    // publisher walks any tool result with that shape — no special casing.
    const agentState = {} as AgentState
    const toolResults = [
      {
        role: 'tool',
        toolName: 'check_job',
        toolCallId: 'tc-check',
        content: [
          {
            type: 'json',
            value: {
              jobId: 'job-1',
              state: 'completed',
              events: [],
              nextCursor: 1,
              truncated: false,
              dropped: 0,
              exitCode: 0,
              touchedPaths: ['bg/codegen.ts', 'bg/fmt.ts'],
            },
          },
        ],
      } as unknown as ToolMessage,
    ]

    const published = publishSelfMutatedPaths({ agentState, toolResults })
    expect(published).toContain('bg/codegen.ts')
    expect(published).toContain('bg/fmt.ts')

    expect(
      shouldAbsorbGitStatusFile({
        file: 'bg/codegen.ts',
        initialGitStatusFiles: [],
        gatePassedFiles: new Set(),
        taskRelatedFiles: new Set(),
        selfMutatedPaths: new Set(published),
      }),
    ).toBe(true)
    expect(
      shouldAbsorbGitStatusFile({
        file: 'foreign/other.ts',
        initialGitStatusFiles: [],
        gatePassedFiles: new Set(),
        taskRelatedFiles: new Set(),
        selfMutatedPaths: new Set(published),
      }),
    ).toBe(false)
  })

  test('publishSelfMutatedPaths re-visits a shared payload object once per payload', () => {
    // Regression pin for performance-specialist finding
    // single-visited-set-shared-across-results: the visited set must reset
    // between tool results. The SAME object appears in both results below; the
    // first wraps it too deep for the depth>8 budget to reach its inner
    // touchedPaths, and only the second (shallow) appearance can credit them.
    // A step-global visited set would skip the shallow re-visit and silently
    // lose the deep path.
    const agentState = {} as AgentState
    const shared = {
      touchedPaths: ['shallow/shared.ts'],
      level1: {
        level2: {
          level3: {
            level4: {
              level5: {
                touchedPaths: ['deep/only-via-shallow.ts'],
              },
            },
          },
        },
      },
    }
    const toolResults = [
      {
        role: 'tool',
        toolName: 'check_job',
        toolCallId: 'tc-deep-wrap',
        content: [{ type: 'json', value: { w1: { w2: { w3: shared } } } }],
      } as unknown as ToolMessage,
      {
        role: 'tool',
        toolName: 'check_job',
        toolCallId: 'tc-shallow',
        content: [{ type: 'json', value: shared }],
      } as unknown as ToolMessage,
    ]

    const published = publishSelfMutatedPaths({ agentState, toolResults })
    expect(published).toContain('shallow/shared.ts')
    expect(published).toContain('deep/only-via-shallow.ts')
  })

  test('publishSelfMutatedPaths terminates on an object-array cycle and credits its paths', () => {
    // Bound + parity pin for performance-specialist finding
    // single-visited-set-shared-across-results (breadth clause). The payload
    // below is an object→array→object cycle: the depth-aware memo must cover
    // ARRAY identity as well as object identity (arrays are objects), so the
    // walk terminates with each cycle path credited exactly once instead of
    // re-walking the shared array once per path.
    const agentState = {} as AgentState
    const loop: unknown[] = []
    const nodeA = { touchedPaths: ['cycle/a.ts'], next: loop }
    const nodeB = { touchedPaths: ['cycle/b.ts'], next: loop }
    loop.push(nodeA, nodeB, loop)
    const toolResults = [
      {
        role: 'tool',
        toolName: 'check_job',
        toolCallId: 'tc-cycle',
        content: [{ type: 'json', value: nodeA }],
      } as unknown as ToolMessage,
    ]

    const published = publishSelfMutatedPaths({ agentState, toolResults })
    expect(published).toContain('cycle/a.ts')
    expect(published).toContain('cycle/b.ts')
  })

  test('publishSelfMutatedPaths re-walks a shared subgraph reached shallower within one payload', () => {
    // Regression pin for performance-specialist finding
    // single-visited-set-shared-across-results (within-payload class). A plain
    // visited Set walks `shared` first through the DEEP branch (depth 8, where
    // its `inner` child sits at depth 9 and is pruned by the budget), then
    // silently skips the SHALLOW branch's reach at depth 3 — losing
    // shared/inner.ts. The depth-aware memo re-walks on the shallower reach and
    // credits it, matching the unguarded walk's collected set exactly. This is
    // also the bound test the finding asks for: the diamond terminates with
    // both reaches collected instead of one being silently dropped.
    const agentState = {} as AgentState
    const shared = {
      touchedPaths: ['shared/root.ts'],
      inner: {
        touchedPaths: ['shared/inner.ts'],
      },
    }
    const toolResults = [
      {
        role: 'tool',
        toolName: 'check_job',
        toolCallId: 'tc-diamond',
        content: [
          {
            type: 'json',
            value: {
              // Insertion order puts the deep branch first, so `shared`'s
              // initial reach is the pruned one — the exact interleaving that
              // under-collects with a plain visited Set.
              deep: { d1: { d2: { d3: { d4: { d5: shared } } } } },
              shallow: shared,
            },
          },
        ],
      } as unknown as ToolMessage,
    ]

    const published = publishSelfMutatedPaths({ agentState, toolResults })
    expect(published).toContain('shared/root.ts')
    expect(published).toContain('shared/inner.ts')
  })

  test('creditSelfMutatedPathValue shares the crediting layer with publishSelfMutatedPaths (CASE 5 like-for-like seam)', () => {
    // Regression pin for case5-asymmetric-speedup-ratio / RF-8: the CASE 5
    // before mirror in scripts/measure-perf-guards-baseline.ts runs this
    // shipped crediting layer (path validation, mutation-signal collection,
    // Set/sort publish), so both rows credit identical work and only the
    // traversal guard differs. Pinned here as parity with the publisher on the
    // same node.
    const node = {
      touchedPaths: [
        'gen/out.ts',
        ['pkg', 'nested.ts'].join('\\'),
        '/abs/bad.ts',
        ['..', 'escape.ts'].join('/'),
      ],
      changedFiles: [{ path: 'editor/batch.ts' }, 'editor/other.ts'],
    }
    const credited = new Set<string>()
    creditSelfMutatedPathValue(credited, node)

    const published = publishSelfMutatedPaths({
      agentState: {} as AgentState,
      toolResults: [
        {
          role: 'tool',
          toolName: 'check_job',
          toolCallId: 'tc-seam',
          content: [{ type: 'json', value: node }],
        } as unknown as ToolMessage,
      ],
    })

    expect([...credited].sort()).toEqual(published)
    expect(published).toEqual([
      'editor/batch.ts',
      'editor/other.ts',
      'gen/out.ts',
      'pkg/nested.ts',
    ])
  })

  test('run-agent-step wires publishSelfMutatedPaths after processStream', () => {
    const source = readFileSync(
      new URL(
        '../../packages/agent-runtime/src/run-agent-step.ts',
        import.meta.url,
      ),
      'utf8',
    )
    expect(source).toContain('export function publishSelfMutatedPaths')
    expect(source).toContain('publishSelfMutatedPaths({')
    expect(source).toContain('toolResults: newToolResults')
  })
})

describe('shouldAbsorbGitStatusFile — inline base2 copy matches export', () => {
  const base2Source = readFileSync(
    new URL('../base2/base2.ts', import.meta.url),
    'utf8',
  )

  test('base2 declares and calls the named shouldAbsorbGitStatusFile helper', () => {
    expect(base2Source).toContain('function shouldAbsorbGitStatusFile(')
    expect(base2Source).toContain('shouldAbsorbGitStatusFile({')
  })

  test('parity matrix: inline extract === module export', () => {
    const inline = loadInlineShouldAbsorbGitStatusFile()
    const cases: Array<Parameters<ShouldAbsorbFn>[0]> = [
      {
        file: 'foreign/other.ts',
        initialGitStatusFiles: [],
        gatePassedFiles: new Set(),
        taskRelatedFiles: new Set(),
      },
      {
        file: 'src/task.ts',
        initialGitStatusFiles: [],
        gatePassedFiles: new Set(),
        taskRelatedFiles: new Set(['src/task.ts']),
      },
      {
        // Foreign dirty is excluded even without a terminal-mutation credit path.
        file: 'generated/out.ts',
        initialGitStatusFiles: [],
        gatePassedFiles: new Set(),
        taskRelatedFiles: new Set(),
      },
      {
        file: 'broker/owned.ts',
        initialGitStatusFiles: [],
        gatePassedFiles: new Set(),
        taskRelatedFiles: new Set(),
        selfMutatedPaths: new Set(['broker/owned.ts']),
      },
      {
        file: 'src/initial.ts',
        initialGitStatusFiles: ['src/initial.ts'],
        gatePassedFiles: new Set(),
        taskRelatedFiles: new Set(['src/initial.ts']),
      },
      {
        file: 'src/passed.ts',
        initialGitStatusFiles: [],
        gatePassedFiles: new Set(['src/passed.ts']),
        taskRelatedFiles: new Set(['src/passed.ts']),
      },
    ]

    for (const params of cases) {
      expect(inline(params)).toBe(shouldAbsorbGitStatusFile(params))
    }
  })
})
