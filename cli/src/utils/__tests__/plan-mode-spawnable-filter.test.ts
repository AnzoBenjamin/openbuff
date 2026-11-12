import { afterEach, expect, test } from 'bun:test'

import { agentHasPlanModeRefusedTools } from '@codebuff/common/tools/plan-mode-policy'

import {
  __resetLocalAgentRegistryForTests,
  filterPlanModeSpawnableAgents,
  initializeAgentRegistry,
  loadAgentDefinitions,
} from '../local-agent-registry'

import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'

afterEach(() => __resetLocalAgentRegistryForTests())

// N03 (orchestration-01): user `.agents/` agents, including `~/.agents`, were
// auto-added to every base* template, so base2-plan could spawn a custom agent
// with edit_transaction. Fixtures mirror the p4 probe's home-writer.
const homeWriter = {
  id: 'home-writer',
  displayName: 'Home Writer',
  model: 'fixture',
  toolNames: ['edit_transaction', 'write_file', 'str_replace', 'run_terminal_command'],
} as AgentDefinition
const homeReader = {
  id: 'home-reader',
  displayName: 'Home Reader',
  model: 'fixture',
  toolNames: ['read_files', 'code_search', 'run_terminal_command'],
} as AgentDefinition

const loadWith = (agents: AgentDefinition[]) =>
  initializeAgentRegistry(
    { trustProjectAgents: false },
    {
      getRoot: () => '/plan-filter-project',
      getCwd: () => '/plan-filter-project',
      loadAgents: async () => ({
        agents: Object.fromEntries(agents.map((agent) => [agent.id, agent])),
        validationErrors: [],
      }),
      loadMcpConfig: () => ({ mcpServers: {}, _sourceFilePath: '' }),
    },
  )

test('plan-mode templates spawn only agents without plan-refused tools', async () => {
  await loadWith([homeWriter, homeReader])
  const definitions = loadAgentDefinitions()
  const byId = new Map(definitions.map((definition) => [definition.id, definition]))

  const plan = byId.get('base2-plan')
  expect(plan?.programmaticConfig?.planOnly).toBe(true)
  expect(plan?.spawnableAgents).toContain('home-reader')
  expect(plan?.spawnableAgents).not.toContain('home-writer')
  for (const id of plan?.spawnableAgents ?? []) {
    expect(
      agentHasPlanModeRefusedTools(byId.get(id)?.toolNames),
      `base2-plan spawnable ${id}`,
    ).toBe(false)
  }

  // Execute mode keeps the auto-added writer.
  expect(byId.get('base2')?.spawnableAgents).toContain('home-writer')
})

test('the filter drops unknown ids and leaves non-plan templates alone', () => {
  const definitions = [
    {
      id: 'plan-root',
      displayName: 'Plan',
      programmaticConfig: { planOnly: true },
      spawnableAgents: ['reader', 'writer', 'missing'],
    },
    {
      id: 'exec-root',
      displayName: 'Exec',
      spawnableAgents: ['reader', 'writer', 'missing'],
    },
    { id: 'reader', displayName: 'Reader', toolNames: ['read_files'] },
    { id: 'writer', displayName: 'Writer', toolNames: ['rename_symbol'] },
  ] as AgentDefinition[]
  filterPlanModeSpawnableAgents(definitions)
  expect(definitions[0]!.spawnableAgents).toEqual(['reader'])
  expect(definitions[1]!.spawnableAgents).toEqual(['reader', 'writer', 'missing'])
})
