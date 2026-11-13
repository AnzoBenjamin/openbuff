import { expect, test } from 'bun:test'

import { markMCPConfigOrigin, originOf } from '../client'
import { bindMcpSession, resolveMcpHostBinding } from '../provenance'
import type { MCPConfig, MCPConfigOrigin } from '../../types/mcp'
import type { McpReferencedTemplate } from '../provenance'

const projectRoot = '/tmp/openbuff-mcp-provenance-project'

function config(origin?: MCPConfigOrigin): MCPConfig {
  const value: MCPConfig = {
    type: 'stdio',
    command: 'fixture-server',
    args: [],
    env: { VALUE: '$OPENBUFF_MCP_TEST_VALUE' },
  }
  if (origin) markMCPConfigOrigin(value, origin)
  return value
}

function bind(servers: Record<string, MCPConfig>, sessionReference?: string) {
  return bindMcpSession({
    projectRoot,
    sessionReference,
    templates: { agent: { id: 'agent', mcpServers: servers } },
  })
}

function referenceParams(bound: ReturnType<typeof bind>, name = 'server') {
  const template = bound.templates.agent
  return {
    projectRoot,
    sessionReference: bound.sessionReference!,
    mcpConfig: JSON.parse(
      JSON.stringify(template.mcpServers![name]),
    ) as MCPConfig,
    mcpReference: template.mcpServerReferences![name],
    mcpAgentId: 'agent',
    mcpServerName: name,
  }
}

test('JSON continuation restores exact mixed per-server origins and immutable snapshots', () => {
  const original = bind({
    user: config('user'),
    project: config('project'),
    peer: config('client'),
  })
  const restored = bindMcpSession({
    projectRoot,
    sessionReference: original.sessionReference,
    templates: JSON.parse(JSON.stringify(original.templates)),
  })
  for (const [name, expected] of [
    ['user', 'user'],
    ['project', 'project'],
    ['peer', 'client'],
  ] as const) {
    const resolved = resolveMcpHostBinding(referenceParams(restored, name))
    expect(resolved.origin).toBe(expected)
    expect(originOf(restored.templates.agent.mcpServers![name])).toBe(expected)
    expect(Object.isFrozen(resolved.config)).toBe(true)
    expect(
      Object.isFrozen(
        resolved.config.type === 'stdio'
          ? resolved.config.env
          : resolved.config.headers,
      ),
    ).toBe(true)
    expect(restored.templates.agent.mcpServerReferences![name]).toBe(
      original.templates.agent.mcpServerReferences![name],
    )
  }
})

test('references refuse cross-session, project, agent, server and changed-config replay', () => {
  const original = bind({ server: config('user') })
  const other = bind({ server: config('user') })
  const params = referenceParams(original)
  for (const changed of [
    { ...params, sessionReference: other.sessionReference! },
    { ...params, projectRoot: '/tmp/a-different-project' },
    { ...params, mcpAgentId: 'a-sibling-agent' },
    { ...params, mcpServerName: 'a-sibling-server' },
    { ...params, mcpReference: 'unknown-reference' },
    {
      ...params,
      mcpConfig: {
        ...params.mcpConfig,
        command: 'changed-server',
      } as MCPConfig,
    },
  ])
    expect(() => resolveMcpHostBinding(changed)).toThrow()
})

test('downgrade and replacement revoke the previous server authority', () => {
  const original = bind({ server: config('user') })
  const old = referenceParams(original)
  const downgraded = bind(
    { server: config('client') },
    original.sessionReference,
  )
  expect(() => resolveMcpHostBinding(old)).toThrow()
  expect(resolveMcpHostBinding(referenceParams(downgraded)).origin).toBe(
    'client',
  )
  const changed = config('project')
  if (changed.type !== 'stdio') throw new Error('fixture config kind')
  changed.command = 'replacement-server'
  const replaced = bind({ server: changed }, original.sessionReference)
  expect(() => resolveMcpHostBinding(referenceParams(downgraded))).toThrow()
  expect(resolveMcpHostBinding(referenceParams(replaced)).config).toEqual(
    changed,
  )
})

