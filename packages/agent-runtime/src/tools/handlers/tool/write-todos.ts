import { promises as fs } from 'fs'
import * as path from 'path'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { jsonToolResult } from '@codebuff/common/util/messages'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'

type ToolName = 'write_todos'

type TodoItem = {
  task: string
  completed: boolean
}

const MAX_RETURNED_TODOS = 20

function getTodoSummary(todos: TodoItem[]): {
  totalCount: number
  completedCount: number
  remainingCount: number
  remainingTodos: TodoItem[]
} {
  const completedCount = todos.filter((t) => t.completed).length
  const remainingTodos = todos.filter((t) => !t.completed)
  return {
    totalCount: todos.length,
    completedCount,
    remainingCount: remainingTodos.length,
    remainingTodos: remainingTodos.slice(0, MAX_RETURNED_TODOS),
  }
}

// Only scores at or above the merge threshold matter. Calculate their edit
// distance in a band, with two rows instead of a full quadratic matrix.
export async function getTodoSimilarity(
  s1: string,
  s2: string,
): Promise<number> {
  const a = s1.toLowerCase().trim()
  const b = s2.toLowerCase().trim()
  if (a === b) return 1.0
  if (!a || !b) return 0.0

  const m = a.length
  const n = b.length
  const maxLen = Math.max(m, n)
  // ceil avoids excluding a threshold match due to floating-point rounding;
  // the final score still decides whether the merge threshold was met.
  const limit = Math.ceil(maxLen * 0.15)
  if (Math.abs(m - n) > limit) return 0
  const unreachable = maxLen + 1
  let previous = new Float64Array(n + 1).fill(unreachable)
  let current = new Float64Array(n + 1).fill(unreachable)
  let cellsSinceYield = 0
  for (let j = 0; j <= Math.min(n, limit); j++) previous[j] = j

  for (let i = 1; i <= m; i++) {
    const start = Math.max(1, i - limit)
    const end = Math.min(n, i + limit)
    current[0] = i <= limit ? i : unreachable
    if (start > 1) current[start - 1] = unreachable
    let rowMin = current[0]
    for (let j = start; j <= end; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost,
      )
      rowMin = Math.min(rowMin, current[j])
      if (++cellsSinceYield >= 16_384) {
        cellsSinceYield = 0
        await yieldToEventLoop()
      }
    }
    if (end < n) current[end + 1] = unreachable
    if (rowMin > limit) return 0
    ;[previous, current] = [current, previous]
    if (i % 64 === 0) {
      cellsSinceYield = 0
      await yieldToEventLoop()
    }
  }

  return 1.0 - previous[n] / maxLen
}

let pendingTodoWrite: Promise<void> = Promise.resolve()

export const handleWriteTodos = (async (params: {
  previousToolCallFinished: Promise<void>
  toolCall: CodebuffToolCall<ToolName>
}): Promise<{ output: CodebuffToolOutput<ToolName> }> => {
  const { previousToolCallFinished, toolCall } = params

  await previousToolCallFinished
  // Async reads and writes must not interleave between concurrent runs in this
  // process; each merge must observe the previous completed write.
  const operation = pendingTodoWrite.then(() => writeTodos(toolCall))
  pendingTodoWrite = operation.then(
    () => {},
    () => {},
  )
  return operation
}) satisfies CodebuffToolHandlerFunction<ToolName>

async function writeTodos(toolCall: CodebuffToolCall<ToolName>): Promise<{
  output: CodebuffToolOutput<ToolName>
}> {
  const incomingTodos = (toolCall.input.todos as TodoItem[]) || []
  const stateDir = path.join(process.cwd(), '.omx/state')
  const stateFilePath = path.join(stateDir, 'todos-session.json')

  let masterTodos: TodoItem[] = []

  // Ensure state directory exists
  try {
    await fs.mkdir(stateDir, { recursive: true })
  } catch (err) {
    // Folder creation may fail on read-only mounts / permissions; the read/write
    // paths below handle a missing dir, so don't abort — but surface it.
    console.debug(
      `[write-todos] mkdir failed for ${stateDir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }

  // Load existing master list
  try {
    const content = await fs.readFile(stateFilePath, 'utf8')
    masterTodos = JSON.parse(content) as TodoItem[]
  } catch (err) {
    // If invalid JSON or read error, start fresh rather than blocking the user.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
      console.debug(
        `[write-todos] failed to read ${stateFilePath}, starting fresh: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    masterTodos = []
  }

  const mergedTodos: TodoItem[] = [...masterTodos]

  for (const incoming of incomingTodos) {
    // Try to find a match in master list
    let bestMatchIndex = -1
    let bestScore = 0.0

    for (let i = 0; i < mergedTodos.length; i++) {
      const score = await getTodoSimilarity(incoming.task, mergedTodos[i].task)
      if (score > bestScore) {
        bestScore = score
        bestMatchIndex = i
        if (score === 1) break
      }
      if (i % 64 === 63) await yieldToEventLoop()
    }

    if (bestScore >= 0.85 && bestMatchIndex !== -1) {
      // Update existing master todo
      mergedTodos[bestMatchIndex].completed = incoming.completed
      // Optionally update description if slightly changed (e.g. minor typos fixed)
      if (incoming.task.trim() !== mergedTodos[bestMatchIndex].task.trim()) {
        mergedTodos[bestMatchIndex].task = incoming.task
      }
    } else {
      // It's a new subtask or newly introduced task, append it
      mergedTodos.push({
        task: incoming.task,
        completed: incoming.completed,
      })
    }
  }

  // Save the new merged master list
  try {
    await fs.writeFile(
      stateFilePath,
      JSON.stringify(mergedTodos, null, 2),
      'utf8',
    )
  } catch (err) {
    // Persisting is best-effort; the in-memory list is returned to the model
    // regardless, but surface the failure so silent state loss is debuggable.
    console.debug(
      `[write-todos] failed to write ${stateFilePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }

  const todoSummary = getTodoSummary(incomingTodos)
  const persistedHistoricalSummary = getTodoSummary(mergedTodos)
  const historicalTodoCount = Math.max(
    0,
    persistedHistoricalSummary.totalCount - incomingTodos.length,
  )

  let message = `Todos written successfully. Current active progress: ${todoSummary.completedCount}/${todoSummary.totalCount} tasks completed.`
  if (historicalTodoCount > 0) {
    message += ` Historical master checklist persists ${persistedHistoricalSummary.totalCount} total task(s), including approximately ${historicalTodoCount} task(s) not shown in the current active list.`
  }

  return {
    output: jsonToolResult({
      message,
      todoSummary,
      currentTodos: incomingTodos.slice(0, MAX_RETURNED_TODOS),
      persistedHistoricalSummary: {
        totalCount: persistedHistoricalSummary.totalCount,
        completedCount: persistedHistoricalSummary.completedCount,
        remainingCount: persistedHistoricalSummary.remainingCount,
        historicalTodoCount,
      },
      masterTodosOmittedForLength: true,
    }),
  }
}
