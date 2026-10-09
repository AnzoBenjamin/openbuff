import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { maxFilesPerCall } from '../services/build-graph'
import { getAffectedTests } from '../tools/get-affected-tests'
import { getBuildTargets } from '../tools/get-build-targets'
import { inspectEnvironment } from '../tools/inspect-environment'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})

describe('harness intelligence read tools', () => {
  test('return JSON tool envelopes without executing project scripts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-read-tools-'))
    roots.push(root)
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'exit 99', build: 'exit 98' } }),
    )
    fs.writeFileSync(path.join(root, 'app.test.ts'), '')

    expect(inspectEnvironment(root)[0]).toMatchObject({
      type: 'json',
      value: {
        manifests: ['package.json'],
        tools: { blender: { available: expect.any(Boolean) } },
      },
    })
    const affected = getAffectedTests(root, ['app.ts'])[0]
    // The pre-existing `targets` field is byte-identical, with the tiered
    // `impact` analysis added alongside it.
    expect(affected).toMatchObject({
      type: 'json',
      value: { targets: [{ candidates: ['app.test.ts'] }] },
    })
    expect(affected).toMatchObject({
      value: {
        impact: [
          {
            source: 'app.ts',
            packageRoot: '.',
            tiers: {
              convention: ['app.test.ts'],
              graph: [],
              buildTool: ['npm run test'],
              coverage: [],
            },
            candidates: [
              { path: 'app.test.ts', tier: 'convention', confidence: 'high' },
              { path: 'npm run test', tier: 'build-tool', confidence: 'low' },
            ],
          },
        ],
      },
    })
    expect(getBuildTargets(root, ['app.ts'])[0]).toMatchObject({
      value: { targets: [{ scripts: ['test', 'build'] }] },
    })
    // Audit fix (J): the empty graph tier is explained honestly, not faked.
    const affectedValue = affected.type === 'json' ? affected.value : undefined
    expect(affectedValue).toMatchObject({
      impact: [
        {
          graphNote:
            'indexer reverse-dependency graph is not wired into this tool yet; graph tier is empty',
        },
      ],
    })
    // Audit fix (I): owningTargets from the build-graph service rides along as
    // an additive optional field without displacing the existing `targets`.
    const buildTargets = getBuildTargets(root, ['app.ts'])[0]
    expect(buildTargets).toMatchObject({
      value: {
        targets: [{ scripts: ['test', 'build'] }],
        owningTargets: [
          {
            file: 'app.ts',
            ecosystem: 'javascript',
            targets: [{ kind: 'package' }],
          },
        ],
      },
    })
    // Audit fix (truncation honesty): under the per-call cap, `truncated` is
    // absent; over the cap, the tool reports honestly that files were not
    // considered.
    expect(
      (buildTargets as { value: Record<string, unknown> }).value,
    ).not.toHaveProperty('truncated')
    const overCapFiles = Array.from(
      { length: maxFilesPerCall + 1 },
      (_, index) => `f-${index}.ts`,
    )
    expect(getBuildTargets(root, overCapFiles)[0]).toMatchObject({
      value: { truncated: true },
    })
  }, 15_000)
})
