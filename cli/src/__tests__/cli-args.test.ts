import { describe, expect, test } from 'bun:test'

import { parseCliArgs } from '../cli-args'

const parse = (args: string[]) =>
  parseCliArgs(['node', 'openbuff', ...args], {
    version: '1.2.3',
    exitOverride: true,
  })

describe('production CLI argument parser', () => {
  test('parses agent, cwd, mode, trust, logs, and prompt together', () => {
    expect(
      parse([
        '--agent',
        'reviewer',
        '--cwd',
        '/repo',
        '--plan',
        '--trust-project-agents',
        '--clear-logs',
        'review',
        'this',
      ]),
    ).toEqual({
      agent: 'reviewer',
      clearLogs: true,
      continue: false,
      continueId: null,
      cwd: '/repo',
      initialMode: 'PLAN',
      initialPrompt: 'review this',
      trustProjectAgents: true,
    })
  })

  test('parses continuation with and without an id', () => {
    expect(parse(['--continue']).continueId).toBeNull()
    expect(parse(['--continue', 'chat-123']).continueId).toBe('chat-123')
  })

  test('does not treat a positional directory as cwd', () => {
    const result = parse(['/tmp/project'])
    expect(result.cwd).toBeUndefined()
    expect(result.initialPrompt).toBe('/tmp/project')
  })

  test('keeps compatibility --local as a no-op', () => {
    expect(parse(['--local', 'hello']).initialPrompt).toBe('hello')
  })

  test('handles empty arguments', () => {
    expect(parse([])).toMatchObject({
      initialPrompt: null,
      continue: false,
      clearLogs: false,
      trustProjectAgents: false,
    })
  })

  test.each([['--help'], ['-h'], ['--version'], ['-v']])(
    'uses Commander output paths for %s',
    (arg) => {
      expect(() => parse([arg])).toThrow()
    },
  )
})

describe('serve subcommand parsing', () => {
  test('leaves serve undefined when the subcommand is not used', () => {
    expect(parse([]).serve).toBeUndefined()
    expect(parse(['hello']).serve).toBeUndefined()
  })

  test('parses bare `serve` as stdio transport', () => {
    expect(parse(['serve']).serve).toEqual({
      transport: 'stdio',
      trustProjectAgents: false,
    })
  })

  test('parses --stdio as stdio transport', () => {
    expect(parse(['serve', '--stdio']).serve).toEqual({
      transport: 'stdio',
      trustProjectAgents: false,
    })
  })

  test('errors when --socket is given without a path', () => {
    expect(() => parse(['serve', '--socket'])).toThrow()
  })

  test('parses --socket with a path', () => {
    expect(parse(['serve', '--socket', '/tmp/x.sock']).serve).toEqual({
      transport: 'socket',
      socketPath: '/tmp/x.sock',
      trustProjectAgents: false,
    })
  })

  test('parses --socket with a path and --socket-token', () => {
    expect(
      parse(['serve', '--socket', '/tmp/x.sock', '--socket-token', 'abc'])
        .serve,
    ).toEqual({
      transport: 'socket',
      socketPath: '/tmp/x.sock',
      token: 'abc',
      trustProjectAgents: false,
    })
  })

  test('parses --agent into serve.agentId for stdio', () => {
    expect(parse(['serve', '--agent', 'foo']).serve).toEqual({
      transport: 'stdio',
      agentId: 'foo',
      trustProjectAgents: false,
    })
  })

  test('parses --socket with --agent', () => {
    expect(
      parse(['serve', '--socket', '/tmp/x.sock', '--agent', 'foo']).serve,
    ).toEqual({
      transport: 'socket',
      socketPath: '/tmp/x.sock',
      agentId: 'foo',
      trustProjectAgents: false,
    })
  })

  test('leaves serve.agentId undefined for bare serve', () => {
    expect(parse(['serve']).serve?.agentId).toBeUndefined()
  })

  test('defaults serve trust to false for both variants', () => {
    expect(parse(['serve']).serve?.trustProjectAgents).toBe(false)
    expect(
      parse(['serve', '--socket', '/tmp/x.sock']).serve?.trustProjectAgents,
    ).toBe(false)
  })

  test('parses --trust-project-agents into the stdio variant', () => {
    expect(parse(['serve', '--trust-project-agents']).serve).toEqual({
      transport: 'stdio',
      trustProjectAgents: true,
    })
  })

  test('parses --trust-project-agents into the socket variant', () => {
    expect(
      parse(['serve', '--socket', '/tmp/x.sock', '--trust-project-agents'])
        .serve,
    ).toEqual({
      transport: 'socket',
      socketPath: '/tmp/x.sock',
      trustProjectAgents: true,
    })
  })

  test('parses --trust-project-agents together with --agent', () => {
    expect(
      parse(['serve', '--trust-project-agents', '--agent', 'foo']).serve,
    ).toEqual({
      transport: 'stdio',
      agentId: 'foo',
      trustProjectAgents: true,
    })
  })

  test('keeps the serve-level trust flag out of the top-level result', () => {
    expect(parse(['serve', '--trust-project-agents']).trustProjectAgents).toBe(
      false,
    )
  })
})

