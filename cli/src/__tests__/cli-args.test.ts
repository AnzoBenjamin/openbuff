import { describe, expect, test } from 'bun:test'

import { isRendererCommand, parseCliArgs } from '../cli-args'

const parse = (args: string[], env?: { OPENBUFF_SERVE_SOCKET?: string }) =>
  parseCliArgs(['node', 'openbuff', ...args], {
    version: '1.2.3',
    exitOverride: true,
    env,
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

describe('isRendererCommand', () => {
  test('returns true for the default (renderer/TUI) path', () => {
    expect(isRendererCommand(parse([]))).toBe(true)
    expect(isRendererCommand(parse(['hello']))).toBe(true)
  })

  test('returns false for the serve subcommand (ACP wire on stdio)', () => {
    expect(isRendererCommand(parse(['serve']))).toBe(false)
  })

  test('returns false for the mcp subcommand (MCP wire on stdio)', () => {
    expect(isRendererCommand(parse(['mcp']))).toBe(false)
  })

  test('returns false for the run subcommand (ndjson stream on stdout)', () => {
    expect(isRendererCommand(parse(['run', 'hello']))).toBe(false)
  })

  test('returns false for the replay subcommand (ndjson stream on stdout)', () => {
    expect(isRendererCommand(parse(['replay', 'run-1']))).toBe(false)
  })
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

describe('replay subcommand parsing (P2-T3)', () => {
  test('leaves replay undefined when the subcommand is not used', () => {
    expect(parse([]).replay).toBeUndefined()
    expect(parse(['hello']).replay).toBeUndefined()
    expect(parse(['serve']).replay).toBeUndefined()
    expect(parse(['mcp']).replay).toBeUndefined()
    expect(parse(['run', 'hello']).replay).toBeUndefined()
  })

  test('parses a bare runId with json off and no overrides', () => {
    expect(parse(['replay', 'run-123']).replay).toEqual({
      runId: 'run-123',
      json: false,
    })
  })

  test('errors when the runId is missing', () => {
    expect(() => parse(['replay'])).toThrow()
  })

  test('parses --json', () => {
    expect(parse(['replay', 'run-123', '--json']).replay).toEqual({
      runId: 'run-123',
      json: true,
    })
  })

  test('parses --from-step into replay.fromStep', () => {
    expect(parse(['replay', 'run-123', '--from-step', '4']).replay).toEqual({
      runId: 'run-123',
      fromStep: 4,
      json: false,
    })
  })

  test('rejects a non-integer --from-step', () => {
    expect(() => parse(['replay', 'run-123', '--from-step', 'nope'])).toThrow()
  })

  test('rejects an empty/whitespace --from-step instead of silently replaying from step 0', () => {
    // Fail-closed contract: Number('') is 0, which used to be silently
    // treated as 'no fromStep' (a full replay from the beginning).
    expect(() => parse(['replay', 'run-123', '--from-step', ''])).toThrow()
    expect(() => parse(['replay', 'run-123', '--from-step', '   '])).toThrow()
  })

  test('rejects non-decimal numeric forms of --from-step', () => {
    // Number('0x10') is 16 and Number('1e2') is 100; neither is a decimal
    // integer literal, so both must error rather than parse.
    expect(() => parse(['replay', 'run-123', '--from-step', '0x10'])).toThrow()
    expect(() => parse(['replay', 'run-123', '--from-step', '1e2'])).toThrow()
  })

  test('parses --model into replay.model', () => {
    expect(
      parse(['replay', 'run-123', '--model', 'anthropic/claude-opus-4']).replay,
    ).toEqual({
      runId: 'run-123',
      model: 'anthropic/claude-opus-4',
      json: false,
    })
  })

  test('parses --from-step, --model and --json together', () => {
    expect(
      parse([
        'replay',
        'run-123',
        '--from-step',
        '2',
        '--model',
        'openai/gpt-5.1',
        '--json',
      ]).replay,
    ).toEqual({
      runId: 'run-123',
      fromStep: 2,
      model: 'openai/gpt-5.1',
      json: true,
    })
  })

  test('keeps the replay subcommand out of the top-level result', () => {
    const result = parse(['replay', 'run-123', '--json'])
    expect(result.initialPrompt).toBeNull()
    expect(result.serve).toBeUndefined()
    expect(result.mcp).toBeUndefined()
    expect(result.run).toBeUndefined()
    expect(result.trustProjectAgents).toBe(false)
    expect(result.continue).toBe(false)
    expect(result.clearLogs).toBe(false)
  })
})

describe('attach flag parsing (P1-T3)', () => {
  test('leaves attach undefined by default', () => {
    expect(parse([]).attach).toBeUndefined()
    expect(parse(['hello']).attach).toBeUndefined()
  })

  test('rejects --attach with no socket path', () => {
    expect(() => parse(['--attach'])).toThrow()
  })

  test('rejects --attach when neither the flag nor OPENBUFF_SERVE_SOCKET provides a socket', () => {
    // Fail closed: the error's prescribed remedy must be exhaustive — an
    // empty env value is not a socket, so a bare `--attach` still dies with
    // the OPENBUFF_SERVE_SOCKET hint.
    expect(() => parse(['--attach'], {})).toThrow(/OPENBUFF_SERVE_SOCKET/)
    expect(() => parse(['--attach'], { OPENBUFF_SERVE_SOCKET: '' })).toThrow(
      /OPENBUFF_SERVE_SOCKET/,
    )
  })

  test('accepts --attach with only OPENBUFF_SERVE_SOCKET (documented env fallback)', () => {
    // Regression: parseCliArgs used to program.error here before
    // cli/src/index.tsx could apply the documented OPENBUFF_SERVE_SOCKET
    // fallback, so setting the env var produced the identical error. The
    // completeness check now consults the injected env; the fallback VALUE is
    // applied by cli/src/index.tsx, so the parser carries only explicit flags.
    const result = parse(['--attach'], {
      OPENBUFF_SERVE_SOCKET: '/tmp/env.sock',
    })
    expect(result.attach).toEqual({})
  })

  test('the env socket unblocks --attach carrying only --serve-token', () => {
    const result = parse(['--attach', '--serve-token', 'abc'], {
      OPENBUFF_SERVE_SOCKET: '/tmp/env.sock',
    })
    expect(result.attach).toEqual({ token: 'abc' })
  })

  test('parses --attach with --serve-socket', () => {
    expect(parse(['--attach', '--serve-socket', '/tmp/x.sock']).attach).toEqual(
      { socketPath: '/tmp/x.sock' },
    )
  })

  test('parses --attach with --serve-socket and --serve-token', () => {
    expect(
      parse([
        '--attach',
        '--serve-socket',
        '/tmp/x.sock',
        '--serve-token',
        'abc',
      ]).attach,
    ).toEqual({ socketPath: '/tmp/x.sock', token: 'abc' })
  })

  test('attach does not poison the top-level prompt/serve/mcp fields', () => {
    const result = parse(['--attach', '--serve-socket', '/tmp/x.sock'])
    expect(result.serve).toBeUndefined()
    expect(result.mcp).toBeUndefined()
    expect(result.attach).toEqual({ socketPath: '/tmp/x.sock' })
  })
})

describe('dash subcommand parsing (P2-T7)', () => {
  test('leaves dash undefined when the subcommand is not used', () => {
    expect(parse([]).dash).toBeUndefined()
    expect(parse(['hello']).dash).toBeUndefined()
    expect(parse(['serve']).dash).toBeUndefined()
    expect(parse(['mcp']).dash).toBeUndefined()
    expect(parse(['run', 'hello']).dash).toBeUndefined()
    expect(parse(['replay', 'run-1']).dash).toBeUndefined()
  })

  test('parses bare `dash` into serve mode with default open and no port/token', () => {
    expect(parse(['dash']).dash).toEqual({ open: true })
    expect(parse(['dash']).dash?.port).toBeUndefined()
    expect(parse(['dash']).dash?.token).toBeUndefined()
    expect(parse(['dash']).dash?.exportDir).toBeUndefined()
  })

  test('parses --port into dash.port', () => {
    expect(parse(['dash', '--port', '4321']).dash).toEqual({
      port: 4321,
      open: true,
    })
  })

  test('rejects a non-integer --port', () => {
    expect(() => parse(['dash', '--port', 'nope'])).toThrow()
  })

  test('rejects non-decimal numeric forms of --port', () => {
    // Number('0x10') is 16 and Number('1e2') is 100; neither is a decimal
    // integer literal, so both must error rather than parse.
    expect(() => parse(['dash', '--port', '0x10'])).toThrow()
    expect(() => parse(['dash', '--port', '1e2'])).toThrow()
    expect(() => parse(['dash', '--port', ''])).toThrow()
  })

  test('rejects --port above 65535', () => {
    expect(() => parse(['dash', '--port', '65536'])).toThrow()
  })

  test('parses --token into dash.token', () => {
    expect(parse(['dash', '--token', 'abc123']).dash).toEqual({
      token: 'abc123',
      open: true,
    })
  })

  test('rejects an empty --token (an empty expected token is an auth bypass)', () => {
    expect(() => parse(['dash', '--token', ''])).toThrow()
    expect(() => parse(['dash', '--token', '   '])).toThrow()
  })

  test('parses --export into dash.exportDir', () => {
    expect(parse(['dash', '--export', '/tmp/site']).dash).toEqual({
      exportDir: '/tmp/site',
      open: true,
    })
  })

  test('rejects an empty --export instead of silently degrading to serve mode', () => {
    // Fail-closed contract mirroring the empty --token rejection: dropping an
    // empty --export used to leave dash.exportDir undefined, so `openbuff
    // dash --export ''` started a token-generating server instead of writing
    // the static export the user asked for.
    expect(() => parse(['dash', '--export', ''])).toThrow(/--export/)
    expect(() => parse(['dash', '--export', '   '])).toThrow(/--export/)
  })

  test('errors when --export is given without a value', () => {
    expect(() => parse(['dash', '--export'])).toThrow()
  })

  test('parses --no-open into dash.open=false', () => {
    expect(parse(['dash', '--no-open']).dash).toEqual({ open: false })
    expect(
      parse(['dash', '--no-open', '--port', '8080']).dash,
    ).toEqual({ port: 8080, open: false })
  })

  test('parses --port, --token and --no-open together', () => {
    expect(
      parse(['dash', '--port', '9000', '--token', 't', '--no-open']).dash,
    ).toEqual({ port: 9000, token: 't', open: false })
  })

  test('keeps the dash subcommand out of the top-level result', () => {
    const result = parse(['dash', '--port', '1'])
    expect(result.initialPrompt).toBeNull()
    expect(result.serve).toBeUndefined()
    expect(result.mcp).toBeUndefined()
    expect(result.run).toBeUndefined()
    expect(result.replay).toBeUndefined()
    expect(result.trustProjectAgents).toBe(false)
    expect(result.continue).toBe(false)
    expect(result.clearLogs).toBe(false)
  })

  test('isRendererCommand returns false for the dash subcommand', () => {
    expect(isRendererCommand(parse(['dash']))).toBe(false)
    expect(isRendererCommand(parse(['dash', '--export', '/tmp/x']))).toBe(false)
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
