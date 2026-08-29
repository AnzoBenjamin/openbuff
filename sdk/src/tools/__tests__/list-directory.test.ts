import { describe, expect, test } from 'bun:test'
import { promises as nodeFs } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'os'
import path from 'path'

import { OWNED_TEMP_SEGMENT_PATTERNS } from '@codebuff/common/util/project-path-containment'

import {
  listDirectory,
  supportsStreamDirectory,
  MAX_LIST_DIRECTORY_ENTRIES,
} from '../list-directory'
import { createNodeFileSystem } from '../node-filesystem'

import type { CodebuffToolOutput } from '@codebuff/common/tools/list'
import type {
  CodebuffFileSystem,
  CodebuffStreamDirectory,
} from '@codebuff/common/types/filesystem'
import type { Dirent, PathLike } from 'fs'
import type { FileFilter } from '../read-files'

/**
 * The single JSON value list_directory returns, derived from the tool schema so
 * a schema change surfaces here as a type error instead of silent drift.
 */
type ListDirectoryValue = CodebuffToolOutput<'list_directory'>[0]['value']
type ListDirectorySuccess = Exclude<
  ListDirectoryValue,
  { errorMessage: string }
>
type ListDirectoryFailure = Extract<
  ListDirectoryValue,
  { errorMessage: string }
>

/**
 * listDirectory only ever calls `readdir`/`streamDirectory` and `realpath` (the
 * latter through the containment resolver), so the stub seeds exactly those
 * members and lets the cast cover the rest of the CodebuffFileSystem surface.
 */
function makeFs(
  overrides: Partial<CodebuffFileSystem> = {},
): CodebuffFileSystem {
  return {
    readdir: async () => [],
    realpath: async (p: PathLike) => String(p),
    ...overrides,
  } as unknown as CodebuffFileSystem
}

/**
 * `readdir` stub for cases where reaching `readdir` is itself the failure,
 * centralizing the overload cast.
 */
function makeThrowingReaddir(
  message = 'should not reach readdir',
): CodebuffFileSystem['readdir'] {
  return (async () => {
    throw new Error(message)
  }) as unknown as CodebuffFileSystem['readdir']
}

/**
 * Filesystem whose `readdir` must never be reached: containment must reject
 * before any listing happens. Extra members (e.g. a `realpath` stub) are
 * layered on top; a caller-supplied `readdir` would defeat the point of this
 * helper and is excluded at the type level rather than by a runtime branch.
 */
function rejectingFs(
  overrides: Omit<Partial<CodebuffFileSystem>, 'readdir'> = {},
): CodebuffFileSystem {
  return makeFs({
    ...overrides,
    readdir: makeThrowingReaddir(),
  })
}

/**
 * Minimal Dirent stub; the single cast lives here instead of at every call
 * site. `kind: 'other'` covers an entry that is neither a file nor a directory
 * (symlink, socket, fifo, ...) — the silently-dropped branch of the entry loop.
 */
function dirent(name: string, kind: 'file' | 'dir' | 'other' = 'file'): Dirent {
  return {
    name,
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
  } as unknown as Dirent
}

/** `readdir` stub that also records the paths it was asked to list. */
type ReaddirStub = CodebuffFileSystem['readdir'] & { calls: string[] }

/**
 * `readdir` stub returning fixed entries, centralizing the overload cast. The
 * recorded `calls` let a test pin that listing happened on the resolved real
 * path rather than the raw caller-supplied input.
 */
function makeReaddir(entries: Dirent[]): ReaddirStub {
  const calls: string[] = []
  const readdir = async (target: PathLike) => {
    calls.push(String(target))
    return entries
  }
  return Object.assign(readdir, { calls }) as unknown as ReaddirStub
}

/**
 * `CodebuffStreamDirectory.readdirView` is spelled as the `fs.promises` member
 * rather than `CodebuffFileSystemBase['readdir']` so the exported type's
 * closure stays self-contained in the published `.d.ts` bundle. This pins the
 * two spellings as mutually assignable, so the self-contained spelling cannot
 * drift from the adapter surface callers actually compare against.
 */
