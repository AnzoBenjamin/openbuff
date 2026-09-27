import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'

import {
  diagnoseFailClosedEnvRefs,
  getMCPClientCacheKey,
  markAllMCPConfigOrigins,
  markMCPConfigOrigin,
  MissingMcpEnvVarError,
  originOf,
  propagateMCPConfigOrigins,
  resolveMCPConfigOrigin,
  resolveMCPConfigValues,
} from '../client'

describe('getMCPClientCacheKey', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
  })

  test('includes remote headers in client identity without exposing raw secrets', () => {
    process.env.MCP_TOKEN_A = 'token-a'
    process.env.MCP_TOKEN_B = 'token-b'

    const baseConfig = {
      type: 'http' as const,
      url: 'https://mcp.example.com/rpc',
      params: { workspace: 'demo' },
      headers: { Authorization: 'Bearer $MCP_TOKEN_A' },
    }

    const firstKey = getMCPClientCacheKey(baseConfig)
    const secondKey = getMCPClientCacheKey({
      ...baseConfig,
      headers: { Authorization: 'Bearer $MCP_TOKEN_B' },
    })

    expect(firstKey).not.toBe(secondKey)
    expect(firstKey).toContain('mcp.example.com')
    expect(firstKey).not.toContain('token-a')
    expect(firstKey).not.toContain('Bearer $MCP_TOKEN_A')
    expect(secondKey).not.toContain('token-b')
  })

  test('includes stdio env identity without exposing resolved env values', () => {
    process.env.MCP_STDIO_TOKEN = 'stdio-secret'

    const key = getMCPClientCacheKey({
      type: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { API_KEY: '$MCP_STDIO_TOKEN' },
    })

    expect(key).toContain('node')
    expect(key).not.toContain('stdio-secret')
    expect(key).not.toContain('$MCP_STDIO_TOKEN')
  })

  test('includes SSE headers in client identity', () => {
    const firstKey = getMCPClientCacheKey({
      type: 'sse',
      url: 'https://mcp.example.com/sse',
      params: {},
      headers: { 'X-Api-Key': 'first' },
    })
    const secondKey = getMCPClientCacheKey({
      type: 'sse',
      url: 'https://mcp.example.com/sse',
      params: {},
      headers: { 'X-Api-Key': 'second' },
    })

    expect(firstKey).not.toBe(secondKey)
    expect(firstKey).not.toContain('first')
    expect(secondKey).not.toContain('second')
  })

  test('normalizes duplicate header casing before hashing cache identity', () => {
    const duplicateCaseKey = getMCPClientCacheKey({
      type: 'http',
      url: 'https://mcp.example.com/rpc',
      params: {},
      headers: {
        Authorization: 'first-secret',
        authorization: 'last-secret',
      },
    })
    const normalizedKey = getMCPClientCacheKey({
      type: 'http',
      url: 'https://mcp.example.com/rpc',
      params: {},
      headers: { authorization: 'last-secret' },
    })

    expect(duplicateCaseKey).toBe(normalizedKey)
    expect(duplicateCaseKey).not.toContain('first-secret')
    expect(duplicateCaseKey).not.toContain('last-secret')
  })

  test('does not collapse stdio env keys that differ only in case', () => {
    // Env var names are case-sensitive (genuinely distinct variables on
    // Linux). Two stdio servers whose env differs only in key case must not
    // share a cache identity, or getMCPClient would return the client spawned
    // with the first config's environment and the second config's env would
    // silently never be applied.
    const upperKey = getMCPClientCacheKey({
      type: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { API_KEY: 'shared-value' },
    })
    const lowerKey = getMCPClientCacheKey({
      type: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { api_key: 'shared-value' },
    })

    expect(upperKey).not.toBe(lowerKey)
  })
})

