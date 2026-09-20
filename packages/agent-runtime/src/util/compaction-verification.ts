import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { TaskMemoryV1 } from '@codebuff/common/types/task-memory'

/**
 * Post-compaction extraction verification — the self-check leg of the
 * fidelity pipeline. The pruner's deterministic post-processing enforces
 * STRUCTURE on what it wrote, but cannot recover a fact the model omitted.
 * This module derives the expected-fact set straight from the
 * pre-compaction transcript (ground truth: the tool calls actually made) and
 * checks each against the post-compaction state (history text + task
 * memory). Gaps are surfaced to the user in the compaction event's recovery
 * guidance and can be recovered via `recall_context` or a re-read.
 */

/** Bound the expected-fact set so verification stays cheap on huge turns. */
export const MAX_VERIFICATION_FACTS = 200

export type ExtractionVerification = {
  /** Facts the pre-compaction transcript is known to contain. */
  expected: number
  /** Expected facts absent from post-compaction history AND task memory. */
  missing: string[]
}

type ToolCallPart = {
  type: 'tool-call'
  toolName: string
  input: unknown
}

const isToolCallPart = (part: unknown): part is ToolCallPart =>
  typeof part === 'object' &&
  part !== null &&
  (part as ToolCallPart).type === 'tool-call'

/**
 * Same conservative policy as the eviction module's path check: project-
 * relative, no traversal, no glob syntax, bounded length. Absolute and
 * traversal strings are noise, not evidence — a false negative here only
 * weakens verification sensitivity, never correctness.
 */
const pathLike = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 1024) return false
  if (trimmed.startsWith('/') || /^[A-Za-z]:\//.test(trimmed)) return false
  if (/[?*{[\]}]/.test(trimmed)) return false
  if (trimmed.split('/').includes('..')) return false
  return trimmed.includes('/') || trimmed.includes('.')
}

/**
 * Derive expected facts from the pre-compaction transcript: file paths the
 * agent read or wrote, and commands it ran (truncated). These are ground
 * truth from tool-call INPUTS, not model recollection.
 */
export function deriveExpectedFacts(messages: Message[]): string[] {
  const facts = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      continue
    }
    for (const part of message.content) {
      if (!isToolCallPart(part)) continue
      const input = (part.input ?? {}) as Record<string, unknown>
      if (part.toolName === 'read_files' || part.toolName === 'write_file') {
        const paths = Array.isArray(input.paths)
          ? input.paths
          : Array.isArray(input.edits)
            ? (input.edits as Array<{ path?: unknown }>)
                .map((edit) => edit?.path)
            : undefined
        for (const path of Array.isArray(paths) ? paths : []) {
          if (pathLike(path)) facts.add(path)
        }
      } else if (part.toolName === 'run_terminal_command') {
        if (typeof input.command === 'string' && input.command.length > 0) {
          facts.add(input.command.slice(0, 80))
        }
      }
      if (facts.size >= MAX_VERIFICATION_FACTS) return [...facts]
    }
  }
  return [...facts]
}

const memoryCites = (taskMemory: TaskMemoryV1 | undefined, fact: string) =>
  [...(taskMemory?.filesInspected ?? []), ...(taskMemory?.editsMade ?? [])]
    .some((entry) => typeof entry === 'string' && entry.includes(fact))

/**
 * Check the extraction: a fact survives if it appears in post-compaction
 * history text (knowledge memory or retained messages) or in task memory.
 * Pure; never throws on malformed content parts.
 */
export function verifyExtractionCoverage(params: {
  preMessages: Message[]
  postMessages: Message[]
  taskMemory?: TaskMemoryV1
}): ExtractionVerification {
  const { preMessages, postMessages, taskMemory } = params
  const expected = deriveExpectedFacts(preMessages)
  const postText = JSON.stringify(postMessages)
  const missing: string[] = []
  for (const fact of expected) {
    if (postText.includes(fact)) continue
    if (memoryCites(taskMemory, fact)) continue
    if (missing.length < 12) missing.push(fact)
  }
  return { expected: expected.length, missing }
}
