/**
 * Helpers for resolving and reading durable plan-session artifacts
 * stored under `.agents/sessions/<slug>/` in the project root.
 */
import fs from 'fs'
import path from 'path'

import {
  ACTIVE_SESSION_POINTER_FILENAME,
  PLAN_ARTIFACT_NAMES,
  TRI_STATE_CHECKBOX_LINE_RE,
  isValidPlanSlug,
  normalizePlanState,
  readCurrentTaskAnnotation,
  preflightPlan,
  type PlanPreflightResult,
  type PlanArtifactName,
  type PlanSessionStatus,
  type PlanSessionState,
} from '@codebuff/common/util/plan-artifacts'

import { getProjectRoot } from '../project-files'
import { assertPlanCaptureStable, isMissingPlanArtifact, openPlanDirectory, openPlanFile, openPlanFileAsync, planDirectoryPath } from './plan-artifact-io'

export { PLAN_ARTIFACT_NAMES }

/**
 * Max bytes read per plan artifact when assembling the prompt. Keeps prompts
 * bounded even when users accidentally write huge SPEC.md/LESSONS.md files.
 */
export const MAX_ARTIFACT_BYTES = 64 * 1024

type ArtifactCapture = {
  text: string
  bytesRead: number
  totalBytes: number
  truncated: boolean
}

/** Read a prefix without allocating the whole file. UTF-8 decoding drops an incomplete final code point. */
function decodeArtifactPrefix(
  buffer: Buffer,
  bytesRead: number,
  totalBytes: number,
): ArtifactCapture {
  const truncated = bytesRead < totalBytes
  const decoder = new TextDecoder('utf-8')
  const text = decoder.decode(buffer.subarray(0, bytesRead), {
    stream: truncated,
  })
  return { text, bytesRead, totalBytes, truncated }
}

export function readBoundedArtifactSync(filePath: string): ArtifactCapture {
  const file = openPlanFile(getProjectRoot(), filePath)
  try {
    const totalBytes = file.stat.size
    const buffer = Buffer.alloc(Math.min(totalBytes, MAX_ARTIFACT_BYTES))
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const count = fs.readSync(file.fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (!count) break
      bytesRead += count
    }
    assertPlanCaptureStable(file.stat, fs.fstatSync(file.fd))
    return decodeArtifactPrefix(buffer, bytesRead, totalBytes)
  } finally { file.close() }
}

export async function readBoundedArtifact(filePath: string): Promise<ArtifactCapture> {
  const { handle, stat } = await openPlanFileAsync(getProjectRoot(), filePath)
  try {
    const totalBytes = stat.size
    const buffer = Buffer.alloc(Math.min(totalBytes, MAX_ARTIFACT_BYTES))
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (!chunk.bytesRead) break
      bytesRead += chunk.bytesRead
    }
    assertPlanCaptureStable(stat, await handle.stat())
    return decodeArtifactPrefix(buffer, bytesRead, totalBytes)
  } finally { await handle.close() }
}

