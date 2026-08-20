import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { getOwnedTempRoots } from '@codebuff/common/util/project-path-containment'

import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'

import { createNodeFileSystem } from '../tools/node-filesystem'
import {
  FilesystemAuthority,
  MAX_COMMIT_RECEIPTS_PER_RUN,
  allowAllFilesystemPolicy,
  detectFilesystemCapabilities,
  hashFileContent,
} from '../tools/filesystem-authority'

function fsError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code })
}

function makeFileSystem(
  options: {
    realpaths?: Record<string, string>
    files?: Record<string, string | Uint8Array>
    capabilities?: Partial<CodebuffFileSystem>
  } = {},
): CodebuffFileSystem {
  const files = new Map(Object.entries(options.files ?? {}))
  const directories = new Set([
    '/repo',
    '/repo/link',
    '/real/repo',
    '/real/repo/actual',
  ])
  return {
    mkdir: async (input) => {
      directories.add(String(input))
      return undefined
    },
    readdir: async () => [],
    readFile: (async (input: string) => {
      const value = files.get(String(input))
      if (value === undefined) throw fsError('ENOENT')
      return typeof value === 'string' ? Buffer.from(value) : Buffer.from(value)
    }) as CodebuffFileSystem['readFile'],
    realpath: (async (input: string) => {
      const value = options.realpaths?.[String(input)]
      if (value) return value
      if (directories.has(String(input)) || files.has(String(input))) {
        return String(input)
      }
      throw fsError('ENOENT')
    }) as CodebuffFileSystem['realpath'],
    stat: (async (input: string) => {
      if (!directories.has(String(input)) && !files.has(String(input))) {
        throw fsError('ENOENT')
      }
      return { isFile: () => files.has(String(input)) }
    }) as CodebuffFileSystem['stat'],
    unlink: async (input) => {
      files.delete(String(input))
    },
    writeFile: async (input, data) => {
      const view = data as NodeJS.ArrayBufferView
      files.set(
        String(input),
        typeof data === 'string'
          ? data
          : new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
      )
    },
    ...options.capabilities,
  } as CodebuffFileSystem
}

async function authorize(
  authority: FilesystemAuthority,
  input = 'src/file.ts',
) {
  const result = await authority.authorizePath(input, 'overwrite')
  if (!result.allowed) throw new Error(result.code)
  return result.path
}

describe('FilesystemAuthority paths and policy', () => {
  test('rejects lexical escapes and resolves a create through its canonical parent', async () => {
    const fileSystem = makeFileSystem({
      realpaths: {
        '/repo': '/real/repo',
        '/repo/link': '/real/repo/actual',
      },
    })
    const authority = new FilesystemAuthority(
      '/repo',
      fileSystem,
      allowAllFilesystemPolicy,
    )

    expect((await authority.authorizePath('../secret', 'read')).allowed).toBe(
      false,
    )
    const result = await authority.authorizePath('link/new.ts', 'create')
    expect(result).toEqual({
      allowed: true,
      path: {
        lexicalPath: '/repo/link/new.ts',
        canonicalPath: '/real/repo/actual/new.ts',
        canonicalParentPath: '/real/repo/actual',
        portablePath: 'link/new.ts',
        operationPath: '/real/repo/actual/new.ts',
        redactPath: false,
        scope: 'project',
      },
    })
  })

  test('uses mandatory composed policy hooks', async () => {
    const phases: string[] = []
    const authority = new FilesystemAuthority('/repo', makeFileSystem(), {
      name: 'deny-secrets',
      evaluate(context) {
        phases.push(`${context.phase}:${context.portablePath}`)
        return { allowed: !context.portablePath.includes('secret') }
      },
    })
    expect((await authority.authorizePath('secret.txt', 'read')).allowed).toBe(
      false,
    )
    expect(phases).toEqual(['resolve:secret.txt'])
  })
})

