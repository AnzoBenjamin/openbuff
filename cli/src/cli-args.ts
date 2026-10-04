import { Command } from 'commander'

import type { AgentMode } from './utils/constants'

export type ParsedArgs = {
  initialPrompt: string | null
  agent?: string
  clearLogs: boolean
  continue: boolean
  continueId?: string | null
  cwd?: string
  initialMode?: AgentMode
  trustProjectAgents: boolean
  /**
   * Populated ONLY when the `serve` subcommand ran (undefined otherwise).
   * `trustProjectAgents` mirrors the serve-level `--trust-project-agents`
   * flag (default false); cli/src/index.tsx resolves the effective serve
   * trust (flag OR trusted-roots allowlist) from it (NEW-2, design §12.8).
   */
  serve?:
    | { transport: 'stdio'; agentId?: string; trustProjectAgents: boolean }
    | {
        transport: 'socket'
        socketPath: string
        token?: string
        agentId?: string
        trustProjectAgents: boolean
      }
  /**
   * Populated ONLY when the `mcp` subcommand ran (undefined otherwise).
   * P1-T4: an MCP server over stdio exposing the SDK's read-only in-process
   * surfaces. `--mutations` arms the opt-in receipt-backed edit tooling
   * (`apply_edits`); the server stays read-only unless it is passed.
   */
  mcp?: { mutations?: boolean }
  /**
   * Populated ONLY when the `run` subcommand ran (undefined otherwise).
   * P1-T5: headless/CI mode — run the agent non-interactively on a prompt.
   * `json` selects the machine-readable ndjson event stream on stdout
   * (otherwise only `text` events stream); `agentId` overrides the default
   * 'base' agent; `timeout` is the explicit `--timeout <seconds>` deadline
   * (undefined = no timeout, the previous behavior). The process exit code
   * reflects the run outcome.
   */
  run?: { prompt: string; json: boolean; agentId?: string; timeout?: number }
  /**
   * Populated ONLY when the `replay` subcommand ran (undefined otherwise).
   * P2-T3: deterministic replay/fork of a P2-T2 run journal. `runId` names
   * the run to replay (required positional); `fromStep` replays from a step
   * boundary; `model` overrides the replayed run's model; `json` selects the
   * machine-readable ndjson event stream on stdout (otherwise a
   * human-readable replay trace). The process exit code reflects the replay
   * outcome.
   */
  replay?: { runId: string; fromStep?: number; model?: string; json: boolean }
  /**
   * Populated ONLY when the `dash` subcommand ran (undefined otherwise).
   * P2-T7: localhost+token HTTP dashboard over the run journals, receipts,
   * and gate timelines. Exactly ONE mode is active: `exportDir` selects the
   * static HTML export (no server); otherwise the dashboard serves.
   * `port` is the explicit `--port` value only (undefined = 0 = random free
   * port); `token` is the explicit `--token` value only (undefined = the
   * OPENBUFF_DASH_TOKEN env fallback, else a generated token printed to
   * stderr — never stdout, which may be piped); `open` mirrors `--no-open`
   * (true by default: the URL is printed; no browser is auto-opened in this
   * slice).
   */
  dash?: { port?: number; token?: string; exportDir?: string; open: boolean }
  /**
   * P1-T3 TUI attach mode. Populated ONLY when `--attach` (optionally with
   * `--serve-socket`/`--serve-token`) is passed; `undefined` keeps the
   * default in-process backend. When set, the CLI's client runs prompts
   * against a live `openbuff serve` over ACP instead of in-process, and
   * supports detach/reattach to the live session. `socketPath`/`token` carry
   * the explicit flag values only; when omitted, cli/src/index.tsx falls back
   * to OPENBUFF_SERVE_SOCKET/OPENBUFF_SERVE_TOKEN (parse-time completeness is
   * validated against the injected `options.env`).
   */
  attach?: { socketPath?: string; token?: string }
}

/**
 * True when the parsed argv dispatches to the interactive OpenTUI renderer
 * rather than a non-renderer command path. The serve/mcp/run/replay commands
 * use stdin/stdout as the ACP/MCP/ndjson protocol wire and return from main()
 * before a renderer is created, so anything that would read stdin or write to
 * the TTY (e.g. the deferred OSC theme probe) must be suppressed on those
 * paths to preserve protocol-wire exclusivity of stdin/stdout.
 */
export function isRendererCommand(args: ParsedArgs): boolean {
  return !args.serve && !args.mcp && !args.run && !args.replay && !args.dash
}

