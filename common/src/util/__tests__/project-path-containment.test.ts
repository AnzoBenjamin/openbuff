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
  configureExternalReadRoots,
  ensureExternalReadRootsConfigured,
  getExternalReadRoots,
  getOwnedTempRoots,
  isExternalReadPath,
  isOwnedTempPath,
  isPathInsideProject,
  resetExternalReadRootsForTesting,
  resolveProjectPath,
  resolveProjectPathForFileSystemRead,
  resolveProjectPathForRead,
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

  test('marks an ordinary in-project path with scope "project"', () => {
    const result = resolveProjectPath('/repo', 'src/a.ts')
    expect(result).not.toBeNull()
    expect(result!.scope).toBe('project')
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

  test('rejects a missing descendant below a symlink whose nearest existing ancestor is outside', () => {
    const missingDescendant = path.join('evil', 'missing', 'deep', 'file.ts')
    expect(resolveProjectPath(tmpDir, missingDescendant)).toBeNull()
    expect(isPathInsideProject(tmpDir, missingDescendant)).toBe(false)
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
      expect(
        isOwnedTempPath(path.join(tempRoot, 'openbuff-test-job-3.log')),
      ).toBe(true)
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

    test('accepts an extension-free mkdtemp-created directory name', () => {
      // mkdtemp appends random alphanumerics to the prefix and creates a
      // DIRECTORY, so the owned name carries no dot-extension.
      expect(
        isOwnedTempPath(path.join(tempRoot, 'openbuff-read-logs-AbC123')),
      ).toBe(true)

      if (literalTmpIsOwnedRoot) {
        expect(isOwnedTempPath('/tmp/openbuff-read-logs-AbC123')).toBe(true)
      }
    })

    test('accepts a nested file beneath an mkdtemp-created directory', () => {
      expect(
        isOwnedTempPath(
          path.join(tempRoot, 'openbuff-read-logs-AbC123', 'inner', 'file.log'),
        ),
      ).toBe(true)
    })

    test('accepts a real mkdtemp-created directory and a file inside it', () => {
      const ownedDir = track(
        fs.mkdtempSync(path.join(tempRoot, 'openbuff-read-logs-')),
      )
      const innerDir = path.join(ownedDir, 'inner')
      fs.mkdirSync(innerDir)
      const innerFile = path.join(innerDir, 'file.log')
      fs.writeFileSync(innerFile, 'line\n')

      expect(isOwnedTempPath(ownedDir)).toBe(true)
      expect(isOwnedTempPath(innerFile)).toBe(true)
    })
  })

  describe('resolveProjectPath owned-temp fallback', () => {
    test('returns the absolute resolved path as relativePath', () => {
      const ownedLog = path.join(tempRoot, `openbuff-job-${uniqueSuffix()}.log`)

      const result = resolveProjectPath('/some/project', ownedLog)

      expect(result).not.toBeNull()
      // Documented behavior: owned temp paths live outside the project, so the
      // "relative" path is the absolute resolved path.
      expect(result!.relativePath).toBe(path.resolve(ownedLog))
      expect(result!.fullPath).toBe(path.resolve(ownedLog))
      expect(result!.scope).toBe('owned-temp')
    })

    test('discriminates the two scopes without inspecting relativePath', () => {
      // Consumers must branch on `scope`, not on `path.isAbsolute(relativePath)`:
      // the absoluteness of `relativePath` is an artifact of the owned-temp
      // fallback, while `scope` is the documented discriminator.
      const ownedLog = path.join(tempRoot, `openbuff-job-${uniqueSuffix()}.log`)
      const ownedResult = resolveProjectPath('/some/project', ownedLog)
      const projectResult = resolveProjectPath('/some/project', 'src/a.ts')

      expect(ownedResult).not.toBeNull()
      expect(projectResult).not.toBeNull()
      expect(ownedResult!.scope).toBe('owned-temp')
      expect(projectResult!.scope).toBe('project')
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

    test('rejects an openbuff-prefixed file with a non-log/json extension', () => {
      // The tightened patterns are anchored full-segment shapes: the
      // file pattern only admits `.log`/`.json`, and the mkdtemp DIRECTORY
      // pattern excludes dots, so it must not rescue a dotted name. This is
      // asserted on the predicate/resolver, never on filesystem state.
      const evil = path.join(tempRoot, 'openbuff-evil.sh')
      expect(isOwnedTempPath(evil)).toBe(false)
      expect(resolveProjectPath('/some/project', evil)).toBeNull()
      expect(isPathInsideProject('/some/project', evil)).toBe(false)

      // Also rejected for a nested path beneath the same segment.
      expect(
        isOwnedTempPath(path.join(tempRoot, 'openbuff-evil.sh', 'payload')),
      ).toBe(false)

      if (literalTmpIsOwnedRoot) {
        expect(isOwnedTempPath('/tmp/openbuff-evil.sh')).toBe(false)
      }
    })

    test('rejects other non-log/json extensions on an owned-looking name', () => {
      const doubleExtension = path.join(tempRoot, 'openbuff-x.log.sh')
      const textExtension = path.join(tempRoot, 'openbuff-x.txt')

      expect(isOwnedTempPath(doubleExtension)).toBe(false)
      expect(isOwnedTempPath(textExtension)).toBe(false)
      expect(resolveProjectPath('/some/project', doubleExtension)).toBeNull()
      expect(resolveProjectPath('/some/project', textExtension)).toBeNull()

      if (literalTmpIsOwnedRoot) {
        expect(isOwnedTempPath('/tmp/openbuff-x.log.sh')).toBe(false)
        expect(isOwnedTempPath('/tmp/openbuff-x.txt')).toBe(false)
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

describe('external read root allowlist', () => {
  const projectRoot = '/repo'
  let allowedRoot: string
  let siblingRoot: string
  let outsideDir: string
  let allowedFile: string

  const cleanupPaths: string[] = []
  const removeTracked = () => {
    for (const target of cleanupPaths.splice(0)) {
      // `rmSync` unlinks symlinks rather than following them, so a link that
      // points outside the temp dirs can never be traversed during cleanup.
      fs.rmSync(target, { force: true, recursive: true })
    }
  }

  beforeEach(() => {
    // Mandatory: the registry is module state, so an unreset configuration
    // would leave an open read boundary for every later test in the process.
    resetExternalReadRootsForTesting()

    allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'external-read-'))
    cleanupPaths.push(allowedRoot)
    // Sibling directory sharing the allowlisted root's prefix.
    siblingRoot = `${allowedRoot}-evil`
    fs.mkdirSync(siblingRoot)
    cleanupPaths.push(siblingRoot)
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'external-outside-'))
    cleanupPaths.push(outsideDir)

    allowedFile = path.join(allowedRoot, 'notes.txt')
    fs.writeFileSync(allowedFile, 'notes\n')
    fs.writeFileSync(path.join(siblingRoot, 'file.txt'), 'sibling\n')
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'secret\n')
  })

  afterEach(() => {
    resetExternalReadRootsForTesting()
    removeTracked()
  })

  describe('default-closed posture', () => {
    test('is unconfigured and refuses outside paths', () => {
      expect(getExternalReadRoots()).toEqual([])
      expect(isExternalReadPath(allowedFile)).toBe(false)
      expect(resolveProjectPathForRead(projectRoot, allowedFile)).toBeNull()
    })

    test('read resolver still behaves exactly like the write resolver in-project', () => {
      const readResult = resolveProjectPathForRead(projectRoot, 'src/a.ts')
      const writeResult = resolveProjectPath(projectRoot, 'src/a.ts')
      expect(readResult).toEqual(writeResult)
      expect(readResult!.scope).toBe('project')
    })
  })

  describe('once configured', () => {
    beforeEach(() => {
      configureExternalReadRoots([allowedRoot])
    })

    test('stores the resolved root and returns a defensive copy', () => {
      expect(getExternalReadRoots()).toEqual([path.resolve(allowedRoot)])
      const copy = getExternalReadRoots()
      copy.push('/mutated')
      expect(getExternalReadRoots()).toEqual([path.resolve(allowedRoot)])
    })

    test('resolves a file strictly inside the root with scope "external-read"', () => {
      expect(isExternalReadPath(allowedFile)).toBe(true)

      const result = resolveProjectPathForRead(projectRoot, allowedFile)
      expect(result).not.toBeNull()
      expect(result!.scope).toBe('external-read')
      // Outside the project, so `relativePath` is the absolute resolved path.
      expect(result!.relativePath).toBe(path.resolve(allowedFile))
      expect(result!.fullPath).toBe(path.resolve(allowedFile))
      expect(path.isAbsolute(result!.relativePath)).toBe(true)
    })

    test('resolves a nested file inside the root', () => {
      const nestedDir = path.join(allowedRoot, 'nested')
      fs.mkdirSync(nestedDir)
      const nestedFile = path.join(nestedDir, 'deep.txt')
      fs.writeFileSync(nestedFile, 'deep\n')

      expect(isExternalReadPath(nestedFile)).toBe(true)
      const nested = resolveProjectPathForRead(projectRoot, nestedFile)
      expect(nested).not.toBeNull()
      expect(nested!.scope).toBe('external-read')
    })

    test('rejects the allowlisted root itself (strictly-inside rule)', () => {
      expect(isExternalReadPath(allowedRoot)).toBe(false)
      expect(resolveProjectPathForRead(projectRoot, allowedRoot)).toBeNull()
    })

    test('rejects a sibling-prefix directory (naive startsWith would admit it)', () => {
      const siblingFile = path.join(siblingRoot, 'file.txt')
      expect(isExternalReadPath(siblingFile)).toBe(false)
      expect(resolveProjectPathForRead(projectRoot, siblingFile)).toBeNull()
    })

    test('rejects a raw .. input even when it collapses back inside the root', () => {
      // Built by concatenation so the `..` segment survives into the input.
      const collapsing = `${allowedRoot}/nested/../notes.txt`
      expect(isExternalReadPath(collapsing)).toBe(false)
      expect(resolveProjectPathForRead(projectRoot, collapsing)).toBeNull()

      const escaping = `${allowedRoot}/../${path.basename(outsideDir)}/secret.txt`
      expect(isExternalReadPath(escaping)).toBe(false)
      expect(resolveProjectPathForRead(projectRoot, escaping)).toBeNull()
    })

    test('rejects a symlink inside the root that dereferences outside it', () => {
      const link = path.join(allowedRoot, 'escape.txt')
      let symlinkSupported = true
      try {
        fs.symlinkSync(path.join(outsideDir, 'secret.txt'), link)
      } catch {
        // Some platforms (e.g. Windows without privileges) refuse symlinks.
        symlinkSupported = false
      }
      if (!symlinkSupported) return

      expect(isExternalReadPath(link)).toBe(false)
      expect(resolveProjectPathForRead(projectRoot, link)).toBeNull()
    })

    test('refuses credentials.json inside the root at the resolver (fail-closed)', () => {
      const credentials = path.join(allowedRoot, 'credentials.json')
      fs.writeFileSync(credentials, '{"apiKey":"redacted"}\n')

      // Pinned on BOTH the predicate and the resolver, so a handler cannot be
      // the only thing standing between an allowlisted config root and the
      // stored OAuth tokens.
      expect(isExternalReadPath(credentials)).toBe(false)
      expect(resolveProjectPathForRead(projectRoot, credentials)).toBeNull()

      // A non-sensitive neighbour in the same root stays readable.
      expect(isExternalReadPath(allowedFile)).toBe(true)
    })

    test('WRITE-PATH INVARIANT: resolveProjectPath never reaches an allowlisted external root', () => {
      // The load-bearing separation: the resolvers used by change_file /
      // replace_range / filesystem-authority must stay blind to the read
      // allowlist even while it is configured.
      expect(resolveProjectPath(projectRoot, allowedFile)).toBeNull()
      expect(isPathInsideProject(projectRoot, allowedFile)).toBe(false)
      // ...while the read-only entry point does reach it.
      expect(resolveProjectPathForRead(projectRoot, allowedFile)).not.toBeNull()
    })

    test('async read resolver agrees with the sync resolver', async () => {
      const allowed = await resolveProjectPathForFileSystemRead(
        projectRoot,
        allowedFile,
        fs.promises,
      )
      expect(allowed).not.toBeNull()
      expect(allowed!.scope).toBe('external-read')
      expect(allowed!.relativePath).toBe(path.resolve(allowedFile))

      const denied = await resolveProjectPathForFileSystemRead(
        projectRoot,
        path.join(siblingRoot, 'file.txt'),
        fs.promises,
      )
      expect(denied).toBeNull()
    })

    test('async read resolver applies the sensitive refusal too', async () => {
      const credentials = path.join(allowedRoot, 'credentials.json')
      fs.writeFileSync(credentials, '{"apiKey":"redacted"}\n')

      expect(
        await resolveProjectPathForFileSystemRead(
          projectRoot,
          credentials,
          fs.promises,
        ),
      ).toBeNull()
    })

    test('re-configuring with an equivalent set is a no-op', () => {
      configureExternalReadRoots([allowedRoot])
      // Same set, different spelling/order still resolves identically.
      configureExternalReadRoots([`${allowedRoot}${path.sep}`, '  '])
      expect(getExternalReadRoots()).toEqual([path.resolve(allowedRoot)])
    })

    test('re-configuring with a different set throws', () => {
      expect(() => configureExternalReadRoots([siblingRoot])).toThrow(Error)
      // The original boundary is untouched by the refused attempt.
      expect(getExternalReadRoots()).toEqual([path.resolve(allowedRoot)])
      expect(isExternalReadPath(path.join(siblingRoot, 'file.txt'))).toBe(false)
    })
  })

  describe('configuration entry filtering', () => {
    test('skips a filesystem-root entry', () => {
      const filesystemRoot = path.resolve('/')
      configureExternalReadRoots([filesystemRoot, allowedRoot])

      expect(getExternalReadRoots()).toEqual([path.resolve(allowedRoot)])
      // Allowlisting `/` would have made the whole filesystem readable.
      expect(isExternalReadPath('/etc/hosts')).toBe(false)
      expect(isExternalReadPath(allowedFile)).toBe(true)
    })

    test('skips an entry containing a raw .. segment', () => {
      configureExternalReadRoots([`${allowedRoot}/../elsewhere`, allowedRoot])

      expect(getExternalReadRoots()).toEqual([path.resolve(allowedRoot)])
      const skipped = path.join(path.dirname(allowedRoot), 'elsewhere', 'x')
      expect(isExternalReadPath(skipped)).toBe(false)
    })

    test('drops empty entries and stays closed when nothing survives', () => {
      configureExternalReadRoots(['', '   ', path.resolve('/')])

      expect(getExternalReadRoots()).toEqual([])
      expect(isExternalReadPath(allowedFile)).toBe(false)
      expect(resolveProjectPathForRead(projectRoot, allowedFile)).toBeNull()
    })
  })

  describe('ensureExternalReadRootsConfigured', () => {
    test('reports "configured" for the first successful configuration', () => {
      const result = ensureExternalReadRootsConfigured([allowedRoot])

      expect(result.status).toBe('configured')
      expect(result.roots).toEqual([path.resolve(allowedRoot)])
      expect(isExternalReadPath(allowedFile)).toBe(true)
    })

    test('reports "unchanged" for an equivalent second call', () => {
      expect(ensureExternalReadRootsConfigured([allowedRoot]).status).toBe(
        'configured',
      )

      // Same set, different spelling/order, plus a dropped blank entry.
      const result = ensureExternalReadRootsConfigured([
        `${allowedRoot}${path.sep}`,
        '  ',
      ])
      expect(result.status).toBe('unchanged')
      expect(result.roots).toEqual([path.resolve(allowedRoot)])
    })

    test('reports "refused-changed" without throwing and keeps the earlier boundary', () => {
      ensureExternalReadRootsConfigured([allowedRoot])

      // A mid-session edit to openbuff.json must not crash the turn, and must
      // not widen a boundary earlier reads were already validated against.
      const result = ensureExternalReadRootsConfigured([siblingRoot])

      expect(result.status).toBe('refused-changed')
      expect(result.roots).toEqual([path.resolve(allowedRoot)])
      if (result.status === 'refused-changed') {
        expect(result.attempted).toEqual([path.resolve(siblingRoot)])
      }
      // The registry itself is untouched by the refused attempt.
      expect(getExternalReadRoots()).toEqual([path.resolve(allowedRoot)])
      expect(isExternalReadPath(allowedFile)).toBe(true)
      expect(isExternalReadPath(path.join(siblingRoot, 'file.txt'))).toBe(false)
    })

    test('a first configuration whose entries are all skipped still reports "configured"', () => {
      // Every entry is refused by normalization, so the stored value is `[]` —
      // which must not be misreported as an already-configured "unchanged".
      const result = ensureExternalReadRootsConfigured([path.resolve('/'), ' '])

      expect(result.status).toBe('configured')
      expect(result.roots).toEqual([])
      // ...and a later differing set is refused rather than applied.
      expect(ensureExternalReadRootsConfigured([allowedRoot]).status).toBe(
        'refused-changed',
      )
      expect(isExternalReadPath(allowedFile)).toBe(false)
    })
  })

  describe('projectRoot owner (ER-5)', () => {
    // The registry is process-global while `cwd` is per-run, so the boundary is
    // tagged with the project it belongs to: a genuine project switch must
    // REPLACE the boundary instead of being refused, which would otherwise
    // leave project A's roots readable while project B's never applied.
    const projectA = path.resolve('/project-a')
    const projectB = path.resolve('/project-b')

    test('a different owner REPLACES the boundary', () => {
      expect(
        ensureExternalReadRootsConfigured([allowedRoot], projectA).status,
      ).toBe('configured')
      expect(isExternalReadPath(allowedFile)).toBe(true)

      const switched = ensureExternalReadRootsConfigured(
        [siblingRoot],
        projectB,
      )

      expect(switched.status).toBe('configured')
      expect(switched.roots).toEqual([path.resolve(siblingRoot)])
      expect(getExternalReadRoots()).toEqual([path.resolve(siblingRoot)])
      // The new project's boundary is the one in force, not project A's.
      expect(isExternalReadPath(path.join(siblingRoot, 'file.txt'))).toBe(true)
      expect(isExternalReadPath(allowedFile)).toBe(false)
    })

    test('the SAME owner with a different set is still refused', () => {
      configureExternalReadRoots([allowedRoot], projectA)

      // Same project mid-run: this is the configure-once violation the registry
      // exists to prevent, owner or not.
      expect(() =>
        configureExternalReadRoots([siblingRoot], projectA),
      ).toThrow(Error)
      expect(getExternalReadRoots()).toEqual([path.resolve(allowedRoot)])

      const refused = ensureExternalReadRootsConfigured([siblingRoot], projectA)
      expect(refused.status).toBe('refused-changed')
      expect(refused.roots).toEqual([path.resolve(allowedRoot)])
      expect(isExternalReadPath(path.join(siblingRoot, 'file.txt'))).toBe(false)
    })

    test('an equivalent call adopts an owner the first call did not supply', () => {
      // First call has no owner, so the registry has no project to compare a
      // later switch against.
      expect(ensureExternalReadRootsConfigured([allowedRoot]).status).toBe(
        'configured',
      )

      // Equivalent set WITH an owner: reported as unchanged, but the owner is
      // adopted...
      expect(
        ensureExternalReadRootsConfigured([allowedRoot], projectA).status,
      ).toBe('unchanged')

      // ...so this genuine switch is detected and replaces the boundary rather
      // than being refused as an unknown-owner reconfiguration.
      const switched = ensureExternalReadRootsConfigured(
        [siblingRoot],
        projectB,
      )
      expect(switched.status).toBe('configured')
      expect(getExternalReadRoots()).toEqual([path.resolve(siblingRoot)])
    })

    test('without an adopted owner a later switch is refused', () => {
      // Contrast case for the adoption above: no owner is ever recorded, so a
      // second project cannot be distinguished from a mid-run re-point.
      ensureExternalReadRootsConfigured([allowedRoot])

      const refused = ensureExternalReadRootsConfigured([siblingRoot], projectB)

      expect(refused.status).toBe('refused-changed')
      expect(getExternalReadRoots()).toEqual([path.resolve(allowedRoot)])
    })
  })
})
