import { OpenbuffClient, type AgentDefinition } from '@openbuff/sdk'
import { beforeAll, describe, expect, it } from 'bun:test'

import { setupE2eMocks } from '../../sdk/e2e/utils/e2e-mocks'

import fileListerDefinition from '../file-explorer/file-lister'
import filePickerDefinition from '../file-explorer/file-picker'

import type { PrintModeEvent } from '@codebuff/common/types/print-mode'

function normalizeFileEntries(entries: unknown[]): string[] {
  return entries
    .map((f) => (typeof f === 'string' ? f : (f as { path?: unknown })?.path))
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function extractFiles(obj: unknown): unknown[] | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  const o = obj as Record<string, unknown>
  if (Array.isArray(o.files)) return o.files as unknown[]
  const candidates: unknown[] = [o.output, o.value]
  for (const c of candidates) {
    if (
      c &&
      typeof c === 'object' &&
      Array.isArray((c as Record<string, unknown>).files)
    ) {
      return (c as Record<string, unknown>).files as unknown[]
    }
  }
  if (
    o.type === 'structuredOutput' &&
    o.value &&
    typeof o.value === 'object' &&
    Array.isArray((o.value as Record<string, unknown>).files)
  ) {
    return (o.value as Record<string, unknown>).files as unknown[]
  }
  const inner = o.value as Record<string, unknown> | undefined
  if (
    inner?.type === 'structuredOutput' &&
    inner.value &&
    typeof inner.value === 'object' &&
    Array.isArray((inner.value as Record<string, unknown>).files)
  ) {
    return (inner.value as Record<string, unknown>).files as unknown[]
  }
  return undefined
}

function parseListedPaths(outputStr: string): string[] {
  try {
    const parsed = JSON.parse(outputStr)
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) {
      return normalizeFileEntries(parsed)
    }
    const tryExtract = (obj: unknown): string[] | null => {
      const files =
        extractFiles(obj) ??
        (obj &&
        typeof obj === 'object' &&
        'value' in (obj as Record<string, unknown>)
          ? extractFiles((obj as Record<string, unknown>).value)
          : undefined)
      if (Array.isArray(files)) return normalizeFileEntries(files)
      return null
    }
    if (Array.isArray(parsed)) {
      for (const el of parsed) {
        const res = tryExtract(el)
        if (res) return res
      }
    }
    const direct = tryExtract(parsed)
    if (direct) return direct
  } catch {
    // fall through to line-based fallback
  }
  // Fallback: split only on newlines to avoid mis-splitting paths that contain commas.
  return outputStr
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Integration tests for agents that use the read_subtree tool.
 * These tests verify that the SDK properly initializes the session state
 * with project files and that agents can access the file tree through
 * the read_subtree tool.
 *
 * The file-lister agent is used directly instead of file-picker because:
 * - file-lister directly uses the read_subtree tool
 * - file-picker spawns file-lister as a subagent, adding complexity
 * - Testing file-lister directly verifies the core functionality
 */
