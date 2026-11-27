import { getAgentBaseName } from './message-block-helpers'
import {
  getStructuredErrorMessages,
  getToolOutputRecords,
} from './tool-result-normalizer'
import { outcomeForTool } from './output-outcome'
import {
  acceptedReceiptVerdict,
  explicitReviewVerdict,
  submittedReceiptValue,
} from './review-outcome'

import type {
  AgentContentBlock,
  TextContentBlock,
  ToolContentBlock,
} from '../types/chat'

const DEFAULT_BASHER_OUTPUT_PREVIEW_MAX_LENGTH = 120
const PREVIEW_ELLIPSIS = '...'

export function truncateToSingleLinePreview(
  text: string,
  maxLength = DEFAULT_BASHER_OUTPUT_PREVIEW_MAX_LENGTH,
): string | undefined {
  const singleLine = text.replace(/\s+/g, ' ').trim()
  if (!singleLine) {
    return undefined
  }

  if (singleLine.length <= maxLength) {
    return singleLine
  }

  const previewLength = Math.max(0, maxLength - PREVIEW_ELLIPSIS.length)
  return `${singleLine.slice(0, previewLength).trimEnd()}${PREVIEW_ELLIPSIS}`
}

export function getAgentDisplayPrompt(
  agentBlock: AgentContentBlock,
): string | undefined {
  const initialPrompt = agentBlock.initialPrompt?.trim()
  if (initialPrompt) {
    return initialPrompt
  }

  if (getAgentBaseName(agentBlock.agentType) !== 'basher') {
    return undefined
  }

  const whatToSummarize = agentBlock.params?.what_to_summarize
  return typeof whatToSummarize === 'string' && whatToSummarize.trim()
    ? whatToSummarize.trim()
    : undefined
}

/** Outcome first for folded agents; prompt remains separately available as scope. */
export function getAgentOutcomePreview(
  agent: AgentContentBlock,
  maxLength = 120,
): string {
  const prefix =
    agent.status === 'failed'
      ? 'Failed'
      : agent.status === 'partial'
        ? 'Partial'
        : agent.status === 'cancelled'
          ? 'Cancelled'
          : agent.status === 'running'
            ? 'Running'
            : agent.status === 'complete'
              ? 'Complete'
              : 'Outcome unknown'
  const blocks = agent.blocks ?? []
  let captured: string | undefined
  // Read recent schema-owned tool envelopes only. No JSON serialization or
  // recursive traversal is needed to draw a bounded preview.
  for (
    let index = blocks.length - 1;
    index >= Math.max(0, blocks.length - 1000);
    index--
  ) {
    const block = blocks[index]
    if (block.type !== 'tool') continue
    const errors = getStructuredErrorMessages(block.outputRaw)
    if (
      errors.length &&
      (agent.status === 'failed' ||
        agent.status === 'partial' ||
        agent.status === 'cancelled')
    ) {
      captured = errors[0]
      break
    }
    if (
      block.toolName === 'set_output' &&
      block.lifecycle !== 'queued' &&
      block.lifecycle !== 'running' &&
      block.lifecycle !== 'failed' &&
      block.lifecycle !== 'cancelled' &&
      block.outputRaw !== undefined
    ) {
      const record = getToolOutputRecords(block.outputRaw)[0]
      if (record?.salvaged === true || record?.status === 'ignored') {
        captured = String(record.message ?? 'Output retained with limits')
        break
      }
      const value = submittedReceiptValue(block.input)
      const input =
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : undefined
      const verdict = input?.status ?? input?.verdict ?? input?.outcome
      const summary = input?.summary ?? input?.message
      if (typeof verdict === 'string' || typeof summary === 'string') {
        captured = [verdict, summary]
          .filter((value) => typeof value === 'string')
          .join(' · ')
        break
      }
    }
    if (
      !captured &&
      (block.lifecycle === 'failed' || block.lifecycle === 'cancelled')
    )
      captured = `${block.toolName.replaceAll('_', ' ')} · ${outcomeForTool(block).label}`
  }
  if (!captured && agent.content?.trim())
    captured = agent.content.slice(0, maxLength * 4)
  if (!captured)
    for (
      let index = blocks.length - 1;
      index >= Math.max(0, blocks.length - 1000);
      index--
    ) {
      const block = blocks[index]
      if (
        block.type === 'text' &&
        block.textType !== 'reasoning' &&
        block.content.trim()
      ) {
        captured = block.content.slice(0, maxLength * 4)
        break
      }
      if (block.type === 'tool' && block.toolName === 'run_terminal_command') {
        const record = getToolOutputRecords(block.outputRaw)[0]
        const stdout =
          typeof record?.stdout === 'string' ? record.stdout : block.output
        if (typeof stdout === 'string' && stdout.trim()) {
          captured = `${outcomeForTool(block).label} · ${stdout.slice(0, maxLength * 4)}`
          break
        }
      }
    }
  return (
    truncateToSingleLinePreview(
      `${prefix} · ${captured ?? 'no captured output'}`,
      maxLength,
    ) ?? `${prefix} · no captured output`
  )
}

export function getAgentOutcomeVerdict(
  agent: AgentContentBlock,
): string | null {
  if (agent.status !== 'complete') return null
  const blocks = agent.blocks ?? []
  for (
    let index = blocks.length - 1;
    index >= Math.max(0, blocks.length - 1000);
    index--
  ) {
    const block = blocks[index]
    if (block.type === 'tool') {
      const verdict = acceptedReceiptVerdict(block)
      if (verdict) return verdict
    }
  }
  return explicitReviewVerdict(agent.content)
}

export function getBasherFinishedOutputPreview(
  agentBlock: AgentContentBlock,
  maxLength = DEFAULT_BASHER_OUTPUT_PREVIEW_MAX_LENGTH,
): string | undefined {
  if (
    getAgentBaseName(agentBlock.agentType) !== 'basher' ||
    agentBlock.status === 'running'
  ) {
    return undefined
  }

  const blocks = agentBlock.blocks ?? []
  return (
    truncateToSingleLinePreview(getTextOutput(blocks), maxLength) ??
    truncateToSingleLinePreview(getCommandOutput(blocks), maxLength)
  )
}

function getTextOutput(
  blocks: NonNullable<AgentContentBlock['blocks']>,
): string {
  return blocks
    .filter(
      (block): block is TextContentBlock =>
        block.type === 'text' && block.textType !== 'reasoning',
    )
    .map((block) => block.content)
    .join('\n')
}

function getCommandOutput(
  blocks: NonNullable<AgentContentBlock['blocks']>,
): string {
  return blocks
    .filter(
      (block): block is ToolContentBlock =>
        block.type === 'tool' && block.toolName === 'run_terminal_command',
    )
    .map((block) => block.output ?? '')
    .join('\n')
}
