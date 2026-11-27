import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import * as osNamespace from 'os'
import path from 'node:path'

import { createMockLogger } from '@codebuff/common/testing/mocks/logger'
import { OpenbuffClient } from '../client'
import { nodeConfigReadFs } from '../host-config'
import { applyOverridesToSessionState, generateInitialRunState, initialSessionState, loadUserKnowledgeFiles } from '../run-state'
import { loadSkills } from '../skills/load-skills'
import { createNodeFileSystem } from '../tools/node-filesystem'

import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { HostConfigurationInputs } from '../host-config'
import type { OpenbuffClientOptions } from '../run'

const roots: string[] = []
const restores: Array<() => void> = []
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-home-policy-'))
  roots.push(root)
  const home = path.join(root, 'selected-home'), ambient = path.join(root, 'ambient-home'), project = path.join(root, 'project')
  for (const directory of [home, ambient, project]) fs.mkdirSync(directory)
  // Even a regression that misses the homedir spy can only read owned decoys.
  const previousHome = process.env.HOME
  process.env.HOME = ambient
  restores.push(() => { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome })
  fs.writeFileSync(path.join(home, '.knowledge.md'), 'selected home knowledge')
  fs.writeFileSync(path.join(ambient, '.knowledge.md'), 'ambient home must remain unread')
  const source = createNodeFileSystem(), reads: string[] = [], directories: string[] = []
  const readFile = (...args: Parameters<CodebuffFileSystem['readFile']>) => {
    reads.push(String(args[0])); return source.readFile(...args)
  }
  const readdir = (...args: Parameters<CodebuffFileSystem['readdir']>) => {
    directories.push(String(args[0])); return source.readdir(...args)
  }
  const observed: CodebuffFileSystem = Object.create(source, {
    readFile: { value: readFile as CodebuffFileSystem['readFile'] },
    readdir: { value: readdir as CodebuffFileSystem['readdir'] },
  })
  return { root, home, ambient, project, fs: observed, reads, directories, logger: createMockLogger() }
}

