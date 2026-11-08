import { spawn as nodeSpawn } from 'node:child_process'
import {
  ReadBuffer,
  serializeMessage,
} from '@modelcontextprotocol/sdk/shared/stdio.js'

import type { ChildProcess } from 'node:child_process'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type {
  PreparedLaunch,
  Result,
} from '../types/contracts/execution-context'
import type { CodebuffSpawn } from '../types/spawn'

/** The callback is bound by the host to a registered resource and request lease. */
export type OwnedStdioTransportOptions = Readonly<{
  prepareLaunch: () => Result<PreparedLaunch>
  spawn?: CodebuffSpawn
}>

/**
 * Own the actual delayed spawn so the admitted environment is the complete
 * environment. The vendor transport merges ambient defaults at this boundary.
 * Closing requests termination; it does not certify process-tree death.
 */
export class OwnedStdioTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  private readonly buffer = new ReadBuffer()
  private child?: ChildProcess
  private started = false
  private closed = false
  private closeReported = false

  constructor(private readonly options: OwnedStdioTransportOptions) {}

  async start(): Promise<void> {
    if (this.started || this.closed)
      throw new Error('MCP stdio transport cannot be started again')
    this.started = true
    const prepared = this.options.prepareLaunch()
    if (!prepared.ok) throw launchError(prepared)
    const admission = await prepared.value.admit()
    if (!admission.ok) throw launchError(admission)
    // close() may run while an interactive admission is pending.
    if (this.closed)
      throw new Error('MCP stdio transport closed before dispatch')

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const fail = (error: Error) => {
        if (!settled) {
          settled = true
          // Observation failure may follow a successful OS launch. Request
          // termination without treating that request as exit evidence.
          try {
            this.child?.kill('SIGTERM')
          } catch {
            /* already exited */
          }
          reject(error)
        }
        this.onerror?.(error)
      }
      const dispatched = prepared.value.dispatchNow(
        admission.value.permit,
        (input, observer) => {
          const child = (this.options.spawn ?? nodeSpawn)(
            input.executable,
            input.argv,
            {
              cwd: input.cwd,
              env: input.env,
              signal: input.resourceSignal,
              shell: false,
              stdio: ['pipe', 'pipe', 'ignore'],
              windowsHide: input.adapterOptions.windowsHide === true,
            },
          )
          this.child = child
          child.once('spawn', () => {
            if (
              typeof child.pid !== 'number' ||
              !Number.isInteger(child.pid) ||
              child.pid <= 0
            ) {
              observer.failure({
                source: 'adapter-observation-error',
                cause: 'MCP child has no valid runtime PID',
              })
              fail(new Error('MCP child has no valid runtime PID'))
              return
            }
            const observed = observer.spawnObserved({
              source: 'node-spawn-event',
              pid: child.pid,
            })
            if (!observed.ok) {
              fail(launchError(observed))
              return
            }
            if (!settled) {
              settled = true
              resolve()
            }
          })
          child.on('error', (error: NodeJS.ErrnoException) => {
            observer.failure({
              source: 'node-error-event',
              errorCode: error.code,
              cause: error.message,
            })
            fail(error)
          })
          child.once('close', () => {
            if (!settled) {
              settled = true
              reject(new Error('MCP stdio child closed before observed start'))
            }
            this.closed = true
            this.child = undefined
            this.buffer.clear()
            this.reportClose()
          })
          child.stdout?.on('data', (chunk: Buffer) => {
            this.buffer.append(chunk)
            this.readMessages()
          })
          child.stdout?.on('error', (error) => this.onerror?.(error))
          child.stdin?.on('error', (error) => this.onerror?.(error))
          return child
        },
      )
      if (!dispatched.ok) fail(launchError(dispatched))
    })
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const input = this.child?.stdin
    if (this.closed || !input)
      throw new Error('MCP stdio transport is not connected')
    await new Promise<void>((resolve, reject) => {
      input.write(serializeMessage(message), (error) =>
        error ? reject(error) : resolve(),
      )
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.buffer.clear()
    // Retain the child reference until its actual close event. A request to
    // terminate is not an observation of exit or successful cleanup.
    this.child?.kill('SIGTERM')
    this.reportClose()
  }

  get pid(): number | null {
    return this.child?.pid ?? null
  }

  private reportClose(): void {
    if (this.closeReported) return
    this.closeReported = true
    this.onclose?.()
  }

  private readMessages(): void {
    while (!this.closed) {
      try {
        const message = this.buffer.readMessage()
        if (message === null) return
        this.onmessage?.(message)
      } catch (error) {
        this.onerror?.(
          error instanceof Error ? error : new Error(String(error)),
        )
      }
    }
  }
}

function launchError(result: { reason: string; cause: string }): Error {
  return Object.assign(new Error(result.cause), {
    name: 'ExecutionAdmissionError',
    executionRefusal: result,
  })
}
