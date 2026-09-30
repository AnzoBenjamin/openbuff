#!/usr/bin/env bun
/**
 * OpenTUI 0.5.12 Stage-0 probe entrypoint (OPENTUI-0.5-MIGRATION-PLAN.md).
 *
 * Verifies the aliased 0.5.12 packages (`opentui-core-05` / `opentui-react-05`)
 * boot under our Bun version WITHOUT touching the product's pinned 0.2.2
 * imports: this file imports only the aliases, renders a box/text pair, and
 * exits. No product code changes; the real 0.2.2 entrypoints are untouched.
 *
 * Run: `bun run cli/src/index-05.tsx --smoke-opentui`
 *
 * Stage-0 acceptance (from the migration plan):
 * - createCliRenderer boots under our Bun version
 * - <box>/<text> render without throwing
 * - the native platform package resolves on this machine
 *
 * Exits 0 on success, throws on failure (non-zero exit).
 */

import { createCliRenderer } from 'opentui-core-05'
import { createRoot } from 'opentui-react-05'
import React from 'react'

const Probe = (): React.ReactElement => (
  <box style={{ flexDirection: 'column' as const }}>
    <text>opentui-05 probe: renderer boot OK</text>
  </box>
) as unknown as React.ReactElement

async function main(): Promise<void> {
  const renderer = await createCliRenderer({
    // Headless-friendly: the probe must work in CI and non-TTY contexts.
    exitOnCtrlC: true,
  })
  try {
    // The aliased packages type-clone @opentui/core 0.5.12 inside
    // opentui-react-05's node_modules, so the two CliRenderer identities are
    // structurally identical but nominally distinct; the probe's renderer is
    // created by the core alias and consumed by the react alias.
    const root = createRoot(
      renderer as unknown as Parameters<typeof createRoot>[0],
    )
    root.render(<Probe />)
    // One frame is enough: renderable tree construction is the probe target.
    await new Promise((resolve) => setTimeout(resolve, 100))
    console.log('SMOKE_OPENTUI_05_OK')
    process.exit(0)
  } finally {
    renderer.destroy()
  }
}

main().catch((error: unknown) => {
  console.error('SMOKE_OPENTUI_05_FAILED', error)
  process.exit(1)
})
