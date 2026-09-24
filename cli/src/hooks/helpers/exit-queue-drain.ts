/**
 * The exit-path queued-prompt drain, extracted from chat.tsx so its
 * partial-failure semantics are testable without mounting the Chat host.
 *
 * chat.tsx registers the returned drainer with setQueuedPromptDrain
 * (use-exit-handler) so prompts queued during an active stream are persisted
 * to session history when the user exits through Ctrl-C/SIGINT before the
 * queue could ever drain (reliability finding
 * exit-handler-drops-queued-prompts); the /exit command runs the same drain
 * inline.
 */
import { formatQueuedMessageForHistory } from './send-message'

import type { QueuedMessage } from '../use-message-queue'

export type QueuedPromptDrainDeps = {
  /** Snapshot the current conversation for /undo before anything is drained. */
  pushMessageSnapshot: () => void
  /** Removes up to `count` prompts from the front of the queue; returns them. */
  clearQueue: (count: number) => QueuedMessage[]
  /** Persists one prompt into the session history. */
  saveToHistory: (prompt: string) => void
}

export type QueuedPromptDrainer = () => void

export const createQueuedPromptDrainer = (
  deps: QueuedPromptDrainDeps,
): QueuedPromptDrainer => {
  const { pushMessageSnapshot, clearQueue, saveToHistory } = deps
  return () => {
    pushMessageSnapshot()
    // Drain one entry at a time (reliability finding
    // exit-drain-partial-failure-drops-queue): a single all-at-once
    // clearQueue() before the persistence loop would drop every prompt if
    // persistence never ran. A persist failure skips only its own entry and
    // the drain continues (reliability finding
    // exit-drain-stops-on-first-persist-failure): re-queuing at exit is
    // unobservable because the in-memory queue cannot survive
    // process.exit(0), so stopping would lose the failed prompt AND every
    // remaining queued prompt.
    for (;;) {
      const [queued] = clearQueue(1)
      if (!queued) break
      try {
        // Persist the attachments folded into the prompt text: dropping
        // them here loses queued context across the restart (reliability
        // finding exit-drain-drops-queued-attachments).
        saveToHistory(formatQueuedMessageForHistory(queued))
      } catch {
        // Skip the failed entry; keep draining the remaining prompts.
      }
    }
  }
}
