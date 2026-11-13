// Probe orchestration-01 + exec-jobs-02 (spawn part): effective plan-mode tool surface and spawnables.
const R = '/home/ben/Code/CLI/openbuff'
const proj = '/tmp/verify-trust/p4/proj'
process.chdir(proj)
const MUT = ['rename_symbol', 'code_action', 'extract_symbol', 'edit_transaction', 'write_file', 'str_replace', 'replace_range', 'edit_3d_asset', 'run_terminal_command', 'kill_job', 'write_todos', 'run_file_change_hooks', 'run_targeted_validation']
const src = (await import(`${R}/agents/base2/base2-plan.ts`)).default
const srcDefault = (await import(`${R}/agents/base2/base2.ts`)).default
const { getEffectiveAgentToolNames } = await import(`${R}/packages/agent-runtime/src/util/agent-tool-names.ts`)
const eff = getEffectiveAgentToolNames(src as any)
console.log('[source base2-plan] planOnly =', src.programmaticConfig?.planOnly, 'progressiveToolDisclosure =', src.programmaticConfig?.progressiveToolDisclosure)
console.log('[source base2-plan] effective tool count =', eff.length)
console.log('[source base2-plan] mutating tools exposed =', MUT.filter(t => eff.includes(t)))
console.log('[source base2-plan] withheld vs base2 =', getEffectiveAgentToolNames(srcDefault as any).filter((t: string) => !eff.includes(t)))
console.log('[source base2-plan] spawnableAgents =', src.spawnableAgents.join(','))

const reg = await import(`${R}/cli/src/utils/local-agent-registry.ts`)
for (const trust of [false, true]) {
  await reg.initializeAgentRegistry({ trustProjectAgents: trust }, { getRoot: () => proj, getCwd: () => proj })
  const defs = reg.loadAgentDefinitions()
  const plan = defs.find((d: any) => d.id === 'base2-plan')
  const byId = new Map(defs.map((d: any) => [d.id, d]))
  const user = plan.spawnableAgents.filter((a: string) => a.endsWith('-writer'))
  console.log(`[registry trust=${trust}] bundled base2-plan tools mutating =`, MUT.filter(t => getEffectiveAgentToolNames(plan).includes(t)), 'user agents auto-added =', user)
  if (trust) {
    for (const id of ['basher', 'general-agent', 'browser-use', 'debugger', 'integration-agent', ...user]) {
      const d: any = byId.get(id); if (!d) { console.log('  missing', id); continue }
      console.log(`  spawnable ${id}: mutating tools =`, MUT.filter(t => (d.toolNames ?? []).includes(t)), 'terminalPermissionProfile =', d.terminalPermissionProfile)
    }
  }
}
// Spawn derivation for plan lineage (packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts:504-525)
const su = await import(`${R}/packages/agent-runtime/src/tools/handlers/tool/spawn-agent-utils.ts`)
const defs = reg.loadAgentDefinitions(); const byId = new Map(defs.map((d: any) => [d.id, d]))
const parent: any = { ...src, toolNames: eff }
for (const id of ['basher', 'general-agent', 'proj-writer']) {
  const child: any = byId.get(id)
  const derived = su.deriveSpawnTemplateCapabilities({ agentTemplate: { ...child, toolNames: child.toolNames ?? [] }, parentAgentTemplate: parent, handoff: undefined, projectRoot: proj })
  console.log(`[derive child of base2-plan] ${id}: planOnly=${derived.programmaticConfig?.planOnly} terminalProfile=${derived.terminalPermissionProfile} mutating tools kept =`, MUT.filter(t => derived.toolNames.includes(t)))
}
// DI dispatch of rename_symbol handler
const { handleRenameSymbol } = await import(`${R}/packages/agent-runtime/src/tools/handlers/tool/rename-symbol.ts`)
const forwarded: any[] = []
await handleRenameSymbol({ previousToolCallFinished: Promise.resolve(), toolCall: { toolName: 'rename_symbol', toolCallId: 'c1', input: { path: 'a.ts', line: 1, character: 1, new_name: 'pwned' } } as any, requestClientToolCall: async (c: any) => { forwarded.push(c); return [{ type: 'json', value: { applied: true } }] as any } } as any)
console.log('[DI] handleRenameSymbol forwarded to client =', JSON.stringify(forwarded))
process.exit(0)