function writeSkill(directory: string, name: string, description: string) {
  const skill = path.join(directory, name)
  fs.mkdirSync(skill, { recursive: true })
  fs.writeFileSync(path.join(skill, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${description}\n`)
}

function interceptHomeDirectory(implementation: () => string) {
  const homeDirectory = mock(implementation)
  const namespaceSpy = spyOn(osNamespace, 'homedir').mockImplementation(homeDirectory)
  const defaultSpy = spyOn(os, 'homedir').mockImplementation(homeDirectory)
  restores.push(() => namespaceSpy.mockRestore(), () => defaultSpy.mockRestore())
  return homeDirectory
}

function forbidAmbientHome() {
  return interceptHomeDirectory(() => { throw new Error('Ambient home lookup is forbidden') })
}

function observeSkillPaths() {
  const paths: string[] = []
  const read = fs.readFileSync, list = fs.readdirSync
  const observeRead = ((...args: Parameters<typeof fs.readFileSync>) => {
    paths.push(String(args[0])); return Reflect.apply(read, fs, args)
  }) as typeof fs.readFileSync
  const readSpy = spyOn(fs, 'readFileSync').mockImplementation(observeRead)
  const listSpy = spyOn(fs, 'readdirSync').mockImplementation((...args) => {
    paths.push(String(args[0])); return Reflect.apply(list, fs, args)
  })
  restores.push(() => readSpy.mockRestore(), () => listSpy.mockRestore())
  return paths
}

test('null home knowledge performs no filesystem or ambient-home lookup', async () => {
  const f = fixture(), ambient = forbidAmbientHome()
  expect(await loadUserKnowledgeFiles({ fs: f.fs, logger: f.logger, homeDir: null })).toEqual({})
  expect(f.reads).toEqual([])
  expect(f.directories).toEqual([])
  expect(ambient).not.toHaveBeenCalled()
})

test('explicit home knowledge reads only selected real bytes without ambient fallback', async () => {
  const f = fixture(), ambient = forbidAmbientHome()
  expect(await loadUserKnowledgeFiles({ fs: f.fs, logger: f.logger, homeDir: f.home }))
    .toEqual({ '~/.knowledge.md': 'selected home knowledge' })
  expect(f.directories).toEqual([f.home])
  expect(f.reads).toEqual([path.join(f.home, '.knowledge.md')])
  expect(await loadUserKnowledgeFiles({ fs: f.fs, logger: f.logger, homeDir: path.join(f.root, 'missing-home') })).toEqual({})
  expect(f.reads).toEqual([path.join(f.home, '.knowledge.md')])
  expect(ambient).not.toHaveBeenCalled()
})

test('explicit home skills retain home and project precedence without probing ambient home', async () => {
  const f = fixture()
  for (const [root, description] of [
    [path.join(f.home, '.claude', 'skills'), 'home claude'],
    [path.join(f.home, '.agents', 'skills'), 'home agents'],
    [path.join(f.project, '.claude', 'skills'), 'project claude'],
    [path.join(f.project, '.agents', 'skills'), 'project agents'],
  ]) writeSkill(root, 'shared', description)
  writeSkill(path.join(f.home, '.agents', 'skills'), 'home-only', 'selected home skill')
  writeSkill(path.join(f.ambient, '.agents', 'skills'), 'ambient-only', 'must remain unread')
  const ambient = forbidAmbientHome(), paths = observeSkillPaths()
  const skills = await loadSkills({ cwd: f.project, homeDir: f.home, includeGlobalSkills: true })
  expect(Object.keys(skills).sort()).toEqual(['home-only', 'shared'])
  expect(skills.shared.description).toBe('project agents')
  expect(skills['home-only'].content).toContain('selected home skill')
  expect(paths.some(value => value.startsWith(f.home + path.sep))).toBe(true)
  expect(paths.some(value => value.startsWith(f.project + path.sep))).toBe(true)
  expect(paths.some(value => value.startsWith(f.ambient + path.sep))).toBe(false)
  expect(ambient).not.toHaveBeenCalled()
})

test('null home and disabled global skills retain project skills without any home search', async () => {
  const f = fixture()
  writeSkill(path.join(f.home, '.agents', 'skills'), 'home-only', 'must remain unread')
  writeSkill(path.join(f.project, '.agents', 'skills'), 'project-only', 'project skill')
  const ambient = forbidAmbientHome(), paths = observeSkillPaths()
  for (const selection of [{ homeDir: null }, { homeDir: f.home, includeGlobalSkills: false }, { includeGlobalSkills: false }]) {
    expect(Object.keys(await loadSkills({ cwd: f.project, ...selection }))).toEqual(['project-only'])
  }
  expect(paths.every(value => value.startsWith(f.project + path.sep))).toBe(true)
  expect(ambient).not.toHaveBeenCalled()
})

test('an explicit skills directory remains authoritative with home and global discovery disabled', async () => {
  const f = fixture(), selected = path.join(f.root, 'explicit-skills')
  writeSkill(selected, 'explicit-only', 'explicit skill bytes')
  writeSkill(path.join(f.project, '.agents', 'skills'), 'project-only', 'not selected')
  const ambient = forbidAmbientHome(), paths = observeSkillPaths()
  const skills = await loadSkills({ cwd: f.project, skillsPath: selected, homeDir: null, includeGlobalSkills: false })
  expect(Object.keys(skills)).toEqual(['explicit-only'])
  expect(skills['explicit-only'].content).toContain('explicit skill bytes')
  expect(paths.every(value => value === selected || value.startsWith(selected + path.sep))).toBe(true)
  expect(ambient).not.toHaveBeenCalled()
})

test('omitted standalone home preserves legacy discovery through an owned ambient-home substitute', async () => {
  const f = fixture()
  writeSkill(path.join(f.home, '.agents', 'skills'), 'home-only', 'legacy home skill')
  process.env.HOME = f.home
  const ambient = interceptHomeDirectory(() => f.home)
  expect(await loadUserKnowledgeFiles({ fs: f.fs, logger: f.logger })).toEqual({ '~/.knowledge.md': 'selected home knowledge' })
  expect(Object.keys(await loadSkills({ cwd: f.project }))).toEqual(['home-only'])
  expect(ambient).toHaveBeenCalled()
})

test('initial state uses selected home and project skills while caller knowledge wins', async () => {
  const f = fixture()
  writeSkill(path.join(f.home, '.agents', 'skills'), 'shared', 'home skill')
  writeSkill(path.join(f.home, '.agents', 'skills'), 'home-only', 'home only')
  writeSkill(path.join(f.project, '.agents', 'skills'), 'shared', 'project skill')
  const ambient = forbidAmbientHome()
  const state = await initialSessionState({ cwd: f.project, fs: f.fs, logger: f.logger,
    projectFiles: {}, persistentMemory: false, homeDir: f.home, includeGlobalSkills: true,
    userKnowledgeFiles: { '~/.knowledge.md': 'caller override', 'caller.md': 'caller notes' } })
  expect(state.fileContext.userKnowledgeFiles).toEqual({ '~/.knowledge.md': 'caller override', 'caller.md': 'caller notes' })
  expect(state.fileContext.skills?.shared.description).toBe('project skill')
  expect(state.fileContext.skills?.['home-only'].description).toBe('home only')
  expect(state.fileContext.systemInfo.homedir).toBe(f.home)
  expect(f.reads).toEqual([path.join(f.home, '.knowledge.md')])
  expect(ambient).not.toHaveBeenCalled()
})

test('initial state with no home retains explicit caller knowledge and project skills', async () => {
  const f = fixture()
  writeSkill(path.join(f.project, '.agents', 'skills'), 'project-only', 'project skill')
  const ambient = forbidAmbientHome(), paths = observeSkillPaths()
  const state = await initialSessionState({ cwd: f.project, fs: f.fs, logger: f.logger,
    projectFiles: {}, persistentMemory: false, homeDir: null, includeGlobalSkills: false,
    userKnowledgeFiles: { '~/.knowledge.md': 'deliberate caller content', 'caller.md': 'caller notes' } })
  expect(state.fileContext.userKnowledgeFiles).toEqual({ '~/.knowledge.md': 'deliberate caller content', 'caller.md': 'caller notes' })
  expect(Object.keys(state.fileContext.skills ?? {})).toEqual(['project-only'])
  expect(state.fileContext.systemInfo.homedir).toBe('')
  expect(f.reads).toEqual([])
  expect(f.directories).toEqual([])
  expect(paths.every(value => value.startsWith(f.project + path.sep))).toBe(true)
  expect(ambient).not.toHaveBeenCalled()
})

test('continued isolated state discards previous automatic home inputs and reloads project skills', async () => {
  const f = fixture()
  writeSkill(path.join(f.home, '.agents', 'skills'), 'home-only', 'old home skill')
  writeSkill(path.join(f.project, '.agents', 'skills'), 'project-only', 'old project skill')
  const ambient = forbidAmbientHome()
  const initial = await initialSessionState({ cwd: f.project, fs: f.fs, logger: f.logger,
    projectFiles: {}, persistentMemory: false, homeDir: f.home, includeGlobalSkills: true,
    userKnowledgeFiles: { 'caller.md': 'retained caller notes' } })
  const base = JSON.parse(JSON.stringify(initial)) as typeof initial
  writeSkill(path.join(f.project, '.agents', 'skills'), 'project-only', 'new project skill')
  f.reads.length = 0; f.directories.length = 0
  const continued = await applyOverridesToSessionState(f.project, base,
    { projectFiles: {}, homeDir: null, includeGlobalSkills: false }, { fs: f.fs, logger: f.logger })
  expect(continued.fileContext.userKnowledgeFiles).toEqual({ 'caller.md': 'retained caller notes' })
  expect(Object.keys(continued.fileContext.skills ?? {})).toEqual(['project-only'])
  expect(continued.fileContext.skills?.['project-only'].description).toBe('new project skill')
  expect(continued.fileContext.systemInfo.homedir).toBe('')
  expect(base.fileContext.userKnowledgeFiles?.['~/.knowledge.md']).toBe('selected home knowledge')
  expect(base.fileContext.skills?.['home-only'].description).toBe('old home skill')
  expect(f.reads).toEqual([])
  expect(f.directories).toEqual([])
  expect(ambient).not.toHaveBeenCalled()
})

test('continued selected home replaces old home knowledge and preserves explicit override precedence', async () => {
  const f = fixture(), nextHome = path.join(f.root, 'next-home')
  fs.mkdirSync(nextHome)
  fs.writeFileSync(path.join(nextHome, '.AGENTS.md'), 'next home knowledge')
  writeSkill(path.join(nextHome, '.agents', 'skills'), 'next-home', 'next home skill')
  const ambient = forbidAmbientHome()
  const base = await initialSessionState({ cwd: f.project, fs: f.fs, logger: f.logger,
    projectFiles: {}, persistentMemory: false, homeDir: f.home, includeGlobalSkills: true })
  const continued = await applyOverridesToSessionState(f.project, base,
    { projectFiles: {}, homeDir: nextHome, includeGlobalSkills: true,
      userKnowledgeFiles: { '~/.AGENTS.md': 'caller override' } }, { fs: f.fs, logger: f.logger })
  expect(continued.fileContext.userKnowledgeFiles).toEqual({ '~/.AGENTS.md': 'caller override' })
  expect(Object.keys(continued.fileContext.skills ?? {})).toEqual(['next-home'])
  expect(continued.fileContext.systemInfo.homedir).toBe(nextHome)
  expect(ambient).not.toHaveBeenCalled()
})

test('generateInitialRunState forwards selected home and global skill policy', async () => {
  const f = fixture()
  writeSkill(path.join(f.home, '.agents', 'skills'), 'home-only', 'not enabled')
  const ambient = forbidAmbientHome()
  const run = await generateInitialRunState({ cwd: f.project, fs: f.fs, logger: f.logger,
    projectFiles: {}, persistentMemory: false, homeDir: f.home, includeGlobalSkills: false })
  expect(run.sessionState?.fileContext.userKnowledgeFiles).toEqual({ '~/.knowledge.md': 'selected home knowledge' })
  expect(run.sessionState?.fileContext.skills).toEqual({})
  expect(ambient).not.toHaveBeenCalled()
})

test('actual SDK fresh and continued runs consume their captured home and global policies', async () => {
  const f = fixture(), globalDirectory = path.join(f.root, 'global-config')
  fs.mkdirSync(globalDirectory)
  writeSkill(path.join(f.home, '.agents', 'skills'), 'home-only', 'selected home skill')
  writeSkill(path.join(f.project, '.agents', 'skills'), 'project-only', 'project skill')
  writeSkill(path.join(f.ambient, '.agents', 'skills'), 'ambient-only', 'must remain unread')
  const configuration = path.join(f.project, 'openbuff.json')
  fs.writeFileSync(configuration, JSON.stringify({ autoFileChangeHooks: false, defaultModel: 'fixture/local',
    providers: { fixture: { type: 'openai-compatible', baseURL: 'https://fixture.invalid/v1', models: ['local'], apiKeyEnv: 'FIXTURE_KEY' } } }))
  const inputs: HostConfigurationInputs = { environment: { PATH: '/usr/bin:/bin', HOME: f.ambient,
    FIXTURE_KEY: 'fixture-not-a-real-key', OPENBUFF_PROCESS_SUPERVISION: '0', OPENBUFF_TELEMETRY: '0', DO_NOT_TRACK: '1' },
    platform: 'linux', invocationCwd: f.project, projectRoot: f.project,
    home: { kind: 'path', path: f.home }, globals: { kind: 'directory', path: globalDirectory },
    selection: { kind: 'explicit', path: configuration, required: true },
    // N02: project skills load only for a project the SDK host trusts.
    trust: { ancestorConfig: false, projectReadableRoots: false, projectConfig: 'trusted' } }
  const options: OpenbuffClientOptions = { cwd: f.project, projectFiles: {}, knowledgeFiles: {},
    userKnowledgeFiles: { 'caller.md': 'caller persisted knowledge' }, hostConfiguration: inputs, configReadFs: nodeConfigReadFs,
    harnessStateDir: path.join(f.root, 'harness'), approvalMode: 'allow-all',
    executionProfile: { policy: 'full-access', preferredBackend: 'portable-ts', required: ['exact-env'], allowBackendFallback: false } }
  const agent: AgentDefinition = { id: 'home-policy-sdk', displayName: 'Home policy SDK', model: 'fixture/local',
    toolNames: ['set_output'], outputMode: 'structured_output',
    handleSteps: function* () { yield { toolName: 'set_output', input: { ok: true } } } }
  const ambient = forbidAmbientHome(), paths = observeSkillPaths()
  let networkCalls = 0
  const forbidden = () => { networkCalls++; throw new Error('Network is forbidden in home-policy controls') }
  const network = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => forbidden(), { preconnect: forbidden }))
  restores.push(() => network.mockRestore())
  const first = await new OpenbuffClient(options).run({ prompt: 'fixture', agent })
  expect(first.runOutcome?.termination).toBe('completed')
  expect(first.sessionState?.fileContext.userKnowledgeFiles).toEqual({
    '~/.knowledge.md': 'selected home knowledge', 'caller.md': 'caller persisted knowledge',
  })
  expect(Object.keys(first.sessionState?.fileContext.skills ?? {}).sort()).toEqual(['home-only', 'project-only'])
  const next = await new OpenbuffClient({ ...options, hostConfiguration: { ...inputs,
    home: { kind: 'none' }, globals: { kind: 'disabled' } } }).run({ prompt: 'fixture', agent, previousRun: first })
  expect(next.runOutcome?.termination).toBe('completed')
  expect(next.sessionState?.fileContext.userKnowledgeFiles).toEqual({ 'caller.md': 'caller persisted knowledge' })
  expect(Object.keys(next.sessionState?.fileContext.skills ?? {})).toEqual(['project-only'])
  expect(next.sessionState?.fileContext.systemInfo.homedir).toBe('')
  expect(paths.some(value => value.startsWith(f.ambient + path.sep))).toBe(false)
  expect(ambient).not.toHaveBeenCalled()
  expect(networkCalls).toBe(0)
}, 20_000)

test('actual SDK fresh and continued relative skills resolve against captured invocation cwd', async () => {
  const f = fixture(), relativeDirectory = 'selected-sdk-skills'
  writeSkill(path.join(f.home, relativeDirectory), 'selected', 'captured invocation skill')
  writeSkill(path.join(f.project, relativeDirectory), 'wrong-project', 'project cwd must not choose this')
  writeSkill(path.join(f.ambient, relativeDirectory), 'wrong-ambient', 'ambient cwd must not choose this')
  const configuration = path.join(f.project, 'openbuff.json')
  fs.writeFileSync(configuration, JSON.stringify({ autoFileChangeHooks: false, defaultModel: 'fixture/local',
    providers: { fixture: { type: 'openai-compatible', baseURL: 'https://fixture.invalid/v1', models: ['local'], apiKeyEnv: 'FIXTURE_KEY' } } }))
  const inputs: HostConfigurationInputs = { environment: { PATH: '/usr/bin:/bin', FIXTURE_KEY: 'fixture-not-a-real-key',
    OPENBUFF_PROCESS_SUPERVISION: '0', OPENBUFF_TELEMETRY: '0', DO_NOT_TRACK: '1' },
    platform: 'linux', invocationCwd: f.home, projectRoot: f.project,
    home: { kind: 'none' }, globals: { kind: 'disabled' },
    selection: { kind: 'explicit', path: configuration, required: true },
    trust: { ancestorConfig: false, projectReadableRoots: false } }
  const options: OpenbuffClientOptions = { cwd: f.project, skillsDir: relativeDirectory,
    projectFiles: {}, knowledgeFiles: {}, hostConfiguration: inputs, configReadFs: nodeConfigReadFs,
    fsSource: f.fs, harnessStateDir: path.join(f.root, 'harness'), approvalMode: 'allow-all' }
  const agent: AgentDefinition = { id: 'relative-skill-sdk', displayName: 'Relative skill SDK', model: 'fixture/local',
    toolNames: ['set_output'], outputMode: 'structured_output',
    handleSteps: function* () { yield { toolName: 'set_output', input: { ok: true } } } }
  const ambient = forbidAmbientHome(), paths = observeSkillPaths()
  let networkCalls = 0
  const forbidden = () => { networkCalls++; throw new Error('Network is forbidden in relative-skill controls') }
  const network = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => forbidden(), { preconnect: forbidden }))
  restores.push(() => network.mockRestore())
  const client = new OpenbuffClient(options)
  const first = await client.run({ prompt: 'fixture', agent })
  const resumed = await client.run({ prompt: 'fixture', agent, previousRun: first })
  for (const result of [first, resumed]) {
    expect(result.runOutcome?.termination).toBe('completed')
    expect(Object.keys(result.sessionState?.fileContext.skills ?? {})).toEqual(['selected'])
    expect(result.sessionState?.fileContext.userKnowledgeFiles).toEqual({})
  }
  expect(paths.some(value => value === path.join(f.home, relativeDirectory, 'selected', 'SKILL.md'))).toBe(true)
  expect(paths.some(value => value.startsWith(path.join(f.project, relativeDirectory)) ||
    value.startsWith(path.join(f.ambient, relativeDirectory)) || value.startsWith(relativeDirectory))).toBe(false)
  expect(ambient).not.toHaveBeenCalled()
  expect(networkCalls).toBe(0)
}, 20_000)
