import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'

import {
  getOwnedTempRoots,
  isOwnedTempPath,
  isPathInsideProject,
  resolveProjectPath,
} from '../project-path-containment'

describe('isPathInsideProject', () => {
  test('accepts project-relative paths', () => {
    expect(isPathInsideProject('/repo', 'src/file.ts')).toBe(true)
    expect(isPathInsideProject('/repo', 'src/nested/file.ts')).toBe(true)
  })

  test('accepts absolute paths inside the project', () => {
    expect(isPathInsideProject('/repo', '/repo/src/file.ts')).toBe(true)
  })

  test('accepts the project root itself', () => {
    expect(isPathInsideProject('/repo', '/repo')).toBe(true)
    expect(isPathInsideProject('/repo', '.')).toBe(true)
  })

  test('rejects empty input', () => {
    expect(isPathInsideProject('/repo', '')).toBe(false)
  })

  test('rejects parent-traversal', () => {
    expect(isPathInsideProject('/repo', '../outside.ts')).toBe(false)
    expect(isPathInsideProject('/repo', '../../outside.ts')).toBe(false)
  })

  test('normalizes embedded .. segments before containment check', () => {
    // `path.resolve` collapses `src/../outside.ts` to `/repo/outside.ts`,
    // which is inside the project — so the helper accepts it. This matches
    // the SDK's `resolveFilePathWithinProject` semantics; traversal payloads
    // that escape the project must begin with `..` from the project root.
    expect(isPathInsideProject('/repo', 'src/../outside.ts')).toBe(true)
  })

  test('rejects absolute paths outside the project', () => {
    expect(isPathInsideProject('/repo', '/outside.ts')).toBe(false)
    expect(isPathInsideProject('/repo', '/etc/passwd')).toBe(false)
  })

  test('rejects sibling-directory prefix matches', () => {
    expect(isPathInsideProject('/repo', '/repo-sibling/file.ts')).toBe(false)
    expect(isPathInsideProject('/repo', '/repo-evil/file.ts')).toBe(false)
  })
})

describe('resolveProjectPath', () => {
  test('returns a relative path with forward slashes and an absolute fullPath', () => {
    const result = resolveProjectPath('/repo', 'src/nested/file.ts')
    expect(result).not.toBeNull()
    expect(result!.relativePath).toBe('src/nested/file.ts')
    expect(result!.fullPath).toBe(path.resolve('/repo/src/nested/file.ts'))
  })

  test('handles absolute input by re-rooting it relative to the project', () => {
    const result = resolveProjectPath('/repo', '/repo/src/file.ts')
    expect(result).not.toBeNull()
    expect(result!.relativePath).toBe('src/file.ts')
  })

  test('accepts the project root itself', () => {
    const absoluteResult = resolveProjectPath('/repo', '/repo')
    expect(absoluteResult).not.toBeNull()
    expect(absoluteResult!.relativePath).toBe('')
    expect(absoluteResult!.fullPath).toBe(path.resolve('/repo'))

    const relativeResult = resolveProjectPath('/repo', '.')
    expect(relativeResult).not.toBeNull()
    expect(relativeResult!.relativePath).toBe('')
    expect(relativeResult!.fullPath).toBe(path.resolve('/repo'))
  })

  test('returns null for traversal payloads', () => {
    expect(resolveProjectPath('/repo', '../outside.ts')).toBeNull()
    expect(resolveProjectPath('/repo', '/etc/passwd')).toBeNull()
  })

  test('preserves lexical behavior for synthetic non-existent paths', () => {
    // /repo doesn't exist on disk in unit tests; the helper should fall
    // back to the lexical resolution so test mocks keep working.
    const result = resolveProjectPath('/repo', 'src/file.ts')
    expect(result).not.toBeNull()
    expect(result!.relativePath).toBe('src/file.ts')
  })
})

describe('isPathInsideProject — symlink containment', () => {
  let tmpDir: string
  let outsideDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-contain-'))
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'))
    // In-project symlink that escapes: tmpDir/evil -> outsideDir
    fs.symlinkSync(outsideDir, path.join(tmpDir, 'evil'))
    // Legit in-project symlink: tmpDir/link -> tmpDir/real
    fs.mkdirSync(path.join(tmpDir, 'real'))
    fs.symlinkSync(path.join(tmpDir, 'real'), path.join(tmpDir, 'link'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(outsideDir, { recursive: true, force: true })
  })

  test('rejects a symlink that points outside the project', () => {
    expect(isPathInsideProject(tmpDir, 'evil')).toBe(false)
    expect(isPathInsideProject(tmpDir, 'evil/file.ts')).toBe(false)
  })

  test('rejects an outside symlink even when the target does not exist', () => {
    expect(isPathInsideProject(tmpDir, 'evil/nonexistent.ts')).toBe(false)
  })

  test('allows a symlink that points inside the project', () => {
    expect(isPathInsideProject(tmpDir, 'link/file.ts')).toBe(true)
  })
})

