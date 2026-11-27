// Probe exec-jobs-02: runtime hardcodes full-access; plan-lineage basher (read-only) still mutates.
import fs from 'node:fs'
const R = '/home/ben/Code/CLI/openbuff'
const proj = '/tmp/verify-trust/p5/proj'
process.env.OPENBUFF_CONFIG_DIR = '/tmp/verify-trust/p5/cfg'
process.chdir(proj)
fs.writeFileSync(`${proj}/old.txt`, 'old\n'); try { fs.unlinkSync(`${proj}/PLAN_MARKER`) } catch {}
const plan = (await import(`${R}/agents/base2/base2-plan.ts`)).default
const basher = (await import(`${R}/agents/basher.ts`)).default
const su = await import(`${R}/packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts`)
const { handleRunTerminalCommand } = await import(`${R}/packages/agent-runtime/src/tools/handlers/tool/run-terminal-command.ts`)
const tcp = await import(`${R}/sdk/src/tools/terminal-command-policy.ts`)
const rtc = await import(`${R}/sdk/src/tools/run-terminal-command.ts`)
const hc = await import(`${R}/sdk/src/host-config.ts`)
const he = await import(`${R}/sdk/src/host-execution.ts`)
const run = await import(`${R}/sdk/src/run.ts`)

console.log('[template] basher.terminalPermissionProfile =', basher.terminalPermissionProfile, '| base2-plan spawns basher =', plan.spawnableAgents.includes('basher'))
const derived = su.deriveSpawnTemplateCapabilities({ agentTemplate: basher as any, parentAgentTemplate: plan as any, handoff: undefined, projectRoot: proj })
console.log('[derive] basher under base2-plan: planOnly =', derived.programmaticConfig?.planOnly, 'terminalPermissionProfile =', derived.terminalPermissionProfile)

// 1) Runtime handler with the derived (read-only) template
let clientCall: any
await handleRunTerminalCommand({ previousToolCallFinished: Promise.resolve(), toolCall: { toolName: 'run_terminal_command', toolCallId: 't1', input: { command: 'rm -f old.txt && touch PLAN_MARKER' } } as any, agentTemplate: derived as any, agentState: { agentId: 'a1', runId: 'r1', ancestorRunIds: ['root-plan-run'] } as any, clientSessionId: 's1', requestClientToolCall: async (c: any) => { clientCall = c; return [{ type: 'json', value: {} }] as any } } as any)
console.log('[runtime] client tool call permission_profile =', clientCall.input.permission_profile, 'mode =', clientCall.input.mode)

const cmd = clientCall.input.command
for (const profile of ['read-only', 'workspace-write', 'full-access']) {
  const p = tcp.evaluateTerminalCommandPolicy({ command: cmd, mode: 'assistant', permissionProfile: profile, projectRoot: proj, allowedPaths: [proj], cwd: proj })
  console.log(`[policy] ${profile}:`, JSON.stringify({ allowed: p.allowed, reason: p.reason }))
}

// 2) SDK dispatch (sdk/src/run.ts:3449-3451 substitutes executionContext.profile.policy)
const snap = hc.loadHostConfigSnapshot({ inputs: hc.captureAmbientHostInputs({ cwd: proj, projectRoot: proj }), fs: hc.nodeConfigReadFs })
if (snap.status !== 'complete') { console.log(snap); process.exit(1) }
const svc = he.createHostExecutionServices({ snapshot: snap.snapshot, boundary: run.captureRunDeadline(60000).value, childInheritanceEnvironment: { ...snap.snapshot.inputs.environment }, env: {} })
if (!svc.ok) { console.log(svc); process.exit(1) }
const op = svc.value.directOperation({ mode: 'assistant' })
if (!op.ok) { console.log(op); process.exit(1) }
const executionContext = op.value.executionContext
console.log('[host] sandbox =', snap.snapshot.sandboxPolicy.mode, 'execution profile.policy =', executionContext.profile.policy, 'approvalMode =', svc.value.approvalMode)
const out = await rtc.runTerminalCommand({ ...clientCall.input, owner: undefined, permission_profile: (executionContext.profile.policy as any) ?? clientCall.input.permission_profile, timeout_seconds: 30, cwd: proj, projectRoot: proj, executionContext, terminalShell: svc.value.terminalShell, getTerminalLaunchMetadata: svc.value.getTerminalLaunchMetadata })
const v: any = (out as any)[0].value
console.log('[sdk dispatch] exitCode =', v.exitCode, 'permissionProfile =', v.permissionProfile, 'error =', v.errorMessage)
console.log('[fs] old.txt exists =', fs.existsSync(`${proj}/old.txt`), 'PLAN_MARKER exists =', fs.existsSync(`${proj}/PLAN_MARKER`))
process.exit(0)
