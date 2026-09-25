import fs from 'fs'
import path from 'node:path'
import os from 'os'

import {
  CHATGPT_OAUTH_CLIENT_ID,
  CHATGPT_OAUTH_TOKEN_URL,
} from '@codebuff/common/constants/chatgpt-oauth'
import { userSchema } from '@codebuff/common/util/credentials'
import { z } from 'zod/v4'

import { getChatGptOAuthTokenFromEnv, getSdkEnv } from './env'

import type { ClientEnv } from '@codebuff/common/types/contracts/env'
import type { User } from '@codebuff/common/util/credentials'

const chatGptOAuthSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
  connectedAt: z.number(),
})

const CHATGPT_OAUTH_REFRESH_TIMEOUT_MS = 30 * 1000

/**
 * Unified schema for the credentials file.
 * Contains both Codebuff user credentials and ChatGPT OAuth credentials.
 */
const credentialsFileSchema = z.object({
  default: userSchema.optional(),
  chatgptOAuth: chatGptOAuthSchema.optional(),
})

/**
 * Ensure the config directory exists with owner-only permissions (0700).
 * The credentials file holds OAuth tokens and the default API key, so the
 * containing directory must not be group/world readable. Existing dirs are
 * chmod'd down to 0700 if they were created more permissively.
 */
const ensureDirectoryExistsSync = (dir: string) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    // mkdir mode is masked by umask; explicitly enforce the intended mode.
    fs.chmodSync(dir, 0o700)
  } else {
    // Tighten an already-existing dir if it was created more permissively.
    try {
      fs.chmodSync(dir, 0o700)
    } catch {
      // chmod can fail on exotic filesystems (e.g. network mounts) — not fatal;
      // the file-level 0600 below is the primary control.
    }
  }
}

export const userFromJson = (json: string): User | null => {
  try {
    const credentials = credentialsFileSchema.parse(JSON.parse(json))
    return credentials.default ?? null
  } catch {
    return null
  }
}

/**
 * Owner-only (0600) atomic write used for every credentials-file update:
 * serialize to a temp file in the same directory, fsync, then rename over the
 * target so a crash mid-write can never leave a truncated credentials file
 * behind (which would otherwise fail subsequent parses silently).
 */
