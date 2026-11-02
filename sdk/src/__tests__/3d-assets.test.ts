import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { afterEach, describe, expect, test } from 'bun:test'

import {
  edit3dAsset,
  inspect3dAsset,
  MAX_OPERATIONS_FILE_CHARS,
  MUTATION_ARTIFACT_PRUNE_MAX_STATS,
  MUTATION_ARTIFACT_RETENTION_MS,
  MUTATION_PRUNE_STRIDE_EDITS,
  MUTATION_RETAINED_ATTEMPT_ARTIFACTS,
  render3dPreview,
} from '../tools/3d-assets'
import { hashFileContent } from '../tools/filesystem-authority'
import { createNodeFileSystem } from '../tools/node-filesystem'
import { prune3dMutationArtifacts } from '../tools/3d-artifact-retention'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function makeGlb(document: object): Buffer {
  const json = Buffer.from(JSON.stringify(document), 'utf8')
  const paddedLength = Math.ceil(json.length / 4) * 4
  const output = Buffer.alloc(20 + paddedLength, 0x20)
  output.write('glTF', 0, 'ascii')
  output.writeUInt32LE(2, 4)
  output.writeUInt32LE(output.length, 8)
  output.writeUInt32LE(paddedLength, 12)
  output.writeUInt32LE(0x4e4f534a, 16)
  json.copy(output, 20)
  return output
}

function valueOf(result: Awaited<ReturnType<typeof inspect3dAsset>>) {
  const part = result[0]
  if (part.type !== 'json') throw new Error('Expected JSON output')
  return part.value as Record<string, any>
}

