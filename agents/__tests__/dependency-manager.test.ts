import { describe, expect, test } from 'bun:test'

import dependencyManager from '../dependency-manager/dependency-manager'

const environmentResult = (value: Record<string, unknown>) => ({
  toolResult: [{ type: 'json' as const, value: value as never }],
  agentState: {} as never,
  stepsComplete: false,
})

const terminalResult = (value: Record<string, unknown>) => ({
  toolResult: [{ type: 'json' as const, value: value as never }],
  agentState: {} as never,
  stepsComplete: false,
})

/** A programmatic tool result carrying a single canonical json part. */
const jsonToolResult = (value: Record<string, unknown>) => ({
  toolResult: [{ type: 'json' as const, value: value as never }],
  agentState: {} as never,
  stepsComplete: false,
})

function advancePastSnapshotRead(
  generator: Generator,
  environment: Record<string, unknown>,
) {
  let next = generator.next(environmentResult(environment))
  if ((next.value as any)?.toolName === 'read_files') {
    const paths = (next.value as any).input.paths as string[]
    next = generator.next({
      toolResult: [
        {
          type: 'json',
          value: paths.map((path) => ({ path, content: `snapshot:${path}` })),
        },
      ],
      agentState: {} as never,
      stepsComplete: false,
    })
  }
  return next
}

