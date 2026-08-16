import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import {
  ChangeOwnershipService,
  HarnessApprovalService,
  classifyTerminalHarnessAction,
  evaluateHarnessActionPolicy,
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

describe('harness enforcement services', () => {
  test('approvals are exact-scope and single-use', () => {
    const service = new HarnessApprovalService(setup())
    const grant = service.grant(scope, {
      action: 'push',
      target: 'origin/feature',
    })
    expect(() =>
      service.consume({
        repositoryId: 'repo-1',
        workspaceId: 'workspace-1',
        runId: 'run-1',
        approvalId: grant.id,
        action: 'push',
        target: 'origin/other',
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
        snapshotId: 'snapshot-1',
      }),
    ).toThrow('already consumed')
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
    ).toEqual({
      action: 'push',
      target: 'origin/feature/x',
      branch: 'feature/x',
    })
    expect(classifyTerminalHarnessAction('git push')).toEqual({
      action: 'push',
      target: 'git push',
    })
    expect(classifyTerminalHarnessAction('git push origin HEAD:main')).toEqual({
      action: 'push',
      target: 'origin/main',
      branch: 'main',
    })
    expect(
      classifyTerminalHarnessAction('git push --force origin main'),
    ).toEqual({
      action: 'push',
      target: 'git push --force origin main',
      branch: 'main',
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
    expect(
      classifyTerminalHarnessAction('git restore src/a.ts'),
    ).toMatchObject({ action: 'workspace-delete' })
    expect(
      classifyTerminalHarnessAction(
        'git restore --staged --worktree src/a.ts',
      ),
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
      classifyTerminalHarnessAction(
        'git log --oneline $(git rev-parse HEAD)',
      ),
    ).toBeUndefined()
    expect(
      classifyTerminalHarnessAction(
        'set -o pipefail; (bun test) 2>&1 | tee /tmp/log | head -20',
      ),
    ).toBeUndefined()
    expect(
      classifyTerminalHarnessAction(
        "set -o pipefail; (bun test sdk) 2>&1 | tee /tmp/openbuff-basher-x.log >/dev/null; status=${PIPESTATUS[0]}; echo exit_status=$status; grep -n -E '\\(fail\\)|error:' /tmp/x.log | head -120 || true; exit \"$status\"",
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
    ).toEqual({
      action: 'pull-request',
      target: 'gh pr create --title test',
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
})
