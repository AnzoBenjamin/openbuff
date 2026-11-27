import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadLocalAgents as loadSdkAgents } from '../../../../sdk/src/agents/load-agents'
import {
  filterPlanModeSpawnableAgents,
  initializeAgentRegistry,
  loadAgentDefinitions,
  loadLocalAgents,
  __resetLocalAgentRegistryForTests,
} from '../local-agent-registry'
import type { AgentDefinition } from '@codebuff/common/templates/initial-agents-dir/types/agent-definition'

let root: string | undefined
afterEach(() => {
  __resetLocalAgentRegistryForTests()
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = undefined
})
test('Markdown tool lists reach CLI spawn filtering and source links', async () => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'markdown-cli-registry-')),
  )
  fs.writeFileSync(
    path.join(root, 'reader.md'),
    '---\nname: md-reader\ndescription: Read source files.\ntools: [read_files]\n---\nRead only.\n',
  )
  fs.writeFileSync(
    path.join(root, 'writer.md'),
    '---\nname: md-writer\ndescription: Edit source files.\ntools: [edit_transaction]\n---\nEdit the requested files.\n',
  )
  const loaded = await loadSdkAgents({ agentsPath: root, validate: true })
  const plan: AgentDefinition = {
    id: 'markdown-plan',
    displayName: 'Markdown plan',
    programmaticConfig: { planOnly: true },
    toolNames: ['spawn_agents'],
    spawnableAgents: ['md-reader', 'md-writer'],
  }
  const definitions = [plan, ...Object.values(loaded.agents)]
  filterPlanModeSpawnableAgents(definitions)
  expect(plan.spawnableAgents).toEqual(['md-reader'])
  await initializeAgentRegistry(
    { trustProjectAgents: true },
    {
      getRoot: () => root!,
      getCwd: () => root!,
      loadAgents: async () => loaded,
      loadMcpConfig: () => ({ mcpServers: {}, _sourceFilePath: '' }),
    },
  )
  expect(
    loadAgentDefinitions().find((agent) => agent.id === 'md-reader')?.toolNames,
  ).toEqual(['read_files'])
  expect(
    loadLocalAgents().find((agent) => agent.id === 'md-reader')?.filePath,
  ).toBe(path.join(root, 'reader.md'))
})
