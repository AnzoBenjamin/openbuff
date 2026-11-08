import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type { HostReadPolicy } from '@codebuff/common/util/project-path-containment'

/** Capture adapter methods without changing their receiver or bounded-read view. */
export function bindHostFileSystem(source: CodebuffFileSystem, readPolicy: HostReadPolicy): CodebuffFileSystem {
  const readFile = source.readFile.bind(source) as CodebuffFileSystem['readFile']
  const readdir = source.readdir.bind(source) as CodebuffFileSystem['readdir']
  const bound: CodebuffFileSystem = {
    hostReadPolicy: readPolicy,
    hostProcessView: source.hostProcessView,
    mutationAuthority: source.mutationAuthority,
    mkdir: source.mkdir.bind(source),
    readdir,
    readFile,
    realpath: source.realpath.bind(source),
    stat: source.stat.bind(source),
    unlink: source.unlink.bind(source),
    writeFile: source.writeFile.bind(source),
  }
  for (const key of ['readRange', 'conditionalCommit', 'conditionalDelete', 'conditionalMove',
    'createFileExclusive', 'renameFile', 'setMode'] as const) {
    const operation = source[key]
    if (operation) Object.defineProperty(bound, key, { value: operation.bind(source), enumerable: true })
  }
  for (const key of ['readTextRange', 'readTextFile'] as const) {
    const operation = source[key]
    if (!operation) continue
    const captured = operation.bind(source)
    if (operation.readFileView !== undefined) Object.defineProperty(captured, 'readFileView', {
      value: operation.readFileView === source.readFile ? readFile : operation.readFileView,
    })
    Object.defineProperty(bound, key, { value: Object.freeze(captured), enumerable: true })
  }
  if (source.streamDirectory) {
    const captured = source.streamDirectory.bind(source)
    Object.defineProperty(captured, 'readdirView', {
      value: source.streamDirectory.readdirView === source.readdir ? readdir : source.streamDirectory.readdirView,
    })
    Object.defineProperty(bound, 'streamDirectory', { value: Object.freeze(captured), enumerable: true })
  }
  return Object.freeze(bound)
}
