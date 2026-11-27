import * as mainPromptModule from '@codebuff/agent-runtime/main-prompt'
import {
  buildReadFilesResultV1,
  type ReadFilesResultV1,
} from '@codebuff/common/tools/results/filesystem'
import * as projectFileTree from '@codebuff/common/project-file-tree'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { writeFileSync } from 'node:fs'

import { OpenbuffClient } from '../client'
import { beginSdkCallback, createSdkCallbackFixture } from './sdk-callback-fixture'
import * as databaseModule from '../impl/database'
import { nodeConfigReadFs } from '../host-config'

import type { FileFilter } from '../tools/read-files'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type { PathLike } from 'node:fs'

interface NodeError extends Error {
  code?: string
}

const createNodeError = (message: string, code: string): NodeError => {
  const error: NodeError = new Error(message)
  error.code = code
  return error
}

function createMockFs(config: {
  files?: Record<string, { content: string; size?: number }>
}): CodebuffFileSystem {
  const { files = {} } = config

  return {
    readFile: async (filePath: PathLike) => {
      const pathStr = String(filePath)
      if (files[pathStr]) {
        return files[pathStr].content
      }
      throw createNodeError(
        `ENOENT: no such file or directory: ${pathStr}`,
        'ENOENT',
      )
    },
    stat: async (filePath: PathLike) => {
      const pathStr = String(filePath)
      if (files[pathStr]) {
        return {
          size: files[pathStr].size ?? files[pathStr].content.length,
          isDirectory: () => false,
          isFile: () => true,
          atimeMs: Date.now(),
          mtimeMs: Date.now(),
        }
      }
      throw createNodeError(
        `ENOENT: no such file or directory: ${pathStr}`,
        'ENOENT',
      )
    },
    readdir: async () => [],
    mkdir: async () => undefined,
    realpath: async (filePath: PathLike) => String(filePath),
    unlink: async (filePath: PathLike) => {
      const pathStr = String(filePath)
      if (!files[pathStr]) {
        throw createNodeError(
          `ENOENT: no such file or directory: ${pathStr}`,
          'ENOENT',
        )
      }
      delete files[pathStr]
    },
    writeFile: async () => undefined,
  } as unknown as CodebuffFileSystem
}

