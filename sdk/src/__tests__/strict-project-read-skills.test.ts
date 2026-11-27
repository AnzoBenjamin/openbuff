import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OpenbuffClient } from '../client'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'

let root: string, project: string, skills: string, config: string
const marker = 'OUTSIDE_SKILL_CANARY_MUST_NOT_BE_LOADED'
const reader: AgentDefinition = {
  id: 'strict-skill-probe',
  displayName: 'Strict skill probe',
  toolNames: [],
  programmaticConfig: { strictProjectReads: true },
  handleSteps: function* () {
    yield { type: 'STEP_TEXT', text: 'done' }
  },
}
beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'strict-skill-bootstrap-')),
  )
  project = path.join(root, 'project')
  skills = path.join(root, 'external-skills')
  fs.mkdirSync(project)
  fs.mkdirSync(path.join(skills, 'outside-skill'), { recursive: true })
  fs.writeFileSync(
    path.join(skills, 'outside-skill', 'SKILL.md'),
    `---\nname: outside-skill\ndescription: ${marker}\n---\n${marker}\n`,
  )
  config = path.join(root, 'config.json')
  fs.writeFileSync(
    config,
    JSON.stringify({ defaultModel: 'fixture/model', providers: {} }),
  )
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
function client(strict: boolean, skillsDir?: string) {
  return new OpenbuffClient({
    cwd: project,
    agentDefinitions: [
      { ...reader, programmaticConfig: { strictProjectReads: strict } },
    ],
    skillsDir,
    projectFiles: {},
    knowledgeFiles: {},
    userKnowledgeFiles: {},
    repositoryIntelligence: false,
    harnessStateDir: path.join(root, 'harness'),
    runTimeoutMs: 5_000,
    handleEvent() {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    hostConfiguration: {
      environment: {
        PATH: '/usr/bin:/bin',
        OPENBUFF_PROCESS_SUPERVISION: '0',
        OPENBUFF_TELEMETRY: '0',
      },
      platform: process.platform,
      invocationCwd: project,
      projectRoot: project,
      home: { kind: 'none' },
      globals: { kind: 'disabled' },
      selection: { kind: 'explicit', path: config, required: true },
      trust: { ancestorConfig: false, projectReadableRoots: false },
    },
  })
}

describe('strict root skill bootstrap read boundary', () => {
  test('explicit outside skills are withheld on fresh strict startup, ordinary control unchanged', async () => {
    const strict = await client(true, skills).run({
      agent: reader.id,
      prompt: 'Probe skills',
    })
    expect(strict.runOutcome?.termination).toBe('completed')
    expect(strict.sessionState?.fileContext.skills).toEqual({})
    expect(
      JSON.stringify(strict.sessionState?.fileContext.skills),
    ).not.toContain(marker)
    const ordinary = await client(false, skills).run({
      agent: reader.id,
      prompt: 'Probe ordinary skills',
    })
    expect(ordinary.runOutcome?.termination).toBe('completed')
    expect(JSON.stringify(ordinary.sessionState?.fileContext.skills)).toContain(
      marker,
    )
  })
  test('strict continuation removes inherited outside skill bytes without disk fallback', async () => {
    const first = await client(false, skills).run({
      agent: reader.id,
      prompt: 'Load ordinary skills',
    })
    expect(JSON.stringify(first.sessionState?.fileContext.skills)).toContain(
      marker,
    )
    const next = await client(true, skills).run({
      agent: reader.id,
      prompt: 'Probe strict continuation',
      previousRun: first,
    })
    expect(next.runOutcome?.termination).toBe('completed')
    expect(next.sessionState?.fileContext.skills).toEqual({})
  })
  test('a hard-linked project skill is not loaded through raw bootstrap', async () => {
    const dir = path.join(project, '.agents', 'skills', 'outside-skill')
    fs.mkdirSync(dir, { recursive: true })
    fs.linkSync(
      path.join(skills, 'outside-skill', 'SKILL.md'),
      path.join(dir, 'SKILL.md'),
    )
    const result = await client(true, path.dirname(dir)).run({
      agent: reader.id,
      prompt: 'Probe linked skill',
    })
    expect(result.runOutcome?.termination).toBe('completed')
    expect(result.sessionState?.fileContext.skills).toEqual({})
  })
})
