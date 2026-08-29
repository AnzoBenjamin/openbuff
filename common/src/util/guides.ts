/**
 * On-demand guide fallback (T1.4d).
 *
 * base2's progressive prompt disclosure replaces each relocated advisory
 * section with a compact pointer naming a workspace-relative
 * `agents/guides/*.md` path. `read_files` resolves those paths against the
 * EMBEDDER's workspace root and no publish pipeline ships the guides, so in any
 * workspace other than this repo the pointer read fails and the model loses the
 * whole section.
 *
 * Detection has to happen at prompt-format time rather than in `createBase2`:
 * `cli/scripts/prebuild-agents.ts` freezes the resolved definitions into
 * `cli/src/agents/bundled-agents.generated.ts` at CLI build time, inside this
 * worktree, where every guide exists. So the tables below carry the FULL
 * section bodies and the per-guide placeholder providers in
 * `packages/agent-runtime/src/templates/strings.ts` re-inline only the body
 * whose guide is missing under the caller's `projectRoot`.
 *
 * Recovery is PER POINTER, not one block for everything: base2 emits one
 * placeholder per pointer it actually discloses, so a section a mode
 * deliberately omits (plan mode is read-only and emits neither the
 * git-discipline pointer nor its body) is never recovered on that surface, and
 * the clause-parameterized broad-audit body is recovered for the clause the
 * same surface disclosed.
 *
 * The bodies are imported from `../constants/prompt-sections` (the same module
 * the bundled agents use) so a recovered body cannot drift from the authored
 * one.
 */

import fs from 'fs'
import path from 'path'

import {
  buildBroadAuditSection,
  gitDisciplineSection,
  preReviewSelfCheckSection,
  qualitySection,
  securityReviewSection,
  specialistRoutingSection,
} from '../constants/prompt-sections'

import type { BroadAuditFinalizeClause } from '../constants/prompt-sections'

/**
 * The relocated guides, keyed the way the placeholder providers reference them.
 *
 * This is the single copy of the paths: the table lives here rather than next
 * to base2's pointers because `packages/agent-runtime` must not import from
 * `agents/`, and base2 imports it back (`GUIDE_PATHS` in
 * `agents/base2/base2.ts` is an alias of this table and its `GuidePath` union
 * is derived from it). Pointer/fallback parity — every relocated pointer has a
 * recovery body and vice versa — is asserted by
 * `agents/__tests__/base2-progressive-disclosure.test.ts` and
 * `packages/agent-runtime/src/templates/__tests__/strings.test.ts`.
 */
export const FALLBACK_GUIDES = {
  codeCraftsmanship: 'agents/guides/code-craftsmanship.md',
  preReviewSelfCheck: 'agents/guides/pre-review-self-check.md',
  gitDiscipline: 'agents/guides/git-discipline.md',
  securityReview: 'agents/guides/security-review.md',
  specialistRouting: 'agents/guides/specialist-routing.md',
  broadAudit: 'agents/guides/broad-audit.md',
} as const

/**
 * Broad-audit recovery bodies keyed by finalize clause.
 *
 * This is the one relocated section whose text depends on the mode: the
 * implementation surfaces finalize with "proceed to implementation or the
 * answer", plan mode finalizes into the durable plan packet, and base2's
 * plan-mode pointer additionally says "do not implement". Recovering the
 * implementation variant on the plan surface would hand a read-only plan-mode
 * prompt directly contradictory finalize instructions, so the recovery is keyed
 * by clause and base2 emits the placeholder for the clause it disclosed.
 */
export const BROAD_AUDIT_FALLBACK_SECTIONS: Readonly<
  Record<BroadAuditFinalizeClause, string>
> = {
  'proceed to implementation or the answer': buildBroadAuditSection(
    'proceed to implementation or the answer',
  ),
  'translate the findings into the durable plan packet below':
    buildBroadAuditSection(
      'translate the findings into the durable plan packet below',
    ),
}

/**
 * Workspace-relative guide path -> the DEFAULT full section body that guide
 * contains.
 *
 * Keys are byte-identical to the paths base2's pointers emit. The broad-audit
 * guide documents the implementation variant of the clause-parameterized body,
 * matching base2's `BROAD_AUDIT_ROW_CLAUSE`; the plan surface overrides it with
 * the plan-clause body from `BROAD_AUDIT_FALLBACK_SECTIONS`.
 */
export const GUIDE_FALLBACK_SECTIONS: Readonly<Record<string, string>> = {
  [FALLBACK_GUIDES.codeCraftsmanship]: qualitySection,
  [FALLBACK_GUIDES.preReviewSelfCheck]: preReviewSelfCheckSection,
  [FALLBACK_GUIDES.gitDiscipline]: gitDisciplineSection,
  [FALLBACK_GUIDES.securityReview]: securityReviewSection,
  [FALLBACK_GUIDES.specialistRouting]: specialistRoutingSection,
  [FALLBACK_GUIDES.broadAudit]:
    BROAD_AUDIT_FALLBACK_SECTIONS['proceed to implementation or the answer'],
}

/**
 * Guide paths (keys of `GUIDE_FALLBACK_SECTIONS`) absent under `projectRoot`,
 * in table declaration order.
 *
 * Returns `[]` for a falsy/non-string root: nothing can be concluded to be
 * missing without a root, and reporting "everything is missing" there would
 * regrow every prompt formatted without a real workspace by six full sections.
 *
 * No error guard: `fs.existsSync` reports a failed probe as `false` instead of
 * throwing, and `path.join` only ever receives the type-guarded root plus a
 * literal table key, so there is no throwing path to catch here.
 */
export function findMissingGuides(projectRoot: string): string[] {
  if (!projectRoot || typeof projectRoot !== 'string') return []
  return Object.keys(GUIDE_FALLBACK_SECTIONS).filter(
    (guide) => !fs.existsSync(path.join(projectRoot, guide)),
  )
}

/**
 * ONE recovered guide body as a headed block.
 *
 * Returns `''` when `guide` is not in `missing` — so the in-repo resolved
 * prompt stays byte-identical and the placeholder collapses cleanly — and for
 * an unknown key with no body. `body` overrides the table entry, which is how
 * the clause-parameterized broad-audit guide recovers the plan-clause body on
 * the plan surface.
 */
export function formatGuideFallbackSection(opts: {
  missing: readonly string[]
  guide: string
  body?: string
}): string {
  const { missing, guide } = opts
  if (!missing.includes(guide)) return ''
  const body = opts.body ?? GUIDE_FALLBACK_SECTIONS[guide]
  if (!body) return ''
  const header = `## On-demand guide body (\`${guide}\` unavailable in this workspace)`
  const intro =
    'The named guide file is not present in this workspace, so `read_files` on it would fail; its full body is inlined below instead.'
  return `${header}\n\n${intro}\n\n${body}`
}
