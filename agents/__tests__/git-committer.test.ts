import { describe, expect, test } from 'bun:test'

import gitCommitter from '../git-committer/git-committer'

describe('git-committer (M5.2 resurrected)', () => {
  // Shared schema conformance checks (mirrors new-bundled-agents.test.ts)
  test('has correct id', () => {
    expect(gitCommitter.id).toBe('git-committer')
  })

  test('has a display name', () => {
    expect(typeof gitCommitter.displayName).toBe('string')
    expect(gitCommitter.displayName.length).toBeGreaterThan(0)
  })

  test('has a non-empty spawner prompt', () => {
    expect(typeof gitCommitter.spawnerPrompt).toBe('string')
    expect(gitCommitter.spawnerPrompt!.length).toBeGreaterThan(20)
  })

  test('does not include message history', () => {
    expect(gitCommitter.includeMessageHistory).toBe(false)
  })

  test('has last_message output mode', () => {
    expect(gitCommitter.outputMode).toBe('last_message')
  })

  test('has a string prompt input schema', () => {
    expect(gitCommitter.inputSchema?.prompt?.type).toBe('string')
  })

  test('exposes at least one tool', () => {
    expect((gitCommitter.toolNames ?? []).length).toBeGreaterThan(0)
  })

  test('has no spawnable agents (leaf agent)', () => {
    expect(gitCommitter.spawnableAgents ?? []).toEqual([])
  })

  test('has a non-empty system prompt', () => {
    expect(typeof gitCommitter.systemPrompt).toBe('string')
    expect(gitCommitter.systemPrompt!.length).toBeGreaterThan(20)
  })

  test('has a non-empty instructions prompt', () => {
    expect(typeof gitCommitter.instructionsPrompt).toBe('string')
    expect(gitCommitter.instructionsPrompt!.length).toBeGreaterThan(20)
  })

  test('handleSteps is serializable (function* form)', () => {
    if (!gitCommitter.handleSteps) return
    const src = gitCommitter.handleSteps.toString()
    expect(src).toMatch(/^function\*\s*\(/)
    // Must not close over top-level lexical bindings (sandbox-safe).
    expect(() => new Function(`return (${src})`)()).not.toThrow()
  })

  // git-committer specifics
  test('does not specify a model (vestigial for bundled agents)', () => {
    expect(gitCommitter.model).toBeUndefined()
  })

  test('exposes read + terminal + git tools', () => {
    const tools = gitCommitter.toolNames ?? []
    expect(tools).toContain('read_files')
    expect(tools).toContain('run_terminal_command')
    expect(tools).toContain('git_status')
    expect(tools).toContain('git_branch')
  })

  test('does not expose write/edit tools (commit only, no code changes)', () => {
    const tools = gitCommitter.toolNames ?? []
    expect(tools).not.toContain('write_file')
    expect(tools).not.toContain('str_replace')
  })

  test('instructions prompt mentions commit message', () => {
    expect(gitCommitter.instructionsPrompt!.toLowerCase()).toContain(
      'commit message',
    )
  })

  test('instructions prompt restricts pushing to explicit authorization', () => {
    expect(gitCommitter.instructionsPrompt).toMatch(
      /push only when params\.push is true/i,
    )
    expect(gitCommitter.instructionsPrompt).toMatch(/never force-push/i)
  })

  test('instructions prompt does not include an AI-attribution footer', () => {
    expect(gitCommitter.instructionsPrompt).not.toMatch(
      /Generated with Openbuff/i,
    )
    expect(gitCommitter.instructionsPrompt).not.toMatch(/Co-Authored-By/i)
    expect(gitCommitter.instructionsPrompt).not.toMatch(/🤖/u)
  })

  test('instructions prompt warns about secrets', () => {
    expect(gitCommitter.instructionsPrompt).toMatch(
      /secrets|\.env|credentials/i,
    )
  })

  // M2 (R3) — git-committer branch capability. `inputSchema.params` is a JSON Schema whose
  // `properties` value can be a boolean-schema (`true`/`false`) per the JSON-Schema spec, so
  // narrow with a type guard before indexing field metadata.
  const branchParams = gitCommitter.inputSchema?.params
  const branchProps =
    branchParams &&
    typeof branchParams === 'object' &&
    'properties' in branchParams
      ? (
          branchParams as {
            properties?: Record<string, { type?: string; default?: unknown }>
          }
        ).properties
      : undefined

  test('accepts branch_name in inputSchema.params', () => {
    expect(branchProps?.branch_name).toBeDefined()
    expect(branchProps?.branch_name?.type).toBe('string')
  })

  test('accepts branch_switch in inputSchema.params', () => {
    expect(branchProps?.branch_switch).toBeDefined()
    expect(branchProps?.branch_switch?.type).toBe('boolean')
    expect(branchProps?.branch_switch?.default).toBe(true)
  })

  test('instructions prompt mentions branch creation when branch_name is provided', () => {
    expect(gitCommitter.instructionsPrompt).toMatch(/branch_name/i)
    expect(gitCommitter.instructionsPrompt).toMatch(/git_branch/i)
  })

  test('spawnerPrompt mentions branch capability', () => {
    expect(gitCommitter.spawnerPrompt).toMatch(/branch/i)
  })

  test('spawnerPrompt names required params.owned_paths', () => {
    expect(gitCommitter.spawnerPrompt).toMatch(/params\.owned_paths/)
  })

  test('handleSteps checks status before git_branch when branch_name is provided', () => {
    if (!gitCommitter.handleSteps) return
    const gen = gitCommitter.handleSteps({
      params: { branch_name: 'feat/test-branch' },
    } as unknown as Parameters<NonNullable<typeof gitCommitter.handleSteps>>[0])
    expect(gen.next().value).toMatchObject({
      toolName: 'run_terminal_command',
      input: { command: 'git status --short --branch' },
    })
    const branchStep = gen.next({
      toolResult: [{ type: 'json', value: { stdout: '' } }],
    } as any).value
    expect(branchStep).toMatchObject({
      toolName: 'git_branch',
      input: { branch_name: 'feat/test-branch', switch: true },
    })
  })

  test('handleSteps omits git_branch step when branch_name is not provided', () => {
    if (!gitCommitter.handleSteps) return
    const gen = gitCommitter.handleSteps({
      params: { stage_all: true },
    } as unknown as Parameters<NonNullable<typeof gitCommitter.handleSteps>>[0])
    const firstStep = gen.next().value
    expect(firstStep).not.toMatchObject({ toolName: 'git_branch' })
    expect(firstStep).toMatchObject({ toolName: 'run_terminal_command' })
  })

  // Incident hardening: placeholder commit messages, policy-denial
  // reporting, and the staged-set-is-a-subset-of-owned_paths verification.
  test('instructions prompt forbids placeholder commit messages', () => {
    expect(gitCommitter.instructionsPrompt).toMatch(
      /placeholder messages? \(probe\/test\/wip/i,
    )
    expect(gitCommitter.instructionsPrompt).toMatch(/policy-rejected/i)
    expect(gitCommitter.instructionsPrompt).toMatch(
      /real imperative message derived from the actual change/i,
    )
  })

  test('instructions prompt requires verbatim reporting of policy denials and forbids workarounds', () => {
    expect(gitCommitter.instructionsPrompt).toMatch(
      /report the exact denial reason verbatim/i,
    )
    expect(gitCommitter.instructionsPrompt).toMatch(
      /never work around a denial/i,
    )
    expect(gitCommitter.instructionsPrompt).toMatch(
      /never substitute a path-scoped git commit/i,
    )
    expect(gitCommitter.instructionsPrompt).toMatch(
      /never invent a placeholder message/i,
    )
  })

  test('system prompt reinforces stop-and-report on policy denial or uncertainty', () => {
    expect(gitCommitter.systemPrompt).toMatch(/policy denial|uncertainty/i)
    expect(gitCommitter.systemPrompt).toMatch(/stop and report/i)
  })

  type CommitterSteps = ReturnType<NonNullable<typeof gitCommitter.handleSteps>>

  const feedJson = (value: Record<string, unknown>) =>
    ({ toolResult: [{ type: 'json', value }] }) as any

  // Drive the deterministic handleSteps prelude (status, branch/diff
  // inspection, git add of owned paths, whitespace check) through the staged
  // listing, feeding `stagedStdout` as the `git diff --cached --name-only`
  // output, and return the next yielded step.
  const advancePastStagedListing = (
    gen: CommitterSteps,
    ownedPaths: string[],
    stagedStdout: string,
  ): unknown => {
    expect(gen.next().value).toMatchObject({
      toolName: 'run_terminal_command',
      input: { command: 'git status --short --branch' },
    })
    let step = gen.next(feedJson({ stdout: '', exitCode: 0 })).value
    const expectedCommands = [
      'git rev-parse --show-toplevel',
      'git rev-parse --git-common-dir',
      'git branch --show-current',
      'git rev-parse --abbrev-ref --symbolic-full-name @{upstream}',
      'git diff HEAD',
      'git log --oneline -10',
      `git add -- ${ownedPaths.map((path) => JSON.stringify(path)).join(' ')}`,
      'git diff --cached --check',
      'git diff --cached --name-only',
    ]
    for (const command of expectedCommands) {
      expect(step).toMatchObject({
        toolName: 'run_terminal_command',
        input: { command },
      })
      step = gen.next(
        feedJson({
          stdout:
            command === 'git diff --cached --name-only' ? stagedStdout : '',
          exitCode: 0,
        }),
      ).value
    }
    return step
  }

  test('handleSteps unstages offending staged paths and stops instead of committing', () => {
    if (!gitCommitter.handleSteps) return
    const gen = gitCommitter.handleSteps({
      params: { owned_paths: ['src/a.ts'] },
    } as unknown as Parameters<NonNullable<typeof gitCommitter.handleSteps>>[0])
    // src/a.ts is owned; src/a.ts.bak is a sibling prefix collision (not
    // under an owned directory) and src/evil.ts is unrelated.
    let step = advancePastStagedListing(
      gen,
      ['src/a.ts'],
      'src/a.ts\nsrc/a.ts.bak\nsrc/evil.ts\n',
    )
    expect(step).toMatchObject({
      toolName: 'run_terminal_command',
      input: { command: 'git restore --staged src/a.ts.bak src/evil.ts' },
    })
    step = gen.next(feedJson({ stdout: '', exitCode: 0 })).value
    expect(step).toMatchObject({ type: 'STEP_TEXT' })
    const report = JSON.stringify(step)
    expect(report).toContain('src/a.ts.bak')
    expect(report).toContain('src/evil.ts')
    expect(report).toContain('src/a.ts')
    expect(gen.next().done).toBe(true)
  })

  test('handleSteps proceeds when every staged path is owned (directory prefix match)', () => {
    if (!gitCommitter.handleSteps) return
    const gen = gitCommitter.handleSteps({
      params: { owned_paths: ['src/'] },
    } as unknown as Parameters<NonNullable<typeof gitCommitter.handleSteps>>[0])
    let step = advancePastStagedListing(
      gen,
      ['src/'],
      'src/a.ts\nsrc/nested/b.ts\n',
    )
    expect(step).toMatchObject({
      toolName: 'run_terminal_command',
      input: { command: 'git diff --cached -U0' },
    })
    step = gen.next(feedJson({ stdout: '', exitCode: 0 })).value
    expect(step).toBe('STEP_ALL')
    expect(gen.next().done).toBe(true)
  })
})
