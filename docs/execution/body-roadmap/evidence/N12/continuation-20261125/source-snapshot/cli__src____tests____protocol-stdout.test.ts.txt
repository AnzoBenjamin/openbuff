import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

import { describe, expect, test } from 'bun:test'

import {
  isNonRendererCommandArgv,
  isRendererCommand,
  parseCliArgs,
} from '../cli-args'
import { routeProtocolDiagnostics } from '../pre-init/protocol-stdio'

const cliRoot = path.resolve(import.meta.dir, '../..')

function fixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'openbuff-protocol-stdout-'),
  )
  const project = path.join(root, 'project')
  const configDir = path.join(root, 'config')
  fs.mkdirSync(project)
  fs.mkdirSync(configDir)
  const configPath = path.join(configDir, 'openbuff.json')
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      indexing: { enabled: false },
      defaultModel: 'fixture/model',
      providers: {
        fixture: {
          type: 'openai-compatible',
          baseURL: 'http://127.0.0.1:1/v1',
          models: ['model'],
        },
      },
    }),
  )
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    SHELL: process.env.SHELL,
    TERM: 'xterm-256color',
    NODE_ENV: 'test',
    OPENBUFF_PROVIDER_CONFIG: configPath,
    OPENBUFF_CONFIG_DIR: configDir,
    OPENBUFF_PROCESS_SUPERVISION: '0',
    OPENBUFF_TELEMETRY: '0',
    DO_NOT_TRACK: '1',
    NEXT_PUBLIC_CODEBUFF_APP_URL: 'http://localhost:3000',
  }
  return { root, project, env }
}

