/**
 * CI environment helper for dependency injection.
 *
 * This module provides a typed interface to CI-specific environment variables.
 * These are used in CI/CD pipelines and eval contexts.
 * In tests, use `@codebuff/common/testing-env-ci`.
 */

import type { CiEnv } from './types/contracts/env'

/**
 * Get CI environment values.
 * Returns a snapshot of the current process.env values for CI-specific vars.
 */
export const getCiEnv = (environment: Readonly<Record<string, string | undefined>> = process.env): CiEnv => ({
  CI: environment.CI,
  GITHUB_ACTIONS: environment.GITHUB_ACTIONS,
  RENDER: environment.RENDER,
  IS_PULL_REQUEST: environment.IS_PULL_REQUEST,
  CODEBUFF_GITHUB_TOKEN: environment.CODEBUFF_GITHUB_TOKEN,
  CODEBUFF_CHATGPT_OAUTH_TOKEN:
    environment.CODEBUFF_CHATGPT_OAUTH_TOKEN ??
    environment.OPENBUFF_CHATGPT_OAUTH_TOKEN,
  OPENBUFF_CHATGPT_OAUTH_TOKEN: environment.OPENBUFF_CHATGPT_OAUTH_TOKEN,
  LINKUP_API_KEY: environment.LINKUP_API_KEY,
})

/**
 * Default CI env instance.
 * Use this for production code, inject mocks in tests.
 */
export const ciEnv: CiEnv = getCiEnv()

/**
 * Check if running in CI environment
 */
export const isCI = (): boolean => {
  const env = getCiEnv()
  return env.CI === 'true' || env.CI === '1' || env.GITHUB_ACTIONS === 'true'
}
