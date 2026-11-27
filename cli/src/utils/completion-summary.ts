/**
 * Completion summary utility.
 * Walks accumulated agent/tool blocks to produce a concise summary block.
 */

import {
  extractFilePath,
  isEditToolBlock,
  isSuccessfulEditMessage,
} from './implementor-helpers'
import {
  getCanonicalMutationResult,
  getConfirmedMutationActions,
  getToolOutputRecords,
  getToolOutputValues,
  getStructuredErrorMessages,
} from './tool-result-normalizer'

import { acceptedReceiptVerdict, explicitReviewVerdict } from './review-outcome'
import {
  classifyValidationResult,
  classifyOutputOutcome,
} from './output-outcome'

import type { ContentBlock } from '../types/chat'

export type CompletionSummary = {
  filesEdited: number
  filesFailed: number
  filesUnconfirmed: number
  filesRolledBack: number
  rollbackIncomplete: number
  reviewVerdict: string | null
  testPassed: number
  testFailed: number
  hooksPassed: number
  hooksFailed: number
  hooksUnknown?: number
  reviewHistory?: Array<{ verdict: string; sourceId: string; stale: boolean }>
  hooksSkipped: number
  auxiliaryCompleted: number
  auxiliaryFailed: number
  errors: number
}

/**
 * Walk agent/tool blocks to tally completion stats.
 */
