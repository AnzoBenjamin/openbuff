import { describe, test, expect, afterEach } from 'bun:test'

import {
  getChatGptOAuthTokenFromEnv,
  getChildProcessEnv,
  getOpenbuffApiKeyFromEnv,
  getSdkEnv,
  matchesCredentialEnvKeyIgnoreCase,
  scrubChildProcessEnv,
} from '../env'
import { createTestSdkEnv } from '../testing/env'

const originalPlatform = process.platform
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  'platform',
)

// Windows environment blocks are case-insensitive; these helpers let the
// win32 branch of scrubChildProcessEnv be exercised on any platform.
const setProcessPlatform = (platform: NodeJS.Platform) => {
  Object.defineProperty(process, 'platform', {
    value: platform,
    writable: true,
    configurable: true,
    enumerable: true,
  })
}

const restoreProcessPlatform = () => {
  Object.defineProperty(process, 'platform', {
    value: originalPlatform,
    writable: originalPlatformDescriptor?.writable ?? true,
    configurable: originalPlatformDescriptor?.configurable ?? true,
    enumerable: originalPlatformDescriptor?.enumerable ?? true,
  })
}

describe('sdk/env', () => {
  describe('getSdkEnv', () => {
    const originalEnv = { ...process.env }

    afterEach(() => {
      // Restore original env
      Object.keys(process.env).forEach((key) => {
        if (!(key in originalEnv)) {
          delete process.env[key]
        }
      })
      Object.assign(process.env, originalEnv)
    })

    test('returns current process.env values for base vars', () => {
      process.env.SHELL = '/bin/zsh'
      process.env.HOME = '/Users/testuser'
      const env = getSdkEnv()
      expect(env.SHELL).toBe('/bin/zsh')
      expect(env.HOME).toBe('/Users/testuser')
    })

    test('returns current process.env values for CODEBUFF_RG_PATH', () => {
      process.env.CODEBUFF_RG_PATH = '/path/to/rg'
      const env = getSdkEnv()
      expect(env.CODEBUFF_RG_PATH).toBe('/path/to/rg')
    })

    test('returns current process.env values for CODEBUFF_WASM_DIR', () => {
      process.env.CODEBUFF_WASM_DIR = '/path/to/wasm'
      const env = getSdkEnv()
      expect(env.CODEBUFF_WASM_DIR).toBe('/path/to/wasm')
    })

    test('returns current process.env values for build flags', () => {
      process.env.VERBOSE = 'true'
      process.env.OVERRIDE_TARGET = 'linux-x64'
      const env = getSdkEnv()
      expect(env.VERBOSE).toBe('true')
      expect(env.OVERRIDE_TARGET).toBe('linux-x64')
    })

    test('returns undefined for unset env vars', () => {
      delete process.env.CODEBUFF_RG_PATH
      delete process.env.CODEBUFF_WASM_DIR
      const env = getSdkEnv()
      expect(env.CODEBUFF_RG_PATH).toBeUndefined()
      expect(env.CODEBUFF_WASM_DIR).toBeUndefined()
    })

    test('returns a snapshot that does not change when process.env changes', () => {
      process.env.CODEBUFF_RG_PATH = '/original/path'
      const env = getSdkEnv()
      process.env.CODEBUFF_RG_PATH = '/new/path'
      expect(env.CODEBUFF_RG_PATH).toBe('/original/path')
    })
  })

  describe('createTestSdkEnv', () => {
    test('returns a SdkEnv with default test values', () => {
      const env = createTestSdkEnv()
      expect(env.HOME).toBe('/home/test')
      expect(env.NODE_ENV).toBe('test')
      expect(env.TERM).toBe('xterm-256color')
      expect(env.PATH).toBe('/usr/bin')
    })

    test('returns undefined for SDK-specific vars by default', () => {
      const env = createTestSdkEnv()
      expect(env.CODEBUFF_RG_PATH).toBeUndefined()
      expect(env.CODEBUFF_WASM_DIR).toBeUndefined()
      expect(env.VERBOSE).toBeUndefined()
      expect(env.OVERRIDE_TARGET).toBeUndefined()
    })

    test('allows overriding SDK-specific values', () => {
      const env = createTestSdkEnv({
        CODEBUFF_RG_PATH: '/custom/rg',
        CODEBUFF_WASM_DIR: '/custom/wasm',
      })
      expect(env.CODEBUFF_RG_PATH).toBe('/custom/rg')
      expect(env.CODEBUFF_WASM_DIR).toBe('/custom/wasm')
      // Other values should still have defaults
      expect(env.HOME).toBe('/home/test')
    })

    test('allows overriding build flags', () => {
      const env = createTestSdkEnv({
        VERBOSE: 'true',
        OVERRIDE_TARGET: 'darwin-arm64',
        OVERRIDE_PLATFORM: 'darwin',
        OVERRIDE_ARCH: 'arm64',
      })
      expect(env.VERBOSE).toBe('true')
      expect(env.OVERRIDE_TARGET).toBe('darwin-arm64')
      expect(env.OVERRIDE_PLATFORM).toBe('darwin')
      expect(env.OVERRIDE_ARCH).toBe('arm64')
    })

    test('allows overriding default values', () => {
      const env = createTestSdkEnv({
        HOME: '/custom/home',
        NODE_ENV: 'production',
      })
      expect(env.HOME).toBe('/custom/home')
      expect(env.NODE_ENV).toBe('production')
    })
  })

  describe('getChatGptOAuthTokenFromEnv', () => {
    const originalEnv = { ...process.env }

    afterEach(() => {
      Object.keys(process.env).forEach((key) => {
        if (!(key in originalEnv)) {
          delete process.env[key]
        }
      })
      Object.assign(process.env, originalEnv)
    })

    test('returns undefined when token env vars are unset', () => {
      delete process.env.CODEBUFF_CHATGPT_OAUTH_TOKEN
      delete process.env.OPENBUFF_CHATGPT_OAUTH_TOKEN
      expect(getChatGptOAuthTokenFromEnv()).toBeUndefined()
    })

    test('returns token from CODEBUFF_CHATGPT_OAUTH_TOKEN', () => {
      process.env.CODEBUFF_CHATGPT_OAUTH_TOKEN = 'chatgpt-oauth-token'
      expect(getChatGptOAuthTokenFromEnv()).toBe('chatgpt-oauth-token')
    })

    test('falls back to OPENBUFF_CHATGPT_OAUTH_TOKEN when CODEBUFF_CHATGPT_OAUTH_TOKEN is unset', () => {
      delete process.env.CODEBUFF_CHATGPT_OAUTH_TOKEN
      process.env.OPENBUFF_CHATGPT_OAUTH_TOKEN = 'openbuff-oauth-token'
      expect(getChatGptOAuthTokenFromEnv()).toBe('openbuff-oauth-token')
    })

    test('CODEBUFF_CHATGPT_OAUTH_TOKEN takes precedence over OPENBUFF_CHATGPT_OAUTH_TOKEN', () => {
      process.env.CODEBUFF_CHATGPT_OAUTH_TOKEN = 'codebuff-token'
      process.env.OPENBUFF_CHATGPT_OAUTH_TOKEN = 'openbuff-token'
      expect(getChatGptOAuthTokenFromEnv()).toBe('codebuff-token')
    })
  })

  describe('getOpenbuffApiKeyFromEnv', () => {
    const originalEnv = { ...process.env }

    afterEach(() => {
      Object.keys(process.env).forEach((key) => {
        if (!(key in originalEnv)) {
          delete process.env[key]
        }
      })
      Object.assign(process.env, originalEnv)
    })

    test('returns undefined when both API key env vars are unset', () => {
      delete process.env.OPENBUFF_API_KEY
      delete process.env.CODEBUFF_API_KEY
      expect(getOpenbuffApiKeyFromEnv()).toBeUndefined()
    })

    test('returns key from OPENBUFF_API_KEY', () => {
      process.env.OPENBUFF_API_KEY = 'openbuff-key'
      delete process.env.CODEBUFF_API_KEY
      expect(getOpenbuffApiKeyFromEnv()).toBe('openbuff-key')
    })

    test('falls back to CODEBUFF_API_KEY when OPENBUFF_API_KEY is unset', () => {
      delete process.env.OPENBUFF_API_KEY
      process.env.CODEBUFF_API_KEY = 'codebuff-key'
      expect(getOpenbuffApiKeyFromEnv()).toBe('codebuff-key')
    })

    test('OPENBUFF_API_KEY takes precedence over CODEBUFF_API_KEY', () => {
      process.env.OPENBUFF_API_KEY = 'openbuff-key'
      process.env.CODEBUFF_API_KEY = 'codebuff-key'
      expect(getOpenbuffApiKeyFromEnv()).toBe('openbuff-key')
    })
  })

  describe('getChildProcessEnv', () => {
    const originalEnv = { ...process.env }

    afterEach(() => {
      Object.keys(process.env).forEach((key) => {
        if (!(key in originalEnv)) {
          delete process.env[key]
        }
      })
      Object.assign(process.env, originalEnv)
    })

    test('omits the agent process own provider credentials', () => {
      process.env.CODEBUFF_BYOK_OPENROUTER = 'byok-secret'
      process.env.CODEBUFF_CHATGPT_OAUTH_TOKEN = 'codebuff-oauth-secret'
      process.env.OPENBUFF_CHATGPT_OAUTH_TOKEN = 'openbuff-oauth-secret'
      process.env.OPENBUFF_API_KEY = 'openbuff-api-secret'
      process.env.CODEBUFF_API_KEY = 'codebuff-api-secret'

      const env = getChildProcessEnv()

      expect(env.CODEBUFF_BYOK_OPENROUTER).toBeUndefined()
      expect(env.CODEBUFF_CHATGPT_OAUTH_TOKEN).toBeUndefined()
      expect(env.OPENBUFF_CHATGPT_OAUTH_TOKEN).toBeUndefined()
      expect(env.OPENBUFF_API_KEY).toBeUndefined()
      expect(env.CODEBUFF_API_KEY).toBeUndefined()
    })

    test('omits generic upstream provider API keys', () => {
      process.env.OPENAI_API_KEY = 'openai-secret'
      process.env.ANTHROPIC_API_KEY = 'anthropic-secret'
      process.env.OPENROUTER_API_KEY = 'openrouter-secret'

      const env = getChildProcessEnv()

      expect(env.OPENAI_API_KEY).toBeUndefined()
      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(env.OPENROUTER_API_KEY).toBeUndefined()
    })

    describe('on win32 (case-insensitive env block)', () => {
      afterEach(() => {
        restoreProcessPlatform()
      })

      test('omits credentials stored under non-canonical case', () => {
        setProcessPlatform('win32')
        process.env.openai_api_key = 'openai-secret'
        process.env.Openai_Api_Key = 'openai-secret-2'
        process.env.SOME_USER_VAR = 'keep'

        const env = getChildProcessEnv()

        expect(env.openai_api_key).toBeUndefined()
        expect(env.Openai_Api_Key).toBeUndefined()
        expect(env.SOME_USER_VAR).toBe('keep')
      })

      test('does not mutate process.env when stripping non-canonical-case credentials', () => {
        setProcessPlatform('win32')
        process.env.openai_api_key = 'openai-secret'

        getChildProcessEnv()

        expect(process.env.openai_api_key).toBe('openai-secret')
      })
    })

    test('omits extended provider credential keys outside the legacy 8-key denylist', () => {
      process.env.GEMINI_API_KEY = 'gemini-secret'
      process.env.OPENCODE_GO_API_KEY = 'opencode-go-secret'

      const env = getChildProcessEnv()

      expect(env.GEMINI_API_KEY).toBeUndefined()
      expect(env.OPENCODE_GO_API_KEY).toBeUndefined()
    })

    test('preserves a non-credential var while stripping generic provider keys', () => {
      process.env.OPENAI_API_KEY = 'openai-secret'
      process.env.ANTHROPIC_API_KEY = 'anthropic-secret'
      process.env.OPENROUTER_API_KEY = 'openrouter-secret'
      process.env.SOME_USER_VAR = 'keep'

      const env = getChildProcessEnv()

      expect(env.OPENAI_API_KEY).toBeUndefined()
      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(env.OPENROUTER_API_KEY).toBeUndefined()
      expect(env.SOME_USER_VAR).toBe('keep')
    })

    test('does not mutate process.env when stripping generic provider keys', () => {
      process.env.OPENAI_API_KEY = 'openai-secret'
      process.env.ANTHROPIC_API_KEY = 'anthropic-secret'
      process.env.OPENROUTER_API_KEY = 'openrouter-secret'

      getChildProcessEnv()

      expect(process.env.OPENAI_API_KEY).toBe('openai-secret')
      expect(process.env.ANTHROPIC_API_KEY).toBe('anthropic-secret')
      expect(process.env.OPENROUTER_API_KEY).toBe('openrouter-secret')
    })

    test('preserves unrelated environment variables', () => {
      process.env.PATH = '/usr/bin:/bin'
      process.env.SOME_USER_VAR = 'keep'

      const env = getChildProcessEnv()

      expect(env.PATH).toBe('/usr/bin:/bin')
      expect(env.SOME_USER_VAR).toBe('keep')
    })

    test('does not mutate process.env', () => {
      process.env.CODEBUFF_API_KEY = 'codebuff-api-secret'
      process.env.SOME_USER_VAR = 'keep'

      getChildProcessEnv()

      expect(process.env.CODEBUFF_API_KEY).toBe('codebuff-api-secret')
      expect(process.env.SOME_USER_VAR).toBe('keep')
    })
  })

  describe('scrubChildProcessEnv', () => {
    const originalEnv = { ...process.env }

    afterEach(() => {
      Object.keys(process.env).forEach((key) => {
        if (!(key in originalEnv)) {
          delete process.env[key]
        }
      })
      Object.assign(process.env, originalEnv)
    })

    test('removes credential keys from a merged environment object', () => {
      const merged = {
        ...getChildProcessEnv(),
        OPENAI_API_KEY: 're-injected-secret',
        GEMINI_API_KEY: 'gemini-secret',
      }

      const scrubbed = scrubChildProcessEnv(merged)

      expect(scrubbed.OPENAI_API_KEY).toBeUndefined()
      expect(scrubbed.GEMINI_API_KEY).toBeUndefined()
    })

    test('preserves non-credential vars from the merged object', () => {
      const merged = {
        PATH: '/usr/bin:/bin',
        SOME_USER_VAR: 'keep',
        OPENAI_API_KEY: 're-injected-secret',
      }

      const scrubbed = scrubChildProcessEnv(merged)

      expect(scrubbed.PATH).toBe('/usr/bin:/bin')
      expect(scrubbed.SOME_USER_VAR).toBe('keep')
      expect(scrubbed.OPENAI_API_KEY).toBeUndefined()
    })

    test('does not mutate the input environment object', () => {
      const merged = { OPENAI_API_KEY: 'secret', SOME_USER_VAR: 'keep' }

      scrubChildProcessEnv(merged)

      expect(merged.OPENAI_API_KEY).toBe('secret')
      expect(merged.SOME_USER_VAR).toBe('keep')
    })

    describe('on win32 (case-insensitive env block)', () => {
      afterEach(() => {
        restoreProcessPlatform()
      })

      test('removes credentials stored under non-canonical case', () => {
        setProcessPlatform('win32')
        const merged = {
          openai_api_key: 'openai-secret',
          Openai_Api_Key: 'openai-secret-2',
          SOME_USER_VAR: 'keep',
        }

        const scrubbed = scrubChildProcessEnv(merged)

        expect(scrubbed.openai_api_key).toBeUndefined()
        expect(scrubbed.Openai_Api_Key).toBeUndefined()
        expect(scrubbed.SOME_USER_VAR).toBe('keep')
      })

      test('still removes exact-name credential keys', () => {
        setProcessPlatform('win32')
        const merged = { OPENAI_API_KEY: 'secret', SOME_USER_VAR: 'keep' }

        const scrubbed = scrubChildProcessEnv(merged)

        expect(scrubbed.OPENAI_API_KEY).toBeUndefined()
        expect(scrubbed.SOME_USER_VAR).toBe('keep')
      })

      test('does not mutate the input environment object', () => {
        setProcessPlatform('win32')
        const merged = { openai_api_key: 'secret', SOME_USER_VAR: 'keep' }

        scrubChildProcessEnv(merged)

        expect(merged.openai_api_key).toBe('secret')
        expect(merged.SOME_USER_VAR).toBe('keep')
      })

      test('keeps POSIX exact-name-only behavior when platform is linux', () => {
        setProcessPlatform('linux')
        const merged = {
          OPENAI_API_KEY: 'secret',
          openai_api_key: 'lowercase-secret',
          SOME_USER_VAR: 'keep',
        }

        const scrubbed = scrubChildProcessEnv(merged)

        expect(scrubbed.OPENAI_API_KEY).toBeUndefined()
        expect(scrubbed.openai_api_key).toBe('lowercase-secret')
        expect(scrubbed.SOME_USER_VAR).toBe('keep')
      })
    })
  })

  describe('matchesCredentialEnvKeyIgnoreCase', () => {
    test('matches denylist names regardless of case', () => {
      expect(matchesCredentialEnvKeyIgnoreCase('OPENAI_API_KEY')).toBe(true)
      expect(matchesCredentialEnvKeyIgnoreCase('openai_api_key')).toBe(true)
      expect(matchesCredentialEnvKeyIgnoreCase('Openai_Api_Key')).toBe(true)
    })

    test('does not match non-credential names', () => {
      expect(matchesCredentialEnvKeyIgnoreCase('SOME_USER_VAR')).toBe(false)
      expect(matchesCredentialEnvKeyIgnoreCase('MY_CUSTOM_VAR')).toBe(false)
    })
  })
})
