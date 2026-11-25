import fs from 'node:fs'
import {
  captureRunOutputSchema,
  MAX_RUN_OUTPUT_SCHEMA_BYTES,
} from '@codebuff/common/util/run-output-schema'

/** Explicit user-selected schema file, captured without executing or dereferencing schemas. */
export async function readRunOutputSchema(filePath: string) {
  if (!filePath.trim() || filePath.includes('\0'))
    throw new Error('Output schema path must not be empty or contain NUL.')
  const handle = await fs.promises.open(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  )
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > MAX_RUN_OUTPUT_SCHEMA_BYTES)
      throw new Error('Output schema must be a regular file of at most 64 KiB.')
    const bytes = Buffer.alloc(before.size)
    let read = 0
    while (read < bytes.length) {
      const chunk = await handle.read(bytes, read, bytes.length - read, read)
      if (!chunk.bytesRead) break
      read += chunk.bytesRead
    }
    const after = await handle.stat()
    if (
      read !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('Output schema changed during capture.')
    return captureRunOutputSchema(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    )
  } finally {
    await handle.close()
  }
}
