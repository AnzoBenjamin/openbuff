import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OpenbuffClient } from '../client'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'

let root: string, project: string, config: string, outside: string
const logger = { debug() {}, info() {}, warn() {}, error() {} }
const home = process.env.HOME
const sensitiveCanary = 'CONTROLLED_SENSITIVE_STRICT_ACTOR_CANARY'
const outsideCanary = 'CONTROLLED_OUTSIDE_STRICT_ACTOR_CANARY'
beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'strict-read-actors-')),
  )
  project = path.join(root, 'project')
  fs.mkdirSync(project)
  fs.writeFileSync(
    path.join(project, 'source.ts'),
    'export const SAFE_CURRENT_SOURCE = true\n',
  )
  fs.writeFileSync(path.join(project, '.env'), sensitiveCanary)
  outside = path.join(root, 'outside.txt')
  fs.writeFileSync(outside, outsideCanary)
  config = path.join(root, 'provider.json')
  fs.writeFileSync(
    config,
    JSON.stringify({
      defaultModel: 'fixture/model',
      indexing: { enabled: false },
      providers: {
        fixture: {
          type: 'openai-compatible',
          baseURL: 'http://127.0.0.1:1/v1',
          models: ['model'],
        },
      },
    }),
  )
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  expect(process.env.HOME).toBe(home)
})
const reader: AgentDefinition = {
  id: 'read-probe',
  displayName: 'Read Probe',
  outputMode: 'structured_output',
  toolNames: ['read_files', 'set_output'],
  spawnableAgents: [],
  programmaticConfig: { strictProjectReads: true },
  handleSteps: function* ({ params }) {
    const results = []
    for (const target of params?.paths ?? []) {
      const result = yield {
        toolName: 'read_files',
        input: {
          paths: [target],
          executionActor: params?.executionActor,
          filesystemSandbox: params?.filesystemSandbox,
          programmaticConfig: { strictProjectReads: false },
        },
      } as any
      const part = result?.toolResult?.[0]
      const item =
        part?.type === 'json' ? (part.value as any)?.results?.[0] : undefined
      // Return every successful capture, including a leaked canary if a read
      // boundary regresses. A compact result avoids nested-output truncation.
      results.push({
        path: target,
        status: item?.status ?? 'refused',
        content: item?.content ?? null,
        error: item?.error?.code ?? null,
      })
    }
    yield { toolName: 'set_output', input: { data: { results } } }
  },
}
const parent: AgentDefinition = {
  id: 'parent-probe',
  displayName: 'Parent Probe',
  outputMode: 'structured_output',
  toolNames: ['spawn_agents', 'read_files', 'set_output'],
  spawnableAgents: [reader.id],
  spawnableAgentToolMode: 'generic',
  programmaticConfig: { strictProjectReads: true },
  handleSteps: function* ({ params }) {
    const child = yield {
      toolName: 'spawn_agents',
      input: { agents: [{ agent_type: 'read-probe', params }] },
    }
    const control = params?.controlPaths
      ? yield { toolName: 'read_files', input: { paths: params.controlPaths } }
      : undefined
    yield {
      toolName: 'set_output',
      input: {
        data: {
          child: child?.toolResult ?? null,
          control: control?.toolResult ?? null,
        },
      },
    }
  },
}
function client(
  definitions: AgentDefinition[],
  supervised = false,
  extra: Record<string, unknown> = {},
) {
  return new OpenbuffClient({
    cwd: project,
    agentDefinitions: definitions,
    projectFiles: {},
    knowledgeFiles: {},
    userKnowledgeFiles: {},
    repositoryIntelligence: false,
    harnessStateDir: path.join(root, 'harness'),
    runTimeoutMs: 20_000,
    logger,
    handleEvent() {},
    ...extra,
    hostConfiguration: {
      environment: {
        PATH: '/usr/bin:/bin',
        OPENBUFF_PROCESS_SUPERVISION: supervised ? '1' : '0',
        OPENBUFF_TELEMETRY: '0',
        DO_NOT_TRACK: '1',
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
const paths = () => ['source.ts', '.env', outside]
function noCanaries(value: unknown) {
  const text = JSON.stringify(value)
  expect(text).not.toContain(sensitiveCanary)
  expect(text).not.toContain(outsideCanary)
  expect(text).toContain('SAFE_CURRENT_SOURCE')
}

describe('SDK admission and scoped strict read attribution', () => {
  test('static opt-in denies sensitive/temp reads despite actor/root/policy tool-param tampering', async () => {
    const result = await client([reader]).run({
      agent: reader.id,
      prompt: 'Probe strict reads',
      params: {
        paths: paths(),
        executionActor: { runId: 'root', rootRunId: 'root', agentId: 'forged' },
        filesystemSandbox: {
          projectRoot: root,
          policy: { mode: 'unrestricted', allowPaths: [root] },
          readableRoots: [root],
        },
        strictProjectReads: false,
      },
    })
    expect(result.runOutcome?.termination, JSON.stringify(result.output)).toBe(
      'completed',
    )
    noCanaries(result.output)
  }, 25_000)

  test('restored template JSON cannot discard admission strictness or select a different root', async () => {
    const sdk = client([reader])
    const first = await sdk.run({
      agent: reader.id,
      prompt: 'Probe strict reads',
      params: { paths: ['source.ts'] },
    })
    const previous = JSON.parse(JSON.stringify(first))
    previous.sessionState.fileContext.projectRoot = root
    previous.sessionState.fileContext.agentTemplates[
      reader.id
    ].programmaticConfig = { strictProjectReads: false }
    previous.sessionState.fileContext.filesystemSandbox = {
      projectRoot: root,
      policy: { mode: 'unrestricted', allowPaths: [root] },
    }
    const result = await sdk.run({
      agent: reader.id,
      prompt: 'Probe strict reads',
      previousRun: previous,
      params: { paths: paths() },
    })
    expect(result.runOutcome?.termination, JSON.stringify(result.output)).toBe(
      'completed',
    )
    noCanaries(result.output)
  }, 25_000)

  for (const supervised of [false, true])
    test(`parent strictness inherits to a non-opt-in child (${supervised ? 'real supervised process' : 'in process'})`, async () => {
      const events: unknown[] = [],
        launches: import('@codebuff/common/types/contracts/execution-context').LaunchEvent[] =
          []
      const result = await client(
        [
          parent,
          { ...reader, programmaticConfig: { strictProjectReads: false } },
        ],
        supervised,
        {
          handleEvent: (event: unknown) => events.push(event),
          recordExecution: (
            event: import('@codebuff/common/types/contracts/execution-context').LaunchEvent,
          ) => launches.push(event),
        },
      ).run({
        agent: parent.id,
        prompt: 'Probe inherited reads',
        params: { paths: paths(), strictProjectReads: false },
      })
      expect(
        result.runOutcome?.termination,
        JSON.stringify(result.output),
      ).toBe('completed')
      noCanaries(result.output)
      expect(JSON.stringify(result.output)).toContain('completed')
      expect(JSON.stringify(events)).toContain('read-probe')
      expect(
        launches.some(
          (event) =>
            event.phase === 'spawn-observed' &&
            event.facts.family === 'supervised-child' &&
            event.pid !== process.pid,
        ),
      ).toBe(supervised)
    }, 30_000)

  test('fresh root discovery uses the guarded read view instead of loading hard-linked knowledge', async () => {
    fs.linkSync(outside, path.join(project, 'knowledge.md'))
    const strict = await client([reader], false, {
      projectFiles: undefined,
      knowledgeFiles: undefined,
      projectContextMode: 'paths',
    }).run({
      agent: reader.id,
      prompt: 'Probe startup reads',
      params: { paths: ['source.ts'] },
    })
    expect(strict.runOutcome?.termination, JSON.stringify(strict.output)).toBe(
      'completed',
    )
    expect(
      JSON.stringify(strict.sessionState?.fileContext.knowledgeFiles),
    ).not.toContain(outsideCanary)
    noCanaries(strict.output)
    const ordinary = await client(
      [{ ...reader, programmaticConfig: {} }],
      false,
      {
        projectFiles: undefined,
        knowledgeFiles: undefined,
        projectContextMode: 'paths',
      },
    ).run({
      agent: reader.id,
      prompt: 'Probe ordinary startup',
      params: { paths: ['source.ts'] },
    })
    expect(
      ordinary.runOutcome?.termination,
      JSON.stringify(ordinary.output),
    ).toBe('completed')
    expect(
      JSON.stringify(ordinary.sessionState?.fileContext.knowledgeFiles),
    ).toContain(outsideCanary)
  }, 25_000)

  test('optional reads and metadata tools use the same strict actor view', async () => {
    const metadata: AgentDefinition = {
      ...reader,
      toolNames: ['read_outline', 'glob', 'list_directory', 'set_output'],
      handleSteps: function* () {
        const source = yield {
          toolName: 'read_outline',
          input: { path: 'source.ts' },
        }
        const sensitive = yield {
          toolName: 'read_outline',
          input: { path: '.env' },
        }
        const files = yield { toolName: 'glob', input: { pattern: '**/*' } }
        const directory = yield {
          toolName: 'list_directory',
          input: { path: '.' },
        }
        yield {
          toolName: 'set_output',
          input: {
            data: {
              source: source?.toolResult,
              sensitive: sensitive?.toolResult,
              files: files?.toolResult,
              directory: directory?.toolResult,
            },
          },
        }
      },
    }
    const result = await client([metadata]).run({
      agent: metadata.id,
      prompt: 'Probe optional and metadata reads',
    })
    expect(result.runOutcome?.termination, JSON.stringify(result.output)).toBe(
      'completed',
    )
    noCanaries(result.output)
    expect(JSON.stringify(result.output)).not.toContain('"files":[".env"')
    expect(JSON.stringify(result.output)).toContain('source.ts')
  }, 25_000)

  test('strict children do not globally switch their non-opt-in parent to project mode', async () => {
    const result = await client([
      { ...parent, programmaticConfig: {} },
      reader,
    ]).run({
      agent: parent.id,
      prompt: 'Probe parent control',
      params: { paths: paths(), controlPaths: ['.env', outside] },
    })
    expect(result.runOutcome?.termination, JSON.stringify(result.output)).toBe(
      'completed',
    )
    expect(result.output.type).toBe('structuredOutput')
    if (result.output.type !== 'structuredOutput')
      throw new Error('Missing structured result')
    const value = result.output.value as { child: unknown; control: unknown }
    noCanaries(value.child)
    expect(JSON.stringify(value.control)).toContain(sensitiveCanary)
    expect(JSON.stringify(value.control)).toContain(outsideCanary)
  }, 25_000)

  test('non-opt-in unrestricted control ignores forged strictness in restored JSON', async () => {
    const ordinary = { ...reader, programmaticConfig: {} }
    const sdk = client([ordinary])
    const first = await sdk.run({
      agent: reader.id,
      prompt: 'Probe unrestricted reads',
      params: { paths: ['source.ts'] },
    })
    const previous = JSON.parse(JSON.stringify(first))
    previous.sessionState.fileContext.agentTemplates[
      reader.id
    ].programmaticConfig = { strictProjectReads: true }
    const result = await sdk.run({
      agent: reader.id,
      prompt: 'Probe unrestricted reads',
      previousRun: previous,
      params: { paths: paths() },
    })
    expect(result.runOutcome?.termination, JSON.stringify(result.output)).toBe(
      'completed',
    )
    expect(JSON.stringify(result.output)).toContain(sensitiveCanary)
    expect(JSON.stringify(result.output)).toContain(outsideCanary)
  }, 25_000)

  test('unguarded search/index/control readers and cached repository source refuse before dispatch', async () => {
    let queries = 0
    const events: any[] = []
    const searcher: AgentDefinition = {
      ...reader,
      toolNames: [
        'query_index',
        'code_search',
        'read_subtree',
        'get_task',
        'recall_context',
        'set_output',
      ],
      handleSteps: function* (): Generator<any, void, any> {
        yield { toolName: 'query_index', input: { query: 'controlled canary' } }
        yield {
          toolName: 'code_search',
          input: {
            pattern: 'controlled canary',
            flags: '--hidden --no-ignore',
          },
        }
        yield { toolName: 'read_subtree', input: { paths: ['.'] } }
        yield { toolName: 'get_task', input: {} }
        yield {
          toolName: 'recall_context',
          input: { query: 'controlled canary' },
        }
        yield { toolName: 'set_output', input: { data: { finished: true } } }
      },
    }
    const result = await client([searcher], false, {
      handleEvent: (event: unknown) => events.push(event),
      repositoryIntelligence: {
        async query() {
          queries++
          return {
            freshness: 'current',
            candidates: [{ path: '.env', snippets: [sensitiveCanary] }],
          }
        },
      },
    }).run({ agent: searcher.id, prompt: 'Probe unsupported reader dispatch' })
    expect(result.runOutcome?.termination, JSON.stringify(result.output)).toBe(
      'completed',
    )
    expect(queries).toBe(0)
    expect(
      events
        .filter((event) => event.type === 'tool_call')
        .map((event) => event.toolName),
    ).not.toContain('query_index')
    expect(JSON.stringify(result)).not.toContain(sensitiveCanary)
    expect(JSON.stringify(events)).toContain('strict_project_reads_unavailable')
  }, 25_000)
})