/** A current-file range inspector. Adjacent UTF-8 pages overlap a boundary character. */
export async function readPlanArtifactPage(
  input: string,
  name: string,
  page = 1,
): Promise<string> {
  if (!(PLAN_ARTIFACT_NAMES as readonly string[]).includes(name))
    return `Unknown artifact. Choose ${PLAN_ARTIFACT_NAMES.join(', ')}.`
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > Math.floor(Number.MAX_SAFE_INTEGER / MAX_ARTIFACT_BYTES)
  )
    return 'Artifact page must be a positive safe integer; each page reads at most 64 KiB plus a UTF-8 boundary overlap.'
  const resolved = resolvePlanSessionDir(input)
  if (!resolved.ok) return resolved.error
  const { handle, stat } = await openPlanFileAsync(getProjectRoot(), path.join(resolved.absSessionDir, name))
  try {
    const totalBytes = stat.size
    const offset = (page - 1) * MAX_ARTIFACT_BYTES
    const pageCount = Math.max(1, Math.ceil(totalBytes / MAX_ARTIFACT_BYTES))
    if (offset >= totalBytes && totalBytes > 0)
      return `No bytes on page ${page}. ${resolved.sessionDir}/${name} has ${pageCount} pages (${totalBytes} bytes); choose --page 1..${pageCount}.`
    const readOffset = Math.max(0, offset - 3)
    const buffer = Buffer.alloc(
      Math.min(MAX_ARTIFACT_BYTES + 6, Math.max(0, totalBytes - readOffset)),
    )
    const { bytesRead } = await handle.read(
      buffer,
      0,
      buffer.length,
      readOffset,
    )
    assertPlanCaptureStable(stat, await handle.stat())
    let begin = Math.min(offset - readOffset, bytesRead)
    while (begin > 0 && (buffer[begin]! & 0xc0) === 0x80) begin--
    const end = Math.min(bytesRead, offset - readOffset + MAX_ARTIFACT_BYTES)
    const text = new TextDecoder('utf-8').decode(buffer.subarray(begin, end), {
      stream: readOffset + end < totalBytes,
    })
    return [
      `Current local artifact · ${resolved.sessionDir}/${name}`,
      `Page ${page}/${pageCount}; captured bytes ${readOffset + begin}–${readOffset + end} of ${totalBytes} at ${new Date().toISOString()}. Adjacent pages may overlap one UTF-8 character.`,
      '',
      text,
      '',
      `Read another range: /plan-artifact ${input} ${name} --page <1..${pageCount}>`,
      'This is a new current-file capture; it does not replace historical recorded evidence.',
    ].join('\n')
  } finally {
    await handle.close()
  }
}

/** A catalog remains useful while refusing individual unreadable or unsafe rows. */
export type PlanSessionCatalog = PlanSessionSummary[] & { partial?: boolean; skipped?: number }
export function planCatalogWarning(catalog: PlanSessionSummary[]): string | null {
  const skipped = (catalog as PlanSessionCatalog).skipped ?? 0
  return skipped ? `Plan sessions partial: skipped ${skipped} unreadable or unsafe session${skipped === 1 ? '' : 's'}.` : null
}
function catalog(rows: Array<PlanSessionSummary & { mtimeMs: number }>, skipped: number): PlanSessionCatalog {
  const result: PlanSessionCatalog = rows.sort((a, b) => b.mtimeMs - a.mtimeMs || a.slug.localeCompare(b.slug))
    .map(({ mtimeMs: _mtimeMs, ...session }) => session)
  if (skipped) { result.partial = true; result.skipped = skipped }
  return result
}
function summarizeSession(slug: string, absSessionDir: string, artifacts: PlanArtifactName[],
  plan: ArtifactCapture | null, state: PlanSessionState | null, activeSlug: string | null, mtimeMs: number) {
  const progress = { done: 0, total: 0 }
  for (const line of plan?.text.split('\n') ?? []) {
    const match = line.match(TRI_STATE_CHECKBOX_LINE_RE)
    if (match) { progress.total++; if (match[2]?.toLowerCase() === 'x') progress.done++ }
  }
  return { slug, sessionDir: `${PLAN_SESSIONS_DIR_PREFIX}${slug}`, absSessionDir, artifacts,
    status: state?.status ?? 'unknown', currentTask: (plan ? readCurrentTaskAnnotation(plan.text) : null) ?? state?.currentTask ?? null,
    updatedAt: state?.updatedAt ?? null, progress, progressPartial: plan?.truncated ?? false,
    isActive: activeSlug === slug, mtimeMs } satisfies PlanSessionSummary & { mtimeMs: number }
}

