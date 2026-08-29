/**
 * Shared fixtures for the gate-telemetry sink tests in `common` and in
 * `packages/agent-runtime`.
 *
 * Both suites drive the SAME sink (`appendGateTelemetryEvent`) from different
 * packages, so the temp-root/sink-read helpers and — more importantly — the
 * platform SKIP POLICY live here: a skip rule that drifts between the two
 * suites silently stops covering one of them.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'

import { GATE_TELEMETRY_RELATIVE } from '../util/gate-telemetry'

/**
 * Creating a symlink needs elevated privilege on Windows, so every symlink case
 * skips there — the same platform policy the POSIX-mode and EACCES cases use.
 */
export const SKIP_SYMLINK_CASES = process.platform === 'win32'

/**
 * Windows honors neither POSIX modes nor the sink's mode repair, so every
 * mode assertion skips there. Owned here for the same reason as the symlink
 * policy above: a mode skip that drifts silently stops covering one suite.
 */
export const SKIP_POSIX_MODE_CASES = process.platform === 'win32'

/**
 * Cases that need a mode to actually DENY access also skip as root, which
 * ignores a missing execute bit entirely and so never produces the EACCES they
 * depend on.
 */
export const SKIP_EACCES_CASES =
  SKIP_POSIX_MODE_CASES || process.getuid?.() === 0

/** Fresh temp directory standing in for one run's project root. */
export function makeGateTelemetryProjectRoot(
  prefix = 'gate-telemetry-test-',
): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** Raw sink contents, for assertions on the exact serialized bytes. */
export function readGateTelemetrySinkRaw(projectRoot: string): string {
  return fs.readFileSync(
    path.join(projectRoot, GATE_TELEMETRY_RELATIVE),
    'utf8',
  )
}

/** Non-empty JSONL lines currently in the sink under `projectRoot`. */
export function readGateTelemetrySinkLines(projectRoot: string): string[] {
  return readGateTelemetrySinkRaw(projectRoot).split('\n').filter(Boolean)
}
