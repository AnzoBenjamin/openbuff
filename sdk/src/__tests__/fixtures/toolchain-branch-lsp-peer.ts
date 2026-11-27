import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { ChildProcess, SpawnOptions } from 'node:child_process'

let nextPid = 50_000

/** Protocol/Node-boundary DI peer. Its positive PID is explicitly synthetic. */
export function createLspBoundaryPeer(command: string, argv: readonly string[], options: SpawnOptions,
  behavior: { holdInitialize?: boolean } = {}) {
  const child = new EventEmitter() as ChildProcess
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const methods: string[] = []
  const messages: Array<{ method: string; params?: { position?: { character: number } } }> = []
  const held: Array<() => void> = []
  let pending = ''
  let closed = false
  let signalListener: (() => void) | undefined
  const finish = (code: number, signal: NodeJS.Signals | null) => {
    if (closed) return
    closed = true
    if (signalListener) options.signal?.removeEventListener('abort', signalListener)
    Object.assign(child, { exitCode: code, signalCode: signal })
    child.emit('exit', code, signal)
    child.emit('close', code, signal)
  }
  const stdin = new Writable({ write(chunk, _encoding, done) {
    pending += chunk.toString()
    for (;;) {
      const end = pending.indexOf('\r\n\r\n')
      if (end < 0) break
      const length = Number(/Content-Length: (\d+)/i.exec(pending.slice(0, end))?.[1])
      if (pending.length < end + 4 + length) break
      const request = JSON.parse(pending.slice(end + 4, end + 4 + length))
      pending = pending.slice(end + 4 + length)
      methods.push(request.method)
      messages.push(request)
      if (request.id !== undefined) {
        const body = JSON.stringify({ jsonrpc: '2.0', id: request.id,
          result: request.method === 'initialize' ? { capabilities: {} } : request.method === 'shutdown' ? null
            : request.method === 'textDocument/hover' ? { contents: 'fixture hover' } : [] })
        const respond = () => { if (!closed) stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`) }
        if (request.method === 'initialize' && behavior.holdInitialize) held.push(respond)
        else queueMicrotask(respond)
      } else if (request.method === 'exit') queueMicrotask(() => finish(0, null))
    }
    done()
  } })
  Object.assign(child, { pid: ++nextPid, stdin, stdout, stderr, stdio: [stdin, stdout, stderr], exitCode: null, signalCode: null,
    kill: (signal: NodeJS.Signals = 'SIGTERM') => { finish(0, signal); return true } })
  signalListener = () => { child.kill('SIGTERM') }
  options.signal?.addEventListener('abort', signalListener, { once: true })
  queueMicrotask(() => child.emit('spawn'))
  return { child, methods, messages, crash: () => finish(1, null), get closed() { return closed },
    releaseInitialize() { for (const respond of held.splice(0)) respond() },
    get resourceSignalAborted() { return options.signal?.aborted ?? null },
    capture: { evidenceKind: 'injected-node-boundary-and-protocol-peer', syntheticPid: child.pid, command, argv: [...argv],
      cwd: options.cwd, env: { ...options.env }, resourceSignalInitiallyAborted: options.signal?.aborted ?? null,
      stdio: options.stdio } }
}