/** Async list destination; bounded batches isolate per-session read failures. */
export async function listPlanSessionsAsync(options: { signal?: AbortSignal } = {}): Promise<PlanSessionCatalog> {
  const projectRoot = getProjectRoot()
  let root
  try { root = openPlanDirectory(projectRoot, '.agents/sessions') }
  catch (error) { if (isMissingPlanArtifact(error)) return []; throw error }
  let entries: fs.Dirent[]
  try { entries = await fs.promises.readdir(planDirectoryPath(root), { withFileTypes: true }) }
  finally { root.close() }
  const activeSlug = getActivePlanSessionSlug()
  const candidates = entries.filter(entry => entry.isDirectory() && isValidPlanSlug(entry.name))
  const results: Array<PlanSessionSummary & { mtimeMs: number }> = []
  let skipped = entries.filter(entry => entry.isSymbolicLink() && isValidPlanSlug(entry.name)).length
  for (let start = 0; start < candidates.length; start += 12) {
    options.signal?.throwIfAborted()
    const batch = await Promise.all(candidates.slice(start, start + 12).map(async entry => {
      const absSessionDir = path.join(projectRoot, PLAN_SESSIONS_DIR_PREFIX, entry.name)
      let directory
      try {
        directory = openPlanDirectory(projectRoot, `${PLAN_SESSIONS_DIR_PREFIX}${entry.name}`)
        const names = await fs.promises.readdir(planDirectoryPath(directory), { withFileTypes: true })
        if (names.some(file => (PLAN_ARTIFACT_NAMES as readonly string[]).includes(file.name) && file.isSymbolicLink())) throw new Error('Unsafe plan artifact')
        const artifacts = listPresentPlanArtifacts(absSessionDir)
        if (!artifacts.length) return null
        const plan = artifacts.includes('PLAN.md') ? await readBoundedArtifact(path.join(absSessionDir, 'PLAN.md')) : null
        return summarizeSession(entry.name, absSessionDir, artifacts, plan, readStateForSession(absSessionDir, entry.name), activeSlug, fs.fstatSync(directory.fd).mtimeMs)
      } catch { skipped++; return null }
      finally { directory?.close() }
    }))
    for (const item of batch) if (item) results.push(item)
  }
  options.signal?.throwIfAborted()
  return catalog(results, skipped)
}

export type PlanArtifacts = {
  /** Project-relative session directory (e.g. ".agents/sessions/foo"). */
  sessionDir: string
  /** Absolute resolved session directory. */
  absSessionDir: string
  /** Map of artifact name -> contents (only present for files that exist). */
  files: Partial<Record<PlanArtifactName, string>>
  /** Project-relative paths for files that exist. */
  presentPaths: Partial<Record<PlanArtifactName, string>>
  /** Artifact names that were not found on disk. */
  missing: PlanArtifactName[]
  /** Artifact names that were truncated because the file exceeded MAX_ARTIFACT_BYTES. */
  truncated: PlanArtifactName[]
  /** Deterministic execution readiness derived from PLAN.md. */
  preflight: PlanPreflightResult | null
}

// TRI_STATE_CHECKBOX_LINE_RE is imported from @codebuff/common/util/plan-artifacts
// so the CLI and the runtime handler share the canonical tri-state regex.

/**
 * Read STATE.json for a session, falling back to a synthesized default
 * (active, no current task) when STATE.json is missing or unparseable.
 *
 * Delegates to the shared `readPlanState` for parsing/validation so the
 * normalization rules live in one place (`common/src/util/plan-artifacts.ts`)
 * and stay in lockstep with the runtime handler.
 */
function readStateForSession(
  absSessionDir: string,
  slug: string,
): PlanSessionState | null {
  const statePath = path.join(absSessionDir, 'STATE.json')
  try {
    const captured = readBoundedArtifactSync(statePath)
    if (captured.truncated) return null
    // Normalize the verified capture; never reopen the lexical STATE.json path.
    const raw = JSON.parse(captured.text) as Record<string, unknown>
    if (
      !raw ||
      Array.isArray(raw) ||
      typeof raw.status !== 'string' ||
      !['active', 'paused', 'completed', 'archived'].includes(raw.status) ||
      typeof raw.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(raw.updatedAt))
    )
      return null
    return normalizePlanState(raw, slug)
  } catch {
    return null
  }
}

export type PlanSessionSummary = {
  /** Session slug under .agents/sessions. */
  slug: string
  /** Project-relative session directory (e.g. ".agents/sessions/foo"). */
  sessionDir: string
  /** Absolute resolved session directory. */
  absSessionDir: string
  /** Artifact names present in this session. */
  artifacts: PlanArtifactName[]
  /** Session lifecycle status (active / paused / completed / archived). */
  status: PlanSessionStatus | 'unknown'
  /** Current task pointer (may differ from STATE.json when PLAN.md is the source of truth). */
  currentTask: string | null
  /** ISO timestamp from STATE.json (or fallback). */
  updatedAt: string | null
  /** Progress counts cover only the bounded PLAN.md prefix when true. */
  progressPartial?: boolean
  /** Done / total checklist counts derived from PLAN.md. */
  progress: { done: number; total: number }
  /** True when this session is the project-wide active session. */
  isActive: boolean
}

