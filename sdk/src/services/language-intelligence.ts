import path from 'node:path'

import {
  createLspMultiplexer,
  LspServerError,
  LspServerUnavailableError,
} from './lsp-multiplexer'

import type { ChildProcess } from 'node:child_process'
import type { CodebuffToolOutput } from '../../../common/src/tools/list'
import type {
  LspChildHandle,
  LspLocation,
  LspMultiplexer,
  LspPosition,
} from './lsp-multiplexer'
import type { CodebuffSpawn } from '@codebuff/common/types/spawn'

/**
 * P3-T2 (LI-01, Q2#5): language-intelligence service.
 *
 * Owns a lazily-built LSP multiplexer and converts the four read-only query
 * tools (go_to_definition / find_references / hover_type / workspace_symbol)
 * into structured results. Every failure mode that means "no language server
 * is present" degrades honestly into a typed `unavailable`/`errorMessage`
 * result rather than throwing, so the model can fall back to grep/index.
 *
 * The multiplexer is injectable so tests are hermetic (a fake multiplexer is
 * supplied and no language-server process is ever spawned).
 */

export type LanguageIntelligenceService = {
  goToDefinition(params: {
    path: string
    line: number
    character: number
  }): Promise<CodebuffToolOutput<'go_to_definition'>>
  findReferences(params: {
    path: string
    line: number
    character: number
  }): Promise<CodebuffToolOutput<'find_references'>>
  hoverType(params: {
    path: string
    line: number
    character: number
  }): Promise<CodebuffToolOutput<'hover_type'>>
  workspaceSymbol(params: {
    query: string
  }): Promise<CodebuffToolOutput<'workspace_symbol'>>
  dispose(): Promise<void>
}

type UnavailableResult = {
  unavailable: { reason: string; languageId?: string }
}

function toUnavailable(error: LspServerUnavailableError): UnavailableResult {
  return {
    unavailable: {
      reason: error.reason,
      ...(error.languageId ? { languageId: error.languageId } : {}),
    },
  }
}

function toErrorMessage(error: LspServerError): { errorMessage: string } {
  return { errorMessage: `Language server error (${error.reason}): ${error.message}` }
}

function uriToPath(uri: string): string {
  if (uri.startsWith('file://')) {
    let rest = uri.slice('file://'.length)
    // Strip a leading slash before a drive letter (Windows: file:///C:/...).
    if (/^\/[A-Za-z]:\//.test(rest)) {
      rest = rest.slice(1)
    }
    try {
      return decodeURIComponent(rest)
    } catch {
      return rest
    }
  }
  return uri
}

function toStructuredLocation(location: LspLocation): {
  uri: string
  path: string
  range: LspLocation['range']
} {
  return { uri: location.uri, path: uriToPath(location.uri), range: location.range }
}

function toStructuredLocations(
  result: LspLocation | LspLocation[] | null,
): ReturnType<typeof toStructuredLocation>[] {
  if (result === null) return []
  const list = Array.isArray(result) ? result : [result]
  return list.map(toStructuredLocation)
}

/** Convert the human-friendly 1-based `line` to the 0-based LSP position. */
function toLspPosition(line: number, character: number): LspPosition {
  return { line: line - 1, character }
}

/**
 * Adapt a spawned node `ChildProcess` to the structural `LspChildHandle`
 * surface the multiplexer drives. Language servers communicate over stdio,
 * so a child spawned without piped stdin/stdout is a spawn failure.
 */
function toLspChildHandle(child: ChildProcess): LspChildHandle {
  const { stdin, stdout } = child
  if (!stdin || !stdout) {
    throw new LspServerError('Spawned LSP server process has no stdio pipes.', {
      reason: 'spawn-failed',
    })
  }
  return {
    pid: child.pid,
    stdin,
    stdout,
    on: (event, listener) => {
      child.on(event, listener)
    },
    kill: (signal) => {
      child.kill(signal as NodeJS.Signals)
    },
  }
}