type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false
const readdirViewMatchesAdapterReaddir: MutuallyAssignable<
  CodebuffStreamDirectory['readdirView'],
  CodebuffFileSystem['readdir']
> = true
void readdirViewMatchesAdapterReaddir

/**
 * Export-closure check for the published `.d.ts` bundle: an adapter author must
 * be able to satisfy the capability using only `CodebuffStreamDirectory` plus
 * the `fs` types it names, without the sibling aliases the SDK also publishes.
 * Annotating a value with the type alone is what pins that: it stops compiling
 * if `CodebuffStreamDirectory` ever reaches back into an alias that does not
 * resolve on its own.
 */
const selfContainedStreamDirectory: CodebuffStreamDirectory = Object.assign(
  async (_directoryPath: PathLike) => ({
    async *[Symbol.asyncIterator]() {
      yield dirent('closure.txt')
    },
  }),
  { readdirView: nodeFs.readdir },
)
void selfContainedStreamDirectory

/**
 * Streaming `streamDirectory` stub. `pulled` counts the entries the consumer
 * actually requested, which is what pins the bounded-memory walk:
 * list-directory must stop one past the cap instead of draining the directory.
 */
type StreamDirectoryStub = {
  (directoryPath: PathLike): Promise<AsyncIterable<Dirent>>
  calls: string[]
  pulled: number
  /** Set when the consumer ended iteration early via the iterator's return(). */
  released: boolean
  /** The readdir this streaming view claims to enumerate; see streamingFs. */
  readdirView: CodebuffFileSystem['readdir']
}

/** Placeholder pairing: matches no filesystem until streamingFs pairs the stub. */
const unpairedReaddirView = makeThrowingReaddir('unpaired streamDirectory')

function makeStreamDirectory(entries: Iterable<Dirent>): StreamDirectoryStub {
  const calls: string[] = []
  const stub: StreamDirectoryStub = Object.assign(
    async (directoryPath: PathLike) => {
      calls.push(String(directoryPath))
      return {
        async *[Symbol.asyncIterator]() {
          // The `finally` runs when the consumer breaks out of `for await`,
          // which is exactly the handle-release contract the capability
          // documents for implementers.
          try {
            for (const entry of entries) {
              stub.pulled += 1
              yield entry
            }
          } finally {
            stub.released = true
          }
        },
      }
    },
    {
      calls,
      pulled: 0,
      released: false,
      readdirView: unpairedReaddirView,
    },
  )
  return stub
}

/**
 * Filesystem opting in to streaming via `streamDirectory`. `readdir` throws:
 * the streaming path must take precedence once the host opts in.
 *
 * The capability is paired with this filesystem's own `readdir` through
 * `readdirView`, exactly as `createNodeFileSystem()` does; listDirectory
 * ignores an unpaired capability.
 */
function streamingFs(streamDirectory: StreamDirectoryStub): CodebuffFileSystem {
  const readdir = makeThrowingReaddir()
  streamDirectory.readdirView = readdir
  return makeFs({ streamDirectory, readdir })
}

/** Lazily produced entries, so `pulled` reflects real consumer demand. */
function* countingEntries(total: number): Generator<Dirent> {
  for (let index = 0; index < total; index += 1) {
    yield dirent(`file-${index}.txt`)
  }
}

/**
 * `realpath` stub over an explicit path->realpath map; unmapped inputs resolve
 * to themselves. Centralizes the CodebuffFileSystem['realpath'] cast so only
 * the assertion-relevant mapping stays visible in each test.
 */
function makeRealpath(
  map: Record<string, string>,
): CodebuffFileSystem['realpath'] {
  return (async (input: PathLike) => {
    const key = String(input)
    return map[key] ?? key
  }) as unknown as CodebuffFileSystem['realpath']
}

/** Always-failing `realpath`, using the same cast as `makeRealpath`. */
function makeFailingRealpath(error: Error): CodebuffFileSystem['realpath'] {
  return (async () => {
    throw error
  }) as unknown as CodebuffFileSystem['realpath']
}

function getValue(
  result: CodebuffToolOutput<'list_directory'>,
): ListDirectoryValue {
  return result[0].value
}

