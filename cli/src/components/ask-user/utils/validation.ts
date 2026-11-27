/**
 * Validation utilities for the ask_user tool
 */
import { getCliEnv } from '../../../utils/env'
import {
  ANSWER_PATTERN_RESULT_PREFIX,
  runAnswerPatternProcess,
} from '../../../utils/answer-pattern-process'

/**
 * Validation result
 */
export interface ValidationResult {
  isValid: boolean
  error?: string
}

/**
 * Question validation rules
 */
export interface QuestionValidation {
  maxLength?: number
  minLength?: number
  pattern?: string
  patternError?: string
}

/**
 * Validate "Other" text input against rules
 * Supports max/min length, regex patterns, and custom error messages
 */
const PATTERN_TIMEOUT_MS = 1000

function validatePattern(
  text: string,
  validation: QuestionValidation,
  signal?: AbortSignal,
): Promise<ValidationResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ isValid: false, error: 'Answer validation cancelled' })
      return
    }
    if ((validation.pattern?.length ?? 0) > 4096) {
      resolve({
        isValid: false,
        error: 'Question validation pattern is too long',
      })
      return
    }
    if (text.length > 32_768) {
      resolve({
        isValid: false,
        error: 'Question validation input is too large',
      })
      return
    }
    const packet = JSON.stringify({ text, pattern: validation.pattern })
    if (Buffer.byteLength(packet, 'utf8') > 64 * 1024) {
      resolve({
        isValid: false,
        error: 'Question validation input is too large',
      })
      return
    }
    // Bun 1.3.5 thread termination cannot interrupt a native RegExp match.
    // A child process gives timeout/cancellation a reliable SIGKILL boundary.
    const args =
      getCliEnv().CODEBUFF_IS_BINARY === 'true'
        ? ['--answer-pattern-worker']
        : ['-e', `(${runAnswerPatternProcess.toString()})()`]
    const startChild = () =>
      Bun.spawn([process.execPath, ...args], {
        stdin: Buffer.from(packet),
        stdout: 'pipe',
        stderr: 'ignore',
      })
    let child: ReturnType<typeof startChild>
    try {
      child = startChild()
    } catch {
      resolve({ isValid: false, error: 'Question validation could not run' })
      return
    }
    let settled = false
    const finish = (result: ValidationResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      try {
        child.kill('SIGKILL')
      } catch {
        /* It may already have exited. */
      }
      // Deliver cancellation only after the OS has reaped the child.
      void child.exited.then(
        () => resolve(result),
        () => resolve(result),
      )
    }
    const cancel = () =>
      finish({ isValid: false, error: 'Answer validation cancelled' })
    const timer = setTimeout(
      () =>
        finish({
          isValid: false,
          error:
            'Answer validation timed out. Shorten your answer or skip this question.',
        }),
      getCliEnv().CODEBUFF_CLI_LEGACY_MACOS === 'true' ? 3000 : PATTERN_TIMEOUT_MS,
    )
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) {
      cancel()
      return
    }
    let output = ''
    void (async () => {
      const reader = child.stdout.getReader()
      try {
        while (!settled) {
          const { done, value: chunk } = await reader.read()
          if (done) break
          output += Buffer.from(chunk).toString('utf8')
          if (output.length > 4096)
            return finish({
              isValid: false,
              error: 'Question validation could not run',
            })
          const index = output.indexOf(ANSWER_PATTERN_RESULT_PREFIX)
          if (index < 0) continue
          const result = output.slice(
            index + ANSWER_PATTERN_RESULT_PREFIX.length,
          )
          if (!result.includes('\n')) continue
          try {
            const value = JSON.parse(result.split('\n')[0]) as {
              matches?: unknown
              invalidPattern?: unknown
            }
            if (value?.invalidPattern === true) {
              finish({
                isValid: false,
                error: 'Question has an invalid validation pattern',
              })
            } else if (typeof value?.matches === 'boolean') {
              finish(
                value.matches
                  ? { isValid: true }
                  : {
                      isValid: false,
                      error: validation.patternError || 'Invalid format',
                    },
              )
            } else
              finish({
                isValid: false,
                error: 'Question validation could not run',
              })
          } catch {
            finish({
              isValid: false,
              error: 'Question validation could not run',
            })
          }
          return
        }
      } catch {
        // Pipe failure and child failure both leave the answer unvalidated.
      } finally {
        reader.releaseLock()
      }
      finish({ isValid: false, error: 'Question validation could not run' })
    })()
  })
}

export async function validateOtherText(
  text: string,
  validation?: QuestionValidation,
  maxLength: number = 500,
  signal?: AbortSignal,
): Promise<ValidationResult> {
  if (signal?.aborted)
    return { isValid: false, error: 'Answer validation cancelled' }
  // Default max length check
  if (text.length > maxLength) {
    return {
      isValid: false,
      error: `Max ${maxLength} characters`,
    }
  }

  // Validation rules (if provided)
  if (validation) {
    if (
      validation.maxLength !== undefined &&
      text.length > validation.maxLength
    ) {
      return {
        isValid: false,
        error: `Max ${validation.maxLength} characters`,
      }
    }

    if (
      validation.minLength !== undefined &&
      text.length < validation.minLength
    ) {
      return {
        isValid: false,
        error: `Min ${validation.minLength} characters`,
      }
    }

    if (validation.pattern && text.length > 0) {
      return validatePattern(text, validation, signal)
    }
  }

  return { isValid: true }
}

/**
 * Check if text input is empty or whitespace only
 */
export function isTextEmpty(text: string | undefined): boolean {
  return !text || !text.trim()
}

/**
 * Sanitize user input (remove control characters, excessive whitespace)
 */
export function sanitizeTextInput(text: string): string {
  return text
    .replace(/[\x00-\x1F\x7F]/g, ' ') // Replace control characters with space
    .replace(/\s+/g, ' ') // Collapse multiple spaces
    .trim()
}
