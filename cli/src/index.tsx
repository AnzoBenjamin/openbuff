#!/usr/bin/env bun

// Embed tree-sitter.wasm into the bun-compile binary at a bunfs path the runtime
// can find. Without this, web-tree-sitter resolves the wasm via require.resolve,
// which (since 0.25.10's split exports map) returns the build-time absolute path
// of tree-sitter.cjs and fails on user machines. Must run before the SDK / code-map
// import chain triggers Parser.init.
import './pre-init/tree-sitter-wasm'

import fs from 'fs'
import { createRequire } from 'module'
import os from 'os'
import path from 'path'

import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import { CHATGPT_OAUTH_ENABLED } from '@codebuff/common/constants/chatgpt-oauth'
import { getProjectFileTree } from '@codebuff/common/project-file-tree'
import { createCliRenderer } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot } from '@opentui/react'
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
} from '@tanstack/react-query'
import { red } from 'picocolors'
import React from 'react'

import { App } from './app'
import { applyOscDetectedThemeToStore } from './hooks/use-theme'
import { initializeApp, switchProjectContext } from './init/init-app'
import { getRgPath } from './native/ripgrep'
import { getProjectRoot, startNewChat } from './project-files'
import {
  awaitRegistriesReady,
  startDeferredRegistryLoads,
} from './services/deferred-registries'
import { connectChatGptOAuth } from './utils/chatgpt-oauth'
import { trackEvent } from './utils/analytics'
import {
  resetCodebuffClient,
  setAttachTarget,
} from './utils/codebuff-client'
import { getCliEnv } from './utils/env'
import { initializeAgentRegistry } from './utils/local-agent-registry'
import { clearLogFile, logger } from './utils/logger'
import { shouldShowProjectPicker } from './utils/project-picker'
import { saveRecentProject } from './utils/recent-projects'
import {
  installProcessCleanupHandlers,
  TERMINAL_RESET_SEQUENCES,
} from './utils/renderer-cleanup'
import { initializeSkillRegistry } from './utils/skill-registry'
import { detectTerminalTheme } from './utils/terminal-color-detection'
import { detectTerminalImageSupport } from './utils/terminal-images'
import { setOscDetectedTheme } from './utils/theme-system'
import { isTrustedProjectRoot, loadTrustedRoots } from './utils/trusted-roots'

import type { FileTreeNode } from '@codebuff/common/util/file'
import { publishWasmBinary } from './pre-init/tree-sitter-wasm'
import { runAcpServeCommand } from './serve-command'
import { runMcpCommand } from './commands/mcp-command'
import { runReplayCommand } from './commands/replay-command'
import { runHeadlessCommand } from './commands/run-command'
import { isRendererCommand, parseCliArgs } from './cli-args'
import { runDashCommand } from './commands/dash-command'

const require = createRequire(import.meta.url)

const WASM_MAX_BYTES = 8 * 1024 * 1024

let cachedHomeDirValue: string | undefined
function getCachedHomeDir(): string {
  if (cachedHomeDirValue !== undefined) return cachedHomeDirValue
  try {
    cachedHomeDirValue = os.homedir()
  } catch {
    cachedHomeDirValue = ''
  }
  return cachedHomeDirValue
}

function loadPackageVersion(): string {
  const env = getCliEnv()
  if (env.CODEBUFF_CLI_VERSION) {
    return env.CODEBUFF_CLI_VERSION
  }

  try {
    const pkg = require('../package.json') as { version?: string }
    if (pkg.version) {
      return pkg.version
    }
  } catch {
    // Continue to dev fallback
  }

  return 'dev'
}

// Configure TanStack Query's focusManager for terminal environments
// This is required because there's no browser visibility API in terminal apps
// Without this, refetchInterval won't work because TanStack Query thinks the app is "unfocused"
focusManager.setEventListener(() => {
  // No-op: no event listeners in CLI environment (no window focus/visibility events)
  return () => {}
})
focusManager.setFocused(true)

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5 * 60 * 1000, // 5 minutes - auth tokens don't change frequently
        gcTime: 10 * 60 * 1000, // 10 minutes - keep cached data a bit longer
        retry: false, // Don't retry failed auth queries automatically
        refetchOnWindowFocus: false, // CLI doesn't have window focus
        refetchOnReconnect: true, // Refetch when network reconnects
        refetchOnMount: false, // Don't refetch on every mount
      },
      mutations: {
        retry: 1, // Retry mutations once on failure
      },
    },
  })
}