describe('MCP config origin', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
  })

  const httpConfig = {
    type: 'http' as const,
    url: 'https://mcp.example.com/rpc',
    params: {},
    headers: { Authorization: 'Bearer $MCP_TOKEN_A' },
  }
  const stdioConfig = {
    type: 'stdio' as const,
    command: 'node',
    args: ['server.js'],
    env: { API_KEY: '$MCP_STDIO_TOKEN' },
  }

  test('trusted origins substitute $VAR references', () => {
    process.env.MCP_TOKEN_A = 'token-a'
    process.env.MCP_STDIO_TOKEN = 'stdio-secret'

    for (const origin of ['project', 'user'] as const) {
      const http = resolveMCPConfigValues(httpConfig, origin)
      expect(http.type).toBe('http')
      if (http.type !== 'stdio') {
        expect(http.headers.Authorization).toBe('Bearer token-a')
      }
      const stdio = resolveMCPConfigValues(stdioConfig, origin)
      if (stdio.type === 'stdio') {
        expect(stdio.env.API_KEY).toBe('stdio-secret')
      }
    }
  })

  test('client origin never substitutes $VAR references', () => {
    process.env.MCP_TOKEN_A = 'token-a'
    process.env.MCP_STDIO_TOKEN = 'stdio-secret'

    const http = resolveMCPConfigValues(httpConfig, 'client')
    if (http.type !== 'stdio') {
      expect(http.headers.Authorization).toBe('Bearer $MCP_TOKEN_A')
    }
    const stdio = resolveMCPConfigValues(stdioConfig, 'client')
    if (stdio.type === 'stdio') {
      expect(stdio.env.API_KEY).toBe('$MCP_STDIO_TOKEN')
    }
    expect(JSON.stringify(http)).not.toContain('token-a')
    expect(JSON.stringify(stdio)).not.toContain('stdio-secret')
  })

  test('origin is part of the cache identity for explicitly marked configs', () => {
    process.env.MCP_TOKEN_A = 'token-a'
    // Trusted-origin resolution now substitutes at cache-key time and throws on
    // a missing var (single connect-time substitution), so the stdio fixture's
    // referenced var must be defined for the trusted-key computations below.
    process.env.MCP_STDIO_TOKEN = 'stdio-secret'

    // UPDATED for fail-closed origins (NEW-1): unmarked configs now resolve
    // to 'client', so this test marks its configs 'project' first to preserve
    // its original intent (a trusted config's identity differs per origin).
    const markedHttp = { ...httpConfig }
    markMCPConfigOrigin(markedHttp, 'project')
    const markedStdio = { ...stdioConfig }
    markMCPConfigOrigin(markedStdio, 'project')

    const projectKey = getMCPClientCacheKey(markedHttp)
    expect(projectKey).toBe(
      getMCPClientCacheKey(httpConfig, { origin: 'project' }),
    )
    expect(projectKey).not.toBe(
      getMCPClientCacheKey(httpConfig, { origin: 'client' }),
    )
    expect(getMCPClientCacheKey(markedStdio)).not.toBe(
      getMCPClientCacheKey(stdioConfig, { origin: 'client' }),
    )
  })

  test('client-origin cache key hashes literal header values', () => {
    process.env.MCP_TOKEN_A = 'token-a'

    const key = getMCPClientCacheKey(httpConfig, { origin: 'client' })
    expect(key).toContain('mcp.example.com')
    expect(key).not.toContain('token-a')
    expect(key).not.toContain('Bearer $MCP_TOKEN_A')
  })

  test('markMCPConfigOrigin/originOf round-trip and unmarked configs stay unmarked', () => {
    const config = { ...httpConfig }
    expect(originOf(config)).toBeUndefined()

    markMCPConfigOrigin(config, 'project')
    expect(originOf(config)).toBe('project')

    // Later trusted calls overwrite the earlier trusted origin.
    markMCPConfigOrigin(config, 'user')
    expect(originOf(config)).toBe('user')
  })

  test("an existing 'client' mark cannot be upgraded to a trusted origin (NEW-1)", () => {
    const config = { ...httpConfig }
    markMCPConfigOrigin(config, 'client')
    expect(originOf(config)).toBe('client')

    // Trusted-loader blanket marks must not silently re-enable $VAR
    // expansion on untrusted configs: the 'client' mark wins.
    markMCPConfigOrigin(config, 'project')
    expect(originOf(config)).toBe('client')
    markMCPConfigOrigin(config, 'user')
    expect(originOf(config)).toBe('client')

    // Trusted origins may still overwrite each other...
    const promoted = { ...httpConfig }
    markMCPConfigOrigin(promoted, 'project')
    markMCPConfigOrigin(promoted, 'user')
    expect(originOf(promoted)).toBe('user')

    // ...and any origin may fail closed by downgrading to 'client'.
    markMCPConfigOrigin(promoted, 'client')
    expect(originOf(promoted)).toBe('client')
  })

  test('markAllMCPConfigOrigins marks every server and no-ops on undefined/empty', () => {
    const servers = {
      remote: { ...httpConfig },
      local: { ...stdioConfig },
    }

    markAllMCPConfigOrigins(servers, 'client')
    expect(originOf(servers.remote)).toBe('client')
    expect(originOf(servers.local)).toBe('client')

    expect(() => markAllMCPConfigOrigins(undefined, 'project')).not.toThrow()
    expect(() => markAllMCPConfigOrigins({}, 'project')).not.toThrow()
  })

  test("markAllMCPConfigOrigins cannot upgrade existing 'client' marks", () => {
    const servers = {
      remote: { ...httpConfig },
      local: { ...stdioConfig },
    }

    markAllMCPConfigOrigins(servers, 'client')
    markAllMCPConfigOrigins(servers, 'project')

    expect(originOf(servers.remote)).toBe('client')
    expect(originOf(servers.local)).toBe('client')
  })

  test('propagateMCPConfigOrigins re-attaches marks onto fresh re-parsed configs', () => {
    const source = { remote: { ...httpConfig }, local: { ...stdioConfig } }
    markMCPConfigOrigin(source.remote, 'client')
    markMCPConfigOrigin(source.local, 'user')

    // A Zod re-parse produces brand-new config objects with no WeakMap entry.
    const target = { remote: { ...httpConfig }, local: { ...stdioConfig } }
    expect(originOf(target.remote)).toBeUndefined()
    expect(originOf(target.local)).toBeUndefined()

    propagateMCPConfigOrigins(source, target)

    expect(originOf(target.remote)).toBe('client')
    expect(originOf(target.local)).toBe('user')
  })

  test("propagateMCPConfigOrigins downgrades trusted targets to a 'client' source mark", () => {
    const source = { remote: { ...httpConfig } }
    markMCPConfigOrigin(source.remote, 'client')

    const target = { remote: { ...httpConfig } }
    markMCPConfigOrigin(target.remote, 'project')

    propagateMCPConfigOrigins(source, target)

    // Fail closed: the untrusted source mark wins over the trusted one.
    expect(originOf(target.remote)).toBe('client')
  })

  test('propagateMCPConfigOrigins never overwrites a trusted target mark with another trusted mark', () => {
    const source = { remote: { ...httpConfig } }
    markMCPConfigOrigin(source.remote, 'user')

    const target = { remote: { ...httpConfig } }
    markMCPConfigOrigin(target.remote, 'project')

    propagateMCPConfigOrigins(source, target)

    expect(originOf(target.remote)).toBe('project')
  })

  test('unmarked configs fail closed to the client origin (no $VAR expansion)', () => {
    process.env.SOMEVAR = 'some-secret-value'

    const unmarkedConfig = {
      type: 'http' as const,
      url: 'https://mcp.example.com/rpc',
      params: {},
      headers: { Authorization: 'Bearer $SOMEVAR' },
    }
    expect(originOf(unmarkedConfig)).toBeUndefined()

    const unmarkedKey = getMCPClientCacheKey(unmarkedConfig)
    expect(unmarkedKey).not.toContain('some-secret-value')
    // Unmarked resolves exactly like an explicit 'client' origin...
    expect(unmarkedKey).toBe(
      getMCPClientCacheKey(unmarkedConfig, { origin: 'client' }),
    )
    // ...and unlike the trusted 'project' origin, which would expand $SOMEVAR.
    expect(unmarkedKey).not.toBe(
      getMCPClientCacheKey(unmarkedConfig, { origin: 'project' }),
    )
  })

  test("marked 'project' configs still expand $VAR references", () => {
    process.env.SOMEVAR = 'some-secret-value'

    const markedConfig = {
      type: 'http' as const,
      url: 'https://mcp.example.com/rpc',
      params: {},
      headers: { Authorization: 'Bearer $SOMEVAR' },
    }
    markMCPConfigOrigin(markedConfig, 'project')

    const markedKey = getMCPClientCacheKey(markedConfig)
    // Values are hashed in the key, so the secret never appears in plaintext.
    expect(markedKey).not.toContain('some-secret-value')
    expect(markedKey).toBe(
      getMCPClientCacheKey(markedConfig, { origin: 'project' }),
    )
    expect(markedKey).not.toBe(
      getMCPClientCacheKey(markedConfig, { origin: 'client' }),
    )
  })
})

