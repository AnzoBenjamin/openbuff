import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { parseFileStructure } from '@codebuff/code-map'

import { codeSearch } from '../tools/code-search'
import { getFilesStructured } from '../tools/read-files'
import { createNodeFileSystem } from '../tools/node-filesystem'
import { inspectCodebaseStructure } from '../services/audit-intelligence'
import { getHarnessStateDir } from '../credentials'
import { WorkspaceMutationBroker } from '../services/workspace-mutation-broker'
import path from 'node:path'

import type { IndexManager } from '@codebuff/indexer'
import type { StructureDiagnostic } from '@codebuff/code-map'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { CodebuffFileSystem } from '@codebuff/common/types/filesystem'
import type { Logger } from '@codebuff/common/types/contracts/logger'

/**
 * The `openbuff mcp` server (P1-T4): a fail-closed MCP projection of the
 * SDK's EXISTING in-process read/inspect surfaces. Every tool delegates to
 * the canonical implementation (the indexer `IndexManager`, the code-map
 * tree-sitter outline pass, the policy-guarded file/ripgrep read tools, and
 * the audit-intelligence inventory) — this layer validates input, adapts
 * call shapes, and formats bounded output; it never reimplements the logic.
 *
 * NOT exposed by default (P1-T4 follow-up `openbuff mcp --mutations`):
 * receipt-backed edit tools (change-file/replace-range via the workspace
 * mutation broker) and memory search (Memory V2 store). Mutation tools must
 * stay opt-in; an `openbuff mcp` process opened by an MCP host config is
 * read-only unless the user explicitly arms edits.
 */

/** The CLI prints its own version; the default keeps the wire shape valid. */
export const MCP_SERVER_NAME = 'openbuff'

/** Server-side caps on tool arguments, independent of the wire schemas. */
const MAX_QUERY_CHARS = 4_096
const MAX_PATTERN_CHARS = 1_024
const MAX_STRINGS = 32
const MAX_SCOPE_ENTRIES = 16
const MAX_SCOPE_CHARS = 256
const MAX_PATH_CHARS = 1_024
const MAX_QUERY_LIMIT = 100
const MAX_SEARCH_RESULTS = 250
const DEFAULT_QUERY_LIMIT = 20
const DEFAULT_SEARCH_RESULTS = 30
const DEFAULT_OUTLINE_DEPTH = 2
const MAX_OUTLINE_DEPTH = 4
const MAX_OUTLINE_SYMBOLS = 500
/** read_files item rendering is capped by path+content budget, not by count. */
const MAX_READ_FILES = 16
const MAX_READ_FILES_TEXT_CHARS = 250_000
/** apply_edits: a bounded batch of full-file writes. */
const MAX_APPLY_EDITS = 32
const MAX_APPLY_EDIT_CONTENT_CHARS = 1_000_000
const DEFAULT_SEARCH_TIMEOUT_SECONDS = 10
const MAX_SEARCH_TIMEOUT_SECONDS = 60
const DEFAULT_INDEX_WAIT_MS = 2_000
const MAX_INDEX_WAIT_MS = 30_000

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const

const MUTATION_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
} as const

const stringList = (description: string) => ({
  type: 'array',
  items: { type: 'string' },
  maxItems: MAX_STRINGS,
  description,
})

const QUERY_INDEX_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      maxLength: MAX_QUERY_CHARS,
      description: 'Free-text search query over the codebase metadata index.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_QUERY_LIMIT,
      description: `Maximum number of file results (default ${DEFAULT_QUERY_LIMIT}, capped at ${MAX_QUERY_LIMIT}).`,
    },
    fileTypes: stringList(
      'Restrict to these file extensions (e.g. ["ts", "py"]).',
    ),
    pathPrefixes: stringList(
      'Restrict to these project-relative path prefixes.',
    ),
    mode: {
      type: 'string',
      enum: ['search', 'neighbors', 'path', 'explain', 'commands', 'references'],
      description:
        'Query mode: free-text search (default) or a graph traversal mode.',
    },
    from: {
      type: 'string',
      maxLength: MAX_PATH_CHARS,
      description: 'Graph traversal start node (neighbors/explain modes).',
    },
    to: {
      type: 'string',
      maxLength: MAX_PATH_CHARS,
      description: 'Graph traversal target node (explain mode).',
    },
    timeoutMs: {
      type: 'integer',
      minimum: 0,
      maximum: MAX_INDEX_WAIT_MS,
      description: `How long to wait for an index build before answering from the empty/stale snapshot (default ${DEFAULT_INDEX_WAIT_MS}ms).`,
    },
  },
  required: ['query'],
  additionalProperties: false,
}