/**
 * Width of the fixed-width `[status]` badge column, sized so the four common
 * lifecycle badges line up. Longer statuses simply overflow the column.
 */
const PLAN_STATUS_BADGE_WIDTH = '[completed]'.length

/** Fixed-width `[status]` badge for one session row. */
function formatPlanStatusBadge(status: string): string {
  return `[${status}]`.padEnd(PLAN_STATUS_BADGE_WIDTH)
}

/** The segments of one `/plans` list row, in render order. */
export type PlanSessionListRow = {
  /** `' * '` for the project-wide active session, blank padding otherwise. */
  activeMarker: string
  /** Fixed-width `[status]` badge. */
  badge: string
  /** Slug plus the optional `N/M done` progress suffix. */
  label: string
  /** `  current: "..."` suffix, or `''` when no current task is recorded. */
  current: string
}

/**
 * Canonical `/plans` row formatter. PlanStatusBox colors these segments
 * individually while formatPlanListReport joins them for the text fallback, so
 * the rendered and text forms of a session row cannot drift.
 */
export function formatPlanSessionListRow(
  session: PlanSessionSummary,
): PlanSessionListRow {
  const progress =
    session.progress.total > 0
      ? ` ${session.progress.done}/${session.progress.total} done${session.progressPartial ? ' (plan prefix)' : ''}`
      : ''
  return {
    activeMarker: session.isActive ? ' * ' : '   ',
    badge: formatPlanStatusBadge(session.status),
    label: `${session.slug}${progress}${session.status === 'unknown' ? ' · legacy/unknown state; update time unknown' : ''}`,
    current: session.currentTask ? `  current: "${session.currentTask}"` : '',
  }
}

/** Single-line text form of a `/plans` row. */
export function formatPlanSessionListRowText(
  session: PlanSessionSummary,
): string {
  const { activeMarker, badge, label, current } =
    formatPlanSessionListRow(session)
  return `${activeMarker}${badge} ${label}${current}`
}

/**
 * Canonical project-relative prefix every plan session directory lives under.
 * The resolver below and the `/plan-use` containment check in
 * command-registry.ts both derive from this constant so they cannot drift.
 */
export const PLAN_SESSIONS_DIR_PREFIX = '.agents/sessions/'

type ResolveResult =
  | { ok: true; sessionDir: string; absSessionDir: string }
  | { ok: false; error: string }

/**
 * Normalize a user-supplied session path: handle backslashes, leading "./",
 * and (when not absolute) a single bare slug. Absolute paths are returned
 * as-is so the caller can decide whether to reject them.
 */
function normalizeSessionInput(input: string): string {
  let rel = input.trim().replace(/\\/g, '/')
  while (rel.startsWith('./')) rel = rel.slice(2)
  if (rel.endsWith('.md')) rel = path.posix.dirname(rel)
  if (!rel.includes('/') && rel.length > 0) {
    rel = `${PLAN_SESSIONS_DIR_PREFIX}${rel}`
  }
  return rel
}

/**
 * Resolve a user-provided session slug or path to a `.agents/sessions/<slug>`
 * directory under the project root. Rejects path traversal that escapes
 * the project root.
 */
export function resolvePlanSessionDir(input: string): ResolveResult {
  const trimmed = input.trim()
  if (!trimmed) {
    return { ok: false, error: 'Missing session slug or path.' }
  }

  const projectRoot = getProjectRoot()
  const rel = normalizeSessionInput(trimmed)

  const abs = path.resolve(projectRoot, rel)
  const rootWithSep = projectRoot.endsWith(path.sep)
    ? projectRoot
    : projectRoot + path.sep
  if (abs !== projectRoot && !abs.startsWith(rootWithSep)) {
    return {
      ok: false,
      error: 'Resolved session path escapes the project root.',
    }
  }

  // Use forward slashes for the project-relative display form.
  const sessionDir = path.relative(projectRoot, abs).split(path.sep).join('/')

  return { ok: true, sessionDir, absSessionDir: abs }
}

