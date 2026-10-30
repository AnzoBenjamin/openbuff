import { describe, test, expect } from 'bun:test'

import commander from '../basher'

import type { AgentState } from '../types/agent-definition'
import type { ToolResultOutput } from '../types/util-types'

describe('commander agent', () => {
  const createMockAgentState = (): AgentState => ({
    agentId: 'commander-test',
    runId: 'test-run',
    parentId: undefined,
    messageHistory: [],
    output: undefined,
    systemPrompt: '',
    toolDefinitions: {},
    contextTokenCount: 0,
  })

  describe('definition', () => {
    test('has correct id', () => {
      expect(commander.id).toBe('basher')
    })

    test('has display name', () => {
      expect(commander.displayName).toBe('Basher')
    })

    test('uses flash-lite model', () => {
      expect(commander.model).toBeUndefined()
    })

    test('has output mode set to structured_output', () => {
      expect(commander.outputMode).toBe('structured_output')
    })

    test('does not include message history', () => {
      expect(commander.includeMessageHistory).toBe(false)
    })

    test('has run_terminal_command tool', () => {
      expect(commander.toolNames).toContain('run_terminal_command')
      expect(commander.toolNames).toHaveLength(1)
      expect(commander.programmaticToolNames).toEqual(['set_output'])
    })

    test('does not promise an unavailable interactive approval path', () => {
      expect(commander.instructionsPrompt).toContain(
        'Do not claim the user can approve and retry this basher invocation',
      )
    })
  })

  describe('input schema', () => {
    test('requires command parameter', () => {
      const schema = commander.inputSchema
      const commandProp = schema?.params?.properties?.command
      expect(
        commandProp &&
          typeof commandProp === 'object' &&
          'type' in commandProp &&
          commandProp.type,
      ).toBe('string')
      expect(schema?.params?.required).toContain('command')
    })

    test('has optional timeout_seconds parameter', () => {
      const schema = commander.inputSchema
      const timeoutProp = schema?.params?.properties?.timeout_seconds
      expect(
        timeoutProp &&
          typeof timeoutProp === 'object' &&
          'type' in timeoutProp &&
          timeoutProp.type,
      ).toBe('number')
      expect(schema?.params?.required).not.toContain('timeout_seconds')
    })

    test('has optional what_to_summarize parameter', () => {
      const schema = commander.inputSchema
      const summarizeProp = schema?.params?.properties?.what_to_summarize
      expect(
        summarizeProp &&
          typeof summarizeProp === 'object' &&
          'type' in summarizeProp &&
          summarizeProp.type,
      ).toBe('string')
      expect(schema?.params?.required).not.toContain('what_to_summarize')
    })

    test('has optional full log capture parameters', () => {
      const schema = commander.inputSchema
      const saveFullLogProp = schema?.params?.properties?.save_full_log
      const failurePatternProp = schema?.params?.properties?.failure_pattern
      const maxFailureLinesProp = schema?.params?.properties?.max_failure_lines

      expect(
        saveFullLogProp &&
          typeof saveFullLogProp === 'object' &&
          'type' in saveFullLogProp &&
          saveFullLogProp.type,
      ).toBe('boolean')
      expect(
        failurePatternProp &&
          typeof failurePatternProp === 'object' &&
          'type' in failurePatternProp &&
          failurePatternProp.type,
      ).toBe('string')
      expect(
        maxFailureLinesProp &&
          typeof maxFailureLinesProp === 'object' &&
          'type' in maxFailureLinesProp &&
          maxFailureLinesProp.type,
      ).toBe('number')
      expect(schema?.params?.required).not.toContain('save_full_log')
      expect(schema?.params?.required).not.toContain('failure_pattern')
      expect(schema?.params?.required).not.toContain('max_failure_lines')
    })
  })

  describe('handleSteps', () => {
    test('returns error when no command provided', () => {
      const mockAgentState = createMockAgentState()
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = commander.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {},
      })

      const result = generator.next()

      const toolCall = result.value as {
        toolName: string
        input: { data: { errorMessage: string } }
      }
      expect(toolCall.toolName).toBe('set_output')
      expect(toolCall.input.data.errorMessage).toContain('command')
    })

    test('yields run_terminal_command with basic command', () => {
      const mockAgentState = createMockAgentState()
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = commander.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: { command: 'ls -la' },
      })

      const result = generator.next()

      // No default timeout: agent tasks can take arbitrarily long. An
      // omitted timeout_seconds passes -1 (no timeout) to the underlying
      // run_terminal_command tool.
      expect(result.value).toEqual({
        toolName: 'run_terminal_command',
        input: {
          command: 'ls -la',
          timeout_seconds: -1,
        },
      })
    })

    test('yields run_terminal_command with timeout', () => {
      const mockAgentState = createMockAgentState()
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = commander.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: { command: 'sleep 10', timeout_seconds: 60 },
      })

      const result = generator.next()

      expect(result.value).toEqual({
        toolName: 'run_terminal_command',
        input: {
          command: 'sleep 10',
          timeout_seconds: 60,
        },
      })
    })

    test('defaults to no timeout and keeps explicit callers winning', () => {
      const mockAgentState = createMockAgentState()
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const defaulted = commander.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: { command: 'sleep 10' },
      })
      expect(defaulted.next().value).toEqual({
        toolName: 'run_terminal_command',
        input: { command: 'sleep 10', timeout_seconds: -1 },
      })

      // An explicitly passed timeout — including -1 (no timeout) — always
      // wins over the documented default.
      const explicit = commander.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: { command: 'sleep 10', timeout_seconds: -1 },
      })
      expect(explicit.next().value).toEqual({
        toolName: 'run_terminal_command',
        input: { command: 'sleep 10', timeout_seconds: -1 },
      })
    })

    test('clamps max_failure_lines when save_full_log is requested', () => {
      const mockAgentState = createMockAgentState()
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const firstCommandFor = (max_failure_lines?: number): string => {
        const generator = commander.handleSteps!({
          agentState: createMockAgentState(),
          logger: mockLogger as any,
          params: {
            command: 'bun test',
            what_to_summarize: 'test failures',
            save_full_log: true,
            ...(max_failure_lines !== undefined ? { max_failure_lines } : {}),
          },
        })
        const first = generator.next().value as {
          toolName: string
          input: { command: string }
        }
        return first.input.command
      }

      // M3-T1: NaN/non-finite and negative values are rejected in favor of
      // the documented default, and a runaway value is capped. The
      // failure extract is a dual-window awk head+tail whose total line
      // count is still exactly failureLineLimit (72 head + 48 tail for 120;
      // a 1-line cap degenerates to a tail-only window; fixed floor(60%)
      // head split keeps the shape deterministic).
      expect(firstCommandFor(Number.NaN)).toContain("awk 'NR<=72'")
      expect(firstCommandFor(Number.NaN)).toContain('| tail -48')
      expect(firstCommandFor(-5)).toContain("awk 'NR<=0'")
      expect(firstCommandFor(-5)).toContain('| tail -1')
      expect(firstCommandFor(5)).toContain("awk 'NR<=3'")
      expect(firstCommandFor(5)).toContain('| tail -2')
      expect(firstCommandFor(1_000_000)).toContain("awk 'NR<=600'")
      expect(firstCommandFor(1_000_000)).toContain('| tail -400')
    })

    test('yields set_output with raw result when what_to_summarize is not provided', () => {
      const mockAgentState = createMockAgentState()
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = commander.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: { command: 'echo hello' },
      })

      // First yield is the command
      generator.next()

      // Second yield should be set_output with the result
      const mockToolResult = {
        agentState: createMockAgentState(),
        toolResult: [{ type: 'json' as const, value: { stdout: 'hello' } }],
        stepsComplete: true,
      }
      const result = generator.next(mockToolResult)

      const toolCall = result.value as {
        toolName: string
        input: { data: { stdout: string } }
        includeToolCall?: boolean
      }
      expect(toolCall.toolName).toBe('set_output')
      expect(toolCall.input.data).toEqual({ stdout: 'hello' })
      expect(toolCall.includeToolCall).toBe(false)
      expect(result.done).toBe(false)

      // Next should be done
      const final = generator.next()
      expect(final.done).toBe(true)
    })

    test('returns deterministic command report when what_to_summarize is provided', () => {
      const mockAgentState = createMockAgentState()
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = commander.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: { command: 'ls -la', what_to_summarize: 'list of files' },
      })

      // First yield is the command, excluded from model history because this is
      // a programmatic tool call rather than a provider-generated one.
      expect(generator.next().value).toEqual({
        toolName: 'run_terminal_command',
        input: {
          command: 'ls -la',
          timeout_seconds: -1,
        },
        includeToolCall: false,
      })

      // Second yield should add a plain-text summary prompt for model analysis.
      const mockToolResult = {
        agentState: createMockAgentState(),
        toolResult: [
          {
            type: 'json' as const,
            value: { stdout: 'file1.txt\nfile2.txt', exitCode: 0 },
          },
        ],
        stepsComplete: true,
      }
      const result = generator.next(mockToolResult)

      const toolCall = result.value as {
        toolName: string
        input: { data: { message: string } }
        includeToolCall?: boolean
      }
      expect(toolCall.toolName).toBe('set_output')
      expect(toolCall.input.data.message).toContain('Command: ls -la')
      expect(toolCall.input.data.message).toContain(
        'Requested summary: list of files',
      )
      expect(toolCall.input.data.message).toContain('Exit code: 0')
      expect(toolCall.input.data.message).toContain('file1.txt\nfile2.txt')
      expect(toolCall.includeToolCall).toBe(false)

      // No provider STEP is needed just to summarize command output.
      expect(generator.next().done).toBe(true)
    })

    test('wraps sync commands when full log capture is requested', () => {
      const mockAgentState = createMockAgentState()
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = commander.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {
          command: "bun test 'quoted file.test.ts'",
          what_to_summarize: 'test failures',
          save_full_log: true,
          failure_pattern: 'FAIL|Expected',
          max_failure_lines: 7,
        },
      })

      const firstYield = generator.next().value as {
        toolName: string
        input: { command: string }
        includeToolCall?: boolean
      }
      expect(firstYield.toolName).toBe('run_terminal_command')
      expect(firstYield.includeToolCall).toBe(false)
      expect(firstYield.input.command).toContain('set -o pipefail')
      expect(firstYield.input.command).toContain(
        "(bun test 'quoted file.test.ts') 2>&1 | tee '/tmp/openbuff-basher-",
      )
      expect(firstYield.input.command).toContain("grep -n -E 'FAIL|Expected'")
      // Dual-window extract: 7-line cap split into a 4-line head window plus
      // a 3-line tail window.
      expect(firstYield.input.command).toContain("awk 'NR<=4'")
      expect(firstYield.input.command).toContain('| tail -3')
      expect(firstYield.input.command).toContain('exit "$status"')
      // Log is always kept on disk even without retain_full_log, with a
      // one-line size notice printed before the extract.
      expect(firstYield.input.command).toContain('(retained, ~$(')
      // Bounded-retention sweep (basher-log-retention-unbounded): the wrap
      // sweeps OLDEST full logs beyond the retention cap BEFORE its own tee
      // creates this run's log file, scoped to the fixed basher log prefix
      // and best-effort (rm failures can never fail the command). No
      // unconditional full-log deletion remains.
      expect(firstYield.input.command).toContain(
        "tail -n +21",
      )
      const sweepLine = firstYield.input.command
        .split('\n')
        .find((line) => line.includes('older_full_logs'))
      expect(sweepLine).toBeDefined()
      expect(sweepLine).toContain("ls -1t /tmp/openbuff-basher-*.log 2>/dev/null")
      expect(sweepLine).toContain('rm -f -- "$f"')
      expect(sweepLine).toContain('|| true')

      const result = generator.next({
        agentState: createMockAgentState(),
        toolResult: [
          {
            type: 'json' as const,
            value: {
              stdout:
                'full_log_path=/tmp/openbuff-basher-test.log\nexit_status=1\n10:Expected 1 received 2',
              exitCode: 1,
            },
          },
        ],
        stepsComplete: true,
      })

      const toolCall = result.value as {
        toolName: string
        input: { data: { message: string } }
      }
      expect(toolCall.toolName).toBe('set_output')
      expect(toolCall.input.data.message).toContain('Command: bun test')
      expect(toolCall.input.data.message).toContain(
        'Full log kept on disk: /tmp/openbuff-basher-',
      )
      expect(toolCall.input.data.message).toContain('10:Expected 1 received 2')
      // A caller-supplied failure_pattern suppresses the inline raw slice.
      expect(
        (toolCall.input.data as { rawOutputInline?: string[] }).rawOutputInline,
      ).toBeUndefined()
    })

    test('includes inline head+tail raw output when no failure_pattern is given', () => {
      const mockAgentState = createMockAgentState()
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = commander.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {
          command: 'bun test',
          what_to_summarize: 'test failures',
          save_full_log: true,
        },
      })

      const firstYield = generator.next().value as {
        toolName: string
        input: { command: string }
      }
      // Failure extract still runs against the default failure pattern.
      expect(firstYield.input.command).toContain('grep -n -E')

      const lines = Array.from({ length: 200 }, (_, i) => `line-${i}`)
      const result = generator.next({
        agentState: createMockAgentState(),
        toolResult: [
          {
            type: 'json' as const,
            value: { stdout: lines.join('\n'), exitCode: 0 },
          },
        ],
        stepsComplete: true,
      })

      const toolCall = result.value as {
        toolName: string
        input: {
          data: {
            message: string
            rawOutputInline: string[]
            fullLogPath?: string
            fullLogRetained?: boolean
          }
        }
      }
      expect(toolCall.toolName).toBe('set_output')
      // Inline window: first 48 lines + one truncation marker + last 32
      // lines (80-line total cap with fixed 60/40 proportions).
      expect(toolCall.input.data.rawOutputInline).toEqual(
        expect.arrayContaining(['line-0', 'line-47', 'line-168', 'line-199']),
      )
      expect(toolCall.input.data.rawOutputInline).toHaveLength(81)
      expect(toolCall.input.data.rawOutputInline).toContain(
        '[... 120 line(s) truncated ...]',
      )
      expect(toolCall.input.data.message).toContain('Inline raw output')
      expect(toolCall.input.data.message).toContain('line-199')
      // The full log is always kept on disk, even without retain_full_log.
      expect(toolCall.input.data.fullLogRetained).toBe(true)
      expect(toolCall.input.data.fullLogPath).toMatch(/^\/tmp\/openbuff-basher-/)
    })

    test('includes background job fields in deterministic report', () => {
      const mockAgentState = createMockAgentState()
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = commander.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: {
          command: 'bun dev',
          process_type: 'BACKGROUND',
          what_to_summarize: 'dev server startup',
        },
      })

      expect(generator.next().value).toEqual({
        toolName: 'run_terminal_command',
        input: {
          command: 'bun dev',
          process_type: 'BACKGROUND',
          timeout_seconds: -1,
        },
        includeToolCall: false,
      })

      const result = generator.next({
        agentState: createMockAgentState(),
        toolResult: [
          {
            type: 'json' as const,
            value: {
              command: 'bun dev',
              processId: 123,
              backgroundProcessStatus: 'running',
              jobId: 'job-1-1',
              logFile: '/tmp/openbuff-job-1-1.log',
            },
          },
        ],
        stepsComplete: true,
      })

      const toolCall = result.value as {
        toolName: string
        input: { data: { message: string } }
      }
      expect(toolCall.toolName).toBe('set_output')
      expect(toolCall.input.data.message).toContain('Job ID: job-1-1')
      expect(toolCall.input.data.message).toContain(
        'Background status: running',
      )
      expect(toolCall.input.data.message).toContain(
        'Log file: /tmp/openbuff-job-1-1.log',
      )
    })

    test('handles empty tool result gracefully', () => {
      const mockAgentState = createMockAgentState()
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = commander.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: { command: 'echo test' },
      })

      // First yield is the command
      generator.next()

      // Second yield with empty result
      const result = generator.next({
        agentState: createMockAgentState(),
        toolResult: [] as ToolResultOutput[],
        stepsComplete: true,
      })

      const toolCall = result.value as {
        toolName: string
        input: { data: { message: string } }
      }
      expect(toolCall.toolName).toBe('set_output')
      expect(toolCall.input.data.message).toBe('')
    })

    test('handles non-json tool result', () => {
      const mockAgentState = createMockAgentState()
      const mockLogger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      }

      const generator = commander.handleSteps!({
        agentState: mockAgentState,
        logger: mockLogger as any,
        params: { command: 'echo test' },
      })

      // First yield is the command
      generator.next()

      // Second yield with non-json result
      const mockToolResult = {
        agentState: createMockAgentState(),
        toolResult: [{ type: 'json' as const, value: 'plain text output' }],
        stepsComplete: true,
      }
      const result = generator.next(mockToolResult)

      const toolCall = result.value as {
        toolName: string
        input: { data: { message: string } }
      }
      expect(toolCall.toolName).toBe('set_output')
      expect(toolCall.input.data.message).toBe('plain text output')
    })

    test('handleSteps can be serialized for sandbox execution', () => {
      const handleStepsString = commander.handleSteps!.toString()

      // Verify it's a valid generator function string
      expect(handleStepsString).toMatch(/^function\*\s*\(/)

      // Should be able to create a new function from it
      const isolatedFunction = new Function(`return (${handleStepsString})`)()
      expect(typeof isolatedFunction).toBe('function')
    })
  })

  describe('system prompt', () => {
    test('contains command analysis instructions', () => {
      expect(commander.systemPrompt).toContain('terminal command')
      expect(commander.systemPrompt).toContain('output')
    })

    test('contains concise description requirement', () => {
      expect(commander.systemPrompt).toContain('concise')
    })
  })

  describe('instructions prompt', () => {
    test('instructs not to use tools', () => {
      expect(commander.instructionsPrompt).toContain('Do not use any tools')
    })

    test('mentions analyzing command output', () => {
      expect(commander.instructionsPrompt).toContain('command')
      expect(commander.instructionsPrompt).toContain('output')
    })
  })
})