function frames(stdout: string) {
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

describe('early protocol diagnostic routing', () => {
  for (const args of [
    [],
    ['a prompt'],
    ['--cwd', '/fixture', 'run'],
    ['run', 'fixture'],
    ['serve'],
    ['mcp'],
    ['replay', 'fixture'],
    ['dash'],
    ['--approval-mode', 'balanced', 'run', 'fixture'],
    ['--approval-mode=strict', 'serve'],
  ]) {
    test(`agrees with the canonical parser for ${args.join(' ') || 'TUI'}`, () => {
      const argv = ['bun', 'openbuff', ...args]
      const parsed = parseCliArgs(argv, { version: 'test', exitOverride: true })
      expect(isNonRendererCommandArgv(argv)).toBe(!isRendererCommand(parsed))
    })
  }

  test('routes console diagnostics to stderr and restores only its own methods', () => {
    const stdout: unknown[][] = []
    const stderr: unknown[][] = []
    const output = {
      log: (...data: unknown[]) => {
        stdout.push(data)
      },
      info: (...data: unknown[]) => {
        stdout.push(data)
      },
      debug: (...data: unknown[]) => {
        stdout.push(data)
      },
      error: (...data: unknown[]) => {
        stderr.push(data)
      },
    }
    const originalInfo = output.info
    const restore = routeProtocolDiagnostics(
      ['bun', 'openbuff', 'run', 'fixture'],
      output,
    )
    output.log('log')
    output.info('info')
    output.debug('debug')
    expect(stdout).toEqual([])
    expect(stderr).toEqual([['log'], ['info'], ['debug']])
    const replacement = () => {}
    output.log = replacement
    restore()
    expect(output.log).toBe(replacement)
    expect(output.info).toBe(originalInfo)
    output.info('restored')
    expect(stdout).toEqual([['restored']])
  })

  test('does not redirect a renderer launch', () => {
    const output = {
      log: () => {},
      info: () => {},
      debug: () => {},
      error: () => {},
    }
    const log = output.log
    routeProtocolDiagnostics(['bun', 'openbuff', 'a prompt'], output)()
    expect(output.log).toBe(log)
  })
})

describe('real CLI protocol stdout', () => {
  for (const entry of ['index.tsx', 'binary-entry.ts']) {
    test(`${entry}: JSON errors have no startup diagnostic prefix`, () => {
      const f = fixture()
      try {
        const result = spawnSync(
          process.execPath,
          [
            '--no-env-file',
            path.join(cliRoot, 'src', entry),
            'run',
            '--json',
            '--agent',
            'missing-protocol-fixture',
            '--timeout',
            '2',
            'fixture',
          ],
          { cwd: f.project, env: f.env, encoding: 'utf8', timeout: 15_000 },
        )
        expect(result.error).toBeUndefined()
        expect(result.status).toBe(1)
        const events = frames(result.stdout)
        expect(events.length).toBeGreaterThan(0)
        expect(events.some((event) => event.type === 'error')).toBe(true)
        // A ready keyless route reaches the intended missing-agent SDK failure;
        // a readiness refusal would correctly create no journal and mask it.
        expect(
          events.some(
            (event) =>
              event.type === 'error' &&
              event.message.includes('missing-protocol-fixture'),
          ),
        ).toBe(true)
        expect(result.stdout).not.toContain('Using environment:')
        expect(result.stdout).not.toContain('Loaded provider config from:')
        expect(result.stderr).not.toContain('run journal unavailable')
        expect(
          fs.existsSync(
            path.join(f.root, 'config', 'state', 'harness', 'run-journal.db'),
          ),
        ).toBe(true)
      } finally {
        fs.rmSync(f.root, { recursive: true, force: true })
      }
    }, 20_000)
  }

  for (const [name, input] of [
    ['empty', Buffer.alloc(0)],
    ['invalid UTF-8', Buffer.from([0xc3, 0x28])],
    ['oversized', Buffer.alloc(1_000_001, 65)],
  ] as const) {
    test(`stdin ${name} returns a clean JSON error before creating a run journal`, () => {
      const f = fixture()
      try {
        const result = spawnSync(
          process.execPath,
          [
            '--no-env-file',
            path.join(cliRoot, 'src', 'binary-entry.ts'),
            'run',
            '--json',
            '--timeout',
            '2',
          ],
          {
            cwd: f.project,
            env: f.env,
            input,
            encoding: 'utf8',
            timeout: 15_000,
          },
        )
        expect(result.error).toBeUndefined()
        expect(result.status).toBe(1)
        const events = frames(result.stdout)
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({
          type: 'error',
          runOutcome: { termination: 'failed' },
        })
        expect(events[0].message).toMatch(/stdin|prompt|UTF-8|byte/)
        expect(
          fs.existsSync(
            path.join(f.root, 'config', 'state', 'harness', 'run-journal.db'),
          ),
        ).toBe(false)
      } finally {
        fs.rmSync(f.root, { recursive: true, force: true })
      }
    }, 20_000)
  }

  test('stdio ACP initialization emits only JSON-RPC frames', async () => {
    const f = fixture()
    const child = spawn(
      process.execPath,
      ['--no-env-file', path.join(cliRoot, 'src', 'index.tsx'), 'serve'],
      { cwd: f.project, env: f.env, stdio: 'pipe' },
    )
    const closed = new Promise<void>((resolve) =>
      child.once('close', () => resolve()),
    )
    let stdout = ''
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      let pending = ''
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
        pending += chunk.toString()
        let boundary: number
        while ((boundary = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, boundary)
          pending = pending.slice(boundary + 1)
          if (!line.trim()) continue
          try {
            const frame = JSON.parse(line)
            if (frame.id === 1) resolve(frame)
          } catch (error) {
            reject(error)
          }
        }
      })
      child.on('error', reject)
      child.on('exit', () =>
        reject(new Error('ACP exited before initialization')),
      )
    })
    child.stderr.resume()
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: {} },
      }) + '\n',
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        response,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('ACP initialization timeout')),
            10_000,
          )
        }),
      ])
      expect(result.jsonrpc).toBe('2.0')
      expect(result.error).toBeUndefined()
      expect(result.result).toMatchObject({ protocolVersion: 1 })
      expect(frames(stdout).every((frame) => frame.jsonrpc === '2.0')).toBe(
        true,
      )
      expect(stdout).not.toContain('Using environment:')
      expect(stdout).not.toContain('Loaded provider config from:')
    } finally {
      if (timer) clearTimeout(timer)
      child.stdin.end()
      child.kill('SIGTERM')
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000)
      await closed
      clearTimeout(killTimer)
      fs.rmSync(f.root, { recursive: true, force: true })
    }
  }, 15_000)
})
