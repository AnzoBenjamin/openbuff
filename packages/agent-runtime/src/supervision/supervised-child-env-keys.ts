/**
 * Closed universe of NON-credential runtime keys a supervised child may
 * receive, each only when the caller seeds it explicitly (P2-T8 env
 * allowlist fix): the provider-config endpoint override
 * (`OPENBUFF_PROVIDER_CONFIG` — the provider layer resolves every
 * baseURL/apiKeyEnv from the config file this var points to), the standard
 * proxy configuration (both cases — POSIX tools read the lowercase forms),
 * the temp dir, the locale set, and the ripgrep override pinned by the X-1
 * golden vectors. Credential-bearing keys are NEVER in this list and are
 * never forwarded; ambient keys are never scraped wholesale into it.
 *
 * LEAF MODULE: deliberately import-free so the SDK impl seam
 * (sdk/src/impl/agent-runtime.ts) can enumerate these keys WITHOUT
 * evaluating supervision/process-supervisor.ts — supervised-spawn.ts keeps
 * the supervisor (and the receipt-schema imports it pulls) lazy behind its
 * dynamic import, so the flag-off hot path must not touch it.
 */
export const SUPERVISED_CHILD_RUNTIME_ENV_KEYS = [
  'OPENBUFF_PROVIDER_CONFIG',
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'CODEBUFF_RG_PATH',
] as const