const CODE_SEARCH_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    pattern: {
      type: 'string',
      maxLength: MAX_PATTERN_CHARS,
      description: 'ripgrep-compatible regular expression to search for.',
    },
    paths: stringList(
      'Optional project-relative files/directories to restrict the search to.',
    ),
    maxResults: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_SEARCH_RESULTS,
      description: `Per-file result cap (default ${DEFAULT_SEARCH_RESULTS}).`,
    },
    timeoutSeconds: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_SEARCH_TIMEOUT_SECONDS,
      description: `Search timeout in seconds (default ${DEFAULT_SEARCH_TIMEOUT_SECONDS}, capped at ${MAX_SEARCH_TIMEOUT_SECONDS}).`,
    },
  },
  required: ['pattern'],
  additionalProperties: false,
}

const READ_FILES_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    paths: stringList(
      'Project-relative file paths to read (policy-guarded; sensitive paths fail closed).',
    ),
    ranges: {
      type: 'array',
      maxItems: MAX_STRINGS,
      description:
        'Optional bounded line-range reads; range reads mint a cap.v3 read capability on full coverage.',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', maxLength: MAX_PATH_CHARS },
          startLine: { type: 'integer', minimum: 1 },
          endLine: { type: 'integer', minimum: 1 },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
}

const FILE_OUTLINE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      maxLength: MAX_PATH_CHARS,
      description:
        'Project-relative source file to outline (parsed with the shipped tree-sitter grammars).',
    },
    maxDepth: {
      type: 'integer',
      minimum: 0,
      maximum: MAX_OUTLINE_DEPTH,
      description: `Maximum symbol nesting depth to include (default ${DEFAULT_OUTLINE_DEPTH}).`,
    },
  },
  required: ['path'],
  additionalProperties: false,
}

const CODEBASE_STRUCTURE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    scope: {
      ...stringList(
        'Optional project-relative subtrees to inventory (defaults to the whole project).',
      ),
      maxItems: MAX_SCOPE_ENTRIES,
    },
  },
  additionalProperties: false,
}

const APPLY_EDITS_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    edits: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_APPLY_EDITS,
      description: `A bounded batch of full-file writes (create or guarded overwrite), applied via the workspace mutation broker.`,
      items: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            maxLength: MAX_PATH_CHARS,
            description: 'Project-relative file path to write.',
          },
          content: {
            type: 'string',
            maxLength: MAX_APPLY_EDIT_CONTENT_CHARS,
            description: 'The complete new file content.',
          },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  required: ['edits'],
  additionalProperties: false,
}

/**
 * The single tool registry: the tools/list payload and the dispatch map are
 * built from these entries, so a tool can never be listed-but-unhandled or
 * handled-but-unlisted. All entries are read-only this wave.
 */
const MCP_TOOLS: Tool[] = [
  {
    name: 'query_index',
    description:
      'Query the Openbuff codebase metadata index (symbols, headings, imports, graph neighbors) with lexical search plus optional semantic blending. Returns ranked file results with the index status.',
    inputSchema: QUERY_INDEX_INPUT_SCHEMA,
    annotations: { title: 'Query code index', ...READ_ONLY_ANNOTATIONS },
  },
  {
    name: 'code_search',
    description:
      'Regex search over the project via the bundled ripgrep (cap-guarded: blocked/sensitive paths are filtered; flags pass through a safe allowlist).',
    inputSchema: CODE_SEARCH_INPUT_SCHEMA,
    annotations: { title: 'Code search', ...READ_ONLY_ANNOTATIONS },
  },
  {
    name: 'read_files',
    description:
      'Read project files through the Openbuff capability guard (sensitive-path blocklist, host read policy, 10MB ceiling, bounded range reads). Complete reads mint cap.v3 read capabilities for edit tooling.',
    inputSchema: READ_FILES_INPUT_SCHEMA,
    annotations: { title: 'Read files', ...READ_ONLY_ANNOTATIONS },
  },
  {
    name: 'file_outline',
    description:
      'Structural outline of one source file (functions, classes, methods with line spans) from the Openbuff tree-sitter code map.',
    inputSchema: FILE_OUTLINE_INPUT_SCHEMA,
    annotations: { title: 'File outline', ...READ_ONLY_ANNOTATIONS },
  },
  {
    name: 'codebase_structure',
    description:
      'Audit intelligence: the whole-repo structural inventory (files, languages, subsystems, entry points) with a content-addressed snapshot id.',
    inputSchema: CODEBASE_STRUCTURE_INPUT_SCHEMA,
    annotations: { title: 'Codebase structure', ...READ_ONLY_ANNOTATIONS },
  },
]

/**
 * The opt-in mutation tool, registered ONLY when the server is started with
 * `mutations: true`. Kept as a single entry so the tools/list payload and the
 * tools/call dispatch stay consistent from one source (the read-only path
 * never sees it: `buildTools(false)` returns `MCP_TOOLS` untouched).
 */
const APPLY_EDITS_TOOL: Tool = {
  name: 'apply_edits',
  description:
    'Apply a bounded batch of full-file writes (create or guarded overwrite) to the workspace via the receipt-backed mutation broker. Opt-in only (openbuff mcp --mutations).',
  inputSchema: APPLY_EDITS_INPUT_SCHEMA,
  annotations: { title: 'Apply edits', ...MUTATION_ANNOTATIONS },
}

