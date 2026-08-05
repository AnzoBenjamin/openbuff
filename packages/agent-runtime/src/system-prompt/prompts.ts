import {
  flattenTree,
  getLastReadFilePaths,
} from '@codebuff/common/project-file-tree'
import { createMarkdownFileBlock } from '@codebuff/common/util/file'
import { truncateString } from '@codebuff/common/util/string'
import { closeXml } from '@codebuff/common/util/xml'

import { truncateFileTreeBasedOnTokenBudget } from './truncate-file-tree'
import { applyMeasure } from '../util/context-budget'

import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ProjectFileContext } from '@codebuff/common/util/file'
import type { ContextBudgetLedger } from '../util/context-budget'

export const knowledgeFilesPrompt = `
# Knowledge files

Knowledge files (knowledge.md / AGENTS.md / CLAUDE.md) capture non-obvious project guidance. Update when the user says always-do-X, corrects you, or shares a helpful URL. BE CONCISE: no single-file docs or restated code. Full guidance → read_files \`agents/guides/knowledge-files.md\`.
`.trim()

const compactPrompt = `
User has typed "compact". Summarize the current conversation and prepare it to replace the existing message history.

1. Summarize the entire conversation up to this point (excluding this 'compact' command).
2. The summary must use this exact structured schema and include every heading, even when the value is "None":
   - Goal:
   - Decisions:
   - Files Inspected:
   - Edits Made:
   - Validation Results:
   - Blockers:
   - Next Action:
3. Preserve concrete facts: file paths, tool names, commands run, validation outcomes, blockers, and the next required action.
4. Keep prose concise, but do not omit operational details needed to resume the task after compaction.
`.trim()

const exportPrompt = `
User has typed "export". Export the current conversation. (It's ok to proceed even if in "Ask" mode because of user change to "Export" mode).

1. Summarize the entire conversation up to this point from the message history (excluding this 'export' command) into a new file.
2. The summary MUST be in Markdown format.
3. The summary MUST include:
   - All key decisions made during the conversation.
   - All significant file changes. If you have access to write_file blocks from our history, reproduce their paths and content accurately. If you only have diffs or descriptions of changes, summarize those.
   - The reasoning behind those decisions and changes.
4. Use the 'write_file' tool to save this Markdown summary to a new file with a generated name starting with the prefix 'codebuff-export-' like 'codebuff-export-topic-of-conversation.md' in the project root directory.

Write file tool format:

<write_file>
<path>codebuff-export-file-name.md${closeXml('path')}
<content>
[Insert markdown content here]
${closeXml('content')}
${closeXml('write_file')}
`.trim()

const initPrompt = `
User has typed "init". Help them set up project knowledge files for better results.

1. Ensure there is a \`knowledge.md\` file in the project root. If it does not exist, create it.
2. Fill \`knowledge.md\` with concise, high-signal information about this repo:
   - What this project is and where key code lives
   - Commands to run (install/dev/test/lint/build) based on package/tooling files
   - Notable conventions, constraints, and "gotchas"
3. Prefer reading existing docs (e.g. README, package.json, scripts) before writing.
4. Use the \`write_file\` tool to create/update \`knowledge.md\`. Do not mention any deprecated configuration files.
`.trim()

export const additionalSystemPrompts = {
  '/init': initPrompt,
  init: initPrompt,
  '/export': exportPrompt,
  export: exportPrompt,
  '/compact': compactPrompt,
  compact: compactPrompt,
} as const

