#!/usr/bin/env bun

/**
 * Durable harness classifier + terminal-policy smoke.
 * Classifies/evaluates only — does not run shell or mutate the worktree.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { classifyTerminalHarnessAction } from '../sdk/src/services/harness-enforcement.ts'
import { evaluateTerminalCommandPolicy } from '../sdk/src/tools/terminal-command-policy.ts'

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

let failures = 0

function report(label, ok, detail = {}) {
  const line = { case: label, ok, ...detail }
  if (ok) {
    console.log(JSON.stringify(line))
  } else {
    failures += 1
    console.error(JSON.stringify(line))
  }
}

function expectHarnessUndefined(command) {
  const classified = classifyTerminalHarnessAction(command)
  report(`harness-undefined: ${command}`, classified === undefined, {
    command,
    action: classified?.action ?? null,
  })
}

function expectHarnessAction(command, action) {
  const classified = classifyTerminalHarnessAction(command)
  report(`harness-action: ${command}`, classified?.action === action, {
    command,
    expected: action,
    actual: classified?.action ?? null,
  })
}

function expectPolicy(label, params, predicate) {
  const decision = evaluateTerminalCommandPolicy({
    mode: 'assistant',
    projectRoot,
    ...params,
  })
  report(label, predicate(decision), {
    command: params.command,
    permissionProfile: params.permissionProfile,
    decision,
  })
}

// Expect harness undefined (not high-impact).
expectHarnessUndefined(
  'set -o pipefail; (bun test sdk) 2>&1 | tee /tmp/x.log | head -20',
)
expectHarnessUndefined('echo $(pwd)')
expectHarnessUndefined('bun run dev &')
expectHarnessUndefined(
  'which blender && blender --version 2>/dev/null | head -3; ls -la || true',
)
expectHarnessUndefined('git status --short --branch')
expectHarnessUndefined('git restore --staged src/a.ts')
expectHarnessUndefined('git restore --staged -- src/a.ts')

// Expect harness action.
expectHarnessAction(
  'git commit -m "Narrow harness terminal classification"',
  'commit',
)
expectHarnessAction('git restore src/a.ts', 'workspace-delete')
expectHarnessAction('git restore --worktree src/a.ts', 'workspace-delete')
expectHarnessAction(
  'git restore --staged --worktree src/a.ts',
  'workspace-delete',
)
expectHarnessAction('node -e "console.log(1)"', 'arbitrary-code')
expectHarnessAction('nohup bun test', 'arbitrary-code')
expectHarnessAction('git clean -fd', 'workspace-delete')

// Policy checks (projectRoot = repo root).
expectPolicy(
  'policy: git restore --staged under git-commit allowlist',
  {
    command: 'git restore --staged src/a.ts',
    permissionProfile: 'git-commit',
    allowedPaths: ['src/a.ts'],
  },
  (decision) => decision.allowed === true,
)

expectPolicy(
  'policy: git restore --staged -- under git-commit allowlist',
  {
    command: 'git restore --staged -- src/a.ts',
    permissionProfile: 'git-commit',
    allowedPaths: ['src/a.ts'],
  },
  (decision) => decision.allowed === true,
)

expectPolicy(
  'policy: git restore --staged other.ts denied by allowlist',
  {
    command: 'git restore --staged other.ts',
    permissionProfile: 'git-commit',
    allowedPaths: ['src/a.ts'],
  },
  (decision) => decision.allowed === false,
)

expectPolicy(
  'policy: bare git restore under git-commit denied',
  {
    command: 'git restore src/a.ts',
    permissionProfile: 'git-commit',
    allowedPaths: ['src/a.ts'],
  },
  (decision) => decision.allowed === false,
)

const basherPipe =
  'set -o pipefail; (bun test sdk) 2>&1 | tee /tmp/x.log | head -20'
expectPolicy(
  'policy: basher-like pipe under workspace-write',
  {
    command: basherPipe,
    permissionProfile: 'workspace-write',
  },
  (decision) => decision.allowed === true,
)

expectPolicy(
  'policy: workspace-write echo $(date) allowed',
  {
    command: 'echo $(date)',
    permissionProfile: 'workspace-write',
  },
  (decision) => decision.allowed === true,
)

expectPolicy(
  'policy: workspace-write echo $(printenv) denied',
  {
    command: 'echo $(printenv)',
    permissionProfile: 'workspace-write',
  },
  (decision) => decision.allowed === false,
)

expectPolicy(
  'policy: workspace-write gh pr create allowed',
  {
    command: 'gh pr create --title test --body ok',
    permissionProfile: 'workspace-write',
  },
  (decision) => decision.allowed === true,
)

expectPolicy(
  'policy: workspace-write cd .. from package cwd allowed',
  {
    command: 'cd .. && bun test',
    permissionProfile: 'workspace-write',
    cwd: path.join(projectRoot, 'packages', 'sdk'),
  },
  (decision) => decision.allowed === true,
)

if (failures > 0) {
  console.error(`SMOKE_FAILED ${failures}`)
  process.exit(1)
}

console.log('SMOKE_OK')
process.exit(0)