export function computeCompletionSummary(
  blocks: ContentBlock[],
): CompletionSummary | null {
  if (!blocks || blocks.length === 0) return null

  const summary: CompletionSummary = {
    filesEdited: 0,
    filesFailed: 0,
    filesUnconfirmed: 0,
    filesRolledBack: 0,
    rollbackIncomplete: 0,
    reviewVerdict: null,
    testPassed: 0,
    testFailed: 0,
    hooksPassed: 0,
    hooksFailed: 0,
    hooksSkipped: 0,
    auxiliaryCompleted: 0,
    auxiliaryFailed: 0,
    errors: 0,
  }

  const fileOutcomes = new Map<
    string,
    'edited' | 'failed' | 'unconfirmed' | 'rolled_back' | 'rollback_incomplete'
  >()

  let editGeneration = 0
  const reviews: Array<{
    verdict: string
    sourceId: string
    generation: number
  }> = []
  const seen = new WeakSet<object>()
  function walk(
    children: ContentBlock[],
    insideAgent = false,
    depth = 0,
  ): number {
    if (depth > 100) return 0
    let countedErrors = 0
    for (const block of children) {
      if (seen.has(block)) continue
      seen.add(block)
      if (block.type === 'tool') {
        const isEdit = isEditToolBlock(block)
        if (isEdit) {
          const canonical = getCanonicalMutationResult(block.outputRaw)
          if (canonical) {
            const confirmed = new Set(
              getConfirmedMutationActions(block).map((action) =>
                String(action.destinationPath ?? action.path),
              ),
            )
            const actions = Array.isArray(canonical.actions)
              ? canonical.actions
              : []
            if (confirmed.size > 0) editGeneration++
            for (const raw of actions) {
              if (
                !raw ||
                typeof raw !== 'object' ||
                typeof raw.path !== 'string'
              )
                continue
              const path = String(raw.destinationPath ?? raw.path)
              const outcome = String(raw.outcome)
              fileOutcomes.set(
                path,
                confirmed.has(path)
                  ? 'edited'
                  : outcome === 'unconfirmed'
                    ? 'unconfirmed'
                    : outcome === 'rolled_back'
                      ? 'rolled_back'
                      : outcome === 'rollback_incomplete'
                        ? 'rollback_incomplete'
                        : 'failed',
              )
            }
          } else if (
            block.lifecycle !== 'cancelled' &&
            block.lifecycle !== 'queued' &&
            block.lifecycle !== 'running'
          ) {
            const file = extractFilePath(block)
            if (file) {
              const records = getToolOutputRecords(block.outputRaw)
              const accepted =
                records.some((record) =>
                  isSuccessfulEditMessage(record.message),
                ) || isSuccessfulEditMessage(block.output)
              const failed =
                block.lifecycle === 'failed' ||
                getStructuredErrorMessages(block.outputRaw).length > 0
              fileOutcomes.set(
                file,
                accepted ? 'edited' : failed ? 'failed' : 'unconfirmed',
              )
              if (accepted) editGeneration++
            }
          }
        }

        const receiptVerdict = acceptedReceiptVerdict(block)
        if (receiptVerdict)
          reviews.push({
            verdict: receiptVerdict,
            sourceId: block.toolCallId,
            generation: editGeneration,
          })

        // Detect test results from basher output
        if (block.toolName === 'run_terminal_command') {
          const output = getToolOutputString(block)
          if (output) {
            const passMatch = output.match(/(\d+)\s+pass(?:ed|ing)/i)
            const failMatch = output.match(/(\d+)\s+fail(?:ed|ing)/i)
            if (passMatch) {
              summary.testPassed += parseInt(passMatch[1], 10)
            }
            if (failMatch) {
              summary.testFailed += parseInt(failMatch[1], 10)
            }
          }
        }

        if (block.toolName === 'run_file_change_hooks') {
          for (const result of getHookResults(block.outputRaw)) {
            const state = classifyValidationResult(result)
            if (state === 'failed') summary.hooksFailed++
            else if (state === 'skipped') summary.hooksSkipped++
            else if (state === 'passed') summary.hooksPassed++
            else summary.hooksUnknown = (summary.hooksUnknown ?? 0) + 1
          }
        }

        // Detect errors from tool output
        // Edit failures already have a dedicated per-file outcome above.
        // Counting them again as generic errors made recoverable edit retries
        // dominate the completion summary.
        if (
          !insideAgent &&
          !isEdit &&
          block.outputRaw &&
          isErrorOutput(block)
        ) {
          summary.errors++
          countedErrors++
        }
      }

      if (block.type === 'agent') {
        const isAuxiliary = [
          'security-reviewer',
          'test-writer',
          'doc-writer',
          'git-committer',
          'librarian',
          'synthesizer',
          'browser-use',
          'tmux-cli',
          'debugger',
        ].some((type) => block.agentType?.includes(type))
        if (isAuxiliary) {
          if (block.status === 'failed') summary.auxiliaryFailed++
          else if (block.status === 'complete') summary.auxiliaryCompleted++
        }
        const descendantErrors = block.blocks
          ? walk(block.blocks, true, depth + 1)
          : 0
        if (
          block.agentType?.includes('code-reviewer') &&
          block.status === 'complete'
        ) {
          const verdict = explicitReviewVerdict(block.content)
          if (verdict)
            reviews.push({
              verdict,
              sourceId: block.agentId,
              generation: editGeneration,
            })
        }
        // Auxiliary failures already have their own explicit count. For other
        // agents, count the failed wrapper only when no nested tool/agent error
        // already explains it.
        if (
          block.status === 'failed' &&
          !isAuxiliary &&
          descendantErrors === 0
        ) {
          summary.errors++
          countedErrors++
        }
        countedErrors += descendantErrors
      }
    }
    return countedErrors
  }

  walk(blocks)
  if (reviews.length) {
    summary.reviewHistory = reviews.map((review) => ({
      verdict: review.verdict,
      sourceId: review.sourceId,
      stale: review.generation !== editGeneration,
    }))
    summary.reviewVerdict =
      reviews.filter((review) => review.generation === editGeneration).at(-1)
        ?.verdict ?? null
  }

  for (const outcome of fileOutcomes.values()) {
    if (outcome === 'edited') summary.filesEdited++
    else if (outcome === 'unconfirmed') summary.filesUnconfirmed++
    else if (outcome === 'rolled_back') summary.filesRolledBack++
    else if (outcome === 'rollback_incomplete') summary.rollbackIncomplete++
    else summary.filesFailed++
  }

  if (
    summary.filesEdited === 0 &&
    summary.filesFailed === 0 &&
    summary.filesUnconfirmed === 0 &&
    summary.filesRolledBack === 0 &&
    summary.rollbackIncomplete === 0 &&
    summary.reviewVerdict === null &&
    summary.testPassed === 0 &&
    summary.testFailed === 0 &&
    summary.hooksPassed === 0 &&
    summary.hooksFailed === 0 &&
    summary.hooksSkipped === 0 &&
    !summary.hooksUnknown &&
    !summary.reviewHistory?.length &&
    summary.auxiliaryCompleted === 0 &&
    summary.auxiliaryFailed === 0 &&
    summary.errors === 0
  ) {
    return null
  }

  return summary
}

function getHookResults(outputRaw: unknown): Array<Record<string, unknown>> {
  return getToolOutputValues(outputRaw)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter(
      (entry): entry is Record<string, unknown> =>
        entry !== null && typeof entry === 'object' && !Array.isArray(entry),
    )
}

