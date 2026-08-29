import { getProjectRoot } from '../project-files'
import { getCliEnv } from '../utils/env'
import { getSystemMessage } from '../utils/message-history'

import type { InfoContentBlock } from '../types/chat'
import type { PostUserMessageFn } from '../types/contracts/send-message'

function getWorkspaceRoot(): string {
  try {
    return getProjectRoot()
  } catch {
    return process.cwd()
  }
}

/**
 * Gets the CLI version with fallback to default.
 */
function getCliVersion(): string {
  return getCliEnv().CODEBUFF_CLI_VERSION ?? '1.0.0'
}

export function buildInfoContentBlock(): InfoContentBlock {
  return {
    type: 'info',
    version: getCliVersion(),
    workspace: getWorkspaceRoot(),
  }
}

/**
 * Handles the /info command — displays diagnostic information.
 * Also accessible via the /status alias.
 */
export function handleInfoCommand(): {
  postUserMessage: PostUserMessageFn
} {
  const block = buildInfoContentBlock()
  const infoContent = [
    '🔍 CLI Diagnostic Info',
    '',
    `Version: ${block.version}`,
    `Workspace: ${block.workspace}`,
    'Auth: Local/BYOK Mode',
  ].join('\n')

  const postUserMessage: PostUserMessageFn = (prev) => {
    const msg = getSystemMessage([block], infoContent)
    return [...prev, msg]
  }

  return { postUserMessage }
}