describe('OpenbuffClientOptions fileFilter', () => {
  let fixture: ReturnType<typeof createSdkCallbackFixture>
  beforeEach(() => {
    fixture = createSdkCallbackFixture('run-file-filter')
    const configFile = fixture.file('openbuff.json')
    writeFileSync(configFile, JSON.stringify({ sandbox: { mode: 'project' } }))
    fixture.options = {
      ...fixture.options,
      configReadFs: nodeConfigReadFs,
      hostConfiguration: {
        ...fixture.options.hostConfiguration!,
        selection: { kind: 'explicit', path: configFile, required: true },
      },
    }
  })
  afterEach(() => {
    mock.restore()
    fixture.close()
  })

  it('[SEC-H01] applies mandatory sensitive policy before the custom filter', async () => {
    spyOn(databaseModule, 'getUserInfoFromApiKey').mockResolvedValue({
      id: 'user-123',
      email: 'test@example.com',
      discord_id: null,
      stripe_customer_id: null,
      banned: false,
      created_at: new Date('2024-01-01T00:00:00Z'),
    })
    spyOn(databaseModule, 'fetchAgentFromDatabase').mockResolvedValue(null)
    spyOn(databaseModule, 'startAgentRun').mockResolvedValue('run-1')
    spyOn(databaseModule, 'finishAgentRun').mockResolvedValue(undefined)
    spyOn(databaseModule, 'addAgentStep').mockResolvedValue('step-1')
    spyOn(projectFileTree, 'isFileIgnored').mockResolvedValue(false)

    const mockFs = createMockFs({
      files: {
        [fixture.file('.env')]: { content: 'SECRET=value' },
        [fixture.file('src/index.ts')]: { content: 'console.log("hello")' },
      },
    })

    let requestedFiles: ReadFilesResultV1 = buildReadFilesResultV1([])

    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const { sendAction, promptId, requestFiles } = params
        const { sessionState } = await beginSdkCallback(params)

        // Simulate agent requesting files
        requestedFiles = await requestFiles({
          filePaths: ['.env', 'src/index.ts'],
        })

        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState,
            output: {
              type: 'lastMessage',
              value: [],
            },
          },
        })

        return {
          sessionState,
          output: {
            type: 'lastMessage' as const,
            value: [],
          },
        }
      },
    )

    const filterCalls: string[] = []
    const fileFilter: FileFilter = (filePath) => {
      filterCalls.push(filePath)
      if (filePath === '.env') {
        return { status: 'blocked' }
      }
      return { status: 'allow' }
    }

    const client = new OpenbuffClient({
      ...fixture.options,
      apiKey: 'test-key',
      cwd: fixture.cwd,
      fsSource: mockFs,
      fileFilter,
    })

    const result = await client.run({
      agent: 'base2',
      prompt: 'read files',
    })

    expect(result.output.type).toBe('lastMessage')
    expect(filterCalls).not.toContain('.env')
    expect(filterCalls).toContain('src/index.ts')
    expect(requestedFiles.results).toContainEqual(
      expect.objectContaining({
        path: '.env',
        status: 'error',
        error: expect.objectContaining({ code: 'blocked' }),
      }),
    )
    expect(requestedFiles.results).toContainEqual(
      expect.objectContaining({
        path: 'src/index.ts',
        status: 'ok',
        content: 'console.log("hello")',
      }),
    )
  })

  it('should mark files as templates when filter returns allow-example', async () => {
    spyOn(databaseModule, 'getUserInfoFromApiKey').mockResolvedValue({
      id: 'user-123',
      email: 'test@example.com',
      discord_id: null,
      stripe_customer_id: null,
      banned: false,
      created_at: new Date('2024-01-01T00:00:00Z'),
    })
    spyOn(databaseModule, 'fetchAgentFromDatabase').mockResolvedValue(null)
    spyOn(databaseModule, 'startAgentRun').mockResolvedValue('run-1')
    spyOn(databaseModule, 'finishAgentRun').mockResolvedValue(undefined)
    spyOn(databaseModule, 'addAgentStep').mockResolvedValue('step-1')
    // Even though isFileIgnored returns true, template files should bypass this
    spyOn(projectFileTree, 'isFileIgnored').mockResolvedValue(true)

    const mockFs = createMockFs({
      files: {
        [fixture.file('.env.example')]: { content: 'API_KEY=your_key_here' },
      },
    })

    let requestedFiles: ReadFilesResultV1 = buildReadFilesResultV1([])

    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const { sendAction, promptId, requestFiles } = params
        const { sessionState } = await beginSdkCallback(params)

        requestedFiles = await requestFiles({
          filePaths: ['.env.example'],
        })

        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState,
            output: {
              type: 'lastMessage',
              value: [],
            },
          },
        })

        return {
          sessionState,
          output: {
            type: 'lastMessage' as const,
            value: [],
          },
        }
      },
    )

    const fileFilter: FileFilter = (filePath) => {
      if (filePath.endsWith('.example')) {
        return { status: 'allow-example' }
      }
      return { status: 'allow' }
    }

    const client = new OpenbuffClient({
      ...fixture.options,
      apiKey: 'test-key',
      cwd: fixture.cwd,
      fsSource: mockFs,
      fileFilter,
    })

    const result = await client.run({
      agent: 'base2',
      prompt: 'read files',
    })

    expect(result.output.type).toBe('lastMessage')
    expect(requestedFiles.results).toContainEqual(
      expect.objectContaining({
        path: '.env.example',
        status: 'ok',
        template: true,
        content: 'API_KEY=your_key_here',
      }),
    )
  })

  it('[SEC-H02] preserves mandatory blocking through requestOptionalFile', async () => {
    spyOn(databaseModule, 'getUserInfoFromApiKey').mockResolvedValue({
      id: 'user-123',
      email: 'test@example.com',
      discord_id: null,
      stripe_customer_id: null,
      banned: false,
      created_at: new Date('2024-01-01T00:00:00Z'),
    })
    spyOn(databaseModule, 'fetchAgentFromDatabase').mockResolvedValue(null)
    spyOn(databaseModule, 'startAgentRun').mockResolvedValue('run-1')
    spyOn(databaseModule, 'finishAgentRun').mockResolvedValue(undefined)
    spyOn(databaseModule, 'addAgentStep').mockResolvedValue('step-1')
    spyOn(projectFileTree, 'isFileIgnored').mockResolvedValue(false)

    const mockFs = createMockFs({
      files: {
        [fixture.file('secret.key')]: { content: 'private key content' },
      },
    })

    let optionalFileError: string | undefined

    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const { sendAction, promptId, requestOptionalFile } = params
        const { sessionState } = await beginSdkCallback(params)

        // Use requestOptionalFile which should also use the fileFilter
        try {
          await requestOptionalFile({ filePath: 'secret.key' })
        } catch (error) {
          optionalFileError =
            error instanceof Error ? error.message : String(error)
        }

        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState,
            output: {
              type: 'lastMessage',
              value: [],
            },
          },
        })

        return {
          sessionState,
          output: {
            type: 'lastMessage' as const,
            value: [],
          },
        }
      },
    )

    const filterCalls: string[] = []
    const fileFilter: FileFilter = (filePath) => {
      filterCalls.push(filePath)
      if (filePath.endsWith('.key')) {
        return { status: 'blocked' }
      }
      return { status: 'allow' }
    }

    const client = new OpenbuffClient({
      ...fixture.options,
      apiKey: 'test-key',
      cwd: fixture.cwd,
      fsSource: mockFs,
      fileFilter,
    })

    const result = await client.run({
      agent: 'base2',
      prompt: 'read optional file',
    })

    expect(result.output.type).toBe('lastMessage')
    expect(filterCalls).not.toContain('secret.key')
    expect(optionalFileError).toContain('read_files blocked')
  })

  it('[SEC-H01] accepts absolute requestOptionalFile paths inside cwd', async () => {
    spyOn(databaseModule, 'getUserInfoFromApiKey').mockResolvedValue({
      id: 'user-123',
      email: 'test@example.com',
      discord_id: null,
      stripe_customer_id: null,
      banned: false,
      created_at: new Date('2024-01-01T00:00:00Z'),
    })
    spyOn(databaseModule, 'fetchAgentFromDatabase').mockResolvedValue(null)
    spyOn(databaseModule, 'startAgentRun').mockResolvedValue('run-1')
    spyOn(databaseModule, 'finishAgentRun').mockResolvedValue(undefined)
    spyOn(databaseModule, 'addAgentStep').mockResolvedValue('step-1')
    spyOn(projectFileTree, 'isFileIgnored').mockResolvedValue(false)

    const mockFs = createMockFs({
      files: {
        [fixture.file('src/index.ts')]: { content: 'normal file content' },
      },
    })

    let optionalFileError: string | undefined

    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const { sendAction, promptId, requestOptionalFile } = params
        const { sessionState } = await beginSdkCallback(params)

        try {
          await requestOptionalFile({ filePath: fixture.file('src/index.ts') })
        } catch (error) {
          optionalFileError =
            error instanceof Error ? error.message : String(error)
        }

        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState,
            output: {
              type: 'lastMessage',
              value: [],
            },
          },
        })

        return {
          sessionState,
          output: {
            type: 'lastMessage' as const,
            value: [],
          },
        }
      },
    )

    const client = new OpenbuffClient({
      ...fixture.options,
      apiKey: 'test-key',
      cwd: fixture.cwd,
      fsSource: mockFs,
    })

    const result = await client.run({
      agent: 'base2',
      prompt: 'read optional file',
    })

    expect(result.output.type).toBe('lastMessage')
    expect(optionalFileError).toBeUndefined()
  })

  it('should allow all files when no fileFilter is provided', async () => {
    spyOn(databaseModule, 'getUserInfoFromApiKey').mockResolvedValue({
      id: 'user-123',
      email: 'test@example.com',
      discord_id: null,
      stripe_customer_id: null,
      banned: false,
      created_at: new Date('2024-01-01T00:00:00Z'),
    })
    spyOn(databaseModule, 'fetchAgentFromDatabase').mockResolvedValue(null)
    spyOn(databaseModule, 'startAgentRun').mockResolvedValue('run-1')
    spyOn(databaseModule, 'finishAgentRun').mockResolvedValue(undefined)
    spyOn(databaseModule, 'addAgentStep').mockResolvedValue('step-1')
    spyOn(projectFileTree, 'isFileIgnored').mockResolvedValue(false)

    const mockFs = createMockFs({
      files: {
        [fixture.file('src/index.ts')]: { content: 'normal file content' },
      },
    })

    let requestedFiles: ReadFilesResultV1 = buildReadFilesResultV1([])

    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const { sendAction, promptId, requestFiles } = params
        const { sessionState } = await beginSdkCallback(params)

        requestedFiles = await requestFiles({
          filePaths: ['src/index.ts'],
        })

        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState,
            output: {
              type: 'lastMessage',
              value: [],
            },
          },
        })

        return {
          sessionState,
          output: {
            type: 'lastMessage' as const,
            value: [],
          },
        }
      },
    )

    const client = new OpenbuffClient({
      ...fixture.options,
      apiKey: 'test-key',
      cwd: fixture.cwd,
      fsSource: mockFs,
    })

    const result = await client.run({
      agent: 'base2',
      prompt: 'read files',
    })

    expect(result.output.type).toBe('lastMessage')
    expect(requestedFiles.results).toContainEqual(
      expect.objectContaining({
        path: 'src/index.ts',
        status: 'ok',
        content: 'normal file content',
      }),
    )
  })

  it('returns structured read results by default', async () => {
    spyOn(databaseModule, 'getUserInfoFromApiKey').mockResolvedValue({
      id: 'user-123',
      email: 'test@example.com',
      discord_id: null,
      stripe_customer_id: null,
      banned: false,
      created_at: new Date('2024-01-01T00:00:00Z'),
    })
    spyOn(databaseModule, 'fetchAgentFromDatabase').mockResolvedValue(null)
    spyOn(databaseModule, 'startAgentRun').mockResolvedValue('run-1')
    spyOn(databaseModule, 'finishAgentRun').mockResolvedValue(undefined)
    spyOn(databaseModule, 'addAgentStep').mockResolvedValue('step-1')
    spyOn(projectFileTree, 'isFileIgnored').mockResolvedValue(false)

    const mockFs = createMockFs({
      files: {
        [fixture.file('src/index.ts')]: { content: 'normal file content' },
      },
    })
    let requestedFiles: unknown

    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const { sendAction, promptId, requestFiles } = params
        const { sessionState } = await beginSdkCallback(params)
        requestedFiles = await requestFiles({
          filePaths: ['src/index.ts'],
        })
        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState,
            output: { type: 'lastMessage', value: [] },
          },
        })
        return {
          sessionState,
          output: { type: 'lastMessage' as const, value: [] },
        }
      },
    )

    const client = new OpenbuffClient({
      ...fixture.options,
      apiKey: 'test-key',
      cwd: fixture.cwd,
      fsSource: mockFs,
      overrideTools: {
        read_files: async ({ filePaths }) =>
          buildReadFilesResultV1(
            filePaths.map((filePath, requestIndex) => ({
              selector: 'file' as const,
              requestIndex,
              path: filePath,
              status: 'ok' as const,
              content: 'normal file content',
              complete: true,
              template: false,
            })),
          ),
      },
    })
    await client.run({ agent: 'base2', prompt: 'read files' })

    expect(requestedFiles).toMatchObject({
      kind: 'read_files_result',
      version: 1,
      status: 'ok',
      summary: { requested: 1, ok: 1, partial: 0, failed: 0 },
    })
  })

  it('should run fileFilter before gitignore check', async () => {
    spyOn(databaseModule, 'getUserInfoFromApiKey').mockResolvedValue({
      id: 'user-123',
      email: 'test@example.com',
      discord_id: null,
      stripe_customer_id: null,
      banned: false,
      created_at: new Date('2024-01-01T00:00:00Z'),
    })
    spyOn(databaseModule, 'fetchAgentFromDatabase').mockResolvedValue(null)
    spyOn(databaseModule, 'startAgentRun').mockResolvedValue('run-1')
    spyOn(databaseModule, 'finishAgentRun').mockResolvedValue(undefined)
    spyOn(databaseModule, 'addAgentStep').mockResolvedValue('step-1')

    const isFileIgnoredSpy = spyOn(
      projectFileTree,
      'isFileIgnored',
    ).mockResolvedValue(false)

    const mockFs = createMockFs({
      files: {
        [fixture.file('blocked.ts')]: { content: 'blocked content' },
      },
    })

    let readCalls = 0
    spyOn(mainPromptModule, 'callMainPrompt').mockImplementation(
      async (params: Parameters<typeof mainPromptModule.callMainPrompt>[0]) => {
        const { sendAction, promptId, requestFiles } = params
        const { sessionState } = await beginSdkCallback(params)

        readCalls++
        await requestFiles({
          filePaths: ['blocked.ts'],
        })

        await sendAction({
          action: {
            type: 'prompt-response',
            promptId,
            sessionState,
            output: {
              type: 'lastMessage',
              value: [],
            },
          },
        })

        return {
          sessionState,
          output: {
            type: 'lastMessage' as const,
            value: [],
          },
        }
      },
    )

    const fileFilter: FileFilter = () => {
      // Block all files
      return { status: 'blocked' }
    }

    const client = new OpenbuffClient({
      ...fixture.options,
      apiKey: 'test-key',
      cwd: fixture.cwd,
      fsSource: mockFs,
      fileFilter,
    })

    const result = await client.run({
      agent: 'base2',
      prompt: 'read files',
    })

    expect(result.output.type).toBe('lastMessage')
    expect(readCalls).toBe(1)
    // isFileIgnored should not be called since fileFilter blocks the file first
    expect(isFileIgnoredSpy).not.toHaveBeenCalled()
  })

  it('a captured root mismatch refuses before the mocked prompt and file reads', async () => {
    const mockFs = createMockFs({ files: { [fixture.file('src/index.ts')]: { content: 'unchanged' } } })
    const read = spyOn(mockFs, 'readFile')
    const prompt = spyOn(mainPromptModule, 'callMainPrompt')
    const result = await new OpenbuffClient({
      ...fixture.options,
      fsSource: mockFs,
      hostConfiguration: {
        ...fixture.options.hostConfiguration!,
        projectRoot: fixture.file('different-project'),
      },
    }).run({ agent: 'base2', prompt: 'refused startup' })
    expect(result.output).toMatchObject({
      type: 'error', message: 'Run cwd differs from the captured project root',
    })
    expect(result.runOutcome).toMatchObject({
      termination: 'failed', cause: { code: 'execution_invalid_context' },
    })
    expect(prompt).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })

})