/**
 * Narrows the output union to its success branch. The `expect` runs first so a
 * mismatch reports as a diffed assertion; the throw only narrows the type.
 */
function expectListing(
  result: CodebuffToolOutput<'list_directory'>,
): ListDirectorySuccess {
  const value = getValue(result)
  expect(value).not.toHaveProperty('errorMessage')
  if ('errorMessage' in value) {
    throw new Error(
      `Expected a successful listing, got error: ${value.errorMessage}`,
    )
  }
  return value
}

/** Narrows the output union to its error branch; see `expectListing`. */
function expectFailure(
  result: CodebuffToolOutput<'list_directory'>,
): ListDirectoryFailure {
  const value = getValue(result)
  expect(value).toHaveProperty('errorMessage')
  if (!('errorMessage' in value)) {
    throw new Error(
      `Expected an error result, got a listing of ${value.files.length} file(s)`,
    )
  }
  return value
}

/** Asserts the shared containment-reject error; used by every reject case. */
function expectContainmentRejection(
  result: CodebuffToolOutput<'list_directory'>,
): void {
  expect(expectFailure(result).errorMessage).toMatch(
    /outside the project directory/i,
  )
}

/** True when `segment` is an owned-temp top-level segment per the shared list. */
function isOwnedTempSegment(segment: string): boolean {
  return OWNED_TEMP_SEGMENT_PATTERNS.some((pattern) => pattern.test(segment))
}

describe('listDirectory containment', () => {
  test('rejects sibling /project-evil when project is /project', async () => {
    const result = await listDirectory({
      directoryPath: '/project-evil',
      projectPath: '/project',
      fs: rejectingFs(),
    })
    expectContainmentRejection(result)
  })

  test('rejects nested sibling /project-evil/sub', async () => {
    const result = await listDirectory({
      directoryPath: '/project-evil/sub',
      projectPath: '/project',
      fs: rejectingFs(),
    })
    expectContainmentRejection(result)
  })

  test('rejects sibling-prefix via relative traversal to sibling', async () => {
    const result = await listDirectory({
      directoryPath: '../project-evil',
      projectPath: '/project',
      fs: rejectingFs(),
    })
    expectContainmentRejection(result)
  })

  test('rejects symlink escape via injected filesystem realpath', async () => {
    const fs = rejectingFs({
      realpath: makeRealpath({ '/virtual/repo/link': '/outside' }),
    })
    const result = await listDirectory({
      directoryPath: 'link',
      projectPath: '/virtual/repo',
      fs,
    })
    expectContainmentRejection(result)
  })

  test('rejects symlink escape via nested path under symlink', async () => {
    const fs = rejectingFs({
      realpath: makeRealpath({
        '/virtual/repo/evil': '/outside',
        '/virtual/repo/evil/subdir': '/outside/subdir',
      }),
    })
    const result = await listDirectory({
      directoryPath: 'evil/subdir',
      projectPath: '/virtual/repo',
      fs,
    })
    expectContainmentRejection(result)
  })

  test('rejects absolute sibling even when lexical prefix matches', async () => {
    const result = await listDirectory({
      directoryPath: '/a/project-evil',
      projectPath: '/a/project',
      fs: rejectingFs(),
    })
    expectContainmentRejection(result)
  })

  test('allows in-project directory when symlink points inside', async () => {
    const readdir = makeReaddir([dirent('file.txt')])
    const fs = makeFs({
      realpath: makeRealpath({ '/virtual/repo/link': '/virtual/repo/real' }),
      readdir,
    })
    const result = await listDirectory({
      directoryPath: 'link',
      projectPath: '/virtual/repo',
      fs,
    })
    expect(expectListing(result).files).toEqual(['file.txt'])
    // The listing must run on the dereferenced target, not the raw 'link'
    // input: otherwise a later symlink swap could redirect the operation.
    expect(readdir.calls).toEqual(['/virtual/repo/real'])
  })

  test('lists an owned-temp directory outside the project', async () => {
    // scope === 'owned-temp' resolution yields an ABSOLUTE relativePath, which
    // is what gets joined with each entry name before isReadPathBlocked. This
    // pins the entry-filter behaviour for that shape, including the mandatory
    // sensitive-path block ('.env' must not survive the exact arrays below).
    const ownedTempSegment = 'openbuff-xyz'
    // Precondition: the segment really is owned-temp per the shared pattern
    // list. Without this the case would silently degrade into a plain
    // containment reject if the owned-temp prefix ever changed.
    expect(isOwnedTempSegment(ownedTempSegment)).toBe(true)

    const ownedTempDir = path.join(os.tmpdir(), ownedTempSegment)
    const fs = makeFs({
      readdir: makeReaddir([
        dirent('job.log'),
        dirent('.env'),
        dirent('nested', 'dir'),
      ]),
    })
    const result = await listDirectory({
      directoryPath: ownedTempDir,
      projectPath: '/virtual/repo',
      fs,
    })
    const value = expectListing(result)
    expect(value.files).toEqual(['job.log'])
    expect(value.directories).toEqual(['nested'])
    expect(value.path).toBe(ownedTempDir)
  })

  test('rejects a non-owned temp sibling outside the project', async () => {
    // Negative counterpart to the owned-temp case: an equally out-of-project
    // temp sibling whose segment matches no owned-temp pattern must still be
    // rejected, so the allow above is attributable to owned-temp scope rather
    // than to temp paths being generally reachable.
    const foreignTempSegment = 'not-owned-xyz'
    expect(isOwnedTempSegment(foreignTempSegment)).toBe(false)

    const result = await listDirectory({
      directoryPath: path.join(os.tmpdir(), foreignTempSegment),
      projectPath: '/virtual/repo',
      fs: rejectingFs(),
    })
    expectContainmentRejection(result)
  })
})