describe('File Lister Agent Integration - read_subtree tool', () => {
  beforeAll(() => {
    setupE2eMocks()
  })
  it(
    'should find relevant files using read_subtree tool',
    async () => {
      // Create mock project files that the file-lister should be able to find
      const projectFiles: Record<string, string> = {
        'src/index.ts': `
import { UserService } from './services/user-service'
import { AuthService } from './services/auth-service'

export function main() {
  const userService = new UserService()
  const authService = new AuthService()
  console.log('Application started')
}
`,
        'src/services/user-service.ts': `
export class UserService {
  async getUser(id: string) {
    return { id, name: 'John Doe' }
  }

  async createUser(name: string) {
    return { id: 'new-user-id', name }
  }

  async deleteUser(id: string) {
    console.log('User deleted:', id)
  }
}
`,
        'src/services/auth-service.ts': `
export class AuthService {
  async login(email: string, password: string) {
    return { token: 'mock-token' }
  }

  async logout() {
    console.log('Logged out')
  }

  async validateToken(token: string) {
    return token === 'mock-token'
  }
}
`,
        'src/utils/logger.ts': `
export function log(message: string) {
  console.log('[LOG]', message)
}

export function error(message: string) {
  console.error('[ERROR]', message)
}
`,
        'src/types/user.ts': `
export interface User {
  id: string
  name: string
  email?: string
}
`,
        'package.json': JSON.stringify({
          name: 'test-project',
          version: '1.0.0',
          dependencies: {},
        }),
        'README.md':
          '# Test Project\n\nA simple test project for integration testing.',
      }

      const client = new OpenbuffClient({
        cwd: '/tmp/test-project',
        projectFiles,
        agentDefinitions: [{ ...fileListerDefinition, model: 'anthropic/claude-haiku-4.5' } as unknown as AgentDefinition],
      })

      const events: PrintModeEvent[] = []

      // Run the file-lister agent to find files related to user service
      // The file-lister agent uses the read_subtree tool directly
      const run = await client.run({
        agent: 'file-lister',
        prompt: 'Find files related to user authentication and user management',
        handleEvent: (event) => {
          events.push(event)
        },
      })

      // The output should not be an error
      expect(run.output.type).not.toEqual('error')

      // Verify we got some output
      expect(run.output).toBeDefined()

      // The file-lister should have found relevant files — assert structured output, not single-token hallucination
      const outputStr =
        typeof run.output === 'string' ? run.output : JSON.stringify(run.output)

      // Require multiple distinct expected files to appear as full paths (not just substring 'user'/'api')
      const expectedFiles = [
        'src/services/user-service.ts',
        'src/services/auth-service.ts',
        'src/types/user.ts',
      ]
      const matchedFiles = expectedFiles.filter((file) => outputStr.includes(file))
      expect(matchedFiles.length).toBeGreaterThanOrEqual(2)
      // Also assert file-list structured output: try JSON first, then split fallback, and verify at least 2 project files listed
      const listedPaths = parseListedPaths(outputStr).filter(
        (s) => s.endsWith('.ts') || s.endsWith('.json') || s.endsWith('.md'),
      )
      expect(listedPaths.length).toBeGreaterThanOrEqual(2)
    },
    { timeout: 60_000 },
  )

  it(
    'should use the file tree from session state',
    async () => {
      // Create a different set of project files with a specific structure
      const projectFiles: Record<string, string> = {
        'packages/core/src/index.ts': 'export const VERSION = "1.0.0"',
        'packages/core/src/api/server.ts':
          'export function startServer() { console.log("started") }',
        'packages/core/src/api/routes.ts':
          'export const routes = { health: "/health" }',
        'packages/utils/src/helpers.ts':
          'export function formatDate(d: Date) { return d.toISOString() }',
        'docs/api.md': '# API Documentation\n\nAPI docs here.',
        'package.json': JSON.stringify({ name: 'mono-repo', version: '2.0.0' }),
      }

      const client = new OpenbuffClient({
        cwd: '/tmp/test-project',
        projectFiles,
        agentDefinitions: [{ ...fileListerDefinition, model: 'anthropic/claude-haiku-4.5' } as unknown as AgentDefinition],
      })

      const events: PrintModeEvent[] = []

      // Run file-lister to find API-related files
      const run = await client.run({
        agent: 'file-lister',
        prompt: 'Find files related to the API server implementation',
        handleEvent: (event) => {
          events.push(event)
        },
      })

      expect(run.output.type).not.toEqual('error')

      const outputStr =
        typeof run.output === 'string' ? run.output : JSON.stringify(run.output)

      // Require multiple distinct expected files — prevents hallucinated substring matches
      const expectedFiles = [
        'packages/core/src/api/server.ts',
        'packages/core/src/api/routes.ts',
        'packages/core/src/index.ts',
      ]
      const matchedFiles = expectedFiles.filter((file) => outputStr.includes(file))
      expect(matchedFiles.length).toBeGreaterThanOrEqual(2)
      const listedPaths = parseListedPaths(outputStr).filter(
        (s) => s.endsWith('.ts') || s.endsWith('.md'),
      )
      expect(listedPaths.length).toBeGreaterThanOrEqual(2)
    },
    { timeout: 60_000 },
  )

  it(
    'should respect directories parameter',
    async () => {
      // Create project with multiple top-level directories
      const projectFiles: Record<string, string> = {
        'frontend/src/App.tsx':
          'export function App() { return <div>App</div> }',
        'frontend/src/components/Button.tsx':
          'export function Button() { return <button>Click</button> }',
        'backend/src/server.ts':
          'export function start() { console.log("started") }',
        'backend/src/routes/users.ts':
          'export function getUsers() { return [] }',
        'shared/types/common.ts': 'export type ID = string',
        'package.json': JSON.stringify({ name: 'full-stack-app' }),
      }

      const client = new OpenbuffClient({
        cwd: '/tmp/test-project',
        projectFiles,
        agentDefinitions: [{ ...fileListerDefinition, model: 'anthropic/claude-haiku-4.5' } as unknown as AgentDefinition],
      })

      // Run file-lister with directories parameter to limit to frontend only
      const run = await client.run({
        agent: 'file-lister',
        prompt: 'Find React component files',
        params: {
          directories: ['frontend'],
        },
        handleEvent: () => {},
      })

      expect(run.output.type).not.toEqual('error')

      const outputStr =
        typeof run.output === 'string' ? run.output : JSON.stringify(run.output)

      // Require multiple distinct expected files within the scoped directory
      const expectedFiles = [
        'frontend/src/App.tsx',
        'frontend/src/components/Button.tsx',
      ]
      const matchedFiles = expectedFiles.filter((file) => outputStr.includes(file))
      expect(matchedFiles.length).toBeGreaterThanOrEqual(1)
      // Ensure no backend files leak through the directory filter
      expect(outputStr).not.toContain('backend/src/server.ts')
      const listedPaths = parseListedPaths(outputStr).filter(
        (s) => s.endsWith('.tsx') || s.endsWith('.ts'),
      )
      expect(listedPaths.length).toBeGreaterThanOrEqual(1)
    },
    { timeout: 60_000 },
  )
})

