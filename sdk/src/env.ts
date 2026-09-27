/**
 * SDK environment helper for dependency injection.
 *
 * This module provides SDK-specific env helpers that extend the base
 * process env with SDK-specific vars for binary paths and WASM.
 */

import { BYOK_OPENROUTER_ENV_VAR } from '@codebuff/common/constants/byok'
import {
  CHATGPT_OAUTH_TOKEN_ENV_VAR,
  OPENBUFF_CHATGPT_OAUTH_TOKEN_ENV_VAR,
} from '@codebuff/common/constants/chatgpt-oauth'
import { getBaseEnv } from '@codebuff/common/env-process'

import type { SdkEnv } from './types/env'

/**
 * Get SDK environment values.
 * Composes from getBaseEnv() + SDK-specific vars.
 */
export const getSdkEnv = (): SdkEnv => ({
  ...getBaseEnv(),

  // SDK-specific paths
  CODEBUFF_RG_PATH: process.env.CODEBUFF_RG_PATH,
  CODEBUFF_WASM_DIR: process.env.CODEBUFF_WASM_DIR,
  CHROME_PATH: process.env.CHROME_PATH,
  CHROMIUM_PATH: process.env.CHROMIUM_PATH,

  // Build flags
  VERBOSE: process.env.VERBOSE,
  OVERRIDE_TARGET: process.env.OVERRIDE_TARGET,
  OVERRIDE_PLATFORM: process.env.OVERRIDE_PLATFORM,
  OVERRIDE_ARCH: process.env.OVERRIDE_ARCH,
})

/**
 * Resolve the API key from the environment. Prefers OPENBUFF_API_KEY and
 * falls back to CODEBUFF_API_KEY for backward compatibility.
 */
export const getOpenbuffApiKeyFromEnv = (): string | undefined => {
  return process.env.OPENBUFF_API_KEY ?? process.env.CODEBUFF_API_KEY
}

/** @deprecated Use getOpenbuffApiKeyFromEnv instead. Kept as a compatibility
 * alias so existing imports continue to resolve after the SDK rename. */
export const getCodebuffApiKeyFromEnv = getOpenbuffApiKeyFromEnv

export const getSystemProcessEnv = (): NodeJS.ProcessEnv => {
  return process.env
}

/**
 * Environment for spawned child shell commands (e.g. run_terminal_command).
 *
 * Returns a shallow copy of process.env with the agent process's own
 * provider credentials removed, along with the generic upstream provider
 * API keys the agent process may hold (OPENAI_API_KEY, ANTHROPIC_API_KEY,
 * OPENROUTER_API_KEY). Child shell commands legitimately need the rest of
 * the environment (PATH, HOME, and the user's own project vars), so we
 * delete only the specific keys that hold Openbuff's own BYOK/OAuth/API
 * credentials AND those generic upstream provider keys — a child command
 * (or a compromised dependency it invokes) must not be able to read those
 * secrets. Keys are deleted by exact name (no wildcard filtering) so the
 * user's own variables are never disturbed; deleting an absent key is a
 * harmless no-op. The copy is a new object so process.env itself is never
 * mutated.
 */
export const getChildProcessEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env }
  delete env[BYOK_OPENROUTER_ENV_VAR]
  delete env[CHATGPT_OAUTH_TOKEN_ENV_VAR]
  delete env[OPENBUFF_CHATGPT_OAUTH_TOKEN_ENV_VAR]
  delete env['OPENBUFF_API_KEY']
  delete env['CODEBUFF_API_KEY']
  delete env['OPENAI_API_KEY']
  delete env['ANTHROPIC_API_KEY']
  delete env['OPENROUTER_API_KEY']
  return env
}

export const getByokOpenrouterApiKeyFromEnv = (): string | undefined => {
  return process.env[BYOK_OPENROUTER_ENV_VAR]
}

/**
 * Get ChatGPT OAuth token from environment variable.
 */
export const getChatGptOAuthTokenFromEnv = (): string | undefined => {
  return (
    process.env[CHATGPT_OAUTH_TOKEN_ENV_VAR] ??
    process.env[OPENBUFF_CHATGPT_OAUTH_TOKEN_ENV_VAR]
  )
}
