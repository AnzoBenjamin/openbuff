#!/usr/bin/env bun

/**
 * Check the status of optional local development services.
 *
 * Usage:
 *   bun status-services    # Check if services are running
 *
 * Bun automatically loads .env.local and .env.development.local,
 * so environment variables are available without manual sourcing.
 *
 * The tracked-service identity (TRACKED_SERVICE_ARGV, command matching, and
 * the PID-ownership check) is imported from start-services.ts — the single
 * source of what is spawned and what counts as ours — so a change to the
 * spawned argv can never leave this script reporting false PID-reuse
 * warnings for a legitimately tracked build.
 */

import {
  isProcessRunning,
  isTrackedServiceProcess,
  loadPids,
  ok,
} from './start-services'

function warn(name: string, message: string): void {
  console.log(`  \x1b[33m?\x1b[0m ${name.padEnd(10)} ${message}`)
}

async function main(): Promise<void> {
  console.log('')
  console.log('Optional Service Status:')
  console.log('')

  const pids = loadPids()
  let anyRunning = false

  // Check SDK build (if tracked)
  if (pids?.sdk) {
    if (!isProcessRunning(pids.sdk)) {
      // SDK build completes and exits, so this is expected
      ok('sdk', 'build completed')
    } else if (!isTrackedServiceProcess(pids.sdk, pids.sdkStartTime)) {
      // The PID is live but its ownership record cannot be verified: the
      // short-lived build exited and its PID was recycled — possibly by a
      // process running the identical tracked argv, which only the persisted
      // start time can distinguish — the start time no longer matches, or
      // the command line or start time is unreadable on this platform (or
      // the record was written by an older revision without a start time).
      // Reporting it as 'running' would be a lie.
      warn(
        'sdk',
        `PID ${pids.sdk} could not be verified as the SDK build (possible PID reuse)`,
      )
    } else {
      ok('sdk', `running (PID ${pids.sdk})`)
      anyRunning = true
    }
  } else {
    warn('sdk', 'not tracked')
  }

  console.log('')

  if (anyRunning) {
    console.log('  To stop optional services: bun down')
  } else {
    console.log('  The CLI needs no background services for BYOK local development.')
    console.log('  To rebuild the SDK: bun up')
  }

  console.log('')
}

main().catch((error) => {
  console.error('Error checking status:', error)
  process.exit(1)
})
