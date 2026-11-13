import { describe, expect, test } from 'bun:test'
import {
  persistenceWorkerSource,
  runPersistenceCodec,
} from '../persistence-codec'
import {
  createPayloadSanitizers,
  sanitizeForChatPersistence,
} from '../payload-sanitizer'

describe('persistence worker codec', () => {
  test('parses and sanitizes large chat data identically to the synchronous path', async () => {
    const value = {
      content: 'chat '.repeat(20_000),
      accessToken: 'secret',
      nested: { tokenCount: 4 },
    }
    expect(
      await runPersistenceCodec<typeof value>('parse', JSON.stringify(value)),
    ).toEqual(sanitizeForChatPersistence(value))
  })

  test('serializes independently captured messages and redacts archive data', async () => {
    const input = {
      runState: {
        sessionState: {
          mainAgentState: {
            runId: 'one',
            compactionArchive: [{ accessToken: 'secret' }],
          },
        },
      },
      messages: [{ id: 'one', content: 'hello' }],
    }
    const result = await runPersistenceCodec<{
      runState: string
      messages: string
      archive: unknown
    }>('serialize', input)
    expect(JSON.parse(result.runState)).toEqual(
      sanitizeForChatPersistence(input.runState),
    )
    expect(JSON.parse(result.messages)).toEqual(input.messages)
    expect(JSON.stringify(result.archive)).not.toContain('secret')
  })

  test('propagates cancellation and invalid JSON', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      runPersistenceCodec('parse', '{}', controller.signal),
    ).rejects.toThrow()
    await expect(runPersistenceCodec('parse', '{')).rejects.toThrow()
  })

  test('terminates and rejects at the bounded deadline instead of staying pending', async () => {
    // A 1ms deadline fires before worker thread creation (never sub-millisecond)
    // even with an instant handler, so the promise must settle via the timeout
    // path — rejection with the deadline message — rather than resolving.
    // Without the deadline ratchet, a worker stuck reading or parsing a
    // pathological payload would keep the awaiting restore/send flow pending
    // for as long as the worker lived.
    await expect(
      runPersistenceCodec('parse', '{}', undefined, 1),
    ).rejects.toThrow('Persistence worker did not respond within 1ms')
  })

  test('unaffected calls settle normally under the default deadline', async () => {
    // Guard against the deadline regression ever breaking the healthy path:
    // a well-formed parse still resolves (production's large-payload restore
    // path awaits this and falls back to sync parsing only on rejection).
    const value = { content: 'x'.repeat(100_000), accessToken: 'secret' }
    expect(
      await runPersistenceCodec<typeof value>(
        'parse',
        JSON.stringify(value),
      ),
    ).toEqual(sanitizeForChatPersistence(value))
  })
})

describe('production runtime portability (Bun standalone eval-worker support)', () => {
  // Runtime evidence for the claim in persistence-codec.ts: the eval-worker
  // source must be fully self-contained so it runs even where a worker cannot
  // be launched by source-file URL (Bun standalone executables), and the
  // workers in the suite above actually launch in the Bun runtime these tests
  // run under.

  test('the embedded worker script resolves only node: builtins', () => {
    // No ESM imports and no file-relative module resolution may appear in the
    // worker source: a standalone executable cannot necessarily open a
    // source-file URL, so any such reference would make the worker exit
    // before answering, and callers would permanently fall back to
    // synchronous parsing instead of the off-thread path.
    expect(persistenceWorkerSource.includes('import ')).toBe(false)
    expect(persistenceWorkerSource.includes('import(')).toBe(false)
    const moduleSpecifiers = [
      ...persistenceWorkerSource.matchAll(/require\('([^']*)'\)/g),
    ].map((match) => match[1])
    expect(moduleSpecifiers).toContain('node:worker_threads')
    for (const specifier of moduleSpecifiers) {
      expect(specifier.startsWith('node:')).toBe(true)
    }
  })

  test('the embedded sanitizer factory closes over no module scope', () => {
    // The worker rebuilds the sanitizer purely from source text —
    // (${createPayloadSanitizers.toString()})(). If the factory ever
    // referenced a module-scope import, evaluation inside the worker would
    // throw a ReferenceError on every codec call. Rebuild it here in a fresh
    // Function scope — the same evaluation form the worker uses — and pin
    // that it runs and sanitizes identically to the module-scope instance.
    const reborn = new Function(
      `return (${createPayloadSanitizers.toString()})();`,
    )() as ReturnType<typeof createPayloadSanitizers>
    // The immediate invocation returns the sanitizers object (exactly what the
    // worker receives), so call its method directly.
    const value = { accessToken: 'secret', nested: { tokenCount: 3 } }
    expect(reborn.sanitizeForChatPersistence(value)).toEqual(
      sanitizeForChatPersistence(value),
    )
  })

  test('the synchronous caller fallback parses identically to the worker', async () => {
    // parsePersistedAsync falls back to sanitize + JSON.parse on the main
    // thread whenever the worker cannot start in the host runtime, and
    // saveChatState does the same for serialization. Persisted and restored
    // chat state must therefore be identical whether or not the production
    // runtime supports eval workers.
    const text = JSON.stringify({
      version: 1,
      runState: {
        output: { type: 'error', message: 'resume' },
        accessToken: 'secret',
      },
      messages: [
        { id: 'm', variant: 'user', timestamp: '', content: 'hello' },
      ],
    })
    const parsed = await runPersistenceCodec<unknown>('parse', text)
    expect(sanitizeForChatPersistence(JSON.parse(text))).toEqual(parsed)
  })
})
