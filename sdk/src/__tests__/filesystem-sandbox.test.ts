import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { withFilesystemSandbox } from '@codebuff/common/util/filesystem-sandbox'
import {
  resolveProjectPath,
  resolveProjectPathForFileSystem,
} from '@codebuff/common/util/project-path-containment'
import { OpenbuffClient } from '../client'
import { nodeConfigReadFs } from '../host-config'
import { codeSearch } from '../tools/code-search'
import { glob } from '../tools/glob'
import { createNodeFileSystem } from '../tools/node-filesystem'
import { evaluateTerminalCommandPolicy } from '../tools/terminal-command-policy'

import type {
  AgentDefinition,
  ToolCall,
} from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { FilesystemSandboxPolicy } from '@codebuff/common/util/filesystem-sandbox'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})
const unrestricted: FilesystemSandboxPolicy = {
  mode: 'unrestricted',
  allowPaths: [],
}
const project: FilesystemSandboxPolicy = { mode: 'project', allowPaths: [] }
const program: AgentDefinition = {
  id: 'sandbox-fixture',
  displayName: 'Sandbox fixture',
  model: 'fixture-model',
  toolNames: [
    'read_files',
    'write_file',
    'read_subtree',
    'read_outline',
    'read_logs',
    'list_directory',
    'glob',
    'code_search',
    'run_terminal_command',
    'set_output',
  ],
  outputMode: 'structured_output',
  handleSteps: function* ({ prompt }) {
    const results = []
    for (const call of JSON.parse(prompt ?? '[]')) {
      const { toolResult } = yield call as ToolCall
      results.push(toolResult)
    }
    yield { toolName: 'set_output', input: { results } }
  },
}

function fixture(sandbox?: FilesystemSandboxPolicy) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-sandbox-'))
  roots.push(root)
  const cwd = path.join(root, 'project'),
    external = path.join(root, 'config')
  fs.mkdirSync(cwd)
  fs.mkdirSync(external)
  fs.writeFileSync(path.join(external, 'service.log'), 'sandbox-fixture log\n')
  fs.writeFileSync(path.join(external, '.env'), 'FIXTURE_VALUE=local-only\n')
  fs.writeFileSync(path.join(external, 'notes.md'), '# Outside project\n')
  fs.symlinkSync(path.join(external, '.env'), path.join(cwd, 'config-link'))
  const configFile = path.join(cwd, 'openbuff.json')
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      autoFileChangeHooks: false,
      sandbox,
      providers: {
        fixture: {
          type: 'openai-compatible',
          baseURL: 'https://fixture.invalid/v1',
          models: ['fixture-model'],
          apiKeyEnv: 'FIXTURE_KEY',
        },
      },
    }),
  )
  const client = new OpenbuffClient({
    cwd,
    knowledgeFiles: {},
    approvalMode: 'allow-all',
    harnessStateDir: path.join(root, 'state'),
    configReadFs: nodeConfigReadFs,
    hostConfiguration: {
      invocationCwd: cwd,
      projectRoot: cwd,
      home: { kind: 'none' },
      globals: { kind: 'disabled' },
      selection: { kind: 'explicit', path: configFile, required: true },
      trust: { ancestorConfig: false, projectReadableRoots: true },
      environment: { PATH: '/usr/bin:/bin' },
      platform: process.platform,
    },
  })
  const run = (calls: unknown[]) =>
    client.run({ agent: program, prompt: JSON.stringify(calls) })
  return { cwd, external, configFile, run }
}