describe('listDirectory listing behaviour', () => {
  test('drops entries that are neither file nor directory', async () => {
    // Boundary case for the entry loop's silently-dropped branch: a dirent
    // with isDirectory() === false && isFile() === false (symlink/socket)
    // must land in neither bucket. The exact arrays also pin the mandatory
    // sensitive-path block (isReadPathBlocked with no fileFilter) for the
    // ordinary in-project relative shape: the entry name is joined onto the
    // relative path before the check, so a regression in that join would
    // surface '.env' here.
    const readdir = makeReaddir([
      dirent('file.txt'),
      dirent('.env'),
      dirent('nested', 'dir'),
      dirent('socket.sock', 'other'),
    ])
    const fs = makeFs({ readdir })
    const result = await listDirectory({
      directoryPath: 'src',
      projectPath: '/virtual/repo',
      fs,
    })
    const value = expectListing(result)
    expect(value.files).toEqual(['file.txt'])
    expect(value.directories).toEqual(['nested'])
    // Pins the logical-path echo for the common in-project shape (the
    // owned-temp case covers the absolute-relativePath shape).
    expect(value.path).toBe('src')
    // Listing happens on the resolved real path, while `path` echoes the
    // logical input.
    expect(readdir.calls).toEqual(['/virtual/repo/src'])
  })

  test('omits entries a fileFilter reports as blocked', async () => {
    const fs = makeFs({
      readdir: makeReaddir([
        dirent('kept.txt'),
        dirent('blocked.txt'),
        dirent('nested', 'dir'),
        dirent('blocked-dir', 'dir'),
      ]),
    })
    // The filter sees the project-relative entry path, not the bare name, and
    // is applied to both buckets, so a blocked directory must be dropped too.
    const seen: string[] = []
    const fileFilter: FileFilter = (filePath) => {
      seen.push(filePath)
      return {
        status:
          filePath.endsWith('blocked.txt') || filePath.endsWith('blocked-dir')
            ? 'blocked'
            : 'allow',
      }
    }
    const result = await listDirectory({
      directoryPath: 'src',
      projectPath: '/virtual/repo',
      fs,
      fileFilter,
    })
    const value = expectListing(result)
    expect(value.files).toEqual(['kept.txt'])
    expect(value.directories).toEqual(['nested'])
    expect(seen).toContain('src/blocked.txt')
    expect(seen).toContain('src/blocked-dir')
  })

  test('streams entries when the filesystem opts in to streamDirectory', async () => {
    const streamDirectory = makeStreamDirectory([
      dirent('kept.txt'),
      dirent('.env'),
      dirent('nested', 'dir'),
      dirent('socket.sock', 'other'),
    ])
    const result = await listDirectory({
      directoryPath: 'src',
      projectPath: '/virtual/repo',
      fs: streamingFs(streamDirectory),
    })
    const value = expectListing(result)
    expect(value.files).toEqual(['kept.txt'])
    expect(value.directories).toEqual(['nested'])
    // Streaming iteration runs on the resolved real path; reaching readdir at
    // all would throw from the rejecting stub.
    expect(streamDirectory.calls).toEqual(['/virtual/repo/src'])
  })

  test('ignores an inherited fs.promises opendir member', async () => {
    // An adapter built by inheriting from fs.promises and overriding readdir to
    // serve a virtual view carries opendir on its prototype without opting in.
    // Detection must key on the declared streamDirectory capability, otherwise
    // the listing would silently switch to the host filesystem enumeration.
    const readdir = makeReaddir([
      dirent('virtual.txt'),
      dirent('nested', 'dir'),
    ])
    const hostOpendir = () => {
      throw new Error('should not reach inherited opendir')
    }
    // Same shape as the SDK's own Node adapter: capabilities layered onto an
    // object whose prototype is the host fs.promises surface.
    const fs = Object.assign(
      Object.create({ opendir: hostOpendir }) as CodebuffFileSystem,
      { readdir, realpath: makeRealpath({}) },
    )
    // Precondition: the inherited member really is visible and callable, so a
    // pass here is attributable to the capability check rather than absence.
    expect('opendir' in fs).toBe(true)
    expect(typeof Object.getPrototypeOf(fs).opendir).toBe('function')

    const result = await listDirectory({
      directoryPath: 'src',
      projectPath: '/virtual/repo',
      fs,
    })
    const value = expectListing(result)
    expect(value.files).toEqual(['virtual.txt'])
    expect(value.directories).toEqual(['nested'])
    expect(readdir.calls).toEqual(['/virtual/repo/src'])
  })

  test('ignores a streamDirectory carried over by a decorating adapter', async () => {
    // A consumer builds a virtual adapter by decorating the object
    // createNodeFileSystem() returns and overriding readdir. Because
    // streamDirectory is an own property it is copied by the spread, so the
    // capability alone cannot be trusted: without the readdirView pairing the
    // listing would silently enumerate the host filesystem instead of the
    // consumer's virtual view.
    const hostStream = makeStreamDirectory([
      dirent('host.txt'),
      dirent('host-dir', 'dir'),
    ])
    const host = streamingFs(hostStream)
    const readdir = makeReaddir([
      dirent('virtual.txt'),
      dirent('nested', 'dir'),
    ])
    const decorated: CodebuffFileSystem = { ...host, readdir }
    // Preconditions: the capability really did survive decoration as an own
    // property, and it is no longer paired with the adapter's readdir.
    expect(Object.hasOwn(decorated, 'streamDirectory')).toBe(true)
    expect(decorated.streamDirectory).toBe(hostStream)
    expect(hostStream.readdirView).not.toBe(decorated.readdir)

    const result = await listDirectory({
      directoryPath: 'src',
      projectPath: '/virtual/repo',
      fs: decorated,
    })
    const value = expectListing(result)
    expect(value.files).toEqual(['virtual.txt'])
    expect(value.directories).toEqual(['nested'])
    expect(readdir.calls).toEqual(['/virtual/repo/src'])
    // The host streaming view must not have been consulted at all.
    expect(hostStream.calls).toEqual([])
    expect(hostStream.pulled).toBe(0)
  })

  test('falls back to readdir when streamDirectory is present but not callable', async () => {
    // The `typeof streamDirectory !== 'function'` guard exists for adapters
    // that expose the capability with a non-function value; the readdir path
    // must still run.
    const readdir = makeReaddir([dirent('kept.txt'), dirent('nested', 'dir')])
    const fs = Object.assign(makeFs({ readdir }), { streamDirectory: 'nope' })
    const result = await listDirectory({
      directoryPath: 'src',
      projectPath: '/virtual/repo',
      fs,
    })
    const value = expectListing(result)
    expect(value.files).toEqual(['kept.txt'])
    expect(value.directories).toEqual(['nested'])
    expect(readdir.calls).toEqual(['/virtual/repo/src'])
  })

  test('stops streaming one entry past the cap and releases the handle', async () => {
    const streamDirectory = makeStreamDirectory(
      countingEntries(MAX_LIST_DIRECTORY_ENTRIES + 100),
    )
    const result = await listDirectory({
      directoryPath: 'huge',
      projectPath: '/virtual/repo',
      fs: streamingFs(streamDirectory),
    })
    expect(expectFailure(result).errorMessage).toMatch(/too large/i)
    // Resource safety: an adversarial directory must never be materialized in
    // full. One entry past the cap is what makes 'over the cap' decidable.
    expect(streamDirectory.pulled).toBe(MAX_LIST_DIRECTORY_ENTRIES + 1)
    // Early termination must invoke the iterator's return(), the cleanup hook
    // the capability's documented obligations rely on.
    expect(streamDirectory.released).toBe(true)
  })

  test('reports only the errno code when the listing fails', async () => {
    // The raw message names the resolved absolute path; none of it may survive.
    const fs = makeFs({
      readdir: async () => {
        throw Object.assign(
          new Error("EACCES: permission denied, scandir '/virtual/repo/src'"),
          { code: 'EACCES' },
        )
      },
    })
    const result = await listDirectory({
      directoryPath: 'src',
      projectPath: '/virtual/repo',
      fs,
    })
    const value = expectFailure(result)
    expect(value.errorMessage).toBe("Failed to list directory 'src' (EACCES)")
    // Deliberate shape change from `Failed to list directory: <fs message>`:
    // only the leading text survives (see the SDK CHANGELOG [Unreleased] entry).
    expect(value.errorMessage.startsWith('Failed to list directory')).toBe(true)
    expect(value.errorMessage).not.toContain('Failed to list directory: ')
    // No part of the raw failure text is echoed, which is what the shape
    // change buys: the raw message named a path this call never resolved.
    expect(value.errorMessage).not.toContain('permission denied')
    expect(value.errorMessage).not.toContain('scandir')
  })

  test('redacts projectPath from a failure raised around path resolution', async () => {
    // The containment resolver tolerates a realpath failure (it falls back to
    // the lexical path), so the surfaced failure is the listing one — and its
    // message names projectPath only, never the resolved '/virtual/repo/src'.
    // Redaction must not depend on which path the raw message happens to name.
    const leak = Object.assign(
      new Error("EPERM: operation not permitted, scandir '/virtual/repo'"),
      { code: 'EPERM' },
    )
    const fs = makeFs({
      realpath: makeFailingRealpath(leak),
      readdir: async () => {
        throw leak
      },
    })
    const result = await listDirectory({
      directoryPath: 'src',
      projectPath: '/virtual/repo',
      fs,
    })
    expect(expectFailure(result).errorMessage).toBe(
      "Failed to list directory 'src' (EPERM)",
    )
  })

  test('omits detail entirely for an error without an errno code', async () => {
    const fs = makeFs({
      readdir: async () => {
        throw new Error('boom')
      },
    })
    const result = await listDirectory({
      directoryPath: 'src',
      projectPath: '/virtual/repo',
      fs,
    })
    expect(expectFailure(result).errorMessage).toBe(
      "Failed to list directory 'src'",
    )
  })

  test('drops an uppercase code longer than the errno token bound', async () => {
    // The allowlist is length-bounded, so uppercase text alone cannot push an
    // arbitrarily long adapter-set string into tool output.
    const fs = makeFs({
      readdir: async () => {
        throw Object.assign(new Error('nope'), { code: 'A'.repeat(33) })
      },
    })
    const result = await listDirectory({
      directoryPath: 'src',
      projectPath: '/virtual/repo',
      fs,
    })
    expect(expectFailure(result).errorMessage).toBe(
      "Failed to list directory 'src'",
    )
  })

  test('drops a code that is not a canonical errno token', async () => {
    // `code` is only echoed because a real errno is a fixed uppercase token.
    // An adapter putting arbitrary text there must not open a leak channel.
    const fs = makeFs({
      readdir: async () => {
        throw Object.assign(new Error('nope'), { code: '/elsewhere/secret' })
      },
    })
    const result = await listDirectory({
      directoryPath: 'src',
      projectPath: '/virtual/repo',
      fs,
    })
    expect(expectFailure(result).errorMessage).toBe(
      "Failed to list directory 'src'",
    )
  })

  test('normalizes backslash separators in the resolved relative path', async () => {
    // Covers list-directory's `resolved.relativePath.replace(/\\/g, '/')`. On a
    // POSIX host a backslash is a legal filename character, so the resolver
    // returns a relativePath carrying the backslashes verbatim and this replace
    // is the only thing that turns them into separators.
    //
    // The input carries TWO runtime backslashes on purpose: read-policy
    // normalizes backslashes again on the joined entry path, so a single
    // runtime backslash would be indistinguishable ('src\\sub/kept.txt' and
    // 'src/sub/kept.txt' both end up as 'src/sub/kept.txt'). With two, the
    // replace makes path.posix.join collapse 'src//sub' to 'src/sub', while
    // dropping it leaves read-policy handing the filter 'src//sub/kept.txt'.
    const fs = makeFs({
      readdir: makeReaddir([dirent('kept.txt'), dirent('blocked.txt')]),
    })
    const seen: string[] = []
    const fileFilter: FileFilter = (filePath) => {
      seen.push(filePath)
      return {
        status: filePath === 'src/sub/blocked.txt' ? 'blocked' : 'allow',
      }
    }
    const result = await listDirectory({
      directoryPath: 'src\\\\sub',
      projectPath: '/virtual/repo',
      fs,
      fileFilter,
    })
    const value = expectListing(result)
    expect(seen).toContain('src/sub/kept.txt')
    expect(seen.some((filePath) => filePath.includes('//'))).toBe(false)
    // The blocked entry proves the normalized path is what actually reached
    // the filter, not just an incidentally-cleaned copy of it.
    expect(value.files).toEqual(['kept.txt'])
  })

  test('lists exactly MAX_LIST_DIRECTORY_ENTRIES entries without erroring', async () => {
    // Boundary case for the `>` comparison: the cap itself must still succeed,
    // so an off-by-one flip to `>=` fails here.
    const fs = makeFs({
      readdir: makeReaddir(
        Array.from({ length: MAX_LIST_DIRECTORY_ENTRIES }, (_, i) =>
          dirent(`file-${i}.txt`),
        ),
      ),
    })
    const result = await listDirectory({
      directoryPath: 'at-cap',
      projectPath: '/virtual/repo',
      fs,
    })
    expect(expectListing(result).files.length).toBe(MAX_LIST_DIRECTORY_ENTRIES)
  })

  test('caps huge listings via error to preserve contract', async () => {
    const fs = makeFs({
      readdir: makeReaddir(
        Array.from({ length: MAX_LIST_DIRECTORY_ENTRIES + 1 }, (_, i) =>
          dirent(`file-${i}.txt`),
        ),
      ),
    })
    const result = await listDirectory({
      directoryPath: 'huge',
      projectPath: '/virtual/repo',
      fs,
    })
    const value = expectFailure(result)
    // Must preserve the original error contract for large dirs so persisted
    // error handling and consumers expecting errorMessage continue to work.
    expect(value.errorMessage).toMatch(/too large/i)
    expect('files' in value).toBe(false)
    // Deliberate text change, not a verbatim carry-over: the observed entry
    // count and the previous `exceeds limit of <cap>` phrasing are gone. The
    // "more than" bound is uniform across both read paths even though only
    // the streaming path is unable to learn the true total. See the SDK
    // CHANGELOG [Unreleased] entry for the migration.
    expect(value.errorMessage).toBe(
      `Directory listing too large: more than ${MAX_LIST_DIRECTORY_ENTRIES} entries. List a specific subdirectory instead.`,
    )
    expect(value.errorMessage).not.toContain('exceeds limit of')
    // The guidance must name an action the model can take through this tool:
    // fileFilter is supplied host-side and is not a list_directory input.
    expect(value.errorMessage).not.toContain('fileFilter')
  })
})