export function parseCliArgs(
  argv: string[],
  options: {
    version: string
    exitOverride?: boolean
    /**
     * Env fallback source for the `--attach` socket (OPENBUFF_SERVE_SOCKET).
     * The parser reads no ambient process.env — cli/src/index.tsx injects
     * getCliEnv() here so the documented "pass --serve-socket <path> or set
     * OPENBUFF_SERVE_SOCKET" contract can be validated up front. Only the
     * socket is checked (the token is optional); the fallback VALUES are
     * applied by cli/src/index.tsx where the attach target is recorded.
     */
    env?: { OPENBUFF_SERVE_SOCKET?: string }
  },
): ParsedArgs {
  // The tests (and cli/src/index.tsx) pass a full argv with the node+script
  // prefix, i.e. ['node', 'openbuff', ...userArgs]. Detect an explicit leading
  // subcommand token (`serve`, `mcp`) in the user args BEFORE constructing the
  // top-level program.
  // Registering `.command('serve')` on the same program that parses prompts
  // makes commander treat the first positional prompt as an unknown command,
  // so the two paths are kept fully separate.
  const userArgs = argv.slice(2)

  if (userArgs[0] === 'serve') {
    // `openbuff serve` subcommand (P1-T2 Wave-2). This wave only PARSES it
    // into ParsedArgs.serve; wiring it into cli/src/index.tsx is a FOLLOW-UP
    // wave.
    const serveProgram = new Command()
    serveProgram
      .name('openbuff serve')
      .description(
        'Run the ACP bridge over stdio (default) or a unix domain socket',
      )
      .option('--stdio', 'Serve the ACP bridge over stdio (default)')
      .option(
        '--socket <path>',
        'Serve the ACP bridge over a unix domain socket at the given path',
      )
      .option(
        '--socket-token <token>',
        'Token clients must present on --socket (generated by the CLI if omitted)',
      )
      .option(
        '--agent <id>',
        'Run a specific agent id for served prompt turns (default: base)',
      )
      .option(
        '--trust-project-agents',
        'Allow executable agents and MCP config from this project or its parent directory',
      )
      .allowExcessArguments(true)
    if (options.exitOverride) {
      serveProgram.exitOverride()
    }
    // Re-attach the node/script prefix and drop the leading `serve` token so
    // commander parses only the serve-specific options.
    serveProgram.parse([argv[0], argv[1], ...userArgs.slice(1)])
    const serveOpts = serveProgram.opts()
    const serveAgentId =
      typeof serveOpts.agent === 'string' ? serveOpts.agent : undefined
    // Serve-level trust flag (NEW-2): defaults to false when absent.
    const serveTrustProjectAgents = serveOpts.trustProjectAgents === true
    // SEC-4: an explicitly EMPTY --socket-token ("" or whitespace) is an
    // auth bypass — any client satisfies an empty expected token — so it is
    // rejected, never carried. Omitting the flag stays the documented path
    // (the CLI generates a 256-bit CSPRNG token).
    if (
      typeof serveOpts.socketToken === 'string' &&
      serveOpts.socketToken.trim().length === 0
    ) {
      serveProgram.error(
        '--socket-token must not be empty (omit it to generate one)',
      )
    }
    // An explicitly EMPTY --socket ("" or whitespace) must fail closed too:
    // carrying it would select the socket transport with an empty path
    // (no usable bind target). Same empty-value contract as --socket-token
    // above; omitting the flag stays the stdio default.
    if (
      typeof serveOpts.socket === 'string' &&
      serveOpts.socket.trim().length === 0
    ) {
      serveProgram.error('--socket must not be empty (pass a unix socket path)')
    }
    const serve: ParsedArgs['serve'] =
      typeof serveOpts.socket === 'string'
        ? {
            transport: 'socket',
            socketPath: serveOpts.socket,
            trustProjectAgents: serveTrustProjectAgents,
            ...(typeof serveOpts.socketToken === 'string'
              ? { token: serveOpts.socketToken }
              : {}),
            ...(serveAgentId ? { agentId: serveAgentId } : {}),
          }
        : {
            transport: 'stdio',
            trustProjectAgents: serveTrustProjectAgents,
            ...(serveAgentId ? { agentId: serveAgentId } : {}),
          }
    return {
      initialPrompt: null,
      clearLogs: false,
      continue: false,
      continueId: null,
      trustProjectAgents: false,
      serve,
    }
  }

  if (userArgs[0] === 'mcp') {
    // `openbuff mcp` subcommand (P1-T4). Kept off the top-level program for
    // exactly the reason the comment above names for `serve`: registering
    // `.command('mcp')` there would break positional prompts.
    const mcpProgram = new Command()
    mcpProgram
      .name('openbuff mcp')
      .description('Run the Openbuff MCP server over stdio')
      .option(
        '--mutations',
        'Arm receipt-backed edit tooling (apply_edits) on the MCP server',
      )
      .allowExcessArguments(true)
      // Tolerate unknown options too: an MCP host config may pass flags a
      // future CLI understands; failing hard on them would break the host.
      .allowUnknownOption(true)
    if (options.exitOverride) {
      mcpProgram.exitOverride()
    }
    // Re-attach the node/script prefix and drop the leading `mcp` token so
    // commander parses only the mcp-specific options (currently --mutations).
    mcpProgram.parse([argv[0], argv[1], ...userArgs.slice(1)])
    return {
      initialPrompt: null,
      clearLogs: false,
      continue: false,
      continueId: null,
      trustProjectAgents: false,
      mcp: { mutations: mcpProgram.opts().mutations === true },
    }
  }

  if (userArgs[0] === 'run') {
    // `openbuff run` subcommand (P1-T5): headless/CI mode. Kept off the
    // top-level program for exactly the reason the comment above names for
    // `serve`: registering `.command('run')` there would break positional
    // prompts. stdout carries ONLY the machine-readable stream in --json mode.
    const runProgram = new Command()
    runProgram
      .name('openbuff run')
      .description(
        'Run an agent non-interactively on a prompt and exit (headless/CI mode)',
      )
      .option(
        '--json',
        'Emit machine-readable events (one JSON object per line) on stdout',
      )
      .option('--agent <id>', 'Run a specific agent id (default: base)')
      .option(
        '--timeout <seconds>',
        'Abort the run after this many seconds (default: no timeout)',
      )
      .argument('<prompt...>', 'Prompt to send to the agent')
      .allowExcessArguments(true)
    if (options.exitOverride) {
      runProgram.exitOverride()
    }
    // Re-attach the node/script prefix and drop the leading `run` token so
    // commander parses only the run-specific options. `.argument('<prompt...>')
    // is required, so a run with no prompt errors via commander's error path
    // (exitOverride in tests, process exit in production) and never launches.
    runProgram.parse([argv[0], argv[1], ...userArgs.slice(1)])
    const runOpts = runProgram.opts()
    const prompt = runProgram.args.join(' ')
    const runAgentId =
      typeof runOpts.agent === 'string' ? runOpts.agent : undefined
    // Fail-closed --timeout validation, mirroring the --from-step contract:
    // commander passes the raw string through, so a strict DECIMAL integer
    // check runs first ('' / '0x10' / '1e2' must never silently parse), and
    // 0 is rejected because a zero-second deadline would abort immediately.
    let timeoutSeconds: number | undefined
    if (typeof runOpts.timeout === 'string') {
      const rawTimeout = runOpts.timeout.trim()
      if (!/^\d+$/.test(rawTimeout) || Number(rawTimeout) < 1) {
        runProgram.error(
          `--timeout must be a positive integer (seconds), got ${JSON.stringify(runOpts.timeout)}`,
        )
      }
      timeoutSeconds = Number(rawTimeout)
    }
    return {
      initialPrompt: null,
      clearLogs: false,
      continue: false,
      continueId: null,
      trustProjectAgents: false,
      run: {
        prompt,
        json: runOpts.json === true,
        ...(runAgentId ? { agentId: runAgentId } : {}),
        ...(timeoutSeconds !== undefined ? { timeout: timeoutSeconds } : {}),
      },
    }
  }

  if (userArgs[0] === 'replay') {
    // `openbuff replay` subcommand (P2-T3): deterministic replay/fork of a
    // P2-T2 run journal. Kept off the top-level program for exactly the
    // reason the comment above names for `serve`: registering
    // `.command('replay')` there would break positional prompts. stdout
    // carries ONLY the machine-readable stream in --json mode.
    const replayProgram = new Command()
    replayProgram
      .name('openbuff replay')
      .description(
        'Replay a journaled run deterministically (optionally from a step boundary / with a model override)',
      )
      .argument('<runId>', 'Run id to replay')
      .option('--from-step <n>', 'Replay from a step boundary')
      .option('--model <id>', 'Override the model for the replayed run')
      .option(
        '--json',
        'Emit machine-readable events (one JSON object per line) on stdout',
      )
      .allowExcessArguments(true)
    if (options.exitOverride) {
      replayProgram.exitOverride()
    }
    // Re-attach the node/script prefix and drop the leading `replay` token so
    // commander parses only the replay-specific options. `.argument('<runId>')
    // is required, so a replay with no runId errors via commander's error path
    // (exitOverride in tests, process exit in production) and never runs.
    replayProgram.parse([argv[0], argv[1], ...userArgs.slice(1)])
    const replayOpts = replayProgram.opts()
    const runId = replayProgram.args[0]
    // Validate --from-step: commander passes the raw string through, so the
    // documented fail-closed contract requires a strict DECIMAL integer.
    // Plain `Number()` parsing is too lax: '' / '   ' parse to 0 (silently
    // replaying from step 0) and '0x10' / '1e2' parse as integers, so an
    // explicit decimal-digit check runs first and any other shape errors.
    let fromStep: number | undefined
    if (typeof replayOpts.fromStep === 'string') {
      const rawFromStep = replayOpts.fromStep.trim()
      if (!/^\d+$/.test(rawFromStep)) {
        replayProgram.error(
          `--from-step must be a non-negative integer, got ${JSON.stringify(replayOpts.fromStep)}`,
        )
      }
      fromStep = Number(rawFromStep)
    }
    const replayModel =
      typeof replayOpts.model === 'string' ? replayOpts.model : undefined
    return {
      initialPrompt: null,
      clearLogs: false,
      continue: false,
      continueId: null,
      trustProjectAgents: false,
      replay: {
        runId,
        ...(fromStep !== undefined ? { fromStep } : {}),
        ...(replayModel ? { model: replayModel } : {}),
        json: replayOpts.json === true,
      },
    }
  }

  if (userArgs[0] === 'dash') {
    // `openbuff dash` subcommand (P2-T7): localhost+token dashboard over the
    // run journals, receipts, and gate timelines, or a static HTML export
    // with --export. Kept off the top-level program for exactly the reason
    // the comment above names for `serve`: registering `.command('dash')`
    // there would break positional prompts. The dashboard serves on
    // 127.0.0.1 ONLY and prints its URL to stdout; the token (when the CLI
    // generates one) is printed to stderr because stdout may be piped.
    const dashProgram = new Command()
    dashProgram
      .name('openbuff dash')
      .description(
        'Serve the local run/receipt/gate dashboard on 127.0.0.1 (or export it as static HTML with --export)',
      )
      .option(
        '--port <n>',
        'TCP port to bind on 127.0.0.1 (default: 0 = random free port)',
      )
      .option(
        '--token <t>',
        'Dashboard auth token (generated and printed to stderr when omitted)',
      )
      .option(
        '--export <dir>',
        'Export the dashboard as static HTML + JSON into <dir> instead of serving (mutually exclusive with serving)',
      )
      .option(
        '--no-open',
        'Do not print the dashboard URL on startup (no browser is auto-opened either way)',
      )
      .allowExcessArguments(true)
    if (options.exitOverride) {
      dashProgram.exitOverride()
    }
    // Re-attach the node/script prefix and drop the leading `dash` token so
    // commander parses only the dash-specific options.
    dashProgram.parse([argv[0], argv[1], ...userArgs.slice(1)])
    const dashOpts = dashProgram.opts()
    // Fail-closed --port validation, mirroring the --from-step contract:
    // commander passes the raw string through, so a strict DECIMAL integer
    // check runs first ('' / '0x10' / '1e2' must never silently parse).
    let port: number | undefined
    if (typeof dashOpts.port === 'string') {
      const rawPort = dashOpts.port.trim()
      if (!/^\d+$/.test(rawPort)) {
        dashProgram.error(
          `--port must be a non-negative integer, got ${JSON.stringify(dashOpts.port)}`,
        )
      }
      port = Number(rawPort)
      if (port > 65535) {
        dashProgram.error(`--port must be at most 65535, got ${port}`)
      }
    }
    // SEC: an explicitly EMPTY --token ("" or whitespace) is an auth bypass
    // — any client satisfies an empty expected token — so it is rejected,
    // never carried. Omitting the flag stays the documented path (the CLI
    // honors OPENBUFF_DASH_TOKEN, else generates a 256-bit CSPRNG token and
    // prints it to stderr).
    if (
      typeof dashOpts.token === 'string' &&
      dashOpts.token.trim().length === 0
    ) {
      dashProgram.error('--token must not be empty (omit it to generate one)')
    }
    // An explicitly EMPTY --export ("" or whitespace) must fail closed too:
    // silently dropping it below would degrade the invocation to SERVE mode,
    // so a user asking for a static export would get a token-generating
    // server instead of files. Same empty-value danger contract as --token.
    if (
      typeof dashOpts.export === 'string' &&
      dashOpts.export.trim().length === 0
    ) {
      dashProgram.error('--export must not be empty (pass a directory path)')
    }
    const dashTokenArg =
      typeof dashOpts.token === 'string' && dashOpts.token.length > 0
        ? dashOpts.token
        : undefined
    const dashExportDir =
      typeof dashOpts.export === 'string' && dashOpts.export.length > 0
        ? dashOpts.export
        : undefined
    return {
      initialPrompt: null,
      clearLogs: false,
      continue: false,
      continueId: null,
      trustProjectAgents: false,
      dash: {
        ...(port !== undefined ? { port } : {}),
        ...(dashTokenArg ? { token: dashTokenArg } : {}),
        ...(dashExportDir ? { exportDir: dashExportDir } : {}),
        open: dashOpts.open !== false,
      },
    }
  }

  const program = new Command()
  program
    .name('openbuff')
    .description('Local/BYOK AI coding assistant')
    .version(options.version, '-v, --version', 'Print the CLI version')
    .option(
      '--agent <agent-id>',
      'Run a specific agent id (skips loading local .agents overrides)',
    )
    .option('--clear-logs', 'Remove any existing CLI log files before starting')
    .option(
      '--continue [conversation-id]',
      'Continue from a previous conversation (optionally specify a conversation id)',
    )
    .option(
      '--cwd <directory>',
      'Set the working directory (default: current directory)',
    )
    .option('--plan', 'Start in PLAN mode')
    .option('--local', 'Local/BYOK mode (default; kept for compatibility)')
    .option(
      '--trust-project-agents',
      'Allow executable agents and MCP config from this project or its parent directory',
    )
    .option(
      '--attach',
      'Attach to a running `openbuff serve` over ACP instead of running in-process',
    )
    .option(
      '--serve-socket <path>',
      'Unix socket of a running `openbuff serve` (used with --attach; or OPENBUFF_SERVE_SOCKET)',
    )
    .option(
      '--serve-token <token>',
      'Auth token for --serve-socket (or OPENBUFF_SERVE_TOKEN)',
    )
    .addHelpText(
      'after',
      '\nCommands:\n  init                           Create local project context',
    )
    .helpOption('-h, --help', 'Show this help message')
    .argument('[prompt...]', 'Initial prompt to send to the agent')
    .allowExcessArguments(true)

  if (options.exitOverride) {
    program.exitOverride()
  }
  program.parse(argv)

  const parsed = program.opts()
  const continueFlag = parsed.continue
  // P1-T3: --attach is OFF by default. The parser resolves flags only — the
  // OPENBUFF_SERVE_SOCKET/TOKEN fallback VALUES are applied by
  // cli/src/index.tsx — but the injected `options.env` (never ambient
  // process.env) is consulted here so the documented fallback satisfies the
  // completeness check below instead of hard-erroring before the entry can
  // apply it (the error's own remedy must be reachable).
  const envSocketRaw = options.env?.OPENBUFF_SERVE_SOCKET
  const envSocketPath =
    typeof envSocketRaw === 'string' && envSocketRaw.length > 0
      ? envSocketRaw
      : undefined
  const attachSocketPath =
    typeof parsed.serveSocket === 'string' && parsed.serveSocket.length > 0
      ? parsed.serveSocket
      : undefined
  const attachToken =
    typeof parsed.serveToken === 'string' && parsed.serveToken.length > 0
      ? parsed.serveToken
      : undefined
  const attach =
    parsed.attach === true
      ? {
          ...(attachSocketPath ? { socketPath: attachSocketPath } : {}),
          ...(attachToken ? { token: attachToken } : {}),
        }
      : undefined
  if (parsed.attach === true && !attachSocketPath && !envSocketPath) {
    program.error(
      '--attach requires a serve socket: pass --serve-socket <path> or set OPENBUFF_SERVE_SOCKET',
    )
  }
  return {
    initialPrompt: program.args.length > 0 ? program.args.join(' ') : null,
    agent: parsed.agent,
    clearLogs: parsed.clearLogs || false,
    continue: Boolean(continueFlag),
    continueId:
      typeof continueFlag === 'string' && continueFlag.trim().length > 0
        ? continueFlag.trim()
        : null,
    cwd: parsed.cwd,
    initialMode: parsed.plan ? 'PLAN' : undefined,
    trustProjectAgents: parsed.trustProjectAgents === true,
    serve: undefined,
    mcp: undefined,
    ...(attach ? { attach } : {}),
  }
}