describe('fail-closed diagnosability for unmarked configs with $VAR refs', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
  })

  // Restore spies (e.g. spyOn(console, 'warn')) between tests so call counts
  // don't accumulate across tests in this block.
  afterEach(() => {
    mock.restore()
  })

  function makeUnmarkedVarConfig(url: string) {
    return {
      type: 'http' as const,
      url,
      params: {},
      headers: { Authorization: 'Bearer $SOMEVAR' },
    }
  }

  test('resolveMCPConfigOrigin warns once for an unmarked $VAR config', () => {
    process.env.SOMEVAR = 'some-secret-value'
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

    const unmarkedConfig = makeUnmarkedVarConfig('https://diag.example.com/rpc')
    expect(originOf(unmarkedConfig)).toBeUndefined()

    expect(resolveMCPConfigOrigin(unmarkedConfig)).toBe('client')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const message = String(warnSpy.mock.calls[0][0])
    expect(message).toContain('Authorization')
    expect(message).toContain('client')
    expect(message).toContain('markMCPConfigOrigin')

    // Content-keyed dedup: an equivalent fresh copy (e.g. re-parsed or
    // re-passed through client.run) does not warn again.
    resolveMCPConfigOrigin({ ...unmarkedConfig })
    resolveMCPConfigOrigin(unmarkedConfig)
    expect(warnSpy).toHaveBeenCalledTimes(1)

    // A different unmarked config (different content) still warns.
    resolveMCPConfigOrigin(makeUnmarkedVarConfig('https://other.example.com/rpc'))
    expect(warnSpy).toHaveBeenCalledTimes(2)
  })

  test('getMCPClientCacheKey emits the diagnosability warning on the production path', () => {
    process.env.SOMEVAR = 'some-secret-value'
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

    // The exact scenario from the finding: an SDK caller passes mcpServers
    // straight to client.run without the marked on-disk loaders, so the
    // config reaches getMCPClient unmarked.
    const unmarkedConfig = makeUnmarkedVarConfig('https://sdk.example.com/rpc')

    getMCPClientCacheKey(unmarkedConfig)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const message = String(warnSpy.mock.calls[0][0])
    expect(message).toContain('Authorization')

    // Same path again: deduped, and the fail-closed resolution is unchanged.
    const keyBefore = getMCPClientCacheKey(unmarkedConfig)
    expect(getMCPClientCacheKey(unmarkedConfig)).toBe(keyBefore)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  test('explicitly marked configs never trigger the diagnosability warning', () => {
    process.env.SOMEVAR = 'some-secret-value'
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

    const projectConfig = makeUnmarkedVarConfig('https://marked.example.com/rpc')
    markMCPConfigOrigin(projectConfig, 'project')
    expect(resolveMCPConfigOrigin(projectConfig)).toBe('project')

    const clientConfig = makeUnmarkedVarConfig('https://peer.example.com/rpc')
    markMCPConfigOrigin(clientConfig, 'client')
    expect(resolveMCPConfigOrigin(clientConfig)).toBe('client')

    // Explicitly trusted origin via options also stays silent.
    const unmarked = makeUnmarkedVarConfig('https://opts.example.com/rpc')
    expect(resolveMCPConfigOrigin(unmarked, { origin: 'project' })).toBe('project')

    expect(warnSpy).not.toHaveBeenCalled()
  })

  test('configs without $VAR references never trigger the warning', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

    expect(
      resolveMCPConfigOrigin({
        type: 'http' as const,
        url: 'https://plain.example.com/rpc',
        params: {},
        headers: { Authorization: 'Bearer plain-literal-token' },
      }),
    ).toBe('client')

    expect(
      resolveMCPConfigOrigin({
        type: 'stdio' as const,
        command: 'node',
        args: ['server.js'],
        env: { PLAIN: 'literal value' },
      }),
    ).toBe('client')

    expect(warnSpy).not.toHaveBeenCalled()
  })

  test('stdio env references are diagnosed like http headers', () => {
    process.env.SOMEVAR = 'some-secret-value'
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

    expect(
      resolveMCPConfigOrigin({
        type: 'stdio' as const,
        command: 'node',
        args: ['server.js'],
        env: { API_KEY: '$SOMEVAR' },
      }),
    ).toBe('client')

    expect(warnSpy).toHaveBeenCalledTimes(1)
    const message = String(warnSpy.mock.calls[0][0])
    expect(message).toContain('API_KEY')
  })

  test('diagnoseFailClosedEnvRefs is exported and silent for marked/non-$VAR configs', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

    const marked = makeUnmarkedVarConfig('https://direct.example.com/rpc')
    markMCPConfigOrigin(marked, 'project')
    diagnoseFailClosedEnvRefs(marked, 'project')
    diagnoseFailClosedEnvRefs(marked, 'client')

    diagnoseFailClosedEnvRefs(
      makeUnmarkedVarConfig('https://direct2.example.com/rpc'),
      'client',
    )
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })
})

