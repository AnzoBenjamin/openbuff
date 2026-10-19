import z from 'zod/v4'

import { $getNativeToolCallExampleString } from '../utils'

import type { $ToolParams } from '../../constants'
import {
  decodeJsonObjectString,
  recoverTruncatedJsonObject,
} from '../../../util/model-payload-recovery'

// C2 of the json-overhaul: the decode layer (recoverTruncatedJsonObject +
// decodeJsonObjectString) moved verbatim to
// common/src/util/model-payload-recovery.ts. Re-imported here and re-exported
// so importer paths (tool-executor, handler, set-output-schema tests) stay
// untouched.

const toolName = 'set_output'
const endsAgentStep = false
// Reviewer-only scope: these are the array/object fields of the reviewer
// receipt schema (agents/reviewer/code-reviewer.ts). Stringified containers
// under any other field name are intentionally left as strings; a future
// non-reviewer agent with stringified array/object fields must add its own
// field names here (or get its own normalization pass).
const structuredContainerFields = new Set([
  'reviewedFiles',
  'findings',
  'dimensions',
  'requirementCoverage',
])

// Receipt-shape constants (GATE_CRITICAL_KEYS, ATTESTATION_CORE_KEYS,
// REVIEWER_VERDICT_VALUES, REVIEWER_COVERAGE_VALUES,
// REQUIRED_DIMENSION_KEYS, TRUNCATION_DIMENSION_PLACEHOLDER) moved verbatim to
// common/src/util/model-payload-recovery.ts (C1 of the json-overhaul), and the
// JSON decode layer (scan helpers + recoverTruncatedJsonObject +
// decodeJsonObjectString) followed in C2 so all recovery logic has one
// canonical home.

// When requirementCoverage is truncated off entirely, do not synthesize
// `[]` under the recovered verdict. The gate finalizes only on LOOKS_GOOD, so
// an empty placeholder would finalize with zero requirement evidence. Inject
// an explicit `uncertain` entry and force verdict BLOCKING so a mid-essay
// truncate cannot pass as a complete review.

// Re-exports keep the historical importer paths intact.
export {
  decodeJsonObjectString,
  recoverTruncatedJsonObject,
}

export const normalizeStructuredOutputValue = (
  value: unknown,
  fieldName?: string,
  depth = 0,
): unknown => {
  if (depth > 8) return value
  if (typeof value === 'string') {
    const candidate = value.trim()
    if (fieldName === 'schemaVersion' && /^\d+$/.test(candidate)) {
      return Number(candidate)
    }
    const canDecodeContainer =
      fieldName !== undefined && structuredContainerFields.has(fieldName)
    if (
      canDecodeContainer &&
      ((candidate.startsWith('{') && candidate.endsWith('}')) ||
        (candidate.startsWith('[') && candidate.endsWith(']')))
    ) {
      try {
        return normalizeStructuredOutputValue(
          JSON.parse(candidate) as unknown,
          fieldName,
          depth + 1,
        )
      } catch {
        return value
      }
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      normalizeStructuredOutputValue(item, undefined, depth + 1),
    )
  }
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      normalizeStructuredOutputValue(item, key, depth + 1),
    ]),
  )
}

// WHY `data` EXISTS IN THE INPUT SCHEMA:
// Subagents inherit their parent's tool definitions, and because of prompt caching
// we cannot modify or add tools mid-conversation. OpenAI models enforce the tool's
// input schema strictly, so we need a permissive shape that any model can call.
// An empty schema or `z.object({}).passthrough()` would be rejected by OpenAI's
// strict schema enforcement. The `data: z.record(...)` field is a deliberately
// vague shape that satisfies OpenAI while allowing us to inject the real
// outputSchema later in the conversation (in the instructions prompt).
//
// At runtime, the handler (`packages/agent-runtime/src/tools/handlers/tool/set-output.ts`)
// tries parsing against the real outputSchema in two ways:
//   1. Parse the raw output (agent passed fields at top level)
//   2. Fallback: parse `output.data` (agent wrapped fields in `data`)
// This means both `{ results: [...] }` and `{ data: { results: [...] } }` are accepted.
const inputSchema = z
  .looseObject({
    data: z
      .preprocess(decodeJsonObjectString, z.record(z.string(), z.any()))
      .optional(),
  })
  .describe(
    'JSON object to set as the agent output. The shape of the parameters are specified dynamically further down in the conversation. This completely replaces any previous output. If the agent was spawned, this value will be passed back to its parent. If the agent has an outputSchema defined, the output will be validated against it.',
  )
const description = `
Use this tool to publish an explicit structured receipt when your instructions require it (for example reviewers). It is not the only possible channel: if your instructions say the parent harvests plain assistant text, do not call this tool just to publish the answer.

Note that the output schema is provided dynamically in a user prompt further down in the conversation. Be sure to follow what the latest output schema is when using this tool.

Please set the output with all the information and analysis you want to pass on. Pass native object fields; never call JSON.stringify or place serialized JSON text inside data. If you just want to send a simple message, use an object with the key "message" and value of the message you want to send. Always pass a real JSON object literal (not a quoted string, not a markdown code block, not JSON.stringify output); if your agent has a declared output schema, include every field that schema marks required.
Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    message: 'I found a bug in the code!',
  },
  endsAgentStep,
})}
`.trim()

export const setOutputParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: z.tuple([
    z.object({
      type: z.literal('json'),
      value: z.object({
        message: z.string(),
      }),
    }),
  ]),
} satisfies $ToolParams