describe('FilesystemAuthority locks and leases', () => {
  test('takes multi-path locks in canonical total order without interleaving', async () => {
    const authority = new FilesystemAuthority(
      '/repo',
      makeFileSystem(),
      allowAllFilesystemPolicy,
    )
    const events: string[] = []
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })

    const first = authority.withPathLocks(['/repo/b', '/repo/a'], async () => {
      events.push('first:start')
      markFirstStarted()
      await firstGate
      events.push('first:end')
    })
    await firstStarted
    const second = authority.withPathLocks(['/repo/a', '/repo/b'], async () => {
      events.push('second:start')
      events.push('second:end')
    })
    expect(events).toEqual(['first:start'])
    releaseFirst()
    await Promise.all([first, second])
    expect(events).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ])
  })

  test('cancel wins while open and commit wins after beginCommit', async () => {
    const authority = new FilesystemAuthority(
      '/repo',
      makeFileSystem(),
      allowAllFilesystemPolicy,
    )
    const file = await authorize(authority)
    authority.registerOperation({
      id: 'cancel-first',
      kind: 'overwrite',
      paths: [file],
    })
    expect(authority.cancel('cancel-first')).toEqual({ cancelled: true })
    expect(authority.beginCommit('cancel-first')).toEqual({
      begun: false,
      state: 'cancelled',
    })

    authority.registerOperation({
      id: 'commit-first',
      kind: 'overwrite',
      paths: [file],
    })
    const begun = authority.beginCommit('commit-first')
    expect(begun.begun).toBe(true)
    expect(authority.cancel('commit-first')).toEqual({
      cancelled: false,
      state: 'committing',
    })
    if (!begun.begun) throw new Error('commit did not begin')
    expect(authority.finishCommit(begun.lease, { succeeded: true })).toEqual({
      finished: true,
      state: 'committed',
    })
  })
})

describe('FilesystemAuthority capabilities, snapshots, and receipts', () => {
  test('[ERR-M04] reports text range capability without pretending unsupported operations are atomic', async () => {
    const baselineFs = makeFileSystem()
    expect(detectFilesystemCapabilities(baselineFs).tier).toBe('baseline')
    const baseline = new FilesystemAuthority(
      '/repo',
      baselineFs,
      allowAllFilesystemPolicy,
    )
    const baselinePath = await authorize(baseline)
    expect(await baseline.createExclusive(baselinePath, 'x')).toEqual({
      supported: false,
      reason: 'unsupported',
    })

    const atomicFs = makeFileSystem({
      capabilities: {
        mutationAuthority: 'native_atomic',
        readRange: async () => ({ data: new Uint8Array(), endExclusive: 0 }),
        readTextRange: async () => ({
          data: new Uint8Array(),
          startLine: 1,
          endLine: 0,
          totalLines: 0,
          complete: true,
        }),
        createFileExclusive: async () => {},
        conditionalCommit: async () => ({ applied: true }),
        conditionalDelete: async () => ({ applied: true }),
        conditionalMove: async () => ({ applied: true }),
      },
    })
    const snapshot = detectFilesystemCapabilities(atomicFs)
    expect(snapshot.tier).toBe('atomic')
    expect([...snapshot.capabilities].sort()).toEqual([
      'baseline',
      'conditional_commit',
      'conditional_delete',
      'conditional_move',
      'exclusive_create',
      'range_read',
      'text_range_read',
    ])

    const cooperativeFs = makeFileSystem({
      capabilities: {
        mutationAuthority: 'cooperative_cas',
        createFileExclusive: async () => {},
        conditionalCommit: async () => ({ applied: true }),
        conditionalDelete: async () => ({ applied: true }),
        conditionalMove: async () => ({ applied: true }),
      },
    })
    expect(detectFilesystemCapabilities(cooperativeFs).tier).toBe(
      'cooperative',
    )

    const undeclaredFs = makeFileSystem({
      capabilities: {
        createFileExclusive: async () => {},
        conditionalCommit: async () => ({ applied: true }),
        conditionalDelete: async () => ({ applied: true }),
        conditionalMove: async () => ({ applied: true }),
      },
    })
    expect(detectFilesystemCapabilities(undeclaredFs).tier).toBe('enhanced')
  })

  test('hashes bytes deterministically and revalidates expected state', async () => {
    const fileSystem = makeFileSystem({
      files: { '/repo/src/file.ts': 'hello' },
    })
    const authority = new FilesystemAuthority(
      '/repo',
      fileSystem,
      allowAllFilesystemPolicy,
    )
    const file = await authorize(authority)
    const hash = hashFileContent(Buffer.from('hello'))
    expect(await authority.snapshot(file)).toEqual({
      state: 'present',
      hash,
      byteLength: 5,
    })
    expect(
      await authority.revalidateExpectedState(file, { state: 'present', hash }),
    ).toEqual({
      matches: true,
      actual: { state: 'present', hash, byteLength: 5 },
    })
  })

  test('retains only the newest bounded receipts', async () => {
    const authority = new FilesystemAuthority(
      '/repo',
      makeFileSystem(),
      allowAllFilesystemPolicy,
    )
    const file = await authorize(authority)
    for (let index = 0; index < MAX_COMMIT_RECEIPTS_PER_RUN + 3; index++) {
      const id = `operation-${index}`
      authority.registerOperation({ id, kind: 'overwrite', paths: [file] })
      authority.cancel(id)
    }
    const receipts = authority.listReceipts()
    expect(receipts).toHaveLength(MAX_COMMIT_RECEIPTS_PER_RUN)
    expect(receipts[0]?.operationId).toBe('operation-3')
    expect(receipts.at(-1)?.operationId).toBe(
      `operation-${MAX_COMMIT_RECEIPTS_PER_RUN + 2}`,
    )
  })

  test('redacts sensitive paths and sanitizes observable error metadata', async () => {
    const authority = new FilesystemAuthority('/repo', makeFileSystem(), {
      name: 'sensitive',
      evaluate: () => ({ allowed: true, redactPath: true }),
    })
    const file = await authorize(authority, 'secrets/token.txt')
    authority.registerOperation({
      id: 'redacted',
      kind: 'overwrite',
      paths: [file],
    })
    const begun = authority.beginCommit('redacted')
    if (!begun.begun) throw new Error('commit did not begin')
    authority.finishCommit(begun.lease, {
      succeeded: false,
      errorCode: 'permission denied: token=super-secret',
    })
    const receipt = authority.listReceipts()[0]
    expect(receipt?.paths[0]?.label).toBe('[redacted]')
    expect(receipt?.paths[0]?.fingerprint).toMatch(/^[a-f0-9]{16}$/)
    expect(JSON.stringify(receipt)).not.toContain('secrets/token.txt')
    expect(JSON.stringify(receipt)).not.toContain('super-secret')
    expect(receipt?.error?.code).toBe('OPERATION_FAILED')
  })
})

