import { sanitizeOutbound } from './outbound-filter'

import type { AcpPromptHandler } from '../services/acp/acp-agent'
import type { AcpSessionData } from '../services/acp/session-data'
import type {
  FilesystemMutationEvent,
  OpenbuffClientOptions,
  RunOptions,
} from '../run'
import type { RunState } from '../run-state'
import type { MCPConfig } from '@codebuff/common/types/mcp'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'

/**
 * The structural slice of `OpenbuffClient` the bridge needs: just `.run`. The
 * production `openbuff serve` CLI (a LATER wave) passes a real
 * `OpenbuffClient`; unit tests pass a fake whose `.run` invokes the supplied
 * `handleEvent`/`onFilesystemMutation` and resolves a `RunState`. Typed as the
 * exact production run signature so a real client is assignable without a cast.
 */
export type ServeBridgeClient = {
  run: (runOptions: RunOptions & OpenbuffClientOptions) => Promise<RunState>
}

export type ServeBridgeOptions = {
  /** Structurally-typed run seam (see {@link ServeBridgeClient}). */
  client: ServeBridgeClient
  /**
   * The LIVE per-session store the ACP extension methods
   * (`openbuff/getReceipts`, `openbuff/gateState`) read. The bridge records
   * confirmed receipts and published gate-state here as the turn streams.
   */
  sessionData: AcpSessionData
  /**
   * Reserved for the CLI wave: lets the host mark which MCP servers the client
   * advertised so the run can attach them. Accepted here (everything reaches
   * the bridge via options — this layer never reads `process.env`) but not
   * exercised by the Wave-1 core.
   */
  markClientMcpServers?: (mcpServers: Record<string, MCPConfig>) => void
  /** Optional structured logger forwarded by the host; unused in Wave-1 core. */
  logger?: Logger
}

/**
 * The seam the `openbuff serve` CLI (LATER wave) instantiates: it binds the
 * ACP `AcpPromptHandler` to the real `OpenbuffClient.run()` loop and feeds the
 * live `AcpSessionData` store the read-only ACP extension methods serve.
 *
 * Security posture (P1-T1-DESIGN §12.1 SEC-1):
 * - The bridge NEVER forwards `tool_call`/`tool_result` events or raw tool
 *   output to the client — those are structurally DROPPED. Only model-visible
 *   assistant text (`PrintModeEvent` of type `'text'`) is forwarded, and when
 *   unsure whether an event carries such text the bridge DROPS it.
 * - Every forwarded chunk passes through {@link sanitizeOutbound} before it
 *   crosses the ACP wire, so a cap.v3 token or provider secret that slipped
 *   into assistant text is redacted as a last line of defense.
 * - Confirmed filesystem mutations and published `<gate-state>` blocks are
 *   recorded into the injected LIVE store, which is exactly what the ACP
 *   extension methods project back to the client.
 *
 * The bridge is transport-agnostic and free of process spawning: it only wires
 * callbacks. The CLI wave supplies the real client and the stdio transport.
 */
export function createServeBridge(options: ServeBridgeOptions): {
  promptHandler: AcpPromptHandler
  sessionData: AcpSessionData
} {
  const { client, sessionData } = options

  const promptHandler: AcpPromptHandler = async (input) => {
    /**
     * Forwards ONLY model-visible assistant text. `tool_call`/`tool_result`
     * and every other variant are dropped (return without forwarding). The
     * raw text feeds gate-state parsing (a no-op when there is no block), and
     * the sanitized copy is what crosses the wire.
     */
    const handleEvent = async (event: PrintModeEvent): Promise<void> => {
      const text = extractForwardableText(event)
      if (text === undefined) return
      // Record any published gate-state block from the model-visible text; the
      // store's parser is a no-op when the chunk carries no block.
      sessionData.updateGateStateFromBlock(input.sessionId, text)
      await input.update(sanitizeOutbound(text))
    }

    await client.run({
      agent: 'base',
      prompt: input.promptText,
      handleEvent,
      onFilesystemMutation: (event: FilesystemMutationEvent) =>
        sessionData.recordReceiptFromMutationEvent(input.sessionId, event),
      signal: input.signal,
    })

    // A run that ended via the abort signal maps to 'cancelled'; a naturally
    // settled run is 'end_turn'.
    return { stopReason: input.signal.aborted ? 'cancelled' : 'end_turn' }
  }

  return { promptHandler, sessionData }
}

/**
 * Extracts the model-visible assistant text from a `PrintModeEvent`, or
 * `undefined` when the event carries none. Conservative by design: only the
 * `'text'` variant (the assistant message-text chunk) is forwardable. Every
 * other variant — including `tool_call`, `tool_result`, and reasoning deltas —
 * returns `undefined` so the caller drops it.
 */
function extractForwardableText(event: PrintModeEvent): string | undefined {
  if (event.type === 'text' && typeof event.text === 'string') {
    return event.text
  }
  return undefined
}
