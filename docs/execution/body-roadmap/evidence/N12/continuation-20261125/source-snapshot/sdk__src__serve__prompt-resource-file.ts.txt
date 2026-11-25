import fs from 'node:fs'
import path from 'node:path'
import { RequestError } from '@agentclientprotocol/sdk'
import { isMandatorySensitiveReadPath } from '@codebuff/common/util/sensitive-paths'

export type AcpPromptFileFailure =
  | 'cancelled'
  | 'containment_unavailable'
  | 'outside_project'
  | 'file_changed'
  | 'not_regular'
  | 'hard_link'
  | 'sensitive_path'
  | 'file_too_large'
  | 'file_missing'
  | 'unsafe_path'
  | 'read_failed'
type Refuse = (reason: AcpPromptFileFailure) => never
export type AcpPromptFileReader = {
  read(file: string): Promise<Buffer>
  close(): Promise<void>
}
const MAX_FILE_BYTES = 1024 * 1024
const proc = (fd: number, child?: string) =>
  `/proc/self/fd/${fd}${child === undefined ? '' : `/${child}`}`
const fileFlags = () =>
  fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK

function relative(root: string, file: string): string | null {
  const value = path.relative(root, file)
  return value === '..' ||
    value.startsWith(`..${path.sep}`) ||
    path.isAbsolute(value)
    ? null
    : value
}
function checkAbort(signal: AbortSignal, fail: Refuse): void {
  if (signal.aborted) fail('cancelled')
}
async function descriptorPath(
  handle: fs.promises.FileHandle,
  fail: Refuse,
): Promise<string> {
  try {
    return await fs.promises.realpath(proc(handle.fd))
  } catch {
    return fail('containment_unavailable')
  }
}
function ioFailure(error: unknown, fail: Refuse): never {
  if (error instanceof RequestError) throw error
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'ENOENT') fail('file_missing')
  if (code === 'ELOOP' || code === 'ENOTDIR') fail('unsafe_path')
  return fail('read_failed')
}
async function close(handle: fs.promises.FileHandle): Promise<void> {
  await handle.close().catch(() => {
    /* Preserve the primary refusal/cancellation. */
  })
}
function regular(stat: fs.BigIntStats, fail: Refuse): void {
  if (!stat.isFile()) fail('not_regular')
  if (stat.nlink !== 1n) fail('hard_link')
}

/**
 * Hold one host-selected root for a prompt capture. Every descendant is opened
 * against its held parent; there is no lexical reopen or portable fallback.
 * The supplied refusal function owns the protocol error, not read authority.
 * Stable host root is assumed; metadata checks are not same-inode snapshot isolation.
 */
export async function openAcpPromptFileReader(input: {
  projectRoot?: string
  cwd?: string
  signal: AbortSignal
  refuse: Refuse
}): Promise<AcpPromptFileReader> {
  const { projectRoot: selected, cwd, signal } = input
  const fail: Refuse = input.refuse
  if (
    process.platform !== 'linux' ||
    !fs.constants.O_NOFOLLOW ||
    !fs.constants.O_DIRECTORY ||
    !fs.constants.O_NONBLOCK
  )
    fail('containment_unavailable')
  if (!selected || !path.isAbsolute(selected)) fail('containment_unavailable')
  let root: fs.promises.FileHandle | undefined
  let canonical: string
  try {
    canonical = await fs.promises.realpath(selected)
    checkAbort(signal, fail)
    if (
      cwd !== undefined &&
      (!path.isAbsolute(cwd) ||
        (relative(selected, cwd) === null && relative(canonical, cwd) === null))
    )
      fail('outside_project')
    const expected = await fs.promises.stat(canonical, { bigint: true })
    checkAbort(signal, fail)
    root = await fs.promises.open(
      canonical,
      fileFlags() | fs.constants.O_DIRECTORY,
    )
    checkAbort(signal, fail)
    const observed = await root.stat({ bigint: true })
    if (
      !observed.isDirectory() ||
      observed.dev !== expected.dev ||
      observed.ino !== expected.ino
    )
      fail('file_changed')
    if ((await descriptorPath(root, fail)) !== canonical) fail('file_changed')
    checkAbort(signal, fail)
  } catch (error) {
    if (root) await close(root)
    return ioFailure(error, fail)
  }
  const heldRoot = root
  return Object.freeze({
    async read(file: string): Promise<Buffer> {
      const rel =
        relative(selected, file) ??
        relative(canonical, file) ??
        fail('outside_project')
      if (!rel) fail('not_regular')
      const target = path.join(canonical, rel)
      if (
        isMandatorySensitiveReadPath(file) ||
        isMandatorySensitiveReadPath(target)
      )
        fail('sensitive_path')
      const parts = rel.split(path.sep)
      const handles: Array<{ handle: fs.promises.FileHandle; path: string }> =
        []
      try {
        let parent = heldRoot,
          expected = canonical
        for (const part of parts.slice(0, -1)) {
          checkAbort(signal, fail)
          const handle = await fs.promises.open(
            proc(parent.fd, part),
            fileFlags() | fs.constants.O_DIRECTORY,
          )
          expected = path.join(expected, part)
          handles.push({ handle, path: expected })
          checkAbort(signal, fail)
          if (!(await handle.stat()).isDirectory()) fail('unsafe_path')
          if ((await descriptorPath(handle, fail)) !== expected)
            fail('file_changed')
          parent = handle
        }
        checkAbort(signal, fail)
        const handle = await fs.promises.open(
          proc(parent.fd, parts.at(-1)!),
          fileFlags(),
        )
        handles.push({ handle, path: target })
        checkAbort(signal, fail)
        const before = await handle.stat({ bigint: true })
        regular(before, fail)
        if (before.size < 0n || before.size > BigInt(MAX_FILE_BYTES))
          fail('file_too_large')
        if ((await descriptorPath(handle, fail)) !== target)
          fail('file_changed')
        const size = Number(before.size),
          bytes = Buffer.alloc(size)
        let offset = 0
        while (offset < size) {
          checkAbort(signal, fail)
          const { bytesRead } = await handle.read(
            bytes,
            offset,
            Math.min(64 * 1024, size - offset),
            offset,
          )
          checkAbort(signal, fail)
          if (bytesRead === 0) fail('file_changed')
          offset += bytesRead
        }
        const after = await handle.stat({ bigint: true })
        regular(after, fail)
        if (
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs
        )
          fail('file_changed')
        for (const entry of [
          { handle: heldRoot, path: canonical },
          ...handles,
        ]) {
          checkAbort(signal, fail)
          if ((await descriptorPath(entry.handle, fail)) !== entry.path)
            fail('file_changed')
        }
        checkAbort(signal, fail)
        return bytes
      } catch (error) {
        return ioFailure(error, fail)
      } finally {
        for (const entry of handles.reverse()) await close(entry.handle)
      }
    },
    close: () => close(heldRoot),
  })
}
