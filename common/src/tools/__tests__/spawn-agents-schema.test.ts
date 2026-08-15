import { describe, expect, it } from 'bun:test'

import {
  buildSpawnAgentsProviderInputSchema,
  spawnAgentsParams,
} from '../params/tool/spawn-agents'

describe('spawn_agents handoff schema', () => {
  it('accepts string context for model-generated handoffs', () => {
    const result = spawnAgentsParams.inputSchema.safeParse({
      agents: [
        {
          agent_type: 'editor',
          prompt: 'Implement the requested change.',
          handoff: { context: 'Use the existing dashboard patterns.' },
        },
      ],
    })

    expect(result.success).toBe(true)
  })

  it('accepts compact file evidence with freshness metadata', () => {
    const result = spawnAgentsParams.inputSchema.safeParse({
      agents: [
        {
          agent_type: 'editor',
          handoff: {
            schemaVersion: 1,
            taskId: 'T1',
            role: 'editor',
            objective: 'Update the runtime safely.',
            requirements: [],
            acceptanceCriteria: [],
            context: [
              {
                path: 'src/runtime.ts',
                symbols: ['run'],
                reason: 'Primary implementation path',
                confidence: 'confirmed',
                freshnessHash: 'sha256:abc',
              },
            ],
            nonGoals: [],
            findings: [],
            permissions: {
              readablePaths: ['src/runtime.ts'],
              writablePaths: ['src/runtime.ts'],
              allowedTools: ['read_files', 'str_replace'],
            },
          },
        },
      ],
    })

    expect(result.success).toBe(true)
  })

  it('repairs double-stringified lists and stringified agent entries', () => {
    const entry = {
      agent_type: 'code-searcher',
      params: {
        searchQueries: [{ pattern: 'authenticate', flags: ['-g', '*.ts'] }],
      },
    }
    for (const agents of [
      JSON.stringify(JSON.stringify([entry])),
      [JSON.stringify(entry)],
    ]) {
      const result = spawnAgentsParams.inputSchema.safeParse({ agents })
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.agents).toEqual([entry])
    }
  })

  it('repairs a JSON-stringified agent-specific array inside params', () => {
    const result = spawnAgentsParams.inputSchema.safeParse({
      agents: [
        {
          agent_type: 'code-searcher',
          params: {
            searchQueries: JSON.stringify([
              { pattern: 'Helmet', flags: "-g '*.tsx'" },
            ]),
          },
        },
      ],
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.agents[0]?.params?.searchQueries).toEqual([
        { pattern: 'Helmet', flags: "-g '*.tsx'" },
      ])
    }
  })

  it('repairs a provider-tagged Basher command into params.command', () => {
    const command =
      'ls -la /tmp/garden-rose-evidence/ 2>/dev/null; echo "---"; ls -la assets/garden/'
    const result = spawnAgentsParams.inputSchema.safeParse({
      agents: [
        {
          agent_type: 'basher',
          params: `command</arg_key><arg_value>${command}`,
        },
      ],
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.agents[0]?.params).toEqual({ command })
    }
  })
})

describe('spawn_agents common params fields', () => {
  it('accepts owned_paths, snapshot_id, changed_files+snapshot_fingerprint, manager+operation, and repoUrl', () => {
    const result = spawnAgentsParams.inputSchema.safeParse({
      agents: [
        {
          agent_type: 'git-committer',
          params: { owned_paths: ['src/runtime.ts'] },
        },
        {
          agent_type: 'accessibility-reviewer',
          params: {
            snapshot_id:
              'v3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
        },
        {
          agent_type: 'security-reviewer',
          params: {
            changed_files: ['src/runtime.ts'],
            snapshot_fingerprint: 'opaque-token',
          },
        },
        {
          agent_type: 'dependency-manager',
          params: { manager: 'bun', operation: 'add' },
        },
        {
          agent_type: 'librarian',
          params: { repoUrl: 'https://github.com/owner/repo' },
        },
      ],
    })

    expect(result.success).toBe(true)
  })
})

describe('live-catalog spawn enum', () => {
  const catalogSchema = buildSpawnAgentsProviderInputSchema([
    'file-picker',
    'code-searcher',
  ])

  it('accepts visible hyphenated types and the underscore alias', () => {
    for (const agent_type of ['file-picker', 'code-searcher', 'file_picker']) {
      expect(
        catalogSchema.safeParse({ agents: [{ agent_type }] }).success,
      ).toBe(true)
    }
  })

  it('rejects a hallucinated agent that is not in the live catalog', () => {
    for (const agent_type of ['researcher', 'file-explorer']) {
      expect(
        catalogSchema.safeParse({ agents: [{ agent_type }] }).success,
      ).toBe(false)
    }
  })

  it('falls back to a free-form agent_type string when the visible list is empty', () => {
    const openSchema = buildSpawnAgentsProviderInputSchema([])
    expect(
      openSchema.safeParse({
        agents: [{ agent_type: 'researcher' }],
      }).success,
    ).toBe(true)
  })
})
