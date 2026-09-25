import { describe, expect, test, mock, afterEach } from 'bun:test'
import fs from 'fs'
import path from 'node:path'
import os from 'os'

import {
  getConfigDir,
  getCredentialsPath,
  getUserCredentials,
  getChatGptOAuthCredentials,
  saveChatGptOAuthCredentials,
  clearChatGptOAuthCredentials,
  isChatGptOAuthValid,
  refreshChatGptOAuthToken,
  getValidChatGptOAuthCredentials,
  userFromJson,
  type ChatGptOAuthCredentials,
} from '../credentials'

// Need to import to check env var name
import { CHATGPT_OAUTH_TOKEN_ENV_VAR } from '@codebuff/common/constants/chatgpt-oauth'

describe('credentials', () => {
  const testEnv = {
    NEXT_PUBLIC_CB_ENVIRONMENT: 'test',
  } as const

  describe('getConfigDir', () => {
    test('returns the default openbuff config path', () => {
      const dir = getConfigDir(testEnv as any)
      expect(dir).toContain('openbuff')
      expect(dir).toContain('.config')
      expect(dir).not.toContain('manicode')
    })

    test('returns same fixed path for prod environment', () => {
      const prodEnv = { NEXT_PUBLIC_CB_ENVIRONMENT: 'prod' }
      const dir = getConfigDir(prodEnv as any)
      expect(dir).toContain('openbuff')
      expect(dir).not.toContain('manicode')
    })

    test('returns same fixed path when environment is undefined', () => {
      const emptyEnv = {}
      const dir = getConfigDir(emptyEnv as any)
      expect(dir).toContain('openbuff')
      expect(dir).not.toContain('manicode')
    })

    test('honors OPENBUFF_CONFIG_DIR before XDG_CONFIG_HOME', () => {
      const dir = getConfigDir({
        OPENBUFF_CONFIG_DIR: '/custom/openbuff',
        XDG_CONFIG_HOME: '/xdg/config',
      } as any)
      expect(dir).toBe('/custom/openbuff')
    })

    test('honors XDG_CONFIG_HOME', () => {
      const dir = getConfigDir({ XDG_CONFIG_HOME: '/xdg/config' } as any)
      expect(dir).toBe(path.join('/xdg/config', 'openbuff'))
    })
  })

  describe('getCredentialsPath', () => {
    test('returns path within config directory', () => {
      const credPath = getCredentialsPath(testEnv as any)
      expect(credPath).toContain('credentials.json')
      expect(credPath).toContain('openbuff')
      expect(credPath).not.toContain('manicode')
    })
  })

  describe('userFromJson', () => {
    test('returns null for invalid JSON', () => {
      const user = userFromJson('not valid json')
      expect(user).toBeNull()
    })

    test('returns null for missing default user', () => {
      const json = JSON.stringify({ chatgptOAuth: { accessToken: 'test' } })
      const user = userFromJson(json)
      expect(user).toBeNull()
    })

    test('returns null for empty object', () => {
      const user = userFromJson('{}')
      expect(user).toBeNull()
    })
  })

  describe('getUserCredentials', () => {
    test('returns null when credentials file does not exist', () => {
      const env = { NEXT_PUBLIC_CB_ENVIRONMENT: 'nonexistent' } as any
      const user = getUserCredentials(env)
      expect(user).toBeNull()
    })
  })

  describe('getChatGptOAuthCredentials', () => {
    test('returns null when no credentials exist', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-nocreds-'))
      const originalHomedir = os.homedir
      ;(os as any).homedir = () => tmpDir

      try {
        const env = {
          NEXT_PUBLIC_CB_ENVIRONMENT: 'chatgpt-nonexistent-env',
        } as any
        const creds = getChatGptOAuthCredentials(env)
        expect(creds).toBeNull()
      } finally {
        ;(os as any).homedir = originalHomedir
        fs.rmSync(tmpDir, { recursive: true })
      }
    })

    test('returns credentials from environment variable when set', () => {
      const originalToken = process.env[CHATGPT_OAUTH_TOKEN_ENV_VAR]
      process.env[CHATGPT_OAUTH_TOKEN_ENV_VAR] = 'chatgpt-env-token-123'

      try {
        const creds = getChatGptOAuthCredentials(testEnv as any)
        expect(creds).not.toBeNull()
        expect(creds?.accessToken).toBe('chatgpt-env-token-123')
        expect(creds?.refreshToken).toBe('')
        expect(creds?.expiresAt).toBeGreaterThan(Date.now())
      } finally {
        if (originalToken) {
          process.env[CHATGPT_OAUTH_TOKEN_ENV_VAR] = originalToken
        } else {
          delete process.env[CHATGPT_OAUTH_TOKEN_ENV_VAR]
        }
      }
    })
  })

  describe('save/clear ChatGPT OAuth credentials', () => {
    test('saves and clears ChatGPT OAuth credentials while preserving user credentials', () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'chatgpt-save-clear-test-'),
      )
      const env = { NEXT_PUBLIC_CB_ENVIRONMENT: 'test' } as any
      const originalHomedir = os.homedir
      ;(os as any).homedir = () => tmpDir

      try {
        const configDir = getConfigDir(env)
        fs.mkdirSync(configDir, { recursive: true })

        const initial = {
          default: {
            userId: 'user-chatgpt',
            email: 'user-chatgpt@test.com',
            token: 'token-chatgpt',
          },
        }
        fs.writeFileSync(
          path.join(configDir, 'credentials.json'),
          JSON.stringify(initial),
        )

        const newCreds: ChatGptOAuthCredentials = {
          accessToken: 'chatgpt-access',
          refreshToken: 'chatgpt-refresh',
          expiresAt: Date.now() + 3_600_000,
          connectedAt: Date.now(),
        }

        saveChatGptOAuthCredentials(newCreds, env)

        let parsed = JSON.parse(
          fs.readFileSync(path.join(configDir, 'credentials.json'), 'utf8'),
        )
        expect(parsed.default.userId).toBe('user-chatgpt')
        expect(parsed.chatgptOAuth.accessToken).toBe('chatgpt-access')

        clearChatGptOAuthCredentials(env)

        parsed = JSON.parse(
          fs.readFileSync(path.join(configDir, 'credentials.json'), 'utf8'),
        )
        expect(parsed.chatgptOAuth).toBeUndefined()
        expect(parsed.default.userId).toBe('user-chatgpt')
      } finally {
        ;(os as any).homedir = originalHomedir
        fs.rmSync(tmpDir, { recursive: true })
      }
    })
  })

  describe('writeCredentialsFileAtomic EEXIST/EPERM fallback', () => {
    const makeErrnoError = (code: string): NodeJS.ErrnoException => {
      const error: NodeJS.ErrnoException = new Error(
        `simulated ${code} from renameSync`,
      )
      error.code = code
      return error
    }

    // Fail specific 1-indexed renameSync call numbers so tests can exercise
    // each branch of the fallback independently.
    const stubRenameFailures = (failingCalls: number[], code = 'EEXIST') => {
      const originalRenameSync = fs.renameSync
      const failing = new Set(failingCalls)
      let call = 0
      ;(fs as any).renameSync = (...args: unknown[]) => {
        call++
        if (failing.has(call)) {
          throw makeErrnoError(code)
        }
        return (originalRenameSync as (...renameArgs: unknown[]) => void)(
          ...(args as [string, string]),
        )
      }
      return () => {
        fs.renameSync = originalRenameSync
      }
    }
    const setupCredentialsFile = (env: any) => {
      const configDir = getConfigDir(env)
      fs.mkdirSync(configDir, { recursive: true })
      const credPath = getCredentialsPath(env)
      const oldContent = JSON.stringify({
        default: {
          userId: 'user-fallback',
          email: 'user-fallback@test.com',
          token: 'token-old',
        },
      })
      fs.writeFileSync(credPath, oldContent)
      return { configDir, credPath, oldContent }
    }

    const newCreds = (): ChatGptOAuthCredentials => ({
      accessToken: 'chatgpt-fallback-access',
      refreshToken: 'chatgpt-fallback-refresh',
      expiresAt: Date.now() + 3_600_000,
      connectedAt: Date.now(),
    })

    test(
      'keeps the credentials file present with old or new content when ' +
        'the first rename fails with EEXIST',
      () => {
        const tmpDir = fs.mkdtempSync(
          path.join(os.tmpdir(), 'chatgpt-fallback-eexist-'),
        )
        const env = { NEXT_PUBLIC_CB_ENVIRONMENT: 'test' } as any
        const originalHomedir = os.homedir
        ;(os as any).homedir = () => tmpDir

        try {
          const { credPath, configDir } = setupCredentialsFile(env)
          const restoreRename = stubRenameFailures([1])

          try {
            saveChatGptOAuthCredentials(newCreds(), env)

            // The swap succeeded via the fallback: new content is in place.
            expect(fs.existsSync(credPath)).toBe(true)
            const parsed = JSON.parse(fs.readFileSync(credPath, 'utf8'))
            expect(parsed.chatgptOAuth.accessToken).toBe(
              'chatgpt-fallback-access',
            )
            expect(parsed.default.userId).toBe('user-fallback')

            // The backup was cleaned up and no stray temp/backup files remain.
            const leftovers = fs
              .readdirSync(configDir)
              .filter((name) => /\.bak\.|\.tmp\./.test(name))
            expect(leftovers).toEqual([])
          } finally {
            restoreRename()
          }
        } finally {
          ;(os as any).homedir = originalHomedir
          fs.rmSync(tmpDir, { recursive: true })
        }
      },
    )

    test(
      'preserves the old credentials file and a recoverable backup when ' +
        'the swap rename fails again — the file is never left missing',
      () => {
        const tmpDir = fs.mkdtempSync(
          path.join(os.tmpdir(), 'chatgpt-fallback-fail-'),
        )
        const env = { NEXT_PUBLIC_CB_ENVIRONMENT: 'test' } as any
        const originalHomedir = os.homedir
        ;(os as any).homedir = () => tmpDir

        // Copy-based fallback: renameSync is only called for temp -> target.
        // Failing BOTH calls (calls 1 and 2) exercises the branch where the
        // swap rename fails again after the copy — the target must still
        // hold the old content and the backup must survive for recovery.
        const restoreRename = stubRenameFailures([1, 2], 'EPERM')

        try {
          const { credPath, configDir, oldContent } = setupCredentialsFile(env)

          expect(() => saveChatGptOAuthCredentials(newCreds(), env)).toThrow()

          // Copy-based fallback: the target is never moved away, so after a
          // failed rename it still exists with the OLD content, and the
          // copy-based backup preserves a recoverable copy of the original.
          expect(fs.existsSync(credPath)).toBe(true)
          expect(fs.readFileSync(credPath, 'utf8')).toBe(oldContent)
          const backups = fs
            .readdirSync(configDir)
            .filter((name) => /\.bak\./.test(name))
          expect(backups.length).toBe(1)
          expect(fs.readFileSync(path.join(configDir, backups[0]!), 'utf8')).toBe(
            oldContent,
          )
        } finally {
          restoreRename()
          ;(os as any).homedir = originalHomedir
          fs.rmSync(tmpDir, { recursive: true })
        }
      },
    )
  })

  describe('isChatGptOAuthValid', () => {
    test('returns false when no credentials exist', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-novalid-'))
      const originalHomedir = os.homedir
      ;(os as any).homedir = () => tmpDir

      try {
        const env = { NEXT_PUBLIC_CB_ENVIRONMENT: 'chatgpt-novalid-env' } as any
        const valid = isChatGptOAuthValid(env)
        expect(valid).toBe(false)
      } finally {
        ;(os as any).homedir = originalHomedir
        fs.rmSync(tmpDir, { recursive: true })
      }
    })
  })

  describe('refreshChatGptOAuthToken', () => {
    const originalFetch = globalThis.fetch

    afterEach(() => {
      globalThis.fetch = originalFetch
    })

    test('returns null when no credentials exist', async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'chatgpt-norefresh-'),
      )
      const originalHomedir = os.homedir
      ;(os as any).homedir = () => tmpDir

      try {
        const env = {
          NEXT_PUBLIC_CB_ENVIRONMENT: 'chatgpt-norefresh-env',
        } as any
        const result = await refreshChatGptOAuthToken(env)
        expect(result).toBeNull()
      } finally {
        ;(os as any).homedir = originalHomedir
        fs.rmSync(tmpDir, { recursive: true })
      }
    })

    test('successfully refreshes token', async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'chatgpt-refresh-test-'),
      )
      const env = { NEXT_PUBLIC_CB_ENVIRONMENT: 'test' } as any
      const originalHomedir = os.homedir
      ;(os as any).homedir = () => tmpDir

      try {
        const configDir = getConfigDir(env)
        fs.mkdirSync(configDir, { recursive: true })

        const credentials = {
          chatgptOAuth: {
            accessToken: 'old-chatgpt-access',
            refreshToken: 'chatgpt-refresh-token-123',
            expiresAt: Date.now() - 1_000,
            connectedAt: Date.now() - 7_200_000,
          },
        }
        fs.writeFileSync(
          path.join(configDir, 'credentials.json'),
          JSON.stringify(credentials),
        )

        const mockFetch = mock(() =>
          Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                access_token: 'new-chatgpt-access-token',
                refresh_token: 'new-chatgpt-refresh-token',
                expires_in: 3600,
              }),
          } as Response),
        )
        globalThis.fetch = mockFetch as unknown as typeof fetch

        const result = await refreshChatGptOAuthToken(env)

        expect(result).not.toBeNull()
        expect(result?.accessToken).toBe('new-chatgpt-access-token')
        expect(result?.refreshToken).toBe('new-chatgpt-refresh-token')
      } finally {
        ;(os as any).homedir = originalHomedir
        fs.rmSync(tmpDir, { recursive: true })
      }
    })

    test('shares one fetch for two concurrent refreshes with the SAME config dir', async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'chatgpt-refresh-same-dir-'),
      )
      // M2-T5 repair: the config dir must live under the MOCKED homedir (an
      // isolated tmpDir), not a root-level absolute path — writeCredentialsFileAtomic
      // creates it with mode 0700, so an absolute path like '/shared-refresh-dir-a'
      // cannot be created by an unprivileged test user, and getChatGptOAuthCredentials
      // reads via the homedir-derived getConfigDir while the file was written to the
      // literal path.
      const env = {
        OPENBUFF_CONFIG_DIR: path.join(tmpDir, 'shared-refresh-dir'),
      } as any
      const originalHomedir = os.homedir
      ;(os as any).homedir = () => tmpDir

      try {
        const configDir = getConfigDir(env)
        fs.mkdirSync(configDir, { recursive: true })
        fs.writeFileSync(
          path.join(configDir, 'credentials.json'),
          JSON.stringify({
            chatgptOAuth: {
              accessToken: 'old-access',
              refreshToken: 'shared-refresh-token',
              expiresAt: Date.now() - 1_000,
              connectedAt: Date.now() - 7_200_000,
            },
          }),
        )

        let fetchCalls = 0
        globalThis.fetch = mock(() => {
          fetchCalls++
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                access_token: 'shared-refresh-access',
                refresh_token: 'shared-refresh-token',
                expires_in: 3600,
              }),
          } as Response)
        }) as unknown as typeof fetch

        const [a, b] = await Promise.all([
          refreshChatGptOAuthToken(env),
          refreshChatGptOAuthToken(env),
        ])

        expect(fetchCalls).toBe(1)
        expect(a).not.toBeNull()
        expect(b).toBe(a)
      } finally {
        ;(os as any).homedir = originalHomedir
        fs.rmSync(tmpDir, { recursive: true })
      }
    })

    test('issues two fetches for two concurrent refreshes with DIFFERENT config dirs', async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'chatgpt-refresh-multi-dir-'),
      )
      // M2-T5 repair: same isolation rule as the same-dir test above — the
      // config dirs must live under the mocked homedir's tmpDir so they can
      // actually be created and read.
      const envA = {
        OPENBUFF_CONFIG_DIR: path.join(tmpDir, 'refresh-dir-a'),
      } as any
      const envB = {
        OPENBUFF_CONFIG_DIR: path.join(tmpDir, 'refresh-dir-b'),
      } as any
      const originalHomedir = os.homedir
      ;(os as any).homedir = () => tmpDir

      try {
        for (const env of [envA, envB]) {
          fs.mkdirSync(getConfigDir(env), { recursive: true })
          fs.writeFileSync(
            path.join(getConfigDir(env), 'credentials.json'),
            JSON.stringify({
              chatgptOAuth: {
                accessToken: 'old-access',
                refreshToken: 'dir-refresh-token',
                expiresAt: Date.now() - 1_000,
                connectedAt: Date.now() - 7_200_000,
              },
            }),
          )
        }

        let fetchCalls = 0
        globalThis.fetch = mock(() => {
          fetchCalls++
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                access_token: 'per-dir-refresh-access',
                refresh_token: 'dir-refresh-token',
                expires_in: 3600,
              }),
          } as Response)
        }) as unknown as typeof fetch

        const [a, b] = await Promise.all([
          refreshChatGptOAuthToken(envA),
          refreshChatGptOAuthToken(envB),
        ])

        expect(fetchCalls).toBe(2)
        expect(a).not.toBeNull()
        expect(b).not.toBeNull()
      } finally {
        ;(os as any).homedir = originalHomedir
        fs.rmSync(tmpDir, { recursive: true })
      }
    })
  })

  describe('getValidChatGptOAuthCredentials', () => {
    test('returns null when no credentials exist', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-nocreds2-'))
      const originalHomedir = os.homedir
      ;(os as any).homedir = () => tmpDir

      try {
        const env = { NEXT_PUBLIC_CB_ENVIRONMENT: 'chatgpt-no-creds' } as any
        const result = await getValidChatGptOAuthCredentials(env)
        expect(result).toBeNull()
      } finally {
        ;(os as any).homedir = originalHomedir
        fs.rmSync(tmpDir, { recursive: true })
      }
    })
  })

  describe('credentials file permissions (0600) and redaction', () => {
    test('saveChatGptOAuthCredentials writes credentials.json with mode 0600', () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'chatgpt-perms-save-'),
      )
      const env = { NEXT_PUBLIC_CB_ENVIRONMENT: 'test' } as any
      const originalHomedir = os.homedir
      ;(os as any).homedir = () => tmpDir

      try {
        const creds: ChatGptOAuthCredentials = {
          accessToken: 'access-secret',
          refreshToken: 'refresh-secret',
          expiresAt: Date.now() + 3_600_000,
          connectedAt: Date.now(),
        }
        saveChatGptOAuthCredentials(creds, env)

        const credPath = getCredentialsPath(env)
        const stat = fs.statSync(credPath)
        // Owner read/write only (0600). Mask off file type bits.
        const mode = stat.mode & 0o777
        expect(mode).toBe(0o600)
      } finally {
        ;(os as any).homedir = originalHomedir
        fs.rmSync(tmpDir, { recursive: true })
      }
    })

    test('saveChatGptOAuthCredentials creates config dir with mode 0700', () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'chatgpt-perms-dir-'),
      )
      const env = { NEXT_PUBLIC_CB_ENVIRONMENT: 'test' } as any
      const originalHomedir = os.homedir
      ;(os as any).homedir = () => tmpDir

      try {
        const creds: ChatGptOAuthCredentials = {
          accessToken: 'access-secret',
          refreshToken: 'refresh-secret',
          expiresAt: Date.now() + 3_600_000,
          connectedAt: Date.now(),
        }
        saveChatGptOAuthCredentials(creds, env)

        const dirStat = fs.statSync(getConfigDir(env))
        expect(dirStat.mode & 0o777).toBe(0o700)
      } finally {
        ;(os as any).homedir = originalHomedir
        fs.rmSync(tmpDir, { recursive: true })
      }
    })

    test('saveChatGptOAuthCredentials tightens an existing 0777 dir down to 0700', () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'chatgpt-perms-tighten-'),
      )
      const env = { NEXT_PUBLIC_CB_ENVIRONMENT: 'test' } as any
      const originalHomedir = os.homedir
      ;(os as any).homedir = () => tmpDir

      try {
        const configDir = getConfigDir(env)
        fs.mkdirSync(configDir, { recursive: true, mode: 0o777 })
        // Re-chmod to 0777 after umask masking (mkdir mode is masked by umask).
        fs.chmodSync(configDir, 0o777)
        expect(fs.statSync(configDir).mode & 0o777).toBe(0o777)

        const creds: ChatGptOAuthCredentials = {
          accessToken: 'access-secret',
          refreshToken: 'refresh-secret',
          expiresAt: Date.now() + 3_600_000,
          connectedAt: Date.now(),
        }
        saveChatGptOAuthCredentials(creds, env)

        expect(fs.statSync(configDir).mode & 0o777).toBe(0o700)
      } finally {
        ;(os as any).homedir = originalHomedir
        fs.rmSync(tmpDir, { recursive: true })
      }
    })

    test('clearChatGptOAuthCredentials preserves 0600 mode on rewrite', () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'chatgpt-perms-clear-'),
      )
      const env = { NEXT_PUBLIC_CB_ENVIRONMENT: 'test' } as any
      const originalHomedir = os.homedir
      ;(os as any).homedir = () => tmpDir

      try {
        const creds: ChatGptOAuthCredentials = {
          accessToken: 'access-secret',
          refreshToken: 'refresh-secret',
          expiresAt: Date.now() + 3_600_000,
          connectedAt: Date.now(),
        }
        saveChatGptOAuthCredentials(creds, env)

        const credPath = getCredentialsPath(env)
        expect(fs.statSync(credPath).mode & 0o777).toBe(0o600)

        clearChatGptOAuthCredentials(env)

        // File still exists (default user preserved) and remains 0600.
        expect(fs.existsSync(credPath)).toBe(true)
        expect(fs.statSync(credPath).mode & 0o777).toBe(0o600)
      } finally {
        ;(os as any).homedir = originalHomedir
        fs.rmSync(tmpDir, { recursive: true })
      }
    })

    test('getUserCredentials logs a redacted message when readFileSync throws', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-redact-'))
      const env = { NEXT_PUBLIC_CB_ENVIRONMENT: 'test' } as any
      const originalHomedir = os.homedir
      ;(os as any).homedir = () => tmpDir

      // Capture console.error to assert the redacted catch block fires.
      const originalConsoleError = console.error
      const logged: string[] = []
      console.error = (...args: unknown[]) => {
        logged.push(args.map((a) => String(a)).join(' '))
      }

      try {
        const configDir = getConfigDir(env)
        fs.mkdirSync(configDir, { recursive: true })
        // Make credentials.json a directory so fs.readFileSync throws EISDIR.
        // This is the reachable path into getUserCredentials' catch block:
        // userFromJson swallows JSON parse errors internally, so malformed JSON
        // never reaches this catch — only readFileSync failures do.
        fs.mkdirSync(path.join(configDir, 'credentials.json'))

        const user = getUserCredentials(env)
        expect(user).toBeNull()

        // The catch block fired exactly once with the redacted prefix.
        expect(logged.length).toBe(1)
        const loggedLine = logged[0]
        expect(loggedLine).toContain('Error reading credentials file:')
        // The raw error object must not be appended wholesale; only a
        // truncated `name: message` string is logged.
        expect(loggedLine).not.toMatch(/\{[\s\S]*stack[\s\S]*\}/)
      } finally {
        console.error = originalConsoleError
        ;(os as any).homedir = originalHomedir
        fs.rmSync(tmpDir, { recursive: true })
      }
    })
  })
})
