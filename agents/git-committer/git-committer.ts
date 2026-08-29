import { publisher } from '../constants'

import type { ToolCall } from '../types/agent-definition'
import type { StepText } from '../types/agent-definition'
import type { SecretAgentDefinition } from '../types/secret-agent-definition'

const definition: SecretAgentDefinition = {
  id: 'git-committer',
  publisher,
  displayName: 'Mitt the Git Committer',
  spawnerPrompt:
    'Safely delivers task-owned changes through git: inspect repository/worktree state, stage only related paths, commit with a repository-style message, and optionally push a non-default feature branch when the user explicitly requested it. Requires params.owned_paths with the exact task-owned paths eligible for staging.',
  inputSchema: {
    prompt: {
      type: 'string',
      description:
        'What changes to commit. Describe the feature/bugfix/refactor and the scope of changes so the agent can write a good commit message.',
    },
    params: {
      type: 'object',
      properties: {
        owned_paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Exact task-owned paths eligible for staging. Required. The agent must not stage paths outside this allowlist.',
        },
        branch_name: {
          type: 'string',
          description:
            'If set, create and switch to this branch before committing. Switching/creating a branch on a dirty worktree requires allow_dirty_branch: true; otherwise the agent refuses the switch to protect uncommitted work. The terminal policy also supports safe switch/merge/cherry-pick/stash/reset-soft/tag operations.',
        },
        branch_switch: {
          type: 'boolean',
          default: true,
          description:
            'When true (default), create AND switch to the branch. When false, only create the branch without switching. Ignored if branch_name is not provided.',
        },
        allow_dirty_branch: {
          type: 'boolean',
          default: false,
          description:
            'Explicitly allow creating/switching branches while the worktree is dirty. Defaults to false; set true only after confirming the current uncommitted changes should move with the branch switch/create.',
        },
        push: {
          type: 'boolean',
          default: false,
          description:
            'Push the resulting current feature branch only when the user explicitly requested a push. Default false.',
        },
        remote: {
          type: 'string',
          default: 'origin',
          description: 'Remote used for fetch/push. Defaults to origin.',
        },
      },
      required: ['owned_paths'],
    },
  },
  outputMode: 'last_message',
  includeMessageHistory: false,
  toolNames: [
    'read_files',
    'read_outline',
    'code_search',
    'run_terminal_command',
    'git_status',
    'git_branch',
  ],
  terminalPermissionProfile: 'git-commit',
  spawnableAgents: [],

  systemPrompt: `You are a conservative git delivery specialist for task-owned changes only. Prefer the success path: inspect → stage owned paths → commit with a real imperative message → optional authorized push. On any policy denial or uncertainty about data-loss risk, stop and report rather than improvise a workaround. Do not treat normal git inspection, owned staging, non-amend commits, or git restore --staged as security-sensitive.`,

  instructionsPrompt: `Instructions:
1. Inspect first (DO): check branch, upstream, remote/default branch, worktree membership, dirty/staged/untracked files, and in-progress merge/rebase/cherry-pick state before staging. DON'T: alter git config.
2. Branch switch (DO): when branch_name is set, create/switch via the git_branch tool. Dirty tree requires allow_dirty_branch: true; otherwise stop. Existing worktrees are valid — report the current worktree and branch. DON'T: create or remove worktrees in this version.
3. Stage only owned_paths (required allowlist). DO: stage exact owned paths. DON'T: use git add -A, git add ., or broad globs. If a file mixes unrelated user and task changes and safe hunk staging is unavailable, stop and report rather than claiming ownership. If changes span unrelated concerns, commit only the logical change requested and leave the rest untouched.
4. Commit messages (DO): write a real imperative message derived from the actual change; match recent repository style (imperative subject under 72 characters, body explaining why). Read source files when the diff is insufficient. DON'T: use placeholder messages (probe/test/wip/tmp/foo/bar/x/update/misc/etc.) — they are forbidden and policy-rejected.
5. Pre-commit checks (DO): run git diff --cached, whitespace/secret checks, and verify the staged set is a subset of owned_paths. Unstage extras with git restore --staged only.
6. Allowed ops: inspect state; stage owned paths; non-amend commit; non-force feature-branch push when params.push; git switch / git checkout <branch>; create branch; safe git branch -d; git merge --no-ff / --no-commit; git cherry-pick; git stash push/pop/apply/list; git reset --soft / --mixed; git tag (create); git restore --staged.
7. Forbidden (data loss / rewrite): git reset --hard; git branch -D / --delete; git clean; path checkout / worktree restore overwrite (git checkout -- <path> or bare/worktree git restore); force push (-f/--force/refspec/--delete); git rebase; git commit --amend; git stash drop / clear; git config writes; direct default-branch push; resolving conflicts by discarding a side.
8. Policy denial is final. When the git-commit terminal policy denies a command, STOP and report the exact denial reason verbatim, then ask for guidance. Never work around a denial: never substitute a path-scoped git commit to test policy, never commit just to probe allowance, and never invent a placeholder message.
9. Push only when params.push is true and the branch is a non-default feature branch that is not behind or diverged (fetch the selected remote first; never force-push or use a refspec). Before any operation that could move HEAD or alter the worktree, inspect git status and git stash list; never discard uncommitted work — stop and report instead. Prefer --no-ff / --no-commit merges. On merge/cherry-pick conflicts, STOP and report; rebase needs separate authorization plus fresh validation/review.
10. Return worktree path, branch, commit hash/message, committed paths, remote sync state, and push result.
11. Never commit secrets, .env files, credentials, generated artifacts without their source, or unrelated changes. No eligible changes → report and stop.`.trim(),

  handleSteps: function* ({ params }) {
    const { toolResult: statusResult } = yield {
      toolName: 'run_terminal_command',
      input: { command: 'git status --short --branch' },
    } as ToolCall<'run_terminal_command'>
    const statusValue = statusResult?.find((part) => part.type === 'json')
      ?.value as Record<string, unknown> | undefined
    const statusText =
      typeof statusValue?.stdout === 'string'
        ? statusValue.stdout.trim()
        : typeof statusValue?.message === 'string'
          ? statusValue.message.trim()
          : ''
    const dirtyStatusLines = statusText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('##'))

    if (
      params?.branch_name &&
      dirtyStatusLines.length > 0 &&
      params.allow_dirty_branch !== true
    ) {
      yield {
        type: 'STEP_TEXT',
        text: 'Refusing to create or switch branches with a dirty worktree (data-safety guard). Complex operations such as switch/merge/cherry-pick/stash/reset-soft/tag are otherwise permitted; re-run with allow_dirty_branch: true only after confirming the current uncommitted changes should move to the new branch.',
      } satisfies StepText
      return
    }

    if (params?.branch_name) {
      yield {
        toolName: 'git_branch',
        input: {
          branch_name: params.branch_name,
          switch: params.branch_switch ?? true,
          allow_dirty: params.allow_dirty_branch === true,
        },
      } as ToolCall<'git_branch'>
    }

    yield {
      toolName: 'run_terminal_command',
      input: { command: 'git rev-parse --show-toplevel' },
    } as ToolCall<'run_terminal_command'>

    yield {
      toolName: 'run_terminal_command',
      input: { command: 'git rev-parse --git-common-dir' },
    } as ToolCall<'run_terminal_command'>

    yield {
      toolName: 'run_terminal_command',
      input: { command: 'git branch --show-current' },
    } as ToolCall<'run_terminal_command'>

    yield {
      toolName: 'run_terminal_command',
      input: {
        command: 'git rev-parse --abbrev-ref --symbolic-full-name @{upstream}',
      },
    } as ToolCall<'run_terminal_command'>

    yield {
      toolName: 'run_terminal_command',
      input: { command: 'git diff HEAD' },
    } as ToolCall<'run_terminal_command'>

    yield {
      toolName: 'run_terminal_command',
      input: { command: 'git log --oneline -10' },
    } as ToolCall<'run_terminal_command'>

    const ownedPaths = Array.isArray(params?.owned_paths)
      ? params.owned_paths.filter(
          (value: unknown): value is string =>
            typeof value === 'string' && value.trim().length > 0,
        )
      : []
    if (ownedPaths.length > 0) {
      yield {
        toolName: 'run_terminal_command',
        input: {
          command: `git add -- ${ownedPaths.map((path: string) => JSON.stringify(path)).join(' ')}`,
        },
      } as ToolCall<'run_terminal_command'>

      const { toolResult: safetyResult } = yield {
        toolName: 'run_terminal_command',
        input: {
          command: 'git diff --cached --check',
        },
      } as ToolCall<'run_terminal_command'>
      const safetyValue = safetyResult?.find((part) => part.type === 'json')
        ?.value as Record<string, unknown> | undefined
      if (
        typeof safetyValue?.exitCode === 'number' &&
        safetyValue.exitCode !== 0
      ) {
        yield {
          type: 'STEP_TEXT',
          text: [
            'Commit blocked by staged-diff whitespace checks.',
            typeof safetyValue.stdout === 'string' && safetyValue.stdout
              ? `stdout: ${safetyValue.stdout}`
              : '',
            typeof safetyValue.stderr === 'string' && safetyValue.stderr
              ? `stderr: ${safetyValue.stderr}`
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
        } satisfies StepText
        return
      }
      // Verify the staged set is a subset of owned_paths before committing:
      // a staged path is owned when it exactly equals an owned path or lives
      // under an owned directory (owned_paths may use trailing slashes for
      // directories). Never proceed to git commit with an over-broad set.
      const { toolResult: stagedResult } = yield {
        toolName: 'run_terminal_command',
        input: { command: 'git diff --cached --name-only' },
      } as ToolCall<'run_terminal_command'>
      const stagedValue = stagedResult?.find((part) => part.type === 'json')
        ?.value as Record<string, unknown> | undefined
      const stagedPaths = (
        typeof stagedValue?.stdout === 'string' ? stagedValue.stdout : ''
      )
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
      const normalizedOwnedPaths = ownedPaths.map((ownedPath: string) =>
        ownedPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''),
      )
      const unexpectedStagedPaths = stagedPaths.filter((stagedPath: string) => {
        const normalizedStagedPath = stagedPath
          .replace(/\\/g, '/')
          .replace(/^\.\//, '')
        return !normalizedOwnedPaths.some(
          (ownedPath: string) =>
            normalizedStagedPath === ownedPath ||
            normalizedStagedPath.startsWith(`${ownedPath}/`),
        )
      })
      if (unexpectedStagedPaths.length > 0) {
        // Safe unstage path: `git restore --staged <path>...` is the
        // policy-permitted shape, so only bare path tokens are passed.
        const unstageTargets = unexpectedStagedPaths.filter(
          (stagedPath: string) => /^[A-Za-z0-9._/-]+$/.test(stagedPath),
        )
        if (unstageTargets.length > 0) {
          yield {
            toolName: 'run_terminal_command',
            input: {
              command: `git restore --staged ${unstageTargets.join(' ')}`,
            },
          } as ToolCall<'run_terminal_command'>
        }
        yield {
          type: 'STEP_TEXT',
          text: [
            'Stopping: the staged set contains paths outside the owned_paths allowlist, so no commit was created.',
            `Offending staged paths: ${unexpectedStagedPaths.join(', ')}`,
            `owned_paths allowlist: ${ownedPaths.join(', ')}`,
            unstageTargets.length > 0
              ? `Unstaged via git restore --staged: ${unstageTargets.join(', ')}.`
              : 'No offending paths could be unstaged automatically; unstage them manually.',
            'Re-scope owned_paths to the intended paths (or clean up the pre-staged files) and run again.',
          ].join('\n'),
        } satisfies StepText
        return
      }
      yield {
        toolName: 'run_terminal_command',
        input: { command: 'git diff --cached -U0' },
      } as ToolCall<'run_terminal_command'>
    }

    // Let the model inspect context, stage only eligible paths when an
    // allowlist was not provided, and create the commit.
    yield 'STEP_ALL'

    if (params?.push === true) {
      const remote =
        typeof params.remote === 'string' &&
        /^[A-Za-z0-9._/-]+$/.test(params.remote)
          ? params.remote
          : 'origin'
      const { toolResult: branchResult } = yield {
        toolName: 'run_terminal_command',
        input: { command: 'git branch --show-current' },
      } as ToolCall<'run_terminal_command'>
      const branchValue = branchResult?.find((part) => part.type === 'json')
        ?.value as Record<string, unknown> | undefined
      const branch =
        typeof branchValue?.stdout === 'string' ? branchValue.stdout.trim() : ''
      if (!branch) {
        yield {
          type: 'STEP_TEXT',
          text: 'Push refused: HEAD is detached or the current branch could not be determined.',
        } satisfies StepText
        return
      }
      yield {
        toolName: 'run_terminal_command',
        input: { command: `git fetch --prune ${remote}` },
      } as ToolCall<'run_terminal_command'>
      const { toolResult: defaultResult } = yield {
        toolName: 'run_terminal_command',
        input: {
          command: `git rev-parse --abbrev-ref ${remote}/HEAD`,
        },
      } as ToolCall<'run_terminal_command'>
      const defaultValue = defaultResult?.find((part) => part.type === 'json')
        ?.value as Record<string, unknown> | undefined
      const defaultRef =
        typeof defaultValue?.stdout === 'string'
          ? defaultValue.stdout.trim()
          : ''
      const defaultBranch = defaultRef.split('/').at(-1) ?? ''
      if (branch === defaultBranch) {
        yield {
          type: 'STEP_TEXT',
          text: `Push refused: '${branch}' is the detected default branch. Create and push a feature branch instead.`,
        } satisfies StepText
        return
      }
      const { toolResult: countsResult } = yield {
        toolName: 'run_terminal_command',
        input: {
          command: `git rev-list --left-right --count ${remote}/${branch}...HEAD`,
        },
      } as ToolCall<'run_terminal_command'>
      const countsValue = countsResult?.find((part) => part.type === 'json')
        ?.value as Record<string, unknown> | undefined
      const counts =
        typeof countsValue?.stdout === 'string'
          ? countsValue.stdout.trim().split(/\s+/).map(Number)
          : []
      if (counts.length === 2 && counts[0] > 0) {
        yield {
          type: 'STEP_TEXT',
          text: `Push refused: ${remote}/${branch} is ahead by ${counts[0]} commit(s). Rebase or merge requires separate authorization and must be followed by fresh validation/review.`,
        } satisfies StepText
        return
      }
      yield {
        toolName: 'run_terminal_command',
        input: { command: `git push -u ${remote} ${branch}` },
      } as ToolCall<'run_terminal_command'>
    }
  },
}

export default definition
