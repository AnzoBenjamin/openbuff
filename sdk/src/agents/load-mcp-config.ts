import fs from 'fs'
import fsPromises from 'fs/promises'
import os from 'os'
import path from 'path'

import { mcpConfigSchema } from '@codebuff/common/types/mcp'
import { z } from 'zod/v4'

import type { MCPConfig, MCPConfigOrigin } from '@codebuff/common/types/mcp'
import { markMCPConfigOrigin } from '@codebuff/common/mcp/client'

/**
 * Schema for the mcp.json file format.
 * Matches the standard MCP config format used by Claude Code, Cursor, etc.
 */
export const mcpFileSchema = z.object({
  mcpServers: z.record(z.string(), mcpConfigSchema).default(() => ({})),
})

export type MCPFileConfig = z.infer<typeof mcpFileSchema>

/**
 * Loaded MCP configuration. `$VAR` references in server env/headers are kept
 * literal at load time and resolved once at connect time (see
 * resolveMCPConfigValues in common/src/mcp/client.ts), gated by origin.
 */
export type LoadedMCPConfig = {
  mcpServers: Record<string, MCPConfig>
  /** The file path this config was loaded from */
  _sourceFilePath: string
}

const MCP_CONFIG_FILE_NAME = 'mcp.json'

/**
 * Get default directories to search for mcp.json.
 * Matches the agent loading directories for consistency.
 */
const getDefaultMcpConfigDirs = (includeProjectConfig: boolean): string[] => {
  const cwdAgents = path.join(process.cwd(), '.agents')
  const parentAgents = path.join(process.cwd(), '..', '.agents')
  const homeAgents = path.join(os.homedir(), '.agents')
  return includeProjectConfig
    ? [homeAgents, parentAgents, cwdAgents]
    : [homeAgents]
}

/**
 * Trusted origin for an MCP config loaded from `configPath`: `'user'` when
 * the file lives under the user's home directory, `'project'` otherwise.
 * Uses a normalized prefix check with a path-separator boundary so e.g.
 * `/home/userX` never matches a home dir of `/home/user`.
 */
export function mcpConfigOriginForPath(configPath: string): MCPConfigOrigin {
  const home = path.normalize(os.homedir())
  const normalized = path.normalize(configPath)
  if (
    normalized === home ||
    (normalized.startsWith(home) && normalized.charAt(home.length) === path.sep)
  ) {
    return 'user'
  }
  return 'project'
}

/**
 * Process the raw string content of a single `mcp.json` file into `mergedConfig`.
 *
 * Parses the JSON, validates it against {@link mcpFileSchema}, and merges the
 * servers into `mergedConfig` (later calls override earlier ones), marking each
 * with its trusted origin. `$VAR` references are kept literal and resolved once
 * at connect time. A validation failure for this file logs when `verbose` and
 * returns early without merging, so one bad file does not abort the overall
 * load. `JSON.parse` failures propagate to the caller's try/catch.
 *
 * This helper is synchronous so both the async and sync loaders can share it;
 * each caller performs its own existence check and file read.
 */
function processMcpConfigFile(
  content: string,
  configPath: string,
  mergedConfig: LoadedMCPConfig,
  verbose: boolean,
): void {
  const rawConfig = JSON.parse(content)
  const parseResult = mcpFileSchema.safeParse(rawConfig)

  if (!parseResult.success) {
    if (verbose) {
      console.error(
        `Invalid mcp.json at ${configPath}: ${parseResult.error.message}`,
      )
    }
    return
  }

  const parsedConfig = parseResult.data

  // Merge MCP servers (later directories override earlier ones), marking each
  // with its trusted origin so $VAR substitution keeps working for these
  // on-disk configs while unmarked configs fail closed to 'client'.
  const origin = mcpConfigOriginForPath(configPath)
  for (const [serverName, serverConfig] of Object.entries(
    parsedConfig.mcpServers,
  )) {
    mergedConfig.mcpServers[serverName] = serverConfig
    markMCPConfigOrigin(serverConfig, origin)
  }

  // Track the last successfully loaded config path
  if (Object.keys(parsedConfig.mcpServers).length > 0) {
    mergedConfig._sourceFilePath = configPath
  }
}

/**
 * Load MCP configuration from `mcp.json` files in `.agents` directories.
 *
 * By default, searches for mcp.json in:
 * - `{cwd}/.agents/mcp.json`
 * - `{cwd}/../.agents/mcp.json`
 * - `{homedir}/.agents/mcp.json`
 *
 * Later directories take precedence, so project MCP servers override global ones.
 * Environment variable references (e.g., `$API_KEY`) are kept literal here and
 * resolved once at connect time (gated by origin).
 *
 * @param options.verbose - Whether to log errors during loading
 * @returns Record of MCP server configurations keyed by server name
 *
 * @example
 * ```typescript
 * // Load from default locations
 * const mcpConfig = await loadMCPConfig({ verbose: true })
 *
 * // Access MCP servers
 * for (const [serverName, config] of Object.entries(mcpConfig.mcpServers)) {
 *   console.log(`MCP server: ${serverName}`)
 * }
 * ```
 */
export async function loadMCPConfig(options: {
  includeProjectConfig?: boolean
  verbose?: boolean
}): Promise<LoadedMCPConfig> {
  const { includeProjectConfig = false, verbose = false } = options

  const mergedConfig: LoadedMCPConfig = {
    mcpServers: {},
    _sourceFilePath: '',
  }

  const mcpConfigDirs = getDefaultMcpConfigDirs(includeProjectConfig)

  for (const dir of mcpConfigDirs) {
    const configPath = path.join(dir, MCP_CONFIG_FILE_NAME)

    try {
      // Check if file exists asynchronously
      try {
        await fsPromises.access(configPath)
      } catch {
        continue
      }

      const content = await fsPromises.readFile(configPath, 'utf8')
      processMcpConfigFile(content, configPath, mergedConfig, verbose)
    } catch (error) {
      if (verbose) {
        console.error(
          `Error loading mcp.json from ${configPath}:`,
          error instanceof Error ? error.message : error,
        )
      }
    }
  }

  return mergedConfig
}

/**
 * Synchronously load MCP configuration from `mcp.json` files in `.agents` directories.
 * This is a sync version for use in contexts where async is not available.
 *
 * @param options.verbose - Whether to log errors during loading
 * @returns Record of MCP server configurations keyed by server name
 */
export function loadMCPConfigSync(options: {
  includeProjectConfig?: boolean
  verbose?: boolean
}): LoadedMCPConfig {
  const { includeProjectConfig = false, verbose = false } = options

  const mergedConfig: LoadedMCPConfig = {
    mcpServers: {},
    _sourceFilePath: '',
  }

  const mcpConfigDirs = getDefaultMcpConfigDirs(includeProjectConfig)

  for (const dir of mcpConfigDirs) {
    const configPath = path.join(dir, MCP_CONFIG_FILE_NAME)

    try {
      if (!fs.existsSync(configPath)) {
        continue
      }

      const content = fs.readFileSync(configPath, 'utf8')
      processMcpConfigFile(content, configPath, mergedConfig, verbose)
    } catch (error) {
      if (verbose) {
        console.error(
          `Error loading mcp.json from ${configPath}:`,
          error instanceof Error ? error.message : error,
        )
      }
    }
  }

  return mergedConfig
}
