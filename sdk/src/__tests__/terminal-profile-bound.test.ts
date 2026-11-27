/**
 * N03 / exec-jobs-02: the agent-declared terminal profile reaches the policy
 * engine. Ported from the SDK half of
 * .agents/sessions/product-audit-2026-11-12/verification/probes/trust/p5.ts,
 * where a plan-lineage basher's `rm -f old.txt && touch PLAN_MARKER` ran
 * because the host `full-access` profile replaced the declared `read-only`.
 */
import * as mainPromptModule from '@codebuff/agent-runtime/main-prompt'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { execFileSync } from 'node:child_process'
import nodeFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { OpenbuffClient } from '../client'
import * as databaseModule from '../impl/database'
import { refuseByDeclaredTerminalProfile } from '../tools/terminal-profile-bound'
import { beginSdkCallback, sdkCallbackOptions } from './sdk-callback-fixture'

import type { ToolResultOutput } from '@codebuff/common/types/messages/content-part'

const cleanup: string[] = []
afterEach(() => {
  mock.restore()
  for (const dir of cleanup.splice(0)) nodeFs.rmSync(dir, { recursive: true, force: true })
})

describe('refuseByDeclaredTerminalProfile', () => {
  const projectRoot = '/tmp/terminal-profile-bound-project'
  const check = (declaredProfile: any, command: string, hostProfile = 'full-access') =>
    refuseByDeclaredTerminalProfile({ command, declaredProfile, hostProfile, mode: 'assistant', projectRoot })

  it('refuses a mutation under a declared read-only profile with a denied refusal', () => {
    const refusal = check('read-only', 'rm -f old.txt && touch PLAN_MARKER')
    expect(refusal?.[0]).toMatchObject({
      type: 'json',
      value: {
        permissionDenied: true,
        permissionProfile: 'read-only',
        executionRefusal: { ok: false, reason: 'denied' },
      },
    })
  })

  it('applies workspace-write as an upper bound and allows in-project work', () => {
    expect(check('workspace-write', 'cat /etc/hostname')).toBeDefined()
    expect(check('workspace-write', 'touch build.log && bun test')).toBeUndefined()
  })

  it('leaves undeclared, full-access and task-specific profiles to the host profile', () => {
    for (const profile of [undefined, 'full-access', 'git-commit', 'dependency-mutation', 'tmux-test', 'validation-diagnosis', 'librarian-read-only'])
      expect(check(profile, 'rm -f old.txt'), String(profile)).toBeUndefined()
  })

  it('skips user-mode commands and a host that already runs the declared profile', () => {
    expect(refuseByDeclaredTerminalProfile({ command: 'rm -f x', declaredProfile: 'read-only', hostProfile: 'full-access', mode: 'user', projectRoot })).toBeUndefined()
    expect(check('workspace-write', 'cat /etc/hostname', 'workspace-write')).toBeUndefined()
  })
})

describe('SDK run_terminal_command honours the declared profile (p5)', () => {
  const runCommands = async (calls: Array<{ command: string; permission_profile: string }>) => {
    spyOn(databaseModule, 'getUserInfoFromApiKey').mockResolvedValue({
      id: 'user-123', email: 'test@example.com', discord_id: null,
      stripe_customer_id: null, banned: false, created_at: new Date('2024-01-01T00:00:00Z'),
    })
    spyOn(databaseModule, 'fetchAgentFromDatabase').mockResolvedValue(null)
    spyOn(databaseModule, 'startAgentRun').mockResolvedValue('run-1')
    spyOn(databaseModule, 'finishAgentRun').mockResolvedValue(undefined)
    spyOn(databaseModule, 'addAgentStep').mockResolvedValue('step-1')

    const projectRoot = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-profile-bound-'))
    cleanup.push(projectRoot)
    execFileSync('git', ['init', '--quiet'], { cwd: projectRoot })
    nodeFs.writeFileSync(path.join(projectRoot, 'old.txt'), 'old\n')

    const results: ToolResultOutput[][] = []
    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const { sendAction, promptId } = params
        const callback = await beginSdkCallback(params)
        const sessionState = callback.sessionState
        for (const call of calls) {
          results.push((await callback.request({
            userInputId: promptId,
            toolName: 'run_terminal_command',
            input: {
              command: call.command,
              mode: 'assistant',
              permission_profile: call.permission_profile,
              process_type: 'SYNC',
              owner: { clientSessionId: promptId, rootRunId: 'root-run', parentRunId: 'root-run', parentAgentId: 'main-agent' },
            },
          })).output)
        }
        await sendAction({ action: { type: 'prompt-response', promptId, sessionState, output: { type: 'lastMessage', value: [] } } })
        return { sessionState, output: { type: 'lastMessage' as const, value: [] } }
      },
    )

    const harnessStateDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-profile-bound-state-'))
    cleanup.push(harnessStateDir)
    const client = new OpenbuffClient({ ...sdkCallbackOptions(projectRoot, { fsSource: undefined }), harnessStateDir })
    const result = await client.run({ agent: 'base2', prompt: 'run commands' })
    expect(result.output.type).toBe('lastMessage')
    return { projectRoot, values: results.map((output) => (output[0] as { value: Record<string, unknown> }).value) }
  }

  it('refuses the plan-lineage rm under read-only and leaves the files unchanged', async () => {
    const { projectRoot, values } = await runCommands([
      { command: 'rm -f old.txt && touch PLAN_MARKER', permission_profile: 'read-only' },
    ])
    expect(values[0]).toMatchObject({ permissionDenied: true, permissionProfile: 'read-only' })
    expect(nodeFs.existsSync(path.join(projectRoot, 'old.txt'))).toBe(true)
    expect(nodeFs.existsSync(path.join(projectRoot, 'PLAN_MARKER'))).toBe(false)
  })

  it('keeps execute-mode behaviour for undeclared (full-access) agents', async () => {
    const { projectRoot, values } = await runCommands([
      { command: 'rm -f old.txt && touch EXEC_MARKER', permission_profile: 'full-access' },
    ])
    expect(values[0]).toMatchObject({ exitCode: 0 })
    expect(nodeFs.existsSync(path.join(projectRoot, 'old.txt'))).toBe(false)
    expect(nodeFs.existsSync(path.join(projectRoot, 'EXEC_MARKER'))).toBe(true)
  })
})