/**
 * Integration tests for the file-picker agent that spawns subagents.
 * The file-picker spawns file-lister as a subagent to find files.
 * This tests the spawn_agents tool functionality through the SDK.
 *
 * Wired to local subagent resolution via agentDefinitions passed to OpenbuffClient;
 * the spawned file-lister resolves locally rather than via the server registry.
 */
describe('File Picker Agent Integration - spawn_agents tool', () => {
  beforeAll(() => {
    setupE2eMocks()
  })
  it(
    'should spawn file-lister subagent and find relevant files',
    async () => {
      // Create mock project files
      const projectFiles: Record<string, string> = {
        'src/index.ts': `
import { UserService } from './services/user-service'
export function main() {
  const userService = new UserService()
  console.log('Application started')
}
`,
        'src/services/user-service.ts': `
export class UserService {
  async getUser(id: string) {
    return { id, name: 'John Doe' }
  }
}
`,
        'src/services/auth-service.ts': `
export class AuthService {
  async login(email: string, password: string) {
    return { token: 'mock-token' }
  }
}
`,
        'package.json': JSON.stringify({
          name: 'test-project',
          version: '1.0.0',
        }),
      }

      // Use local agent definitions to test the updated handleSteps
      const localFilePickerDef = filePickerDefinition
      const localFileListerDef = fileListerDefinition

      const client = new OpenbuffClient({
        cwd: '/tmp/test-project-picker',
        projectFiles,
        agentDefinitions: [
          localFilePickerDef as unknown as AgentDefinition,
          localFileListerDef as unknown as AgentDefinition,
        ],
      })

      const events: PrintModeEvent[] = []

      // Run the file-picker agent which spawns file-lister as a subagent
      const run = await client.run({
        agent: localFilePickerDef.id,
        prompt: 'Find files related to user authentication',
        handleEvent: (event) => {
          events.push(event)
        },
      })

      // Check for errors in the output
      if (run.output.type === 'error') {
        console.error('File picker error:', run.output)
      }

      console.log('File picker output type:', run.output.type)
      console.log('File picker output:', JSON.stringify(run.output, null, 2))

      // The output should not be an error
      expect(run.output.type).not.toEqual('error')

      // Verify we got some output
      expect(run.output).toBeDefined()

      // The file-picker should have found relevant files via its spawned file-lister
      const outputStr =
        typeof run.output === 'string' ? run.output : JSON.stringify(run.output)

      // Strengthened: require >=2 distinct full paths like file-lister cases — rejects weak substring `user|auth|service` hallucinations (RF-4).
      const expectedFiles = [
        'src/services/user-service.ts',
        'src/services/auth-service.ts',
        'src/index.ts',
      ]
      const matchedFiles = expectedFiles.filter((file) => outputStr.includes(file))
      expect(matchedFiles.length).toBeGreaterThanOrEqual(2)
      const listedPaths = parseListedPaths(outputStr).filter(
        (s) => s.endsWith('.ts') || s.endsWith('.json') || s.endsWith('.md'),
      )
      expect(listedPaths.length).toBeGreaterThanOrEqual(2)
    },
    { timeout: 90_000 },
  )
})
