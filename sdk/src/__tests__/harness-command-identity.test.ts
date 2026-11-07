import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

import {
  HarnessApprovalService,
  classifyTerminalHarnessAction,
  evaluateHarnessActionPolicy,
  hashCommand,
  hashTerminalExecutionContext,
} from '../services/harness-enforcement'
import { LocalHarnessStore } from '../services/local-harness-store'
import { evaluateTerminalCommandPolicy } from '../tools/terminal-command-policy'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})
const classify = (command: string) => {
  const result = classifyTerminalHarnessAction(command)
  expect(result).toBeDefined()
  return result!
}
const decide = (
  command: string,
  approvalMode: 'balanced' | 'strict' | 'allow-all' = 'balanced',
) =>
  evaluateHarnessActionPolicy({
    ...classify(command),
    defaultBranch: 'main',
    branch: 'feature',
    hasMatchingApproval: false,
    approvalMode,
  })

describe('B18 exact command identity and complete effect admission', () => {
  test('profile path admission preserves whitespace inside quoted arguments', () => {
    const request = {
      command: 'git add "a  b.txt"',
      mode: 'assistant' as const,
      permissionProfile: 'git-commit' as const,
      projectRoot: '/workspace',
    }
    expect(
      evaluateTerminalCommandPolicy({ ...request, allowedPaths: ['a b.txt'] })
        .allowed,
    ).toBe(false)
    expect(
      evaluateTerminalCommandPolicy({ ...request, allowedPaths: ['a  b.txt'] })
        .allowed,
    ).toBe(true)
  })
  test.each([
    ["git commit -m 'a  b'", "git commit -m 'a b'"],
    ['echo one\nrm -rf build', 'echo one rm -rf build'],
    ['echo "$(printf \'a  b\')"', 'echo "$(printf \'a b\')"'],
    ['git push origin feature', ' git push origin feature '],
    ['git commit -m a\\\nb', 'git commit -m ab'],
  ])(
    'different executable bytes retain distinct hashes: %s',
    (first, second) => {
      expect(hashCommand(first)).not.toBe(hashCommand(second))
      expect(hashCommand(first)).toBe(hashCommand(first))
    },
  )

  test.each([
    ['npm install && rm -rf build', ['dependency-install', 'workspace-delete']],
    ['git commit -m ok; kubectl apply -f deploy.yaml', ['commit', 'deploy']],
    ['git push origin feature\nrm -rf build', ['push', 'workspace-delete']],
    [
      'echo "$(git push origin feature; rm -rf build)"',
      ['push', 'workspace-delete'],
    ],
    [
      "bash -c 'npm install && rm -rf build'",
      ['dependency-install', 'workspace-delete'],
    ],
    [
      'echo `git push origin feature`; kubectl apply -f deploy.yaml',
      ['deploy', 'push'],
    ],
    [
      'cat <(git push origin feature; rm -rf build)',
      ['push', 'workspace-delete'],
    ],
    ['(npm install; rm -rf build)', ['dependency-install', 'workspace-delete']],
    [
      '(npm install && git push origin feature) && rm -rf build',
      ['dependency-install', 'push', 'workspace-delete'],
    ],
    [
      '! FOO=1 git push origin feature; git reset -q --hard HEAD',
      ['push', 'workspace-delete'],
    ],
    [
      '\'git\' pu"sh" origin feature && /bin/rm -rf build',
      ['push', 'workspace-delete'],
    ],
  ])('governs every potential effect: %s', (command, actions) => {
    const result = classify(command as string)
    expect(result.parseStatus).toBe('complete')
    expect(result.effects?.map((effect) => String(effect.action))).toEqual(
      actions,
    )
    expect(decide(command as string)).toMatchObject({
      allowed: false,
      approvalRequired: true,
    })
    expect(decide(command as string, 'allow-all').allowed).toBe(true)
    expect(
      evaluateHarnessActionPolicy({ ...result, hasMatchingApproval: true })
        .allowed,
    ).toBe(true)
  })

  test.each([
    ['git push --force origin feature', 'force'],
    ['git push -uf origin feature', 'force'],
    ['git push --force-with-lease origin feature', 'force'],
    ['git push --delete origin feature', 'delete'],
    ['git push -d origin feature', 'delete'],
    ['git push origin :feature', 'delete'],
    ['git push origin +HEAD:feature', 'force'],
    ['git push origin HEAD:feature', 'refspec'],
    ['git push --mirror origin', 'mirror'],
    ['git push --tags origin', 'all-refs'],
    ['git push origin "$BRANCH"', 'dynamic-target'],
    ['git push --repo elsewhere feature', 'unknown-options'],
  ])('preserves push risk across policy modes: %s', (command, risk) => {
    expect(
      classify(command).effects?.[0].pushRisks?.some((value) => value === risk),
    ).toBe(true)
    for (const mode of ['balanced', 'strict'] as const)
      expect(decide(command, mode)).toMatchObject({
        allowed: false,
        approvalRequired: true,
      })
    expect(decide(command, 'allow-all').allowed).toBe(true)
  })

  test('routine feature work remains available and default branch checks cover later pushes', () => {
    expect(decide('git push -u origin feature').allowed).toBe(true)
    expect(decide('npm install && git push origin main')).toMatchObject({
      allowed: false,
      approvalRequired: true,
    })
    for (const command of [
      'bun test && bun run typecheck',
      'echo "$(pwd)"',
      'bun run dev &',
      'git log --oneline $(git rev-parse HEAD)',
      'echo "literal; rm -rf x"',
      'printf ok # rm -rf build\n',
    ])
      expect(classifyTerminalHarnessAction(command)).toBeUndefined()
  })

  test.each([
    'echo "unterminated',
    'echo $(pwd',
    'echo ok &&',
    '(git push origin feature',
    'echo ok)',
    '; echo ok',
    '()',
    'echo ok & & echo wrong',
  ])('malformed shell syntax is explicitly refused: %s', (command) => {
    expect(
      spawnSync('bash', ['-n', '-c', command], {
        env: { PATH: '/usr/bin:/bin' },
      }).status,
    ).not.toBe(0)
    expect(classify(command).parseStatus).toBe('malformed')
    expect(decide(command)).toMatchObject({
      allowed: false,
      approvalRequired: false,
    })
  })

  test.each([
    'if true; then git push origin feature; fi',
    'for x in a; do rm -rf "$x"; done',
    'cat <<EOF\nhello\nEOF',
    '$EXECUTABLE --flag',
    'git "$SUBCOMMAND" origin feature',
    "env -S 'git push origin feature'",
    'git -C elsewhere push origin feature',
    '>trace git push origin feature',
    'coproc git push origin feature',
    'g?t push origin feature',
    'case x in x) git push origin feature;; esac',
    'wrapper() { git push origin feature; }; wrapper',
    'printf push | xargs git origin feature',
  ])('unsupported shell interpretation is explicit: %s', (command) => {
    expect(
      spawnSync('bash', ['-n', '-c', command], {
        env: { PATH: '/usr/bin:/bin' },
      }).status,
    ).toBe(0)
    expect(classify(command).parseStatus).toBe('unsupported')
    expect(decide(command)).toMatchObject({
      allowed: false,
      approvalRequired: true,
    })
    expect(decide(command, 'allow-all').allowed).toBe(true)
  })

  test('one approval binds exact command bytes, execution profile, working context, and snapshot', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'openbuff-b18-approval-'),
    )
    roots.push(root)
    const service = new HarnessApprovalService(new LocalHarnessStore(root))
    const scope = {
      repositoryId: 'repo',
      workspaceId: 'workspace',
      runId: 'run',
      snapshotId: 'basis',
    }
    const command = "git commit -m 'a  b'; rm -rf build"
    const context = {
      permissionProfile: 'workspace-write',
      cwd: root,
      projectRoot: root,
      processType: 'SYNC' as const,
      allowedPaths: ['a', 'b'],
    }
    const action = {
      action: 'commit',
      target: command,
      commandHash: hashCommand(command),
      executionContextHash: hashTerminalExecutionContext(context),
    }
    const grant = service.grant(scope, action)
    const consume = { ...scope, ...action, approvalId: grant.id }
    for (const change of [
      { commandHash: hashCommand("git commit -m 'a b'; rm -rf build") },
      { commandHash: hashCommand("rm -rf build; git commit -m 'a  b'") },
      { snapshotId: 'later-basis' },
      { workspaceId: 'elsewhere' },
      { runId: 'next-run' },
      { executionContextHash: undefined },
      ...[
        { permissionProfile: 'full-access' },
        { cwd: root + '/subdir' },
        { allowedPaths: ['b', 'a'] },
        { processType: 'BACKGROUND' as const },
        { detach: true },
      ].map((change) => ({
        executionContextHash: hashTerminalExecutionContext({
          ...context,
          ...change,
        }),
      })),
    ])
      expect(() => service.consume({ ...consume, ...change })).toThrow(
        'scope does not match',
      )
    expect(service.consume(consume).consumedAt).toBeDefined()
    expect(() => service.consume(consume)).toThrow('already consumed')
  })

  test('real harmless shell effects match the complete admission roster', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-b18-trace-'))
    roots.push(root)
    const trace = path.join(root, 'trace')
    for (const command of ['npm', 'git', 'rm', 'kubectl'])
      fs.writeFileSync(
        path.join(root, command),
        '#!/bin/sh\nprintf "%s\\n" "${0##*/}:$*" >> "$B18_TRACE"\n',
        { mode: 0o700 },
      )
    const command =
      "npm install && git commit -m 'a  b'; rm -rf fixture; kubectl apply -f local.yaml"
    const result = classify(command)
    expect(result.effects?.map((effect) => effect.action)).toEqual([
      'dependency-install',
      'commit',
      'workspace-delete',
      'deploy',
    ])
    expect(decide(command).allowed).toBe(false)
    expect(fs.existsSync(trace)).toBe(false)
    const child = spawnSync(
      '/bin/bash',
      ['--noprofile', '--norc', '-c', command],
      { cwd: root, env: { PATH: root, B18_TRACE: trace }, encoding: 'utf8' },
    )
    expect(child.status).toBe(0)
    expect(fs.readFileSync(trace, 'utf8')).toBe(
      'npm:install\ngit:commit -m a  b\nrm:-rf fixture\nkubectl:apply -f local.yaml\n',
    )
  })
})
