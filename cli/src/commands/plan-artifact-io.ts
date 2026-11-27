import fs from 'node:fs'
import path from 'node:path'
import { isMandatorySensitiveReadPath } from '@codebuff/common/util/sensitive-paths'

/** Read-only plan artifacts use Linux descriptor traversal; no lexical fallback. */
export class PlanArtifactReadError extends Error {
  constructor(
    readonly code:
      | 'unsupported'
      | 'invalid-path'
      | 'unsafe'
      | 'not-regular'
      | 'changed',
  ) {
    super(
      `Plan artifact unavailable: ${code}; a contained no-symlink capture is required.`,
    )
    this.name = 'PlanArtifactReadError'
  }
}
const fail = (code: PlanArtifactReadError['code']): never => {
  throw new PlanArtifactReadError(code)
}
const directoryFlags =
  fs.constants.O_RDONLY |
  fs.constants.O_DIRECTORY |
  fs.constants.O_NOFOLLOW |
  fs.constants.O_NONBLOCK
const fileFlags =
  fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
const names = new Set([
  'SPEC.md',
  'PLAN.md',
  'STATUS.md',
  'LESSONS.md',
  'STATE.json',
])
const proc = (fd: number, child?: string) =>
  `/proc/self/fd/${fd}${child === undefined ? '' : `/${child}`}`
const missing = (error: unknown) =>
  ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
export const isMissingPlanArtifact = missing

function components(relative: string): string[] {
  if (
    typeof relative !== 'string' ||
    path.isAbsolute(relative) ||
    relative.includes('\\') ||
    relative.includes('\0')
  )
    fail('invalid-path')
  const parts = relative ? relative.split('/') : []
  if (parts.some((part) => !part || part === '.' || part === '..'))
    fail('invalid-path')
  return parts
}
function supported() {
  if (
    process.platform !== 'linux' ||
    typeof fs.constants.O_NOFOLLOW !== 'number' ||
    typeof fs.constants.O_DIRECTORY !== 'number'
  )
    fail('unsupported')
}
export type PlanDirectory = Readonly<{ fd: number; close(): void }>

/** Each component is opened relative to a held parent and never follows a link. */
export function openPlanDirectory(
  root: string,
  relative: string,
): PlanDirectory {
  supported()
  const parts = components(relative)
  if (
    parts.length &&
    (parts[0] !== '.agents' ||
      (parts.length > 1 && parts[1] !== 'sessions') ||
      parts.length > 3)
  )
    fail('invalid-path')
  const descriptors: number[] = []
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    for (const fd of descriptors.reverse()) {
      try {
        fs.closeSync(fd)
      } catch {
        /* Preserve primary refusal. */
      }
    }
  }
  try {
    const canonical = fs.realpathSync(root)
    const expected = fs.statSync(canonical)
    const fd = fs.openSync(canonical, directoryFlags)
    descriptors.push(fd)
    const observed = fs.fstatSync(fd)
    if (
      !observed.isDirectory() ||
      observed.dev !== expected.dev ||
      observed.ino !== expected.ino ||
      fs.realpathSync(proc(fd)) !== canonical
    )
      fail('changed')
    let parent = fd
    for (const component of parts) {
      try {
        parent = fs.openSync(proc(parent, component), directoryFlags)
      } catch (error) {
        if (missing(error)) throw error
        fail('unsafe')
      }
      descriptors.push(parent)
      if (!fs.fstatSync(parent).isDirectory()) fail('unsafe')
    }
    return Object.freeze({ fd: parent, close })
  } catch (error) {
    close()
    throw error
  }
}

function validateFilePath(
  root: string,
  file: string,
): { parent: string; name: string } {
  const relative = path
    .relative(path.resolve(root), path.resolve(file))
    .split(path.sep)
    .join('/')
  const parts = components(relative)
  const pointer =
    parts.length === 2 &&
    parts[0] === '.agents' &&
    parts[1] === 'ACTIVE_SESSION'
  if (
    !pointer &&
    !(
      parts.length === 4 &&
      parts[0] === '.agents' &&
      parts[1] === 'sessions' &&
      names.has(parts[3]!)
    )
  )
    fail('invalid-path')
  if (isMandatorySensitiveReadPath(relative)) fail('unsafe')
  return { parent: parts.slice(0, -1).join('/'), name: parts.at(-1)! }
}
function regular(stat: fs.Stats): fs.Stats {
  if (!stat.isFile()) fail('not-regular')
  // A hard-linked alias must not disclose another file's bytes under a safe name.
  if (stat.nlink !== 1 || !Number.isSafeInteger(stat.size) || stat.size < 0)
    fail('unsafe')
  return stat
}
export type PlanFile = Readonly<{ fd: number; stat: fs.Stats; close(): void }>
export function openPlanFile(root: string, file: string): PlanFile {
  const selected = validateFilePath(root, file)
  const directory = openPlanDirectory(root, selected.parent)
  let fd: number | undefined
  try {
    try {
      fd = fs.openSync(proc(directory.fd, selected.name), fileFlags)
    } catch (error) {
      if (missing(error)) throw error
      fail('unsafe')
    }
    const opened = fd ?? fail('unsafe')
    const stat = regular(fs.fstatSync(opened))
    let closed = false
    return Object.freeze({
      fd: opened,
      stat,
      close() {
        if (closed) return
        closed = true
        fs.closeSync(opened)
      },
    })
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd)
    throw error
  } finally {
    directory.close()
  }
}
export async function openPlanFileAsync(root: string, file: string) {
  const selected = validateFilePath(root, file)
  const directory = openPlanDirectory(root, selected.parent)
  let handle: fs.promises.FileHandle | undefined
  try {
    try {
      handle = await fs.promises.open(
        proc(directory.fd, selected.name),
        fileFlags,
      )
    } catch (error) {
      if (missing(error)) throw error
      fail('unsafe')
    }
    const opened = handle ?? fail('unsafe')
    const stat = regular(await opened.stat())
    return { handle: opened, stat }
  } catch (error) {
    await handle?.close()
    throw error
  } finally {
    directory.close()
  }
}
export function assertPlanCaptureStable(
  before: fs.Stats,
  after: fs.Stats,
): void {
  regular(after)
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    fail('changed')
}
export function planDirectoryPath(directory: PlanDirectory): string {
  return proc(directory.fd)
}