export const getProjectFileTreePrompt = (params: {
  fileContext: ProjectFileContext
  fileTreeTokenBudget: number
  mode: 'search' | 'agent'
  logger: Logger
  ledger?: ContextBudgetLedger
}) => {
  const { fileContext, fileTreeTokenBudget, mode, logger, ledger } = params
  const { projectRoot } = fileContext
  const { printedTree, truncationLevel } = truncateFileTreeBasedOnTokenBudget({
    fileContext,
    tokenBudget: Math.max(0, fileTreeTokenBudget),
    logger,
    // Agent/orchestrator SMALL trees prefer path-only; search keeps symbols.
    preferPathOnly: mode === 'agent',
  })

  const truncationNote =
    truncationLevel === 'none'
      ? ''
      : truncationLevel === 'unimportant-files'
        ? '\nNote: Unimportant files (like build artifacts and cache files) have been removed from the file tree.'
        : truncationLevel === 'tokens'
          ? '\nNote: Selected function, class, and variable names in source files have been removed from the file tree to fit within token limits.'
          : '\nNote: The file tree has been truncated to show a subset of files to fit within token limits.'

  const prompt = `
# Project file tree

As Buffy, you have access to all the files in the project.

The following is the path to the project on the user's computer. It is also the current working directory for terminal commands:
<project_path>
${projectRoot}
${closeXml('project_path')}

Within this project directory, here is the file tree.
Note that the file tree:
- Is cached from the start of this conversation. Files created after the start of this conversation will not appear.
- Excludes files that are .gitignored.
${
  mode === 'agent'
    ? `\nThe project file tree below can be ignored unless you need to know what files are in the project.\n`
    : ''
}
<project_file_tree>
${printedTree}
${closeXml('project_file_tree')}
${truncationNote}
`.trim()

  if (ledger) {
    applyMeasure(ledger, {
      category: 'fileTree',
      label: 'project-file-tree',
      content: prompt,
    })
  }

  return prompt
}

const windowsNote = `
Note: many commands in the terminal are different on Windows.
For example, the mkdir command is \`mkdir\` instead of \`mkdir -p\`. Instead of grep, use \`findstr\`. Instead of \`ls\` use \`dir\` to list files. Instead of \`mv\` use \`move\`. Instead of \`rm\` use \`del\`. Instead of \`cp\` use \`copy\`. Unless the user is in Powershell, in which case you should use the Powershell commands instead.
`.trim()

export const getSystemInfoPrompt = (
  fileContext: ProjectFileContext,
  ledger?: ContextBudgetLedger,
) => {
  const { fileTree, shellConfigFiles, systemInfo } = fileContext
  const flattenedNodes = flattenTree(fileTree)
  const lastReadFilePaths = getLastReadFilePaths(flattenedNodes, 20)

  const prompt = `
# System Info

Operating System: ${systemInfo.platform}
${systemInfo.platform === 'win32' ? windowsNote + '\n' : ''}
Shell: ${systemInfo.shell}
Chrome: ${systemInfo.chromeAvailable ? 'installed' : 'not found'}

<user_shell_config_files>
${Object.entries(shellConfigFiles)
  .map(([path, content]) => createMarkdownFileBlock(path, content))
  .join('\n')}
${closeXml('user_shell_config_files')}

The following are the most recently read files according to the OS atime. This is cached from the start of this conversation:
<recently_read_file_paths_most_recent_first>
${lastReadFilePaths.join('\n')}
${closeXml('recently_read_file_paths_most_recent_first')}
`.trim()

  if (ledger) {
    applyMeasure(ledger, {
      category: 'systemInfo',
      label: 'system-info',
      content: prompt,
    })
  }

  return prompt
}

export const getGitChangesPrompt = (
  fileContext: ProjectFileContext,
  ledger?: ContextBudgetLedger,
) => {
  const { gitChanges } = fileContext
  const hasGitChanges =
    !!gitChanges &&
    (gitChanges.status !== '' ||
      gitChanges.diff !== '' ||
      gitChanges.diffCached !== '' ||
      gitChanges.lastCommitMessages !== '')
  if (!hasGitChanges) {
    // Skip recording empty blocks: no git changes means no ledger line.
    return ''
  }
  const maxLength = 30_000
  const prompt = `
Git Changes:
<git_status>
${truncateString(gitChanges.status, maxLength / 10)}
${closeXml('git_status')}

<git_diff>
${truncateString(gitChanges.diff, maxLength)}
${closeXml('git_diff')}

<git_diff_cached>
${truncateString(gitChanges.diffCached, maxLength)}
${closeXml('git_diff_cached')}

<git_commit_messages_most_recent_first>
${truncateString(gitChanges.lastCommitMessages, maxLength / 10)}
${closeXml('git_commit_messages_most_recent_first')}
`.trim()

  if (ledger) {
    applyMeasure(ledger, {
      category: 'gitChanges',
      label: 'git-changes',
      content: prompt,
    })
  }

  return prompt
}