describe('filesystem sandbox configuration reaches actual agent runs', () => {
  test('default runs read config, logs, outlines, subtrees, and terminal cwd outside the project', async () => {
    const f = fixture()
    const result = await f.run([
      { toolName: 'read_files', input: { paths: ['../config/.env'] } },
      { toolName: 'read_files', input: { paths: ['config-link'] } },
      {
        toolName: 'read_logs',
        input: { path: path.join(f.external, 'service.log') },
      },
      {
        toolName: 'read_outline',
        input: { path: path.join(f.external, 'notes.md') },
      },
      { toolName: 'read_subtree', input: { paths: [f.external] } },
      { toolName: 'list_directory', input: { path: f.external } },
      { toolName: 'glob', input: { pattern: '*.md', cwd: f.external } },
      {
        toolName: 'code_search',
        input: {
          pattern: 'sandbox-fixture',
          cwd: path.join(f.external, 'service.log'),
        },
      },
      {
        toolName: 'run_terminal_command',
        input: { command: 'pwd', cwd: f.external, process_type: 'SYNC' },
      },
    ])
    expect(result.output).toMatchObject({ type: 'structuredOutput' })
    expect(
      result.actionOutcomes?.filter((action) => action.outcome !== 'succeeded'),
    ).toEqual([])
    const output = JSON.stringify(result.output)
    expect(output).toContain('FIXTURE_VALUE=local-only')
    expect(output).toContain('sandbox-fixture log')
    expect(output).toContain('Outside project')
    expect(output).toContain('notes.md')
    expect(output).toContain(f.external)
  }, 20_000)

  test('default writes create and overwrite external files through the mutation broker', async () => {
    const f = fixture()
    const file = path.join(f.external, 'script.ts')
    const result = await f.run([
      {
        toolName: 'write_file',
        input: {
          path: file,
          instructions: 'Create fixture',
          content: 'export const value = 1\n',
        },
      },
      { toolName: 'read_files', input: { paths: [file] } },
      {
        toolName: 'write_file',
        input: {
          path: file,
          instructions: 'Update fixture',
          content: 'export const value = 2\n',
        },
      },
    ])
    expect(result.output).toMatchObject({ type: 'structuredOutput' })
    expect(
      result.actionOutcomes?.filter((action) => action.outcome !== 'succeeded'),
    ).toEqual([])
    expect(fs.readFileSync(file, 'utf8')).toBe('export const value = 2\n')
  }, 20_000)

  test('project mode blocks traversal and sensitive reads', async () => {
    const f = fixture(project)
    const result = await f.run([
      { toolName: 'read_files', input: { paths: ['../config/.env'] } },
      {
        toolName: 'read_files',
        input: { paths: [path.join(f.external, '.env')] },
      },
    ])
    expect(result.output).toMatchObject({ type: 'structuredOutput' })
    expect(JSON.stringify(result.output)).not.toContain(
      'FIXTURE_VALUE=local-only',
    )
    expect(
      result.actionOutcomes?.some((action) => action.outcome !== 'succeeded'),
    ).toBe(true)
  }, 20_000)

  test('external glob and code search work with the unrestricted policy', async () => {
    const f = fixture()
    await withFilesystemSandbox(unrestricted, async () => {
      const files = await glob({
        pattern: '*.md',
        cwd: f.external,
        projectPath: f.cwd,
        fs: createNodeFileSystem(),
      })
      expect(JSON.stringify(files)).toContain(path.join(f.external, 'notes.md'))
      const matches = await codeSearch({
        projectPath: f.cwd,
        cwd: path.join(f.external, 'service.log'),
        pattern: 'sandbox-fixture',
      })
      expect(JSON.stringify(matches)).toContain('sandbox-fixture log')
    })
  }, 20_000)

  test('project mode applies additional writable roots on the next run', async () => {
    const f = fixture(project)
    const config = JSON.parse(fs.readFileSync(f.configFile, 'utf8'))
    config.sandbox.allowPaths = [f.external]
    fs.writeFileSync(f.configFile, JSON.stringify(config))
    const file = path.join(f.external, 'allowed.ts')
    const result = await f.run([
      { toolName: 'read_files', input: { paths: ['../config/service.log'] } },
      {
        toolName: 'write_file',
        input: {
          path: file,
          instructions: 'Create allowed fixture',
          content: 'export const allowed = true\n',
        },
      },
    ])
    expect(result.output).toMatchObject({ type: 'structuredOutput' })
    expect(
      result.actionOutcomes?.filter((action) => action.outcome !== 'succeeded'),
    ).toEqual([])
    expect(fs.readFileSync(file, 'utf8')).toBe('export const allowed = true\n')
  }, 20_000)
})

test('concurrent policies stay isolated, including asynchronous filesystem resolution', async () => {
  const fileSystem = createNodeFileSystem()
  await Promise.all(
    [unrestricted, project].map((policy) =>
      withFilesystemSandbox(policy, async () => {
        await Promise.resolve()
        expect(
          resolveProjectPath('/virtual/project', '/virtual/config/log.txt') !==
            null,
        ).toBe(policy.mode === 'unrestricted')
        expect(
          (await resolveProjectPathForFileSystem(
            '/virtual/project',
            '/virtual/config/log.txt',
            fileSystem,
          )) !== null,
        ).toBe(policy.mode === 'unrestricted')
      }),
    ),
  )
})

test('project allowPaths permits exact roots and children but rejects siblings and symlink escapes', async () => {
  const f = fixture()
  const policy: FilesystemSandboxPolicy = {
    mode: 'project',
    allowPaths: ['/virtual/config', f.external],
  }
  fs.symlinkSync('/etc/passwd', path.join(f.external, 'escaped.txt'))
  await withFilesystemSandbox(policy, async () => {
    expect(
      resolveProjectPath('/virtual/project', '/virtual/config'),
    ).not.toBeNull()
    expect(
      resolveProjectPath('/virtual/project', '/virtual/config/service.log'),
    ).not.toBeNull()
    expect(
      resolveProjectPath(
        '/virtual/project',
        '/virtual/config-other/service.log',
      ),
    ).toBeNull()
    expect(
      resolveProjectPath(f.cwd, path.join(f.external, 'escaped.txt')),
    ).toBeNull()
    expect(
      evaluateTerminalCommandPolicy({
        command: 'cat /virtual/config/service.log',
        mode: 'assistant',
        permissionProfile: 'workspace-write',
        projectRoot: '/virtual/project',
      }).allowed,
    ).toBe(true)
  })
})
