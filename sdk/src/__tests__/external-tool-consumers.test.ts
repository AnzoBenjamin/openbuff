import { describe, expect, test } from 'bun:test'
import { spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import z from 'zod/v4'
import { getMCPToolData } from '@codebuff/agent-runtime/mcp'
import { getToolSet } from '@codebuff/agent-runtime/tools/prompts'
import {
  executeCustomToolCall,
  type ExecuteToolCallParams,
} from '@codebuff/agent-runtime/tools/tool-executor'
import { markMCPConfigOrigin } from '@codebuff/common/mcp/client'
import { externalToolAlias } from '@codebuff/common/tools/external-tool'
import { jsonSchemaToZod } from '@codebuff/common/util/json-schema'
import { captureRootDeadline } from '@codebuff/common/util/execution-context'
import type { MediatedMcpRequest } from '@codebuff/common/mcp/request'
import type { Result } from '@codebuff/common/types/contracts/execution-context'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'
import { createHostExecutionServices, executionClock } from '../host-execution'
import { loadHostConfigSnapshot, nodeConfigReadFs } from '../host-config'
import { createRunMcpExecution } from '../services/run-mcp-execution'
import type {
  AgentDefinition,
  ToolCall,
} from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'
import type { MCPConfig } from '@codebuff/common/types/mcp'
import type { CustomToolDefinitions } from '@codebuff/common/util/file'
import { OpenbuffClient } from '../client'
import {
  getCustomToolDefinition,
  type CustomToolDefinition,
} from '../custom-tool'
import { handleToolCall } from '../run'
import { initialSessionState } from '../run-state'
import type { HarnessApprovalService } from '../services/harness-enforcement'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import { createNodeFileSystem } from '../tools/node-filesystem'

// Keep the outside fixture out of /tmp: the host explicitly permits owned-temp paths.
function filesystemFixture() {
  const base = mkdtempSync(path.join(import.meta.dir, '.external-tools-'))
  const cwd = path.join(base, 'project')
  const outside = path.join(base, 'outside')
  mkdirSync(cwd)
  mkdirSync(outside)
  writeFileSync(path.join(cwd, 'allowed.txt'), 'inside')
  writeFileSync(path.join(outside, 'secret.txt'), 'outside')
  return {
    cwd,
    outside,
    close: () => rmSync(base, { recursive: true, force: true }),
  }
}

type DispatchOptions = Partial<Pick<
  Parameters<typeof handleToolCall>[0],
  'fileFilter' | 'filesystemPolicy' | 'resolveMcpRequest' | 'approvalMode'
>>
function dispatch(
  cwd: string,
  tool: CustomToolDefinition,
  input: unknown,
  options: DispatchOptions = {},
) {
  return dispatchAction(
    cwd,
    [tool],
    {
      type: 'tool-call-request',
      requestId: 'fixture-call',
      userInputId: 'fixture-input',
      toolName: tool.toolName,
      input,
    },
    options,
  )
}

function dispatchAction(
  cwd: string,
  tools: CustomToolDefinition[],
  action: Parameters<typeof handleToolCall>[0]['action'],
  options: DispatchOptions = {},
) {
  return handleToolCall({
    action,
    overrides: {},
    customToolDefinitions: Object.fromEntries(
      tools.map((tool) => [tool.toolName, tool]),
    ),
    cwd,
    fs: createNodeFileSystem(),
    trustedJobOwner: {
      clientSessionId: 'fixture-session',
      rootRunId: 'fixture-run',
      parentRunId: 'fixture-run',
      parentAgentId: 'fixture-agent',
    },
    harnessStateDir: path.join(cwd, 'harness'),
    approvalReceiptIds: [],
    approvalMode: 'balanced',
    approvalService: {} as HarnessApprovalService,
    getWorkspaceState: () => undefined,
    setWorkspaceState: () => {},
    ...options,
  })
}

const fixtureAgent: AgentDefinition = {
  id: 'external-consumer-fixture',
  displayName: 'External consumer fixture',
  model: 'fixture-model',
  toolNames: [],
  programmaticToolNames: ['set_output'],
  outputMode: 'structured_output',
  handleSteps: function* ({ prompt }) {
    for (const call of JSON.parse(prompt ?? '[]')) yield call as ToolCall
    yield { toolName: 'set_output', input: { done: true } }
  },
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.reason}: ${result.cause}`)
  return result.value
}

/** Real registered host/action authority for the owned stdio fixture peers. */
function createMcpFixtureHost(root: string) {
  const environment = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    OPENBUFF_PROCESS_SUPERVISION: '0',
    OPENBUFF_TELEMETRY: '0',
    DO_NOT_TRACK: '1',
  }
  const captured = loadHostConfigSnapshot({
    fs: nodeConfigReadFs,
    inputs: {
      environment,
      platform: process.platform,
      invocationCwd: root,
      projectRoot: root,
      home: { kind: 'none' },
      globals: { kind: 'disabled' },
      selection: { kind: 'none' },
      trust: { ancestorConfig: false, projectReadableRoots: false },
    },
  })
  if (captured.status !== 'complete') throw new Error(captured.cause)
  const fixturePaths = [
    path.join(import.meta.dir, 'fixtures/mcp-external-tool-server.mjs'),
    path.resolve(
      import.meta.dir,
      '../../../common/src/mcp/__tests__/fixtures/mcp-catalog-server.mjs',
    ),
  ]
  // The fixture basis is rooted in this snapshot and actual immutable peer bytes.
  const currentBasis = () => {
    const hash = createHash('sha256').update(captured.snapshot.snapshotId)
    for (const filename of fixturePaths)
      hash.update(filename).update(readFileSync(filename))
    return hash.digest('hex')
  }
  const basisId = currentBasis()
  const owner = {
    clientSessionId: 'fixture-session',
    rootRunId: 'fixture-run',
    parentRunId: 'fixture-run',
    parentAgentId: 'fixture-agent',
  }
  const stop = new AbortController()
  const spawn: CodebuffSpawn = (command, argv, options) =>
    nodeSpawn(command, [...argv ?? []], options ?? {})
  const host = unwrap(createHostExecutionServices({
    snapshot: captured.snapshot,
    boundary: unwrap(captureRootDeadline({
      clock: executionClock,
      limit: { kind: 'unbounded' },
    })),
    childInheritanceEnvironment: environment,
    signal: stop.signal,
    spawn,
    // Positive tests own the peers and explicitly approve interpreter execution.
    approvalMode: 'allow-all',
    profile: {
      policy: 'full-access',
      preferredBackend: 'portable-ts',
      required: ['exact-env'],
      allowBackendFallback: false,
    },
    isCurrentBasis: correlation =>
      correlation.kind === 'action' &&
      correlation.basisId === basisId && currentBasis() === basisId &&
      Object.entries(owner).every(([key, value]) =>
        correlation.owner[key as keyof typeof owner] === value),
  }))
  const scope = unwrap(host.registerRun(owner))
  const mcp = createRunMcpExecution({
    snapshot: captured.snapshot,
    authority: host.execution,
    rootLifetime: host.rootLifetime,
    spawn,
  })
  let requestNumber = 0
  return {
    request: (config: MCPConfig) => mcp.request(
      config,
      scope,
      unwrap(scope.action({
        actionId: `fixture-mcp-${++requestNumber}`,
        attemptId: 'attempt',
        basisId,
      })),
    ),
    close: async () => {
      try { await mcp.dispose() }
      finally { stop.abort(new Error('Owned MCP fixture host disposed')) }
    },
  }
}

function mcpFixture(servers: Record<string, string[]>, existingRoot?: string) {
  const root = existingRoot ?? mkdtempSync(path.join(tmpdir(), 'openbuff-mcp-consumers-'))
  const host = createMcpFixtureHost(root)
  const configs = Object.fromEntries(
    Object.entries(servers).map(([serverName, names]) => {
      const config: MCPConfig = {
        type: 'stdio',
        command: process.execPath,
        args: [
          path.join(import.meta.dir, 'fixtures/mcp-external-tool-server.mjs'),
          JSON.stringify(names),
        ],
        env: { OPENBUFF_MCP_FIXTURE_VALUE: serverName },
      }
      markMCPConfigOrigin(config, 'project')
      return [serverName, config]
    }),
  )
  return {
    configs,
    resolve: host.request,
    request: async ({ mcpConfig }: { mcpConfig: MCPConfig }) => {
      const request = await host.request(mcpConfig)
      try { return await request.listToolCatalog() }
      finally { request.release() }
    },
    close: async () => {
      try { await host.close() }
      finally { if (!existingRoot) rmSync(root, { recursive: true, force: true }) }
    },
  }
}

async function advertisedRuntimeDispatch(params: {
  cwd: string
  customTools?: CustomToolDefinition[]
  definitions: CustomToolDefinitions
  toolNames: string[]
  mcpServers: Record<string, MCPConfig>
  mcpRequest?: (config: MCPConfig) => Promise<MediatedMcpRequest>
  alias: string
  input?: Record<string, unknown>
}) {
  const { cwd, definitions, toolNames, mcpServers, alias, input = {} } = params
  const state = await initialSessionState({
    cwd,
    projectFiles: {},
    knowledgeFiles: {},
    agentDefinitions: [fixtureAgent],
    persistentMemory: false,
  })
  const tools = await getToolSet({
    toolNames,
    additionalToolDefinitions: async () => definitions,
    agentTools: {},
    skills: {},
  })
  const output: unknown[] = []
  let discoveries = 0
  const execution = {
    toolName: alias,
    input,
    agentState: state.mainAgentState,
    agentTemplate: {
      ...state.fileContext.agentTemplates[fixtureAgent.id],
      id: fixtureAgent.id,
      toolNames,
      mcpServers,
    },
    fileContext: {
      ...state.fileContext,
      customToolDefinitions: Object.fromEntries(
        (params.customTools ?? []).map((tool) => [
          externalToolAlias({ kind: 'custom', toolName: tool.toolName }),
          {
            identity: { kind: 'custom', toolName: tool.toolName },
            inputSchema: { type: 'object' },
            endsAgentStep: true,
          },
        ]),
      ),
    },
    tools,
    previousToolCallFinished: Promise.resolve(),
    signal: new AbortController().signal,
    userInputId: 'fixture-input',
    toolCallId: 'fixture-call',
    toolCalls: [],
    toolCallsToAddToMessageHistory: [],
    toolResults: [],
    toolResultsToAddToMessageHistory: [],
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    onResponseChunk: (event: unknown) => {
      output.push(event)
    },
    requestMcpToolData: async () => {
      discoveries++
      throw new Error('Execution must retain the advertised catalog')
    },
    requestToolCall: async (
      request: Parameters<ExecuteToolCallParams['requestToolCall']>[0],
    ) =>
      dispatchAction(
        cwd,
        params.customTools ?? [],
        {
          ...request,
          type: 'tool-call-request',
          requestId: 'fixture-call',
        },
        params.mcpRequest ? {
          resolveMcpRequest: params.mcpRequest,
          approvalMode: 'allow-all',
        } : {},
      ),
  } as unknown as ExecuteToolCallParams<string>
  await executeCustomToolCall(execution)
  expect(discoveries).toBe(0)
  return { output, results: execution.toolResults, tools }
}

describe('SDK custom input and filesystem consumers', () => {
  test('full SDK dispatch preserves nested and transform-created step-named handler data', async () => {
    const fixture = filesystemFixture()
    const received: unknown[] = []
    const tool = getCustomToolDefinition({
      toolName: 'nested_step_data',
      description: 'Step-named fields are ordinary nested and transformed data',
      inputSchema: z
        .object({ payload: z.object({ cb_easp: z.boolean() }) })
        .transform((input) => ({ ...input, cb_easp: 'created-by-host' })),
      execute: (input) => {
        received.push(input)
        return [{ type: 'json', value: input }]
      },
    })
    try {
      const client = new OpenbuffClient({
        cwd: fixture.cwd,
        harnessStateDir: path.join(fixture.cwd, 'harness'),
        projectFiles: {},
        knowledgeFiles: {},
        handleEvent: () => {},
        customToolDefinitions: [tool],
      })
      const result = await client.run({
        agent: { ...fixtureAgent, toolNames: [tool.toolName] },
        prompt: JSON.stringify([
          { toolName: tool.toolName, input: { payload: { cb_easp: true } } },
        ]),
      })
      if (result.output.type === 'error') throw new Error(result.output.message)
      expect(received).toEqual([
        { payload: { cb_easp: true }, cb_easp: 'created-by-host' },
      ])
    } finally {
      fixture.close()
    }
  })

  test('ordinary routes, regexes and separator strings have no filesystem authority', async () => {
    const fixture = filesystemFixture()
    try {
      let received: unknown
      const input = {
        route: '/api/v1',
        regex: '^../(a|b)\\w+$',
        separator: '../../',
        windows: 'C:\\data\\thing',
      }
      const tool = getCustomToolDefinition({
        toolName: 'ordinary_strings',
        description: 'fixture',
        inputSchema: z.object({
          route: z.string(),
          regex: z.string(),
          separator: z.string(),
          windows: z.string(),
        }),
        execute: (value) => {
          received = value
          return [{ type: 'json', value }]
        },
      })
      const result = await dispatch(fixture.cwd, tool, input, {
        fileFilter: () => ({ status: 'blocked' }),
      })
      expect(received).toEqual(input)
      expect(result.output).toEqual([{ type: 'json', value: input }])
    } finally {
      fixture.close()
    }
  })

  test('full serialized programmatic dispatch runs original defaults, transforms and async validation once', async () => {
    const fixture = filesystemFixture()
    try {
      let transforms = 0
      let validations = 0
      const received: unknown[] = []
      const tool = getCustomToolDefinition({
        toolName: 'my__custom',
        description: 'fixture',
        inputSchema: z.object({
          count: z
            .string()
            .default('3')
            .transform((value) => {
              transforms++
              return Number(value)
            }),
          name: z
            .string()
            .trim()
            .refine(async (value) => {
              validations++
              await Promise.resolve()
              return value === 'Alice'
            }),
        }),
        execute: (value) => {
          received.push(value)
          return [{ type: 'json', value }]
        },
      })
      const client = new OpenbuffClient({
        cwd: fixture.cwd,
        harnessStateDir: path.join(fixture.cwd, 'harness'),
        projectFiles: {},
        knowledgeFiles: {},
        handleEvent: () => {},
        customToolDefinitions: [tool],
      })
      const result = await client.run({
        agent: { ...fixtureAgent, toolNames: [tool.toolName] },
        prompt: JSON.stringify([
          { toolName: tool.toolName, input: { name: '  Alice  ' } },
        ]),
      })
      if (result.output.type === 'error') throw new Error(result.output.message)
      expect(result.output).not.toMatchObject({ type: 'error' })
      expect(received).toEqual([{ count: 3, name: 'Alice' }])
      expect(transforms).toBe(1)
      expect(validations).toBe(1)
      const rejected = await dispatch(fixture.cwd, tool, { name: 'other' })
      expect(rejected.output[0]).toMatchObject({
        type: 'json',
        value: { errorMessage: expect.stringContaining('Invalid parameters') },
      })
      expect(received).toHaveLength(1)
      expect(transforms).toBe(2)
      expect(validations).toBe(2)
    } finally {
      fixture.close()
    }
  })

  test('the original host schema accepts astral lengths and decimal multiples through full dispatch', async () => {
    const fixture = filesystemFixture()
    const received: unknown[] = []
    const tool = getCustomToolDefinition({
      toolName: 'original_numeric_unicode',
      description: 'Original Zod input fixture',
      inputSchema: z.object({
        text: z.string().min(2),
        value: z.number().multipleOf(0.1),
        caseFold: z.string().regex(/^foo$/i),
        unicode: z.string().regex(/^\p{Letter}+$/u),
        trimmed: z.string().trim().max(3).regex(/^foo$/),
        coerced: z.coerce.number().multipleOf(0.1),
      }),
      execute: (input) => {
        received.push(input)
        return [{ type: 'json', value: input }]
      },
    })
    try {
      const client = new OpenbuffClient({
        cwd: fixture.cwd,
        harnessStateDir: path.join(fixture.cwd, 'harness'),
        projectFiles: {},
        knowledgeFiles: {},
        handleEvent: () => {},
        customToolDefinitions: [tool],
      })
      const valid = {
        text: '😀',
        value: 0.3,
        caseFold: 'FOO',
        unicode: 'é',
        trimmed: '   foo   ',
        coerced: '0.3',
      }
      const normalized = { ...valid, trimmed: 'foo', coerced: 0.3 }
      const result = await client.run({
        agent: { ...fixtureAgent, toolNames: [tool.toolName] },
        prompt: JSON.stringify([{ toolName: tool.toolName, input: valid }]),
      })
      expect(result.output.type).toBe('structuredOutput')
      expect(received).toEqual([normalized])
      const definitions = result.sessionState!.fileContext.customToolDefinitions
      const advertised = await getToolSet({
        toolNames: [],
        additionalToolDefinitions: async () => definitions,
        agentTools: {},
        skills: {},
      })
      expect(
        jsonSchemaToZod(
          (advertised[tool.toolName].inputSchema as { jsonSchema: unknown })
            .jsonSchema,
        ).safeParse(valid).success,
      ).toBe(true)
      for (const input of [
        { ...valid, text: 'a' },
        { ...valid, value: 0.35 },
      ]) {
        const rejected = await dispatch(fixture.cwd, tool, input)
        expect(rejected.output[0]).toMatchObject({
          type: 'json',
          value: {
            errorMessage: expect.stringContaining('Invalid parameters'),
          },
        })
      }
      expect(received).toEqual([normalized])
    } finally {
      fixture.close()
    }
  })

  test('declared paths are selected after transforms and preserve parsed handler input', async () => {
    const fixture = filesystemFixture()
    try {
      let received: unknown
      const tool = getCustomToolDefinition({
        toolName: 'transformed_path',
        description: 'fixture',
        inputSchema: z.object({
          path: z.string().transform(() => 'allowed.txt'),
        }),
        pathParameters: [{ pointer: '/path', access: 'read' }],
        execute: (value) => {
          received = value
          return [{ type: 'json', value }]
        },
      })
      await dispatch(fixture.cwd, tool, {
        path: path.join(fixture.outside, 'secret.txt'),
      })
      expect(received).toEqual({ path: 'allowed.txt' })
    } finally {
      fixture.close()
    }
  })

  test('cooperating handlers receive canonical authorized targets for actual reads and writes', async () => {
    const fixture = filesystemFixture()
    try {
      symlinkSync('allowed.txt', path.join(fixture.cwd, 'internal-link'))
      let received: unknown
      let authorized: unknown
      const tool = getCustomToolDefinition({
        toolName: 'canonical_targets',
        description: 'fixture',
        inputSchema: z.object({
          readPath: z.string().trim(),
          writePath: z.string().trim(),
        }),
        pathParameters: [
          { pointer: '/readPath', access: 'read' },
          { pointer: '/writePath', access: 'write' },
        ],
        execute: (input, context) => {
          received = input
          authorized = context?.authorizedPaths
          const read = context?.authorizedPaths?.find(
            (target) => target.access === 'read',
          )
          const write = context?.authorizedPaths?.find(
            (target) => target.access === 'write',
          )
          if (!read || !write)
            throw new Error('Canonical authorized targets were not supplied')
          writeFileSync(write.path, readFileSync(read.path, 'utf8'))
          return [{ type: 'json', value: { copied: true } }]
        },
      })
      const result = await dispatch(fixture.cwd, tool, {
        readPath: ' internal-link ',
        writePath: ' copied.txt ',
      })
      expect(result.output).toEqual([{ type: 'json', value: { copied: true } }])
      expect(received).toEqual({
        readPath: 'internal-link',
        writePath: 'copied.txt',
      })
      expect(authorized).toEqual([
        {
          inputPath: 'internal-link',
          path: path.join(fixture.cwd, 'allowed.txt'),
          access: 'read',
        },
        {
          inputPath: 'copied.txt',
          path: path.join(fixture.cwd, 'copied.txt'),
          access: 'write',
        },
      ])
      expect(readFileSync(path.join(fixture.cwd, 'copied.txt'), 'utf8')).toBe(
        'inside',
      )
    } finally {
      fixture.close()
    }
  })

  for (const access of ['read', 'write'] as const) {
    test(`${access} rejects transformed outside, traversal, final symlink and ancestor symlink targets`, async () => {
      const fixture = filesystemFixture()
      try {
        const secret = path.join(fixture.outside, 'secret.txt')
        symlinkSync(secret, path.join(fixture.cwd, 'escaped-file'))
        symlinkSync(fixture.outside, path.join(fixture.cwd, 'escaped-dir'))
        let calls = 0
        let selected = ''
        const tool = getCustomToolDefinition({
          toolName: `outside_${access}`,
          description: 'fixture',
          inputSchema: z.object({ path: z.string().transform(() => selected) }),
          pathParameters: [{ pointer: '/path', access }],
          execute: () => {
            calls++
            return [{ type: 'json', value: { ok: true } }]
          },
        })
        for (const target of [
          secret,
          '../outside/secret.txt',
          'escaped-file',
          'escaped-dir/secret.txt',
          'escaped-dir/new/leaf.txt',
        ]) {
          selected = target
          const result = await dispatch(fixture.cwd, tool, {
            path: 'allowed.txt',
          })
          expect(result.output[0]).toMatchObject({
            type: 'json',
            value: { permissionDenied: true },
          })
        }
        expect(calls).toBe(0)
        expect(readFileSync(secret, 'utf8')).toBe('outside')
      } finally {
        fixture.close()
      }
    })

    for (const gate of ['fileFilter', 'filesystemPolicy'] as const) {
      test(`${access} honors deny-all ${gate} on transformed declared paths`, async () => {
        const fixture = filesystemFixture()
        try {
          let calls = 0
          const checked: unknown[] = []
          const tool = getCustomToolDefinition({
            toolName: `${access}_${gate}`,
            description: 'fixture',
            inputSchema: z.object({
              path: z.string().transform(() => 'allowed.txt'),
            }),
            pathParameters: [{ pointer: '/path', access }],
            execute: () => {
              calls++
              return [{ type: 'json', value: {} }]
            },
          })
          const options: DispatchOptions =
            gate === 'fileFilter'
              ? {
                  fileFilter: (value) => {
                    checked.push(value)
                    return { status: 'blocked' }
                  },
                }
              : {
                  filesystemPolicy: {
                    name: 'deny-fixture',
                    evaluate: (value) => {
                      checked.push(value)
                      return { allowed: false, code: 'fixture_denied' }
                    },
                  },
                }
          const result = await dispatch(
            fixture.cwd,
            tool,
            { path: 'untransformed.txt' },
            options,
          )
          expect(result.output[0]).toMatchObject({
            type: 'json',
            value: { permissionDenied: true },
          })
          expect(calls).toBe(0)
          expect(checked.length).toBeGreaterThan(0)
          expect(JSON.stringify(checked)).toContain('allowed.txt')
          expect(JSON.stringify(checked)).not.toContain('untransformed.txt')
        } finally {
          fixture.close()
        }
      })
    }
  }
})

describe('SDK external tool registration and advertised identities', () => {
  test('SDK publication refuses original reserved root declarations before advisory normalization', async () => {
    const fixture = filesystemFixture()
    let called = 0
    const reserved = {
      type: 'object',
      properties: { cb_easp: { type: 'boolean' } },
    }
    try {
      for (const inputSchema of [
        z.object({ cb_easp: z.boolean() }),
        z.object({ cb_easp: z.boolean().optional() }),
        z.intersection(
          z.object({ value: z.string() }),
          z.object({ cb_easp: z.boolean().optional() }),
        ),
        z.object({ cb_easp: z.boolean() }).overwrite((input) => input),
        jsonSchemaToZod({ type: 'object', required: ['cb_easp'] }),
        jsonSchemaToZod({
          type: 'object',
          patternProperties: { '^cb_easp$': { type: 'boolean' } },
        }),
        jsonSchemaToZod({
          type: 'object',
          definitions: { input: reserved },
          allOf: [{ $ref: '#/definitions/input' }],
        }),
      ]) {
        const tool = getCustomToolDefinition({
          toolName: 'reserved_step_input',
          description: 'Reserved input fixture',
          inputSchema,
          execute: () => {
            called++
            return []
          },
        })
        await expect(
          initialSessionState({
            cwd: fixture.cwd,
            projectFiles: {},
            knowledgeFiles: {},
            agentDefinitions: [fixtureAgent],
            persistentMemory: false,
            customToolDefinitions: [tool],
          }),
        ).rejects.toThrow('reserved tool input field cb_easp')
      }
      expect(called).toBe(0)
    } finally {
      fixture.close()
    }
  })

  test('real MCP SDK discovery refuses reserved input declarations and retains nested/output data plus healthy siblings', async () => {
    const fixture = filesystemFixture()
    const host = createMcpFixtureHost(fixture.cwd)
    const events: PrintModeEvent[] = []
    const mcpServers = Object.fromEntries(
      ['reserved', 'healthy'].map((name) => {
        const config: MCPConfig = {
          type: 'stdio',
          command: process.execPath,
          args: [
            '--no-env-file',
            path.resolve(
              import.meta.dir,
              '../../../common/src/mcp/__tests__/fixtures/mcp-catalog-server.mjs',
            ),
            name === 'reserved' ? 'reserved-step' : 'paged',
          ],
          env: { OPENBUFF_CATALOG_FIXTURE_ID: `step-${name}` },
        }
        markMCPConfigOrigin(config, 'project')
        return [name, config]
      }),
    )
    try {
      const catalogs = {} as NonNullable<
        Parameters<typeof getMCPToolData>[0]['writeCatalogTo']
      >
      const definitions = await getMCPToolData({
        toolNames: [],
        mcpServers,
        writeCatalogTo: catalogs,
        requestMcpToolData: async ({ mcpConfig }) => {
          const request = await host.request(mcpConfig)
          try { return await request.listToolCatalog() }
          finally { request.release() }
        },
      })
      expect(Object.keys(definitions).sort()).toEqual([
        'healthy__first',
        'healthy__last',
        'reserved__nested',
      ])
      expect(catalogs['["","reserved"]'].complete).toBe(false)
      expect(catalogs['["","reserved"]'].incompleteReasons).toHaveLength(6)
      expect(
        catalogs['["","reserved"]'].incompleteReasons.every((reason) =>
          reason.includes('reserved tool input field cb_easp'),
        ),
      ).toBe(true)
      expect(catalogs['["","healthy"]'].complete).toBe(true)
      const tools = await getToolSet({
        toolNames: [],
        additionalToolDefinitions: async () => definitions,
        agentTools: {},
        skills: {},
      })
      expect(Object.keys(tools).sort()).toEqual(Object.keys(definitions).sort())
      const client = new OpenbuffClient({
        cwd: fixture.cwd,
        approvalMode: 'allow-all',
        harnessStateDir: path.join(fixture.cwd, 'harness'),
        projectFiles: {},
        knowledgeFiles: {},
        handleEvent: (event) => {
          events.push(event)
        },
      })
      const result = await client.run({
        agent: {
          ...fixtureAgent,
          mcpServers,
          programmaticToolNames: ['set_output', 'reserved__nested'],
        },
        prompt: JSON.stringify([
          {
            toolName: 'reserved__nested',
            input: { payload: { cb_easp: true } },
          },
        ]),
      })
      if (result.output.type === 'error') throw new Error(result.output.message)
      expect(
        events.filter(
          (event) =>
            event.type === 'tool_result' &&
            event.toolName === 'reserved__nested',
        ),
      ).toMatchObject([
        {
          output: [
            {
              type: 'json',
              value: {
                structuredContent: { cb_easp: true },
                kind: 'mcp_tool_result',
              },
            },
          ],
        },
      ])
    } finally {
      await host.close()
      fixture.close()
    }
  })

  test('registration refuses scalar-root schemas outside the tool-call object contract', async () => {
    const fixture = filesystemFixture()
    try {
      for (const inputSchema of [
        z.string(),
        z.number(),
        z.boolean(),
        z.null(),
        z.array(z.string()),
        z.unknown(),
      ]) {
        const tool = getCustomToolDefinition({
          toolName: 'unsupported_root',
          description: 'Unsupported root fixture',
          inputSchema,
          execute: () => [],
        })
        await expect(
          initialSessionState({
            cwd: fixture.cwd,
            projectFiles: {},
            knowledgeFiles: {},
            agentDefinitions: [fixtureAgent],
            persistentMemory: false,
            customToolDefinitions: [tool],
          }),
        ).rejects.toThrow('object-root input schema')
      }
    } finally {
      fixture.close()
    }
  })

  test('initialSessionState rejects duplicate custom identities and native names', async () => {
    const fixture = filesystemFixture()
    try {
      const tool = getCustomToolDefinition({
        toolName: 'duplicate_fixture',
        description: 'fixture',
        inputSchema: z.object({}),
        execute: () => [],
      })
      const options = {
        cwd: fixture.cwd,
        projectFiles: {},
        knowledgeFiles: {},
        agentDefinitions: [fixtureAgent],
        persistentMemory: false,
      }
      await expect(
        initialSessionState({
          ...options,
          customToolDefinitions: [tool, tool],
        }),
      ).rejects.toThrow('Duplicate custom tool identity or alias')
      await expect(
        initialSessionState({
          ...options,
          customToolDefinitions: [{ ...tool, toolName: 'read_files' }],
        }),
      ).rejects.toThrow('conflicts with built-in tool')
    } finally {
      fixture.close()
    }
  })

  test('full runtime dispatch reaches canonical custom handlers for separators, Unicode, long and prototype names', async () => {
    const fixture = filesystemFixture()
    try {
      const names = [
        'my__custom',
        'λ工具',
        'x'.repeat(100),
        '__proto__',
        'constructor',
        'prototype',
      ]
      const received: unknown[] = []
      const tools = names.map((toolName) =>
        getCustomToolDefinition({
          toolName,
          description: 'fixture',
          inputSchema: z.object({ index: z.number() }),
          execute: (input) => {
            received.push({ toolName, input })
            return [{ type: 'json', value: { toolName, input } }]
          },
        }),
      )
      const state = await initialSessionState({
        cwd: fixture.cwd,
        projectFiles: {},
        knowledgeFiles: {},
        agentDefinitions: [fixtureAgent],
        customToolDefinitions: tools,
        persistentMemory: false,
      })
      const definitions = state.fileContext.customToolDefinitions!
      const advertised = await getToolSet({
        toolNames: names,
        additionalToolDefinitions: async () => definitions,
        agentTools: {},
        skills: {},
      })
      const aliases = Object.keys(advertised)
      expect(new Set(aliases).size).toBe(names.length)
      expect(aliases).toContain('my__custom')
      expect(aliases.every((name) => /^[A-Za-z0-9_-]{1,64}$/.test(name))).toBe(
        true,
      )
      const calls = names.map((toolName, index) => ({
        toolName: Object.entries(definitions).find(
          ([, definition]) => definition.identity?.toolName === toolName,
        )![0],
        input: { index },
      }))
      const client = new OpenbuffClient({
        cwd: fixture.cwd,
        harnessStateDir: path.join(fixture.cwd, 'harness'),
        projectFiles: {},
        knowledgeFiles: {},
        handleEvent: () => {},
        customToolDefinitions: tools,
      })
      const result = await client.run({
        agent: {
          ...fixtureAgent,
          toolNames: names,
        },
        prompt: JSON.stringify(calls),
      })
      if (result.output.type === 'error') throw new Error(result.output.message)
      expect(result.output.type).not.toBe('error')
      expect(received).toEqual(
        names.map((toolName, index) => ({ toolName, input: { index } })),
      )
      received.length = 0
      for (const [index, call] of calls.entries()) {
        const modelResult = await advertisedRuntimeDispatch({
          cwd: fixture.cwd,
          customTools: tools,
          definitions,
          toolNames: names,
          mcpServers: {},
          alias: call.toolName,
          input: { index },
        })
        expect(modelResult.results[0].content[0]).toMatchObject({
          type: 'json',
          value: { toolName: names[index], input: { index } },
        })
      }
      expect(received).toEqual(
        names.map((toolName, index) => ({ toolName, input: { index } })),
      )
    } finally {
      fixture.close()
    }
  })

  test('real MCP catalogs and advertised aliases dispatch ambiguous tuples to distinct canonical servers', async () => {
    const fixture = filesystemFixture()
    const mcp = mcpFixture({
      a__b: ['c'],
      a: ['b__c'],
      unicode: ['工具'],
      long: ['x'.repeat(100)],
      prototype: ['__proto__'],
    }, fixture.cwd)
    try {
      const definitions = await getMCPToolData({
        toolNames: [],
        mcpServers: mcp.configs,
        requestMcpToolData: mcp.request,
      })
      expect(Object.keys(definitions)).toHaveLength(5)
      const aliases = Object.keys(definitions)
      expect(new Set(aliases).size).toBe(5)
      expect(
        aliases.every((alias) => /^[A-Za-z0-9_-]{1,64}$/.test(alias)),
      ).toBe(true)
      for (const [alias, descriptor] of Object.entries(definitions)) {
        const identity = descriptor.identity!
        if (identity.kind !== 'mcp')
          throw new Error('Fixture lost MCP identity')
        const result = await advertisedRuntimeDispatch({
          cwd: fixture.cwd,
          definitions,
          toolNames: [],
          mcpServers: mcp.configs,
          mcpRequest: mcp.resolve,
          alias,
          input: { route: '/api/v1', separator: '../' },
        })
        expect(result.results).toHaveLength(1)
        expect(result.results[0].content[0]).toMatchObject({
          type: 'json',
          value: {
            kind: 'mcp_tool_result',
            structuredContent: {
              canonicalName: identity.toolName,
              arguments: { route: '/api/v1', separator: '../' },
              fixtureEnv: identity.serverName,
            },
          },
        })
      }
    } finally {
      await mcp.close()
      fixture.close()
    }
  }, 20_000)

  test('alias-only MCP selection publishes the selected tool and excludes sibling tools', async () => {
    const mcp = mcpFixture({ restricted: ['chosen', 'sibling'] })
    try {
      const definitions = await getMCPToolData({
        toolNames: ['restricted__chosen'],
        mcpServers: mcp.configs,
        requestMcpToolData: mcp.request,
      })
      const provider = await getToolSet({
        toolNames: ['restricted__chosen'],
        additionalToolDefinitions: async () => definitions,
        agentTools: {},
        skills: {},
      })
      expect(Object.keys(provider)).toEqual(['restricted__chosen'])
      expect(Object.keys(definitions)).toEqual(['restricted__chosen'])
    } finally {
      await mcp.close()
    }
  })

  test('encoded MCP selection restricts its server while unrelated server tools remain callable', async () => {
    const fixture = filesystemFixture()
    const mcp = mcpFixture({
      weird__server: ['chosen', 'sibling'],
      healthy: ['one', 'two'],
    }, fixture.cwd)
    try {
      const chosenAlias = externalToolAlias({
        kind: 'mcp',
        serverName: 'weird__server',
        toolName: 'chosen',
      })
      const siblingAlias = externalToolAlias({
        kind: 'mcp',
        serverName: 'weird__server',
        toolName: 'sibling',
      })
      expect(chosenAlias).toStartWith('openbuff_ext_mcp_')
      const toolNames = [chosenAlias]
      const definitions = await getMCPToolData({
        toolNames,
        mcpServers: mcp.configs,
        requestMcpToolData: mcp.request,
      })
      const expected = [
        { alias: chosenAlias, serverName: 'weird__server', toolName: 'chosen' },
        { alias: 'healthy__one', serverName: 'healthy', toolName: 'one' },
        { alias: 'healthy__two', serverName: 'healthy', toolName: 'two' },
      ]
      const expectedAliases = expected.map(({ alias }) => alias).sort()
      expect(Object.keys(definitions).sort()).toEqual(expectedAliases)
      expect(Object.hasOwn(definitions, siblingAlias)).toBe(false)
      for (const { alias, serverName, toolName } of expected) {
        expect(definitions[alias].identity).toMatchObject({
          kind: 'mcp',
          serverName,
          toolName,
        })
        const result = await advertisedRuntimeDispatch({
          cwd: fixture.cwd,
          definitions,
          toolNames,
          mcpServers: mcp.configs,
          mcpRequest: mcp.resolve,
          alias,
          input: { selectedAlias: chosenAlias },
        })
        expect(Object.keys(result.tools).sort()).toEqual(expectedAliases)
        expect(result.results).toHaveLength(1)
        expect(result.results[0].content[0]).toMatchObject({
          type: 'json',
          value: {
            kind: 'mcp_tool_result',
            structuredContent: {
              canonicalName: toolName,
              arguments: { selectedAlias: chosenAlias },
              fixtureEnv: serverName,
            },
          },
        })
      }
    } finally {
      await mcp.close()
      fixture.close()
    }
  })

  test('MCP and allowed custom alias conflicts retain distinct canonical handlers', async () => {
    const fixture = filesystemFixture()
    const mcp = mcpFixture({ conflict: ['echo'] }, fixture.cwd)
    try {
      const received: unknown[] = []
      const custom = getCustomToolDefinition({
        toolName: 'conflict__echo',
        description: 'fixture',
        inputSchema: z.object({ source: z.string() }),
        execute: (input) => {
          received.push(input)
          return [{ type: 'json', value: { custom: true } }]
        },
      })
      const state = await initialSessionState({
        cwd: fixture.cwd,
        projectFiles: {},
        knowledgeFiles: {},
        agentDefinitions: [fixtureAgent],
        customToolDefinitions: [custom],
        persistentMemory: false,
      })
      const toolNames = ['conflict__echo', 'conflict/echo']
      const definitions = await getMCPToolData({
        toolNames,
        mcpServers: mcp.configs,
        writeTo: state.fileContext.customToolDefinitions,
        requestMcpToolData: mcp.request,
      })
      expect(Object.keys(definitions)).toHaveLength(2)
      for (const [alias, descriptor] of Object.entries(definitions)) {
        const result = await advertisedRuntimeDispatch({
          cwd: fixture.cwd,
          customTools: [custom],
          definitions,
          toolNames,
          mcpServers: mcp.configs,
          mcpRequest: mcp.resolve,
          alias,
          input: { source: alias },
        })
        expect(result.results).toHaveLength(1)
        if (descriptor.identity?.kind === 'custom')
          expect(result.results[0].content[0]).toMatchObject({
            type: 'json',
            value: { custom: true },
          })
        else
          expect(result.results[0].content[0]).toMatchObject({
            type: 'json',
            value: {
              structuredContent: {
                canonicalName: 'echo',
                fixtureEnv: 'conflict',
              },
            },
          })
      }
      expect(received).toEqual([{ source: 'conflict__echo' }])
    } finally {
      await mcp.close()
      fixture.close()
    }
  })

  test('unallowed custom collision cannot redirect the MCP descriptor advertised to the model', async () => {
    const fixture = filesystemFixture()
    const mcp = mcpFixture({ selected: ['echo'] }, fixture.cwd)
    try {
      let customCalls = 0
      const custom = getCustomToolDefinition({
        toolName: 'selected__echo',
        description: 'unallowed custom fixture',
        inputSchema: z.object({}),
        execute: () => {
          customCalls++
          return []
        },
      })
      const toolNames = ['selected/echo']
      const state = await initialSessionState({
        cwd: fixture.cwd,
        projectFiles: {},
        knowledgeFiles: {},
        agentDefinitions: [fixtureAgent],
        customToolDefinitions: [custom],
        persistentMemory: false,
      })
      // Hidden custom tools reserve their namespace without being published.
      const definitions = await getMCPToolData({
        toolNames,
        mcpServers: mcp.configs,
        reservedAliases: Object.keys(state.fileContext.customToolDefinitions!),
        writeTo: Object.create(null),
        requestMcpToolData: mcp.request,
      })
      const alias = externalToolAlias(
        { kind: 'mcp', serverName: 'selected', toolName: 'echo' },
        true,
      )
      expect(Object.keys(definitions)).toEqual([alias])
      expect(definitions).not.toHaveProperty(custom.toolName)
      const result = await advertisedRuntimeDispatch({
        cwd: fixture.cwd,
        customTools: [custom],
        definitions,
        toolNames,
        mcpServers: mcp.configs,
        mcpRequest: mcp.resolve,
        alias,
      })
      expect(customCalls).toBe(0)
      expect(result.results[0].content[0]).toMatchObject({
        type: 'json',
        value: {
          structuredContent: { canonicalName: 'echo', fixtureEnv: 'selected' },
        },
      })
    } finally {
      await mcp.close()
      fixture.close()
    }
  })
})