const writeCredentialsFileAtomic = (
  filePath: string,
  value: unknown,
): void => {
  ensureDirectoryExistsSync(path.dirname(filePath))
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
  const handle = fs.openSync(tempPath, 'wx', 0o600)
  try {
    fs.writeFileSync(handle, JSON.stringify(value, null, 2))
    fs.fsyncSync(handle)
  } finally {
    fs.closeSync(handle)
  }
  try {
    fs.renameSync(tempPath, filePath)
  } catch (error) {
    if (
      !['EEXIST', 'EPERM'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )
    ) {
      throw error
    }
    // Fallback for filesystems that cannot rename over an existing target
    // (e.g. Windows EPERM/EEXIST). The target path is NEVER emptied:
    // the old content is COPIED to a unique backup (a failed copy leaves
    // the target untouched), the new content is renamed over the target
    // in one atomic step, and only after that succeeds is the backup
    // removed. A crash in any window leaves either the old or the new
    // credentials in place at the target path — the file holds OAuth
    // tokens and the default API key, so unlink-then-rename here would
    // mean a crash between the two calls destroys them irreversibly.
    const backupPath = `${filePath}.bak.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
    try {
      fs.copyFileSync(filePath, backupPath)
      fs.chmodSync(backupPath, 0o600)
    } catch {
      // A failed copy leaves the target (and its permissions) untouched;
      // fall through to retry the plain rename.
    }
    try {
      fs.renameSync(tempPath, filePath)
    } catch (renameError) {
      // The rename failed again. The copy already preserved the old
      // content at the backup path and the target still holds the old
      // content, so nothing was lost; leave the backup in place as the
      // recoverable copy and surface the failure.
      throw renameError
    }
    try {
      fs.unlinkSync(backupPath)
    } catch {
      // Best-effort cleanup; the swap already succeeded.
    }
  }
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    // Best-effort enforcement; ignore on filesystems that don't support chmod.
  }
}

/**
 * Get the config directory path based on the environment.
 * Uses the clientEnv to determine the environment suffix.
 */
type ConfigPathEnv = ClientEnv & {
  OPENBUFF_CONFIG_DIR?: string
  XDG_CONFIG_HOME?: string
  APPDATA?: string
}

export const getConfigDir = (clientEnv?: Partial<ConfigPathEnv>): string => {
  // An explicitly injected environment is authoritative. Merging live process
  // variables into it breaks test isolation and lets a host XDG/APPDATA value
  // redirect an otherwise isolated caller into the real user config.
  const configEnv: Partial<ConfigPathEnv> = clientEnv ?? getSdkEnv()
  if (configEnv.OPENBUFF_CONFIG_DIR) return configEnv.OPENBUFF_CONFIG_DIR
  if (process.platform === 'win32' && configEnv.APPDATA) {
    return path.join(configEnv.APPDATA, 'openbuff')
  }
  if (configEnv.XDG_CONFIG_HOME) {
    return path.join(configEnv.XDG_CONFIG_HOME, 'openbuff')
  }
  return path.join(os.homedir(), '.config', 'openbuff')
}

export const getHarnessStateDir = (
  clientEnv?: Partial<ConfigPathEnv>,
): string => path.join(getConfigDir(clientEnv), 'state', 'harness')

/**
 * Get the credentials file path based on the environment.
 */
export const getCredentialsPath = (clientEnv?: ClientEnv): string => {
  return path.join(getConfigDir(clientEnv), 'credentials.json')
}

export const getUserCredentials = (clientEnv?: ClientEnv): User | null => {
  const credentialsPath = getCredentialsPath(clientEnv)
  if (!fs.existsSync(credentialsPath)) {
    return null
  }

  try {
    const credentialsFile = fs.readFileSync(credentialsPath, 'utf8')
    const user = userFromJson(credentialsFile)
    return user || null
  } catch (error) {
    // Redact the raw error object: it may embed the credentials file contents
    // (e.g. a JSON SyntaxError message includes the offending text). Only log
    // a sanitized message + the error name so tokens never reach the logs.
    const detail =
      error instanceof Error
        ? `${error.name}: ${error.message.slice(0, 120)}${error.message.length > 120 ? '…' : ''}`
        : 'unknown error'
    console.error('Error reading credentials file:', detail)
    return null
  }
}

/**
 * ChatGPT OAuth credentials stored in the credentials file.
 */
export interface ChatGptOAuthCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number // Unix timestamp in milliseconds
  connectedAt: number // Unix timestamp in milliseconds
}

/**
 * Get ChatGPT OAuth credentials from environment variable or stored file.
 * Environment variable takes precedence.
 */
export const getChatGptOAuthCredentials = (
  clientEnv?: ClientEnv,
): ChatGptOAuthCredentials | null => {
  // 1. Environment variable takes highest precedence
  const envToken = getChatGptOAuthTokenFromEnv()
  if (envToken) {
    return {
      accessToken: envToken,
      refreshToken: '',
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
      connectedAt: Date.now(),
    }
  }

  // 2. Codebuff's own stored credentials
  const credentialsPath = getCredentialsPath(clientEnv)
  if (fs.existsSync(credentialsPath)) {
    try {
      const credentialsFile = fs.readFileSync(credentialsPath, 'utf8')
      const parsed = credentialsFileSchema.safeParse(
        JSON.parse(credentialsFile),
      )
      if (parsed.success && parsed.data.chatgptOAuth) {
        return parsed.data.chatgptOAuth
      }
    } catch {
      // Fall through
    }
  }

  return null
}

export const saveChatGptOAuthCredentials = (
  credentials: ChatGptOAuthCredentials,
  clientEnv?: ClientEnv,
): void => {
  const configDir = getConfigDir(clientEnv)
  const credentialsPath = getCredentialsPath(clientEnv)

  ensureDirectoryExistsSync(configDir)

  let existingData: Record<string, unknown> = {}
  if (fs.existsSync(credentialsPath)) {
    try {
      existingData = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))
    } catch {
      // Ignore parse errors, start fresh
    }
  }

  const updatedData = {
    ...existingData,
    chatgptOAuth: credentials,
  }

  // Write with owner-only permissions (0600) via an atomic temp-file rename so
  // a crash mid-write never leaves a truncated credentials file behind. The
  // file contains OAuth access/refresh tokens and the default API key; it must
  // not be group/world readable.
  writeCredentialsFileAtomic(credentialsPath, updatedData)
}

export const clearChatGptOAuthCredentials = (clientEnv?: ClientEnv): void => {
  const credentialsPath = getCredentialsPath(clientEnv)
  if (!fs.existsSync(credentialsPath)) {
    return
  }

  try {
    const existingData = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))
    delete existingData.chatgptOAuth
    // Preserve the 0600 mode established by saveChatGptOAuthCredentials.
    writeCredentialsFileAtomic(credentialsPath, existingData)
  } catch {
    // Ignore errors
  }
}

export const isChatGptOAuthValid = (clientEnv?: ClientEnv): boolean => {
  const credentials = getChatGptOAuthCredentials(clientEnv)
  if (!credentials) {
    return false
  }
  const bufferMs = 5 * 60 * 1000
  return credentials.expiresAt > Date.now() + bufferMs
}

// Module-level single-flight refresh promises, keyed by the config-dir
// identity the negative cache and credentials files are keyed by. One global
// slot would make caller B joining caller A's in-flight refresh receive A's
// tokens (saved to A's file) even across different credential stores (M2-T5).
const chatGptRefreshPromises = new Map<
  string,
  Promise<ChatGptOAuthCredentials | null>
>()

// Module-level negative cache for failed refresh attempts, keyed by config-Dir
// identity. Contains the last-failure wall-clock time only — no token material.
const REFRESH_FAILURE_TTL_MS = 45_000
const chatGptRefreshFailureAt = new Map<string, number>()

export const refreshChatGptOAuthToken = (
  clientEnv?: ClientEnv,
): Promise<ChatGptOAuthCredentials | null> => {
  // Compute the config-dir key FIRST so every map slot and the negative
  // cache are keyed consistently, before any credentials read/write (M2-T5).
  const refreshKey = getConfigDir(clientEnv)

  const inFlight = chatGptRefreshPromises.get(refreshKey)
  if (inFlight) {
    return inFlight
  }

  const credentials = getChatGptOAuthCredentials(clientEnv)
  if (!credentials?.refreshToken) {
    return Promise.resolve(null)
  }

  const refreshPromise = (async () => {
    let failed = false
    try {
      const response = await fetch(CHATGPT_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: credentials.refreshToken,
          client_id: CHATGPT_OAUTH_CLIENT_ID,
        }),
        signal: AbortSignal.timeout(CHATGPT_OAUTH_REFRESH_TIMEOUT_MS),
      })

      if (!response.ok) {
        console.debug(
          `ChatGPT OAuth token refresh failed (status ${response.status})`,
        )
        failed = true
        return null
      }

      const data = await response.json()

      if (
        typeof data?.access_token !== 'string' ||
        data.access_token.trim().length === 0
      ) {
        console.debug('ChatGPT OAuth token refresh returned empty access token')
        failed = true
        return null
      }

      const expiresIn =
        typeof data.expires_in === 'number'
          ? data.expires_in * 1000
          : 3600 * 1000

      const newCredentials: ChatGptOAuthCredentials = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? credentials.refreshToken,
        expiresAt: Date.now() + expiresIn,
        connectedAt: credentials.connectedAt,
      }

      saveChatGptOAuthCredentials(newCredentials, clientEnv)

      return newCredentials
    } catch (error) {
      console.debug(
        'ChatGPT OAuth token refresh failed:',
        error instanceof Error ? error.message : String(error),
      )
      failed = true
      return null
    } finally {
      // Stamp the negative cache BEFORE the shared promise resolves and the
      // map slot clears, so a caller that observes a null outcome cannot
      // start a fresh refresh before the failure is recorded (M2-T5).
      if (failed) {
        chatGptRefreshFailureAt.set(refreshKey, Date.now())
      } else {
        chatGptRefreshFailureAt.delete(refreshKey)
      }
      chatGptRefreshPromises.delete(refreshKey)
    }
  })()

  chatGptRefreshPromises.set(refreshKey, refreshPromise)

  return refreshPromise
}

export const getValidChatGptOAuthCredentials = async (
  clientEnv?: ClientEnv,
): Promise<ChatGptOAuthCredentials | null> => {
  const credentials = getChatGptOAuthCredentials(clientEnv)
  if (!credentials) {
    return null
  }

  const bufferMs = 5 * 60 * 1000

  // No refresh token (e.g. env var override) — return only if still valid
  if (!credentials.refreshToken) {
    return credentials.expiresAt > Date.now() + bufferMs ? credentials : null
  }

  if (credentials.expiresAt > Date.now() + bufferMs) {
    return credentials
  }

  // Negative cache: a refresh that failed less than REFRESH_FAILURE_TTL_MS ago
  // means we skip retrying entirely rather than re-hitting the network with
  // the same (presumably still rejected) refresh token.
  const failureKey = getConfigDir(clientEnv)
  const lastFailure = chatGptRefreshFailureAt.get(failureKey)
  if (
    lastFailure !== undefined &&
    Date.now() - lastFailure < REFRESH_FAILURE_TTL_MS
  ) {
    return null
  }

  return refreshChatGptOAuthToken(clientEnv)
}
