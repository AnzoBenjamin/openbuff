import {
  endsAgentStepParam,
  toolNameParam,
} from '@codebuff/common/tools/constants'

// Ordered spellings of the injected tool-name key. Providers and models
// re-spell `cb_tool_name` as tool_name / toolName / tool / name often enough
// that treating the canonical key as the only legal spelling turned a
// formatting quirk into a hard runtime error: the whole <codebuff_tool_call>
// was discarded as a parse error even though the intended call was obvious.
// Aliases are consulted only when the canonical key is absent or blank, so a
// real cb_tool_name always wins (see resolveToolName).
//
// This lives here rather than in a parser because BOTH parsers must accept the
// same spellings: the streaming parser read only the canonical key and so
// dropped exactly the calls the text parser had already learned to recover.
export const TOOL_NAME_KEYS = [
  toolNameParam,
  'tool_name',
  'toolName',
  'tool',
  'name',
] as const

// The ONE failure both parsers report when a tool-call block parses but
// carries no usable name. It lives beside the resolver so the streaming and
// text parsers cannot drift apart on wording a model will read: whichever path
// dropped the call, the model sees the identical sentence. Callers interpolate
// it after their own prefix, and the trailing period is part of the constant so
// no caller can append a second one.
export const MISSING_TOOL_NAME_REASON =
  'no tool-name key was present as a non-empty string.'

export type ResolvedToolName = { toolName: string; key: string }

/**
 * Resolves the tool name from a parsed <codebuff_tool_call> object.
 *
 * The canonical key is checked first and alone: when it holds a non-blank
 * string the result matches the old constant-only lookup, so the common path
 * does no alias work. Only a missing / blank / non-string canonical value walks
 * TOOL_NAME_KEYS, where the first non-blank string in list order wins so
 * precedence never depends on JSON key order.
 *
 * The supplying key travels back with the name so the caller can remove
 * exactly that spelling and leave the others alone — they may be real params.
 */
export function resolveToolName(
  parsed: Record<string, unknown>,
): ResolvedToolName | undefined {
  const canonical = parsed[toolNameParam]
  if (typeof canonical === 'string' && canonical.trim() !== '') {
    return { toolName: canonical.trim(), key: toolNameParam }
  }

  for (const key of TOOL_NAME_KEYS) {
    const value = parsed[key]
    if (typeof value === 'string' && value.trim() !== '') {
      return { toolName: value.trim(), key }
    }
  }

  return undefined
}

/**
 * Returns a copy of `parsed` with the injected tool-name control keys removed.
 *
 * Only the spelling that actually supplied the name (`resolved.key`) is
 * stripped, never every alias: `skill` declares a real `name` param, so
 * {"cb_tool_name":"skill","name":"x"} must keep `name` or the call fails on a
 * field the model did send. A leftover alias spelling is at worst an unknown key
 * that non-strict param schemas strip — never a missing-field error.
 */
export function stripToolNameKeys(
  parsed: Record<string, unknown>,
  resolved: ResolvedToolName,
): Record<string, unknown> {
  const input = { ...parsed }
  delete input[toolNameParam]
  delete input[resolved.key]
  delete input[endsAgentStepParam]
  return input
}