describe('single connect-time env substitution', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
  })

  // Restore any spyOn(...) installed by tests in this block.
  afterEach(() => {
    mock.restore()
  })

  test('resolves a trusted var whose value contains $ID exactly once (no re-expansion)', () => {
    process.env.MCP_RESOLVED = 'abc$IDxyz'
    // If the substituted output were re-scanned, $ID would be expanded to
    // this value; the single-pass guarantee must emit '$ID' verbatim instead.
    process.env.ID = 'SHOULD_NOT_APPEAR'

    const stdio = resolveMCPConfigValues(
      {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: { API_KEY: '$MCP_RESOLVED' },
      },
      'project',
    )
    if (stdio.type === 'stdio') {
      expect(stdio.env.API_KEY).toBe('abc$IDxyz')
      expect(stdio.env.API_KEY).not.toContain('SHOULD_NOT_APPEAR')
    }
  })

  test('trusted origins throw MissingMcpEnvVarError uniformly for whole-value, inline, and header refs', () => {
    for (const origin of ['user', 'project'] as const) {
      // (a) whole-value stdio env
      expect(() =>
        resolveMCPConfigValues(
          {
            type: 'stdio',
            command: 'node',
            args: ['server.js'],
            env: { API_KEY: '$MISSING_MCP_VAR_A' },
          },
          origin,
        ),
      ).toThrow(MissingMcpEnvVarError)

      // (b) inline stdio env (interpolation)
      expect(() =>
        resolveMCPConfigValues(
          {
            type: 'stdio',
            command: 'node',
            args: ['server.js'],
            env: { TOKEN: 'Bearer $MISSING_MCP_VAR_B' },
          },
          origin,
        ),
      ).toThrow(MissingMcpEnvVarError)

      // (c) http/sse headers
      expect(() =>
        resolveMCPConfigValues(
          {
            type: 'http',
            url: 'https://mcp.example.com/rpc',
            params: {},
            headers: { Authorization: 'Bearer $MISSING_MCP_VAR_C' },
          },
          origin,
        ),
      ).toThrow(MissingMcpEnvVarError)
    }
  })

  test('MissingMcpEnvVarError carries the missing variable name(s) and a stable name', () => {
    let caught: unknown
    try {
      resolveMCPConfigValues(
        {
          type: 'stdio',
          command: 'node',
          args: ['server.js'],
          env: { API_KEY: '$MISSING_MCP_VAR_NAME' },
        },
        'project',
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(MissingMcpEnvVarError)
    expect((caught as MissingMcpEnvVarError).name).toBe('MissingMcpEnvVarError')
    expect((caught as MissingMcpEnvVarError).missingVars).toContain(
      'MISSING_MCP_VAR_NAME',
    )
  })

  test('happy path is byte-identical for a config without missing vars', () => {
    process.env.MCP_TOKEN_A = 'token-a'
    process.env.MCP_STDIO_TOKEN = 'stdio-secret'

    // No throw, and cache-key computation is unaffected by the collect logic.
    expect(() =>
      getMCPClientCacheKey(
        {
          type: 'stdio',
          command: 'node',
          args: ['server.js'],
          env: { API_KEY: '$MCP_STDIO_TOKEN' },
        },
        { origin: 'project' },
      ),
    ).not.toThrow()
  })

  test('client origin returns literals for a missing var and never throws (NEW-1)', () => {
    const stdioWhole = resolveMCPConfigValues(
      {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: { API_KEY: '$MISSING_CLIENT_VAR' },
      },
      'client',
    )
    if (stdioWhole.type === 'stdio') {
      expect(stdioWhole.env.API_KEY).toBe('$MISSING_CLIENT_VAR')
    }

    const stdioInline = resolveMCPConfigValues(
      {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: { TOKEN: 'Bearer $MISSING_CLIENT_VAR' },
      },
      'client',
    )
    if (stdioInline.type === 'stdio') {
      expect(stdioInline.env.TOKEN).toBe('Bearer $MISSING_CLIENT_VAR')
    }

    const http = resolveMCPConfigValues(
      {
        type: 'http',
        url: 'https://mcp.example.com/rpc',
        params: {},
        headers: { Authorization: 'Bearer $MISSING_CLIENT_VAR' },
      },
      'client',
    )
    if (http.type !== 'stdio') {
      expect(http.headers.Authorization).toBe('Bearer $MISSING_CLIENT_VAR')
    }
  })
})

