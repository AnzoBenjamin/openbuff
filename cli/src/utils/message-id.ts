/**
 * P6.2: Collision-free message id generation.
 *
 * A millisecond timestamp alone collides whenever multiple messages are
 * created in the same millisecond (queue flushes, error + divider pairs),
 * which breaks the message tree keyed by id. A per-process monotonic counter
 * plus a random suffix keeps ids unique across calls without any new deps,
 * formatted like the existing `<prefix>-<token>` ids callers pin in tests.
 */
let counter = 0

export const generateMessageId = (prefix: string): string => {
  counter += 1
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 10)}`
}
