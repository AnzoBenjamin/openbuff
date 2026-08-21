import type fs from 'fs'
import type { Dirent } from 'fs'

export type CodebuffFileContent = string | NodeJS.ArrayBufferView

export type CodebuffRangeReadResult = {
  data: Uint8Array
  /** Byte offset immediately after the returned range. */
  endExclusive: number
}

export type CodebuffTextRangeReadResult = {
  /** Exact bytes for the returned complete lines, without implicit decoding. */
  data: Uint8Array
  /** First returned 1-indexed line. */
  startLine: number
  /** Last returned 1-indexed line, or zero when no lines were returned. */
  endLine: number
  /** Authoritative total visible line count for the file snapshot. */
  totalLines: number
  /** False when maxBytes prevented returning the full requested line span. */
  complete: boolean
}

export type CodebuffConditionalCommitOptions = {
  /** `null` requires the destination to still be absent. */
  expectedHash: string | null
}

export type CodebuffConditionalCommitResult =
  | { applied: true }
  | { applied: false; actualHash: string | null }

export type CodebuffConditionalDeleteResult = CodebuffConditionalCommitResult

export type CodebuffConditionalMoveOptions = {
  expectedSourceHash: string
  /** Guarded moves currently require an absent destination. */
  expectedDestinationHash: null
}

export type CodebuffConditionalMoveResult =
  | { applied: true }
  | {
      applied: false
      actualSourceHash: string | null
      actualDestinationHash: string | null
    }

/**
 * Streaming (lazy) directory iteration, paired with the `readdir` view it
 * enumerates.
 *
 * Implementer obligations:
 * - Callers consume the iterable lazily and stop as soon as they have enough
 *   entries, so the iterator MUST release its directory handle from
 *   `return()` — the method that breaking out of `for await` invokes. Async
 *   generators and Node's `Dir` satisfy this; a hand-written iterator
 *   without `return()` leaks the handle on every bounded listing.
 * - Entries must describe the same directory `readdirView` would list, so
 *   enabling streaming never changes which view is served.
 */
export type CodebuffStreamDirectory = ((
  path: fs.PathLike,
) => Promise<AsyncIterable<Dirent>>) & {
  /**
   * The `readdir` implementation this streaming view claims to enumerate.
   * Spelled as the `fs.promises` member rather than
   * `CodebuffFileSystemBase['readdir']` so this exported type resolves on its
   * own, whichever sibling aliases a consumer imports. The SDK publishes the
   * whole `CodebuffFileSystem` closure — `CodebuffFileSystemBase` included —
   * so both spellings are available; the resolved signature is identical,
   * since `CodebuffFileSystemBase` picks `readdir` from the same source.
   * Callers ignore the capability when the adapter's `readdir` is a different
   * function, so an adapter decorated with a virtual `readdir` (by spread or
   * `Object.create()` over `createNodeFileSystem()`) keeps serving its own
   * view instead of host enumeration. This is a mis-wiring guard rather than a
   * trust boundary: an adapter can set the field to whatever it likes.
   */
  readdirView: (typeof fs.promises)['readdir']
}

/**
 * Optional operations that a filesystem adapter may implement with native or
 * cooperative compare-and-swap authority. Their absence is meaningful:
 * callers must not emulate the guarantee with a check-then-write sequence.
 */
export type CodebuffFileSystemCapabilities = {
  /** Whether process-backed tools observe the same workspace as this adapter. */
  hostProcessView?: boolean
  /**
   * Describes the authority behind conditional mutations. `cooperative_cas`
   * serializes participating Openbuff processes, but cannot exclude arbitrary
   * external filesystem writers.
   */
  mutationAuthority?: 'cooperative_cas' | 'native_atomic'
  readRange?: (
    path: fs.PathLike,
    start: number,
    endExclusive: number,
  ) => Promise<CodebuffRangeReadResult>
  /**
   * Bounded line-oriented text read. Implementations must never return more
   * than maxBytes and must derive all metadata from one coherent snapshot.
   */
  readTextRange?: (
    path: fs.PathLike,
    startLine: number,
    endLine: number,
    maxBytes: number,
  ) => Promise<CodebuffTextRangeReadResult>
  /**
   * Streaming (lazy) directory iteration; see {@link CodebuffStreamDirectory}
   * for the handle-release and `readdirView` pairing obligations.
   *
   * Deliberately NOT named `opendir`: an adapter inheriting from `fs.promises`
   * already carries an `opendir` member, and a colliding name would be
   * auto-detected and silently redirect directory listings to the host
   * filesystem. Declaring this member is therefore an explicit opt-in.
   *
   * Absence — and a `readdirView` that is not the adapter's current `readdir`
   * — means callers fall back to the non-streaming `readdir`; they must not
   * emulate streaming by draining `readdir` first. SDK consumers observe
   * support through the published `supportsStreamDirectory()` predicate, which
   * applies both halves of that check.
   */
  streamDirectory?: CodebuffStreamDirectory
  conditionalCommit?: (
    path: fs.PathLike,
    data: CodebuffFileContent,
    options: CodebuffConditionalCommitOptions,
  ) => Promise<CodebuffConditionalCommitResult>
  conditionalDelete?: (
    path: fs.PathLike,
    options: { expectedHash: string },
  ) => Promise<CodebuffConditionalDeleteResult>
  /**
   * Move a source under the adapter's declared mutation authority only when
   * its content hash still matches and the destination is still absent.
   * Implementations must not replace an existing destination.
   */
  conditionalMove?: (
    source: fs.PathLike,
    destination: fs.PathLike,
    options: CodebuffConditionalMoveOptions,
  ) => Promise<CodebuffConditionalMoveResult>
  createFileExclusive?: (
    path: fs.PathLike,
    data: CodebuffFileContent,
  ) => Promise<void>
  /** Native metadata-preserving rename when source and destination share a filesystem. */
  renameFile?: (source: fs.PathLike, destination: fs.PathLike) => Promise<void>
  /** Restore portable permission bits after rollback/recreation. */
  setMode?: (path: fs.PathLike, mode: number) => Promise<void>
}

/** The `fs.promises` subset every adapter must provide.
 *
 * `CodebuffStreamDirectory` deliberately does not reference this alias, so the
 * capability type resolves on its own; the SDK re-exports both, keeping the
 * published `.d.ts` closure complete either way.
 */
export type CodebuffFileSystemBase = Pick<
  typeof fs.promises,
  | 'mkdir'
  | 'readdir'
  | 'readFile'
  | 'realpath'
  | 'stat'
  | 'unlink'
  | 'writeFile'
>

/** File system used for Codebuff SDK.
 *
 * Compatible with `fs.promises` from the `'fs'` module.
 */
export type CodebuffFileSystem = CodebuffFileSystemBase &
  CodebuffFileSystemCapabilities