describe('FilesystemAuthority owned-temp namespace permits CRUD except live job artifacts', () => {
  // The owned-temp namespace is mutable so tools can manage their own scratch
  // artifacts. Only LIVE background-job log/metadata files stay read-only, and
  // a move may never cross the project/owned-temp boundary.
  const uniqueSuffix = () =>
    `${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  // `getOwnedTempRoots()[0]` rather than a literal `/tmp`: on macOS the OS
  // temp dir is a symlinked `/var/folders/...` path.
  const ownedTempRoot = getOwnedTempRoots()[0]

  let projectRoot: string
  let ownedTempDir: string
  let ownedTempLog: string
  let ownedTempMetadata: string
  let ownedTempScratch: string
  let ownedTempNestedDir: string
  let ownedTempNestedNew: string
  let tmuxCapturesDir: string
  let tmuxCaptureFile: string
  let authority: FilesystemAuthority

  /**
   * Narrows an `authorizePath` result to its `AuthorizedFilesystemPath`.
   * `authorizeMovePair` takes the real authorized values (they carry `scope`
   * plus the canonical/portable members), so they must come from the authority
   * rather than an object literal.
   */
  const authorizedPath = async (
    input: string,
    operation: Parameters<FilesystemAuthority['authorizePath']>[1],
  ) => {
    const result = await authority.authorizePath(input, operation)
    if (!result.allowed) throw new Error(`unexpected refusal: ${result.code}`)
    return result.path
  }

  beforeAll(() => {
    // A NON-`openbuff-` mkdtemp prefix keeps the project scope distinct from
    // the owned-temp scope even though both live under the temp dir.
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsauth-project-'))
    fs.mkdirSync(path.join(projectRoot, 'src'))
    fs.writeFileSync(path.join(projectRoot, 'src', 'file.ts'), 'export {}\n')

    // Scratch artifacts live one level down, inside an owned `openbuff-`
    // directory: `create`/`delete` authorize with `followFinalSymlink: false`,
    // which also contains the PARENT directory, and the bare temp root is
    // never itself owned-temp (strictly-inside rule).
    ownedTempDir = fs.mkdtempSync(
      path.join(ownedTempRoot, 'openbuff-fsauth-jobs-'),
    )
    // Job-shaped artifacts. NOTE: both sit NESTED inside the owned mkdtemp
    // directory, which is exactly what proves the job-artifact carve-out is
    // basename-driven rather than depth-driven — a job-shaped basename is
    // refused at any depth inside the owned namespace.
    ownedTempLog = path.join(ownedTempDir, `openbuff-job-${uniqueSuffix()}.log`)
    fs.writeFileSync(ownedTempLog, 'job log line\n')
    ownedTempMetadata = path.join(
      ownedTempDir,
      `openbuff-${uniqueSuffix()}.json`,
    )
    fs.writeFileSync(ownedTempMetadata, '{"jobId":"fsauth"}\n')

    // An ordinary (non-job-shaped) scratch file: full CRUD is expected here.
    ownedTempScratch = path.join(ownedTempDir, `scratch-${uniqueSuffix()}.txt`)
    fs.writeFileSync(ownedTempScratch, 'scratch\n')

    // A not-yet-existing path under an existing nested scratch directory.
    ownedTempNestedDir = path.join(ownedTempDir, 'nested')
    fs.mkdirSync(ownedTempNestedDir)
    ownedTempNestedNew = path.join(
      ownedTempNestedDir,
      `new-${uniqueSuffix()}.txt`,
    )

    // `tmux-captures-<session>` must be the FIRST segment below the owned temp
    // root for the owned-namespace patterns to match.
    tmuxCapturesDir = path.join(
      ownedTempRoot,
      `tmux-captures-fsauth-${uniqueSuffix()}`,
    )
    fs.mkdirSync(tmuxCapturesDir)
    tmuxCaptureFile = path.join(tmuxCapturesDir, 'capture-0001.txt')
    fs.writeFileSync(tmuxCaptureFile, 'pane output\n')

    authority = new FilesystemAuthority(
      projectRoot,
      createNodeFileSystem(),
      allowAllFilesystemPolicy,
    )
  })

  afterAll(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true })
    fs.rmSync(ownedTempDir, { recursive: true, force: true })
    fs.rmSync(tmuxCapturesDir, { recursive: true, force: true })
  })

  test.each(['read', 'create', 'overwrite', 'delete', 'move'] as const)(
    'allows %s on an ordinary owned-temp scratch file',
    async (operation) => {
      const result = await authority.authorizePath(ownedTempScratch, operation)
      expect(result).toMatchObject({ allowed: true })
      // Asserting the scope rules out a false pass through the project branch
      // (and a `path_outside_project` refusal reported as some other failure).
      if (!result.allowed) throw new Error(result.code)
      expect(result.path.scope).toBe('owned-temp')
    },
  )

  test('allows create of a not-yet-existing nested owned-temp path', async () => {
    const result = await authority.authorizePath(ownedTempNestedNew, 'create')
    expect(result).toMatchObject({ allowed: true })
    if (!result.allowed) throw new Error(result.code)
    expect(result.path.scope).toBe('owned-temp')
  })

  test('allows delete of a nested owned-temp scratch directory', async () => {
    // Tools clean up their own scratch dirs. `delete` authorizes with
    // `followFinalSymlink: false`, so the PARENT must also be contained; the
    // parent here is the owned `openbuff-` mkdtemp dir.
    const result = await authority.authorizePath(ownedTempNestedDir, 'delete')
    expect(result).toMatchObject({ allowed: true })
    if (!result.allowed) throw new Error(result.code)
    expect(result.path.scope).toBe('owned-temp')
  })

  test('authorizes delete of the top-level owned mkdtemp directory itself', async () => {
    // A top-level owned entry has the BARE TEMP ROOT as its parent, and the
    // temp root is deliberately never itself owned-temp (strictly-inside
    // rule). `resolveFilePathFor*Operation` therefore falls back to the
    // already-validated `realFullPath` for the no-follow parent check, so the
    // top-level scratch dir authorizes instead of being refused with
    // `path_outside_project`.
    //
    // This asserts AUTHORIZATION ONLY. No mutation tool currently performs a
    // directory delete through this path (change_file reads the source first
    // and would fail with EISDIR), so this case deliberately does not claim
    // an end-to-end capability.
    const result = await authority.authorizePath(ownedTempDir, 'delete')
    expect(result).toMatchObject({ allowed: true })
    if (!result.allowed) throw new Error(result.code)
    expect(result.path.scope).toBe('owned-temp')
  })

  test.each(['create', 'overwrite', 'delete', 'move'] as const)(
    'refuses %s on a tmux capture file',
    async (operation) => {
      // Captures are verification evidence the PARENT agent reads, so they get
      // the same read-only treatment as live background-job artifacts: a
      // subagent must not be able to rewrite a capture to forge evidence.
      const result = await authority.authorizePath(tmuxCaptureFile, operation)
      expect(result).toEqual({
        allowed: false,
        code: 'owned_temp_capture_read_only',
      })
    },
  )

  test('still allows read of a tmux capture file', async () => {
    const result = await authority.authorizePath(tmuxCaptureFile, 'read')
    expect(result).toMatchObject({ allowed: true })
    if (!result.allowed) throw new Error(result.code)
    expect(result.path.scope).toBe('owned-temp')
  })

  test.each(['create', 'overwrite', 'move'] as const)(
    'refuses %s of an executable-extension owned-temp basename',
    async (operation) => {
      // /tmp tokens are exempt from the terminal command policy's
      // outside-path check, so allowing a tool to write an arbitrary `.sh`
      // into owned temp space would turn a plain file write into a
      // terminal-policy bypass.
      const result = await authority.authorizePath(
        path.join(ownedTempDir, `payload-${uniqueSuffix()}.sh`),
        operation,
      )
      expect(result).toEqual({
        allowed: false,
        code: 'owned_temp_executable_extension_refused',
      })
    },
  )

  test.each(['create', 'overwrite', 'delete', 'move'] as const)(
    'refuses %s on a live background-job log',
    async (operation) => {
      const result = await authority.authorizePath(ownedTempLog, operation)
      expect(result).toEqual({
        allowed: false,
        code: 'owned_temp_job_artifact_read_only',
      })
    },
  )

  test.each(['create', 'overwrite', 'delete', 'move'] as const)(
    'refuses %s on a background-job metadata json',
    async (operation) => {
      const result = await authority.authorizePath(ownedTempMetadata, operation)
      expect(result).toEqual({
        allowed: false,
        code: 'owned_temp_job_artifact_read_only',
      })
    },
  )

  test.each([
    ['job log', () => ownedTempLog],
    ['job metadata json', () => ownedTempMetadata],
  ] as const)('still allows read of the %s', async (_label, getPath) => {
    const result = await authority.authorizePath(getPath(), 'read')
    expect(result).toMatchObject({ allowed: true })
    if (!result.allowed) throw new Error(result.code)
    expect(result.path.scope).toBe('owned-temp')
  })

  test('leaves the project scope unaffected', async () => {
    const result = await authority.authorizePath('src/file.ts', 'overwrite')
    expect(result).toMatchObject({ allowed: true })
    if (!result.allowed) throw new Error(result.code)
    expect(result.path.scope).toBe('project')
  })

  test('allows a move within the project scope', async () => {
    const source = await authorizedPath('src/file.ts', 'move')
    const destination = await authorizedPath('src/moved.ts', 'move')
    expect(authority.authorizeMovePair(source, destination)).toEqual({
      allowed: true,
    })
  })

  test('allows a move within the owned-temp scope', async () => {
    const source = await authorizedPath(ownedTempScratch, 'move')
    const destination = await authorizedPath(ownedTempNestedNew, 'move')
    expect(authority.authorizeMovePair(source, destination)).toEqual({
      allowed: true,
    })
  })

  test('refuses a move from the project into owned-temp', async () => {
    const source = await authorizedPath('src/file.ts', 'move')
    const destination = await authorizedPath(ownedTempScratch, 'move')
    expect(authority.authorizeMovePair(source, destination)).toEqual({
      allowed: false,
      code: 'move_crosses_scope_boundary',
    })
  })

  test('refuses a move from owned-temp into the project', async () => {
    const source = await authorizedPath(ownedTempScratch, 'move')
    const destination = await authorizedPath('src/file.ts', 'move')
    expect(authority.authorizeMovePair(source, destination)).toEqual({
      allowed: false,
      code: 'move_crosses_scope_boundary',
    })
  })
})