test('the same authoritative loader reuses active bindings, and removal revokes them', () => {
  const original = bind({ server: config('project') })
  const repeated = bind(
    { server: config('project') },
    original.sessionReference,
  )
  expect(repeated.templates.agent.mcpServerReferences).toEqual(
    original.templates.agent.mcpServerReferences,
  )
  bind({}, original.sessionReference)
  expect(() => resolveMcpHostBinding(referenceParams(original))).toThrow()
})

test('unavailable process references require an authoritative config reload', () => {
  const original = bind({ server: config('user') })
  const serialized = JSON.parse(JSON.stringify(original.templates))
  expect(() =>
    bindMcpSession({
      projectRoot,
      sessionReference: 'prior-process',
      templates: serialized,
    }),
  ).toThrow('previous process')
  markMCPConfigOrigin(serialized.agent.mcpServers.server, 'user')
  const reloaded = bindMcpSession({
    projectRoot,
    sessionReference: 'prior-process',
    templates: serialized,
  })
  expect(reloaded.sessionReference).not.toBe('prior-process')
  expect(resolveMcpHostBinding(referenceParams(reloaded)).origin).toBe('user')
})

test('serialized execution and origin labels cannot upgrade an unmarked config', () => {
  const raw = {
    id: 'agent',
    mcpServers: { server: config() },
    executionSource: 'local',
    mcpOrigins: { server: 'user' },
  }
  const bound = bindMcpSession({ projectRoot, templates: { agent: raw } })
  expect(resolveMcpHostBinding(referenceParams(bound)).origin).toBe('client')
})

test('malformed raw siblings remain available for normal validation and do not block healthy binding', () => {
  const invalid = {
    id: 'bad',
    mcpServers: { broken: { type: 'stdio', command: 42 } },
  }
  const templates = {
    agent: { id: 'agent', mcpServers: { server: config('project') } },
    invalid,
    null: null,
    malformed: { id: 'malformed', mcpServers: [] },
  } as unknown as Record<string, McpReferencedTemplate>
  const bound = bindMcpSession({ projectRoot, templates })
  expect(bound.templates.invalid).toBe(invalid)
  expect(bound.templates.null).toBeNull()
  expect(bound.templates.malformed).toBe(templates.malformed)
  expect(resolveMcpHostBinding(referenceParams(bound)).origin).toBe('project')
})

test('scope eviction expires old references instead of reclassifying them', () => {
  const original = bind({ server: config('user') })
  for (let index = 0; index < 256; index++) bind({ server: config('client') })
  expect(() => resolveMcpHostBinding(referenceParams(original))).toThrow(
    'expired',
  )
})

test('complete collections revoke removed/invalid owners; child subset rebinds retain siblings', () => {
  const original = bindMcpSession({
    projectRoot,
    templates: {
      agent: { id: 'agent', mcpServers: { server: config('user') } },
      sibling: { id: 'sibling', mcpServers: { server: config('project') } },
    },
  })
  const sibling = {
    ...referenceParams(original),
    mcpConfig: original.templates.sibling.mcpServers!.server,
    mcpAgentId: 'sibling',
    mcpReference: original.templates.sibling.mcpServerReferences!.server,
  }
  bindMcpSession({
    projectRoot,
    sessionReference: original.sessionReference,
    templateScope: 'subset',
    templates: { agent: original.templates.agent },
  })
  expect(resolveMcpHostBinding(sibling).origin).toBe('project')
  bindMcpSession({
    projectRoot,
    sessionReference: original.sessionReference,
    templates: {
      agent: {
        id: 'agent',
        mcpServers: [],
      } as unknown as McpReferencedTemplate,
      sibling: original.templates.sibling,
    },
  })
  expect(() => resolveMcpHostBinding(referenceParams(original))).toThrow()
  expect(resolveMcpHostBinding(sibling).origin).toBe('project')
  bindMcpSession({
    projectRoot,
    sessionReference: original.sessionReference,
    templates: {},
  })
  expect(() => resolveMcpHostBinding(sibling)).toThrow()
})