describe('run subcommand parsing', () => {
  test('leaves run undefined when the subcommand is not used', () => {
    expect(parse([]).run).toBeUndefined()
    expect(parse(['hello']).run).toBeUndefined()
    expect(parse(['serve']).run).toBeUndefined()
    expect(parse(['mcp']).run).toBeUndefined()
  })

  test('joins positional prompt tokens with spaces', () => {
    expect(parse(['run', 'hello', 'world']).run).toEqual({
      prompt: 'hello world',
      json: false,
    })
  })

  test('parses --json', () => {
    expect(parse(['run', '--json', 'fix the bug']).run).toEqual({
      prompt: 'fix the bug',
      json: true,
    })
  })

  test('parses --agent into run.agentId', () => {
    expect(parse(['run', '--agent', 'reviewer', 'do it']).run).toEqual({
      prompt: 'do it',
      json: false,
      agentId: 'reviewer',
    })
  })

  test('errors when the prompt is empty', () => {
    expect(() => parse(['run'])).toThrow()
  })

  test('keeps the run subcommand out of the top-level result', () => {
    const result = parse(['run', 'hello'])
    expect(result.initialPrompt).toBeNull()
    expect(result.serve).toBeUndefined()
    expect(result.mcp).toBeUndefined()
    expect(result.trustProjectAgents).toBe(false)
    expect(result.continue).toBe(false)
    expect(result.clearLogs).toBe(false)
  })
})

describe('mcp subcommand parsing', () => {
  test('leaves mcp undefined when the subcommand is not used', () => {
    expect(parse([]).mcp).toBeUndefined()
    expect(parse(['hello']).mcp).toBeUndefined()
    expect(parse(['serve']).mcp).toBeUndefined()
  })

  test('parses bare `mcp` into ParsedArgs.mcp', () => {
    expect(parse(['mcp']).mcp).toEqual({ mutations: false })
  })

  test('parses --mutations into mcp.mutations', () => {
    expect(parse(['mcp', '--mutations']).mcp).toEqual({ mutations: true })
    expect(parse(['mcp', '--mutations']).mcp?.mutations).toBe(true)
  })

  test('tolerates excess arguments (allowExcessArguments)', () => {
    expect(parse(['mcp', '--future-flag']).mcp).toEqual({ mutations: false })
  })

  test('keeps the mcp subcommand out of the top-level result', () => {
    const result = parse(['mcp'])
    expect(result.initialPrompt).toBeNull()
    expect(result.serve).toBeUndefined()
    expect(result.trustProjectAgents).toBe(false)
    expect(result.continue).toBe(false)
    expect(result.clearLogs).toBe(false)
  })
})
