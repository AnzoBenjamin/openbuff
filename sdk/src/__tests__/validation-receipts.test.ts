import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { computeValidationDependencyFingerprint } from '@codebuff/common/types/memory-playbook'
import { createValidationReceiptRegistry } from '../services/validation-receipts'

import type { ExecutionActor } from '@codebuff/common/types/contracts/client'
import type {
  ValidationReceiptRegistry,
  ValidationReceiptRegistryOptions,
} from '../services/validation-receipts'

const actor: ExecutionActor = {
  runId: 'validator-child',
  rootRunId: 'task-1',
  agentId: 'basher',
}
const committer: ExecutionActor = {
  runId: 'committer-child',
  rootRunId: 'task-1',
  agentId: 'git-committer',
}
const packageJson = {
  name: 'receipt-fixture',
  scripts: {
    'check:ci-local': 'tsc --noEmit -p . && bun test --isolate',
    check: 'tsc --noEmit',
    typecheck: 'tsc --noEmit',
    test: 'bun test',
  },
  devDependencies: { typescript: '5.9.3' },
}
let root: string
let outside: string
const capturedPath = `${path.resolve(import.meta.dir, '../../../node_modules/.bin')}${path.delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`
const registries: ValidationReceiptRegistry[] = []
const registry = (options: Partial<ValidationReceiptRegistryOptions> = {}) => {
  const store = createValidationReceiptRegistry({
    projectRoot: root,
    workspaceId: 'ws-1',
    environment: { NODE_ENV: 'test', PATH: capturedPath },
    toolVersions: () => ({ bun: '1.4.4' }),
    clock: { now: () => 1_000 },
    ...options,
  })
  registries.push(store)
  return store
}
const begin = (
  store: ValidationReceiptRegistry,
  command = 'bun run check:ci-local',
) => store.begin({ command, cwd: root, actor })
const succeed = async (
  store: ValidationReceiptRegistry,
  command = 'bun run check:ci-local',
) => store.complete(await begin(store, command), { exitCode: 0 })
const installCompilerFixture = async () => {
  const directory = path.join(root, 'node_modules', 'typescript')
  await mkdir(path.join(directory, 'bin'), { recursive: true })
  await mkdir(path.join(directory, 'lib'))
  await mkdir(path.join(root, 'node_modules', '.bin'))
  await writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({
      name: 'typescript',
      version: 'fixture',
      bin: { tsc: 'bin/tsc' },
    }),
  )
  await writeFile(
    path.join(directory, 'bin/tsc'),
    '#!/usr/bin/env node\nrequire("../lib/compiler.cjs")\n',
    { mode: 0o755 },
  )
  await writeFile(
    path.join(directory, 'lib/compiler.cjs'),
    'module.exports = 1\n',
  )
  await symlink(
    path.join(directory, 'bin/tsc'),
    path.join(root, 'node_modules', '.bin', 'tsc'),
  )
  return directory
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'openbuff-validation-'))
  outside = await mkdtemp(
    path.join(os.tmpdir(), 'openbuff-validation-outside-'),
  )
  await mkdir(path.join(root, 'src'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify(packageJson))
  await writeFile(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2023', noEmit: true },
      include: ['src/value.ts'],
    }),
  )
  await writeFile(path.join(root, 'src/value.ts'), 'export const value = 1\n')
  await writeFile(
    path.join(root, 'src/value.test.ts'),
    "import { expect, test } from 'bun:test'\nimport { value } from './value'\ntest('required behavior', () => expect(value).toBe(1))\n",
  )
})
afterEach(async () => {
  for (const store of registries.splice(0)) store.close()
  await Promise.allSettled([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ])
})