describe('supportsStreamDirectory', () => {
  test('reports true only for a capability paired with the adapter readdir', async () => {
    const fs = streamingFs(makeStreamDirectory([dirent('kept.txt')]))
    expect(supportsStreamDirectory(fs)).toBe(true)
  })

  test('reports false when the capability is absent', async () => {
    expect(supportsStreamDirectory(makeFs())).toBe(false)
  })

  test('reports false when the capability is not callable', async () => {
    const fs = Object.assign(makeFs(), { streamDirectory: 'nope' })
    expect(supportsStreamDirectory(fs)).toBe(false)
  })

  test('reports false for a capability carried over by a decorating adapter', async () => {
    // Same mis-wiring the listing path ignores: presence of the member is only
    // half the contract, so the published predicate must apply the readdirView
    // pairing too or consumers would disagree with the tool's own decision.
    const host = streamingFs(makeStreamDirectory([dirent('host.txt')]))
    const decorated: CodebuffFileSystem = {
      ...host,
      readdir: makeReaddir([dirent('virtual.txt')]),
    }
    expect(Object.hasOwn(decorated, 'streamDirectory')).toBe(true)
    expect(supportsStreamDirectory(decorated)).toBe(false)
  })

  test('agrees with the path listDirectory actually takes', async () => {
    // Pins the predicate to observable behaviour: the streaming filesystem's
    // readdir throws, so a listing succeeding is only possible via streaming.
    const streamDirectory = makeStreamDirectory([dirent('kept.txt')])
    const fs = streamingFs(streamDirectory)
    expect(supportsStreamDirectory(fs)).toBe(true)
    const result = await listDirectory({
      directoryPath: 'src',
      projectPath: '/virtual/repo',
      fs,
    })
    expect(expectListing(result).files).toEqual(['kept.txt'])
    expect(streamDirectory.calls).toEqual(['/virtual/repo/src'])
  })
})

