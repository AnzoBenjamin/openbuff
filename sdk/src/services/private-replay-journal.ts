import { closeSync, lstatSync, openSync } from 'node:fs'
import path from 'node:path'

/** Shared by both explicit replay lanes; these journals can contain private data. */
export function requirePrivateReplayJournalPath(
  file: string,
  uid: number,
): void {
  const parent = path.dirname(file)
  const ancestors: string[] = []
  for (let directory = parent; ; directory = path.dirname(directory)) {
    ancestors.push(directory)
    if (directory === path.dirname(directory)) break
  }
  for (const directory of ancestors.reverse()) {
    const info = lstatSync(directory, { throwIfNoEntry: false })
    if (directory === parent) {
      if (!info?.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0)
        throw new Error(
          'Replay requires an existing owner-only private directory for its journal.',
        )
    } else if (
      !info?.isDirectory() ||
      (info.uid !== uid && info.uid !== 0) ||
      ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)
    ) {
      throw new Error(
        'Replay requires trusted ancestors for its journal directory.',
      )
    }
  }
  const check = (name: string, optional: boolean) => {
    const info = lstatSync(name, { throwIfNoEntry: false })
    if (!info && optional) return
    if (
      !info?.isFile() ||
      info.uid !== uid ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0
    )
      throw new Error(
        'Replay requires regular, owner-only files for its database and SQLite sidecars.',
      )
  }
  for (const suffix of ['-journal', '-wal', '-shm']) check(file + suffix, true)
  try {
    closeSync(openSync(file, 'wx', 0o600))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  check(file, false)
}