describe('inspect3dAsset', () => {
  test('summarizes glTF and GLB scene structure without Blender', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-3d-tools-'))
    roots.push(root)
    const document = {
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'Hero', mesh: 0 }],
      meshes: [{ name: 'Body', primitives: [{ attributes: {} }] }],
      materials: [{ name: 'PortfolioMaterial' }],
      animations: [{ name: 'Idle' }],
    }
    fs.writeFileSync(path.join(root, 'scene.gltf'), JSON.stringify(document))
    fs.writeFileSync(path.join(root, 'scene.glb'), makeGlb(document))
    const fileSystem = createNodeFileSystem()

    for (const assetPath of ['scene.gltf', 'scene.glb']) {
      const value = valueOf(
        await inspect3dAsset({ path: assetPath, cwd: root, fs: fileSystem }),
      )
      expect(value.error).toBeUndefined()
      expect(value.summary.nodes[0].name).toBe('Hero')
      expect(value.summary.meshes[0]).toEqual({
        name: 'Body',
        primitiveCount: 1,
      })
      expect(value.summary.materials).toEqual(['PortfolioMaterial'])
      expect(value.summary.animations).toEqual(['Idle'])
      expect(value.sourceHash).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  test('summarizes OBJ geometry and rejects traversal', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-3d-tools-'))
    roots.push(root)
    fs.writeFileSync(
      path.join(root, 'mesh.obj'),
      'mtllib scene.mtl\no Cube\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl Red\nf 1 2 3\n',
    )
    const fileSystem = createNodeFileSystem()
    const value = valueOf(
      await inspect3dAsset({ path: 'mesh.obj', cwd: root, fs: fileSystem }),
    )
    expect(value.summary).toMatchObject({
      vertices: 3,
      faces: 1,
      objects: ['Cube'],
      materials: ['Red'],
      materialLibraries: ['scene.mtl'],
    })

    const escaped = valueOf(
      await inspect3dAsset({ path: '../mesh.obj', cwd: root, fs: fileSystem }),
    )
    expect(escaped.error).toContain('outside the project root')
  })

  test('applies the host file filter before inspecting an asset', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-3d-tools-'))
    roots.push(root)
    fs.writeFileSync(path.join(root, 'private.obj'), 'v 0 0 0\n')

    const value = valueOf(
      await inspect3dAsset({
        path: 'private.obj',
        cwd: root,
        fs: createNodeFileSystem(),
        fileFilter: () => ({ status: 'blocked' }),
      }),
    )
    expect(value.error).toContain('authorized filesystem policy')
  })

  test('rejects a stale declarative edit before invoking Blender or writing artifacts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-3d-tools-'))
    roots.push(root)
    fs.writeFileSync(path.join(root, 'scene.blend'), Buffer.from('fixture'))
    const fileSystem = Object.assign(createNodeFileSystem(), {
      mutationAuthority: 'cooperative_cas' as const,
      conditionalCommit: async () => ({ applied: true as const }),
    })

    const result = await edit3dAsset({
      path: 'scene.blend',
      sourceHash: '0'.repeat(64),
      operations: [{ type: 'rename_object', object: 'Cube', new_name: 'Hero' }],
      cwd: root,
      fs: fileSystem,
      operationId: '../../escape',
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        outcome: 'not_applied',
        errors: [{ message: expect.stringContaining('source hash is stale') }],
      },
    })
    expect(fs.existsSync(path.join(root, '.openbuff'))).toBe(false)
  })

  test('writes the operations payload to a file instead of the child env', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-3d-tools-'))
    roots.push(root)
    const fixture = Buffer.from('fixture')
    fs.writeFileSync(path.join(root, 'scene.blend'), fixture)
    const operations = [
      { type: 'rename_object', object: 'Cube', new_name: 'Hero' },
    ]
    const operationsRoot = path.join(
      root,
      '.openbuff/artifacts/3d/mutations/operations-file/current',
    )

    // No Blender needed for the assertion, and NO post-call assertion either:
    // the run directory is owned by the attempt and released on every
    // not_applied exit (which is what this call takes without Blender). So the
    // payload is captured from inside the attempt, via the CONTRACTED `unlink`
    // member the release path uses, at the moment the file is released. The
    // release path deliberately touches only contracted adapter members
    // (readdir/unlink/stat), so it is captured here through `unlink` rather than
    // through an `rm` hook the published contract does not declare.
    //
    // The filename carries the attempt uuid (`<attemptId>.json`), so it is not
    // predictable from the operationId: match the operations payload by its
    // suffix inside the stable release target.
    let capturedOperations: string | undefined
    const baseFileSystem = createNodeFileSystem()
    const fileSystem: typeof baseFileSystem = Object.assign(
      Object.create(baseFileSystem),
      {
        mutationAuthority: 'cooperative_cas' as const,
        conditionalCommit: async () => ({ applied: true as const }),
        unlink: async (target: fs.PathLike) => {
          const entryPath = String(target)
          if (
            path.dirname(entryPath) === operationsRoot &&
            path.basename(entryPath).endsWith('.json') &&
            fs.existsSync(entryPath)
          ) {
            capturedOperations = fs.readFileSync(entryPath, 'utf8')
          }
          await baseFileSystem.unlink(target)
        },
      },
    )

    await edit3dAsset({
      path: 'scene.blend',
      sourceHash: hashFileContent(fixture).replace(/^sha256:/, ''),
      operations,
      cwd: root,
      fs: fileSystem,
      operationId: 'operations-file',
    })

    // The payload crossed to Blender as a file, not as an env value.
    expect(capturedOperations).toBe(JSON.stringify(operations))
  })

  test('bounds the operations payload at a fixed baseline: below, at, and 2x the cap', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-3d-tools-'))
    roots.push(root)
    const fixture = Buffer.from('fixture')
    fs.writeFileSync(path.join(root, 'scene.blend'), fixture)

    // A `rename_object` whose payload is EXACTLY `targetChars` once serialized,
    // so the below/at/2x cases straddle the documented bound rather than
    // approximating it with a hand-sized string.
    const operationsAtSize = (targetChars: number) => {
      const base = [
        { type: 'rename_object' as const, object: 'Cube', new_name: '' },
      ]
      const pad = targetChars - JSON.stringify(base).length
      return [
        {
          type: 'rename_object' as const,
          object: 'Cube',
          new_name: 'n'.repeat(pad),
        },
      ]
    }

    // The enforced ceiling is the OWNER's EXPORTED value, exactly like the
    // set_output fixtures pin theirs. Reading a bound out of the rejection PROSE
    // (`/the limit is (\d+)/`) made the baseline track the message text instead
    // of the enforced cap, so an edit to the wording silently turned the
    // baseline into a NaN guard that reported nothing about a cap change.
    expect(MAX_OPERATIONS_FILE_CHARS).toBe(100_000)
    const limit = MAX_OPERATIONS_FILE_CHARS

    const run = async (
      operationId: string,
      targetChars: number,
      capture: boolean,
    ) => {
      const operations = operationsAtSize(targetChars)
      expect(JSON.stringify(operations)).toHaveLength(targetChars)
      // Captured at release time, like the sibling env->file test: the payload
      // lives in the stable release target
      // (`.openbuff/artifacts/3d/mutations/<operationId>/current/`) under an
      // attempt-uuid filename, so the path is NOT predictable from the
      // operationId and the release hook is the only place the payload can be
      // observed. The hook is the CONTRACTED `unlink` the release path uses,
      // not an undeclared `rm`.
      const operationsRoot = path.join(
        root,
        '.openbuff/artifacts/3d/mutations',
        operationId,
        'current',
      )
      const releasedEntries: string[] = []
      let operationsWriteCount = 0
      let capturedOperations: string | undefined
      const baseFileSystem = createNodeFileSystem()
      const fileSystem: typeof baseFileSystem = Object.assign(
        Object.create(baseFileSystem),
        {
          mutationAuthority: 'cooperative_cas' as const,
          conditionalCommit: async () => ({ applied: true as const }),
          writeFile: async (
            target: fs.PathLike,
            data: string | NodeJS.ArrayBufferView,
            options?: { flag?: string },
          ) => {
            const entryPath = String(target)
            if (
              path.dirname(entryPath) === operationsRoot &&
              path.basename(entryPath).endsWith('.json')
            ) {
              operationsWriteCount += 1
            }
            await baseFileSystem.writeFile(target, data, options)
          },
          ...(capture
            ? {
                unlink: async (target: fs.PathLike) => {
                  const entryPath = String(target)
                  if (
                    path.dirname(entryPath) === operationsRoot &&
                    path.basename(entryPath).endsWith('.json') &&
                    fs.existsSync(entryPath)
                  ) {
                    capturedOperations = fs.readFileSync(entryPath, 'utf8')
                    releasedEntries.push(path.basename(entryPath))
                  }
                  await baseFileSystem.unlink(target)
                },
              }
            : {}),
        },
      )
      const result = await edit3dAsset({
        path: 'scene.blend',
        sourceHash: hashFileContent(fixture).replace(/^sha256:/, ''),
        operations,
        cwd: root,
        fs: fileSystem,
        operationId,
      })
      return {
        result,
        capturedOperations,
        releasedEntries,
        operationsWriteCount,
        operationsRoot,
      }
    }

    /*
     * GENUINELY SMALLER payload (1_000 chars, two orders of magnitude below the
     * cap): the operations file is written EXACTLY once, and the attempt takes no
     * release-path interception of a DIFFERENT file — the below-cap case used to
     * be `limit - 1`, which proved only that the boundary was accepted.
     */
    const small = await run('operations-small', 1_000, true)
    expect(small.operationsWriteCount).toBe(1)
    expect(small.capturedOperations).toHaveLength(1_000)
    expect(small.releasedEntries).toHaveLength(1)

    // Exactly AT the cap: accepted and written verbatim.
    const atCap = await run('operations-at-cap', limit, true)
    const atCapErrors =
      (atCap.result[0] as { value: { errors?: Array<{ message: string }> } })
        .value.errors ?? []
    expect(
      atCapErrors.some((error) => error.message.includes('too large')),
    ).toBe(false)
    expect(atCap.operationsWriteCount).toBe(1)
    expect(atCap.capturedOperations).toHaveLength(limit)

    // 2x the cap: rejected before ANYTHING is created, so no artifact leaks AND
    // no directory is left behind. The rejection is a cheap, pre-mkdir check:
    // if it ever moved back below the `mkdir`, this assertion fails instead of
    // silently accumulating an empty leaf directory per attempt.
    const rejected = await run('operations-2x-cap-rejected', limit * 2, true)
    expect(rejected.result[0]).toMatchObject({
      type: 'json',
      value: {
        outcome: 'not_applied',
        errors: [{ message: expect.stringContaining('too large') }],
      },
    })
    expect(rejected.capturedOperations).toBeUndefined()
    expect(rejected.operationsWriteCount).toBe(0)
    expect(fs.existsSync(rejected.operationsRoot)).toBe(false)
    /*
     * FIXED BASELINE: non-applied attempts leave ZERO artifacts and ZERO
     * attempt directories behind. The release target is shared and its files are
     * attempt-scoped, so an abandoned attempt never accumulates on disk — the
     * previous per-attempt-uuid layout left one empty leaf directory per attempt
     * forever (a directory could be emptied but never removed through the
     * contracted adapter surface).
     */
    for (const operationId of [
      'operations-small',
      'operations-at-cap',
      'operations-2x-cap-rejected',
    ]) {
      const releasedTarget = path.join(
        root,
        '.openbuff/artifacts/3d/mutations',
        operationId,
        'current',
      )
      const remaining = fs.existsSync(releasedTarget)
        ? fs.readdirSync(releasedTarget)
        : []
      expect(remaining).toEqual([])
    }
  })

  test('removes the run artifact directory when an edit is not applied', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-3d-tools-'))
    roots.push(root)
    const fixture = Buffer.from('fixture')
    fs.writeFileSync(path.join(root, 'scene.blend'), fixture)
    const fileSystem = Object.assign(createNodeFileSystem(), {
      mutationAuthority: 'cooperative_cas' as const,
      conditionalCommit: async () => ({ applied: true as const }),
    })

    // This rejection happens AFTER working.blend, edit-asset.py and the run
    // directory were written, so it is the not_applied path that used to leak
    // a full asset copy plus the operations payload for every abandoned
    // attempt (operationIds are generated per attempt when absent/invalid).
    const result = await edit3dAsset({
      path: 'scene.blend',
      sourceHash: hashFileContent(fixture).replace(/^sha256:/, ''),
      operations: [
        {
          type: 'rename_object',
          object: 'Cube',
          new_name: 'x'.repeat(500_001),
        },
      ],
      cwd: root,
      fs: fileSystem,
      operationId: 'operations-too-large',
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        outcome: 'not_applied',
        errors: [{ message: expect.stringContaining('too large') }],
      },
    })
    // FIXED BASELINE: a non-applied attempt leaves ZERO artifacts behind. The
    // release target is shared and its files are attempt-scoped, so there is no
    // per-attempt directory to abandon and nothing to tolerate as an empty
    // leftover.
    const releaseTarget = path.join(
      root,
      '.openbuff/artifacts/3d/mutations/operations-too-large/current',
    )
    expect(
      fs.existsSync(releaseTarget) ? fs.readdirSync(releaseTarget) : [],
    ).toEqual([])
  })

  test('pins every retained-artifact bound to its own literal', () => {
    // PER-COMPONENT fixed baselines, the same discipline the set_output fixture
    // applies to its budgets. These three constants are the whole per-attempt
    // disk-growth budget, and a multiplier on any one of them (an 8x raise of
    // the retained-copy count, a 64x raise of the prune stat window, a longer
    // age bound) used to pass the suite silently. Each is pinned to its OWN
    // literal so a compensating pair of changes fails on the component that
    // moved instead of cancelling out.
    expect(MUTATION_RETAINED_ATTEMPT_ARTIFACTS).toBe(8)
    expect(MUTATION_ARTIFACT_PRUNE_MAX_STATS).toBe(64)
    expect(MUTATION_ARTIFACT_RETENTION_MS).toBe(24 * 60 * 60 * 1000)
    // The retention count is a bound on FULL asset copies, so it must stay a
    // small constant rather than tracking anything derived from the tree.
    expect(MUTATION_RETAINED_ATTEMPT_ARTIFACTS).toBeLessThan(
      MUTATION_ARTIFACT_PRUNE_MAX_STATS,
    )
  })

  test('still returns the structured not_applied receipt when cleanup itself throws', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-3d-tools-'))
    roots.push(root)
    const fixture = Buffer.from('fixture')
    fs.writeFileSync(path.join(root, 'scene.blend'), fixture)
    const baseFileSystem = createNodeFileSystem()
    const controller = new AbortController()
    let commitCalled = false

    /*
     * A hostile adapter whose `readdir` RESOLVES to a non-iterable. That throws
     * at the `for (... of entries)` site — outside the per-entry guards — so
     * without an outer guard on the release path the throw escapes
     * `tryReleaseArtifactDir` → `releaseArtifactDir` → `notApplied` and replaces
     * the caller's structured `not_applied` receipt with an exception (the
     * outer catch cannot rescue it: it calls the same `notApplied`).
     */
    const fileSystem: typeof baseFileSystem = Object.assign(
      Object.create(baseFileSystem),
      {
        mutationAuthority: 'cooperative_cas' as const,
        conditionalCommit: async () => {
          commitCalled = true
          return { applied: true as const }
        },
        writeFile: async (
          ...args: Parameters<typeof baseFileSystem.writeFile>
        ) => {
          await baseFileSystem.writeFile(...args)
          // Cancel after the attempt files exist, before starting Blender.
          // This exercises failed cleanup even when Blender is not installed.
          if (String(args[0]).endsWith('.json')) controller.abort()
        },
        readdir: (async () => null) as unknown as typeof baseFileSystem.readdir,
      },
    )

    // Cancellation preserves the real diagnosis when cleanup cannot enumerate
    // its own files; no external executable is needed for this failure path.
    const result = await edit3dAsset({
      path: 'scene.blend',
      sourceHash: hashFileContent(fixture).replace(/^sha256:/, ''),
      operations: [{ type: 'rename_object', object: 'Cube', new_name: 'Hero' }],
      cwd: root,
      fs: fileSystem,
      operationId: 'cleanup-throws',
      signal: controller.signal,
    })

    // The receipt is still returned, with its real diagnosis.
    expect(result[0]).toMatchObject({
      type: 'json',
      value: {
        outcome: 'not_applied',
        errors: [{ message: expect.stringContaining('cancelled') }],
      },
    })
    expect(commitCalled).toBe(false)
    // Ownership is NOT surrendered on an unconfirmed release: this attempt's
    // files stay in the shared release target so a later release attempt can
    // retry rather than leaking an unreclaimable copy.
    const releaseTarget = path.join(
      root,
      '.openbuff/artifacts/3d/mutations/cleanup-throws/current',
    )
    const survivingEntries = fs.readdirSync(releaseTarget)
    expect(
      survivingEntries.filter((entry) => entry.endsWith('.blend')),
    ).toHaveLength(1)
    expect(survivingEntries.some((entry) => entry.endsWith('.blend'))).toBe(
      true,
    )
  })

  test('keeps a previous attempt artifact when a retry with the same operationId is not applied', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-3d-tools-'))
    roots.push(root)
    const fixture = Buffer.from('fixture')
    fs.writeFileSync(path.join(root, 'scene.blend'), fixture)

    /*
     * A previous attempt with this operationId already RETURNED this artifact
     * path. Because the filename is attempt-scoped it still exists and is still
     * readable, which is the whole point of the receipt's promise.
     */
    const releaseTarget = path.join(
      root,
      '.openbuff/artifacts/3d/mutations/shared-operation-id/current',
    )
    fs.mkdirSync(releaseTarget, { recursive: true })
    const previousArtifactPath = path.join(
      releaseTarget,
      'previous-attempt.blend',
    )
    fs.writeFileSync(previousArtifactPath, Buffer.from('previous-attempt'))

    const fileSystem = Object.assign(createNodeFileSystem(), {
      mutationAuthority: 'cooperative_cas' as const,
      conditionalCommit: async () => ({ applied: true as const }),
    })

    // A retrying caller REUSES the explicit, correlated operationId.
    const result = await edit3dAsset({
      path: 'scene.blend',
      sourceHash: hashFileContent(fixture).replace(/^sha256:/, ''),
      operations: [
        {
          type: 'rename_object',
          object: 'Cube',
          new_name: 'x'.repeat(500_001),
        },
      ],
      cwd: root,
      fs: fileSystem,
      operationId: 'shared-operation-id',
    })

    expect(result[0]).toMatchObject({
      type: 'json',
      value: { outcome: 'not_applied' },
    })
    // The retry released only ITS OWN files, leaving the earlier attempt's
    // artifact in place: the release is prefix-scoped, so a previous receipt's
    // `artifactPath` keeps pointing at a readable file.
    const remainingEntries = fs.readdirSync(releaseTarget)
    expect(remainingEntries).toEqual(['previous-attempt.blend'])
    // ...so the artifact a returned receipt names is untouched. Deleting it
    // would dangle that pointer while the source edit stayed applied.
    expect(fs.readFileSync(previousArtifactPath, 'utf8')).toBe(
      'previous-attempt',
    )
  })

  test.skipIf(!fs.existsSync('/usr/bin/blender'))(
    'reports commit_outcome_unknown and retains the attempt artifacts when the guarded commit rejects',
    async () => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'openbuff-3d-commit-unknown-'),
      )
      roots.push(root)
      const blendPath = path.join(root, 'commit-unknown.blend')
      const created = spawnSync(
        'blender',
        [
          '--background',
          '--python-expr',
          `import bpy; bpy.ops.mesh.primitive_cube_add(); bpy.context.object.name='Cube'; bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(blendPath)})`,
        ],
        { encoding: 'utf8', timeout: 60_000 },
      )
      expect(created.status).toBe(0)
      const sourceHash = hashFileContent(fs.readFileSync(blendPath)).replace(
        /^sha256:/,
        '',
      )

      /*
       * A guarded commit that REJECTS while being applied: the edit may or may
       * not have landed. Reporting `not_applied` here would assert a revert that
       * was never observed and would delete the only copy of the attempted
       * result, so the receipt must carry `commit_outcome_unknown` and retain the
       * files for reconciliation.
       */
      const baseFileSystem = createNodeFileSystem()
      const fileSystem = Object.assign(Object.create(baseFileSystem), {
        mutationAuthority: 'cooperative_cas' as const,
        conditionalCommit: async () => {
          throw new Error('adapter closed mid-commit')
        },
      })

      const result = await edit3dAsset({
        path: 'commit-unknown.blend',
        sourceHash,
        operations: [
          { type: 'rename_object', object: 'Cube', new_name: 'RenamedCube' },
        ],
        cwd: root,
        fs: fileSystem,
        operationId: 'commit-unknown',
      })

      const receipt = valueOf(
        result as unknown as Awaited<ReturnType<typeof inspect3dAsset>>,
      )
      expect(receipt.outcome).toBe('commit_outcome_unknown')
      expect(receipt.authorityTier).toBeNull()
      const errors = receipt.errors as Array<
        Record<string, unknown> & { message: string }
      >
      expect(errors).toHaveLength(1)
      expect(errors[0]!.code).toBe('application_unconfirmed')
      expect(errors[0]!.message).toContain('OUTCOME IS UNKNOWN')
      expect(errors[0]!.message).toContain(
        '.openbuff/artifacts/3d/mutations/commit-unknown/current',
      )

      // The attempt's working copy is RETAINED and named in the receipt, so the
      // operator can compare it against the source instead of losing it.
      const releaseTarget = path.join(
        root,
        '.openbuff/artifacts/3d/mutations/commit-unknown/current',
      )
      const retained = fs
        .readdirSync(releaseTarget)
        .filter((entry) => entry.endsWith('.blend'))
      expect(retained).toHaveLength(1)
      expect(errors[0]!.message).toContain(
        `working copy ${retained[0]!.replace(/\.blend$/, '')}`,
      )
      // No revert is claimed and none happened: the source is still the original
      // scene this attempt started from.
      expect(hashFileContent(fs.readFileSync(blendPath))).toBe(
        `sha256:${sourceHash}`,
      )
    },
  )

  function retainedAttempt(
    root: string,
    operationId: string,
    attemptId: string,
  ) {
    const dir = path.join(
      root,
      '.openbuff/artifacts/3d/mutations',
      operationId,
      'current',
    )
    fs.mkdirSync(dir, { recursive: true })
    for (const suffix of ['blend', 'py', 'json'])
      fs.writeFileSync(
        path.join(dir, `${attemptId}.${suffix}`),
        `retained work: ${attemptId}`,
      )
    return { dir, file: path.join(dir, `${attemptId}.blend`) }
  }

  test('keeps retained working copies bounded across distinct operationIds', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-3d-retention-'),
    )
    roots.push(root)
    const base = createNodeFileSystem()
    let stats = 0
    const fileSystem = Object.assign(Object.create(base), {
      stat: async (target: fs.PathLike) => {
        stats++
        return base.stat(target)
      },
    })
    const copies: string[] = []
    const attempts =
      MUTATION_RETAINED_ATTEMPT_ARTIFACTS + 2 * MUTATION_PRUNE_STRIDE_EDITS
    for (let index = 0; index < attempts; index++) {
      const id = `attempt-${index}`
      const artifact = retainedAttempt(root, `operation-${index}`, id)
      copies.push(artifact.file)
      stats = 0
      await prune3dMutationArtifacts({
        fs: fileSystem,
        currentOperationDir: artifact.dir,
        attemptId: id,
      })
      expect(stats).toBeLessThanOrEqual(MUTATION_ARTIFACT_PRUNE_MAX_STATS)
      expect(fs.readFileSync(artifact.file, 'utf8')).toBe(
        `retained work: ${id}`,
      )
    }
    const remaining = copies.filter((file) => fs.existsSync(file))
    expect(remaining.length).toBeLessThanOrEqual(
      MUTATION_RETAINED_ATTEMPT_ARTIFACTS + MUTATION_PRUNE_STRIDE_EDITS - 1,
    )
    expect(remaining.length).toBeLessThan(attempts)
    // Count retention permits older receipts to expire; the recent receipt
    // window must remain readable, including the copy just handed out.
    for (const file of copies.slice(-MUTATION_RETAINED_ATTEMPT_ARTIFACTS))
      expect(fs.existsSync(file)).toBe(true)
  })

  test('converges when one reused operationId already exceeds the stat window', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-3d-reused-op-'),
    )
    roots.push(root)
    const operationId = 'reused-operation'
    const backlog = Array.from(
      { length: MUTATION_ARTIFACT_PRUNE_MAX_STATS + 4 },
      (_, index) => retainedAttempt(root, operationId, `old-${index}`),
    )
    const base = createNodeFileSystem()
    let stats = 0
    const fileSystem = Object.assign(Object.create(base), {
      stat: async (target: fs.PathLike) => {
        stats++
        return base.stat(target)
      },
    })
    const current: string[] = []
    for (let index = 0; index < 3 * MUTATION_PRUNE_STRIDE_EDITS; index++) {
      const id = `current-${index}`
      const artifact = retainedAttempt(root, operationId, id)
      current.push(artifact.file)
      stats = 0
      await prune3dMutationArtifacts({
        fs: fileSystem,
        currentOperationDir: artifact.dir,
        attemptId: id,
      })
      expect(stats).toBeLessThanOrEqual(MUTATION_ARTIFACT_PRUNE_MAX_STATS)
    }
    const remaining = fs
      .readdirSync(backlog[0]!.dir)
      .filter((name) => name.endsWith('.blend'))
    expect(remaining.length).toBeLessThanOrEqual(
      MUTATION_RETAINED_ATTEMPT_ARTIFACTS + MUTATION_PRUNE_STRIDE_EDITS - 1,
    )
    expect(
      backlog.filter((artifact) => fs.existsSync(artifact.file)),
    ).toHaveLength(0)
    for (const file of current.slice(-MUTATION_RETAINED_ATTEMPT_ARTIFACTS))
      expect(fs.existsSync(file)).toBe(true)
  })

  test('honors cancellation before starting a Blender render', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-3d-tools-'))
    roots.push(root)
    fs.writeFileSync(path.join(root, 'scene.blend'), Buffer.from('fixture'))
    const controller = new AbortController()
    controller.abort()

    const result = await render3dPreview({
      path: 'scene.blend',
      views: ['perspective'],
      mode: 'clay',
      width: 128,
      height: 128,
      cwd: root,
      fs: createNodeFileSystem(),
      signal: controller.signal,
    })
    expect(result[0]).toMatchObject({
      type: 'json',
      value: { error: 'Blender operation cancelled.' },
    })
    expect(fs.existsSync(path.join(root, '.openbuff'))).toBe(false)
  })

  test.skipIf(!fs.existsSync('/usr/bin/blender'))(
    'inspects, renders, and conditionally edits a real Blender scene',
    async () => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'openbuff-blender-e2e-'),
      )
      roots.push(root)
      const blendPath = path.join(root, 'portfolio.blend')
      const created = spawnSync(
        'blender',
        [
          '--background',
          '--python-expr',
          `import bpy; bpy.ops.mesh.primitive_cube_add(); bpy.context.object.name='PortfolioCube'; bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(blendPath)})`,
        ],
        { encoding: 'utf8', timeout: 60_000 },
      )
      expect(created.status).toBe(0)

      const baseFileSystem = createNodeFileSystem()
      const fileSystem = Object.assign(Object.create(baseFileSystem), {
        mutationAuthority: 'cooperative_cas' as const,
        conditionalCommit: async (
          filePath: fs.PathLike,
          data: string | NodeJS.ArrayBufferView,
          options: { expectedHash: string | null },
        ) => {
          const before = Buffer.from(await fs.promises.readFile(filePath))
          if (hashFileContent(before) !== options.expectedHash) {
            return {
              applied: false as const,
              actualHash: hashFileContent(before),
            }
          }
          await fs.promises.writeFile(filePath, data)
          return { applied: true as const }
        },
      })
      const before = valueOf(
        await inspect3dAsset({
          path: 'portfolio.blend',
          cwd: root,
          fs: fileSystem,
        }),
      )
      expect(before.summary.objects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'PortfolioCube' }),
        ]),
      )
      expect(before.derivedMetadataPath).toBe(
        `.openbuff/artifacts/3d/metadata/${before.sourceHash}.json`,
      )

      const preview = await render3dPreview({
        path: 'portfolio.blend',
        views: ['perspective'],
        mode: 'clay',
        width: 128,
        height: 128,
        cwd: root,
        fs: fileSystem,
      })
      if (!preview.some((part) => part.type === 'media')) {
        throw new Error(
          `Preview did not attach media: ${JSON.stringify(preview)}`,
        )
      }
      expect(preview[0]).toMatchObject({
        type: 'json',
        value: {
          receipts: [
            {
              sourcePath: 'portfolio.blend',
              sourceHash: before.sourceHash,
              dimensions: { width: 128, height: 128 },
              view: 'perspective',
              mode: 'clay',
            },
          ],
        },
      })

      const edit = await edit3dAsset({
        path: 'portfolio.blend',
        sourceHash: before.sourceHash,
        operations: [
          {
            type: 'rename_object',
            object: 'PortfolioCube',
            new_name: 'HeroModel',
          },
        ],
        cwd: root,
        fs: fileSystem,
        operationId: 'blender-e2e',
      })
      expect(edit[0]).toMatchObject({
        type: 'json',
        value: { outcome: 'applied' },
      })
      expect(edit.some((part) => part.type === 'media')).toBe(true)
      // The applied receipt must always NAME the retained artifact and describe
      // the preview, so a post-commit preview failure can never leave a kept
      // full-asset directory with nothing pointing at it.
      const assetMutationValue = (
        edit[1]?.type === 'json' ? edit[1].value : {}
      ) as Record<string, any>
      expect(typeof assetMutationValue.assetMutation.artifactPath).toBe(
        'string',
      )
      expect(
        fs.existsSync(
          path.join(root, assetMutationValue.assetMutation.artifactPath),
        ),
      ).toBe(true)
      expect(assetMutationValue.assetMutation.preview).toBeDefined()
      expect(assetMutationValue.assetMutation.previewRendered).toBe(true)

      const after = valueOf(
        await inspect3dAsset({
          path: 'portfolio.blend',
          cwd: root,
          fs: fileSystem,
        }),
      )
      expect(after.sourceHash).not.toBe(before.sourceHash)
      expect(after.summary.objects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'HeroModel' }),
        ]),
      )
    },
    180_000,
  )
})