/**
 * Canonical artifact-presence rule: an artifact counts as present only when it
 * exists as a regular file. Every caller (readPlanArtifacts, listPlanSessions
 * and the `/plan-use` validation path) goes through this helper so the rule
 * lives in exactly one place.
 */
function planArtifactExists(
  absSessionDir: string,
  name: PlanArtifactName,
): boolean {
  try {
    const file = openPlanFile(getProjectRoot(), path.join(absSessionDir, name))
    file.close()
    return true
  } catch (error) { if (isMissingPlanArtifact(error)) return false; throw error }
}

/** Known plan artifacts present in an already-resolved session directory. */
function listPresentPlanArtifacts(absSessionDir: string): PlanArtifactName[] {
  return PLAN_ARTIFACT_NAMES.filter((name) =>
    planArtifactExists(absSessionDir, name),
  )
}

/**
 * True when an already-resolved session directory holds at least one known plan
 * artifact. Used on the `/plan-use` validation path so the slug is resolved
 * exactly once and artifact bodies are not read just to test presence.
 */
export function hasPlanArtifactInDir(absSessionDir: string): boolean {
  try { return PLAN_ARTIFACT_NAMES.some(name => planArtifactExists(absSessionDir, name)) }
  catch { return false }
}

/**
 * Read whichever plan artifacts exist under the given session directory.
 * Returns `null` if the session directory does not exist on disk. Artifacts
 * larger than MAX_ARTIFACT_BYTES are truncated to keep prompts bounded.
 */
export function readPlanArtifacts(input: string): PlanArtifacts | null {
  try {
  const resolved = resolvePlanSessionDir(input)
  if (!resolved.ok) return null
  const directory = openPlanDirectory(getProjectRoot(), resolved.sessionDir)
  directory.close()

  const files: Partial<Record<PlanArtifactName, string>> = {}
  const presentPaths: Partial<Record<PlanArtifactName, string>> = {}
  const missing: PlanArtifactName[] = []
  const truncated: PlanArtifactName[] = []

  for (const name of PLAN_ARTIFACT_NAMES) {
    if (!planArtifactExists(resolved.absSessionDir, name)) {
      missing.push(name)
      continue
    }
    const abs = path.join(resolved.absSessionDir, name)
    const captured = readBoundedArtifactSync(abs)
    const raw = captured.text
    if (captured.truncated) {
      files[name] =
        `${raw}\n\n[Captured the first ${captured.bytesRead} of ${captured.totalBytes} bytes; read the current artifact directly for remaining contents.]`
      truncated.push(name)
    } else {
      files[name] = raw
    }
    presentPaths[name] = `${resolved.sessionDir}/${name}`
  }

  return {
    sessionDir: resolved.sessionDir,
    absSessionDir: resolved.absSessionDir,
    files,
    presentPaths,
    missing,
    truncated,
    preflight:
      files['PLAN.md'] && !truncated.includes('PLAN.md')
        ? preflightPlan(files['PLAN.md'])
        : null,
  }
  } catch { return null }
}

/**
 * Format the artifact contents for inclusion in an agent prompt.
 */
export function formatArtifactsForPrompt(artifacts: PlanArtifacts): string {
  const sections: string[] = []
  for (const name of PLAN_ARTIFACT_NAMES) {
    const content = artifacts.files[name]
    if (content === undefined) continue
    sections.push(
      `--- BEGIN ${artifacts.sessionDir}/${name} ---\n${content.trimEnd()}\n--- END ${artifacts.sessionDir}/${name} ---`,
    )
  }
  if (artifacts.preflight) {
    sections.unshift(
      [
        '--- PLAN PREFLIGHT ---',
        `Ready: ${artifacts.preflight.ok ? 'yes' : 'no'}`,
        `Next task: ${artifacts.preflight.nextTaskId ?? 'none'}`,
        `Errors: ${artifacts.preflight.errors.join('; ') || 'none'}`,
        `Warnings: ${artifacts.preflight.warnings.join('; ') || 'none'}`,
        '--- END PLAN PREFLIGHT ---',
      ].join('\n'),
    )
  }
  return sections.join('\n\n')
}

/**
 * Returns true if the artifact set contains at least one of the four files.
 */
