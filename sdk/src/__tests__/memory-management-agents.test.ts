import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import retriever from '../../../agents/memory/knowledge-retriever'
import reviewer from '../../../agents/memory/knowledge-reviewer'
import manager from '../../../agents/memory/memory-manager'
import { OpenbuffClient } from '../client'
import { silentLogger } from './fixtures/fake-llm-server'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'

let root: string, project: string, config: string, outside: string
let server: ReturnType<typeof Bun.serve>,
  requests: Record<string, unknown>[],
  counts: Record<string, number>
let attack: boolean
const home = process.env.HOME
const retrieval = {
  schemaVersion: 1,
  status: 'complete',
  scope: ['knowledge.md'],
  summary: 'One scoped package-manager claim.',
  records: [
    {
      id: 'K1',
      statement: 'Use Bun for package scripts.',
      sourceKind: 'knowledge-file',
      canonicalCategory: 'none',
      evidence: [
        { kind: 'file', locator: 'knowledge.md', startLine: 1, endLine: 2 },
      ],
      caveats: [],
    },
  ],
  omissions: [],
}
const review = {
  schemaVersion: 1,
  status: 'complete',
  checkedScopes: ['knowledge.md', 'package.json'],
  summary: 'Current scripts support this guidance.',
  findings: [
    {
      id: 'F1',
      claimId: 'K1',
      status: 'supported',
      detail: 'Package scripts invoke Bun.',
      evidence: [{ kind: 'file', locator: 'package.json' }],
    },
  ],
  proposals: [
    {
      id: 'P1',
      action: 'retain',
      target: 'knowledge.md',
      reason: 'Still accurate.',
      evidence: [{ kind: 'file', locator: 'package.json' }],
    },
  ],
  omissions: [],
}
beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'memory-agents-wire-')),
  )
  project = path.join(root, 'project')
  fs.mkdirSync(project)
  fs.writeFileSync(
    path.join(project, 'knowledge.md'),
    '# Knowledge\nUse Bun for package scripts.\n',
  )
  fs.writeFileSync(
    path.join(project, 'package.json'),
    JSON.stringify({ scripts: { test: 'bun test' } }),
  )
  fs.writeFileSync(
    path.join(project, '.env'),
    'SECRET_CANARY_MUST_NOT_REACH_PROVIDER',
  )
  outside = path.join(root, 'outside.txt')
  fs.writeFileSync(outside, 'OUTSIDE_CANARY_MUST_NOT_REACH_PROVIDER')
  requests = []
  counts = {}
  attack = false
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>
      requests.push(body)
      const messages = JSON.stringify(body.messages)
      const role = messages.includes('You retrieve relevant evidence')
        ? 'knowledge-retriever'
        : messages.includes('You are an independent skeptic')
          ? 'knowledge-reviewer'
          : 'unexpected-manager-model'
      counts[role] = (counts[role] ?? 0) + 1
      const step = counts[role]
      let name = 'set_output',
        input: unknown = role === 'knowledge-retriever' ? retrieval : review
      if (role === 'knowledge-retriever' && attack) {
        if (step === 1) {
          name = 'write_file'
          input = { path: 'should-not-write.txt', content: 'blocked mutation' }
        } else if (step === 2) {
          name = 'record_decision'
          input = {
            kind: 'fact',
            text: 'Must not promote this fabricated fact.',
            evidenceSelectors: ['knowledge.md'],
          }
        } else if (step === 3) {
          name = 'read_files'
          input = { paths: ['.env', outside] }
        } else if (step === 4) {
          name = 'read_files'
          input = { paths: ['knowledge.md', 'package.json'] }
        }
      } else if (step === 1) {
        name = 'read_files'
        input = { paths: ['knowledge.md', 'package.json'] }
      }
      const packet = (
        delta: unknown,
        finish_reason: string | null,
        usage?: unknown,
      ) =>
        `data: ${JSON.stringify({
          id: `memory-agent-${requests.length}`,
          object: 'chat.completion.chunk',
          created: 0,
          model: body.model,
          choices: [{ index: 0, delta, finish_reason }],
          ...(usage ? { usage } : {}),
        })}\n\n`
      return new Response(
        packet(
          {
            tool_calls: [
              {
                index: 0,
                id: `${role}-${step}`,
                type: 'function',
                function: { name, arguments: JSON.stringify(input) },
              },
            ],
          },
          null,
        ) +
          packet({}, 'tool_calls', {
            prompt_tokens: 100,
            completion_tokens: 10,
            total_tokens: 110,
          }) +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  config = path.join(root, 'config.json')
  fs.writeFileSync(
    config,
    JSON.stringify({
      defaultModel: 'fixture/model',
      indexing: { enabled: false },
      providers: {
        fixture: {
          type: 'openai-compatible',
          baseURL: `http://127.0.0.1:${server.port}/v1`,
          models: ['model'],
        },
      },
    }),
  )
})
afterEach(() => {
  const evidenceDir = process.env.OPENBUFF_TEST_MEMORY_AGENTS_EVIDENCE_DIR
  if (evidenceDir) {
    fs.mkdirSync(evidenceDir, { recursive: true })
    fs.writeFileSync(
      path.join(evidenceDir, `wire-${crypto.randomUUID()}.json`),
      JSON.stringify(
        {
          observedAt: new Date().toISOString(),
          executable:
            process.env.OPENBUFF_TEST_MEMORY_AGENTS_EXECUTABLE ?? 'source',
          requests,
          counts,
          attack,
          homeUnchanged: process.env.HOME === home,
          files: fs.readdirSync(project),
          knowledge: fs.readFileSync(
            path.join(project, 'knowledge.md'),
            'utf8',
          ),
          authoredMutationAbsent: !fs.existsSync(
            path.join(project, 'should-not-write.txt'),
          ),
        },
        null,
        2,
      ),
    )
  }
  server.stop(true)
  fs.rmSync(root, { recursive: true, force: true })
  expect(process.env.HOME).toBe(home)
})
function client(definitions: unknown[] = [retriever, reviewer, manager]) {
  return new OpenbuffClient({
    cwd: project,
    agentDefinitions: definitions as AgentDefinition[],
    projectFiles: {},
    knowledgeFiles: {},
    userKnowledgeFiles: {},
    repositoryIntelligence: false,
    harnessStateDir: path.join(root, 'harness'),
    runTimeoutMs: 15_000,
    handleEvent() {},
    logger: silentLogger,
    hostConfiguration: {
      environment: {
        PATH: '/usr/bin:/bin',
        OPENBUFF_PROCESS_SUPERVISION: '0',
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
const prompt =
  'Review knowledge.md against current package scripts; propose changes only.'
const params = { paths: ['knowledge.md'], domains: ['knowledge-files'] }

describe('actual SDK read-only memory-management agents', () => {
  test('the manager joins actual retrieval and independent source reads without a manager model call', async () => {
    const original = fs.readFileSync(path.join(project, 'knowledge.md'))
    const result = await client().run({ agent: manager.id, prompt, params })
    expect(result.runOutcome?.termination, JSON.stringify(result.output)).toBe(
      'completed',
    )
    expect(result.output).toMatchObject({
      type: 'structuredOutput',
      value: {
        status: 'complete',
        requiresUserApproval: true,
        applied: false,
        untrustedSuggestions: true,
        retrieval,
        review,
        proposals: review.proposals,
      },
    })
    expect(counts).toEqual({
      'knowledge-retriever': 2,
      'knowledge-reviewer': 2,
    })
    expect(
      requests.some((request) =>
        JSON.stringify(request.messages).includes(
          'Coordinate retrieval then independent review',
        ),
      ),
    ).toBe(false)
    expect(fs.readFileSync(path.join(project, 'knowledge.md'))).toEqual(
      original,
    )
    expect(JSON.stringify(requests)).not.toContain(
      'SECRET_CANARY_MUST_NOT_REACH_PROVIDER',
    )
  }, 20_000)
  test('declared read-only roles refuse mutation, memory promotion, credentials and outside file reads', async () => {
    attack = true
    const original = fs.readFileSync(path.join(project, 'knowledge.md'))
    const result = await client().run({ agent: retriever.id, prompt, params })
    expect(result.runOutcome?.termination, JSON.stringify(result.output)).toBe(
      'completed',
    )
    expect(result.output).toMatchObject({
      type: 'structuredOutput',
      value: retrieval,
    })
    expect(fs.existsSync(path.join(project, 'should-not-write.txt'))).toBe(
      false,
    )
    expect(fs.readFileSync(path.join(project, 'knowledge.md'))).toEqual(
      original,
    )
    expect(JSON.stringify(requests)).not.toContain(
      'SECRET_CANARY_MUST_NOT_REACH_PROVIDER',
    )
    expect(JSON.stringify(requests)).not.toContain(
      'OUTSIDE_CANARY_MUST_NOT_REACH_PROVIDER',
    )
    expect(
      JSON.stringify(result.sessionState?.mainAgentState.taskMemory?.decisions),
    ).not.toContain('fabricated fact')
  }, 20_000)
  test('the actual source or explicitly selected built CLI can run memory-manager from the shipped catalog', async () => {
    const entry =
      process.env.OPENBUFF_TEST_MEMORY_AGENTS_EXECUTABLE ??
      path.resolve(import.meta.dir, '../../../cli/src/binary-entry.ts')
    const source = entry.endsWith('.ts')
    const schemaFile = path.join(root, 'manager-schema.json')
    const configDir = path.join(root, 'cli-config')
    fs.mkdirSync(configDir, { mode: 0o700 })
    fs.writeFileSync(schemaFile, JSON.stringify(manager.outputSchema))
    const args = [
      'run',
      '--agent',
      manager.id,
      '--json',
      '--timeout',
      '20',
      '--output-schema',
      schemaFile,
      '-p',
      prompt,
    ]
    const child = spawn(
      source ? process.execPath : entry,
      source ? ['--no-env-file', '--no-install', entry, ...args] : args,
      {
        cwd: project,
        env: {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          USER: process.env.USER,
          OPENBUFF_CONFIG_DIR: configDir,
          OPENBUFF_PROVIDER_CONFIG: config,
          OPENBUFF_PROCESS_SUPERVISION: '0',
          OPENBUFF_TELEMETRY: '0',
          DO_NOT_TRACK: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const out: Buffer[] = [],
      err: Buffer[] = []
    child.stdout.on('data', (bytes) => out.push(Buffer.from(bytes)))
    child.stderr.on('data', (bytes) => err.push(Buffer.from(bytes)))
    const timer = setTimeout(() => child.kill('SIGKILL'), 25_000)
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('close', resolve)
        child.once('error', reject)
      })
      expect(code, Buffer.concat(err).toString('utf8')).toBe(0)
      const events = Buffer.concat(out)
        .toString('utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(events.at(-1)).toMatchObject({
        type: 'result',
        output: {
          status: 'complete',
          requiresUserApproval: true,
          applied: false,
          untrustedSuggestions: true,
          proposals: review.proposals,
        },
      })
      expect(counts).toEqual({
        'knowledge-retriever': 2,
        'knowledge-reviewer': 2,
      })
      expect(JSON.stringify(requests)).not.toContain(
        'SECRET_CANARY_MUST_NOT_REACH_PROVIDER',
      )
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL')
    }
  }, 30_000)

  test('a strict manager cannot be widened by an unflagged retrieval child', async () => {
    attack = true
    const relaxedChild = {
      ...retriever,
      programmaticConfig: { strictProjectReads: false },
    }
    const result = await client([relaxedChild, reviewer, manager]).run({
      agent: manager.id,
      prompt,
      params,
    })
    expect(result.runOutcome?.termination, JSON.stringify(result.output)).toBe(
      'completed',
    )
    expect(JSON.stringify(requests)).not.toContain(
      'SECRET_CANARY_MUST_NOT_REACH_PROVIDER',
    )
    expect(JSON.stringify(requests)).not.toContain(
      'OUTSIDE_CANARY_MUST_NOT_REACH_PROVIDER',
    )
  }, 20_000)
  test('an explicit non-opt-in control retains existing unrestricted reads', async () => {
    attack = true
    const relaxed = {
      ...retriever,
      id: 'unrestricted-reader-control',
      programmaticConfig: { strictProjectReads: false },
    }
    const result = await client([relaxed]).run({
      agent: relaxed.id,
      prompt,
      params,
    })
    expect(result.runOutcome?.termination, JSON.stringify(result.output)).toBe(
      'completed',
    )
    expect(JSON.stringify(requests)).toContain(
      'SECRET_CANARY_MUST_NOT_REACH_PROVIDER',
    )
    expect(JSON.stringify(requests)).toContain(
      'OUTSIDE_CANARY_MUST_NOT_REACH_PROVIDER',
    )
  }, 20_000)

  test('a real exhausted retrieval child cannot produce a falsely complete maintenance report', async () => {
    const result = await client([
      { ...retriever, maxSteps: 1 },
      reviewer,
      manager,
    ]).run({ agent: manager.id, prompt, params })
    expect(result.runOutcome?.termination).toBe('completed')
    expect(result.output).toMatchObject({
      type: 'structuredOutput',
      value: { status: 'unavailable', applied: false, proposals: [] },
    })
    expect(counts['knowledge-reviewer']).toBeUndefined()
  }, 20_000)
  test('a real exhausted reviewer preserves retrieval and reports partial, not applied work', async () => {
    const result = await client([
      retriever,
      { ...reviewer, maxSteps: 1 },
      manager,
    ]).run({ agent: manager.id, prompt, params })
    expect(result.runOutcome?.termination).toBe('completed')
    expect(result.output).toMatchObject({
      type: 'structuredOutput',
      value: { status: 'partial', retrieval, applied: false, proposals: [] },
    })
  }, 20_000)
})