export type LanguageIntelligenceOptions = {
  cwd: string
  /** Required to lazily build the real multiplexer; unused when `multiplexer` is injected. */
  spawn?: CodebuffSpawn
  /** Inject a pre-built multiplexer so tests stay hermetic (no server spawned). */
  multiplexer?: LspMultiplexer
}

export function createLanguageIntelligence(
  options: LanguageIntelligenceOptions,
): LanguageIntelligenceService {
  let multiplexer: LspMultiplexer | undefined = options.multiplexer
  let built = options.multiplexer !== undefined

  function getMultiplexer(): LspMultiplexer {
    if (!built) {
      const spawn = options.spawn
      if (!spawn) {
        throw new LspServerError(
          'No LSP spawner configured and no multiplexer injected.',
          { reason: 'unavailable' },
        )
      }
      multiplexer = createLspMultiplexer({
        spawner: (spec): LspChildHandle => {
          const [command, ...args] = spec.argv
          return toLspChildHandle(spawn(command, args, { cwd: spec.cwd }))
        },
      })
      built = true
    }
    if (!multiplexer) {
      // Unreachable: `built` implies `multiplexer` is set. Fail closed.
      throw new LspServerError('LSP multiplexer was not initialized.', {
        reason: 'unavailable',
      })
    }
    return multiplexer
  }

  async function runQuery<T>(
    query: (mux: LspMultiplexer) => Promise<T>,
  ): Promise<T | UnavailableResult | { errorMessage: string }> {
    try {
      return await query(getMultiplexer())
    } catch (error) {
      if (error instanceof LspServerUnavailableError) {
        return toUnavailable(error)
      }
      if (error instanceof LspServerError) {
        return toErrorMessage(error)
      }
      throw error
    }
  }

  return {
    async goToDefinition(params) {
      const result = await runQuery((mux) =>
        mux.definition({
          filePath: path.resolve(options.cwd, params.path),
          position: toLspPosition(params.line, params.character),
        }),
      )
      if (result !== null && ('unavailable' in result || 'errorMessage' in result)) {
        return [{ type: 'json', value: result }]
      }
      return [{ type: 'json', value: { locations: toStructuredLocations(result) } }]
    },

    async findReferences(params) {
      const result = await runQuery((mux) =>
        mux.references({
          filePath: path.resolve(options.cwd, params.path),
          position: toLspPosition(params.line, params.character),
        }),
      )
      if (result !== null && ('unavailable' in result || 'errorMessage' in result)) {
        return [{ type: 'json', value: result }]
      }
      return [{ type: 'json', value: { locations: toStructuredLocations(result) } }]
    },

    async hoverType(params) {
      const result = await runQuery((mux) =>
        mux.hover({
          filePath: path.resolve(options.cwd, params.path),
          position: toLspPosition(params.line, params.character),
        }),
      )
      if (result !== null && ('unavailable' in result || 'errorMessage' in result)) {
        return [{ type: 'json', value: result }]
      }
      if (result === null) {
        return [{ type: 'json', value: {} }]
      }
      const hover = result as {
        contents: unknown
        range?: {
          start: { line: number; character: number }
          end: { line: number; character: number }
        }
      }
      return [
        {
          type: 'json',
          value: {
            hover: {
              contents: hover.contents as never,
              ...(hover.range ? { range: hover.range } : {}),
            },
          },
        },
      ]
    },

    async workspaceSymbol(params) {
      const result = await runQuery((mux) => mux.workspaceSymbol(params.query))
      if (result !== null && ('unavailable' in result || 'errorMessage' in result)) {
        return [{ type: 'json', value: result }]
      }
      const symbols = (result ?? []).map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        location: toStructuredLocation(symbol.location),
        ...(symbol.containerName ? { containerName: symbol.containerName } : {}),
      }))
      return [{ type: 'json', value: { symbols } }]
    },

    async dispose() {
      if (multiplexer) {
        await multiplexer.dispose()
      }
    },
  }
}