describe('host validation receipt registry', () => {
  test('rejects echo, nonexistent scripts, suppressed failures and mismatched declared capabilities', async () => {
    const store = registry()
    for (const command of [
      'echo check:ci-local',
      'bun run missing',
      'bun run check:ci-local || true',
      'bun run check:ci-local && echo passed',
      'env bun run check:ci-local',
    ]) {
      expect(await begin(store, command)).toBeUndefined()
    }
    expect(
      await store.begin({
        command: 'bun run typecheck',
        cwd: root,
        actor,
        validationKind: 'ci-local',
      }),
    ).toBeUndefined()
    expect(await store.evidence(committer)).toBeUndefined()
  }, 30_000)

  test('attests an actual successful Bun check and reuses it for another actor in the same task', async () => {
    const environment = {
      ...process.env,
      PATH: `${path.resolve(import.meta.dir, '../../../node_modules/.bin')}${path.delimiter}${process.env.PATH ?? ''}`,
    }
    const store = registry({ environment })
    const token = await begin(store)
    expect(token).toBeDefined()
    await promisify(execFile)(process.execPath, ['run', 'check:ci-local'], {
      cwd: root,
      env: environment,
      timeout: 10_000,
    })
    const receipt = await store.complete(token, { exitCode: 0 })
    expect(receipt?.checkKind).toBe('ci-local')
    expect(receipt?.producer).toEqual({
      runId: actor.runId,
      agentId: actor.agentId,
    })
    const evidence = await store.evidence(committer)
    expect(evidence?.receipts).toHaveLength(1)
    expect(evidence?.receipts[0]?.dependencyFingerprint).toBe(
      computeValidationDependencyFingerprint(evidence!.currentDependencyHashes),
    )
    expect(
      await store.evidence({ ...committer, rootRunId: 'different-task' }),
    ).toBeUndefined()

    await writeFile(path.join(root, 'src/value.ts'), 'export const value = 2\n')
    const failedToken = await begin(store)
    let exitCode = 0
    try {
      await promisify(execFile)(process.execPath, ['run', 'check:ci-local'], {
        cwd: root,
        env: environment,
        timeout: 10_000,
      })
    } catch (error) {
      exitCode = Number((error as { code?: number }).code ?? 1)
    }
    expect(exitCode).not.toBe(0)
    expect(await store.complete(failedToken, { exitCode })).toBeUndefined()
    expect(await store.evidence(committer)).toBeUndefined()
  }, 30_000)

  test('recognizes declared pnpm check and concrete Bun test recipes without echo or shell-list substitutes', async () => {
    const store = registry()
    const pnpmToken = await begin(store, 'pnpm check')
    expect(pnpmToken).toBeDefined()
    expect(await store.complete(pnpmToken, { exitCode: 0 })).toMatchObject({
      checkKind: 'typecheck',
    })
    const token = await begin(store, 'bun test --isolate src/value.test.ts')
    expect(token).toBeDefined()
    await promisify(execFile)(
      process.execPath,
      ['test', '--isolate', 'src/value.test.ts'],
      { cwd: root, timeout: 10_000 },
    )
    expect(await store.complete(token, { exitCode: 0 })).toMatchObject({
      checkKind: 'package-checks',
    })
    expect(
      await begin(store, 'bun test --watch src/value.test.ts'),
    ).toBeUndefined()
    expect(await begin(store, 'bun test missing.test.ts')).toBeUndefined()
    expect(
      await begin(store, 'bun test src/value.test.ts; echo check:ci-local'),
    ).toBeUndefined()
  }, 30_000)

  test('script names cannot attest echo/no-op, mislabeled or opaque wrapper bodies', async () => {
    for (const body of [
      'echo LOOKS_GOOD',
      'printf passed',
      'true',
      'exit 0',
      'bun validate.ts',
      'bun test || true',
    ]) {
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({
          ...packageJson,
          scripts: { ...packageJson.scripts, 'check:ci-local': body },
        }),
      )
      expect(await begin(registry())).toBeUndefined()
    }
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        ...packageJson,
        scripts: { ...packageJson.scripts, typecheck: 'bun test' },
      }),
    )
    expect(await begin(registry(), 'bun run typecheck')).toBeUndefined()
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        ...packageJson,
        scripts: {
          ...packageJson.scripts,
          'check:ci-local': 'bun run typecheck && bun run test',
        },
      }),
    )
    expect(await begin(registry())).toBeDefined()
  }, 30_000)

  test('invalidates included source, configuration, lockfile and input-roster changes', async () => {
    const mutations = [
      () =>
        writeFile(path.join(root, 'src/value.ts'), 'export const value = 2\n'),
      () =>
        writeFile(
          path.join(root, 'package.json'),
          JSON.stringify({ ...packageJson, private: true }),
        ),
      () => writeFile(path.join(root, 'bun.lock'), 'new-lockfile'),
      () =>
        writeFile(
          path.join(root, 'src/new-input.ts'),
          'export const added = true\n',
        ),
    ]
    for (const mutate of mutations) {
      const store = registry()
      expect(await succeed(store)).toBeDefined()
      await mutate()
      expect(await store.evidence(committer)).toBeUndefined()
    }
    const store = registry()
    expect(await succeed(store)).toBeDefined()
    await rm(path.join(root, 'src/value.ts'))
    expect(await store.evidence(committer)).toBeUndefined()
  }, 30_000)

  test('rejects a successful result if dependencies changed while the check ran', async () => {
    const store = registry()
    const token = await begin(store)
    await writeFile(path.join(root, 'src/value.ts'), 'export const value = 2\n')
    expect(await store.complete(token, { exitCode: 0 })).toBeUndefined()
    expect(await store.evidence(committer)).toBeUndefined()
  }, 30_000)

  test('hashes captured environment and tool versions without disclosing values', async () => {
    let environment = {
      NODE_ENV: 'test',
      API_TOKEN: 'private-token-do-not-store',
      PATH: capturedPath,
    }
    let tools = { bun: '1.4.4' }
    const store = registry({
      environment: () => environment,
      toolVersions: () => tools,
    })
    expect(await succeed(store)).toBeDefined()
    expect(JSON.stringify(await store.evidence(committer))).not.toContain(
      'private-token-do-not-store',
    )
    environment = { ...environment, NODE_ENV: 'production' }
    expect(await store.evidence(committer)).toBeUndefined()
    expect(await succeed(store)).toBeDefined()
    tools = { bun: 'different-version' }
    expect(await store.evidence(committer)).toBeUndefined()
  }, 30_000)

  test('allows changes outside the conservative source/config dependency closure', async () => {
    const store = registry()
    expect(await succeed(store)).toBeDefined()
    await mkdir(path.join(root, '.openbuff'))
    await mkdir(path.join(root, 'dist'))
    await writeFile(path.join(root, '.openbuff/log.json'), '{"result":"new"}')
    await writeFile(path.join(root, 'dist/output.js'), 'generated-output')
    await writeFile(path.join(root, 'README.md'), 'Documentation update')
    expect((await store.evidence(committer))?.receipts).toHaveLength(1)
  }, 30_000)

  test('invalidates executable and deep installed compiler changes without lockfile or version changes', async () => {
    const compiler = await installCompilerFixture()
    const store = registry()
    for (const mutate of [
      () =>
        writeFile(
          path.join(compiler, 'bin/tsc'),
          '#!/usr/bin/env node\nrequire("../lib/compiler.cjs");\n',
          { mode: 0o755 },
        ),
      () =>
        writeFile(
          path.join(compiler, 'lib/compiler.cjs'),
          'module.exports = 2\n',
        ),
      () =>
        writeFile(path.join(compiler, 'lib/added.cjs'), 'module.exports = 3\n'),
      () => rm(path.join(compiler, 'lib/added.cjs')),
    ]) {
      expect(await succeed(store, 'tsc --noEmit')).toBeDefined()
      await mutate()
      expect(await store.evidence(committer)).toBeUndefined()
    }
  }, 30_000)

  test('does not traverse unrelated installations or resolve unused package managers', async () => {
    await installCompilerFixture()
    // This points at the real large workspace install. A recursive watch or
    // whole-install digest would turn this small check into unbounded work.
    await symlink(
      path.resolve(import.meta.dir, '../../../node_modules'),
      path.join(root, 'node_modules', 'unrelated'),
    )
    await writeFile(
      path.join(root, 'node_modules', '.bin', 'pnpm'),
      'untrusted-unused-tool',
      { mode: 0o755 },
    )
    const store = registry()
    expect(await succeed(store, 'tsc --noEmit')).toBeDefined()
    await writeFile(
      path.join(root, 'node_modules', '.bin', 'pnpm'),
      'changed-unused-tool',
      { mode: 0o755 },
    )
    const evidence = await store.evidence(committer)
    expect(evidence?.receipts).toHaveLength(1)
    expect(
      Object.keys(evidence!.currentDependencyHashes).some((key) =>
        key.startsWith('tool:pnpm:'),
      ),
    ).toBe(false)
  }, 30_000)

  test('binds native PATH separately from a package runner compiler resolution', async () => {
    await installCompilerFixture()
    const nativeCompiler = path.join(outside, 'typescript')
    await mkdir(path.join(nativeCompiler, 'bin'), { recursive: true })
    await writeFile(
      path.join(nativeCompiler, 'package.json'),
      JSON.stringify({ name: 'typescript', version: 'native-fixture' }),
    )
    await writeFile(
      path.join(nativeCompiler, 'bin/tsc'),
      '#!/usr/bin/env node\nprocess.exit(0)\n',
      { mode: 0o755 },
    )
    const store = registry({
      environment: {
        PATH: `${path.join(nativeCompiler, 'bin')}${path.delimiter}${capturedPath}`,
      },
    })
    expect(await succeed(store, 'tsc --noEmit')).toBeDefined()
    await writeFile(
      path.join(nativeCompiler, 'bin/tsc'),
      '#!/usr/bin/env node\nprocess.exit(1)\n',
      { mode: 0o755 },
    )
    expect(await store.evidence(committer)).toBeUndefined()
  }, 30_000)

  test('bounds preparation time, tool bytes and source directory work and then fails closed', async () => {
    const startedAt = performance.now()
    expect(await begin(registry({ maxPreparationMs: 1 }))).toBeUndefined()
    expect(performance.now() - startedAt).toBeLessThan(4_000)
    expect(await begin(registry({ maxToolBytes: 1 }))).toBeUndefined()
    expect(await begin(registry(), 'tsc '.repeat(8_193))).toBeUndefined()
    expect(
      await begin(
        registry({
          environment: {
            PATH: capturedPath,
            ...Object.fromEntries(
              Array.from({ length: 4_096 }, (_, index) => [
                `ENV_${index}`,
                'value',
              ]),
            ),
          },
        }),
      ),
    ).toBeUndefined()
    await Promise.all(
      Array.from({ length: 128 }, (_, index) =>
        mkdir(path.join(root, `empty-${index}`)),
      ),
    )
    expect(await begin(registry({ maxFiles: 20 }))).toBeUndefined()
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        ...packageJson,
        scripts: Object.fromEntries(
          Array.from({ length: 129 }, (_, index) => [
            `script-${index}`,
            'true',
          ]),
        ),
      }),
    )
    expect(await begin(registry())).toBeUndefined()
  }, 30_000)

  test('combines required checks at an unchanged fingerprint and retains the oldest freshness timestamp', async () => {
    let atMs = 1_000
    const store = registry({ clock: { now: () => atMs } })
    expect(await succeed(store, 'bun run typecheck')).toMatchObject({
      checkKind: 'typecheck',
    })
    expect(
      (await store.evidence(committer))?.receipts.some(
        (receipt) => receipt.checkKind === 'package-checks',
      ),
    ).toBe(false)
    atMs = 3_000
    expect(await succeed(store, 'bun run test')).toMatchObject({
      checkKind: 'package-checks',
      completedAt: 1_000,
    })
  }, 30_000)

  test('creates package-check evidence only from complete successful native hook outcomes', async () => {
    const store = registry()
    const token = await store.begin({
      command: 'run_file_change_hooks',
      cwd: root,
      actor,
      validationKind: 'file-change-hooks',
    })
    const receipt = await store.complete(token, {
      nativeHooksOutput: [
        {
          type: 'json',
          value: [
            {
              command: 'bun run typecheck',
              hookName: 'typecheck',
              exitCode: 0,
            },
            { command: 'bun run test', hookName: 'test', exitCode: 0 },
          ],
        },
      ],
    })
    expect(receipt?.checkKind).toBe('package-checks')
    expect(
      (await store.evidence(committer))?.receipts.some(
        (entry) => entry.checkKind === 'package-checks',
      ),
    ).toBe(true)
  }, 30_000)

  test('rejects skipped, failed, missing-status and echo-only native hook outcomes', async () => {
    for (const values of [
      [{ validationStatus: 'hooks_skipped' }],
      [{ command: 'bun run typecheck', exitCode: 1 }],
      [{ command: 'bun run typecheck' }],
      [{ command: 'echo check:ci-local', hookName: 'typecheck', exitCode: 0 }],
      [
        { command: 'bun run typecheck', exitCode: 0 },
        {
          validationStatus: 'diagnostic_delta_unknown',
          diagnosticStatus: 'unknown',
        },
      ],
    ]) {
      const store = registry()
      const token = await store.begin({
        command: 'run_file_change_hooks',
        cwd: root,
        actor,
        validationKind: 'file-change-hooks',
      })
      expect(
        await store.complete(token, {
          nativeHooksOutput: [{ type: 'json', value: values }],
        }),
      ).toBeUndefined()
      expect(await store.evidence(committer)).toBeUndefined()
    }
    const store = registry()
    const token = await store.begin({
      command: 'run_file_change_hooks',
      cwd: root,
      actor,
      validationKind: 'file-change-hooks',
    })
    expect(
      await store.complete(token, {
        nativeHooksOutput: [
          {
            type: 'json',
            value: [
              { command: 'bun run typecheck', exitCode: 0 },
              { command: 'echo tests-passed', hookName: 'test', exitCode: 0 },
            ],
          },
        ],
      }),
    ).toMatchObject({ checkKind: 'typecheck' })
    expect(
      (await store.evidence(committer))?.receipts.some(
        (receipt) => receipt.checkKind === 'package-checks',
      ),
    ).toBe(false)
  }, 30_000)

  test('rejects foreign or replayed tokens, failed outcomes and unsafe or over-budget input views', async () => {
    const store = registry()
    const token = await begin(store)
    expect(
      await store.complete({ id: token!.id }, { exitCode: 0 }),
    ).toBeUndefined()
    expect(await registry().complete(token, { exitCode: 0 })).toBeUndefined()
    expect(await store.complete(token, { exitCode: 1 })).toBeUndefined()
    expect(await store.complete(token, { exitCode: 0 })).toBeUndefined()
    expect(await begin(registry({ maxFiles: 1 }))).toBeUndefined()
    expect(await begin(registry({ maxBytes: 1 }))).toBeUndefined()
    expect(
      await store.begin({
        command: 'bun run check:ci-local',
        cwd: outside,
        actor,
      }),
    ).toBeUndefined()
    await writeFile(
      path.join(outside, 'external.ts'),
      'export const outside = true\n',
    )
    await symlink(
      path.join(outside, 'external.ts'),
      path.join(root, 'src/external.ts'),
    )
    expect(await begin(store)).toBeUndefined()
  }, 30_000)
})
