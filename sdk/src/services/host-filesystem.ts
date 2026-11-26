import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import {
  getHostReadProjectRoot,
  isProjectOnlyReadPolicy,
  type HostReadPolicy,
} from '@codebuff/common/util/project-path-containment'
import {
  captureNodeMutationBroker,
  captureNodeProjectReadFactory,
} from '../tools/node-filesystem'
import { projectReadUnavailable } from '../tools/guarded-project-read'

const projectReaders = new WeakMap<
  CodebuffFileSystem,
  NonNullable<ReturnType<typeof captureNodeProjectReadFactory>>
>()
const guardedViews = new WeakMap<CodebuffFileSystem, HostReadPolicy>()
const mutationBrokers = new WeakMap<
  CodebuffFileSystem,
  NonNullable<ReturnType<typeof captureNodeMutationBroker>>
>()

/** Only an original Node adapter or a host-bound view of one can prove effects. */
export function captureHostMutationBroker(source: CodebuffFileSystem) {
  return mutationBrokers.get(source) ?? captureNodeMutationBroker(source)
}

/** Private registry, not an adapter-supplied claim or a serialized capability. */
export function hasGuardedProjectReads(view: CodebuffFileSystem): boolean {
  return (
    isProjectOnlyReadPolicy(view.hostReadPolicy) &&
    guardedViews.get(view) === view.hostReadPolicy
  )
}

// Raw process/index/archive/control-plane readers have no guarded read contract.
// Keep this list explicit: an added native tool is unavailable until reviewed.
const strictReadTools = new Set([
  'read_files',
  'read_outline',
  'read_image',
  'glob',
  'list_directory',
  'set_output',
  'end_turn',
  'task_completed',
  'add_message',
  'set_messages',
  'spawn_agents',
  'spawn_agent_inline',
  'check_background_agent',
  'cancel_background_agent',
])
export const isStrictProjectReadToolSupported = (toolName: string): boolean =>
  strictReadTools.has(toolName)

/** Capture adapter methods without changing ordinary receivers or bounded-read views. */
export function bindHostFileSystem(
  source: CodebuffFileSystem,
  readPolicy: HostReadPolicy,
): CodebuffFileSystem {
  getHostReadProjectRoot(readPolicy) // Reject copied/serialized tokens even for ordinary views.
  const strict = isProjectOnlyReadPolicy(readPolicy)
  const projectReader =
    projectReaders.get(source) ?? captureNodeProjectReadFactory(source)
  const unavailable = async () => projectReadUnavailable()
  const readSource: Pick<
    CodebuffFileSystem,
    | 'readFile'
    | 'readdir'
    | 'realpath'
    | 'stat'
    | 'readRange'
    | 'readTextRange'
    | 'readTextFile'
    | 'streamDirectory'
  > = strict
    ? (projectReader?.(readPolicy) ?? {
        readFile: unavailable as CodebuffFileSystem['readFile'],
        readdir: unavailable as CodebuffFileSystem['readdir'],
        realpath: unavailable as CodebuffFileSystem['realpath'],
        stat: unavailable as CodebuffFileSystem['stat'],
        readRange: unavailable,
        readTextRange: unavailable,
        readTextFile: unavailable,
      })
    : source
  const readFile = readSource.readFile.bind(
    readSource,
  ) as CodebuffFileSystem['readFile']
  const readdir = readSource.readdir.bind(
    readSource,
  ) as CodebuffFileSystem['readdir']
  const bound: CodebuffFileSystem = {
    hostReadPolicy: readPolicy,
    hostProcessView: strict ? false : source.hostProcessView,
    mutationAuthority: source.mutationAuthority,
    mkdir: source.mkdir.bind(source),
    readdir,
    readFile,
    ...(strict || !source.lstat ? {} : { lstat: source.lstat.bind(source) }),
    realpath: readSource.realpath.bind(readSource),
    stat: readSource.stat.bind(readSource),
    unlink: source.unlink.bind(source),
    writeFile: source.writeFile.bind(source),
  }
  for (const key of [
    'readRange',
    'conditionalCommit',
    'conditionalDelete',
    'conditionalMove',
    'createFileExclusive',
    'renameFile',
    'setMode',
  ] as const) {
    const receiver = key === 'readRange' ? readSource : source
    const operation = key === 'readRange' ? readSource.readRange : source[key]
    if (operation)
      Object.defineProperty(bound, key, {
        value: operation.bind(receiver),
        enumerable: true,
      })
  }
  for (const key of ['readTextRange', 'readTextFile'] as const) {
    const operation = readSource[key]
    if (!operation) continue
    const captured = operation.bind(readSource)
    if (operation.readFileView !== undefined)
      Object.defineProperty(captured, 'readFileView', {
        value:
          operation.readFileView === readSource.readFile
            ? readFile
            : operation.readFileView,
      })
    Object.defineProperty(bound, key, {
      value: Object.freeze(captured),
      enumerable: true,
    })
  }
  if (readSource.streamDirectory) {
    const captured = readSource.streamDirectory.bind(readSource)
    Object.defineProperty(captured, 'readdirView', {
      value:
        readSource.streamDirectory.readdirView === readSource.readdir
          ? readdir
          : readSource.streamDirectory.readdirView,
    })
    Object.defineProperty(bound, 'streamDirectory', {
      value: Object.freeze(captured),
      enumerable: true,
    })
  }
  if (projectReader) projectReaders.set(bound, projectReader)
  const broker = captureHostMutationBroker(source)
  if (broker) mutationBrokers.set(bound, broker)
  if (strict && projectReader) guardedViews.set(bound, readPolicy)
  return Object.freeze(bound)
}
