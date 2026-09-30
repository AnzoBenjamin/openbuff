#!/usr/bin/env bun

/**
 * Stop development services started by start-services.ts
 *
 * Bun automatically loads .env.local and .env.development.local,
 * so environment variables are available without manual sourcing.
 *
 * The tracked-service identity (TRACKED_SERVICE_ARGV, command matching, and
 * the PID-ownership check) and the terminate logic are imported from
 * start-services.ts — the single source of what is spawned and what counts
 * as ours — so a change to the spawned argv can never leave this script
 * silently failing to reap the tracked build.
 *
 * The whole PID-file lifecycle (read → terminate → unlink) runs under the
 * same exclusive lock start-services.ts holds across its read → terminate →
 * spawn → save sequence, so a concurrent stop can never unlink a start's
 * freshly saved ownership record (which would leave the newly spawned build
 * untracked and unreapable), and a concurrent start can never overwrite the
 * record this stop is reaping.
 */

import { unlinkSync } from 'fs'

import {
  PID_FILE,
  acquireStartLock,
  isProcessRunning,
  isTrackedServiceProcess,
  loadPids,
  releaseStartLock,
  terminateProcess,
} from './start-services'

async function main(): Promise<void> {
  if (!acquireStartLock()) {
    // A concurrent `bun up` holds the start lock: its own terminate phase
    // reaps any previously tracked build, and its freshly spawned build is
    // saved to services.json under this same lock. Skipping here keeps the
    // PID-file lifecycle serialized instead of racing it.
    console.log('Another "bun up" is starting services; run `bun down` again after it finishes.')
    return
  }
  try {
    const pids = loadPids()
    let stopped = false
    let keepPidFile = false

    // Kill tracked processes
    if (pids) {
      if (pids.sdk) {
        if (!isProcessRunning(pids.sdk)) {
          // Stale record: the tracked SDK build already exited (expected — the
          // build is short-lived) or vanished. Nothing to signal.
        } else if (!isTrackedServiceProcess(pids.sdk, pids.sdkStartTime)) {
          // PID reuse or an unverifiable ownership record: the PID now belongs
          // to an unrelated process, or the persisted start time is missing
          // (records written by an older revision) or no longer matches — a
          // recycled PID running the identical tracked argv is indistinguishable
          // from the original build by command line alone. It must never be
          // signalled; the ownership record is stale and safe to drop.
        } else {
          const outcome = await terminateProcess(pids.sdk, pids.sdkStartTime)
          if (outcome === 'survived') {
            // SIGKILL was delivered but the process survived its liveness
            // window: keep services.json so the surviving tracked process still
            // has an ownership record a later stop can reap, instead of
            // orphaning it and reporting 'No services were running'.
            keepPidFile = true
          } else {
            // 'terminated' (exit confirmed) and 'recycled' (the tracked build
            // confirmed gone, its PID since reused by a foreign process) are
            // both terminal gone outcomes: the record is stale and is dropped
            // here. Keeping it for 'recycled' would preserve an ownership
            // record that points at a foreign PID and tell the operator the
            // build 'survived termination' for a process that is already gone.
            stopped = true
          }
        }
      }

      if (!keepPidFile) {
        // Clean up PID file
        try {
          unlinkSync(PID_FILE)
        } catch {
          // Ignore
        }
      }
    }

    if (stopped) {
      console.log('✓ Optional services stopped')
    } else if (keepPidFile) {
      console.log(
        `✗ SDK build (PID ${pids?.sdk}) survived termination; keeping ${PID_FILE} — run \`bun down\` again to stop it.`,
      )
    } else {
      console.log('No services were running')
    }
  } finally {
    releaseStartLock()
  }
}

main().catch((error) => {
  console.error('Error stopping services:', error)
  process.exit(1)
})
