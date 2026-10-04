import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MAX_FILE_CHANGES_PER_TRANSACTION } from '@codebuff/common/actions'
import { createMockFs } from '@codebuff/common/testing/mocks/filesystem'
import { fileMutationResultV1Schema } from '@codebuff/common/tools/results/filesystem'
import { getContentHash } from '@codebuff/common/util/content-hash'

import { changeFile, changeFiles } from '../tools/change-file'
import { createTransactionIntentLogForWorkspace } from '../tools/transaction-intent-log'

const capabilityIssuer = {
  projectId: '/repo',
  runId: 'change-file-tests',
}

describe('changeFile', () => {
  test('returns a canonical authority-backed result for string replacements', async () => {
    const fs = createMockFs({
      files: {
        '/repo/src/file.ts': 'const value = 1\n',
      },
    })

    const result = await changeFile({
      parameters: {
        type: 'patch',
        path: 'src/file.ts',
        content: '@@ -1,1 +1,1 @@\n-const value = 1\n+const value = 2\n',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]?.type === 'json' ? result[0].value : null).toMatchObject({
      kind: 'file_mutation_result',
      version: 1,
      outcome: 'applied',
      actions: [
        expect.objectContaining({
          action: 'update',
          path: 'src/file.ts',
          outcome: 'applied',
          afterContent: 'const value = 2\n',
          editAnchor: expect.objectContaining({
            startLine: 1,
            endLine: 2,
            contentHash: getContentHash('const value = 2\n'),
            readCapability: expect.stringContaining('cap.v3.'),
          }),
        }),
      ],
    })
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(
      'const value = 2\n',
    )
  })

  test('accepts absolute prompt paths when they resolve inside the project', async () => {
    const fs = createMockFs({
      files: {
        '/repo/src/file.ts': 'const value = 1\n',
      },
    })

    const result = await changeFile({
      parameters: {
        type: 'patch',
        path: '/repo/src/file.ts',
        content: '@@ -1,1 +1,1 @@\n-const value = 1\n+const value = 2\n',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]?.type === 'json' ? result[0].value : null).toMatchObject({
      kind: 'file_mutation_result',
      outcome: 'applied',
      actions: [
        expect.objectContaining({
          action: 'update',
          outcome: 'applied',
          afterContent: 'const value = 2\n',
        }),
      ],
    })
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(
      'const value = 2\n',
    )
  })

  test('returns a canonical authority-backed result for new file writes', async () => {
    const fs = createMockFs()

    const result = await changeFile({
      parameters: {
        type: 'file',
        path: 'src/file.ts',
        content: 'const value = 1\n',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]?.type === 'json' ? result[0].value : null).toMatchObject({
      kind: 'file_mutation_result',
      outcome: 'applied',
      actions: [
        expect.objectContaining({
          action: 'create',
          afterContent: 'const value = 1\n',
        }),
      ],
    })
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(
      'const value = 1\n',
    )
  })

  test('accepts absolute file-write prompt paths when they resolve inside the project', async () => {
    const fs = createMockFs()

    const result = await changeFile({
      parameters: {
        type: 'file',
        path: '/repo/src/file.ts',
        content: 'const value = 1\n',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]?.type === 'json' ? result[0].value : null).toMatchObject({
      kind: 'file_mutation_result',
      outcome: 'applied',
      actions: [
        expect.objectContaining({
          action: 'create',
          afterContent: 'const value = 1\n',
        }),
      ],
    })
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(
      'const value = 1\n',
    )
  })

  test('accepts paths whose file names start with two dots inside the project', async () => {
    const fs = createMockFs()

    const result = await changeFile({
      parameters: {
        type: 'file',
        path: '..config',
        content: 'value = true\n',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]?.type === 'json' ? result[0].value : null).toMatchObject({
      kind: 'file_mutation_result',
      outcome: 'applied',
      actions: [expect.objectContaining({ path: '..config' })],
    })
    expect(await fs.readFile('/repo/..config', 'utf-8')).toBe('value = true\n')
  })

  test('returns a canonical result for overwritten file writes', async () => {
    const fs = createMockFs({
      files: {
        '/repo/src/file.ts': 'const value = 1\n',
      },
    })

    const result = await changeFile({
      parameters: {
        type: 'file',
        path: 'src/file.ts',
        content: 'const value = 2\n',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]?.type === 'json' ? result[0].value : null).toMatchObject({
      kind: 'file_mutation_result',
      outcome: 'applied',
      actions: [
        expect.objectContaining({
          action: 'update',
          afterContent: 'const value = 2\n',
        }),
      ],
    })
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe(
      'const value = 2\n',
    )
  })

  test('uses conditionalCommit for updates when the adapter provides it', async () => {
    const fs = createMockFs({ files: { '/repo/src/file.ts': 'before\n' } })
    let conditionalCalls = 0
    fs.conditionalCommit = async () => {
      conditionalCalls += 1
      return { applied: false, actualHash: getContentHash('external\n') }
    }

    const result = await changeFile({
      parameters: { type: 'file', path: 'src/file.ts', content: 'after\n' },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(conditionalCalls).toBe(1)
    expect(result[0]?.type === 'json' ? result[0].value : null).toMatchObject({
      outcome: 'not_applied',
      errors: [expect.objectContaining({ code: 'stale_state' })],
    })
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe('before\n')
  })

  test('reports update for a rejected unguarded write to an existing file', async () => {
    const fs = createMockFs({ files: { '/repo/src/file.ts': 'before\n' } })
    fs.conditionalCommit = async () => ({
      applied: false,
      actualHash: getContentHash('external\n'),
    })

    const result = await changeFile({
      // Absolute prompt path: the failure result must still report the
      // project-relative path, like the applied branch does.
      parameters: {
        type: 'file',
        path: '/repo/src/file.ts',
        content: 'after\n',
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]?.type === 'json' ? result[0].value : null).toMatchObject({
      outcome: 'not_applied',
      actions: [
        expect.objectContaining({
          action: 'update',
          path: 'src/file.ts',
          outcome: 'not_applied',
        }),
      ],
      errors: [expect.objectContaining({ code: 'stale_state' })],
    })
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe('before\n')
  })

  test('logs a redacted diagnostic when a guarded update is stale', async () => {
    const fs = createMockFs({ files: { '/repo/src/file.ts': 'current\n' } })
    const logged: Array<{ data: unknown; message?: string }> = []
    const logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (data: unknown, message?: string) => {
        logged.push({ data, message })
      },
    }

    const result = await changeFile({
      parameters: {
        type: 'file',
        path: 'src/file.ts',
        content: 'sensitive-new-content\n',
        expectedHash: getContentHash('stale\n'),
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
      logger,
    })

    expect(result[0]?.type === 'json' ? result[0].value : null).toMatchObject({
      outcome: 'not_applied',
      errors: [expect.objectContaining({ code: 'stale_state' })],
    })
    expect(logged).toHaveLength(1)
    expect(logged[0].data).toEqual({
      path: 'src/file.ts',
      type: 'file',
      byteLength: Buffer.byteLength('sensitive-new-content\n'),
      code: 'stale_state',
    })
    const serialized = JSON.stringify(logged[0])
    expect(serialized).not.toContain('sensitive-new-content')
    expect(serialized).not.toContain('current')
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe('current\n')
  })

  test('fails closed for a guarded update when conditional commit is unavailable', async () => {
    const fs = createMockFs({ files: { '/repo/src/file.ts': 'before\n' } })
    fs.conditionalCommit = undefined

    const result = await changeFile({
      parameters: {
        type: 'file',
        path: 'src/file.ts',
        content: 'after\n',
        expectedHash: getContentHash('before\n'),
      },
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]?.type === 'json' ? result[0].value : null).toMatchObject({
      outcome: 'not_applied',
      errors: [expect.objectContaining({ code: 'unsupported' })],
    })
    expect(await fs.readFile('/repo/src/file.ts', 'utf-8')).toBe('before\n')
  })

  test('rejects absolute paths outside the project', async () => {
    const fs = createMockFs()

    await expect(
      changeFile({
        parameters: {
          type: 'file',
          path: '/outside/file.ts',
          content: 'const value = 1\n',
        },
        cwd: '/repo',
        fs,
      }),
    ).rejects.toThrow('file path is outside the project directory')
  })

  test('applies multiple preflighted file changes with a verified receipt', async () => {
    const fs = createMockFs({
      files: {
        '/repo/src/one.ts': 'const one = 1\n',
        '/repo/src/two.ts': 'const two = 1\n',
      },
    })

    const result = await changeFiles({
      parameters: [
        {
          type: 'patch',
          path: 'src/one.ts',
          content: '@@ -1,1 +1,1 @@\n-const one = 1\n+const one = 2\n',
        },
        {
          type: 'patch',
          path: 'src/two.ts',
          content: '@@ -1,1 +1,1 @@\n-const two = 1\n+const two = 2\n',
        },
      ],
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    expect(result[0]?.type === 'json' ? result[0].value : null).toMatchObject({
      kind: 'file_mutation_result',
      outcome: 'applied',
      actions: [
        expect.objectContaining({
          path: 'src/one.ts',
          outcome: 'applied',
          afterContent: 'const one = 2\n',
        }),
        expect.objectContaining({
          path: 'src/two.ts',
          outcome: 'applied',
          afterContent: 'const two = 2\n',
        }),
      ],
    })
    expect(await fs.readFile('/repo/src/one.ts', 'utf-8')).toBe(
      'const one = 2\n',
    )
    expect(await fs.readFile('/repo/src/two.ts', 'utf-8')).toBe(
      'const two = 2\n',
    )
  })

  test('does not write any file when one coordinated change fails to prepare', async () => {
    const fs = createMockFs({
      files: {
        '/repo/src/one.ts': 'const one = 1\n',
        '/repo/src/two.ts': 'const two = 1\n',
      },
    })

    const result = await changeFiles({
      parameters: [
        {
          type: 'patch',
          path: 'src/one.ts',
          content: '@@ -1,1 +1,1 @@\n-const one = 1\n+const one = 2\n',
        },
        {
          type: 'patch',
          path: 'src/two.ts',
          content: '@@ -1,1 +1,1 @@\n-const missing = 1\n+const missing = 2\n',
        },
      ],
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    // Parsed unconditionally: a shape regression must fail the test instead of
    // silently skipping these assertions.
    const mutation = fileMutationResultV1Schema.parse(
      result[0]?.type === 'json' ? result[0].value : null,
    )
    expect(mutation).toMatchObject({
      kind: 'file_mutation_result',
      outcome: 'not_applied',
    })
    expect(
      mutation.actions.every(
        (action) =>
          action.afterContent === undefined && action.editAnchor === undefined,
      ),
    ).toBe(true)
    expect(await fs.readFile('/repo/src/one.ts', 'utf-8')).toBe(
      'const one = 1\n',
    )
    expect(await fs.readFile('/repo/src/two.ts', 'utf-8')).toBe(
      'const two = 1\n',
    )
  })

  test('rolls back files written before a coordinated write failure', async () => {
    const files: Record<string, string> = {
      '/repo/src/one.ts': 'const one = 1\n',
      '/repo/src/two.ts': 'const two = 1\n',
    }
    let failedWrite = false
    const fs = createMockFs({
      files,
      readFileImpl: async (path) => {
        const content = files[path]
        if (content === undefined)
          throw Object.assign(new Error('not found'), { code: 'ENOENT' })
        return content
      },
      writeFileImpl: async (path, content) => {
        if (path === '/repo/src/two.ts' && !failedWrite) {
          failedWrite = true
          throw new Error('disk full')
        }
        files[path] = content
      },
    })

    const result = await changeFiles({
      parameters: [
        {
          type: 'patch',
          path: 'src/one.ts',
          content: '@@ -1,1 +1,1 @@\n-const one = 1\n+const one = 2\n',
        },
        {
          type: 'patch',
          path: 'src/two.ts',
          content: '@@ -1,1 +1,1 @@\n-const two = 1\n+const two = 2\n',
        },
      ],
      cwd: '/repo',
      fs,
    })

    expect(result[0]?.type === 'json' ? result[0].value : null).toMatchObject({
      kind: 'file_mutation_result',
      outcome: 'rolled_back',
    })
    expect(files['/repo/src/one.ts']).toBe('const one = 1\n')
    expect(files['/repo/src/two.ts']).toBe('const two = 1\n')
  })

  test('reports an incomplete rollback without claiming atomic restoration', async () => {
    const files: Record<string, string> = {
      '/repo/src/one.ts': 'const one = 1\n',
      '/repo/src/two.ts': 'const two = 1\n',
    }
    const fs = createMockFs({
      files,
      readFileImpl: async (path) => {
        const content = files[path]
        if (content === undefined)
          throw Object.assign(new Error('not found'), { code: 'ENOENT' })
        return content
      },
      writeFileImpl: async (path, content) => {
        if (path === '/repo/src/two.ts') throw new Error('disk full')
        if (path === '/repo/src/one.ts' && content === 'const one = 1\n') {
          throw new Error('rollback denied')
        }
        files[path] = content
      },
    })

    const result = await changeFiles({
      parameters: [
        {
          type: 'patch',
          path: 'src/one.ts',
          content: '@@ -1,1 +1,1 @@\n-const one = 1\n+const one = 2\n',
        },
        {
          type: 'patch',
          path: 'src/two.ts',
          content: '@@ -1,1 +1,1 @@\n-const two = 1\n+const two = 2\n',
        },
      ],
      cwd: '/repo',
      fs,
    })

    const value = result[0]?.type === 'json' ? result[0].value : undefined
    expect(value).toMatchObject({
      kind: 'file_mutation_result',
      outcome: 'rollback_incomplete',
      actions: expect.arrayContaining([
        expect.objectContaining({
          path: 'src/one.ts',
          outcome: 'applied',
          rollback: expect.objectContaining({
            attempted: true,
            succeeded: false,
          }),
        }),
      ]),
      authorityReceipt: expect.objectContaining({
        status: 'rollback_incomplete',
      }),
    })
    expect(files['/repo/src/one.ts']).toBe('const one = 2\n')
  })

  test('does not overwrite an external edit when conditional rollback detects a conflict', async () => {
    const fs = createMockFs({
      files: {
        '/repo/src/one.ts': 'one-before\n',
        '/repo/src/two.ts': 'two-before\n',
      },
    })
    const conditionalCommit = fs.conditionalCommit!.bind(fs)
    fs.conditionalCommit = async (filePath, data, options) => {
      if (String(filePath) === '/repo/src/two.ts') {
        await fs.writeFile('/repo/src/one.ts', 'external\n')
        throw new Error('disk full')
      }
      return conditionalCommit(filePath, data, options)
    }

    const result = await changeFiles({
      parameters: [
        {
          type: 'file',
          path: 'src/one.ts',
          content: 'one-after\n',
          expectedHash: getContentHash('one-before\n'),
        },
        {
          type: 'file',
          path: 'src/two.ts',
          content: 'two-after\n',
          expectedHash: getContentHash('two-before\n'),
        },
      ],
      cwd: '/repo',
      fs,
    })

    expect(result[0]?.type === 'json' ? result[0].value : null).toMatchObject({
      outcome: 'rollback_incomplete',
      actions: [
        expect.objectContaining({
          path: 'src/one.ts',
          rollback: expect.objectContaining({ succeeded: false }),
          error: expect.objectContaining({ code: 'rollback_incomplete' }),
        }),
        expect.anything(),
      ],
    })
    expect(await fs.readFile('/repo/src/one.ts', 'utf-8')).toBe('external\n')
  })

  test('[ABI-M08] coordinates create, delete, and move with expected state', async () => {
    const fs = createMockFs({
      files: {
        '/repo/delete.txt': 'remove me',
        '/repo/source.txt': 'move me',
      },
    })

    const result = await changeFiles({
      parameters: [
        {
          type: 'file',
          path: 'created.txt',
          content: 'created',
          expectedHash: null,
        },
        {
          type: 'delete',
          path: 'delete.txt',
          expectedHash: getContentHash('remove me'),
        },
        {
          type: 'move',
          path: 'source.txt',
          destinationPath: 'moved.txt',
          expectedHash: getContentHash('move me'),
          destinationExpectedHash: null,
        },
      ],
      cwd: '/repo',
      fs,
      capabilityIssuer,
    })

    const mutation = fileMutationResultV1Schema.parse(
      result[0]?.type === 'json' ? result[0].value : null,
    )
    expect(mutation).toMatchObject({
      kind: 'file_mutation_result',
      outcome: 'applied',
      actions: [
        expect.objectContaining({
          action: 'create',
          path: 'created.txt',
          afterContent: 'created',
        }),
        expect.objectContaining({
          action: 'delete',
          path: 'delete.txt',
        }),
        expect.objectContaining({
          action: 'move',
          path: 'source.txt',
          destinationPath: 'moved.txt',
          afterContent: 'move me',
          editAnchor: expect.objectContaining({
            startLine: 1,
            endLine: 1,
            contentHash: getContentHash('move me'),
          }),
        }),
      ],
    })
    // A deleted path has no post-state, so it must carry neither content nor
    // a read capability that would authorize editing the removed file.
    const deleteAction = mutation.actions[1]
    expect(deleteAction.afterContent).toBeUndefined()
    expect(deleteAction.editAnchor).toBeUndefined()
    expect(await fs.readFile('/repo/created.txt', 'utf-8')).toBe('created')
    await expect(fs.readFile('/repo/delete.txt', 'utf-8')).rejects.toThrow()
    await expect(fs.readFile('/repo/source.txt', 'utf-8')).rejects.toThrow()
    expect(await fs.readFile('/repo/moved.txt', 'utf-8')).toBe('move me')
  })

  test('[ABI-M08] rejects a stale lifecycle transaction before commit', async () => {
    const fs = createMockFs({ files: { '/repo/delete.txt': 'current' } })
    const result = await changeFiles({
      parameters: [
        {
          type: 'delete',
          path: 'delete.txt',
          expectedHash: getContentHash('stale'),
        },
      ],
      cwd: '/repo',
      fs,
    })
    expect(result[0]?.type === 'json' ? result[0].value : null).toMatchObject({
      kind: 'file_mutation_result',
      outcome: 'not_applied',
      errors: [expect.objectContaining({ code: 'stale_state' })],
    })
    expect(await fs.readFile('/repo/delete.txt', 'utf-8')).toBe('current')
  })

  test('[ABI-M08] revalidates state after commit authorization', async () => {
    let targetReads = 0
    const fs = createMockFs({
      files: { '/repo/file.txt': 'before' },
      readFileImpl: async (path) => {
        if (path !== '/repo/file.txt') throw new Error('not found')
        targetReads++
        return targetReads === 1 ? 'before' : 'external-change'
      },
    })
    const result = await changeFiles({
      parameters: [
        {
          type: 'file',
          path: 'file.txt',
          content: 'after',
          expectedHash: getContentHash('before'),
        },
      ],
      cwd: '/repo',
      fs,
    })
    expect(result[0]?.type === 'json' ? result[0].value : null).toMatchObject({
      kind: 'file_mutation_result',
      outcome: 'not_applied',
      errors: [expect.objectContaining({ code: 'stale_state' })],
    })
    expect(targetReads).toBeGreaterThanOrEqual(2)
  })

  test('mandatory mutation policy blocks sensitive and custom-filtered paths', async () => {
    const fs = createMockFs()
    const sensitive = await changeFile({
      parameters: { type: 'file', path: '.env', content: 'SECRET=value' },
      cwd: '/repo',
      fs,
    })
    expect(
      sensitive[0]?.type === 'json' ? sensitive[0].value : null,
    ).toMatchObject({
      kind: 'file_mutation_result',
      outcome: 'not_applied',
      // A rejected write to a missing path is still reported as a `create`,
      // not an `update`, so the agent can tell why it was blocked.
      actions: [
        expect.objectContaining({
          action: 'create',
          path: '.env',
          outcome: 'not_applied',
        }),
      ],
      errors: [expect.objectContaining({ code: 'blocked' })],
    })
    const customBlocked = await changeFile({
      parameters: { type: 'file', path: 'blocked.txt', content: 'nope' },
      cwd: '/repo',
      fs,
      fileFilter: (path) => ({
        status: path === 'blocked.txt' ? 'blocked' : 'allow',
      }),
    })
    expect(
      customBlocked[0]?.type === 'json' ? customBlocked[0].value : null,
    ).toMatchObject({
      kind: 'file_mutation_result',
      outcome: 'not_applied',
      errors: [expect.objectContaining({ code: 'blocked' })],
    })
    await expect(fs.readFile('/repo/.env', 'utf-8')).rejects.toThrow()
    await expect(fs.readFile('/repo/blocked.txt', 'utf-8')).rejects.toThrow()
  })

  test('successful transactions include an authority-owned verified receipt', async () => {
    const fs = createMockFs({ files: { '/repo/file.txt': 'before' } })
    const result = await changeFiles({
      parameters: [
        {
          type: 'file',
          path: 'file.txt',
          content: 'after',
          expectedHash: getContentHash('before'),
        },
      ],
      cwd: '/repo',
      fs,
      callId: 'tool-call',
    })
    expect(result[0]?.type === 'json' ? result[0].value : null).toMatchObject({
      kind: 'file_mutation_result',
      outcome: 'applied',
      authorityReceipt: {
        kind: 'commit_receipt',
        callId: 'tool-call',
        status: 'committed',
        finalHashes: { 'file.txt': getContentHash('after') },
      },
    })
  })

  test('[ABI-M08] fails closed when conditional no-clobber move is unavailable', async () => {
    const fs = createMockFs({ files: { '/repo/source.txt': 'move me' } })
    fs.conditionalMove = undefined
    const result = await changeFiles({
      parameters: [
        {
          type: 'move',
          path: 'source.txt',
          destinationPath: 'moved.txt',
          expectedHash: getContentHash('move me'),
          destinationExpectedHash: null,
        },
      ],
      cwd: '/repo',
      fs,
    })
    expect(result[0]?.type === 'json' ? result[0].value : null).toMatchObject({
      kind: 'file_mutation_result',
      outcome: 'not_applied',
      errors: [expect.objectContaining({ code: 'unsupported' })],
    })
    expect(await fs.readFile('/repo/source.txt', 'utf-8')).toBe('move me')
    await expect(fs.readFile('/repo/moved.txt', 'utf-8')).rejects.toThrow()
  })

  test('records durable begin/commit intents and stamps the transactionId on the receipt', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'openbuff-tx-wiring-'))
    try {
      const intentLog = createTransactionIntentLogForWorkspace({
        stateDir,
        cwd: '/repo',
      })
      const fs = createMockFs({
        files: {
          '/repo/src/one.ts': 'const one = 1\n',
          '/repo/src/two.ts': 'const two = 1\n',
        },
      })

      const result = await changeFiles({
        parameters: [
          {
            type: 'patch',
            path: 'src/one.ts',
            content:
              '@@ -1,1 +1,1 @@\n-const one = 1\n+const one = 2\n',
          },
          {
            type: 'patch',
            path: 'src/two.ts',
            content:
              '@@ -1,1 +1,1 @@\n-const two = 1\n+const two = 2\n',
          },
        ],
        cwd: '/repo',
        fs,
        intentLog,
      })

      const mutation = fileMutationResultV1Schema.parse(
        result[0]?.type === 'json' ? result[0].value : null,
      )
      expect(mutation.outcome).toBe('applied')
      const stampedId = mutation.authorityReceipt?.transactionId
      expect(stampedId).toBeDefined()
      expect(stampedId).toBe(`tx-${mutation.operationId}`)

      const events = readFileSync(intentLog.filePath, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(events.map((event) => event.kind)).toEqual([
        'tx_begin',
        'tx_commit',
      ])
      expect(events[0]).toMatchObject({
        transactionId: stampedId,
        operationId: mutation.operationId,
      })
      // Durable pre-images: every staged path is present, with beforeBytes
      // for updates and none for move destinations.
      const entries = events[0]?.entries as Array<{
        path: string
        beforeHash: string | null
        beforeBytes?: string
        beforeMode?: number
      }>
      expect(entries).toEqual([
        {
          path: 'src/one.ts',
          beforeHash: expect.any(String),
          beforeBytes: 'const one = 1\n',
          // The file's permission bits are part of the durable pre-image.
          beforeMode: 0o644,
        },
        {
          path: 'src/two.ts',
          beforeHash: expect.any(String),
          beforeBytes: 'const two = 1\n',
          beforeMode: 0o644,
        },
      ])
      expect(events[1]).toMatchObject({ transactionId: stampedId })
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test('records a durable abort after a rolled-back multi-file commit', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'openbuff-tx-wiring-'))
    try {
      const intentLog = createTransactionIntentLogForWorkspace({
        stateDir,
        cwd: '/repo',
      })
      const files: Record<string, string> = {
        '/repo/src/one.ts': 'const one = 1\n',
        '/repo/src/two.ts': 'const two = 1\n',
      }
      let failedWrite = false
      const fs = createMockFs({
        files,
        readFileImpl: async (path) => {
          const content = files[path]
          if (content === undefined)
            throw Object.assign(new Error('not found'), { code: 'ENOENT' })
          return content
        },
        writeFileImpl: async (path, content) => {
          if (path === '/repo/src/two.ts' && !failedWrite) {
            failedWrite = true
            throw new Error('disk full')
          }
          files[path] = content
        },
      })

      const result = await changeFiles({
        parameters: [
          {
            type: 'patch',
            path: 'src/one.ts',
            content:
              '@@ -1,1 +1,1 @@\n-const one = 1\n+const one = 2\n',
          },
          {
            type: 'patch',
            path: 'src/two.ts',
            content:
              '@@ -1,1 +1,1 @@\n-const two = 1\n+const two = 2\n',
          },
        ],
        cwd: '/repo',
        fs,
        intentLog,
      })

      const mutation = fileMutationResultV1Schema.parse(
        result[0]?.type === 'json' ? result[0].value : null,
      )
      expect(mutation.outcome).toBe('rolled_back')
      expect(mutation.authorityReceipt?.transactionId).toBeDefined()
      // The in-memory rollback already restored the files.
      expect(files['/repo/src/one.ts']).toBe('const one = 1\n')

      const events = readFileSync(intentLog.filePath, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(events.map((event) => event.kind)).toEqual([
        'tx_begin',
        'tx_abort',
      ])
      expect(events[1]).toMatchObject({
        transactionId: mutation.authorityReceipt?.transactionId,
      })
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test('single-file transactions skip the durable intent log', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'openbuff-tx-wiring-'))
    try {
      const intentLog = createTransactionIntentLogForWorkspace({
        stateDir,
        cwd: '/repo',
      })
      const fs = createMockFs({ files: { '/repo/file.txt': 'before' } })

      const result = await changeFiles({
        parameters: [
          {
            type: 'file',
            path: 'file.txt',
            content: 'after',
            expectedHash: getContentHash('before'),
          },
        ],
        cwd: '/repo',
        fs,
        intentLog,
      })

      // No intent events were written for a single-file transaction, so the
      // receipt carries NO transactionId: the CommitReceiptV1 field documents
      // a durable transaction-intent id, not an operation-scoped alias.
      expect(existsSync(intentLog.filePath)).toBe(false)
      const mutation = fileMutationResultV1Schema.parse(
        result[0]?.type === 'json' ? result[0].value : null,
      )
      expect(mutation.authorityReceipt?.transactionId).toBeUndefined()
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test('an intent-log failure never breaks the commit path', async () => {
    const failingIntentLog = {
      filePath: '/nonexistent/intents.jsonl',
      beginTransaction: async () => ({ ok: false, error: 'disk exploded' }),
      commitTransaction: async () => ({ ok: false, error: 'disk exploded' }),
      abortTransaction: async () => ({ ok: false, error: 'disk exploded' }),
      recoverInterruptedTransactions: async () => ({
        ok: false as const,
        error: 'disk exploded',
      }),
      revertTransaction: async () => ({
        ok: false as const,
        status: 'revert_failed' as const,
        error: 'disk exploded',
        revertedPaths: 0,
      }),
    }
    const fs = createMockFs({
      files: {
        '/repo/src/one.ts': 'const one = 1\n',
        '/repo/src/two.ts': 'const two = 1\n',
      },
    })

    const result = await changeFiles({
      parameters: [
        {
          type: 'patch',
          path: 'src/one.ts',
          content: '@@ -1,1 +1,1 @@\n-const one = 1\n+const one = 2\n',
        },
        {
          type: 'patch',
          path: 'src/two.ts',
          content: '@@ -1,1 +1,1 @@\n-const two = 1\n+const two = 2\n',
        },
      ],
      cwd: '/repo',
      fs,
      intentLog: failingIntentLog,
    })

    expect(result[0]?.type === 'json' ? result[0].value : null).toMatchObject({
      kind: 'file_mutation_result',
      outcome: 'applied',
    })
    // A tx_begin that failed means no durable intent record exists, so the
    // committed receipt carries NO transactionId (no dangling id).
    const mutation = fileMutationResultV1Schema.parse(
      result[0]?.type === 'json' ? result[0].value : null,
    )
    expect(mutation.authorityReceipt?.transactionId).toBeUndefined()
    expect(await fs.readFile('/repo/src/one.ts', 'utf-8')).toBe(
      'const one = 2\n',
    )
  })

  test('an abort mid-commit stops the loop, rolls back applied changes, and reports a cancelled outcome', async () => {
    const files: Record<string, string> = {
      '/repo/src/one.ts': 'const one = 1\n',
      '/repo/src/two.ts': 'const two = 1\n',
      '/repo/src/three.ts': 'const three = 1\n',
    }
    const fs = createMockFs({ files })
    const conditionalCommit = fs.conditionalCommit!.bind(fs)
    // Abort right after the FIRST per-change commit lands, so the recheck
    // before the SECOND commit must stop the loop with one file applied.
    let commits = 0
    const controller = new AbortController()
    fs.conditionalCommit = async (filePath, data, options) => {
      // The shared rollback path also goes through conditionalCommit to
      // restore the applied change, so only commits made before the abort
      // count as forward transaction commits.
      const wasAborted = controller.signal.aborted
      const result = await conditionalCommit(filePath, data, options)
      if (!wasAborted) {
        commits += 1
        if (commits === 1) controller.abort()
      }
      return result
    }

    const result = await changeFiles({
      parameters: [
        {
          type: 'patch',
          path: 'src/one.ts',
          content: '@@ -1,1 +1,1 @@\n-const one = 1\n+const one = 2\n',
        },
        {
          type: 'patch',
          path: 'src/two.ts',
          content: '@@ -1,1 +1,1 @@\n-const two = 1\n+const two = 2\n',
        },
        {
          type: 'patch',
          path: 'src/three.ts',
          content:
            '@@ -1,1 +1,1 @@\n-const three = 1\n+const three = 2\n',
        },
      ],
      cwd: '/repo',
      fs,
      signal: controller.signal,
    })

    const mutation = fileMutationResultV1Schema.parse(
      result[0]?.type === 'json' ? result[0].value : null,
    )
    // The applied changes were rolled back through the shared in-memory
    // rollback path, so the outcome is the structured rolled_back shape —
    // with a 'cancelled' error naming the abort, not an io_error.
    expect(mutation.outcome).toBe('rolled_back')
    expect(mutation.errors).toEqual([
      expect.objectContaining({ code: 'cancelled' }),
    ])
    expect(mutation.authorityReceipt).toMatchObject({ status: 'rolled_back' })
    // Exactly ONE change committed before the abort stopped the loop.
    expect(commits).toBe(1)
    // The rollback restored the already-applied change and the remaining
    // changes were never applied.
    expect(files['/repo/src/one.ts']).toBe('const one = 1\n')
    expect(files['/repo/src/two.ts']).toBe('const two = 1\n')
    expect(files['/repo/src/three.ts']).toBe('const three = 1\n')
  })

  test('returns a structured resource-limit result for oversized transactions', async () => {
    const fs = createMockFs()
    const result = await changeFiles({
      parameters: Array.from(
        { length: MAX_FILE_CHANGES_PER_TRANSACTION + 1 },
        (_, index) => ({
          type: 'file' as const,
          path: `file-${index}.txt`,
          content: 'x',
          expectedHash: null,
        }),
      ),
      cwd: '/repo',
      fs,
    })
    expect(result[0]?.type === 'json' ? result[0].value : null).toMatchObject({
      kind: 'file_mutation_result',
      outcome: 'not_applied',
      errors: [
        expect.objectContaining({
          code: 'resource_limit',
          recovery: 'split_transaction',
        }),
      ],
    })
  })
})
