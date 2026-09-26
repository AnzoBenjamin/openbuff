import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import tmuxCli from '../tmux-cli'

// SB-5: the tmux-cli agent writes a self-contained bash helper to /tmp, drives
// it through run_terminal_command, and tears the session + helper down in a
// finally block. A stray `'>` in the teardown command previously turned it into
// a bash parse error, so `stop`/`rm -f` never ran (the P0-T3 fix removed it).
// These tests run `bash -n` (parse-only, no execution) over the exact command
// bytes the agent emits, so any future re-introduction of a shell syntax error
// in the helper, the setup wrapper, or the teardown command fails loudly here
// instead of silently leaking tmux sessions/helper files at runtime.

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

// bash availability guard: the parse-only checks need a real bash. Skip (rather
// than error) on the rare host without one so the suite stays green off-CI.
const hasBash = (() => {
  try {
    execFileSync('bash', ['-c', 'true'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

/**
 * Run `bash -n <script>` on a temp file and return null when the script parses,
 * or the captured stderr when bash reports a syntax error. Parse-only: nothing
 * in the script is executed, so the nonexistent /tmp helper paths are inert.
 */
function bashSyntaxError(script: string): string | null {
  const dir = mkdtempSync(path.join(tmpdir(), 'tmux-cli-bashn-'))
  const file = path.join(dir, 'script.sh')
  try {
    writeFileSync(file, script)
    execFileSync('bash', ['-n', file], { stdio: 'pipe' })
    return null
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr
    return String(stderr ?? (error as Error).message ?? error)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Drive the tmux-cli handleSteps generator far enough to capture the exact
 * command strings it yields: the combined setup script (which heredocs the
 * helper), the initial capture command, and the finally-block teardown command.
 * The generator is synchronous, so we can step it directly without a runtime.
 */
function driveForCommands(command: string): {
  setupScript: string
  helperScript: string
  initCommand: string
  teardownCommand: string
  sessionName: string
} {
  const gen = tmuxCli.handleSteps!({
    params: { command },
    logger: noopLogger,
  } as never) as Generator<unknown, unknown, unknown>

  const commandOf = (result: IteratorResult<unknown>): string => {
    const value = result.value as {
      toolName?: string
      input?: { command?: unknown }
    }
    if (
      value?.toolName !== 'run_terminal_command' ||
      typeof value.input?.command !== 'string'
    ) {
      throw new Error(
        `Expected a run_terminal_command yield, got: ${JSON.stringify(value)}`,
      )
    }
    return value.input.command
  }

  // 1) Setup script (writes + starts the helper, sends the command).
  const setupScript = commandOf(gen.next())
  const sessionName = setupScript.match(/ start '([^']+)'/)?.[1] ?? ''
  expect(sessionName).not.toBe('')

  // 2) Feed a successful setup result (stdout must equal the session name).
  const initCommand = commandOf(
    gen.next({
      toolResult: [
        {
          type: 'json',
          value: { stdout: sessionName, stderr: '', exitCode: 0 },
        },
      ],
    } as never),
  )

  // 3) Feed the initial-capture result -> the agent yields an add_message.
  const addMessage = gen.next({
    toolResult: [
      { type: 'json', value: { stdout: 'ready', stderr: '', exitCode: 0 } },
    ],
  } as never)
  expect((addMessage.value as { toolName?: string })?.toolName).toBe(
    'add_message',
  )

  // 4) Resume past add_message -> the agent yields 'STEP_ALL'.
  const stepAll = gen.next()
  expect(stepAll.value).toBe('STEP_ALL')

  // 5) Resume past STEP_ALL -> the try block ends and the finally yields the
  //    teardown command (stop session + rm helper).
  const teardownCommand = commandOf(gen.next())

  // Extract the heredoc'd helper script bytes exactly as written to disk.
  const openMarker = "<< 'TMUX_HELPER_EOF'\n"
  const openIndex = setupScript.indexOf(openMarker)
  expect(openIndex).toBeGreaterThanOrEqual(0)
  const helperStart = openIndex + openMarker.length
  const closeIndex = setupScript.indexOf('\nTMUX_HELPER_EOF\n', helperStart)
  expect(closeIndex).toBeGreaterThan(helperStart)
  const helperScript = setupScript.slice(helperStart, closeIndex + 1)

  return { setupScript, helperScript, initCommand, teardownCommand, sessionName }
}

describe('tmux-cli agent', () => {
  test('declares the runtime-enforced tmux-test permission profile', () => {
    // The agent advertises tmux-test; note that the agent-runtime handler
    // (packages/agent-runtime/.../run-terminal-command.ts) forwards
    // permission_profile: 'full-access' for every agent, so tmux-test itself is
    // pinned in sdk/src/__tests__/terminal-command-policy.test.ts. This assert
    // guards the declaration the CLI product relies on.
    expect(tmuxCli.terminalPermissionProfile).toBe('tmux-test')
    expect(tmuxCli.toolNames).toContain('run_terminal_command')
  })

  test.skipIf(!hasBash)(
    'generated helper, setup, init-capture, and teardown commands are valid bash',
    () => {
      const { setupScript, helperScript, initCommand, teardownCommand } =
        driveForCommands('echo hello')

      expect(bashSyntaxError(helperScript)).toBeNull()
      expect(bashSyntaxError(setupScript)).toBeNull()
      expect(bashSyntaxError(initCommand)).toBeNull()
      expect(bashSyntaxError(teardownCommand)).toBeNull()
    },
  )

  test('teardown command runs stop then rm without a stray redirection (P0-T3/SB-5)', () => {
    const { teardownCommand, sessionName } = driveForCommands('echo hello')

    // The fix removed a stray `'>` that made `stop`/`rm -f` a parse error.
    // Pin the exact intended shape so it can't silently regress.
    expect(teardownCommand).toMatch(
      /stop '[^']+' >\/dev\/null 2>&1; rm -f '[^']+'/,
    )
    expect(teardownCommand).toContain(`stop '${sessionName}'`)
    expect(teardownCommand).not.toContain("'>")
  })

  test.skipIf(!hasBash)(
    'teardown stays valid bash even when the start command contains shell metacharacters',
    () => {
      // The command is single-quote-escaped into the setup script; a payload
      // with quotes/semicolons must not break the emitted teardown either.
      const { setupScript, teardownCommand } = driveForCommands(
        "echo 'a'; rm -rf /tmp/should-not-run && printf %s \"$X\"",
      )
      expect(bashSyntaxError(setupScript)).toBeNull()
      expect(bashSyntaxError(teardownCommand)).toBeNull()
    },
  )
})
