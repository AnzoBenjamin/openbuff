import * as validationModule from '@codebuff/common/templates/agent-validation'
import { TEST_AGENT_RUNTIME_IMPL } from '@codebuff/common/testing/impl/agent-runtime'
import {
  getMCPClientCacheKey,
  markAllMCPConfigOrigins,
  originOf,
} from '@codebuff/common/mcp/client'
import { getStubProjectFileContext } from '@codebuff/common/util/file'
import {
  describe,
  expect,
  it,
  beforeEach,
  afterEach,
  spyOn,
  mock,
} from 'bun:test'

import {
  getAgentTemplate,
  assembleLocalAgentTemplates,
} from '../agent-registry'

import type { AgentTemplate } from '../types'
import type {
  AgentRuntimeDeps,
  AgentRuntimeScopedDeps,
} from '@codebuff/common/types/contracts/agent-runtime'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { DynamicAgentTemplate } from '@codebuff/common/types/dynamic-agent-template'
import type { ProjectFileContext } from '@codebuff/common/util/file'

let agentRuntimeImpl: AgentRuntimeDeps & AgentRuntimeScopedDeps

// Swappable validateAgents implementation so individual tests can simulate
// alternate loader behavior (e.g. the Zod re-parse losing object identity)
// without re-spying on the same module method.
let validateAgentsBehavior: (
  params: Parameters<typeof validationModule.validateAgents>[0],
) => ReturnType<typeof validationModule.validateAgents>

// Create mock static templates that will be used by the agent registry
const mockStaticTemplates: Record<string, AgentTemplate> = {
  base: {
    id: 'base',
    displayName: 'Base Agent',
    systemPrompt: 'Test',
    instructionsPrompt: 'Test',
    stepPrompt: 'Test',
    mcpServers: {},
    toolNames: ['end_turn'],
    spawnableAgents: [],
    outputMode: 'last_message',
    includeMessageHistory: true,
    inheritParentSystemPrompt: false,
    model: 'anthropic/claude-4-sonnet-20250522',
    spawnerPrompt: 'Test',
    inputSchema: {},
  },
  file_picker: {
    id: 'file_picker',
    displayName: 'File Picker',
    systemPrompt: 'Test',
    instructionsPrompt: 'Test',
    stepPrompt: 'Test',
    mcpServers: {},
    toolNames: ['find_files'],
    spawnableAgents: [],
    outputMode: 'last_message',
    includeMessageHistory: true,
    inheritParentSystemPrompt: false,
    model: 'google/gemini-2.5-flash',
    spawnerPrompt: 'Test',
    inputSchema: {},
  },
}

// We'll spy on the validation functions instead of mocking the entire module

