/**
 * Canonical list of credential-bearing environment variable names that must
 * never reach child processes (or other untrusted consumers of a host env).
 *
 * This is a LEAF module: it must not import from provider-config (or anything
 * that transitively does) because env.ts and the tool layer consume it on hot
 * paths where a config-loading import cycle would break module
 * initialization. The built-in preset `apiKeyEnv` names below are lifted
 * literally from OPENBUFF_PROVIDER_PRESETS in sdk/src/provider-config.ts;
 * keep the two in sync when a preset adds or renames its env var.
 */

import { BYOK_OPENROUTER_ENV_VAR } from '@codebuff/common/constants/byok'
import {
  CHATGPT_OAUTH_TOKEN_ENV_VAR,
  OPENBUFF_CHATGPT_OAUTH_TOKEN_ENV_VAR,
} from '@codebuff/common/constants/chatgpt-oauth'

/**
 * Exact-name (no wildcards) credential env keys stripped from child-process
 * environments. Deleting an absent key is a harmless no-op, and user-owned
 * variables (PATH, HOME, project vars, ...) are never matched.
 */
export const CREDENTIAL_ENV_KEYS = [
  // Openbuff's own credentials: the BYOK OpenRouter key, the ChatGPT OAuth
  // tokens, and the Openbuff/Codebuff API keys.
  BYOK_OPENROUTER_ENV_VAR,
  CHATGPT_OAUTH_TOKEN_ENV_VAR,
  OPENBUFF_CHATGPT_OAUTH_TOKEN_ENV_VAR,
  'OPENBUFF_API_KEY',
  'CODEBUFF_API_KEY',

  // Generic upstream provider API keys the agent process may hold.
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',

  // Other common provider credentials that must not leak to child processes.
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'TOGETHER_API_KEY',
  'FIREWORKS_API_KEY',
  'XAI_API_KEY',

  // Built-in preset provider apiKeyEnv names (OPENBUFF_PROVIDER_PRESETS in
  // sdk/src/provider-config.ts).
  'OPENCODE_GO_API_KEY',
  'GLM_API_KEY',
  'AWS_BEARER_TOKEN_BEDROCK',
  'FREEMODEL_API_KEY',
] as const
