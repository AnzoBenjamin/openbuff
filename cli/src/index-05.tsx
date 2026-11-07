#!/usr/bin/env bun
/**
 * OpenTUI 0.5 smoke probe (OPENTUI-0.5-MIGRATION-PLAN.md, Stage 0/1).
 *
 * Verifies the product's pinned 0.5.12 packages (@opentui/core +
 * @opentui/react) boot under our Bun version: this file imports the SAME
 * packages the product entrypoints use, renders a box/text pair, and exits.
 * Stage 1 flipped the product pins to 0.5.12, so this probe now validates the
 * live dependency graph (it exercised the npm: aliases while Stage 0 kept
 * 0.2.2 installed side by side; the aliases are gone).
 *
 * Run: `bun run cli/src/index-05.tsx`
 *
 * Acceptance (from the migration plan):
 * - the 0.5.x renderer boots under our Bun version, via
 *   @opentui/core/testing's createTestRenderer: it drives the renderer with
 *   mock stdin/stdout and never takes over the terminal, so the probe keeps
 *   working in CI and non-TTY contexts (the 0.2.x `testing: true` renderer
 *   option that disabled terminal takeover was removed in 0.5.x, so a
 *   full-screen createCliRenderer boot cannot make that guarantee)
 * - <box>/<text> render without throwing
 * - the native platform package resolves on this machine
 *
 * Exits 0 on success, throws on failure (non-zero exit).
 */

import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'

import { createTestRenderer } from '@opentui/core/testing'
import { createRoot } from '@opentui/react'
import React from 'react'

const Probe = (): React.ReactElement => (
  <box style={{ flexDirection: 'column' as const }}>
    <text>opentui-05 probe: renderer boot OK</text>
  </box>
) as unknown as React.ReactElement

/**
 * Locate the installed OpenTUI native platform package
 * (@opentui/core-<platform>-<arch>, or its -musl variant on musl Linux) that
 * @opentui/core resolves at runtime. Bun hoists workspace installs, so the
 * search walks node_modules up from this file's directory.
 */
function findOpenTuiNativePackageDir(): string | null {
  const folders = [
    `core-${process.platform}-${process.arch}`,
    `core-${process.platform}-${process.arch}-musl`,
  ]
  let dir = import.meta.dir
  for (;;) {
    for (const folder of folders) {
      const candidate = join(dir, 'node_modules', '@opentui', folder)
      if (existsSync(candidate)) return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Runtime evidence for the OpenTUI 0.5.x pin: the version of the
 * @opentui/core package this probe actually resolves at runtime. The probe
 * compares it against the pin in cli/package.json and emits it as
 * SMOKE_OPENTUI_05_CORE_VERSION for the build log, so a drifted install is
 * visible in recorded run output rather than only in source.
 */
function readResolvedOpentuiCoreVersion(): string | null {
  let dir = import.meta.dir
  for (;;) {
    const packageJsonPath = join(
      dir,
      'node_modules',
      '@opentui',
      'core',
      'package.json',
    )
    if (existsSync(packageJsonPath)) {
      const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
        version?: string
      }
      return parsed.version ?? null
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

async function main(): Promise<void> {
  // Acceptance: the pinned @opentui/core version is what this probe actually
  // resolved (runtime evidence for the 0.5.x pin — an install that has
  // drifted off the pin fails here instead of producing a green probe log
  // against the wrong version).
  const cliPackageJsonPath = join(import.meta.dir, '..', 'package.json')
  const cliPackageJson = JSON.parse(
    readFileSync(cliPackageJsonPath, 'utf8'),
  ) as { dependencies?: Record<string, string> }
  const pinnedCore = cliPackageJson.dependencies?.['@opentui/core']
  const resolvedCore = readResolvedOpentuiCoreVersion()
  if (!pinnedCore || !resolvedCore) {
    throw new Error(
      `Could not verify the @opentui/core pin (pinned: ${pinnedCore ?? 'missing'}, resolved: ${resolvedCore ?? 'missing'}); searched node_modules/@opentui/core walking up from ${import.meta.dir}`,
    )
  }
  // Strip any range prefix so a ranged pin still compares equal.
  const pinnedCoreVersion = pinnedCore.replace(/^[^0-9]*/, '')
  if (resolvedCore !== pinnedCoreVersion) {
    throw new Error(
      `The resolved @opentui/core ${resolvedCore} does not match the cli/package.json pin ${pinnedCore}; re-run bun install before running the 0.5.x smoke probe`,
    )
  }

  // Acceptance: the native platform package resolves on this machine.
  const nativeDir = findOpenTuiNativePackageDir()
  if (!nativeDir) {
    throw new Error(
      `OpenTUI native platform package failed to resolve for ${process.platform}-${process.arch}; searched node_modules/@opentui walking up from ${import.meta.dir}`,
    )
  }
  // Acceptance: the 0.5.x renderer boots without taking over the terminal,
  // so the probe works in CI and non-TTY contexts (see the header comment).
  const { renderer, renderOnce } = await createTestRenderer({
    // No exit-signal handlers: the probe owns its own exit (process.exit).
    exitSignals: [],
  })
  try {
    const root = createRoot(renderer)
    root.render(<Probe />)
    // One frame is enough: renderable tree construction is the probe target.
    await renderOnce()
  } finally {
    await renderer.destroy()
  }
  console.log(`SMOKE_OPENTUI_05_CORE_VERSION ${resolvedCore}`)
  console.log(`SMOKE_OPENTUI_05_NATIVE ${nativeDir}`)
  console.log('SMOKE_OPENTUI_05_OK')
  process.exit(0)
}

main().catch((error: unknown) => {
  console.error('SMOKE_OPENTUI_05_FAILED', error)
  process.exit(1)
})
