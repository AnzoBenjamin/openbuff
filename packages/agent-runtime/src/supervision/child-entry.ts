/**
 * P2-T8 supervised child entrypoint (Bun entry module).
 *
 * Contract (mirrors supervision/__fixtures__/settle-child.ts):
 *  - argv[2] is the path of a temp file holding the JSON-serialized
 *    `SupervisedSpawnRequest` (stdin is 'ignore' in the supervisor);
 *  - stdout carries EXACTLY ONE newline-terminated JSON line: an
 *    `agentReceiptSchema` envelope. The envelope is compact by schema and
 *    bounded before writing so it stays under the supervisor's 8 MiB stdout
 *    capture cap (beyond-cap bytes are discarded by the supervisor and settle
 *    as 'truncated') — a future bridge that streams larger child output must
 *    bound it here before writing;
 *  - exit 0 when an envelope was written, 1 on any other failure (the
 *    supervisor classifies non-zero exits / no output as crashed or
 *    missing_output).
 *
 * LIMITED AGENT CLASS (this slice): `loopAgentSteps` consumes
 * non-serializable parent-callback deps (promptAiSdkStream, promptAiSdk,
 * promptAiSdkStructured, sendAction, requestToolCall, requestFiles, ...).
 * The parent→child RPC bridge for those deps has NOT landed yet, so this
 * entrypoint cannot run any agent end-to-end yet. Rather than half-run, it
 * returns a structured FAILED receipt (status 'failed', outcome 'crashed',
 * errors[].code 'unsupported-deps') naming every missing callback dep — an
 * honest, schema-valid degradation the parent settle chain reconciles like
 * any other failed spawn. Only agents whose tools are satisfiable WITHOUT
 * parent callbacks (read-only tool handlers that never need requestToolCall /
 * sendAction) will be eligible once the bridge lands; the
 * `missingChildCallbackDeps` gate below is the single place that flips.
 *
 * Scope note: the `processSupervision` flag applies at the `executeSubagent`
 * choke point, so the two programmatic call sites
 * (util/context-consolidation-runner.ts, util/runtime-semantic-compaction.ts)
 * are subject to the same flag — deliberately no second gate.
 */
import { agentReceiptSchema } from '@codebuff/common/types/agent-handoff'
import type { AgentReceipt } from '@codebuff/common/types/agent-handoff'
import { generateCompactId } from '@codebuff/common/util/string'
import { readFileSync } from 'node:fs'

import type { SupervisedSpawnRequest } from './process-supervisor'

/**
 * The parent-callback deps `loopAgentSteps` needs that cannot be rebuilt from
 * a JSON-serializable request. The future RPC bridge supplies them; until it
 * lands this gate fails closed for every request (the honest
 * 'unsupported-deps' degradation), never a partial run.
 */
const CHILD_CALLBACK_DEPS = [
  'promptAiSdkStream',
  'promptAiSdk',
  'promptAiSdkStructured',
  'sendAction',
  'requestToolCall',
  'requestFiles',
  'requestOptionalFile',
  'requestMcpToolData',
  'handleStepsLogChunk',
  'sendSubagentChunk',
  'trackEvent',
  'fetch',
  'startAgentRun',
  'finishAgentRun',
  'addAgentStep',
  'databaseAgentCache',
] as const

/**
 * Names the required callback deps the request fails to supply. In this
 * slice none of them are serializable and no bridge exists, so the list is
 * complete for every request; the bridge slice replaces this with a real
 * per-dep check before any supervised agent runs.
 */
export function missingChildCallbackDeps(): string[] {
  return [...CHILD_CALLBACK_DEPS]
}

/**
 * Structured 'unsupported-deps' failed receipt: field-complete,
 * `agentReceiptSchema`-valid, exit-code-free — the parent's settle chain
 * reconciles it exactly like any other failed spawn.
 */
export function buildUnsupportedDepsReceipt(params: {
  agentType: string
  agentId: string
  missing: string[]
}): AgentReceipt {
  return agentReceiptSchema.parse({
    schemaVersion: 1,
    receiptId: generateCompactId(),
    taskId: `spawn-${params.agentId}`,
    role: 'specialist',
    agentId: params.agentId,
    status: 'failed',
    outcome: 'crashed',
    changedFiles: [],
    requirementsAddressed: [],
    acceptanceCriteriaAddressed: [],
    findingsAddressed: [],
    evidence: [],
    assumptions: [],
    unresolved: [],
    requestedValidation: [],
    artifacts: [],
    errors: [
      {
        code: 'unsupported-deps',
        message: `Supervised spawn of "${params.agentType}" cannot run: the required parent-callback deps (${params.missing.join(', ')}) are not serializable and the parent→child RPC bridge has not landed (P2-T8 follow-up). Only agents whose tools need no parent callbacks will be eligible once it does.`,
        retryable: false,
      },
    ],
    output: {
      errorMessage:
        'Supervised spawn degraded honestly: required parent-callback deps are not bridged yet (unsupported-deps).',
      partial: true,
    },
  })
}

/**
 * Runs the child entry logic for one parsed request and returns the single
 * receipt envelope to write. Pure with respect to stdout/stderr/exit — the
 * main() below owns the process contract.
 */
export function runSupervisedChildEntry(
  request: SupervisedSpawnRequest,
): AgentReceipt {
  const agentId = request.child?.agentId ?? generateCompactId()
  return buildUnsupportedDepsReceipt({
    agentType: request.agentType,
    agentId,
    missing: missingChildCallbackDeps(),
  })
}

/**
 * Stdout sink for the single-envelope contract. Injectable so tests can
 * capture the emitted bytes without owning the process' real stdout.
 */
export type ChildEntryWrite = (line: string) => void | Promise<void>

const defaultWrite: ChildEntryWrite = (line) => {
  void Bun.write(Bun.stdout, line)
}

/**
 * Process entry contract: read the request file, emit EXACTLY ONE
 * newline-terminated JSON envelope on stdout, exit 0 on ok / 1 otherwise.
 * Diagnostics go to stderr only (never parsed into the receipt).
 */
export async function runChildEntryMain(
  argv: string[],
  write: ChildEntryWrite = defaultWrite,
): Promise<number> {
  const requestPath = argv[2]
  if (!requestPath) {
    process.stderr.write('child-entry: missing request-file argv\n')
    return 1
  }
  let envelope: AgentReceipt
  try {
    const parsed: unknown = JSON.parse(readFileSync(requestPath, 'utf8'))
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as { agentType?: unknown }).agentType !== 'string'
    ) {
      throw new Error('request file is not a SupervisedSpawnRequest envelope')
    }
    envelope = runSupervisedChildEntry(parsed as SupervisedSpawnRequest)
  } catch (error) {
    process.stderr.write(
      `child-entry: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    return 1
  }
  await write(`${JSON.stringify(envelope)}\n`)
  return 0
}

if (import.meta.main) {
  process.exit(await runChildEntryMain(process.argv))
}
