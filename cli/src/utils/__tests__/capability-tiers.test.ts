import { describe, expect, test } from 'bun:test'

import {
  capabilityMapV1Schema,
  defaultCapabilityMapV1,
} from '@codebuff/common/protocol/acp-ext-v1'

import {
  buildCliCapabilityMapV1,
  buildDoctorCapabilityRows,
  formatSandboxCapabilityChipLabel,
} from '../capability-tiers'

describe('buildCliCapabilityMapV1', () => {
  test('matches the frozen P1 honest posture and validates against the canonical schema', () => {
    const map = buildCliCapabilityMapV1()

    // The map the CLI displays must stay a valid CapabilityMapV1: the schema
    // is the canonical protocol contract, so drift fails here first.
    expect(capabilityMapV1Schema.safeParse(map).success).toBe(true)

    // The CLI map is DERIVED from the canonical builder, never hand-copied:
    // a value change in the SDK's honest posture (e.g. the sandbox tier or
    // the gate default) must reach the CLI's status-bar chip and doctor rows
    // automatically instead of leaving them advertising a stale contract
    // while serve mode advertises the new one.
    expect(map).toEqual(defaultCapabilityMapV1({ journalAvailable: false }))

    // Honest reporting pins: never a stronger claim than the serve-mode map.
    expect(map.sandbox).toEqual({
      tier: 'lexical',
      enforced: false,
      network: 'unrestricted',
    })
    expect(map.index).toEqual({ state: 'absent' })
    expect(map.lsp).toEqual([])
    expect(map.sidecars).toEqual([])
    expect(map.journal).toEqual({ resume: false, replay: false })
    expect(map.gate).toEqual({ enabled: true })
  })
})

describe('formatSandboxCapabilityChipLabel', () => {
  test('renders the actual tier, e.g. sandbox:lexical', () => {
    expect(
      formatSandboxCapabilityChipLabel(buildCliCapabilityMapV1().sandbox),
    ).toBe('sandbox:lexical')
  })
})

describe('buildDoctorCapabilityRows', () => {
  test('reports the honest defaults in a stable display order', () => {
    const rows = buildDoctorCapabilityRows(buildCliCapabilityMapV1())

    expect(rows.map((row) => row.label)).toEqual([
      'Sandbox',
      'Index',
      'LSP servers',
      'Sidecars',
      'Journal',
      'Gate',
    ])

    const byLabel = Object.fromEntries(rows.map((row) => [row.label, row]))
    expect(byLabel.Sandbox?.value).toBe(
      'lexical (enforced: false, network: unrestricted)',
    )
    // An unenforced sandbox must never read as a success state.
    expect(byLabel.Sandbox?.tone).toBe('warning')
    expect(byLabel.Index?.value).toBe('absent')
    expect(byLabel['LSP servers']?.value).toBe('none')
    expect(byLabel['LSP servers']?.rows).toBeUndefined()
    expect(byLabel.Sidecars?.value).toBe('none')
    expect(byLabel.Sidecars?.rows).toBeUndefined()
    expect(byLabel.Journal?.value).toBe('resume: off, replay: off')
    expect(byLabel.Gate?.value).toBe('enabled')
    expect(byLabel.Gate?.tone).toBe('success')
  })

  test('lists lsp and sidecar entries when the map carries them', () => {
    const rows = buildDoctorCapabilityRows({
      ...buildCliCapabilityMapV1(),
      lsp: [
        {
          language: 'typescript',
          server: 'typescript-language-server',
          state: 'ready',
        },
      ],
      sidecars: [{ id: 'indexer', version: '0.1.0', state: 'degraded' }],
    })

    const byLabel = Object.fromEntries(rows.map((row) => [row.label, row]))
    expect(byLabel['LSP servers']?.value).toBe('1')
    expect(byLabel['LSP servers']?.rows).toEqual([
      'typescript=typescript-language-server(ready)',
    ])
    expect(byLabel.Sidecars?.value).toBe('1')
    expect(byLabel.Sidecars?.rows).toEqual(['indexer@0.1.0(degraded)'])
  })
})
