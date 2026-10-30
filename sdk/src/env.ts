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

import { CREDENTIAL_ENV_KEYS } from './credential-env-keys'

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

  // Diagnostic-delta preflight match mode
  OPENBUFF_DIAGNOSTIC_DELTA_MODE: process.env.OPENBUFF_DIAGNOSTIC_DELTA_MODE,
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

/**
 * UNSAFE for child-process environments: returns the RAW `process.env`,
 * including every agent credential (API keys, OAuth tokens, BYOK secrets).
 * Never hand this to a spawned child process — use {@link getChildProcessEnv}
 * (or {@link scrubChildProcessEnv} for merged caller overrides), which strip
 * the canonical credential denylist. Kept as an export because existing
 * consumers intentionally read the live agent-process environment; new
 * callers almost always want one of the scrubbing helpers instead.
 */
export const getSystemProcessEnv = (): NodeJS.ProcessEnv => {
  return process.env
}

/**
 * Environment for spawned child shell commands (e.g. run_terminal_command).
 *
 * Returns a shallow copy of process.env with every key in the canonical
 * credential denylist {@link CREDENTIAL_ENV_KEYS} removed. The denylist is
 * an EXACT-NAME list (no wildcard filtering) maintained in
 * ./credential-env-keys; it covers Openbuff's own BYOK/OAuth/API
 * credentials, the generic upstream provider API keys, other common
 * provider credentials (GEMINI_API_KEY, DEEPSEEK_API_KEY, ...), and the
 * built-in preset providers' apiKeyEnv names. Child shell commands
 * legitimately need the rest of the environment (PATH, HOME, and the
 * user's own project vars), so only those credential-named keys are
 * deleted — a child command (or a compromised dependency it invokes) must
 * not be able to read any of those secrets. Custom openbuff.json apiKeyEnv
 * names beyond the canonical list are NOT stripped here; add such a name
 * to CREDENTIAL_ENV_KEYS if it must never reach child processes. Deleting
 * an absent key is a harmless no-op, and the copy is a new object so
 * process.env itself is never mutated.
 */
export const getChildProcessEnv = (): NodeJS.ProcessEnv => {
  return scrubChildProcessEnv(process.env)
}

/**
 * Whether `name` case-insensitively matches an entry in the canonical
 * credential denylist {@link CREDENTIAL_ENV_KEYS}. Windows environment
 * blocks are case-insensitive, so a credential stored under a
 * non-canonical case (e.g. 'openai_api_key') is still what a child shell
 * resolves for %OPENAI_API_KEY%. Exported for testing.
 */
const LOWERCASED_CREDENTIAL_ENV_KEYS = new Set(
  CREDENTIAL_ENV_KEYS.map((key) => key.toLowerCase()),
)

export const matchesCredentialEnvKeyIgnoreCase = (name: string): boolean =>
  LOWERCASED_CREDENTIAL_ENV_KEYS.has(name.toLowerCase())

/**
 * Applies the same credential strip as {@link getChildProcessEnv} to an
 * arbitrary environment object: every key in the canonical denylist
 * {@link CREDENTIAL_ENV_KEYS} is removed by exact name (no wildcards;
 * deleting an absent key is a no-op) and a NEW object is returned — the
 * input, including process.env, is never mutated. On win32 the match is
 * additionally case-insensitive, because Windows environment blocks are
 * case-insensitive and a credential stored under a non-canonical case
 * (e.g. 'openai_api_key') would otherwise survive the copy while the
 * child shell still resolves %OPENAI_API_KEY% to it; on POSIX only
 * exact-name deletes happen, to avoid surprising case-collisions on
 * case-sensitive platforms. Used for merge-after-scrub: when
 * caller-supplied env overrides are merged into a child-process env, the
 * merged object is passed here so credential-named keys cannot be
 * re-injected through the override.
 */
export const scrubChildProcessEnv = (
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  const scrubbed = { ...env }
  for (const key of CREDENTIAL_ENV_KEYS) {
    delete scrubbed[key]
  }
  if (process.platform === 'win32') {
    for (const key of Object.keys(scrubbed)) {
      if (matchesCredentialEnvKeyIgnoreCase(key)) {
        delete scrubbed[key]
      }
    }
  }
  return scrubbed
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
