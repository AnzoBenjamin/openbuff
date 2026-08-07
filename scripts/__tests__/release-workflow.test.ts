import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const workflow = readFileSync(
  resolve(import.meta.dir, '../../.github/workflows/cli-release-prod.yml'),
  'utf8',
)

const buildWorkflow = readFileSync(
  resolve(import.meta.dir, '../../.github/workflows/cli-release-build.yml'),
  'utf8',
)

describe('production release workflow', () => {
  test('builds the committed release source before creating its tag', () => {
    const prepareStart = workflow.indexOf('  prepare-and-commit-prod:')
    const buildStart = workflow.indexOf('  build-prod-binaries:')
    const releaseStart = workflow.indexOf('  create-prod-release:')
    const tagStep = workflow.indexOf(
      '      - name: Create and push production tag',
    )

    expect(prepareStart).toBeGreaterThan(-1)
    expect(buildStart).toBeGreaterThan(prepareStart)
    expect(releaseStart).toBeGreaterThan(buildStart)
    expect(tagStep).toBeGreaterThan(releaseStart)
    expect(workflow.slice(prepareStart, buildStart)).not.toContain('git tag')
  })

  test('checks out the exact version-bump commit for binary builds', () => {
    expect(workflow).toContain(
      'release_commit: ${{ steps.commit_version.outputs.release_commit }}',
    )
    expect(workflow).toContain(
      'checkout-ref: ${{ needs.prepare-and-commit-prod.outputs.release_commit }}',
    )
    expect(workflow).not.toContain(
      'checkout-ref: v${{ needs.prepare-and-commit-prod.outputs.new_version }}',
    )
  })

  test('makes tag creation idempotent for safe job retries', () => {
    expect(workflow).toContain(
      'existing_commit=$(git ls-remote --tags origin "refs/tags/${tag}"',
    )
    expect(workflow).toContain('test "$existing_commit" = "$RELEASE_COMMIT"')
  })
})

describe('CLI release build workflow', () => {
  test('selects a usable Xcode before macOS cargo builds that need a C linker', () => {
    const legacyStep = 'Prepare macOS 11 legacy toolchain'
    const intelRipgrepStep = 'Rebuild Intel ripgrep for macOS 13'
    const legacyStart = buildWorkflow.indexOf(legacyStep)
    const intelStart = buildWorkflow.indexOf(intelRipgrepStep)
    const legacyCargo = buildWorkflow.indexOf(
      'MACOSX_DEPLOYMENT_TARGET=11.0 cargo build --release --locked',
    )
    const intelCargo = buildWorkflow.indexOf(
      'MACOSX_DEPLOYMENT_TARGET=13.0 cargo build --release --locked',
    )

    expect(legacyStart).toBeGreaterThan(-1)
    expect(intelStart).toBeGreaterThan(-1)
    expect(legacyCargo).toBeGreaterThan(legacyStart)
    expect(intelCargo).toBeGreaterThan(intelStart)

    const legacyBlock = buildWorkflow.slice(legacyStart, legacyCargo)
    const intelBlock = buildWorkflow.slice(intelStart, intelCargo)

    for (const block of [legacyBlock, intelBlock]) {
      expect(block).toContain('xcode-select -s')
      expect(block).toContain('export DEVELOPER_DIR')
      expect(block).toContain('xcrun --find clang')
    }
  })
})
