import { describe, expect, test } from 'bun:test'

import { buildVisibleAgentRows } from '../agent-checklist'

const agents = [
  { id: 'root', displayName: 'Root', filePath: '/tmp/root.ts' },
  { id: 'child', displayName: 'Child', filePath: '/tmp/child.ts' },
  { id: 'grandchild', displayName: 'Grandchild', filePath: '/tmp/grand.ts' },
]

describe('AgentChecklist focus rows', () => {
  test('includes expanded dependency rows in keyboard navigation order', () => {
    const rows = buildVisibleAgentRows({
      allAgents: agents,
      filteredAgents: [agents[0]],
      expandedAgentIds: new Set(['root']),
      agentDefinitions: new Map([
        ['root', { spawnableAgents: ['child'] }],
        ['child', { spawnableAgents: ['grandchild'] }],
      ]),
    })

    expect(
      rows.map((row) => (row.kind === 'agent' ? row.agent.id : row.agentId)),
    ).toEqual(['root', 'child', 'grandchild'])
    expect(rows.map((row) => row.kind)).toEqual([
      'agent',
      'dependency',
      'dependency',
    ])
  })

  test('keeps collapsed dependency rows out of the focus order', () => {
    const rows = buildVisibleAgentRows({
      allAgents: agents,
      filteredAgents: [agents[0]],
      expandedAgentIds: new Set(),
      agentDefinitions: new Map([['root', { spawnableAgents: ['child'] }]]),
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'agent' })
  })
})

test('a 29-agent layered DAG expands each node once and retains short shared links', () => {
  const allAgents = [
    { id: 'root', displayName: 'Root', filePath: '/tmp/root' },
    ...Array.from({ length: 28 }, (_, index) => ({
      id: `node${index}`,
      displayName: `Node ${index}`,
      filePath: `/tmp/${index}`,
    })),
  ]
  const definitions = new Map<string, { spawnableAgents?: string[] }>([
    ['root', { spawnableAgents: ['node0', 'node1'] }],
  ])
  for (let layer = 0; layer < 13; layer++)
    for (const index of [layer * 2, layer * 2 + 1])
      definitions.set(`node${index}`, {
        spawnableAgents: [`node${layer * 2 + 2}`, `node${layer * 2 + 3}`],
      })
  const rows = buildVisibleAgentRows({
    allAgents,
    filteredAgents: [allAgents[0]],
    agentDefinitions: definitions,
    expandedAgentIds: new Set(['root']),
  })
  expect(rows.length).toBeLessThanOrEqual(60)
  expect(
    new Set(
      rows
        .filter((row) => row.kind === 'dependency')
        .map((row) => (row.kind === 'dependency' ? row.agentId : '')),
    ).size,
  ).toBe(28)
  expect(
    rows.some((row) => row.kind === 'dependency' && row.reference === 'shared'),
  ).toBe(true)
  expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length)
})

test('cycles remain visible links and dependency paging has an explicit limit row', () => {
  const rows = buildVisibleAgentRows({
    allAgents: agents,
    filteredAgents: [agents[0]],
    agentDefinitions: new Map([
      ['root', { spawnableAgents: ['child', 'grandchild'] }],
      ['child', { spawnableAgents: ['root'] }],
    ]),
    expandedAgentIds: new Set(['root']),
  })
  expect(
    rows.some((row) => row.kind === 'dependency' && row.reference === 'cycle'),
  ).toBe(true)
  const limited = buildVisibleAgentRows({
    allAgents: agents,
    filteredAgents: [agents[0]],
    agentDefinitions: new Map([
      ['root', { spawnableAgents: ['child', 'grandchild'] }],
    ]),
    expandedAgentIds: new Set(['root']),
    maxDependencyRows: 1,
  })
  expect(limited.at(-1)).toMatchObject({
    kind: 'dependency',
    reference: 'limited',
  })
  expect(limited).toHaveLength(3)
})