describe('Agent Registry', () => {
  let mockFileContext: ProjectFileContext

  beforeEach(async () => {
    agentRuntimeImpl = {
      ...TEST_AGENT_RUNTIME_IMPL,
    }

    agentRuntimeImpl.databaseAgentCache.clear()

    mockFileContext = getStubProjectFileContext()

    // Spy on validation functions. Implementations are routed through
    // swappable holders so individual tests can simulate alternate loader
    // behavior (e.g. the Zod re-parse losing object identity) without
    // re-spying on the same module method.
    validateAgentsBehavior = ({
      agentTemplates = {},
    }: {
      agentTemplates?: Record<string, DynamicAgentTemplate>
      logger: Logger
    }) => {
      // Start with static templates (simulating the real behavior)
      const templates: Record<string, AgentTemplate> = {
        ...mockStaticTemplates,
      }
      const validationErrors: any[] = []

      for (const key in agentTemplates) {
        const template = agentTemplates[key]
        if (template.id === 'invalid-agent') {
          validationErrors.push({
            filePath: key,
            message: 'Invalid agent configuration',
          })
          // Don't add invalid agents to templates (this simulates validation failure)
        } else {
          templates[template.id] = template as AgentTemplate
        }
      }

      return { templates, dynamicTemplates: agentTemplates, validationErrors }
    }

    spyOn(validationModule, 'validateAgents').mockImplementation(
      (params) => validateAgentsBehavior(params),
    )

    spyOn(validationModule, 'validateSingleAgent').mockImplementation(
      ({ template }: { template: DynamicAgentTemplate; filePath?: string }) => {
        // Check for malformed agents (missing required fields)
        if (
          template.id === 'malformed-agent' ||
          !template.systemPrompt ||
          !template.instructionsPrompt ||
          !template.stepPrompt
        ) {
          return {
            success: false,
            error: 'Invalid agent configuration - missing required fields',
          }
        }
        return {
          success: true,
          agentTemplate: template as AgentTemplate,
        }
      },
    )
  })

  afterEach(() => {
    mock.restore()
  })

  describe('parseAgentId (tested through getAgentTemplate)', () => {
    it('should handle agent IDs without publisher (local agents)', async () => {
      const localAgents = {
        'my-agent': {
          id: 'my-agent',
          displayName: 'My Agent',
          systemPrompt: 'Test',
          instructionsPrompt: 'Test',
          stepPrompt: 'Test',
          mcpServers: {},
          toolNames: ['end_turn'],
          spawnableAgents: [],
          outputMode: 'last_message',
          includeMessageHistory: true,
          inheritParentSystemPrompt: false,
          model: 'anthropic/claude-4-sonnet-20250522',
          spawnerPrompt: 'Test',
          inputSchema: {},
        } as AgentTemplate,
      }

      const result = await getAgentTemplate({
        ...agentRuntimeImpl,
        agentId: 'my-agent',
        localAgentTemplates: localAgents,
      })
      expect(result).toBeTruthy()
      expect(result?.id).toBe('my-agent')
    })

    it('should handle agent IDs with publisher but no version', async () => {
      const result = await getAgentTemplate({
        ...agentRuntimeImpl,
        agentId: 'publisher/agent-name',
        localAgentTemplates: {},
      })
      expect(result).toBeNull()
    })

    it('should handle agent IDs with publisher and version', async () => {
      const result = await getAgentTemplate({
        ...agentRuntimeImpl,
        agentId: 'publisher/agent-name@1.0.0',
        localAgentTemplates: {},
      })
      expect(result).toBeNull()
    })

    it('should return null for invalid agent ID formats', async () => {
      const result = await getAgentTemplate({
        ...agentRuntimeImpl,
        agentId: 'invalid/format/with/too/many/slashes',
        localAgentTemplates: {},
      })
      expect(result).toBeNull()
    })
  })

  describe('fetchAgentFromDatabase', () => {
    it('should return null when agent not found in database', async () => {
      const result = await getAgentTemplate({
        ...agentRuntimeImpl,
        agentId: 'nonexistent/agent@1.0.0',
        localAgentTemplates: {},
      })
      expect(result).toBeNull()
    })

    it('should handle database query for specific version', async () => {
      const mockAgentData: AgentTemplate = {
        id: 'test-publisher/test-agent@1.0.0',
        displayName: 'Test Agent',
        systemPrompt: 'Test system prompt',
        instructionsPrompt: 'Test instructions',
        stepPrompt: 'Test step prompt',
        toolNames: ['end_turn'],
        mcpServers: {},
        inputSchema: {},
        spawnableAgents: [],
        outputMode: 'last_message',
        includeMessageHistory: true,
        inheritParentSystemPrompt: false,
        model: 'anthropic/claude-4-sonnet-20250522',
        spawnerPrompt: 'Test',
      }

      agentRuntimeImpl = {
        ...agentRuntimeImpl,
        fetchAgentFromDatabase: async () => mockAgentData,
      }

      const result = await getAgentTemplate({
        ...agentRuntimeImpl,
        agentId: 'test-publisher/test-agent@1.0.0',
        localAgentTemplates: {},
      })
      expect(result).toBeTruthy()
      expect(result?.id).toBe('test-publisher/test-agent@1.0.0')
    })
  })

  describe('getAgentTemplate priority order', () => {
    it('should prioritize local agents over database agents', async () => {
      const localAgents = {
        'test-agent': {
          id: 'test-agent',
          displayName: 'Local Test Agent',
          systemPrompt: 'Local system prompt',
          instructionsPrompt: 'Local instructions',
          stepPrompt: 'Local step prompt',
          mcpServers: {},
          toolNames: ['end_turn'],
          spawnableAgents: [],
          outputMode: 'last_message',
          includeMessageHistory: true,
          inheritParentSystemPrompt: false,
          model: 'anthropic/claude-4-sonnet-20250522',
          spawnerPrompt: 'Local test',
          inputSchema: {},
        } as AgentTemplate,
      }

      const result = await getAgentTemplate({
        ...agentRuntimeImpl,
        agentId: 'test-agent',
        localAgentTemplates: localAgents,
      })
      expect(result).toBeTruthy()
      expect(result?.displayName).toBe('Local Test Agent')
    })

    it('should use database cache when available', async () => {
      const mockAgentData: AgentTemplate = {
        id: 'test-publisher/cached-agent@1.0.0',
        displayName: 'Cached Agent',
        systemPrompt: 'Cached system prompt',
        instructionsPrompt: 'Cached instructions',
        stepPrompt: 'Cached step prompt',
        inputSchema: {},
        mcpServers: {},
        toolNames: ['end_turn'],
        spawnableAgents: [],
        outputMode: 'last_message',
        includeMessageHistory: true,
        inheritParentSystemPrompt: false,
        model: 'anthropic/claude-4-sonnet-20250522',
        spawnerPrompt: 'Cached test',
      }

      const spy = mock(async () => mockAgentData)
      agentRuntimeImpl = {
        ...agentRuntimeImpl,
        fetchAgentFromDatabase: spy,
      }

      // First call - should hit database
      const result1 = await getAgentTemplate({
        ...agentRuntimeImpl,
        agentId: 'test-publisher/cached-agent@1.0.0',
        localAgentTemplates: {},
      })
      expect(result1).toBeTruthy()
      expect(spy).toHaveBeenCalled()

      const spy2 = mock(async () => mockAgentData)
      agentRuntimeImpl = {
        ...agentRuntimeImpl,
        fetchAgentFromDatabase: spy2,
      }

      // Second call - should use cache
      const result2 = await getAgentTemplate({
        ...agentRuntimeImpl,
        agentId: 'test-publisher/cached-agent@1.0.0',
        localAgentTemplates: {},
      })
      expect(result2).toBeTruthy()
      expect(result2?.displayName).toBe('Cached Agent')
      expect(spy2).not.toHaveBeenCalled()
    })
  })

  describe('assembleLocalAgentTemplates', () => {
    it('should merge static and dynamic templates', () => {
      const fileContext: ProjectFileContext = {
        ...mockFileContext,
        agentTemplates: {
          'custom-agent.ts': {
            id: 'custom-agent',
            displayName: 'Custom Agent',
            systemPrompt: 'Custom system prompt',
            instructionsPrompt: 'Custom instructions',
            stepPrompt: 'Custom step prompt',
            toolNames: ['end_turn'],
            spawnableAgents: [],
            outputMode: 'last_message',
            includeMessageHistory: true,
            model: 'anthropic/claude-4-sonnet-20250522',
            spawnerPrompt: 'Custom test',
          },
        },
      }

      const result = assembleLocalAgentTemplates({
        ...agentRuntimeImpl,
        fileContext,
      })

      // Should have dynamic template
      expect(result.agentTemplates).toHaveProperty('custom-agent')
      expect(result.agentTemplates['custom-agent'].displayName).toBe(
        'Custom Agent',
      )

      // Should have no validation errors
      expect(result.validationErrors).toHaveLength(0)
    })

    it('should handle validation errors in dynamic templates', () => {
      const fileContext: ProjectFileContext = {
        ...mockFileContext,
        agentTemplates: {
          'invalid-agent.ts': {
            id: 'invalid-agent',
            displayName: 'Invalid Agent',
            // Missing required fields to trigger validation error
          } as Partial<DynamicAgentTemplate>, // invalid - missing required fields
        },
      }

      const result = assembleLocalAgentTemplates({
        ...agentRuntimeImpl,
        fileContext,
      })

      // Should not have invalid template
      expect(result.agentTemplates).not.toHaveProperty('invalid-agent')

      // Should have validation errors
      expect(result.validationErrors.length).toBeGreaterThan(0)
    })

    it('should handle empty agentTemplates', () => {
      const fileContext: ProjectFileContext = {
        ...mockFileContext,
        agentTemplates: {},
      }

      const result = assembleLocalAgentTemplates({
        ...agentRuntimeImpl,
        fileContext,
      })

      // Should have no validation errors
      expect(result.validationErrors).toHaveLength(0)

      // Should return some agent templates (static ones from our mock)
      expect(Object.keys(result.agentTemplates).length).toBeGreaterThan(0)
    })
  })

  describe('clearDatabaseCache', () => {
    it('should clear the database cache', async () => {
      const mockAgentData: AgentTemplate = {
        id: 'test-publisher/cache-test-agent@1.0.0',
        displayName: 'Cache Test Agent',
        systemPrompt: 'Cache test system prompt',
        instructionsPrompt: 'Cache test instructions',
        stepPrompt: 'Cache test step prompt',
        inputSchema: {},
        mcpServers: {},
        toolNames: ['end_turn'],
        spawnableAgents: [],
        outputMode: 'last_message',
        includeMessageHistory: true,
        inheritParentSystemPrompt: false,
        model: 'anthropic/claude-4-sonnet-20250522',
        spawnerPrompt: 'Cache test',
      }

      const selectSpy = mock(async () => mockAgentData)
      agentRuntimeImpl = {
        ...agentRuntimeImpl,
        fetchAgentFromDatabase: selectSpy,
      }

      // First call - should hit database and populate cache
      await getAgentTemplate({
        ...agentRuntimeImpl,
        agentId: 'test-publisher/cache-test-agent@1.0.0',
        localAgentTemplates: {},
      })
      expect(selectSpy).toHaveBeenCalledTimes(1)

      // Second call - should use cache
      await getAgentTemplate({
        ...agentRuntimeImpl,
        agentId: 'test-publisher/cache-test-agent@1.0.0',
        localAgentTemplates: {},
      })
      expect(selectSpy).toHaveBeenCalledTimes(1)

      agentRuntimeImpl.databaseAgentCache.clear()

      // Third call - should hit database again after cache clear
      await getAgentTemplate({
        ...agentRuntimeImpl,
        agentId: 'test-publisher/cache-test-agent@1.0.0',
        localAgentTemplates: {},
      })
      expect(selectSpy).toHaveBeenCalledTimes(2)
    })
  })

  describe('edge cases', () => {
    it('should handle empty agent ID', async () => {
      const result = await getAgentTemplate({
        ...agentRuntimeImpl,
        agentId: '',
        localAgentTemplates: {},
      })
      expect(result).toBeNull()
    })

    it('should handle agent ID with multiple @ symbols', async () => {
      const result = await getAgentTemplate({
        ...agentRuntimeImpl,
        agentId: 'publisher/agent@1.0.0@extra',
        localAgentTemplates: {},
      })
      expect(result).toBeNull()
    })

    it('should handle agent ID with only @ symbol', async () => {
      const result = await getAgentTemplate({
        ...agentRuntimeImpl,
        agentId: 'publisher/agent@',
        localAgentTemplates: {},
      })
      expect(result).toBeNull()
    })
  })

  describe('MCP config origin marking (NEW-1)', () => {
    const secretValue = 'super-secret-value'
    const secretMcpServers = {
      remote: {
        type: 'http' as const,
        url: 'https://mcp.example.com/rpc',
        params: {},
        headers: { 'X-Api-Key': '$TEST_SECRET' },
      },
    }

    function makeSecretDbAgent(): AgentTemplate {
      return {
        id: 'test-publisher/secret-agent@1.0.0',
        displayName: 'Secret Agent',
        systemPrompt: 'Test system prompt',
        instructionsPrompt: 'Test instructions',
        stepPrompt: 'Test step prompt',
        toolNames: ['end_turn'],
        mcpServers: secretMcpServers,
        inputSchema: {},
        spawnableAgents: [],
        outputMode: 'last_message',
        includeMessageHistory: true,
        inheritParentSystemPrompt: false,
        model: 'anthropic/claude-4-sonnet-20250522',
        spawnerPrompt: 'Test',
      }
    }

    it("marks database-fetched agent mcpServers as 'client' on the direct-fetch branch and the cached path", async () => {
      process.env.TEST_SECRET = secretValue
      try {
        const spy = mock(async () => makeSecretDbAgent())
        agentRuntimeImpl = {
          ...agentRuntimeImpl,
          fetchAgentFromDatabase: spy,
        }

        // First call: direct-fetch branch (specific version is cached).
        const result1 = await getAgentTemplate({
          ...agentRuntimeImpl,
          agentId: 'test-publisher/secret-agent@1.0.0',
          localAgentTemplates: {},
        })
        expect(result1).toBeTruthy()
        expect(spy).toHaveBeenCalledTimes(1)
        expect(originOf(result1!.mcpServers.remote)).toBe('client')

        // Second call: cached path (cache stores the same marked object).
        const result2 = await getAgentTemplate({
          ...agentRuntimeImpl,
          agentId: 'test-publisher/secret-agent@1.0.0',
          localAgentTemplates: {},
        })
        expect(result2).toBeTruthy()
        expect(spy).toHaveBeenCalledTimes(1)
        expect(originOf(result2!.mcpServers.remote)).toBe('client')
      } finally {
        delete process.env.TEST_SECRET
      }
    })

    it("marks assembled local templates' mcpServers as 'project'", () => {
      const fileContext: ProjectFileContext = {
        ...mockFileContext,
        agentTemplates: {
          'mcp-agent.ts': {
            id: 'mcp-agent',
            displayName: 'MCP Agent',
            // loadLocalAgents stamps trusted on-disk templates 'local'; the
            // registry blanket-marks 'project' only for that provenance.
            executionSource: 'local',
            systemPrompt: 'Test',
            instructionsPrompt: 'Test',
            stepPrompt: 'Test',
            toolNames: ['end_turn'],
            spawnableAgents: [],
            outputMode: 'last_message',
            includeMessageHistory: true,
            model: 'anthropic/claude-4-sonnet-20250522',
            spawnerPrompt: 'Test',
            mcpServers: {
              remote: {
                type: 'http' as const,
                url: 'https://mcp.example.com/rpc',
                params: {},
                headers: {},
              },
            },
          },
        },
      }

      const result = assembleLocalAgentTemplates({
        ...agentRuntimeImpl,
        fileContext,
      })

      expect(result.agentTemplates['mcp-agent']).toBeDefined()
      expect(originOf(result.agentTemplates['mcp-agent'].mcpServers.remote)).toBe(
        'project',
      )
    })

    it("keeps an existing 'client' mark when the trusted loader blanket-marks 'project'", () => {
      process.env.TEST_SECRET = secretValue
      try {
        // Simulate untrusted (client-supplied) agent definitions reaching
        // fileContext.agentTemplates, e.g. via the run-state overrides merge:
        // their MCP configs arrive pre-marked 'client'.
        const clientMarkedMcpServers = {
          remote: {
            type: 'http' as const,
            url: 'https://mcp.example.com/rpc',
            params: {},
            headers: { 'X-Api-Key': '$TEST_SECRET' },
          },
        }
        markAllMCPConfigOrigins(clientMarkedMcpServers, 'client')
        expect(originOf(clientMarkedMcpServers.remote)).toBe('client')

        const fileContext: ProjectFileContext = {
          ...mockFileContext,
          agentTemplates: {
            'client-marked-agent.ts': {
              id: 'client-marked-agent',
              displayName: 'Client Marked Agent',
              executionSource: 'local',
              systemPrompt: 'Test',
              instructionsPrompt: 'Test',
              stepPrompt: 'Test',
              toolNames: ['end_turn'],
              spawnableAgents: [],
              outputMode: 'last_message',
              includeMessageHistory: true,
              model: 'anthropic/claude-4-sonnet-20250522',
              spawnerPrompt: 'Test',
              mcpServers: clientMarkedMcpServers,
            },
          },
        }

        const result = assembleLocalAgentTemplates({
          ...agentRuntimeImpl,
          fileContext,
        })

        expect(result.agentTemplates['client-marked-agent']).toBeDefined()
        // The blanket 'project' mark must NOT upgrade the untrusted 'client'
        // mark: $VAR expansion stays disabled for this config.
        expect(
          originOf(
            result.agentTemplates['client-marked-agent'].mcpServers.remote,
          ),
        ).toBe('client')

        const remote = result.agentTemplates['client-marked-agent'].mcpServers.remote
        const clientKey = getMCPClientCacheKey(remote)
        expect(clientKey).toBe(
          getMCPClientCacheKey(remote, { origin: 'client' }),
        )
        expect(clientKey).not.toBe(
          getMCPClientCacheKey(remote, { origin: 'project' }),
        )
        expect(clientKey).not.toContain(secretValue)
      } finally {
        delete process.env.TEST_SECRET
      }
    })

    it("keeps an existing 'client' mark across the validation re-parse's fresh mcpServers objects", () => {
      process.env.TEST_SECRET = secretValue
      try {
        // Simulate validateSingleAgent's Zod re-parse: validated templates are
        // brand-new objects whose mcpServers configs have no WeakMap entry, so
        // the trusted 'project' blanket mark in assembleLocalAgentTemplates
        // would silently upgrade a pre-existing 'client' mark without mark
        // propagation (NEW-1 no-upgrade invariant).
        validateAgentsBehavior = ({ agentTemplates = {} }) => {
          const dynamicTemplates: Record<string, DynamicAgentTemplate> = {}
          for (const template of Object.values(agentTemplates)) {
            dynamicTemplates[template.id] = {
              ...template,
              mcpServers: JSON.parse(JSON.stringify(template.mcpServers ?? {})),
            }
          }
          return {
            templates: dynamicTemplates as Record<string, AgentTemplate>,
            dynamicTemplates,
            validationErrors: [],
          }
        }

        const clientMarkedMcpServers = {
          remote: {
            type: 'http' as const,
            url: 'https://mcp.example.com/rpc',
            params: {},
            headers: { 'X-Api-Key': '$TEST_SECRET' },
          },
        }
        markAllMCPConfigOrigins(clientMarkedMcpServers, 'client')

        const fileContext: ProjectFileContext = {
          ...mockFileContext,
          agentTemplates: {
            'client-marked-agent.ts': {
              id: 'client-marked-agent',
              displayName: 'Client Marked Agent',
              executionSource: 'local',
              systemPrompt: 'Test',
              instructionsPrompt: 'Test',
              stepPrompt: 'Test',
              toolNames: ['end_turn'],
              spawnableAgents: [],
              outputMode: 'last_message',
              includeMessageHistory: true,
              model: 'anthropic/claude-4-sonnet-20250522',
              spawnerPrompt: 'Test',
              mcpServers: clientMarkedMcpServers,
            } as unknown as DynamicAgentTemplate,
          },
        }

        const result = assembleLocalAgentTemplates({
          ...agentRuntimeImpl,
          fileContext,
        })

        const remote =
          result.agentTemplates['client-marked-agent'].mcpServers.remote
        // The 'client' mark must survive the identity-losing re-parse, and the
        // trusted 'project' blanket mark must not upgrade it: $VAR expansion
        // stays disabled for this config.
        expect(originOf(remote)).toBe('client')
        const reparseClientKey = getMCPClientCacheKey(remote)
        expect(reparseClientKey).toBe(
          getMCPClientCacheKey(remote, { origin: 'client' }),
        )
        expect(reparseClientKey).not.toBe(
          getMCPClientCacheKey(remote, { origin: 'project' }),
        )
        expect(reparseClientKey).not.toContain(secretValue)
      } finally {
        delete process.env.TEST_SECRET
      }
    })

    it("$TEST_SECRET arrives at getMCPClientCacheKey unexpanded (GV-30)", () => {
      process.env.TEST_SECRET = secretValue
      try {
        const config = secretMcpServers.remote

        // The registry marked this config 'client' (untrusted): the $VAR
        // reference must NOT be expanded from this process's environment.
        const clientKey = getMCPClientCacheKey(config)
        expect(clientKey).toBe(
          getMCPClientCacheKey(config, { origin: 'client' }),
        )
        expect(clientKey).not.toContain(secretValue)
        expect(clientKey).not.toContain('$TEST_SECRET')

        // An explicit trusted 'project' origin WOULD expand the reference,
        // producing a different identity for the same config object.
        const projectKey = getMCPClientCacheKey(config, { origin: 'project' })
        expect(projectKey).not.toBe(clientKey)
      } finally {
        delete process.env.TEST_SECRET
      }
    })

    it("re-marks a 'database'-provenance template 'client' after the serialization hop erases the fetch-time mark", () => {
      process.env.TEST_SECRET = secretValue
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
      try {
        // Simulate the full hop: the database fetch marked these configs
        // 'client' (fetchAgentFromDatabase/getAgentTemplate), then client.run's
        // cloneDeep + the session-state JSON round-trip erased the WeakMap
        // marks, and validateSingleAgent's Zod re-parse rebuilt the mcpServers
        // objects. Only the string executionSource survives the hop.
        validateAgentsBehavior = ({ agentTemplates = {} }) => {
          const dynamicTemplates: Record<string, DynamicAgentTemplate> = {}
          for (const template of Object.values(agentTemplates)) {
            dynamicTemplates[template.id] = {
              ...template,
              mcpServers: JSON.parse(JSON.stringify(template.mcpServers ?? {})),
            }
          }
          return {
            templates: dynamicTemplates as Record<string, AgentTemplate>,
            dynamicTemplates,
            validationErrors: [],
          }
        }

        const fileContext: ProjectFileContext = {
          ...mockFileContext,
          agentTemplates: {
            'db-agent.ts': {
              id: 'db-agent',
              displayName: 'DB Agent',
              systemPrompt: 'Test',
              instructionsPrompt: 'Test',
              stepPrompt: 'Test',
              toolNames: ['end_turn'],
              spawnableAgents: [],
              outputMode: 'last_message',
              includeMessageHistory: true,
              model: 'anthropic/claude-4-sonnet-20250522',
              spawnerPrompt: 'Test',
              executionSource: 'database',
              mcpServers: {
                remote: {
                  type: 'http' as const,
                  url: 'https://mcp.example.com/rpc',
                  params: {},
                  headers: { 'X-Api-Key': '$TEST_SECRET' },
                },
              },
            },
          },
        }

        const result = assembleLocalAgentTemplates({
          ...agentRuntimeImpl,
          fileContext,
        })

        const remote = result.agentTemplates['db-agent'].mcpServers.remote
        // The erased 'client' mark must be restored from provenance, never
        // upgraded to trusted 'project' (NEW-1 no-upgrade invariant).
        expect(originOf(remote)).toBe('client')
        const dbKey = getMCPClientCacheKey(remote)
        expect(dbKey).toBe(getMCPClientCacheKey(remote, { origin: 'client' }))
        expect(dbKey).not.toBe(
          getMCPClientCacheKey(remote, { origin: 'project' }),
        )
        expect(dbKey).not.toContain(secretValue)
        // The fail-closed behavior here is intentional, not a migration
        // accident: no diagnosability warning fires for a marked config.
        expect(warnSpy).not.toHaveBeenCalled()
      } finally {
        delete process.env.TEST_SECRET
      }
    })

    it('leaves unknown-provenance templates unmarked so their configs fail closed at resolve time', () => {
      process.env.TEST_SECRET = secretValue
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
      try {
        // No executionSource and no surviving origin marks (e.g. an SDK
        // caller's inline definition after the cloneDeep hop): provenance
        // cannot establish trust, so the configs must NOT be blanket-marked
        // 'project' — they stay unmarked and fail closed to 'client'.
        const fileContext: ProjectFileContext = {
          ...mockFileContext,
          agentTemplates: {
            'unknown-origin-agent.ts': {
              id: 'unknown-origin-agent',
              displayName: 'Unknown Origin Agent',
              systemPrompt: 'Test',
              instructionsPrompt: 'Test',
              stepPrompt: 'Test',
              toolNames: ['end_turn'],
              spawnableAgents: [],
              outputMode: 'last_message',
              includeMessageHistory: true,
              model: 'anthropic/claude-4-sonnet-20250522',
              spawnerPrompt: 'Test',
              mcpServers: {
                remote: {
                  type: 'http' as const,
                  url: 'https://unmarked.example.com/rpc',
                  params: {},
                  headers: { 'X-Api-Key': '$TEST_SECRET' },
                },
              },
            },
          },
        }

        const result = assembleLocalAgentTemplates({
          ...agentRuntimeImpl,
          fileContext,
        })

        const remote =
          result.agentTemplates['unknown-origin-agent'].mcpServers.remote
        expect(originOf(remote)).toBeUndefined()

        // Fail closed: the unmarked config resolves like 'client' — the $VAR
        // reference is never expanded from this process's environment.
        const unknownKey = getMCPClientCacheKey(remote)
        expect(unknownKey).toBe(
          getMCPClientCacheKey(remote, { origin: 'client' }),
        )
        expect(unknownKey).not.toContain(secretValue)
        // M-3 diagnosability: the one-time warning fires for the unmarked
        // $VAR config instead of a silent behavior change.
        expect(warnSpy).toHaveBeenCalled()
        expect(String(warnSpy.mock.calls[0][0])).toContain('X-Api-Key')
      } finally {
        delete process.env.TEST_SECRET
      }
    })
  })
})
