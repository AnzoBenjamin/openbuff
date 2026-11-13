import { Worker } from 'node:worker_threads'
import { createPayloadSanitizers } from './payload-sanitizer'

// The sanitizer factory has no external dependencies. Embedding its compiled
// function in an eval worker also works in Bun's standalone executables,
// where a source-file URL cannot necessarily be opened by a worker. The
// portability suite in __tests__/persistence-codec.test.ts validates that
// claim at runtime: the worker source must resolve only node: builtins (no
// source-file URL required), the embedded sanitizer factory must close over
// no module scope, and the callers' synchronous fallback must produce
// identical output whenever a production runtime cannot start the worker.
export const persistenceWorkerSource = `
const { parentPort } = require('node:worker_threads');
const { sanitizeForChatPersistence } = (${createPayloadSanitizers.toString()})();
parentPort.on('message', ({ kind, value }) => {
  try {
    if (kind === 'parse') {
      parentPort.postMessage({ ok: true, value: sanitizeForChatPersistence(JSON.parse(value)) });
    } else {
      const runState = sanitizeForChatPersistence(value.runState);
      const messages = sanitizeForChatPersistence(value.messages);
      const main = runState?.sessionState?.mainAgentState;
      parentPort.postMessage({ ok: true, value: {
        runState: JSON.stringify(runState), messages: JSON.stringify(messages),
        archive: main ? { sessionState: { mainAgentState: { runId: main.runId, compactionArchive: main.compactionArchive } } } : null,
      } });
    }
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});`

// Bounded deadline for every codec call. Worker thread creation plus one
// parse/serialize round-trip takes milliseconds in practice; a worker stuck
// reading or parsing a pathological payload must never hold the awaiting
// restore/send paths (restorePromiseRef.current in useSendMessage, the
// initial chats load) pending indefinitely. Callers already fall back to the
// synchronous sanitize+JSON.parse path on rejection (parsePersistedAsync and
// saveChatState's catch).
const PERSISTENCE_CODEC_TIMEOUT_MS = 10_000

export function runPersistenceCodec<T>(
  kind: 'parse' | 'serialize',
  value: unknown,
  signal?: AbortSignal,
  // Explicit override exists for tests; production callers use the default.
  timeoutMs: number = PERSISTENCE_CODEC_TIMEOUT_MS,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('Aborted'))
    let worker: Worker
    try {
      worker = new Worker(persistenceWorkerSource, { eval: true })
    } catch (error) {
      reject(error)
      return
    }
    let settled = false
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    // Every exit path (abort, worker error, exit, message, timeout, or a
    // postMessage throw) funnels through finish, so the worker never outlives
    // the call and the caller's promise always settles.
    const finish = (action: () => void) => {
      if (settled) return
      settled = true
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
      signal?.removeEventListener('abort', abort)
      void worker.terminate()
      action()
    }
    // Race the worker with a bounded deadline: on expiry the stuck worker is
    // terminated and the promise rejects, unblocking the awaiting restore/send
    // flow instead of staying pending for as long as the worker lives.
    timeoutTimer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `Persistence worker did not respond within ${timeoutMs}ms; terminated`,
          ),
        ),
      )
    }, timeoutMs)
    const abort = () =>
      finish(() => reject(signal?.reason ?? new Error('Aborted')))
    signal?.addEventListener('abort', abort, { once: true })
    worker.once('error', (error) => finish(() => reject(error)))
    worker.once('exit', (code) =>
      finish(() => reject(new Error(`Persistence worker exited (${code})`))),
    )
    worker.once(
      'message',
      (result: { ok: boolean; value?: T; error?: string }) => {
        finish(() =>
          result.ok
            ? resolve(result.value as T)
            : reject(new Error(result.error ?? 'Persistence worker failed')),
        )
      },
    )
    try {
      worker.postMessage({ kind, value })
    } catch (error) {
      finish(() => reject(error))
    }
  })
}