export function hasAnyArtifact(artifacts: PlanArtifacts | null): boolean {
  return !!artifacts && Object.keys(artifacts.files).length > 0
}

/**
 * List durable plan sessions under `.agents/sessions/*` that contain at least
 * one known plan artifact. Directories are returned newest first by mtime.
 *
 * Each summary now includes the session's lifecycle status (from
 * `.agents/sessions/<slug>/STATE.json`), progress, current task pointer, and
 * whether the session is the project-wide active session (from
 * `.agents/ACTIVE_SESSION`). Sessions without STATE.json are treated as
 * `active` by default.
 */
export function listPlanSessions(): PlanSessionCatalog {
  const projectRoot = getProjectRoot()
  let root
  try { root = openPlanDirectory(projectRoot, '.agents/sessions') }
  catch (error) { if (isMissingPlanArtifact(error)) return []; throw error }
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(planDirectoryPath(root), { withFileTypes: true }) }
  finally { root.close() }
  const activeSlug = getActivePlanSessionSlug()
  const results: Array<PlanSessionSummary & { mtimeMs: number }> = []
  let skipped = 0
  for (const entry of entries) {
    if (!isValidPlanSlug(entry.name)) continue
    if (entry.isSymbolicLink()) { skipped++; continue }
    if (!entry.isDirectory()) continue
    const absSessionDir = path.join(projectRoot, PLAN_SESSIONS_DIR_PREFIX, entry.name)
    let directory
    try {
      directory = openPlanDirectory(projectRoot, `${PLAN_SESSIONS_DIR_PREFIX}${entry.name}`)
      const artifacts = listPresentPlanArtifacts(absSessionDir)
      if (!artifacts.length) continue
      const plan = artifacts.includes('PLAN.md') ? readBoundedArtifactSync(path.join(absSessionDir, 'PLAN.md')) : null
      results.push(summarizeSession(entry.name, absSessionDir, artifacts, plan, readStateForSession(absSessionDir, entry.name), activeSlug, fs.fstatSync(directory.fd).mtimeMs))
    } catch { skipped++ }
    finally { directory?.close() }
  }
  return catalog(results, skipped)
}

/**
 * Read STATE.json for a given session slug. Returns null if the session
 * directory or STATE.json do not exist. Convenience wrapper around the
 * common module's readPlanState that injects the project root.
 */
export function readPlanSessionState(slug: string): PlanSessionState | null {
  if (!isValidPlanSlug(slug)) return null
  const dir = path.join(getProjectRoot(), '.agents', 'sessions', slug)
  return readStateForSession(dir, slug)
}

/**
 * Returns the slug of the project-wide active session, or null when no
 * session is currently marked active.
 */
export function getActivePlanSessionSlug(): string | null {
  try {
    const captured = readBoundedArtifactSync(path.join(getProjectRoot(), '.agents', ACTIVE_SESSION_POINTER_FILENAME))
    const slug = captured.text.trim()
    return !captured.truncated && !/[\r\n]/.test(slug) && isValidPlanSlug(slug) ? slug : null
  } catch { return null }
}

/**
 * Point `.agents/ACTIVE_SESSION` at `slug`, resolving the project root through
 * the same CLI resolver callers validate the session directory against.
 *
 * The shared `writeActiveSessionPointer` resolves the root again through its own
 * module-level resolver, so a validated session directory and the written
 * pointer could target different roots; writing here keeps the check and the
 * write on one resolver. Returns false (never throws) when the project root is
 * unavailable or the pointer cannot be written.
 */
export function writeActivePlanSessionPointer(slug: string): boolean {
  if (!isValidPlanSlug(slug)) return false
  try {
    const pointerDir = path.join(getProjectRoot(), '.agents')
    fs.mkdirSync(pointerDir, { recursive: true })
    fs.writeFileSync(
      path.join(pointerDir, ACTIVE_SESSION_POINTER_FILENAME),
      `${slug}\n`,
      'utf8',
    )
    return true
  } catch (err) {
    console.debug(
      `[plan-artifacts] writeActivePlanSessionPointer failed for ${slug}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return false
  }
}

/** Re-export the active-session pointer filename for callers (e.g. CLI banners). */
export const ACTIVE_SESSION_FILE_NAME = ACTIVE_SESSION_POINTER_FILENAME
