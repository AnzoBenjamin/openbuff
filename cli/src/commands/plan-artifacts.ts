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
  readActiveSessionPointer,
  readCurrentTaskAnnotation,
  readPlanState,
  preflightPlan,
  type PlanPreflightResult,
  type PlanArtifactName,
  type PlanSessionStatus,
  type PlanSessionState,
} from '@codebuff/common/util/plan-artifacts'

import { getProjectRoot } from '../project-files'

export { PLAN_ARTIFACT_NAMES }

/**
 * Max bytes read per plan artifact when assembling the prompt. Keeps prompts
 * bounded even when users accidentally write huge SPEC.md/LESSONS.md files.
 */
export const MAX_ARTIFACT_BYTES = 64 * 1024

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
 * Count progress inside a session. Returns done/total counts based on
 * checklist marks in PLAN.md (falls back to zeros if PLAN.md is absent).
 */
function countProgress(absSessionDir: string): { done: number; total: number } {
  const planPath = path.join(absSessionDir, 'PLAN.md')
  if (!fs.existsSync(planPath)) return { done: 0, total: 0 }
  const raw = fs.readFileSync(planPath, 'utf8')
  let done = 0
  let total = 0
  for (const line of raw.split('\n')) {
    const m = line.match(TRI_STATE_CHECKBOX_LINE_RE)
    if (!m) continue
    total += 1
    if (m[2] === 'x' || m[2] === 'X') done += 1
  }
  return { done, total }
}

function readCurrentTaskForSession(absSessionDir: string): string | null {
  const planPath = path.join(absSessionDir, 'PLAN.md')
  if (!fs.existsSync(planPath)) return null
  // readCurrentTaskAnnotation is pure regex matching and cannot throw, so no
  // try/catch is needed here.
  const raw = fs.readFileSync(planPath, 'utf8')
  return readCurrentTaskAnnotation(raw)
}

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
): PlanSessionState {
  const state = !fs.existsSync(absSessionDir) ? null : readPlanState(slug)
  if (state) return state
  const now = new Date().toISOString()
  return {
    schemaVersion: 2,
    slug,
    status: 'active',
    currentTask: null,
    revision: 0,
    checkpoint: null,
    createdAt: now,
    updatedAt: now,
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
  status: PlanSessionStatus
  /** Current task pointer (may differ from STATE.json when PLAN.md is the source of truth). */
  currentTask: string | null
  /** ISO timestamp from STATE.json (or fallback). */
  updatedAt: string
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
      ? ` ${session.progress.done}/${session.progress.total} done`
      : ''
  return {
    activeMarker: session.isActive ? ' * ' : '   ',
    badge: formatPlanStatusBadge(session.status),
    label: `${session.slug}${progress}`,
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
  const artifactPath = path.join(absSessionDir, name)
  return fs.existsSync(artifactPath) && fs.statSync(artifactPath).isFile()
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
  return PLAN_ARTIFACT_NAMES.some((name) =>
    planArtifactExists(absSessionDir, name),
  )
}

/**
 * Read whichever plan artifacts exist under the given session directory.
 * Returns `null` if the session directory does not exist on disk. Artifacts
 * larger than MAX_ARTIFACT_BYTES are truncated to keep prompts bounded.
 */
export function readPlanArtifacts(input: string): PlanArtifacts | null {
  const resolved = resolvePlanSessionDir(input)
  if (!resolved.ok) return null
  if (!fs.existsSync(resolved.absSessionDir)) return null

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
    const raw = fs.readFileSync(abs, 'utf8')
    if (raw.length > MAX_ARTIFACT_BYTES) {
      const head = raw.slice(0, MAX_ARTIFACT_BYTES)
      const dropped = raw.length - head.length
      files[name] =
        `${head}\n\n[...truncated ${dropped} chars to keep prompt bounded; read the file directly for full contents...]`
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
    preflight: files['PLAN.md'] ? preflightPlan(files['PLAN.md']) : null,
  }
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
export function listPlanSessions(): PlanSessionSummary[] {
  const projectRoot = getProjectRoot()
  const sessionsRoot = path.join(projectRoot, '.agents', 'sessions')
  if (!fs.existsSync(sessionsRoot)) return []

  // The project-root resolver is wired once in setProjectRoot (see
  // cli/src/project-files.ts), so readPlanState can locate STATE.json here.
  const rootWithSep = sessionsRoot.endsWith(path.sep)
    ? sessionsRoot
    : sessionsRoot + path.sep

  const activeSlug = readActiveSessionPointer()

  return fs
    .readdirSync(sessionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const absSessionDir = path.resolve(sessionsRoot, entry.name)
      if (!absSessionDir.startsWith(rootWithSep)) return null
      if (!isValidPlanSlug(entry.name)) return null

      const artifacts = listPresentPlanArtifacts(absSessionDir)

      if (artifacts.length === 0) return null

      const state = readStateForSession(absSessionDir, entry.name)
      const progress = countProgress(absSessionDir)
      // STATE.json is the canonical source for `currentTask`, but PLAN.md's
      // `<!-- current-task: ... -->` annotation takes precedence when present
      // (it is updated atomically with task transitions).
      const annotationTask = readCurrentTaskForSession(absSessionDir)
      const currentTask = annotationTask ?? state.currentTask

      const summary: PlanSessionSummary & { mtimeMs: number } = {
        slug: entry.name,
        sessionDir: `.agents/sessions/${entry.name}`,
        absSessionDir,
        artifacts,
        status: state.status,
        currentTask,
        updatedAt: state.updatedAt,
        progress,
        isActive: activeSlug === entry.name,
        mtimeMs: fs.statSync(absSessionDir).mtimeMs,
      }
      return summary
    })
    .filter(
      (session): session is PlanSessionSummary & { mtimeMs: number } =>
        session !== null,
    )
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.slug.localeCompare(b.slug))
    .map((session): PlanSessionSummary => {
      const { mtimeMs: _mtimeMs, ...rest } = session
      return rest
    })
}

/**
 * Read STATE.json for a given session slug. Returns null if the session
 * directory or STATE.json do not exist. Convenience wrapper around the
 * common module's readPlanState that injects the project root.
 */
export function readPlanSessionState(slug: string): PlanSessionState | null {
  if (!isValidPlanSlug(slug)) return null
  const dir = path.join(getProjectRoot(), '.agents', 'sessions', slug)
  if (!fs.existsSync(dir)) return null
  return readPlanState(slug)
}

/**
 * Returns the slug of the project-wide active session, or null when no
 * session is currently marked active.
 */
export function getActivePlanSessionSlug(): string | null {
  return readActiveSessionPointer()
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
