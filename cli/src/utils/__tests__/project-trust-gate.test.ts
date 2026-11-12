import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  getProjectTrustOverride,
  readProjectTrustStoreSync,
  setProjectTrustOverride,
} from '@openbuff/sdk'

import {
  listProjectTrustExtras,
  resolveProjectTrust,
} from '../project-trust-gate'

import type { ProjectTrustState } from '@openbuff/sdk'

let root: string
let configDir: string
let project: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'n02-cli-')))
  configDir = path.join(root, 'cfg')
  project = path.join(root, 'proj')
  fs.mkdirSync(configDir)
  fs.mkdirSync(project)
  setProjectTrustOverride(undefined)
})

afterEach(() => {
  setProjectTrustOverride(undefined)
  fs.rmSync(root, { recursive: true, force: true })
})

const state = (overrides: Partial<ProjectTrustState> = {}): ProjectTrustState => ({
  projectRoot: project,
  configHash: 'sha256:abc',
  status: 'untrusted',
  reason: 'unknown',
  files: [path.join(project, 'openbuff.json')],
  gated: [{ kind: 'approvalMode', filePath: path.join(project, 'openbuff.json'), summary: 'set approvalMode "allow-all" (yours: "balanced")' }],
  ...overrides,
})

describe('resolveProjectTrust', () => {
  test('--trust-project-agents is recorded as an explicit grant', async () => {
    const outcome = await resolveProjectTrust({ projectRoot: project, flag: true }, { configDir, loadState: () => state() })
    expect(outcome).toMatchObject({ trusted: true, source: 'flag' })
    expect(readProjectTrustStoreSync(configDir).projects[project]).toMatchObject({ decision: 'trusted', source: 'flag', configHash: 'sha256:abc' })
    expect(getProjectTrustOverride(project)).toBe('trusted')
  })

  test('interactive launch asks once and persists the answer', async () => {
    const asked: string[][] = []
    const outcome = await resolveProjectTrust({ projectRoot: project, flag: false }, {
      configDir, loadState: () => state(), prompt: async (lines) => { asked.push(lines); return false },
    })
    expect(outcome).toMatchObject({ trusted: false, source: 'prompt' })
    expect(asked).toEqual([['set approvalMode "allow-all" (yours: "balanced") (openbuff.json)']])
    expect(readProjectTrustStoreSync(configDir).projects[project]?.decision).toBe('untrusted')
    expect(getProjectTrustOverride(project)).toBe('untrusted')
  })

  test('a stored decision is not asked again; a changed config is', async () => {
    let asked = 0
    const prompt = async () => { asked++; return true }
    await resolveProjectTrust({ projectRoot: project, flag: false }, { configDir, loadState: () => state({ status: 'untrusted', reason: 'stored' }), prompt })
    expect(asked).toBe(0)
    const outcome = await resolveProjectTrust({ projectRoot: project, flag: false }, { configDir, loadState: () => state({ reason: 'changed' }), prompt })
    expect(asked).toBe(1)
    expect(outcome.trusted).toBe(true)
  })

  test('headless launch prints one notice naming the file and stays untrusted', async () => {
    const notices: string[] = []
    const outcome = await resolveProjectTrust({ projectRoot: project, flag: false }, { configDir, loadState: () => state(), notice: (line) => notices.push(line) })
    expect(outcome.trusted).toBe(false)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('openbuff.json')
    expect(notices[0]).toContain('--trust-project-agents')
    expect(fs.existsSync(path.join(configDir, 'project-trust.json'))).toBe(false)
  })

  test('serve allowlist grants without persisting', async () => {
    const outcome = await resolveProjectTrust({ projectRoot: project, flag: false, allowlisted: true }, { configDir, loadState: () => state() })
    expect(outcome).toMatchObject({ trusted: true, source: 'allowlist' })
    expect(fs.existsSync(path.join(configDir, 'project-trust.json'))).toBe(false)
  })

  test('nothing gated and no project agents or skills: no question', async () => {
    let asked = 0
    const outcome = await resolveProjectTrust({ projectRoot: project, flag: false }, {
      configDir, loadState: () => state({ gated: [] }), prompt: async () => { asked++; return true },
    })
    expect(asked).toBe(0)
    expect(outcome.trusted).toBe(false)
  })
})

describe('listProjectTrustExtras', () => {
  test('lists project agents, skills and MCP config', () => {
    fs.mkdirSync(path.join(project, '.agents', 'skills', 's'), { recursive: true })
    fs.writeFileSync(path.join(project, '.agents', 'my-agent.ts'), '')
    fs.writeFileSync(path.join(project, '.agents', 'mcp.json'), '{}')
    expect(listProjectTrustExtras(project)).toEqual([
      'load project agents from .agents/',
      `load project skills from ${path.join('.agents', 'skills')}/`,
      'start MCP servers from .agents/mcp.json',
    ])
  })
})