/**
 * Builds the listed-tool array from the single registry. With mutations off
 * this is exactly `MCP_TOOLS`; with mutations on it appends the opt-in tool.
 * The dispatch switch gates on the same source, so a tool is never
 * listed-but-unhandled or handled-but-unlisted.
 */
function buildTools(mutations: boolean): Tool[] {
  return mutations ? [...MCP_TOOLS, APPLY_EDITS_TOOL] : MCP_TOOLS
}

export type McpQueryIndexOptions = {
  limit?: number
  fileTypes?: string[]
  pathPrefixes?: string[]
  mode?: 'search' | 'neighbors' | 'path' | 'explain' | 'commands' | 'references'
  from?: string
  to?: string
}

/** Minimal structural seam over the real `IndexManager` (tests can stub it). */
export type McpIndexManager = Pick<IndexManager, 'queryBlended' | 'waitUntilReady'>

export type McpSessionData = {
  /** Project root all reads/queries/searches are scoped to. */
  projectRoot: string
  /**
   * Indexer seam (CLI: `IndexManager.getInstance(projectRoot, config, embedder)`).
   * Omitted → query_index answers with an honest disabled payload.
   */
  index?: McpIndexManager
}

/**
 * Structurally-typed host seam (mirrors `ServeBridgeClient`): the CLI binds
 * the real `OpenbuffClient` options here; tests inject stubs. Every member
 * is optional and defaulted inside `createMcpServer`, so a minimal
 * `{ fileSystem }` is a complete client for the read tools.
 */
export type McpServerClient = {
  fileSystem?: CodebuffFileSystem
  fileFilter?: (filePath: string) => { status: 'blocked' | 'allow-example' | 'allow' }
  logger?: Logger
}

/**
 * The public handle to a created MCP server. This is a STRUCTURAL interface
 * covering only what the SDK's public surface and its callers use
 * (`connect`/`close`/`setRequestHandler`) — NOT the concrete
 * `@modelcontextprotocol/sdk` `Server` class.
 *
 * Why: that class's bundled `.d.ts` references zod-v3-only symbols
 * (`objectOutputType`, `objectInputType`, …) that do not exist under this
 * workspace's hoisted zod 4.x, so re-exporting the concrete `Server` type from
 * the SDK's public declaration surface makes `dts-bundle-generator` fail the CI
 * `cd sdk && bun run build` step with `Cannot find symbol for node
 * "objectOutputType"` (P1-T4 follow-up). Returning this structural type keeps
 * the MCP SDK's zod-typed internals OUT of the public `.d.ts`.
 *
 * MIGRATION NOTE (type-level breaking change for @openbuff/sdk consumers):
 * `createMcpServer` previously returned the concrete MCP SDK `Server`; it now
 * returns ONLY this structural surface (`connect`/`close`). Code that used
 * the concrete surface on the returned object — `setRequestHandler(...)`,
 * the `transport` property, or additional `on*` registrations — will no
 * longer typecheck. Migrate by constructing and wiring your own
 * `@modelcontextprotocol/sdk` `Server` for those handlers (the
 * `setRequestHandler` registrations inside `createMcpServer` show the
 * pattern) and keep using this handle for `connect`/`close` only. The
 * runtime object is unchanged: this is a type-level narrowing only.
 */
export interface McpServer {
  // The transport is typed `unknown` (not the MCP SDK's `Transport`): the SDK
  // only ever passes a transport it just constructed (runMcp) or a linked test
  // transport, and referencing the SDK's `Transport` would re-introduce its
  // zod-typed .d.ts into our public declaration surface. `unknown` keeps the
  // concrete `Server` assignable (connect(transport: Transport) accepts it).
  connect(transport: unknown): Promise<void>
  close(): Promise<void>
}

export type CreateMcpServerOptions = {
  client: McpServerClient
  sessionData: McpSessionData
  /** Advertised on the MCP initialize handshake; defaults to MCP_SERVER_NAME. */
  serverName?: string
  /** Advertised on the MCP initialize handshake. */
  serverVersion?: string
  /**
   * Opt-in arm for the receipt-backed `apply_edits` edit tool (default
   * false). When true the tool is listed and handled; when absent the server
   * is read-only and a `tools/call` for `apply_edits` hits the fail-closed
   * unknown-tool gate.
   */
  mutations?: boolean
}

export type RunMcpOptions = CreateMcpServerOptions & {
  /** Aborting closes the server; stdio's lifetime is otherwise the process. */
  signal?: AbortSignal
}

type CallToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

const textResult = (text: string): CallToolResult => ({
  content: [{ type: 'text', text }],
})

const errorResult = (text: string): CallToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
})

