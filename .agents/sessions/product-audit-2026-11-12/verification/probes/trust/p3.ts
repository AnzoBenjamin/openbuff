// Probe extensions-05: skill tool disk fallback + SDK session skill loading vs. project trust.
const R = '/home/ben/Code/CLI/openbuff'
const B = '/tmp/verify-trust/p3'
const proj = `${B}/proj`, home = `${B}/home`
process.env.HOME = home // os.homedir() used by loadSkillFromDisk
const os = await import('node:os')
console.log('[env] os.homedir() =', os.homedir())
const ls = await import(`${R}/sdk/src/skills/load-skills.ts`)
const { handleSkill } = await import(`${R}/packages/agent-runtime/src/tools/handlers/tool/skill.ts`)

// (A) CLI registry with trust OFF (cli/src/utils/skill-registry.ts:57-61, trustProjectSkills=false)
const cliUntrusted = await ls.loadSkills({ cwd: proj, includeProjectSkills: false, verbose: false })
console.log('[A] CLI registry (untrusted) skills =', Object.keys(cliUntrusted))
// (B) SDK session skills, exact args of sdk/src/run-state.ts:861-867 (no includeProjectSkills)
const sdkSession = await ls.loadSkills({ cwd: proj, skillsPath: undefined, homeDir: home, includeGlobalSkills: true, verbose: false })
console.log('[B] SDK initialSessionState skills =', Object.keys(sdkSession), 'deploy-helper from', sdkSession['deploy-helper']?.filePath)

async function call(label: string, skills: any, name: string) {
  const out = await handleSkill({ previousToolCallFinished: Promise.resolve(), toolCall: { toolName: 'skill', toolCallId: 't', input: { name } } as any, fileContext: { projectRoot: proj, skills } as any })
  const v = (out.output as any)[0].value
  console.log(`[${label}] skill(${name}) ->`, JSON.stringify(v.content).slice(0, 110))
}
// (C) Handler with trust-filtered cache (global only, cache = home skills)
await call('C trusted-cache=global-only', cliUntrusted, 'only-project')
// (D) Handler with empty cache (e.g. global skills disabled) -> fallback precedence
await call('D empty-cache', {}, 'deploy-helper')
await call('D empty-cache', {}, 'only-project')
// (E) Handler with the SDK session map (what the runtime actually receives)
await call('E sdk-session-cache', sdkSession, 'deploy-helper')
