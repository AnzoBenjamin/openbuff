import z from 'zod/v4'

import { MAX_SPAWN_BATCH_SIZE } from '../../../constants/agents'
import { agentHandoffSchema } from '../../../types/agent-handoff'

import { jsonObjectSchema } from '../../../types/json'
import {
  $getNativeToolCallExampleString,
  coerceToObject,
  jsonToolResultSchema,
  normalizeSpawnAgentList,
} from '../utils'

import type { $ToolParams } from '../../constants'

export const spawnAgentsOutputSchema = z
  .object({
    agentType: z.string(),
  })
  .and(jsonObjectSchema)
  .array()

export { agentHandoffSchema }

export type { AgentHandoff } from '../../../types/agent-handoff'

const legacyUnversionedHandoffSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => value.schemaVersion === undefined, {
    message:
      'Versioned handoffs must satisfy the complete canonical AgentHandoff schema.',
  })
const spawnHandoffSchema = z.union([
  agentHandoffSchema,
  legacyUnversionedHandoffSchema,
])

const toolName = 'spawn_agents'
const endsAgentStep = true

function getSpawnAgentShortName(agentType: string): string {
  const withoutVersion = agentType.split('@')[0] ?? agentType
  const parts = withoutVersion.split('/')
  return parts[parts.length - 1] ?? agentType
}

function uniqueSpawnAgentTypeValues(visibleAgentTypes: string[]): string[] {
  const unique = new Set<string>()
  for (const agentType of visibleAgentTypes) {
    const shortName = getSpawnAgentShortName(agentType)
    for (const value of [agentType, shortName, shortName.replace(/-/g, '_')]) {
      if (value) unique.add(value)
    }
  }
  return [...unique]
}

const spawnAgentTypeDescription =
  'Agent to spawn. Must be a name from the live "You can spawn the following agents" catalog (hyphenated ids; underscores accepted).'

const spawnAgentsInputDescription = `Spawn up to ${MAX_SPAWN_BATCH_SIZE} agents and send a prompt and/or parameters to each of them. These agents will run in parallel. Note that that means they will run independently. Split larger work into bounded waves. If you need to run agents sequentially, use spawn_agents with one agent at a time instead.`

const spawnAgentEntryFields = {
  prompt: z.string().optional().describe('Prompt to send to the agent'),
  background: z
    .boolean()
    .optional()
    .describe(
      'If true, return jobId immediately and run as in-process coroutine; poll with check_background_agent. Defaults to false (blocking). Cannot outlive this CLI session.',
    ),
  handoff: spawnHandoffSchema
    .optional()
    .describe(
      'Optional structured handoff; additive — non-consumers still get prompt/params.',
    ),
  timeout_seconds: z
    .number()
    .optional()
    .describe(
      'Optional wall-clock deadline seconds; omit or -1 for none. Agent defaultTimeoutMs still applies when set.',
    ),
  params: z
    .preprocess(
      coerceToObject,
      z
        .object({
          // Common agent fields (all optional hints — each agent validates its own required fields)
          command: z
            .string()
            .optional()
            .describe('Terminal command to run (basher, tmux-cli)'),
          what_to_summarize: z
            .string()
            .optional()
            .describe(
              'What information from the command output is desired (basher)',
            ),
          timeout_seconds: z
            .number()
            .optional()
            .describe(
              'Timeout for command. Set to -1 for no timeout. Default 30 (basher)',
            ),
          save_full_log: z
            .boolean()
            .optional()
            .describe(
              'Save full command output to a /tmp log and extract failure lines for long SYNC command output (basher)',
            ),
          failure_pattern: z
            .string()
            .optional()
            .describe(
              'grep -E failure extraction pattern used with save_full_log (basher)',
            ),
          max_failure_lines: z
            .number()
            .optional()
            .describe(
              'Maximum extracted failure lines to return with save_full_log (basher)',
            ),
          searchQueries: z
            .array(
              z.object({
                pattern: z.string().describe('The pattern to search for'),
                flags: z
                  .union([z.string(), z.array(z.string())])
                  .optional()
                  .describe(
                    'Optional ripgrep flags as one string or argv tokens (e.g. "-i -g *.ts" or ["-i", "-g", "*.ts"]). Do not quote the entire expression inside the JSON string.',
                  ),
                cwd: z
                  .string()
                  .optional()
                  .describe(
                    'Optional working directory relative to project root',
                  ),
                maxResults: z
                  .number()
                  .optional()
                  .describe('Max results per file. Default 15'),
              }),
            )
            .optional()
            .describe('Array of code search queries (code-searcher)'),
          filePaths: z
            .array(z.string())
            .optional()
            .describe('Relevant file paths to read (general-agent)'),
          directoryPaths: z
            .array(z.string())
            .optional()
            .describe(
              'Relevant directory paths to inventory (general-agent)',
            ),
          directories: z
            .array(z.string())
            .optional()
            .describe('Directories to search within (file-picker)'),
          url: z
            .string()
            .optional()
            .describe('Starting URL to navigate to (browser-use)'),
          prompts: z
            .array(z.string())
            .optional()
            .describe('Optional agent-specific prompts'),
        })
        .catchall(z.any()),
    )
    .optional()
    .describe('Parameters object for the agent'),
}

