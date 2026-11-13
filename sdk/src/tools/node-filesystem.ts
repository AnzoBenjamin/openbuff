import { createHash } from 'node:crypto'
import { promises as nodeFs } from 'node:fs'

import { parseRawReadBasis } from '@codebuff/common/util/raw-read-basis'
import { throwIfAborted } from './concurrency'

import type {
  CodebuffFileContent,
  CodebuffFileSystem,
  CodebuffTextRangeReadResult,
  CodebuffTextReadOptions,
  CodebuffRangeReadResult,
} from '@codebuff/common/types/filesystem'
import type { WorkspaceMutationBroker } from '../services/workspace-mutation-broker'
import type { PathLike } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'

export const NODE_TEXT_READ_CHUNK_BYTES = 65_536

export type NodeTextReadHandle = Pick<FileHandle, 'read' | 'stat' | 'close'>

export type NodeTextReadEvent = {
  seam: 'allocate' | 'before_read' | 'read' | 'return' | 'close'
  stage: 'retaining' | 'skipping' | 'metadata'
  /** Actual live views. Observers must not retain them or the event. */
  output: Uint8Array
  input: Uint8Array
  scannedBytes: number
  returnedBytes: number
  pendingBytes: number
  lastReadBytes: number
}

export type NodeTextReadInstrumentation = {
  observe?: (event: NodeTextReadEvent) => void | Promise<void>
  /** A test seam for wrapping a real descriptor, including read/close faults. */
  open?: (filePath: PathLike, flags: 'r') => Promise<NodeTextReadHandle>
}

export type NodeFileSystemOptions = {
  mutationBroker?: WorkspaceMutationBroker
  textReadInstrumentation?: NodeTextReadInstrumentation
}

/**
 * Node's default filesystem with the bounded range capability required by
 * `read_files.ranges` for oversized files. The implementation streams the
 * file to EOF with an owned result buffer and fixed descriptor input buffer.
 * Descriptor metadata checks detect observed drift; they do not make arbitrary
 * external writes an immutable snapshot.
 */
export function createNodeFileSystem(
  options: NodeFileSystemOptions = {},
): CodebuffFileSystem {
  const mutationBroker = options.mutationBroker
  const readTextRange = Object.assign(
    (
      filePath: PathLike,
      startLine: number,
      endLine: number,
      maxBytes: number,
      readOptions?: CodebuffTextReadOptions,
    ) =>
      readNodeTextRange(
        filePath,
        startLine,
        endLine,
        maxBytes,
        readOptions,
        options.textReadInstrumentation,
      ),
    { readFileView: nodeFs.readFile },
  )
  const readTextFile = Object.assign(
    (
      filePath: PathLike,
      maxBytes: number,
      readOptions?: CodebuffTextReadOptions,
    ) =>
      readNodeTextRange(
        filePath,
        1,
        Number.MAX_SAFE_INTEGER,
        maxBytes,
        readOptions,
        options.textReadInstrumentation,
        true,
      ),
    { readFileView: nodeFs.readFile },
  )
  return Object.assign(Object.create(nodeFs), {
    hostProcessView: true,
    ...(mutationBroker
      ? {
          mutationAuthority: mutationBroker.authorityKind,
          conditionalCommit: (
            filePath: PathLike,
            data: CodebuffFileContent,
            commitOptions: { expectedHash: string | null },
          ) =>
            mutationBroker.conditionalCommit(
              filePath,
              data,
              commitOptions.expectedHash,
            ),
          conditionalDelete: (
            filePath: PathLike,
            deleteOptions: { expectedHash: string },
          ) =>
            mutationBroker.conditionalDelete(
              filePath,
              deleteOptions.expectedHash,
            ),
          conditionalMove: (
            source: PathLike,
            destination: PathLike,
            moveOptions: { expectedSourceHash: string },
          ) =>
            mutationBroker.conditionalMove(
              source,
              destination,
              moveOptions.expectedSourceHash,
            ),
        }
      : {}),
    readTextRange,
    readTextFile,
    readRange: readNodeRange,
    // Explicit streaming opt-in, deliberately not named `opendir` so adapters
    // inheriting from `fs.promises` are never auto-detected. Node's `Dir`
    // releases its handle from `return()`, satisfying the capability's
    // handle-release obligation, and `readdirView` pins the capability to this
    // adapter's own `readdir` so a decorating adapter that overrides `readdir`
    // is not streamed past (see CodebuffStreamDirectory).
    streamDirectory: Object.assign(
      (filePath: PathLike) => nodeFs.opendir(filePath),
      { readdirView: nodeFs.readdir },
    ),
    createFileExclusive: async (
      filePath: PathLike,
      data: CodebuffFileContent,
    ) => {
      if (mutationBroker) {
        const result = await mutationBroker.createExclusive(filePath, data)
        if (!result.applied) {
          const error = new Error(`File already exists: ${String(filePath)}`)
          Object.assign(error, { code: 'EEXIST' })
          throw error
        }
        return
      }
      await nodeFs.writeFile(filePath, data, { flag: 'wx' })
    },
    renameFile: (source: PathLike, destination: PathLike) =>
      nodeFs.rename(source, destination),
    setMode: (filePath: PathLike, mode: number) => nodeFs.chmod(filePath, mode),
  }) as CodebuffFileSystem
}

