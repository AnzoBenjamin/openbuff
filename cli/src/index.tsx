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
import { getProjectFileTree } from '@codebuff/common/project-file-tree'
import { createCliRenderer } from '@opentui/core'
import { createRoot } from '@opentui/react'
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
} from '@tanstack/react-query'
import { green, red } from 'picocolors'
import React from 'react'

import { App } from './app'
import { parseCliArgs } from './cli-args'
import { initializeApp, switchProjectContext } from './init/init-app'
import { getProjectRoot, startNewChat } from './project-files'
import { trackEvent } from './utils/analytics'
import { resetCodebuffClient } from './utils/codebuff-client'
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
import { setOscDetectedTheme } from './utils/theme-system'

import type { FileTreeNode } from '@codebuff/common/util/file'

const require = createRequire(import.meta.url)

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
  // Full-screen rendering is not deterministic when stdout is a pipe (notably
  // on legacy Intel macOS), so the release smoke test uses this explicit probe
  // for the native FFI boundary and tests full TUI rendering separately where
  // the platform supports it reliably.
  if (process.argv.includes('--smoke-opentui')) {
    try {
      const renderer = await createCliRenderer({
        exitSignals: [],
        testing: true,
        useThread: process.platform !== 'linux',
      })
      renderer.destroy()
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
    try {
      dirListing = fs.readdirSync(execDir)
    } catch (err) {
      dirListing = [
        `<readdir failed: ${err instanceof Error ? err.message : err}>`,
      ]
    }
    // Redact PII (home dir) and bound output length before CI log emission.
    const redactSmokePath = (p: string): string => {
      const home = os.homedir()
      let out = home && p.startsWith(home) ? `~${p.slice(home.length)}` : path.basename(p) || p
      // Keep only last 80 chars; prevents long user-specific paths leaking in logs.
      if (out.length > 80) out = `…${out.slice(-80)}`
      return out
    }
    const redactedListing = dirListing.slice(0, 30).map((e) => redactSmokePath(e))
    console.error(
      `[smoke diag] execPath=${redactSmokePath(process.execPath)}\n` +
        `[smoke diag] execDir=${redactSmokePath(execDir)}\n` +
        `[smoke diag] siblingPath=${redactSmokePath(siblingPath)}\n` +
        `[smoke diag] siblingExists=${fs.existsSync(siblingPath)}\n` +
        `[smoke diag] dir contents (${dirListing.length}): ${redactedListing.join(', ')}\n` +
        `[smoke diag] globalThis wasmPath=${wasmPath ? redactSmokePath(wasmPath) : '<unset>'}\n` +
        `[smoke diag] globalThis wasmBinary bytes=${wasmBinary?.byteLength ?? 0}\n`,
    )

    try {
      const { Parser } = await import('web-tree-sitter')
      // Pick the best wasm source available, falling back to the
      // sibling-of-execPath lookup if pre-init couldn't reach it. By
      // main() time process.execPath has stabilized to the disk path
      // even on Windows, where it was the bunfs path during pre-init.
      let effectiveBinary = wasmBinary
      let effectivePath = wasmPath
      if (!effectiveBinary && !effectivePath && fs.existsSync(siblingPath)) {
        try {
          const stat = fs.statSync(siblingPath)
          // Guard unbounded read: cap sibling wasm to 8 MiB; corrupted/truncated
          // files beyond cap are rejected with a diagnostic instead of OOM.
          const WASM_MAX_BYTES = 8 * 1024 * 1024
          if (stat.size > 0 && stat.size <= WASM_MAX_BYTES) {
            effectivePath = siblingPath
            effectiveBinary = new Uint8Array(fs.readFileSync(siblingPath))
          } else {
            console.error(
              `[smoke diag] sibling wasm size out of bounds: ${stat.size} bytes (cap ${WASM_MAX_BYTES})`,
            )
          }
        } catch (err) {
          console.error(
            `[smoke diag] sibling wasm fallback read failed: ${err instanceof Error ? err.message : err}`,
          )
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
        console.log(`tree-sitter smoke ok (locateFile, path=${effectivePath})`)
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
  const cliArgv = process.argv.filter(
    (arg) => arg !== '--smoke-bootscreen',
  )

  let smokeBootscreenTimer: ReturnType<typeof setTimeout> | null = null
  if (smokeBootscreen && !process.stdout.isTTY) {
    // On Windows with non-TTY stdout OpenTUI paints nothing, so it never drives React's
    // passive-effect flush and a useEffect-emitted marker would stay scheduled
    // but never run, leaving the harness to SIGKILL a silent child. Emit from
    // main() on a short grace timer instead. smoke-binary.ts still scans the
    // full window for FATAL_PATTERNS, so any later async startup crash is caught.
    // Schedule BEFORE any awaits (renderer/app init may hang on Windows pipes
    // and would otherwise prevent this timer from ever being registered).
    smokeBootscreenTimer = setTimeout(() => {
      console.log('openbuff bootscreen ok')
    }, 1500)
    smokeBootscreenTimer.unref()
  }

  // Run OSC theme detection BEFORE anything else.
  // This MUST happen before OpenTUI starts because OSC responses come through stdin,
  // and OpenTUI also listens to stdin. Running detection here ensures stdin is clean.
  if (process.stdin.isTTY && process.platform !== 'win32') {
    try {
      const oscTheme = await detectTerminalTheme()
      if (oscTheme) {
        setOscDetectedTheme(oscTheme)
      }
    } catch {
      // Silently ignore OSC detection failures
    }
  }

  const {
    initialPrompt,
    agent,
    clearLogs,
    continue: continueChat,
    continueId,
    cwd,
    initialMode,
    trustProjectAgents,
  } = parseCliArgs(cliArgv, { version: loadPackageVersion() })

  const isPublishCommand = process.argv[2] === 'publish'
  const hasAgentOverride = Boolean(agent?.trim())

  await initializeApp({ cwd })

  // Show project picker only when user starts at the home directory or an ancestor
  const projectRoot = getProjectRoot()
  const homeDir = os.homedir()
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

  // Initialize agent registry (loads user agents via SDK).
  // When --agent is provided, skip local .agents to avoid overrides.
  if (isPublishCommand || !hasAgentOverride) {
    await initializeAgentRegistry({ trustProjectAgents })
  }

  // Initialize skill registry (loads skills from .agents/skills)
  await initializeSkillRegistry({ trustProjectSkills: trustProjectAgents })

  // Handle publish command before rendering the app
  if (isPublishCommand) {
    logger.error(red('Agent publishing is disabled in local mode.'))
    process.exit(1)
  }

  if (clearLogs) {
    clearLogFile()
  }

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
          resetCodebuffClient()
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
            isHomeDir: newProjectPath === os.homedir(),
          })
          saveRecentProject(newProjectPath)
          setCurrentProjectRoot(getProjectRoot())
          setFileTree([])
          setShowProjectPickerScreen(false)
        } catch (error) {
          await switchProjectContext(previousProjectRoot)
          resetCodebuffClient()
          logger.error({ error }, 'Failed to switch projects')
          throw error
        }
      },
      [],
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

  let renderer: Awaited<ReturnType<typeof createCliRenderer>> | null = null
  try {
    renderer = await createCliRenderer({
    backgroundColor: 'transparent',
    exitOnCtrlC: false,
    screenMode: 'alternate-screen',
  })

  } catch (error) {
    if (smokeBootscreenTimer) clearTimeout(smokeBootscreenTimer)
    throw error
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

  if (smokeBootscreenTimer) {
    clearTimeout(smokeBootscreenTimer)
    smokeBootscreenTimer = null
  }
}

void main()
