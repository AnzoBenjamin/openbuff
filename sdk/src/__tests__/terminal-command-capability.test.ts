import { describe, expect, it } from 'bun:test'

import { evaluateTerminalCommandPolicy } from '../tools/terminal-command-policy'

const projectRoot = '/workspace/project'

const run = (command: string) =>
  evaluateTerminalCommandPolicy({
    command,
    mode: 'assistant',
    permissionProfile: 'workspace-write',
    projectRoot,
  })

/**
 * Stage P1.1 capability corpus: workspace-write must genuinely SUPPORT the
 * shapes the restrictive profiles historically neutered (temp writes,
 * complex pipelines, ${HOME} expansions), WITHOUT re-enabling the
 * genuinely dangerous deny-list set. The live forwarding path still sends
 * 'full-access' (stage P1.2); these tests pin the policy BEFORE wiring.
 */
describe('terminal command capability (workspace-write allowup)', () => {
  describe('allows previously-neutered workspace effects', () => {
    it('allows mktemp-based temp writes end-to-end', () => {
      for (const command of [
        'mktemp -d',
        'TMP=$(mktemp -d) && echo x > "$TMP/f"',
      ]) {
        expect(run(command)).toEqual({ allowed: true })
      }
    })

    it('allows legitimate pipelines', () => {
      for (const command of [
        'git log --format=\'%H %s\' | head -20',
        'cmd a | tee log && cmd b',
      ]) {
        expect(run(command)).toEqual({ allowed: true })
      }
    })

    it('allows bun/testers with flag values and env-prefixed executables', () => {
      for (const command of [
        'bun test --filter=$ExpectedFilter',
        'FOO=bar bun x tsc --noEmit',
      ]) {
        expect(run(command)).toEqual({ allowed: true })
      }
    })

    it('allows bare HOME expansions as read-only invocation arguments', () => {
      for (const command of ['echo $HOME', 'ls ${HOME}']) {
        expect(run(command)).toEqual({ allowed: true })
      }
    })
  })

  describe('still denies the dangerous set', () => {
    it('keeps the hard deny-list blocked', () => {
      for (const command of [
        'sudo apt-get install',
        'rm -rf /',
        'cp .env ${HOME}',
        'printenv',
        'git push --force origin main',
      ]) {
        const decision = run(command)
        expect(decision.allowed).toBe(false)
        if (!decision.allowed) {
          expect(decision.reason.length).toBeGreaterThan(0)
        }
      }
    })
  })
})