describe('createNodeFileSystem streaming capability', () => {
  test('is reported as streaming by the published capability predicate', async () => {
    expect(supportsStreamDirectory(createNodeFileSystem())).toBe(true)
  })

  test('pairs streamDirectory with its own readdir and yields Dirents', async () => {
    const fs = createNodeFileSystem()
    const streamDirectory = fs.streamDirectory
    expect(typeof streamDirectory).toBe('function')
    // Load-bearing pairing: listDirectory only streams when readdirView is the
    // adapter's current readdir. It holds because the adapter object inherits
    // both members from fs.promises (neither is an own or bound copy), so a
    // refactor that wraps or rebinds either one silently drops every Node
    // listing back to full readdir materialization.
    expect(streamDirectory!.readdirView).toBe(nodeFs.readdir)
    expect(streamDirectory!.readdirView).toBe(fs.readdir)

    const directory = await mkdtemp(path.join(os.tmpdir(), 'openbuff-stream-'))
    try {
      await writeFile(path.join(directory, 'kept.txt'), 'x')
      await mkdir(path.join(directory, 'nested'))

      // The capability really iterates real Dirents for a real directory.
      const names: string[] = []
      for await (const entry of await streamDirectory!.call(fs, directory)) {
        expect(typeof entry.isDirectory).toBe('function')
        names.push(entry.name)
      }
      expect(names.sort()).toEqual(['kept.txt', 'nested'])

      // End to end through listDirectory, which takes the streaming path only
      // because the pairing above holds.
      const result = await listDirectory({
        directoryPath: '.',
        projectPath: directory,
        fs,
      })
      const value = expectListing(result)
      expect(value.files).toEqual(['kept.txt'])
      expect(value.directories).toEqual(['nested'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