async function main(): Promise<void> {
  // CI/release gate: prove that the packaged OpenTUI native library can be
  // resolved and can create a renderer without depending on terminal output.
  // Uses the OpenTUI 0.5 test renderer (createTestRenderer from
  // @opentui/core/testing): it drives the renderer with a mock stdin and never
  // takes over the terminal, since full-screen rendering is not deterministic
  // when stdout is a pipe (notably on legacy Intel macOS). The 0.2.x
  // `testing: true` renderer config option was removed in 0.5.x, so the probe
  // can no longer disable terminal takeover that way. The release smoke test
  // uses this explicit probe for the native FFI boundary and tests full TUI
  // rendering separately where the platform supports it reliably.
  if (process.argv.includes('--smoke-opentui')) {
    try {
      const { renderer } = await createTestRenderer({
        exitSignals: [],
        useThread: process.platform !== 'linux',
      })
      await renderer.destroy()
      // Marker consumed by cli/scripts/smoke-binary.ts. Keep exact text.
      console.log('opentui smoke ok')
      process.exit(0)
    } catch (err) {
      console.error('opentui smoke FAIL:', err)
      process.exit(1)
    }
  }

  // CI gate: `<binary> --smoke-tree-sitter` proves the embedded wasm boots
  // through Parser.init end-to-end. Has to live BEFORE commander.parse() —
  // an earlier attempt put this in a pre-init module with top-level await,
  // and on Windows that didn't actually pause module evaluation (commander
  // still ran first and rejected the unknown flag).
  if (process.argv.includes('--smoke-tree-sitter')) {
    const wasmBinary = (
      globalThis as { __CODEBUFF_TREE_SITTER_WASM_BINARY__?: Uint8Array }
    ).__CODEBUFF_TREE_SITTER_WASM_BINARY__
    const wasmPath = (
      globalThis as { __CODEBUFF_TREE_SITTER_WASM_PATH__?: string }
    ).__CODEBUFF_TREE_SITTER_WASM_PATH__

    // Diagnostic dump so CI logs (and bug reports) show exactly what
    // the runtime saw when smoke fails. process.execPath, the
    // siblingPath we expect, and what's actually in that directory.
    // RF-6: truncation already applied (30 entries) and PII-redacted — full absolute paths are not dumped in CI logs.
    const execDir = path.dirname(process.execPath)
    const siblingPath = path.join(execDir, 'tree-sitter.wasm')
    let dirListing: string[] = []
    let dirEntryCount = 0
    let dirTruncated = false
    try {
      const entries = await fs.promises.readdir(execDir)
      dirEntryCount = entries.length
      dirListing = entries.slice(0, 30)
      dirTruncated = entries.length > 30
    } catch (err) {
      dirListing = [
        `<readdir failed: ${err instanceof Error ? err.message : err}>`,
      ]
    }
    let siblingExists = false
    try {
      await fs.promises.access(siblingPath)
      siblingExists = true
    } catch {
      siblingExists = false
    }
    // Redact PII (home dir) and bound output length before CI log emission.
    const cachedHomeDir = getCachedHomeDir()
    const redactSmokePath = (p: string): string => {
      const home = cachedHomeDir
      let out =
        home && p.startsWith(home)
          ? `~${p.slice(home.length)}`
          : path.basename(p) || p
      // Keep only last 80 chars; prevents long user-specific paths leaking in logs.
      if (out.length > 80) out = `…${out.slice(-80)}`
      return out
    }
    const redactedListing = dirListing.map((e) => {
      // e is a bare dir entry name, not a full path — skip home/basename redaction
      let out = e
      if (out.length > 80) out = `…${out.slice(-80)}`
      return out
    })
    console.error(
      `[smoke diag] execPath=${redactSmokePath(process.execPath)}\n` +
        `[smoke diag] execDir=${redactSmokePath(execDir)}\n` +
        `[smoke diag] siblingPath=${redactSmokePath(siblingPath)}\n` +
        `[smoke diag] siblingExists=${siblingExists}\n` +
        `[smoke diag] dir contents (${dirTruncated ? `${dirEntryCount} total, showing 30` : String(dirEntryCount)}): ${redactedListing.join(', ')}${dirTruncated ? ' (truncated to 30)' : ''}\n` +
        `[smoke diag] globalThis wasmPath=${wasmPath ? redactSmokePath(wasmPath) : '<unset>'}\n` +
        `[smoke diag] globalThis wasmBinary bytes=${wasmBinary?.byteLength ?? 0}\n`,
    )

    try {
      const { Parser } = await import('web-tree-sitter')
      // P1-T9: the wasm byte read is deferred out of module import time, so
      // this is the first actual use — read + publish the bytes now.
      publishWasmBinary()
      // Pick the best wasm source available, falling back to the
      // sibling-of-execPath lookup if pre-init couldn't reach it. By
      // main() time process.execPath has stabilized to the disk path
      // even on Windows, where it was the bunfs path during pre-init.
      let effectiveBinary =
        wasmBinary ??
        (globalThis as { __CODEBUFF_TREE_SITTER_WASM_BINARY__?: Uint8Array })
          .__CODEBUFF_TREE_SITTER_WASM_BINARY__
      let effectivePath = wasmPath
      if (!effectiveBinary && !effectivePath) {
        try {
          const siblingStat = await fs.promises.stat(siblingPath)
          if (
            !siblingStat.isFile() ||
            siblingStat.size <= 0 ||
            siblingStat.size > WASM_MAX_BYTES
          ) {
            console.error(
              `[smoke diag] sibling wasm size out of bounds: ${siblingStat.size} bytes (cap ${WASM_MAX_BYTES})`,
            )
          } else {
            const data = await fs.promises.readFile(siblingPath)
            // Re-check byteLength after read to close stat+read TOCTOU (file could
            // have grown between stat and read past 8MiB cap); bound even if raced.
            if (data.byteLength > 0 && data.byteLength <= WASM_MAX_BYTES) {
              effectivePath = siblingPath
              effectiveBinary = new Uint8Array(data)
            } else {
              console.error(
                `[smoke diag] sibling wasm size out of bounds: ${data.byteLength} bytes (cap ${WASM_MAX_BYTES})`,
              )
            }
          }
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code
          if (code !== 'ENOENT') {
            console.error(
              `[smoke diag] sibling wasm fallback read failed: ${err instanceof Error ? err.message : err}`,
            )
          }
        }
      }

      if (effectiveBinary) {
        await Parser.init({ wasmBinary: effectiveBinary })
        // Marker grepped by cli/scripts/smoke-binary.ts — keep this exact text.
        console.log(
          `tree-sitter smoke ok (wasmBinary, ${effectiveBinary.byteLength} bytes)`,
        )
      } else if (effectivePath) {
        await Parser.init({
          locateFile: (name: string) =>
            name === 'tree-sitter.wasm' ? effectivePath! : name,
        })
        console.log(
          `tree-sitter smoke ok (locateFile, path=${redactSmokePath(effectivePath)})`,
        )
      } else {
        console.error(
          'tree-sitter smoke FAIL: no wasm available — pre-init published ' +
            'nothing and the sibling-of-execPath fallback also missed. See ' +
            'the diag above for paths.',
        )
        process.exit(1)
      }
      process.exit(0)
    } catch (err) {
      console.error('tree-sitter smoke FAIL:', err)
      process.exit(1)
    }
  }

  // Smoke-gate only: strip --smoke-bootscreen before commander.parse so the flag
  // is never rejected as an unknown option (the other --smoke-* probes handle
  // their own flags pre-parse and exit; this one must continue to full boot).
  const smokeBootscreen = process.argv.includes('--smoke-bootscreen')
  const cliArgv = process.argv.filter((arg) => arg !== '--smoke-bootscreen')

  // `openbuff login chatgpt` (ChatGPT subscription OAuth login). Handled
  // here — BEFORE parseCliArgs — because the top-level commander program
  // has no `login` subcommand: left unhandled, the tokens parse as an
  // initial prompt and the TUI launches instead of logging in. The ACP
  // initialize() auth method for terminal-capable clients advertises
  // exactly this argv (`login chatgpt`), so the advertised method must
  // resolve to a working command. ONLY that exact argv is intercepted: any
  // other `login ...` invocation (e.g. the initial prompt `openbuff login
  // to my account`) keeps the pre-existing CLI contract and launches the
  // TUI with that prompt. Output goes to stdout/stderr only; the
  // OAuth flow opens the browser itself and bounds its own wait (5-minute
  // callback timeout), so nothing here can hang forever.
  if (
    CHATGPT_OAUTH_ENABLED &&
    cliArgv[2] === 'login' &&
    cliArgv[3]?.trim() === 'chatgpt'
  ) {
    try {
      const { credentials } = connectChatGptOAuth()
      await credentials
      console.log('openbuff login: ChatGPT connected.')
      process.exit(0)
    } catch (error) {
      console.error(
        'openbuff login failed:',
        error instanceof Error ? error.message : String(error),
      )
      process.exit(1)
    }
  }

  let smokeBootscreenTimer: ReturnType<typeof setTimeout> | null = null
  let smokeBootscreenEmitted = false
  if (smokeBootscreen && !process.stdout.isTTY) {
    // On Windows with non-TTY stdout OpenTUI paints nothing, so it never drives React's
    // passive-effect flush and a useEffect-emitted marker would stay scheduled
    // but never run, leaving the harness to SIGKILL a silent child. Emit from
    // main() on a short grace timer instead. smoke-binary.ts still scans the
    // full window for FATAL_PATTERNS, so any later async startup crash is caught.
    // Schedule BEFORE any awaits (renderer/app init may hang on Windows pipes
    // and would otherwise prevent this timer from ever being registered).
    // RF-3: intentionally ref'd (no .unref()) so the 1.5s grace window keeps the event loop alive until the marker can fire; cleared on earlyFatalHandler and after renderer creation so it never keeps the process alive after renderer.destroy() or successful boot.
    smokeBootscreenTimer = setTimeout(() => {
      smokeBootscreenEmitted = true
      console.log('openbuff bootscreen ok')
      smokeBootscreenTimer = null
    }, 1500)
  }

  const parsedArgs = parseCliArgs(cliArgv, {
    version: loadPackageVersion(),
    // Inject the attach env fallback (OPENBUFF_SERVE_SOCKET) so parseCliArgs
    // can validate the documented `--attach` completeness contract without
    // reading ambient process.env itself.
    env: getCliEnv(),
  })
  const {
    initialPrompt,
    agent,
    clearLogs,
    continue: continueChat,
    continueId,
    cwd,
    initialMode,
    trustProjectAgents,
    serve,
    mcp,
    run,
    replay,
    dash,
    attach,
  } = parsedArgs

  // Start OSC theme detection so it runs CONCURRENTLY with CLI init (P1-T9),
  // but ONLY on paths that end in the OpenTUI renderer. The serve/mcp/run/replay
  // commands return from main() before the renderer is created and use
  // stdin/stdout as the ACP/MCP/ndjson protocol wire; the OSC probe puts stdin
  // into raw mode with a 'data' listener and writes its query to the TTY, so
  // starting it on those paths would interleave with protocol traffic and
  // corrupt wire framing. parseCliArgs is pure and synchronous, so starting the
  // probe here — immediately after arg parsing — still overlaps all of
  // initializeApp and the rest of startup; the promise is only awaited
  // immediately before the renderer is created, so the probe never shares stdin
  // with OpenTUI. The resolved theme is fed to setOscDetectedTheme + the theme
  // store exactly as before.
  const oscThemePromise: Promise<'dark' | 'light' | null> =
    isRendererCommand(parsedArgs) &&
    process.stdin.isTTY &&
    process.platform !== 'win32'
      ? detectTerminalTheme().catch(() => null)
      : Promise.resolve(null)

  // P1-T3: record the attach target BEFORE any client is created so
  // getCodebuffClient() (and the TUI's hook) builds the ACP-remote backend.
  // The socket path and auth token come from --serve-socket/--serve-token,
  // falling back to OPENBUFF_SERVE_SOCKET/OPENBUFF_SERVE_TOKEN. The parser
  // reads no ambient env: it validates completeness against the injected
  // getCliEnv() above, and the fallback VALUES are applied here in the entry.
  if (attach) {
    const socketPath = attach.socketPath ?? getCliEnv().OPENBUFF_SERVE_SOCKET
    if (socketPath) {
      setAttachTarget({
        socketPath,
        token: attach.token ?? getCliEnv().OPENBUFF_SERVE_TOKEN,
      })
    }
  }

  const isPublishCommand = cliArgv[2] === 'publish'
  const hasAgentOverride = Boolean(agent?.trim())

  await initializeApp({ cwd })

  // Show project picker only when user starts at the home directory or an ancestor
  const projectRoot = getProjectRoot()
  const homeDir = getCachedHomeDir()
  const startCwd = process.cwd()
  const showProjectPicker = shouldShowProjectPicker(startCwd, homeDir)

  // Requires analytics to be initialized, which is done in initializeApp
  trackEvent(AnalyticsEvent.APP_LAUNCHED, {
    version: loadPackageVersion(),
    platform: process.platform,
    arch: process.arch,
    hasInitialPrompt: Boolean(initialPrompt),
    hasAgentOverride: hasAgentOverride,
    continueChat,
    initialMode: initialMode ?? 'DEFAULT',
  })

  // NEW-2 serve trust (design §12.8): `openbuff serve` loads project-scope
  // `.agents/**` agent definitions and project `.agents/mcp.json` ONLY when
  // the user started serve with `--trust-project-agents` OR the project
  // root's realpath appears in the user-level allowlist
  // (~/.config/openbuff/trusted-roots.json, owner-only 0600). Trust is never
  // inferred from `session/new` cwd or any client-supplied field, and every
  // allowlist read/validation error fails closed (untrusted). On the TUI
  // path `effectiveTrust` stays equal to the raw `--trust-project-agents`
  // flag, so non-serve behavior is unchanged.
  let effectiveTrust = trustProjectAgents
  if (serve) {
    // The serve subcommand carries its own --trust-project-agents; the
    // top-level program hardcodes trustProjectAgents to false for serve runs.
    effectiveTrust = serve.trustProjectAgents
    if (!effectiveTrust) {
      try {
        effectiveTrust = isTrustedProjectRoot(
          fs.realpathSync(projectRoot),
          await loadTrustedRoots(),
        )
      } catch {
        // Fail closed: realpathSync threw (e.g. missing project root) so
        // serve stays untrusted (effectiveTrust is false here).
      }
    }
  }

  // P1-T9: the agent/skill registries are NOT awaited here. They are started
  // (not awaited) just before the renderer mounts below, so the .agents disk
  // scan overlaps startup instead of serializing ahead of the first render.
  // Consumers gate on whenRegistriesReady(); the serve/mcp/run/replay command
  // paths keep their previous (command-managed) behavior by awaiting the
  // deferred loads via awaitRegistriesReady() in their dispatch blocks below
  // — before handing control to the command, so the registries are fully
  // initialized exactly as they were before the deferral.
  const shouldLoadAgents = isPublishCommand || !hasAgentOverride

  // Handle publish command before rendering the app
  if (isPublishCommand) {
    logger.error(red('Agent publishing is disabled in local mode.'))
    process.exit(1)
  }

  // `openbuff serve` never launches the OpenTUI renderer: stdout is the ACP
  // protocol wire, so we start the bridge and return from main() before the
  // renderer is created. The stdio/socket transport keeps the event loop alive.
  if (serve) {
    // Restore the pre-P1-T9 contract on this non-renderer path: the agent
    // and skill registries are fully initialized before the bridge starts
    // (previously they were awaited synchronously in main()).
    await awaitRegistriesReady({ shouldLoadAgents, effectiveTrust })
    await runAcpServeCommand({ ...serve, trustProjectAgents: effectiveTrust })
    return
  }

  // `openbuff mcp` never launches the OpenTUI renderer either: stdout is the
  // MCP protocol wire, so we start the server and return from main() before
  // the renderer is created. The stdio transport keeps the event loop alive.
  if (mcp) {
    // Restore the pre-P1-T9 contract on this non-renderer path: the agent
    // and skill registries are fully initialized before the MCP server
    // starts (previously they were awaited synchronously in main()).
    await awaitRegistriesReady({ shouldLoadAgents, effectiveTrust })
    await runMcpCommand(mcp)
    return
  }

  // `openbuff run` (P1-T5) never launches the OpenTUI renderer either: stdout
  // is the machine-readable stream in --json mode, so we run the agent
  // headlessly and set the process exit code from the run outcome. Prefer
  // `process.exitCode = code` over `process.exit(code)` so the event loop
  // drains cleanly (flushing the ndjson stream) before the process exits.
  if (run) {
    // Restore the pre-P1-T9 contract on this non-renderer path: the agent
    // and skill registries are fully initialized before the headless run
    // starts (previously they were awaited synchronously in main()).
    await awaitRegistriesReady({ shouldLoadAgents, effectiveTrust })
    const code = await runHeadlessCommand(run)
    process.exitCode = code
    return
  }

  // `openbuff replay` (P2-T3) never launches the OpenTUI renderer either:
  // stdout is the machine-readable stream in --json mode, so we replay the
  // journaled run deterministically and set the process exit code from the
  // replay outcome. Prefer `process.exitCode = code` over `process.exit(code)`
  // so the event loop drains cleanly (flushing the ndjson stream) before the
  // process exits.
  if (replay) {
    // Restore the pre-P1-T9 contract on this non-renderer path: the agent
    // and skill registries are fully initialized before the replay starts
    // (previously they were awaited synchronously in main()).
    await awaitRegistriesReady({ shouldLoadAgents, effectiveTrust })
    const code = await runReplayCommand(replay)
    process.exitCode = code
    return
  }

  // `openbuff dash` (P2-T7) never launches the OpenTUI renderer either: in
  // serve mode stdout carries the dashboard URL (a generated token goes to
  // stderr — stdout may be piped) and in --export mode it carries the written
  // file paths, so we run the command and set the process exit code from the
  // outcome. P2-T7 follow-up LANDED: the dash now reads the LIVE run journal
  // at the shared cli/src/utils/run-journal-path.ts location (opened
  // read-only, only after the file exists — never created from the dash
  // side; absent/unopenable falls back to empty data with a stderr
  // warning), so runs journaled by the TUI (`use-send-message.ts`) and
  // headless (`run-command.ts`) processes surface in the dashboard.
  // Explicit journalReader/receipts/gateState seams still win for tests.
  if (dash) {
    const code = await runDashCommand(dash)
    process.exitCode = code
    return
  }

  if (clearLogs) {
    clearLogFile()
  }

  // P1-T9: pre-warm ripgrep extraction. getRgPath() is memoized and otherwise
  // only called lazily on the first code_search (codebuff-client.ts), so
  // starting it here — fire-and-forget, in parallel with renderer creation —
  // lets the extraction overlap startup instead of taxing the first search.
  // Best-effort: never blocks the first frame, and a failure only logs (the
  // lazy path re-runs later and reports the same way).
  void getRgPath().catch((error) => {
    logger.debug({ error }, 'ripgrep pre-warm failed')
  })

  // P1-T9: start the deferred agent/skill registry loads BEFORE the renderer
  // mounts. The .agents / .agents/skills scans are async, so they overlap
  // renderer creation instead of serializing ahead of the first frame — but
  // starting them here (not in a mount effect) binds the whenRegistriesReady()
  // promise before any consumer subscribes: React runs child effects before
  // parent effects, so an effect-started load would race (and lose to) the
  // mount-time registry reads in chat.tsx that gate on it.
  startDeferredRegistryLoads({ shouldLoadAgents, effectiveTrust })

  const queryClient = createQueryClient()

  const AppWithAsyncAuth = () => {
    const [fileTree, setFileTree] = React.useState<FileTreeNode[]>([])
    const [currentProjectRoot, setCurrentProjectRoot] =
      React.useState(projectRoot)
    const [showProjectPickerScreen, setShowProjectPickerScreen] =
      React.useState(showProjectPicker)

    const loadFileTree = React.useCallback(async (root: string) => {
      try {
        if (root) {
          const tree = await getProjectFileTree({
            projectRoot: root,
            fs: fs.promises,
          })
          setFileTree(tree)
        }
      } catch (error) {
        logger.warn(
          { error },
          'Failed to load the initial project file tree for suggestions',
        )
      }
    }, [])

    React.useEffect(() => {
      loadFileTree(currentProjectRoot)
    }, [currentProjectRoot, loadFileTree])

    // Callback for when user selects a new project from the picker
    const handleProjectChange = React.useCallback(
      async (newProjectPath: string) => {
        const previousProjectRoot = getProjectRoot()

        try {
          await switchProjectContext(newProjectPath)
          await resetCodebuffClient()
          if (isPublishCommand || !hasAgentOverride) {
            await initializeAgentRegistry({ trustProjectAgents })
          }
          await initializeSkillRegistry({
            trustProjectSkills: trustProjectAgents,
          })
          startNewChat()

          // Track directory change (avoid logging full paths for privacy)
          const isGitRepo = fs.existsSync(path.join(newProjectPath, '.git'))
          const pathDepth = newProjectPath
            .split(path.sep)
            .filter(Boolean).length
          trackEvent(AnalyticsEvent.CHANGE_DIRECTORY, {
            isGitRepo,
            pathDepth,
            isHomeDir: (() => {
              const h = getCachedHomeDir()
              return h !== '' && newProjectPath === h
            })(),
          })
          saveRecentProject(newProjectPath)
          setCurrentProjectRoot(getProjectRoot())
          setFileTree([])
          setShowProjectPickerScreen(false)
        } catch (error) {
          await switchProjectContext(previousProjectRoot)
          await resetCodebuffClient()
          logger.error({ error }, 'Failed to switch projects')
          throw error
        }
      },
      [trustProjectAgents, hasAgentOverride, isPublishCommand],
    )

    return (
      <App
        key={currentProjectRoot}
        initialPrompt={initialPrompt}
        agentId={agent}
        fileTree={fileTree}
        continueChat={continueChat}
        continueChatId={continueId ?? undefined}
        initialMode={initialMode}
        showProjectPicker={showProjectPickerScreen}
        onProjectChange={handleProjectChange}
      />
    )
  }

  // Install early error handlers BEFORE renderer creation.
  // If the renderer crashes during init, these ensure the error is visible
  // by exiting the alternate screen buffer before printing the error.
  const earlyFatalHandler = (error: unknown) => {
    if (smokeBootscreenTimer) clearTimeout(smokeBootscreenTimer)
    try {
      if (process.stdin.isTTY && process.stdin.setRawMode) {
        process.stdin.setRawMode(false)
      }
    } catch {
      // stdin may be closed
    }
    try {
      if (process.stdout.isTTY) {
        process.stdout.write(TERMINAL_RESET_SEQUENCES)
      }
    } catch {
      // stdout may be closed
    }
    try {
      console.error('Fatal error during startup:', error)
    } catch {
      // stderr may be closed
    }
    process.exit(1)
  }
  process.on('uncaughtException', earlyFatalHandler)
  process.on('unhandledRejection', earlyFatalHandler)

  // Resolve the (already-started) OSC probe BEFORE creating the renderer: OSC
  // responses arrive on stdin, which OpenTUI is about to take over, so the
  // probe must finish first. This await is not the up-to-600ms serialized cost
  // it used to be — the probe ran concurrently with all of the init above.
  {
    const oscTheme = await oscThemePromise
    if (oscTheme) {
      setOscDetectedTheme(oscTheme)
      // The probe may have resolved after initializeApp() built the theme
      // store from env/IDE detectors; apply the OSC result to the store so
      // the rendered theme matches the resolved value exactly.
      applyOscDetectedThemeToStore()
    }
  }

  const renderer = await createCliRenderer({
    backgroundColor: 'transparent',
    exitOnCtrlC: false,
    screenMode: 'alternate-screen',
    // D47 Stage 4: request the raw kitty image transport when our protocol
    // detection says the terminal runs kitty — our detection module stays the
    // source of truth (kittyImageTransport verified on CliRendererConfig in
    // node_modules/@opentui/core/renderer.d.ts). Omitted otherwise so
    // OpenTUI's own capability probing applies.
    ...(detectTerminalImageSupport() === 'kitty'
      ? { kittyImageTransport: 'raw' as const }
      : {}),
  })

  if (smokeBootscreenTimer) {
    clearTimeout(smokeBootscreenTimer)
    smokeBootscreenTimer = null
  }
  if (smokeBootscreen && !smokeBootscreenEmitted) {
    console.log('openbuff bootscreen ok')
  }

  // Remove early handlers — proper cleanup handlers (with renderer access) take over
  process.removeListener('uncaughtException', earlyFatalHandler)
  process.removeListener('unhandledRejection', earlyFatalHandler)
  installProcessCleanupHandlers(renderer)

  createRoot(renderer).render(
    <QueryClientProvider client={queryClient}>
      <AppWithAsyncAuth />
    </QueryClientProvider>,
  )
}

void main()