describe('dependency-manager', () => {
  test('uses constrained dependency mutation plus hidden environment inspection', () => {
    expect(dependencyManager.terminalPermissionProfile).toBe(
      'dependency-mutation',
    )
    expect(dependencyManager.toolNames).toEqual([
      'run_terminal_command',
      'read_files',
      'write_file',
    ])
    expect(dependencyManager.programmaticToolNames).toEqual([
      'inspect_environment',
      'read_files',
      'write_file',
      'edit_transaction',
      'set_output',
    ])
  })

  test.each([
    [
      {
        manager: 'npm',
        operation: 'add',
        packages: ['prom-client'],
        workspace: 'server',
      },
      { packageManager: 'npm', manifests: ['package.json'] },
      "npm install -w 'server' 'prom-client'",
    ],
    [
      {
        manager: 'pnpm',
        operation: 'add',
        packages: ['prom-client'],
        workspace: 'server',
      },
      { packageManager: 'pnpm', manifests: ['package.json'] },
      "pnpm --filter 'server' add 'prom-client'",
    ],
    [
      { manager: 'uv', operation: 'sync' },
      { manifests: ['pyproject.toml'] },
      'uv sync',
    ],
    [
      { manager: 'cargo', operation: 'add', packages: ['serde'] },
      { manifests: ['Cargo.toml'] },
      "cargo add 'serde'",
    ],
    [
      { manager: 'go', operation: 'sync' },
      { manifests: ['go.mod'] },
      'go mod tidy',
    ],
    [
      { manager: 'composer', operation: 'add', packages: ['vendor/pkg'] },
      { manifests: [] },
      "composer require 'vendor/pkg'",
    ],
    [
      { manager: 'swift', operation: 'restore' },
      { manifests: ['Package.swift'] },
      'swift package resolve',
    ],
    [
      { manager: 'flutter', operation: 'add', packages: ['http'] },
      { manifests: [] },
      "flutter pub add 'http'",
    ],
    [{ manager: 'mix', operation: 'sync' }, { manifests: [] }, 'mix deps.get'],
    [
      { manager: 'maven', operation: 'restore' },
      { manifests: ['pom.xml'] },
      'mvn dependency:resolve',
    ],
    [
      { manager: 'gradle', operation: 'restore' },
      { manifests: ['build.gradle'] },
      './gradlew dependencies',
    ],
  ])('constructs a bounded command for %o', (params, environment, expected) => {
    const generator = dependencyManager.handleSteps!({
      agentState: {} as never,
      params,
      logger: {} as never,
    })
    expect(generator.next().value).toMatchObject({
      toolName: 'inspect_environment',
    })
    expect(advancePastSnapshotRead(generator, environment).value).toMatchObject(
      {
        toolName: 'run_terminal_command',
        input: { command: expected, timeout_seconds: 600 },
      },
    )
  })

  test('rejects unsupported manager-operation pairs without running a command', () => {
    const generator = dependencyManager.handleSteps!({
      agentState: {} as never,
      params: { manager: 'maven', operation: 'add', packages: ['example'] },
      logger: {} as never,
    })
    expect(generator.next().value).toMatchObject({
      toolName: 'set_output',
      input: {
        data: {
          status: 'unsupported',
          manager: 'maven',
          operation: 'add',
          supportedOperations: ['sync', 'restore'],
        },
      },
    })
  })

  test('rejects package-manager flags disguised as package names', () => {
    const generator = dependencyManager.handleSteps!({
      agentState: {} as never,
      params: {
        manager: 'npm',
        operation: 'add',
        packages: ['--ignore-scripts'],
      },
      logger: {} as never,
    })
    expect(generator.next().value).toMatchObject({
      toolName: 'set_output',
      input: { data: { status: 'invalid' } },
    })
  })

  test('refuses a selected manager that conflicts with repository evidence', () => {
    const generator = dependencyManager.handleSteps!({
      agentState: {} as never,
      params: { manager: 'npm', operation: 'sync' },
      logger: {} as never,
    })
    generator.next()
    expect(
      advancePastSnapshotRead(generator, {
        packageManager: 'pnpm',
        manifests: ['package.json'],
      }).value,
    ).toMatchObject({
      toolName: 'set_output',
      input: {
        data: { status: 'invalid', detectedManager: 'pnpm' },
      },
    })
  })

  test('does not confuse a JavaScript root manager with a nested non-JavaScript ecosystem', () => {
    const generator = dependencyManager.handleSteps!({
      agentState: {} as never,
      params: { manager: 'cargo', operation: 'sync', cwd: 'crates/core' },
      logger: {} as never,
    })
    generator.next()
    expect(
      advancePastSnapshotRead(generator, {
        packageManager: 'pnpm',
        manifests: ['package.json', 'Cargo.toml'],
      }).value,
    ).toMatchObject({
      toolName: 'run_terminal_command',
      input: { command: 'cargo fetch', cwd: 'crates/core' },
    })
  })

  test('returns structured failure and honors a bounded timeout', () => {
    const generator = dependencyManager.handleSteps!({
      agentState: {} as never,
      params: {
        manager: 'npm',
        operation: 'sync',
        timeout_seconds: 30,
      },
      logger: {} as never,
    })
    generator.next()
    expect(
      advancePastSnapshotRead(generator, {
        packageManager: 'npm',
        manifests: ['package.json'],
      }).value,
    ).toMatchObject({
      toolName: 'run_terminal_command',
      input: { timeout_seconds: 30 },
    })
    expect(
      generator.next(
        terminalResult({ exitCode: 1, stderr: 'registry unavailable' }),
      ).value,
    ).toMatchObject({ toolName: 'write_file' })
    expect(generator.next({ toolResult: [] } as any).value).toMatchObject({
      toolName: 'inspect_environment',
    })
    expect(
      generator.next(environmentResult({ lockfiles: [] })).value,
    ).toMatchObject({
      toolName: 'set_output',
      input: {
        data: {
          status: 'failed',
          rollbackRequired: false,
          rollbackReceipt: { status: 'rolled_back' },
        },
      },
    })
  })

  test('deletes lockfiles created by a failed command during rollback', () => {
    const generator = dependencyManager.handleSteps!({
      agentState: {} as never,
      params: { manager: 'npm', operation: 'sync' },
      logger: {} as never,
    })
    generator.next()
    expect(
      advancePastSnapshotRead(generator, {
        packageManager: 'npm',
        manifests: ['package.json'],
      }).value,
    ).toMatchObject({ toolName: 'run_terminal_command' })
    expect(
      generator.next(
        terminalResult({ exitCode: 1, stderr: 'registry unavailable' }),
      ).value,
    ).toMatchObject({ toolName: 'write_file' })
    expect(generator.next({ toolResult: [] } as any).value).toMatchObject({
      toolName: 'inspect_environment',
    })
    // The created lockfile must be read before edit_transaction can delete it:
    // strict read-before-edit refuses deletes on never-read paths.
    expect(
      generator.next(environmentResult({ lockfiles: ['package-lock.json'] }))
        .value,
    ).toMatchObject({
      toolName: 'read_files',
      input: { paths: ['package-lock.json'] },
    })
    expect(
      generator.next({
        toolResult: [
          {
            type: 'json',
            value: [
              { path: 'package-lock.json', content: 'created', complete: true },
            ],
          },
        ],
        agentState: {} as never,
        stepsComplete: false,
      } as any).value,
    ).toMatchObject({
      toolName: 'edit_transaction',
      input: { edits: [{ path: 'package-lock.json', type: 'delete' }] },
    })
    // Only a canonical `file_mutation_result` whose `delete` action for this
    // exact path applied proves the deletion; an empty result would not.
    expect(
      generator.next(
        jsonToolResult({
          kind: 'file_mutation_result',
          version: 1,
          outcome: 'applied',
          actions: [
            {
              action: 'delete',
              path: 'package-lock.json',
              outcome: 'applied',
            },
          ],
        }) as any,
      ).value,
    ).toMatchObject({
      toolName: 'set_output',
      input: {
        data: {
          // v2 receipts report applied deletes only, with the remainder in
          // `undeletedCreatedFiles`.
          schemaVersion: 2,
          status: 'failed',
          rollbackRequired: false,
          rollbackReceipt: {
            schemaVersion: 2,
            status: 'rolled_back',
            deletedCreatedFiles: ['package-lock.json'],
            undeletedCreatedFiles: [],
          },
        },
      },
    })
  })

  test('does not claim a deletion when edit_transaction refused the delete', () => {
    const generator = dependencyManager.handleSteps!({
      agentState: {} as never,
      params: { manager: 'npm', operation: 'sync' },
      logger: {} as never,
    })
    generator.next()
    expect(
      advancePastSnapshotRead(generator, {
        packageManager: 'npm',
        manifests: ['package.json'],
      }).value,
    ).toMatchObject({ toolName: 'run_terminal_command' })
    expect(
      generator.next(
        terminalResult({ exitCode: 1, stderr: 'registry unavailable' }),
      ).value,
    ).toMatchObject({ toolName: 'write_file' })
    expect(generator.next({ toolResult: [] } as any).value).toMatchObject({
      toolName: 'inspect_environment',
    })
    expect(
      generator.next(environmentResult({ lockfiles: ['package-lock.json'] }))
        .value,
    ).toMatchObject({
      toolName: 'read_files',
      input: { paths: ['package-lock.json'] },
    })
    expect(
      generator.next({
        toolResult: [
          {
            type: 'json',
            value: [
              { path: 'package-lock.json', content: 'created', complete: true },
            ],
          },
        ],
        agentState: {} as never,
        stepsComplete: false,
      } as any).value,
    ).toMatchObject({
      toolName: 'edit_transaction',
      input: { edits: [{ path: 'package-lock.json', type: 'delete' }] },
    })
    // A native v1 failure carries its message at `error.message` and has no
    // `errorMessage` key anywhere, so substring-matching the serialized result
    // used to record this refused delete as a successful deletion.
    const failure = generator.next(
      jsonToolResult({
        kind: 'native_tool_result_error',
        version: 1,
        toolName: 'edit_transaction',
        lifecycle: { state: 'failed' },
        error: {
          code: 'read_authorization_required',
          message:
            "Delete refused: 'package-lock.json' has no whole-file authorization.",
          retryable: false,
        },
        issueCount: 1,
      }) as any,
    ).value as any
    expect(failure).toMatchObject({
      toolName: 'set_output',
      input: {
        data: {
          schemaVersion: 2,
          status: 'failed',
          rollbackRequired: true,
          rollbackReceipt: {
            schemaVersion: 2,
            status: 'incomplete',
            deletedCreatedFiles: [],
            undeletedCreatedFiles: ['package-lock.json'],
          },
        },
      },
    })
    // Every attempted delete stays in the receipt's audit trail.
    expect(failure.input.data.rollbackReceipt.results).toContainEqual(
      expect.objectContaining({
        action: 'delete-created-lockfile',
        path: 'package-lock.json',
      }),
    )
  })

  test('does not claim a deletion when the rollback read grants no whole-file authorization', () => {
    const generator = dependencyManager.handleSteps!({
      agentState: {} as never,
      params: { manager: 'npm', operation: 'sync' },
      logger: {} as never,
    })
    generator.next()
    expect(
      advancePastSnapshotRead(generator, {
        packageManager: 'npm',
        manifests: ['package.json'],
      }).value,
    ).toMatchObject({ toolName: 'run_terminal_command' })
    expect(
      generator.next(
        terminalResult({ exitCode: 1, stderr: 'registry unavailable' }),
      ).value,
    ).toMatchObject({ toolName: 'write_file' })
    expect(generator.next({ toolResult: [] } as any).value).toMatchObject({
      toolName: 'inspect_environment',
    })
    expect(
      generator.next(environmentResult({ lockfiles: ['package-lock.json'] }))
        .value,
    ).toMatchObject({
      toolName: 'read_files',
      input: { paths: ['package-lock.json'] },
    })
    // The lockfile exceeded the read gate, so no whole-file authorization was
    // registered and edit_transaction would refuse the delete. The rollback must
    // skip the delete and the receipt must not assert it.
    expect(
      generator.next({
        toolResult: [
          {
            type: 'json',
            value: {
              results: [
                {
                  path: 'package-lock.json',
                  status: 'too_large',
                  complete: false,
                },
              ],
            },
          },
        ],
        agentState: {} as never,
        stepsComplete: false,
      } as any).value,
    ).toMatchObject({
      toolName: 'set_output',
      input: {
        data: {
          schemaVersion: 2,
          status: 'failed',
          rollbackRequired: true,
          rollbackReceipt: {
            schemaVersion: 2,
            status: 'incomplete',
            deletedCreatedFiles: [],
            undeletedCreatedFiles: ['package-lock.json'],
          },
        },
      },
    })
  })

  test('rejects multi-package dotnet partial transactions', () => {
    const generator = dependencyManager.handleSteps!({
      agentState: {} as never,
      params: {
        manager: 'dotnet',
        operation: 'add',
        packages: ['One', 'Two'],
      },
      logger: {} as never,
    })
    expect(generator.next().value).toMatchObject({
      toolName: 'set_output',
      input: { data: { status: 'invalid' } },
    })
  })
})
