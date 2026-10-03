/**
 * Fixture child for the D36 spawn-settle fault-injection suite
 * (supervision/__tests__/process-supervisor.test.ts).
 *
 * Reads a mode from argv and emits exactly ONE newline-terminated JSON line
 * on stdout — the PR-T1 receipt envelope shape validated by
 * `agentReceiptSchema` (common/src/types/agent-handoff.ts).
 *
 * Modes:
 *  - ok         — emit a valid 'ok' envelope, exit 0
 *  - no-output  — exit 0 silently
 *  - invalid    — emit a non-JSON line
 *  - bad-schema — emit valid JSON that fails agentReceiptSchema
 *  - truncated  — emit a valid envelope, then >8 MiB unterminated blob
 *  - crash      — process.exit(1)
 *  - slow <ms>  — sleep past the supervisor's short timeout, then emit
 *  - env        — emit a valid envelope carrying the env keys it sees
 */

// Keep byte-identical with the required fields of agentReceiptSchema
// (schemaVersion, receiptId, taskId, role, agentId, status, and the seven
// required arrays). If the schema grows a required field, this fixture fails
// validation loudly in the supervisor tests.
const MINIMAL_OK_RECEIPT = {
  schemaVersion: 1,
  receiptId: 'settle-fixture-receipt',
  taskId: 'settle-fixture-task',
  role: 'specialist',
  agentId: 'settle-fixture-agent',
  status: 'completed',
  outcome: 'ok',
  changedFiles: [],
  requirementsAddressed: [],
  acceptanceCriteriaAddressed: [],
  findingsAddressed: [],
  evidence: [],
  assumptions: [],
  unresolved: [],
  requestedValidation: [],
  artifacts: [],
  errors: [],
}

async function writeLine(value: unknown): Promise<void> {
  await Bun.write(Bun.stdout, `${JSON.stringify(value)}\n`)
}

// Top-level await at the bottom requires this file to be an ES module.
export {}

const mode = process.argv[2]

async function main(): Promise<void> {
  switch (mode) {
    case 'ok':
      await writeLine(MINIMAL_OK_RECEIPT)
      return
    case 'env': {
      // Echo the env keys the child actually sees through a VALID receipt so
      // the supervisor hands them back to the test inside the envelope.
      const seenKeys = Object.keys(process.env).sort()
      await writeLine({ ...MINIMAL_OK_RECEIPT, requirementsAddressed: seenKeys })
      return
    }
    case 'no-output':
      return
    case 'invalid':
      await Bun.write(Bun.stdout, 'this is not json at all\n')
      return
    case 'bad-schema':
      await writeLine({ nope: true })
      return
    case 'truncated': {
      await writeLine(MINIMAL_OK_RECEIPT)
      // 9 MiB single UNTERMINATED blob: pushes the supervisor past its 8 MiB
      // stdout capture cap while keeping the envelope the last COMPLETE line.
      await Bun.write(Bun.stdout, 'x'.repeat(9 * 1024 * 1024))
      return
    }
    case 'crash':
      process.exit(1)
      return
    case 'slow': {
      const sleepMs = Number(process.argv[3] ?? '5000')
      await Bun.sleep(sleepMs)
      await writeLine(MINIMAL_OK_RECEIPT)
      return
    }
    default:
      process.stderr.write(`settle-child: unknown mode ${String(mode)}\n`)
      process.exit(1)
  }
}

await main()
