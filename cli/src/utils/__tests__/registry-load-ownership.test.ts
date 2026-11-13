import { afterEach, expect, test } from 'bun:test'
import { initializeAgentRegistry, loadLocalAgents, getProjectAgentTrustStatus, __resetLocalAgentRegistryForTests } from '../local-agent-registry'
import { initializeSkillRegistry, getLoadedSkills, getProjectSkillTrustStatus, __resetSkillRegistryForTests } from '../skill-registry'
import { createDeferredRegistryLoader } from '../../services/deferred-registries'

afterEach(() => { __resetLocalAgentRegistryForTests(); __resetSkillRegistryForTests() })
const gate = <T,>() => { let resolve!: (value:T) => void; const promise = new Promise<T>((done) => resolve = done); return {promise, resolve} }

test('late old-project registry success cannot overwrite current project definitions or trust', async () => {
  let root = '/project-a'
  const oldAgents = gate<any>(), oldSkills = gate<any>()
  const agent = {id: 'current', displayName: 'Current', model: 'fixture'} as any
  const deps = {getRoot: () => root, getCwd: () => root, loadAgents: () => oldAgents.promise, loadMcpConfig: () => ({mcpServers: {}, _sourceFilePath: ''})}
  const first = initializeAgentRegistry({trustProjectAgents: true}, deps)
  const skills = initializeSkillRegistry({trustProjectSkills: true}, {getRoot: () => root, loadSkills: () => oldSkills.promise})
  root = '/project-b'
  await initializeAgentRegistry({trustProjectAgents: false}, {...deps, loadAgents: async () => ({agents: {current: agent}, validationErrors: []})})
  await initializeSkillRegistry({trustProjectSkills: false}, {getRoot: () => root, loadSkills: async () => ({current: {name:'current'} as any})})
  oldAgents.resolve({agents: {old: {...agent, id: 'old'}}, validationErrors: []})
  oldSkills.resolve({old: {name:'old'}})
  await Promise.all([first, skills])
  expect(loadLocalAgents().map((value) => value.id)).toContain('current')
  expect(loadLocalAgents().map((value) => value.id)).not.toContain('old')
  expect(Object.keys(getLoadedSkills())).toEqual(['current'])
  expect(getProjectAgentTrustStatus()).toBe(false)
  expect(getProjectSkillTrustStatus()).toBe(false)
})

test('reset revokes an old deferred chain before skills; recovery restores independent trust decisions', async () => {
  let root = '/project-a'
  const pending = gate<void>()
  const calls: unknown[] = []
  const loader = createDeferredRegistryLoader({getRoot: () => root, invalidate: () => {}, warn: () => {},
    initializeAgents: async (options) => {calls.push(options); if (root === '/project-a') await pending.promise},
    initializeSkills: async (options) => {calls.push(options)},
  })
  loader.startDeferredRegistryLoads({shouldLoadAgents:true, effectiveTrust:true})
  const old = loader.whenRegistriesReady()
  root = '/project-b'
  await loader.reloadProjectRegistries({shouldLoadAgents:true, trustProjectAgents:false, trustProjectSkills:true})
  pending.resolve()
  await old
  expect(calls).toEqual([{trustProjectAgents:true}, {trustProjectAgents:false}, {trustProjectSkills:true}])
})
