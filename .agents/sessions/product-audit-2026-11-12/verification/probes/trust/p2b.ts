// Probe extensions-03 (hooks): project fileChangeHooks executed with no trust gate (balanced mode, no flags).
import fs from 'node:fs'
const R = '/home/ben/Code/CLI/openbuff'
const proj = '/tmp/verify-trust/p2b/proj'
process.env.OPENBUFF_CONFIG_DIR = '/tmp/verify-trust/p2b/cfg'
process.env.ANTHROPIC_API_KEY = 'sk-ant-FAKE-USER-KEY-verify-trust'
for (const k of ['OPENBUFF_TRUST_ANCESTOR_CONFIG', 'OPENBUFF_PROVIDER_CONFIG', 'OPENBUFF_TRUST_PROJECT_READABLE_ROOTS']) delete process.env[k]
try { fs.unlinkSync(`${proj}/HOOK_RAN_MARKER`) } catch {}
process.chdir(proj)
const hc = await import(`${R}/sdk/src/host-config.ts`)
const he = await import(`${R}/sdk/src/host-execution.ts`)
const run = await import(`${R}/sdk/src/run.ts`)
const fch = await import(`${R}/sdk/src/tools/file-change-hooks.ts`)
const inputs = hc.captureAmbientHostInputs({ cwd: proj, projectRoot: proj })
const snap = hc.loadHostConfigSnapshot({ inputs, fs: hc.nodeConfigReadFs })
if (snap.status !== 'complete') { console.log(snap); process.exit(1) }
const cfg = snap.snapshot.loaded.config
console.log('[snapshot] approvalMode =', cfg.approvalMode, 'fileChangeHooks =', JSON.stringify(cfg.fileChangeHooks), 'sandbox =', JSON.stringify(snap.snapshot.sandboxPolicy))
// Same capture as sdk/src/run.ts:1060-1063
const capturedHookConfiguration = Object.freeze({ autoFileChangeHooks: cfg.autoFileChangeHooks === true, fileChangeHooks: Object.freeze(cfg.fileChangeHooks.map((h: any) => Object.freeze({ ...h }))) })
const svc = he.createHostExecutionServices({ snapshot: snap.snapshot, boundary: run.captureRunDeadline(60000).value, childInheritanceEnvironment: { ...snap.snapshot.inputs.environment }, env: {} })
if (!svc.ok) { console.log('svc', svc); process.exit(1) }
const op = svc.value.directOperation({ mode: 'assistant' })
if (!op.ok) { console.log('op', op); process.exit(1) }
console.log('[exec ctx] mode =', op.value.executionContext.mode, 'profile.policy =', op.value.executionContext.profile.policy)
// Same call shape as sdk/src/run.ts:3600-3611 (run_file_change_hooks dispatch)
const result = await fch.runFileChangeHooks({ files: ['a.ts'], cwd: proj, executionContext: op.value.executionContext, capturedConfiguration: capturedHookConfiguration, terminalShell: svc.value.terminalShell, getTerminalLaunchMetadata: svc.value.getTerminalLaunchMetadata })
console.log('[hook result]', JSON.stringify(result).slice(0, 600))
console.log('[marker exists]', fs.existsSync(`${proj}/HOOK_RAN_MARKER`), fs.existsSync(`${proj}/HOOK_RAN_MARKER`) ? fs.readFileSync(`${proj}/HOOK_RAN_MARKER`, 'utf8').trim() : '')
process.exit(0)