function getToolOutputString(block: {
  output?: string
  outputRaw?: unknown
}): string {
  if (typeof block.output === 'string' && block.output.trim())
    return block.output
  const record = getToolOutputRecords(block.outputRaw)[0]
  if (record)
    return [record.stdout, record.stderr]
      .filter((value) => typeof value === 'string')
      .join('\n')
  return getToolOutputValues(block.outputRaw)
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
}

function isErrorOutput(block: { outputRaw?: unknown }): boolean {
  return (
    getStructuredErrorMessages(block.outputRaw).length > 0 ||
    getToolOutputRecords(block.outputRaw).some(
      (record) => Array.isArray(record.errors) && record.errors.length > 0,
    )
  )
}

/**
 * Format a completion summary into a human-readable string.
 */
export function formatCompletionSummary(summary: CompletionSummary): string {
  const parts: string[] = []

  if (summary.auxiliaryCompleted > 0 || summary.auxiliaryFailed > 0) {
    parts.push(
      `${summary.auxiliaryFailed > 0 ? '⚠️' : '✅'} ${summary.auxiliaryCompleted} auxiliary agent${summary.auxiliaryCompleted === 1 ? '' : 's'} completed${summary.auxiliaryFailed > 0 ? `, ${summary.auxiliaryFailed} failed` : ''}`,
    )
  }

  if (
    summary.filesEdited > 0 ||
    summary.filesFailed > 0 ||
    summary.filesUnconfirmed > 0 ||
    summary.filesRolledBack > 0 ||
    summary.rollbackIncomplete > 0
  ) {
    let editPart = ''
    if (summary.filesEdited > 0) {
      editPart += `${summary.filesEdited} file${summary.filesEdited !== 1 ? 's' : ''} edited`
    }
    if (summary.filesFailed > 0) {
      if (editPart) editPart += ', '
      editPart += `${summary.filesFailed} failed`
    }
    if (summary.filesUnconfirmed > 0) {
      if (editPart) editPart += ', '
      editPart += `${summary.filesUnconfirmed} unconfirmed`
    }
    if (summary.filesRolledBack > 0) {
      if (editPart) editPart += ', '
      editPart += `${summary.filesRolledBack} rolled back`
    }
    if (summary.rollbackIncomplete > 0) {
      if (editPart) editPart += ', '
      editPart += `${summary.rollbackIncomplete} rollback incomplete`
    }
    if (
      summary.filesFailed > 0 ||
      summary.filesUnconfirmed > 0 ||
      summary.rollbackIncomplete > 0
    ) {
      parts.push(`⚠️ ${editPart}`)
    } else {
      parts.push(`✅ ${editPart}`)
    }
  }

  if (
    summary.hooksPassed ||
    summary.hooksFailed ||
    summary.hooksSkipped ||
    summary.hooksUnknown
  ) {
    const hookParts = [
      summary.hooksPassed ? `${summary.hooksPassed} passed` : '',
      summary.hooksFailed ? `${summary.hooksFailed} failed` : '',
      summary.hooksSkipped ? `${summary.hooksSkipped} skipped` : '',
      summary.hooksUnknown ? `${summary.hooksUnknown} outcome unknown` : '',
    ].filter(Boolean)
    parts.push(
      `${summary.hooksFailed ? '❌' : '✅'} Hooks: ${hookParts.join(', ')}`,
    )
  }

  if (summary.reviewVerdict) {
    const verd = summary.reviewVerdict
    const tone = classifyOutputOutcome(verd)
    const icon =
      tone === 'bad'
        ? '🔴'
        : tone === 'warn'
          ? '🟡'
          : tone === 'good'
            ? '🟢'
            : '⚪'
    parts.push(`Reviewed: ${icon} ${verd}`)
  }

  if (!summary.reviewVerdict && summary.reviewHistory?.length)
    parts.push('Review evidence predates the latest captured edit')

  if (summary.testPassed > 0 || summary.testFailed > 0) {
    let testPart = 'Tests: '
    if (summary.testPassed > 0) {
      testPart += `${summary.testPassed} passed`
    }
    if (summary.testFailed > 0) {
      if (summary.testPassed > 0) testPart += ', '
      testPart += `${summary.testFailed} failed`
    }
    parts.push(summary.testFailed > 0 ? `❌ ${testPart}` : `✅ ${testPart}`)
  }

  if (summary.errors > 0) {
    parts.push(`❌ ${summary.errors} error${summary.errors !== 1 ? 's' : ''}`)
  }

  return parts.join(' | ')
}