describe('openbuff-owned OS temp namespace exception', () => {
  // `os.tmpdir()` is used for the primary cases: on macOS it is a symlinked
  // `/var/folders/...` path, so hardcoding `/tmp` would compare the wrong
  // strings. Literal `/tmp` assertions are guarded on it being an owned root.
  const tempRoot = getOwnedTempRoots()[0]
  // Literal `/tmp` assertions only run where `/tmp` really is an owned root
  // (POSIX); `getOwnedTempRoots()[0]` covers every platform.
  const literalTmpIsOwnedRoot = isOwnedTempPath('/tmp/openbuff-probe.log')
  const uniqueSuffix = () =>
    `${process.pid}-${Math.random().toString(36).slice(2, 10)}`

  /** Files, dirs and symlinks created on the real filesystem by these tests. */
  const createdPaths: string[] = []
  const track = (p: string) => {
    createdPaths.push(p)
    return p
  }
  const cleanupCreated = () => {
    for (const p of createdPaths.splice(0)) {
      let isLink = false
      try {
        isLink = fs.lstatSync(p).isSymbolicLink()
      } catch {
        continue
      }
      // Unlink symlinks explicitly so a link to a directory outside the temp
      // root can never be followed during cleanup.
      if (isLink) {
        fs.unlinkSync(p)
      } else {
        fs.rmSync(p, { force: true, recursive: true })
      }
    }
  }

  afterEach(cleanupCreated)
  afterAll(cleanupCreated)

  describe('accepts openbuff-owned temp paths', () => {
    test('accepts background-job log and metadata names', () => {
      expect(isOwnedTempPath(path.join(tempRoot, 'openbuff-job-abc.log'))).toBe(
        true,
      )
      expect(isOwnedTempPath(path.join(tempRoot, 'openbuff-abc123.json'))).toBe(
        true,
      )
    })

    test('accepts a basher full-log name', () => {
      const basherLog = path.join(
        tempRoot,
        `openbuff-basher-${uniqueSuffix()}.log`,
      )
      expect(isOwnedTempPath(basherLog)).toBe(true)

      if (literalTmpIsOwnedRoot) {
        expect(
          isOwnedTempPath(`/tmp/openbuff-basher-${uniqueSuffix()}.log`),
        ).toBe(true)
      }
    })

    test('accepts a nested file under an owned directory', () => {
      expect(
        isOwnedTempPath(
          path.join(
            tempRoot,
            'tmux-captures-mysession',
            'capture-001-boot.txt',
          ),
        ),
      ).toBe(true)

      if (literalTmpIsOwnedRoot) {
        expect(
          isOwnedTempPath('/tmp/tmux-captures-mysession/capture-001-boot.txt'),
        ).toBe(true)
      }
    })

    test('rejects a tmux helper script name', () => {
      // The executable tmux helper script is deliberately NOT an owned temp
      // namespace: it is chmod +x'd and then EXECUTED by
      // run_terminal_command, so granting write access there would turn a
      // file write into arbitrary command execution.
      expect(isOwnedTempPath(path.join(tempRoot, 'tmux-helper-abc.sh'))).toBe(
        false,
      )

      if (literalTmpIsOwnedRoot) {
        expect(isOwnedTempPath('/tmp/tmux-helper-abc.sh')).toBe(false)
      }
    })

    test('accepts an owned temp file that really exists on disk', () => {
      const ownedLog = track(
        path.join(tempRoot, `openbuff-job-${uniqueSuffix()}.log`),
      )
      fs.writeFileSync(ownedLog, 'line\n')

      expect(isOwnedTempPath(ownedLog)).toBe(true)
    })
  })

  describe('resolveProjectPath owned-temp fallback', () => {
    test('returns the absolute resolved path as relativePath', () => {
      const ownedLog = path.join(
        tempRoot,
        `openbuff-job-${uniqueSuffix()}.log`,
      )

      const result = resolveProjectPath('/some/project', ownedLog)

      expect(result).not.toBeNull()
      // Documented behavior: owned temp paths live outside the project, so the
      // "relative" path is the absolute resolved path.
      expect(result!.relativePath).toBe(path.resolve(ownedLog))
      expect(result!.fullPath).toBe(path.resolve(ownedLog))
    })

    test('isPathInsideProject accepts an owned temp path', () => {
      expect(
        isPathInsideProject(
          '/some/project',
          path.join(tempRoot, 'tmux-captures-mysession', 'capture-001.txt'),
        ),
      ).toBe(true)
    })
  })

  describe('rejects paths outside the owned namespaces', () => {
    test('rejects the temp root itself (strictly-inside rule)', () => {
      expect(isOwnedTempPath(os.tmpdir())).toBe(false)
      expect(isOwnedTempPath(tempRoot)).toBe(false)
      expect(resolveProjectPath('/some/project', tempRoot)).toBeNull()

      if (literalTmpIsOwnedRoot) {
        expect(isOwnedTempPath('/tmp')).toBe(false)
        expect(resolveProjectPath('/some/project', '/tmp')).toBeNull()
      }
    })

    test('rejects a first segment that matches no owned pattern', () => {
      const foreign = path.join(tempRoot, 'other-tool-cache', 'x.log')
      expect(isOwnedTempPath(foreign)).toBe(false)
      expect(resolveProjectPath('/some/project', foreign)).toBeNull()

      if (literalTmpIsOwnedRoot) {
        expect(isOwnedTempPath('/tmp/other-tool-cache/x.log')).toBe(false)
      }
    })

    test('requires the owned prefix at the start of the segment', () => {
      const substringMatch = path.join(tempRoot, 'notopenbuff-foo.log')
      expect(isOwnedTempPath(substringMatch)).toBe(false)
      expect(resolveProjectPath('/some/project', substringMatch)).toBeNull()

      if (literalTmpIsOwnedRoot) {
        expect(isOwnedTempPath('/tmp/notopenbuff-foo.log')).toBe(false)
      }
    })

    test('requires the owned prefix on the first segment under the root', () => {
      const nested = path.join(tempRoot, 'nested', 'openbuff-foo.log')
      expect(isOwnedTempPath(nested)).toBe(false)
      expect(resolveProjectPath('/some/project', nested)).toBeNull()

      if (literalTmpIsOwnedRoot) {
        expect(isOwnedTempPath('/tmp/nested/openbuff-foo.log')).toBe(false)
      }
    })

    test('rejects non-temp absolute paths', () => {
      expect(isOwnedTempPath('/etc/passwd')).toBe(false)
      expect(isOwnedTempPath('/var/log/openbuff-foo.log')).toBe(false)
      expect(resolveProjectPath('/some/project', '/etc/passwd')).toBeNull()
    })

    test('rejects empty input', () => {
      expect(isOwnedTempPath('')).toBe(false)
    })

    test('rejects any input containing a .. segment', () => {
      // Built by concatenation, not `path.join`, so the `..` segments survive
      // into the input the helper inspects.
      const traversal = `${tempRoot}/openbuff-x/../../etc/passwd`
      expect(isOwnedTempPath(traversal)).toBe(false)
      expect(resolveProjectPath('/some/project', traversal)).toBeNull()

      // Even a `..` that collapses back into the owned namespace is refused.
      expect(isOwnedTempPath(`${tempRoot}/openbuff-a/../openbuff-b.log`)).toBe(
        false,
      )

      if (literalTmpIsOwnedRoot) {
        expect(isOwnedTempPath('/tmp/openbuff-x/../../etc/passwd')).toBe(false)
      }
    })

    test('rejects an owned-named symlink that dereferences outside the temp root', () => {
      // The symlink target must be clearly OUTSIDE the temp roots for this to
      // be a real escape: a tmpdir -> tmpdir symlink would legitimately still
      // be inside the root. The project directory serves as that target.
      const escapeTarget = fs.realpathSync(process.cwd())
      const targetIsOutsideTempRoots = getOwnedTempRoots().every((root) => {
        const relative = path.relative(fs.realpathSync(root), escapeTarget)
        return (
          relative === '..' ||
          relative.startsWith('..' + path.sep) ||
          path.isAbsolute(relative)
        )
      })
      expect(isOwnedTempPath(escapeTarget)).toBe(false)

      const link = track(
        path.join(tempRoot, `openbuff-escape-${uniqueSuffix()}.log`),
      )
      fs.symlinkSync(escapeTarget, link)

      if (targetIsOutsideTempRoots) {
        // The lexical path looks owned; the dereferenced path is not.
        expect(isOwnedTempPath(link)).toBe(false)
        expect(resolveProjectPath('/some/project', link)).toBeNull()
      }
    })
  })

  describe('project containment is preserved', () => {
    test('still rejects parent traversal from the project root', () => {
      expect(resolveProjectPath('/repo', '../outside')).toBeNull()
      expect(resolveProjectPath('/repo', '../../outside.ts')).toBeNull()
    })

    test('still rejects sibling-prefix escapes', () => {
      expect(resolveProjectPath('/repo', '/repo-evil/file.ts')).toBeNull()
      expect(isPathInsideProject('/repo', '/repo-evil/file.ts')).toBe(false)
    })

    test('still rejects an in-project symlink that dereferences outside the project', () => {
      const projectDir = track(
        fs.mkdtempSync(path.join(os.tmpdir(), 'path-contain-project-')),
      )
      const outsideDir = track(
        fs.mkdtempSync(path.join(os.tmpdir(), 'path-contain-outside-')),
      )
      const outsideFile = path.join(outsideDir, 'secret.ts')
      fs.writeFileSync(outsideFile, 'secret\n')
      fs.symlinkSync(outsideFile, path.join(projectDir, 'evil.ts'))

      expect(resolveProjectPath(projectDir, 'evil.ts')).toBeNull()
      expect(
        resolveProjectPath(projectDir, path.join(projectDir, 'evil.ts')),
      ).toBeNull()
      expect(isPathInsideProject(projectDir, 'evil.ts')).toBe(false)
    })
  })
})