function invalid(message: string): CallToolResult {
  return errorResult(`Invalid input: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  return typeof error === 'string' && error.length > 0 ? error : 'Unknown error'
}

function optionalString(
  value: unknown,
  name: string,
  maxChars: number,
): { ok: true; value: string | undefined } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, value: undefined }
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, message: `${name} must be a non-empty string.` }
  }
  if (value.length > maxChars) {
    return { ok: false, message: `${name} exceeds the ${maxChars}-character limit.` }
  }
  return { ok: true, value }
}

function optionalStringList(
  value: unknown,
  name: string,
  maxItems: number,
  maxChars: number,
): { ok: true; value: string[] | undefined } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, value: undefined }
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || entry.length === 0)
  ) {
    return { ok: false, message: `${name} must be an array of non-empty strings.` }
  }
  if (value.length > maxItems) {
    return { ok: false, message: `${name} supports at most ${maxItems} entries.` }
  }
  if (value.some((entry) => entry.length > maxChars)) {
    return { ok: false, message: `${name} entries are capped at ${maxChars} characters.` }
  }
  return { ok: true, value: value as string[] }
}

function optionalBoundedInt(
  value: unknown,
  name: string,
  min: number,
  max: number,
  fallback: number | undefined,
): { ok: true; value: number | undefined } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, value: fallback }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, message: `${name} must be a finite number.` }
  }
  const rounded = Math.floor(value)
  if (rounded < min) {
    return { ok: false, message: `${name} must be at least ${min}.` }
  }
  return { ok: true, value: Math.min(rounded, max) }
}

const QUERY_INDEX_MODES = new Set([
  'search',
  'neighbors',
  'path',
  'explain',
  'commands',
  'references',
])

function validateQueryIndexInput(
  args: unknown,
):
  | {
      ok: true
      input: { query: string; options: McpQueryIndexOptions; timeoutMs: number }
    }
  | { ok: false; message: string } {
  if (!isRecord(args)) return { ok: false, message: 'arguments must be an object.' }
  const query = optionalString(args.query, 'query', MAX_QUERY_CHARS)
  if (!query.ok || query.value === undefined) {
    return { ok: false, message: query.ok ? 'query is required.' : query.message }
  }
  const fileTypes = optionalStringList(
    args.fileTypes,
    'fileTypes',
    MAX_STRINGS,
    32,
  )
  if (!fileTypes.ok) return fileTypes
  const pathPrefixes = optionalStringList(
    args.pathPrefixes,
    'pathPrefixes',
    MAX_STRINGS,
    MAX_PATH_CHARS,
  )
  if (!pathPrefixes.ok) return pathPrefixes
  const limit = optionalBoundedInt(
    args.limit,
    'limit',
    1,
    MAX_QUERY_LIMIT,
    undefined,
  )
  if (!limit.ok) return limit
  const timeoutMs = optionalBoundedInt(
    args.timeoutMs,
    'timeoutMs',
    0,
    MAX_INDEX_WAIT_MS,
    DEFAULT_INDEX_WAIT_MS,
  )
  if (!timeoutMs.ok) return timeoutMs
  const from = optionalString(args.from, 'from', MAX_PATH_CHARS)
  if (!from.ok) return from
  const to = optionalString(args.to, 'to', MAX_PATH_CHARS)
  if (!to.ok) return to
  let mode: McpQueryIndexOptions['mode']
  if (args.mode !== undefined) {
    if (typeof args.mode !== 'string' || !QUERY_INDEX_MODES.has(args.mode)) {
      return {
        ok: false,
        message: `mode must be one of: ${[...QUERY_INDEX_MODES].join(', ')}.`,
      }
    }
    mode = args.mode as McpQueryIndexOptions['mode']
  }
  return {
    ok: true,
    input: {
      query: query.value,
      timeoutMs: timeoutMs.value ?? DEFAULT_INDEX_WAIT_MS,
      options: {
        ...(limit.value !== undefined ? { limit: limit.value } : {}),
        ...(fileTypes.value ? { fileTypes: fileTypes.value } : {}),
        ...(pathPrefixes.value ? { pathPrefixes: pathPrefixes.value } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(from.value !== undefined ? { from: from.value } : {}),
        ...(to.value !== undefined ? { to: to.value } : {}),
      },
    },
  }
}

async function callQueryIndex(
  sessionData: McpSessionData,
  args: unknown,
): Promise<CallToolResult> {
  const validated = validateQueryIndexInput(args)
  if (!validated.ok) return invalid(validated.message)
  const index = sessionData.index
  if (!index) {
    return textResult(
      JSON.stringify(
        {
          kind: 'query_index_result',
          schemaVersion: 1,
          results: [],
          ready: false,
          totalIndexed: 0,
          message:
            'No codebase index was configured for this MCP server (indexing disabled in openbuff.json); fall back to code_search or read_files.',
        },
        null,
        2,
      ),
    )
  }
  await index.waitUntilReady(validated.input.timeoutMs)
  const result = await index.queryBlended(
    validated.input.query,
    validated.input.options,
  )
  // Project to a bounded payload: the per-file symbol/heading lists are
  // already capped by the indexer; totals/status/message ride along verbatim.
  return textResult(
    JSON.stringify(
      {
        kind: 'query_index_result',
        schemaVersion: 1,
        results: result.results.map((item) => ({
          path: item.path,
          score: item.score,
          matchedOn: item.matchedOn,
          ...(item.symbols ? { symbols: item.symbols } : {}),
          ...(item.headings ? { headings: item.headings } : {}),
          ...(item.matchedSnippets
            ? { matchedSnippets: item.matchedSnippets }
            : {}),
          ...(item.explanation ? { explanation: item.explanation } : {}),
        })),
        ready: result.ready,
        totalIndexed: result.totalIndexed,
        indexAge: result.indexAge,
        status: result.status,
        ...(result.snapshot ? { snapshot: result.snapshot } : {}),
      },
      null,
      2,
    ),
  )
}

async function callCodeSearch(
  client: McpServerClient,
  sessionData: McpSessionData,
  args: unknown,
): Promise<CallToolResult> {
  if (!isRecord(args)) return invalid('arguments must be an object.')
  const pattern = optionalString(args.pattern, 'pattern', MAX_PATTERN_CHARS)
  if (!pattern.ok || pattern.value === undefined) {
    return invalid(pattern.ok ? 'pattern is required.' : pattern.message)
  }
  const paths = optionalStringList(args.paths, 'paths', MAX_STRINGS, MAX_PATH_CHARS)
  if (!paths.ok) return invalid(paths.message)
  const maxResults = optionalBoundedInt(
    args.maxResults,
    'maxResults',
    1,
    MAX_SEARCH_RESULTS,
    DEFAULT_SEARCH_RESULTS,
  )
  if (!maxResults.ok) return invalid(maxResults.message)
  const timeoutSeconds = optionalBoundedInt(
    args.timeoutSeconds,
    'timeoutSeconds',
    1,
    MAX_SEARCH_TIMEOUT_SECONDS,
    DEFAULT_SEARCH_TIMEOUT_SECONDS,
  )
  if (!timeoutSeconds.ok) return invalid(timeoutSeconds.message)
  const output = await codeSearch({
    projectPath: sessionData.projectRoot,
    pattern: pattern.value,
    maxResults: maxResults.value ?? DEFAULT_SEARCH_RESULTS,
    globalMaxResults: MAX_SEARCH_RESULTS,
    timeoutSeconds: timeoutSeconds.value ?? DEFAULT_SEARCH_TIMEOUT_SECONDS,
    ...(paths.value ? { paths: paths.value } : {}),
    ...(client.logger ? { logger: client.logger } : {}),
    ...(client.fileFilter ? { fileFilter: client.fileFilter } : {}),
  })
  const jsonPart = output.find((part) => part.type === 'json')
  const value: { errorMessage?: string; stdout?: string } =
    jsonPart && jsonPart.type === 'json' && isRecord(jsonPart.value)
      ? (jsonPart.value as { errorMessage?: string; stdout?: string })
      : {}
  if (typeof value.errorMessage === 'string') {
    return errorResult(value.errorMessage)
  }
  const stdout = typeof value.stdout === 'string' ? value.stdout : ''
  return textResult(
    stdout.trim().length > 0
      ? stdout
      : `No matches for pattern ${JSON.stringify(pattern.value)}.`,
  )
}

function renderReadFilesItem(item: {
  path: string
  status: string
  selector: string
  content?: string
  complete?: boolean
  startLine?: number
  endLine?: number
  totalLines?: number
  error?: { code: string; message: string }
  editAnchor?: { readCapability: string }
}): string {
  const header =
    item.selector === 'range'
      ? `--- ${item.path} lines ${item.startLine ?? '?'}-${item.endLine ?? '?'} of ${item.totalLines ?? '?'} [${item.status}] ---`
      : `--- ${item.path} [${item.status}] ---`
  if (item.status === 'error') {
    return `${header}\nerror(${item.error?.code ?? 'io_error'}): ${item.error?.message ?? 'unknown error'}`
  }
  const capability = item.editAnchor?.readCapability
  const footer = capability
    ? `\n\n[READ_CAPABILITY lines ${item.selector === 'range' ? `${item.startLine}-${item.endLine}` : `1-${item.totalLines ?? '?'}`}: ${capability}]`
    : ''
  return `${header}\n${item.content ?? ''}${footer}`
}

async function callReadFiles(
  client: Required<Pick<McpServerClient, 'fileSystem'>> & McpServerClient,
  sessionData: McpSessionData,
  args: unknown,
): Promise<CallToolResult> {
  if (!isRecord(args)) return invalid('arguments must be an object.')
  const paths = optionalStringList(args.paths, 'paths', MAX_READ_FILES, MAX_PATH_CHARS)
  if (!paths.ok) return invalid(paths.message)
  let ranges:
    | { path: string; startLine?: number; endLine?: number }[]
    | undefined
  if (args.ranges !== undefined) {
    if (!Array.isArray(args.ranges) || args.ranges.length > MAX_STRINGS) {
      return invalid(`ranges must be an array of at most ${MAX_STRINGS} entries.`)
    }
    ranges = []
    for (const entry of args.ranges) {
      if (!isRecord(entry)) return invalid('ranges entries must be objects.')
      const rangePath = optionalString(entry.path, 'ranges[].path', MAX_PATH_CHARS)
      if (!rangePath.ok || rangePath.value === undefined) {
        return invalid(
          rangePath.ok ? 'ranges[].path is required.' : rangePath.message,
        )
      }
      const startLine = optionalBoundedInt(
        entry.startLine,
        'ranges[].startLine',
        1,
        Number.MAX_SAFE_INTEGER,
        undefined,
      )
      if (!startLine.ok) return invalid(startLine.message)
      const endLine = optionalBoundedInt(
        entry.endLine,
        'ranges[].endLine',
        1,
        Number.MAX_SAFE_INTEGER,
        undefined,
      )
      if (!endLine.ok) return invalid(endLine.message)
      if (
        startLine.value !== undefined &&
        endLine.value !== undefined &&
        endLine.value < startLine.value
      ) {
        return invalid('ranges[].endLine must not precede ranges[].startLine.')
      }
      ranges.push({
        path: rangePath.value,
        ...(startLine.value !== undefined ? { startLine: startLine.value } : {}),
        ...(endLine.value !== undefined ? { endLine: endLine.value } : {}),
      })
    }
  }
  if ((paths.value?.length ?? 0) === 0 && (ranges?.length ?? 0) === 0) {
    return invalid('at least one path or range is required.')
  }
  const result = await getFilesStructured({
    filePaths: paths.value ?? [],
    ...(ranges ? { ranges } : {}),
    cwd: sessionData.projectRoot,
    fs: client.fileSystem,
    ...(client.fileFilter ? { fileFilter: client.fileFilter } : {}),
    // cap.v3 minting: scoped to this project root and MCP server process; the
    // process-scoped runId keeps tokens non-transferable across sessions, and
    // mutation tooling stays opt-in (P1-T4 follow-up) so minted capabilities
    // are inert read attestations by default.
    capabilityIssuer: {
      projectId: sessionData.projectRoot,
      runId: 'mcp',
    },
  })
  const blocks: string[] = []
  let usedChars = 0
  let truncatedCount = 0
  for (const item of result.results) {
    const block = renderReadFilesItem(item)
    if (usedChars + block.length > MAX_READ_FILES_TEXT_CHARS) {
      truncatedCount += 1
      continue
    }
    blocks.push(block)
    usedChars += block.length
  }
  if (truncatedCount > 0) {
    blocks.push(
      `[${truncatedCount} result(s) omitted to stay within the ${MAX_READ_FILES_TEXT_CHARS}-character MCP response budget; request them with narrower reads.]`,
    )
  }
  return textResult(blocks.join('\n\n'))
}

async function callFileOutline(
  client: Required<Pick<McpServerClient, 'fileSystem'>> & McpServerClient,
  sessionData: McpSessionData,
  args: unknown,
): Promise<CallToolResult> {
  if (!isRecord(args)) return invalid('arguments must be an object.')
  const pathArg = optionalString(args.path, 'path', MAX_PATH_CHARS)
  if (!pathArg.ok || pathArg.value === undefined) {
    return invalid(pathArg.ok ? 'path is required.' : pathArg.message)
  }
  const maxDepth = optionalBoundedInt(
    args.maxDepth,
    'maxDepth',
    0,
    MAX_OUTLINE_DEPTH,
    DEFAULT_OUTLINE_DEPTH,
  )
  if (!maxDepth.ok) return invalid(maxDepth.message)
  // The file content comes through the SAME cap-guarded read as the
  // read_files tool, so outline can never see bytes the guard would block.
  const read = await getFilesStructured({
    filePaths: [pathArg.value],
    cwd: sessionData.projectRoot,
    fs: client.fileSystem,
    ...(client.fileFilter ? { fileFilter: client.fileFilter } : {}),
  })
  const item = read.results[0]
  if (item === undefined) {
    return errorResult(
      `read failed for ${pathArg.value}: the read returned no result.`,
    )
  }
  // Union narrowing: `status: 'error'` items carry `error`; the whole-file
  // 'file' selector carries `content`/`complete`. Reading those fields off
  // the un-narrowed ReadFilesItemV1 union does not typecheck.
  if (item.status === 'error') {
    return errorResult(
      `read failed for ${pathArg.value}: ${item.error.message}`,
    )
  }
  if (item.selector !== 'file' || typeof item.content !== 'string') {
    return errorResult(
      `read failed for ${pathArg.value}: the file could not be read.`,
    )
  }
  if (!item.complete) {
    return errorResult(
      `The file ${pathArg.value} exceeds the whole-file read limit; outline requires a complete file.`,
    )
  }
  const diagnostics: StructureDiagnostic[] = []
  const symbols = await parseFileStructure(item.content, pathArg.value, diagnostics)
  if (symbols === null) {
    return errorResult(
      `No tree-sitter grammar is available for ${pathArg.value}; outline unsupported.`,
    )
  }
  const depthLimit = maxDepth.value ?? DEFAULT_OUTLINE_DEPTH
  const visible = symbols.filter((symbol) => symbol.depth <= depthLimit)
  const rendered = visible
    .slice(0, MAX_OUTLINE_SYMBOLS)
    .map((symbol) => {
      const indent = '  '.repeat(symbol.depth)
      const tags = [symbol.kind, symbol.exported === true ? 'exported' : null]
        .filter(Boolean)
        .join(', ')
      return `${indent}${symbol.name} (${tags}) — lines ${symbol.startLine}-${symbol.endLine}`
    })
  const notes: string[] = []
  if (visible.length > MAX_OUTLINE_SYMBOLS) {
    notes.push(
      `[outline truncated at ${MAX_OUTLINE_SYMBOLS} symbols; lower maxDepth to narrow it.]`,
    )
  }
  if (symbols.length > visible.length) {
    notes.push(
      `[${symbols.length - visible.length} deeper symbol(s) hidden by maxDepth=${depthLimit}.]`,
    )
  }
  for (const diagnostic of diagnostics.slice(0, 8)) {
    notes.push(`[parse diagnostic: ${diagnostic.message}]`)
  }
  const header = `Outline of ${pathArg.value} (${symbols.length} symbol(s), maxDepth=${depthLimit}):`
  return textResult(
    [header, ...(rendered.length > 0 ? rendered : ['(no top-level symbols)']), ...notes].join(
      '\n',
    ),
  )
}

function callCodebaseStructure(
  sessionData: McpSessionData,
  args: unknown,
): CallToolResult {
  if (args !== undefined && !isRecord(args)) {
    return invalid('arguments must be an object.')
  }
  const scope = optionalStringList(
    isRecord(args) ? args.scope : undefined,
    'scope',
    MAX_SCOPE_ENTRIES,
    MAX_SCOPE_CHARS,
  )
  if (!scope.ok) return invalid(scope.message)
  const inventory = inspectCodebaseStructure(
    sessionData.projectRoot,
    scope.value,
  )
  return textResult(JSON.stringify(inventory, null, 2))
}

async function callApplyEdits(
  sessionData: McpSessionData,
  getBroker: () => Promise<WorkspaceMutationBroker>,
  args: unknown,
): Promise<CallToolResult> {
  if (!isRecord(args)) return invalid('arguments must be an object.')
  const rawEdits = args.edits
  if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
    return invalid('edits must be a non-empty array.')
  }
  if (rawEdits.length > MAX_APPLY_EDITS) {
    return invalid(`edits supports at most ${MAX_APPLY_EDITS} entries.`)
  }
  const edits: { path: string; content: string }[] = []
  for (const entry of rawEdits) {
    if (!isRecord(entry)) return invalid('edits entries must be objects.')
    const pathArg = optionalString(entry.path, 'edits[].path', MAX_PATH_CHARS)
    if (!pathArg.ok || pathArg.value === undefined) {
      return invalid(pathArg.ok ? 'edits[].path is required.' : pathArg.message)
    }
    if (typeof entry.content !== 'string') {
      return invalid('edits[].content must be a string.')
    }
    if (entry.content.length > MAX_APPLY_EDIT_CONTENT_CHARS) {
      return invalid(
        `edits[].content exceeds the ${MAX_APPLY_EDIT_CONTENT_CHARS}-character limit.`,
      )
    }
    edits.push({ path: pathArg.value, content: entry.content })
  }
  // A broker-construction failure (lock/state-dir unavailable, identity
  // unresolvable) surfaces as a tool error, never a crashed server.
  let broker: WorkspaceMutationBroker
  try {
    broker = await getBroker()
  } catch (error) {
    return errorResult(
      `Workspace mutation broker unavailable: ${errorMessage(error)}`,
    )
  }
  const results: { path: string; applied: boolean; actualHash?: string }[] = []
  for (const edit of edits) {
    // v1 is a full-file write: `expectedHash: null` is a create/overwrite.
    const commit = await broker.conditionalCommit(edit.path, edit.content, null)
    results.push({
      path: edit.path,
      applied: commit.applied,
      // `actualHash` exists only on the `applied: false` union variant (the
      // hash that blocked the write); narrow before reading it.
      ...(commit.applied === false && commit.actualHash != null
        ? { actualHash: commit.actualHash }
        : {}),
    })
  }
  return textResult(JSON.stringify(results, null, 2))
}

/**
 * A zod-4-native `tools/call` request schema. The MCP SDK's bundled
 * `CallToolRequestSchema` is zod-v3-shaped: its `params.arguments` is a
 * one-argument `z.record(z.unknown())`, which this workspace's hoisted zod 4
 * cannot parse — any non-empty arguments object throws
 * `undefined is not an object (evaluating 'def.valueType._zod')` inside the
 * SDK's protocol layer and surfaces as a -32603 response. Registering this
 * equivalent schema keeps the wire contract (method + name + optional
 * arguments/_meta) while parsing under zod 4; per-tool input validation still
 * happens in the handlers below.
 */
const CALL_TOOL_REQUEST_SCHEMA_V4 = z.object({
  method: z.literal('tools/call'),
  params: z.object({
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()).optional(),
    _meta: z.unknown().optional(),
  }),
})

/**
 * Builds the MCP server: a raw `Server` with the tools capability declared
 * and `ListToolsRequestSchema`/`CallToolRequestSchema` handlers registered
 * explicitly, so the dispatch contract stays visible at this layer.
 *
 * Fail-closed posture: an unknown tool name throws `McpError(MethodNotFound)`
 * (a structured JSON-RPC error, never a process crash), and every handler
 * exception is converted to a tool-level `{ isError: true }` result.
 *
 * Public return type: the structural `McpServer` (connect/close only), NOT
 * the concrete MCP SDK `Server` — see the migration note on that interface
 * before relying on the concrete Server surface.
 */
export function createMcpServer(options: CreateMcpServerOptions): McpServer {
  const { sessionData } = options
  const client: McpServerClient = options.client
  const mutations = options.mutations === true
  const fs = client.fileSystem ?? createNodeFileSystem()
  const tools = buildTools(mutations)
  const toolNames = new Set(tools.map((tool) => tool.name))

  // The broker is constructed once per server and memoized: a per-call
  // `WorkspaceMutationBroker.create` would re-acquire the workspace lock for
  // every edit. It is built LAZILY (on the first apply_edits call) so an
  // armed server that never mutates never touches the broker state dir.
  let brokerPromise: Promise<WorkspaceMutationBroker> | undefined
  const getMutationBroker = (): Promise<WorkspaceMutationBroker> => {
    brokerPromise ??= WorkspaceMutationBroker.create({
      cwd: sessionData.projectRoot,
      // The broker requires its state dir OUTSIDE the workspace (it rejects a
      // state dir inside the project root), so it lives under the harness
      // state dir rather than the project — the same convention run.ts uses.
      stateDir: path.join(getHarnessStateDir(), 'mutation-broker'),
    })
    return brokerPromise
  }

  const server = new Server(
    {
      name: options.serverName ?? MCP_SERVER_NAME,
      version: options.serverVersion ?? '0.0.0',
    },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }))

  server.setRequestHandler(
    // Cast: the SDK's parameter type is its bundled zod-v3-shaped schema;
    // ours is the zod-4-native equivalent with the identical wire shape (see
    // CALL_TOOL_REQUEST_SCHEMA_V4 above).
    CALL_TOOL_REQUEST_SCHEMA_V4 as unknown as typeof CallToolRequestSchema,
    async (request) => {
      const { name, arguments: args } = request.params
      // Fail closed BEFORE any handler logic: unknown names get a structured
      // MCP error, never a dispatched call. The gate is built from the SAME
      // tools array that tools/list served, so a listed tool is always handled.
      if (!toolNames.has(name)) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`)
      }
      try {
        switch (name) {
          case 'query_index':
            return await callQueryIndex(sessionData, args)
          case 'code_search':
            return await callCodeSearch(client, sessionData, args)
          case 'read_files':
            return await callReadFiles(
              { ...client, fileSystem: fs },
              sessionData,
              args,
            )
          case 'file_outline':
            return await callFileOutline(
              { ...client, fileSystem: fs },
              sessionData,
              args,
            )
          case 'codebase_structure':
            return callCodebaseStructure(sessionData, args)
          case 'apply_edits':
            return await callApplyEdits(sessionData, getMutationBroker, args)
          default:
            // Unreachable given the toolNames gate; kept so a registry edit
            // that forgets a case still fails closed.
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${name}`,
            )
        }
      } catch (error) {
        // A handler failure is a TOOL error: the MCP client gets isError:true
        // content, never a crashed server or a dropped JSON-RPC response.
        return errorResult(`Tool ${name} failed: ${errorMessage(error)}`)
      }
    },
  )

  return server
}

/**
 * Connects the MCP server to a `StdioServerTransport` and returns `{ close }`
 * (a no-op for stdio — the transport's lifetime IS the process). stdout is
 * the MCP wire: this layer writes nothing human-readable anywhere; the CLI
 * owns the stderr banner.
 */
export async function runMcp(
  options: RunMcpOptions,
): Promise<{ close: () => Promise<void> }> {
  const { signal, ...serverOptions } = options
  const server = createMcpServer(serverOptions)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  const close = async () => {
    await server.close()
  }
  if (signal) {
    if (signal.aborted) {
      await close()
    } else {
      signal.addEventListener('abort', () => void close(), { once: true })
    }
  }
  return { close }
}