describe('batch cache-key/enumeration impact of the trusted missing-var throw (RF-1-7a1e4076)', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
  })

  function stdioVarConfig(varName: string) {
    return {
      type: 'stdio' as const,
      command: 'node',
      args: ['server.js'],
      env: { API_KEY: `$${varName}` },
    }
  }

  test('a trusted config with a missing var throws only for that config; sibling cache keys still compute', () => {
    process.env.PRESENT_BATCH_VAR = 'present-value'

    const present = stdioVarConfig('PRESENT_BATCH_VAR')
    const missing = stdioVarConfig('MISSING_BATCH_VAR')
    markMCPConfigOrigin(present, 'project')
    markMCPConfigOrigin(missing, 'project')

    // Emulate a batch cache-key pass that isolates per config, mirroring
    // getMCPToolData's Promise.allSettled: one server's missing var must not
    // strip identities from its healthy siblings.
    const outcomes = [present, missing].map((config) => {
      try {
        return { ok: true as const, key: getMCPClientCacheKey(config) }
      } catch (error) {
        return { ok: false as const, error }
      }
    })

    expect(outcomes[0].ok).toBe(true)
    if (outcomes[0].ok) {
      expect(outcomes[0].key).toContain('node')
      // The resolved secret is hashed into the identity, never emitted raw.
      expect(outcomes[0].key).not.toContain('present-value')
    }

    expect(outcomes[1].ok).toBe(false)
    if (!outcomes[1].ok) {
      expect(outcomes[1].error).toBeInstanceOf(MissingMcpEnvVarError)
      expect(
        (outcomes[1].error as MissingMcpEnvVarError).missingVars,
      ).toContain('MISSING_BATCH_VAR')
    }
  })

  test('client-origin batch enumeration never throws even when every referenced var is missing', () => {
    const configs = [
      stdioVarConfig('MISSING_CLIENT_BATCH_A'),
      stdioVarConfig('MISSING_CLIENT_BATCH_B'),
    ]

    // Untrusted peer configs are used literally, so a whole-map cache-key
    // enumeration over 'client'-origin configs is total (no substitution, no
    // throw) and safe to run unguarded.
    let keys: string[] = []
    expect(() => {
      keys = configs.map((config) =>
        getMCPClientCacheKey(config, { origin: 'client' }),
      )
    }).not.toThrow()
    expect(keys).toHaveLength(2)
    // Distinct literal references produce distinct identities.
    expect(keys[0]).not.toBe(keys[1])
  })

  test('resolveMCPConfigValues throw is per config, so a trusted sibling still resolves in the same pass', () => {
    process.env.PRESENT_RESOLVE_VAR = 'resolved-value'

    const resolved = resolveMCPConfigValues(
      stdioVarConfig('PRESENT_RESOLVE_VAR'),
      'project',
    )
    if (resolved.type === 'stdio') {
      expect(resolved.env.API_KEY).toBe('resolved-value')
    }

    expect(() =>
      resolveMCPConfigValues(stdioVarConfig('MISSING_RESOLVE_VAR'), 'project'),
    ).toThrow(MissingMcpEnvVarError)
  })
})
