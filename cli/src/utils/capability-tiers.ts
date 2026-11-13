import { defaultCapabilityMapV1 } from '@codebuff/common/protocol/acp-ext-v1'
import type { CapabilityMapV1 } from '@codebuff/common/protocol/acp-ext-v1'

/**
 * X-4 CLI capability advertisement. The frozen `CapabilityMapV1` contract and
 * its zod schema live in `@codebuff/common/protocol/acp-ext-v1`, and the
 * canonical default posture is `defaultCapabilityMapV1` in that same module
 * (served over the protocol as `_openbuff.dev/capabilities/get`). The CLI
 * derives its map from that canonical builder — never a hand-copied field
 * set — so a value change in the SDK's honest posture (e.g. the sandbox tier
 * or the gate default) is picked up here automatically and the CLI's
 * status-bar chip and doctor rows can never silently drift from the
 * serve-mode advertisement.
 */

/**
 * The CLI's capability posture, DERIVED from the canonical
 * `defaultCapabilityMapV1({ journalAvailable: false })`: lexical sandboxing
 * that is NOT enforced, no index, no LSP servers or sidecars, no durable
 * session journal, and the gate enabled. Honest by construction (SPEC
 * principle 6): nothing here may claim a stronger tier than the serve-mode
 * map advertises — which holds structurally, because this IS the serve-mode
 * map's builder at the CLI's no-durable-journal posture.
 */
export function buildCliCapabilityMapV1(): CapabilityMapV1 {
  return defaultCapabilityMapV1({ journalAvailable: false })
}

/** Compact status-bar chip label for the sandbox tier, e.g. 'sandbox:lexical'. */
export const formatSandboxCapabilityChipLabel = (
  sandbox: CapabilityMapV1['sandbox'],
): string => `sandbox:${sandbox.tier}`

/** Display tone for one doctor capability row. */
export type DoctorCapabilityRowTone = 'default' | 'success' | 'warning' | 'muted'

/**
 * One row of the doctor box's capability-tier section. `rows` carries the
 * per-entry detail lines for the list-valued tiers (lsp servers, sidecars)
 * and is omitted when the tier has none.
 */
export type DoctorCapabilityRow = {
  label: string
  value: string
  tone: DoctorCapabilityRowTone
  rows?: string[]
}

const onOff = (value: boolean): string => (value ? 'on' : 'off')

/**
 * Doctor-box rows for the capability tiers, in a fixed display order. Every
 * row is rendered straight from the map: an unenforced sandbox is toned
 * warning (never success), an absent index stays 'absent', and empty lsp /
 * sidecar lists read 'none'.
 */
export function buildDoctorCapabilityRows(
  map: CapabilityMapV1,
): DoctorCapabilityRow[] {
  return [
    {
      label: 'Sandbox',
      value: `${map.sandbox.tier} (enforced: ${map.sandbox.enforced}, network: ${map.sandbox.network})`,
      tone: map.sandbox.enforced ? 'success' : 'warning',
    },
    {
      label: 'Index',
      value: map.index.state,
      tone: map.index.state === 'ready' ? 'success' : 'default',
    },
    {
      label: 'LSP servers',
      value: map.lsp.length === 0 ? 'none' : String(map.lsp.length),
      tone: map.lsp.length === 0 ? 'muted' : 'default',
      ...(map.lsp.length > 0 && {
        rows: map.lsp.map(
          (server) => `${server.language}=${server.server}(${server.state})`,
        ),
      }),
    },
    {
      label: 'Sidecars',
      value: map.sidecars.length === 0 ? 'none' : String(map.sidecars.length),
      tone: map.sidecars.length === 0 ? 'muted' : 'default',
      ...(map.sidecars.length > 0 && {
        rows: map.sidecars.map(
          (sidecar) => `${sidecar.id}@${sidecar.version}(${sidecar.state})`,
        ),
      }),
    },
    {
      label: 'Journal',
      value: `resume: ${onOff(map.journal.resume)}, replay: ${onOff(map.journal.replay)}`,
      tone: map.journal.resume || map.journal.replay ? 'default' : 'muted',
    },
    {
      label: 'Gate',
      value: map.gate.enabled ? 'enabled' : 'disabled',
      tone: map.gate.enabled ? 'success' : 'warning',
    },
  ]
}