// Without a broker, conditionalCommit, conditionalDelete, and conditionalMove
// remain deliberately absent. Node's portable fs APIs cannot atomically
// combine a content-hash comparison with replacement/deletion. Guarded
// callers fail closed instead of presenting check-then-write as CAS authority.

async function readNodeRange(
  filePath: PathLike,
  start: number,
  endExclusive: number,
): Promise<CodebuffRangeReadResult> {
  const length = endExclusive - start
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(endExclusive) ||
    start < 0 ||
    length < 0 ||
    length > 1024 * 1024
  ) {
    throw new RangeError('Invalid bounded byte range request (maximum 1 MiB)')
  }
  const handle = await nodeFs.open(filePath, 'r')
  try {
    const data = Buffer.alloc(length)
    let bytesRead = 0
    while (bytesRead < length) {
      const result = await handle.read(
        data,
        bytesRead,
        length - bytesRead,
        start + bytesRead,
      )
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    return {
      data: data.subarray(0, bytesRead),
      endExclusive: start + bytesRead,
    }
  } finally {
    await handle.close()
  }
}

async function readNodeTextRange(
  filePath: PathLike,
  startLine: number,
  endLine: number,
  maxBytes: number,
  options: CodebuffTextReadOptions = {},
  instrumentation: NodeTextReadInstrumentation = {},
  wholeRead = false,
): Promise<CodebuffTextRangeReadResult> {
  const signal = options.signal
  throwIfAborted(signal)
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    !Number.isSafeInteger(maxBytes) ||
    startLine < 1 ||
    endLine < startLine ||
    maxBytes < 0
  ) {
    throw new RangeError('Invalid bounded text range request')
  }

  // Buffer.alloc is unpooled: capacities, rather than just subarray lengths,
  // are exactly B and C, including a one-byte or zero-byte result budget.
  const output = Buffer.alloc(maxBytes)
  const input = Buffer.alloc(NODE_TEXT_READ_CHUNK_BYTES)
  const documentHash = createHash('sha256')
  let outputBytes = 0
  let committedBytes = 0
  let scannedBytes = 0
  let lastReadBytes = 0
  let currentLine = 1
  let lineStartByte = 0
  let returnedStartLine = 0
  let returnedEndLine = 0
  let selectedStartByte = 0
  let selectedEndByte = 0
  let selectedTerminator: 'lf' | 'crlf' | 'none' = 'none'
  let truncated = false
  let lastByte = -1
  let previousByte = -1
  let firstBytes = 0
  let continuationBytes = 0
  let continuationMin = 0x80
  let continuationMax = 0xbf

  const stage = (): NodeTextReadEvent['stage'] =>
    currentLine > endLine
      ? 'metadata'
      : currentLine < startLine || truncated
        ? 'skipping'
        : 'retaining'
  const observe = async (seam: NodeTextReadEvent['seam']): Promise<void> => {
    await instrumentation.observe?.({
      seam,
      stage: stage(),
      output,
      input,
      scannedBytes,
      returnedBytes: committedBytes,
      pendingBytes: outputBytes - committedBytes,
      lastReadBytes,
    })
  }
  const finishLine = (
    endByte: number,
    terminator: typeof selectedTerminator,
  ): void => {
    if (currentLine >= startLine && currentLine <= endLine && !truncated) {
      if (returnedStartLine === 0) {
        returnedStartLine = currentLine
        selectedStartByte = lineStartByte
      }
      returnedEndLine = currentLine
      selectedEndByte = endByte
      selectedTerminator = terminator
      committedBytes = outputBytes
    }
    currentLine += 1
    lineStartByte = endByte
  }

  const invalidUtf8 = (): never => {
    throw Object.assign(new TypeError('The file is not valid UTF-8 text.'), {
      code: 'UNSUPPORTED_ENCODING',
    })
  }
  const validateByte = (byte: number): void => {
    if (continuationBytes > 0) {
      if (byte < continuationMin || byte > continuationMax) invalidUtf8()
      continuationBytes--
      continuationMin = 0x80
      continuationMax = 0xbf
    } else if (byte <= 0x7f) {
      return
    } else if (byte >= 0xc2 && byte <= 0xdf) {
      continuationBytes = 1
    } else if (byte >= 0xe0 && byte <= 0xef) {
      continuationBytes = 2
      continuationMin = byte === 0xe0 ? 0xa0 : 0x80
      continuationMax = byte === 0xed ? 0x9f : 0xbf
    } else if (byte >= 0xf0 && byte <= 0xf4) {
      continuationBytes = 3
      continuationMin = byte === 0xf0 ? 0x90 : 0x80
      continuationMax = byte === 0xf4 ? 0x8f : 0xbf
    } else {
      invalidUtf8()
    }
  }

  await observe('allocate')
  throwIfAborted(signal)
  const handle = await (instrumentation.open ?? nodeFs.open)(filePath, 'r')
  let result: CodebuffTextRangeReadResult
  try {
    throwIfAborted(signal)
    const before = await handle.stat()
    const generation = (metadata: typeof before): string =>
      `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`
    const beforeGeneration = generation(before)
    while (true) {
      throwIfAborted(signal)
      await observe('before_read')
      throwIfAborted(signal)
      const read = await handle.read(input, 0, input.byteLength, scannedBytes)
      throwIfAborted(signal)
      lastReadBytes = read.bytesRead
      if (read.bytesRead === 0) break
      documentHash.update(input.subarray(0, read.bytesRead))
      for (let index = 0; index < read.bytesRead; index++) {
        const byte = input[index]!
        validateByte(byte)
        if (scannedBytes < 3) firstBytes = (firstBytes << 8) | byte
        previousByte = lastByte
        lastByte = byte
        scannedBytes++
        if (currentLine >= startLine && currentLine <= endLine && !truncated) {
          if (outputBytes === output.byteLength) {
            // The pending line shares B. Once it cannot fit, rewind its bytes
            // and discard the remaining selected text without concatenation.
            outputBytes = committedBytes
            truncated = true
          } else {
            output[outputBytes++] = byte
          }
        }
        if (byte === 0x0a) {
          finishLine(scannedBytes, previousByte === 0x0d ? 'crlf' : 'lf')
        }
      }
      await observe('read')
    }
    if (continuationBytes !== 0) invalidUtf8()
    throwIfAborted(signal)
    const after = await handle.stat()
    if (beforeGeneration !== generation(after) || scannedBytes !== after.size) {
      throw Object.assign(
        new Error('The file changed during the descriptor read.'),
        {
          code: 'ESTALE',
        },
      )
    }
    const documentBom =
      scannedBytes >= 3 && firstBytes === 0xefbbbf ? 'utf8' : 'none'
    const payloadBytes = scannedBytes - (documentBom === 'utf8' ? 3 : 0)
    const totalLines =
      currentLine - 1 + (payloadBytes > 0 && lastByte !== 0x0a ? 1 : 0)
    const maxCapabilityLine = currentLine
    // The final split entry is addressable even when it has no visible text.
    finishLine(scannedBytes, 'none')
    const requestedLastExistingLine = Math.min(endLine, maxCapabilityLine)
    const complete =
      !truncated &&
      (requestedLastExistingLine < startLine ||
        returnedEndLine === requestedLastExistingLine)
    const hash = `sha256:${documentHash.digest('hex')}`
    const whole =
      wholeRead &&
      complete &&
      returnedStartLine === 1 &&
      (returnedEndLine === totalLines ||
        returnedEndLine === maxCapabilityLine) &&
      selectedEndByte === scannedBytes
    const rawBasis =
      returnedStartLine > 0 && (complete || committedBytes > 0)
        ? parseRawReadBasis({
            version: 1,
            scope: whole ? 'whole' : 'lines',
            rawHash: whole
              ? hash
              : `sha256:${createHash('sha256').update(output.subarray(0, committedBytes)).digest('hex')}`,
            documentRawHash: hash,
            documentBytes: scannedBytes,
            startByte: whole ? 0 : selectedStartByte,
            endByteExclusive: whole ? scannedBytes : selectedEndByte,
            documentBom,
            includesBom:
              documentBom === 'utf8' &&
              selectedStartByte === 0 &&
              selectedEndByte >= 3,
            endTerminator: whole
              ? lastByte === 0x0a
                ? previousByte === 0x0d
                  ? 'crlf'
                  : 'lf'
                : 'none'
              : selectedTerminator,
            view: 'descriptor',
            coherence: 'checked',
            generation: beforeGeneration,
          })
        : undefined
    result = {
      data: output.subarray(0, committedBytes),
      startLine: returnedStartLine || startLine,
      endLine: returnedEndLine,
      totalLines,
      complete: wholeRead ? complete && whole : complete,
      metadataComplete: true,
      ...(rawBasis ? { rawBasis } : {}),
    }
  } finally {
    await handle.close()
    await observe('close')
  }
  throwIfAborted(signal)
  await observe('return')
  throwIfAborted(signal)
  return result
}
