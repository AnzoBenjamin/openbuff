import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'

import { setProjectRoot, getProjectRoot } from '../../project-files'
import {
  getAgentRegistryEpoch,
  getLoadedMCPServers,
  initializeAgentRegistry,
  loadLocalAgents,
  __resetLocalAgentRegistryForTests,
  setAgentRegistryLoggerForTests,
} from '../../utils/local-agent-registry'

// TEST-ONLY: replace the registry's module logger with a noop so logger
// side effects (analytics initialization) cannot run in tests. This uses
// the registry's injection seam instead of mock.module, mirroring
// integration/local-agents.test.ts.
const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
} as typeof import('../../utils/logger').logger

// The epoch assertions are relative, so a beforeEach reset (which itself
// bumps the epoch) keeps the counts exact regardless of test order.
describe('agent registry epoch', () => {
  let tempDir: string
  let originalCwd: string
  let originalProjectRoot: string | undefined

  beforeEach(() => {
    // Mirror integration/local-agents.test.ts: run the real fs scans
    // initializeAgentRegistry performs against an EMPTY temp directory so
    // this epoch test stays tiny and cannot observe the repo's own .agents
    // contents.
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'codebuff-epoch-'))
    originalCwd = process.cwd()
    setProjectRoot(process.cwd())
    originalProjectRoot = getProjectRoot()
    process.chdir(tempDir)
    setProjectRoot(tempDir)
    __resetLocalAgentRegistryForTests()
    setAgentRegistryLoggerForTests(noopLogger)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    setProjectRoot(originalProjectRoot ?? originalCwd)
    // Restore registry state (which also bumps the epoch, invalidating any
    // epoch-keyed cache left over from this test).
    __resetLocalAgentRegistryForTests()
    setAgentRegistryLoggerForTests(null)
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('initializeAgentRegistry bumps the epoch on every call', async () => {
    const before = getAgentRegistryEpoch()
    await initializeAgentRegistry()
    // One call now advances the epoch by 2: the load-start bump (invalidates
    // pre-reload caches before the new content becomes observable) plus the
    // landing bump (invalidates any verdict a mid-reload send cached against
    // the start epoch).
    expect(getAgentRegistryEpoch()).toBe(before + 2)
    // A reload bumps again (start + landing) — this is what invalidates
    // epoch-keyed caches on every registry refresh.
    await initializeAgentRegistry()
    expect(getAgentRegistryEpoch()).toBe(before + 4)
  })

  test('a mode listing cached during the reload window does not survive the landing bump', async () => {
    // Prime the mode cache, then start a reload: its synchronous prefix
    // (load-start bump + mode-cache clear) runs, then it awaits the SDK
    // loader — the reload window.
    loadLocalAgents()
    const reload = initializeAgentRegistry()
    // A mid-window listing call repopulates the mode cache from the OLD
    // userAgentsCache (whenRegistriesReady() does not gate the
    // project-switch path, so renders can happen inside this window).
    const windowListing = loadLocalAgents()
    await reload
    // The landing bump makes the new registry generation observable; the
    // mid-window listing was built from pre-landing content and must NOT
    // be served afterwards. A rebuild returns a NEW array reference, so
    // identity discriminates a rebuild from a stale cache hit.
    const afterLanding = loadLocalAgents()
    expect(afterLanding).not.toBe(windowListing)
  })

  test('the MCP config assignment lands BEFORE the landing bump, so a final-epoch verdict derives from the new mcp.json', async () => {
    // (mcp-cache-epoch-gap) mcpServersCache is REGISTRY-DERIVED content —
    // loadAgentDefinitions() merges it into the base agent definitions
    // that feed validateAgents() and the epoch-keyed validation cache — so
    // the landing bump must be the LAST step of the reload. If the bump ran
    // before the MCP assignment, a consumer that read the FINAL epoch in
    // between would cache a verdict derived from the OLD mcp.json under
    // it, with no later bump to invalidate it until the next reload.
    // The registry scans {cwd}/.agents for mcp.json and the test's cwd is
    // tempDir — mirroring integration/local-agents.test.ts's agentsDir.
    const agentsDir = path.join(tempDir, '.agents')
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(
      path.join(agentsDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          'epoch-probe-server': {
            type: 'stdio',
            command: 'echo',
            args: ['probe'],
          },
        },
      }),
      'utf8',
    )

    // The MCP-load debug call is the observable moment the NEW
    // mcpServersCache becomes visible (it runs right after the
    // assignment), so the epoch sampled inside it discriminates the
    // ordering: with the pre-fix ordering the sample was the
    // post-landing-bump (final) epoch, because the bump ran first.
    const mcpLoadDebugEpochs: number[] = []
    setAgentRegistryLoggerForTests({
      ...noopLogger,
      debug: (...args: unknown[]) => {
        const message = args[1]
        if (
          typeof message === 'string' &&
          message === '[agents] Loaded MCP servers from mcp.json'
        ) {
          mcpLoadDebugEpochs.push(getAgentRegistryEpoch())
        }
      },
    } as typeof import('../../utils/logger').logger)

    const reload = initializeAgentRegistry({ trustProjectAgents: true })
    // The synchronous prefix (load-start bump + cache clears) has already
    // run, so this is the epoch a mid-reload send would read.
    const midReloadEpoch = getAgentRegistryEpoch()
    await reload
    const finalEpoch = getAgentRegistryEpoch()

    expect(mcpLoadDebugEpochs).toHaveLength(1)
    // The NEW mcpServersCache became observable BEFORE the landing bump:
    // the assignment happened under the reload-start epoch, which the
    // landing bump then invalidated — so a verdict cached at the
    // assignment's epoch cannot survive to the final epoch.
    expect(mcpLoadDebugEpochs[0]).toBe(midReloadEpoch)
    expect(finalEpoch).toBe(midReloadEpoch + 1)
    // And the MCP config observable under the FINAL epoch is the new
    // generation, so a verdict cached under the final epoch is derived
    // from the CURRENT mcp.json.
    expect(getLoadedMCPServers()['epoch-probe-server']).toBeDefined()
  })

  test('__resetLocalAgentRegistryForTests bumps the epoch too', () => {
    const before = getAgentRegistryEpoch()
    __resetLocalAgentRegistryForTests()
    expect(getAgentRegistryEpoch()).toBe(before + 1)
  })
})