function spawnAgentsAgentsArraySchema(agentTypeSchema: z.ZodTypeAny) {
  return z
    .object({
      agent_type: agentTypeSchema,
      ...spawnAgentEntryFields,
    })
    .array()
    .min(1)
    .max(
      MAX_SPAWN_BATCH_SIZE,
      `A spawn batch can contain at most ${MAX_SPAWN_BATCH_SIZE} agents. Split larger work into bounded waves.`,
    )
}

function buildSpawnAgentsProviderSchema(agentTypeSchema: z.ZodTypeAny) {
  return z
    .object({
      agents: z.preprocess(
        (value) => normalizeSpawnAgentList(value),
        spawnAgentsAgentsArraySchema(agentTypeSchema),
      ),
    })
    .describe(spawnAgentsInputDescription)
}

export function buildSpawnAgentsProviderInputSchema(
  visibleAgentTypes: string[],
) {
  const uniqueValues = uniqueSpawnAgentTypeValues(visibleAgentTypes)
  if (uniqueValues.length === 0) {
    return buildSpawnAgentsProviderSchema(
      z.string().describe(spawnAgentTypeDescription),
    )
  }

  return buildSpawnAgentsProviderSchema(
    z.enum(uniqueValues as [string, ...string[]]).describe(
      `Agent to spawn from the live catalog: ${uniqueValues.join(', ')}. Must be a name from the live "You can spawn the following agents" catalog (hyphenated ids; underscores accepted).`,
    ),
  )
}

const inputSchema = z
  .object({
    agents: z.preprocess(
      (value) => normalizeSpawnAgentList(value),
      z
        .object({
          agent_type: z.string().describe(spawnAgentTypeDescription),
          ...spawnAgentEntryFields,
        })
        .array()
        .min(1)
        .max(
          MAX_SPAWN_BATCH_SIZE,
          `A spawn batch can contain at most ${MAX_SPAWN_BATCH_SIZE} agents. Split larger work into bounded waves.`,
        ),
    ),
  })
  .describe(spawnAgentsInputDescription)
const description = `
Spawn agents in parallel (up to batch max). Pass \`agents\` as a real array of objects — do not JSON.stringify entries.

- **\`agent_type\` must be a name from the live "You can spawn the following agents" catalog** (hyphenated ids; underscores accepted). It is an agent name (e.g. basher, code-searcher, general-agent), **not a tool name** (read_files, str_replace, …). Call tools directly; do not wrap them in spawn_agents.
- Prefer spawn_agents over single-agent tool aliases so multiple agents can run in parallel. Same nested \`prompt\` + \`params\` schema either way.
- Include required agent params (e.g. basher \`command\`, code-searcher \`searchQueries\`). Agent-specific fields go in \`params\`, not only the prompt.
- \`background: true\` returns a jobId immediately; poll with check_background_agent.

Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    agents: [
      {
        agent_type: 'basher',
        prompt: 'Check if tests pass',
        params: { command: 'npm test' },
      },
      {
        agent_type: 'code-searcher',
        params: {
          searchQueries: [{ pattern: 'authenticate', flags: '-g *.ts' }],
        },
      },
    ],
  },
  endsAgentStep,
})}
`.trim()

export const spawnAgentsParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(spawnAgentsOutputSchema),
} satisfies $ToolParams
