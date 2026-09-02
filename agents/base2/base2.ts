import { buildArray } from '@codebuff/common/util/array'
import type { SpecialistReviewerAgent } from '@codebuff/common/agents/specialist-risk-router'
import {
  resolveMaxRepairRounds,
  resolveMaxReviewerRepairRounds,
  resolveMaxSpecialistRepairRounds,
} from '@codebuff/common/util/gate-repair-budgets'
import { FALLBACK_GUIDES } from '@codebuff/common/util/guides'

import type {
  Base2ActiveWorkPhase,
  Base2ActiveWorkState,
  Base2PlanTaskGateReceipt,
  Base2WorkflowTodo,
  Base2WorkflowTodoProgress,
  Base2ReviewReceipt,
} from './gate-state'
import {
  type BroadAuditFinalizeClause,
  buildBroadAuditSection,
  gateAwarenessSection,
  gitDisciplineSection,
  preReviewSelfCheckSection,
  qualitySection,
  securityReviewSection,
  specialistRoutingSection,
} from './quality-prompt-section'
import { resolveModelToolNames, type UnlockedToolTier } from './tool-tiers'
import { publisher } from '../constants'
import {
  PLACEHOLDER,
  type PlaceholderValue,
  type SecretAgentDefinition,
} from '../types/secret-agent-definition'

/**
 * Default when the option is omitted: ON (post-M2 flip). No env canary — an
 * explicit `progressivePromptDisclosure: false` is the only opt-out.
 */
const DEFAULT_PROGRESSIVE_PROMPT_DISCLOSURE: boolean = true

/**
 * Pointers emitted in place of the relocated sections while disclosure is on.
 * Every pointer must keep its "If that guide is unavailable" clause: the guides
 * are plain repo files, so an embedder whose workspace lacks `agents/guides/`
 * degrades to the inline summary instead of losing the section to a failed
 * read. The full bodies are additionally recovered at prompt-format time by the
 * `ON_DEMAND_GUIDE_FALLBACK` placeholder below, whose provider detects the
 * missing guides against the caller's workspace root (T1.4d; table and
 * detection live in `common/src/util/guides.ts`).
 */
const broadAuditPointer =
  'Broad audit / many-file / coverage-sweep request → read_files `agents/guides/broad-audit.md` before sharding. If that guide is unavailable, still scope first: measure breadth, dispatch one file-picker/code-searcher pair per subsystem in bounded waves, and machine-check coverage before synthesizing — never a single codesearch.'
/** Finalize clause whose section body `GUIDE_POINTER_TABLE` pins. */
const BROAD_AUDIT_ROW_CLAUSE: BroadAuditFinalizeClause =
  'proceed to implementation or the answer'
/**
 * Per-clause tail appended to `broadAuditPointer`: only plan mode carries the
 * "do not implement" sentence. Keyed by `BroadAuditFinalizeClause` so a new
 * clause is a compile error rather than a silently missing tail.
 */
const BROAD_AUDIT_POINTER_TAILS: Record<BroadAuditFinalizeClause, string> = {
  'proceed to implementation or the answer': '',
  'translate the findings into the durable plan packet below':
    ' In plan mode, do not implement — translate the findings into the durable plan packet instead.',
}
const specialistRoutingPointer =
  'Choosing a specialist agent → read_files `agents/guides/specialist-routing.md`. If that guide is unavailable, route only on a crossed risk boundary (architecture, requirements, performance, reliability, migration, compatibility, accessibility, dependencies), pass the gate-assigned `params.snapshot_id`, and never substitute a specialist for the runtime-owned final gate.'
const gitDisciplinePointer =
  'Before any git commit/branch/push → read_files `agents/guides/git-discipline.md`. If that guide is unavailable, apply the standard git rules: delegate to `git-committer` with `params.owned_paths`, commit only after GATE: PASSED, never push or alter git config unless explicitly asked, and never commit secrets.'
// The named guide is advisory routing only (when to ask for a pre-edit
// security review), so the degraded clause mirrors that routing rule rather
// than restating the reviewer rubric's input-validation/fail-closed bullet,
// which `preReviewSelfCheckPointer` already owns.
const securityReviewPointer =
  'Editing security-sensitive files (auth/crypto/secrets/payment/permissions) → read_files `agents/guides/security-review.md` before editing. If that guide is unavailable, apply the standard routing rule: consider an advisory (non-blocking) `security-reviewer` pre-edit review before the editor runs, skip it for trivial edits such as typos or comments, and remember the automated post-edit validation/reviewer gate still runs regardless.'
// The always-inline `# Code Editing Mandates` block below intentionally
// restates these rules in base2's own wording: it is the minimum always-on
// editing contract, so it must survive both this pointer and a workspace with
// no `agents/guides/`. quality-prompt-snapshot.test.ts pins the shared topic
// labels on BOTH copies so the duplication cannot silently drift.
const qualitySectionPointer =
  'Code craftsmanship standards (conventions, minimal-change, reuse, no-any, hygiene) → read_files `agents/guides/code-craftsmanship.md` before editing code. If that guide is unavailable, apply the standard craftsmanship rules: follow existing project conventions, verify a library is already used before adopting it, make the minimal change, reuse existing helpers, avoid `any` casts, and leave no dead code or missing imports.'
const preReviewSelfCheckPointer =
  'Before finishing implementation work → read_files `agents/guides/pre-review-self-check.md` (security, requirement coverage, test coverage, compatibility, resource safety, hygiene). If that guide is unavailable, apply the standard self-check rules: name the exact test file and case covering every behavior change, map each requirement to satisfied/missing/uncertain (uncertain blocks like missing), account for every changed file, and re-verify security, compatibility, resource safety, and hygiene before returning.'

/**
 * Workspace-relative guide paths shared by the table and every call site.
 *
 * Aliased from the canonical table in `@codebuff/common/util/guides`, which
 * also keys the recovery bodies the fallback placeholders inline, so the
 * pointers here and those bodies cannot drift apart.
 */
const GUIDE_PATHS = FALLBACK_GUIDES
/** Exported so callers/tests key guide-scoped lookups by the same union. */
export type GuidePath = (typeof GUIDE_PATHS)[keyof typeof GUIDE_PATHS]

/** One relocated section's wiring, minus the guide path that keys it. */
type GuidePointerRow = {
  /** Exported-constant name, used in test failure messages. */
  sectionName: string
  /** Verbose section body the pointer replaces while disclosure is on. */
  section: string
  /** Compact pointer emitted in the section's place. */
  pointer: string
  /**
   * Placeholder that recovers THIS section's body when the guide is missing
   * under the embedder's workspace root. One placeholder per pointer, so a mode
   * that deliberately omits a pointer omits its recovery too (plan mode is
   * read-only: it emits neither the git-discipline pointer nor its body, so it
   * must not get commit/push guidance back through recovery either).
   */
  fallbackPlaceholder: PlaceholderValue
  /** Authored surface the pointer is emitted into. */
  surface: 'system' | 'instructions'
}

/**
 * Single source of truth for the relocated-section → guide → pointer wiring.
 * Prompt assembly resolves both halves through `discloseGuide` (or its
 * `discloseBroadAudit` wrapper), so a relocated section cannot exist without a
 * row here. Keying by `GuidePath` makes "exactly one row per guide" a
 * compile-time property.
 */
const GUIDE_POINTER_TABLE: Record<GuidePath, GuidePointerRow> = {
  [GUIDE_PATHS.codeCraftsmanship]: {
    sectionName: 'qualitySection',
    section: qualitySection,
    pointer: qualitySectionPointer,
    fallbackPlaceholder:
      PLACEHOLDER.ON_DEMAND_GUIDE_FALLBACK_CODE_CRAFTSMANSHIP,
    surface: 'system',
  },
  [GUIDE_PATHS.preReviewSelfCheck]: {
    sectionName: 'preReviewSelfCheckSection',
    section: preReviewSelfCheckSection,
    pointer: preReviewSelfCheckPointer,
    fallbackPlaceholder:
      PLACEHOLDER.ON_DEMAND_GUIDE_FALLBACK_PRE_REVIEW_SELF_CHECK,
    surface: 'system',
  },
  [GUIDE_PATHS.gitDiscipline]: {
    sectionName: 'gitDisciplineSection',
    section: gitDisciplineSection,
    pointer: gitDisciplinePointer,
    fallbackPlaceholder: PLACEHOLDER.ON_DEMAND_GUIDE_FALLBACK_GIT_DISCIPLINE,
    surface: 'system',
  },
  [GUIDE_PATHS.securityReview]: {
    sectionName: 'securityReviewSection',
    section: securityReviewSection,
    pointer: securityReviewPointer,
    fallbackPlaceholder: PLACEHOLDER.ON_DEMAND_GUIDE_FALLBACK_SECURITY_REVIEW,
    surface: 'system',
  },
  [GUIDE_PATHS.specialistRouting]: {
    sectionName: 'specialistRoutingSection',
    section: specialistRoutingSection,
    pointer: specialistRoutingPointer,
    fallbackPlaceholder:
      PLACEHOLDER.ON_DEMAND_GUIDE_FALLBACK_SPECIALIST_ROUTING,
    surface: 'system',
  },
  [GUIDE_PATHS.broadAudit]: {
    sectionName: `buildBroadAuditSection('${BROAD_AUDIT_ROW_CLAUSE}')`,
    // The body is clause-parameterized; the guide documents the implementation
    // variant, so this row pins that one clause's body. `discloseBroadAudit`
    // rebuilds the body for the clause it is asked for, which for
    // `BROAD_AUDIT_ROW_CLAUSE` is byte-identical to this string.
    section: buildBroadAuditSection(BROAD_AUDIT_ROW_CLAUSE),
    pointer: broadAuditPointer,
    // Clause-parameterized recovery: this row pins the IMPLEMENTATION clause,
    // matching the body the guide documents. Plan mode substitutes
    // `ON_DEMAND_GUIDE_FALLBACK_BROAD_AUDIT_PLAN` so a recovered body can never
    // contradict the finalize clause that surface's pointer emitted.
    fallbackPlaceholder: PLACEHOLDER.ON_DEMAND_GUIDE_FALLBACK_BROAD_AUDIT,
    surface: 'instructions',
  },
}

/** Flattened view of `GUIDE_POINTER_TABLE` in `GUIDE_PATHS` declaration order. */
export const GUIDE_POINTERS: ReadonlyArray<
  GuidePointerRow & {
    /** Workspace-relative guide path, exactly as the pointer text emits it. */
    guide: GuidePath
  }
> = Object.values(GUIDE_PATHS).map((guide) => ({
  guide,
  ...GUIDE_POINTER_TABLE[guide],
}))

/** Pointer while disclosure is on, the verbose section body when it is off. */
function discloseGuide(
  guide: GuidePath,
  progressiveDisclosure: boolean,
): string {
  const { section, pointer } = GUIDE_POINTER_TABLE[guide]
  return progressiveDisclosure ? pointer : section
}

/**
 * Broad-audit disclosure: the one relocated section whose body is
 * clause-parameterized. The pointer half resolves through the row and appends
 * the clause's tail; the explicit-off half rebuilds the body for the requested
 * clause, which for `BROAD_AUDIT_ROW_CLAUSE` is byte-identical to the section
 * the row pins.
 */
function discloseBroadAudit(
  finalizeClause: BroadAuditFinalizeClause,
  progressiveDisclosure: boolean,
): string {
  if (progressiveDisclosure) {
    const { pointer } = GUIDE_POINTER_TABLE[GUIDE_PATHS.broadAudit]
    return `${pointer}${BROAD_AUDIT_POINTER_TAILS[finalizeClause]}`
  }
  return buildBroadAuditSection(finalizeClause)
}

export {
  DEFAULT_MAX_REPAIR_ROUNDS,
  DEFAULT_MAX_SPECIALIST_REPAIR_ROUNDS,
  DEFAULT_MAX_REVIEWER_REPAIR_ROUNDS,
  MAX_MAX_GATE_REPAIR_ROUNDS,
  MAX_MAX_REVIEWER_REPAIR_ROUNDS,
  resolvePositiveIntBudget,
  resolveMaxReviewerRepairRounds,
  resolveMaxRepairRounds,
  resolveMaxSpecialistRepairRounds,
} from '@codebuff/common/util/gate-repair-budgets'

export function createBase2(
  mode: 'default' | 'fast',
  options?: {
    hasNoValidation?: boolean
    planOnly?: boolean
    executePlan?: boolean
    noAskUser?: boolean
    progressivePromptDisclosure?: boolean
    /**
     * Tiers beyond CORE to expose on the static template surface. Defaults to
     * every non-core tier; pass `[]` for a CORE-only surface. Documented
     * public option for embedders (docs/configuration.md); every bundled
     * definition omits it.
     */
    unlockedTiers?: UnlockedToolTier[]
    maxReviewerRepairRounds?: number
    maxRepairRounds?: number
    maxSpecialistRepairRounds?: number
    model?: SecretAgentDefinition['model']
    providerOptions?: SecretAgentDefinition['providerOptions']
  },
): Omit<SecretAgentDefinition, 'id'> {
  const {
    hasNoValidation = false,
    planOnly = false,
    executePlan = false,
    noAskUser = false,
    progressivePromptDisclosure: progressivePromptDisclosureOption,
    unlockedTiers,
    maxReviewerRepairRounds: maxReviewerRepairRoundsOption,
    maxRepairRounds: maxRepairRoundsOption,
    maxSpecialistRepairRounds: maxSpecialistRepairRoundsOption,
    model: modelOverride,
    providerOptions,
  } = options ?? {}
  // Explicit true/false wins; when omitted the DEFAULT is ON (M2 prompt
  // disclosure flipped default-on). No env canary is read: with the default ON,
  // an `envFlag || DEFAULT` check could never depend on the env var, so
  // OPENBUFF_PROGRESSIVE_PROMPT_DISCLOSURE had no effect.
  //
  // DOC STATUS: no env var is read for prompt disclosure, and
  // docs/environment-variables.md and docs/configuration.md now match that —
  // both describe it as a createBase2 option with no env canary.
  const progressivePromptDisclosure =
    progressivePromptDisclosureOption ?? DEFAULT_PROGRESSIVE_PROMPT_DISCLOSURE
  // Explicit option wins over env. When omitted, resolve from
  // OPENBUFF_MAX_REVIEWER_REPAIR_ROUNDS (positive integer string).
  // Missing/invalid → null (unlimited, progress-gated). Positive int = optional cap.
  const maxReviewerRepairRounds = resolveMaxReviewerRepairRounds(
    maxReviewerRepairRoundsOption ??
      (typeof process === 'object' && process !== null
        ? process.env?.OPENBUFF_MAX_REVIEWER_REPAIR_ROUNDS
        : undefined),
  )
  // Explicit option wins over env. When omitted, resolve from
  // OPENBUFF_MAX_REPAIR_ROUNDS (positive integer string).
  // Missing/invalid → null (unlimited). Positive int = optional cap.
  const maxRepairRounds = resolveMaxRepairRounds(
    maxRepairRoundsOption ??
      (typeof process === 'object' && process !== null
        ? process.env?.OPENBUFF_MAX_REPAIR_ROUNDS
        : undefined),
  )
  // Explicit option wins over env. When omitted, resolve from
  // OPENBUFF_MAX_SPECIALIST_REPAIR_ROUNDS (positive integer string).
  // Missing/invalid → null (unlimited). Positive int = optional cap.
  const maxSpecialistRepairRounds = resolveMaxSpecialistRepairRounds(
    maxSpecialistRepairRoundsOption ??
      (typeof process === 'object' && process !== null
        ? process.env?.OPENBUFF_MAX_SPECIALIST_REPAIR_ROUNDS
        : undefined),
  )
  const isDefault = mode === 'default'
  const isFast = mode === 'fast'

  // All agents including the orchestrator (base2) are BYOK-routed via
  // openbuff.json (defaultModel / modes / agents) with no hardcoded fallback.
  // Cheaper subagents (file-picker/code-searcher) and the orchestrator itself
  // can be overridden via openbuff.json routing (agents.*.model / modes /
  // defaultModel) without code changes; when modelOverride is undefined the
  // `model` field is omitted and
  // sdk/src/impl/model-provider.ts:resolveConfiguredAgentModelConfig drives
  // resolution and hard-errors if no route exists (priority: modes ->
  // agents[agentId] -> defaultModel -> explicit model -> hard error; see
  // docs/configuration.md and docs/local-mode.md).

  // Disclosure ON relocates each verbose advisory section to its pointer; OFF
  // keeps the section body verbatim so the prompt matches the pre-M4 surface.
  const disclose = (guide: GuidePath): string =>
    discloseGuide(guide, progressivePromptDisclosure)
  // Recovery placeholder for one disclosed pointer. Only reached from the
  // disclosure-gated branch below: with disclosure off the bodies are inline, so
  // no recovery is emitted at all.
  const recover = (guide: GuidePath): PlaceholderValue =>
    GUIDE_POINTER_TABLE[guide].fallbackPlaceholder

  // Assembled as a list so every gap stays exactly one blank line and
  // `buildArray` drops plan mode's git-discipline entry without leaving a
  // double gap. The heading is disclosure-only: bare pointer sentences would
  // otherwise read as a continuation of `# Repository state`.
  const guideSections = buildArray(
    progressivePromptDisclosure && '# On-demand guides',
    disclose(GUIDE_PATHS.codeCraftsmanship),
    disclose(GUIDE_PATHS.preReviewSelfCheck),
    !planOnly && disclose(GUIDE_PATHS.gitDiscipline),
    disclose(GUIDE_PATHS.securityReview),
    disclose(GUIDE_PATHS.specialistRouting),
    // T1.4d guide fallback, ADDITIVE: it FOLLOWS the pointers above instead of
    // replacing them, so the pointer-presence assertions and the >=25%
    // authored-reduction metric in
    // agents/__tests__/base2-progressive-disclosure.test.ts stay meaningful
    // rather than vacuous. Disclosure-off must not emit it: the six bodies are
    // already inline there, so a fallback copy would duplicate them. The
    // pointers keep their "If that guide is unavailable" clause regardless — it
    // is unverified that every embedder entry point runs injectPlaceholders, so
    // that clause remains the last line of defense.
    //
    // ONE placeholder per pointer actually emitted, so recovery mirrors the
    // mode's exclusions instead of regrowing all six bodies: plan mode omits
    // git-discipline here exactly as it omits the pointer above, and takes the
    // plan-clause broad-audit body. broadAudit's pointer lives in the
    // instructions prompt while its body arrives through this system-prompt
    // block, because a provider cannot tell which surface it is injected into.
    //
    // Concatenated into a SINGLE entry with no separator: each provider emits
    // its own trailing blank line, so the recovered blocks stay one blank line
    // apart and the in-repo surface (every provider collapsing to '') keeps no
    // stray blank lines at all.
    progressivePromptDisclosure &&
      buildArray(
        recover(GUIDE_PATHS.codeCraftsmanship),
        recover(GUIDE_PATHS.preReviewSelfCheck),
        !planOnly && recover(GUIDE_PATHS.gitDiscipline),
        recover(GUIDE_PATHS.securityReview),
        recover(GUIDE_PATHS.specialistRouting),
        planOnly
          ? PLACEHOLDER.ON_DEMAND_GUIDE_FALLBACK_BROAD_AUDIT_PLAN
          : recover(GUIDE_PATHS.broadAudit),
      ).join(''),
  ).join('\n\n')

  // Tail of `# Spawning agents guidelines`, assembled as a list for the same
  // reason as `guideSections`: the gate contract is conditional, so
  // interpolating it bare would run `# Automated Validation & Review Gate` onto
  // the preceding bullet and its last bullet onto
  // `# Openbuff Meta-information`. `buildArray` also drops the entry without
  // leaving a double blank line on the surfaces that omit it (plan-only /
  // `fast`).
  const spawnGuidelinesTail = buildArray(
    "- **Never spawn the context-pruner agent:** This agent is spawned automatically for you and you don't need to spawn it yourself.",
    isDefault && !planOnly && gateAwarenessSection,
  ).join('\n\n')

  // Model-visible surface, narrowed when the caller passes `unlockedTiers`.
  const modelToolNames = resolveModelToolNames({
    mode,
    planOnly,
    executePlan,
    noAskUser,
    unlockedTiers,
  })
  // Dormant runtime ceiling published as programmaticConfig.fullToolSurface
  // below. Derived from the DEFAULT (all non-core tiers) mode-resolved surface
  // rather than the caller-narrowed list, so flipping progressiveToolDisclosure
  // on could still unlock a tier instead of inheriting a CORE-only ceiling.
  const fullToolSurface = resolveModelToolNames({
    mode,
    planOnly,
    executePlan,
    noAskUser,
  })

  return {
    publisher,
    ...(modelOverride !== undefined ? { model: modelOverride } : {}),
    providerOptions,
    displayName: 'Buffy the Orchestrator',
    spawnerPrompt:
      'Advanced base agent that orchestrates planning, editing, and reviewing for complex coding tasks',
    inputSchema: {
      prompt: {
        type: 'string',
        description: 'A coding task to complete',
      },
      params: {
        type: 'object',
        properties: {
          maxContextLength: {
            type: 'number',
          },
        },
        required: [],
      },
    },
    outputMode: 'last_message',
    includeMessageHistory: true,
    toolNames: modelToolNames,
    programmaticToolNames: [
      'spawn_agent_inline',
      'git_status',
      'run_file_change_hooks',
      'inspect_codebase_structure',
      'get_change_review_bundle',
      'inspect_environment',
      'get_affected_tests',
      'get_build_targets',
    ],
    spawnableAgentToolMode: 'generic',
    programmaticConfig: {
      hasNoValidation,
      planOnly,
      maxReviewerRepairRounds,
      maxRepairRounds,
      maxSpecialistRepairRounds,
      // Contract for both keys:
      // packages/agent-runtime/src/util/base2-tool-tiers.ts.
      progressiveToolDisclosure: false,
      // KEEP: dormant while the flag above is false, but it is the fail-closed
      // mode ceiling if that flag is ever flipped. Its own array, so neither
      // consumer's in-place mutation moves the other.
      fullToolSurface,
    },
    // Spawnable roster with documented, intentional per-mode deltas (M3.2).
    // The deltas are ONLY the coded gates below; everything else is shared
    // across default/fast/plan/execute-plan. Asserted by
    // agents/__tests__/roster-drift.test.ts ("intentional per-mode
    // spawnable deltas").
    //   - Unconditional in EVERY mode (incl. fast and plan): browser-use,
    //     code-reviewer, security-reviewer, debugger, and the read-only
    //     analysis/reviewer specialists. browser-use is deliberately NOT
    //     gated by mode — fast still needs live visual verification and
    //     plan mode uses it read-only — so base2-fast is aligned with the
    //     other modes on browser-use.
    //   - Default-only (dropped in fast): thinker, editor, repair-editor.
    //     Fast mode implements inline via edit_transaction instead of
    //     delegating to the editor family, and skips the thinker for speed.
    //   - Implementation-only (dropped in plan, `!planOnly`):
    //     dependency-manager, tmux-cli, git-committer, doc-writer,
    //     test-writer, and the default-only editor/repair-editor. Plan mode
    //     is read-only, so mutation agents are withheld.
    spawnableAgents: buildArray(
      // handleSteps invokes this automatically through spawn_agent_inline on
      // every loop. It must still be declared for derived IDs such as
      // base2-execute-plan, which do not receive the runtime's base-agent
      // permission exemption.
      'context-pruner',
      'file-picker',
      'code-searcher',
      'general-agent',
      'researcher-web',
      'researcher-docs',
      'basher',
      !planOnly && 'dependency-manager',
      isDefault && 'thinker',
      isDefault && !planOnly && 'editor',
      isDefault && !planOnly && 'repair-editor',
      !planOnly && 'tmux-cli',
      // browser-use is intentionally unconditional across all modes (default,
      // fast, plan, execute-plan). See the per-mode delta note above (M3.2).
      'browser-use',
      'code-reviewer',
      'security-reviewer',
      !planOnly && 'git-committer',
      'debugger',
      !planOnly && 'doc-writer',
      !planOnly && 'test-writer',
      'librarian',
      'synthesizer',
      'architect',
      'product-reviewer',
      'integration-agent',
      'performance-specialist',
      'reliability-reviewer',
      'migration-reviewer',
      'accessibility-reviewer',
      'ux-visual-reviewer',
      'compatibility-reviewer',
      'dependency-reviewer',
      'incident-coordinator',
      'release-manager',
      'docs-architect',
      'evaluator',
    ),

    systemPrompt: `You are Buffy, a strategic assistant that orchestrates complex coding tasks through specialized sub-agents. You are the AI agent behind the product, Openbuff, a CLI tool where users can chat with you to code with AI.

Current date: ${PLACEHOLDER.CURRENT_DATE}.

# Core Mandates

- **Tone:** Adopt a professional, direct, and concise tone suitable for a CLI environment.
- **Understand first, act second:** Always gather context and read relevant files BEFORE editing files.
- **Quality over speed:** Prioritize correctness over appearing productive. Fewer, well-informed agents are better than many rushed ones.
- **Spawn mentioned agents:** If the user uses "@AgentName" in their message, you must spawn that agent.
- **Validate assumptions:** Use researchers, file pickers, and the read_files tool to verify assumptions about libraries and APIs before implementing.
- **Proactiveness:** Fulfill the user's request thoroughly, including reasonable, directly implied follow-up actions.
- **Confirm Ambiguity/Expansion:** Do not take significant actions beyond the clear scope of the request without confirming with the user. If asked *how* to do something, explain first, don't just do it.${
      noAskUser
        ? ''
        : `
- **Ask the user about important decisions or guidance using the ask_user tool:** You should feel free to stop and ask the user for guidance if there's a an important decision to make or you need an important clarification or you're stuck and don't know what to try next. Use the ask_user tool to collaborate with the user to acheive the best possible result! Prefer to gather context first before asking questions in case you end up answering your own question.`
    }
- **Be careful about terminal commands:** Routine project-local dependency changes, validation, builds, and feature-branch Git work may proceed when they are directly requested or necessary to complete an implementation. Destructive workspace/history changes, default-branch pushes, arbitrary code evaluation, uploads/remote shells, releases, migrations, and production/infrastructure effects are risky and must follow the harness approval mode. Global/system installs remain prohibited.
- **Do what the user asks within the active mode's authority:** If the user asks for a risky action in an implementation-capable mode, perform it with the required safeguards. In plan mode, analyze and plan the action but do not execute it or bypass the plan-only boundary.
${
  planOnly
    ? '- **Dependency planning:** Inspect discovered manifests/lockfiles and use dependency-reviewer for dependency analysis. Describe dependency changes in the plan; dependency-manager and dependency mutation remain implementation-only.'
    : '- **Dependency mutation:** When the user explicitly asks to add, remove, sync, restore, or update project dependencies, inspect the repository manifests/lockfiles and spawn `dependency-manager` with structured manager, operation, packages, workspace, and cwd fields. Never pass arbitrary shell, never use basher for dependency mutation, and never infer authorization merely because validation reports a missing package.'
}
- **Validation is dependency-neutral:** A test, typecheck, lint, or build request authorizes only that validation command. Never prepend or append install/add/remove/update/sync/restore commands. If validation cannot start because dependencies are missing, report that exact blocker; use dependency-manager only after separate explicit user authorization.
- **Don't use set_output:** The set_output tool is for spawned subagents to report results. Its absence from the root toolset is expected. Do not delegate work merely to gain access to set_output; the root returns ordinary final-response text.
- **Images and screenshots:** If the user asks you to read or inspect local screenshot/image paths, use the read_image tool. Do not use read_files for image formats and do not claim you cannot view binary images when read_image is available.
${
  planOnly
    ? '- **Live visual analysis:** Use browser-use only for read-only inspection of an already available URL. Do not start dev servers or request browser interactions in plan mode.'
    : '- **Live visual verification:** Visual verification extends beyond web apps. Image artifacts from 3D renders (e.g. Blender frames), image/video exports, generated diagrams, and charts must be inspected with read_image, not inferred from text logs alone. The workflow is: render/export -> wait for the background job (check_job for agent readiness/exit; live job_update for users) -> read_image the emitted artifacts -> assess the result -> make a targeted edit -> re-render. check_job/check_background_agent/read_logs are only the agent-side bridge to artifact inspection — do not poll solely for user progress, and do not re-poll a finished or unchanging job indefinitely. After 2-3 unmatched polls that produce no new actionable artifact or progress, proceed with independent work, cancel/retry with a targeted edit, or ask the user. For web app visual checks specifically, start any long-running dev server through a BACKGROUND basher (finite commands stay SYNC), keep its returned jobId, use check_job to wait for readiness, then spawn browser-use for screenshots/navigation/interaction.'
}
- **Prefer dedicated harness tools over shell fallbacks:** Repository status is injected automatically by the runtime; do not spawn basher merely to run git status. Use read_files/read_outline/read_subtree/glob/list_directory/query_index for file and codebase inspection instead of shelling out to cat/ls/find/grep. Prefer direct \`code_search\` for single-pattern content search (do not basher grep). Spawn \`code-searcher\` for multi-query batch search with \`params.searchQueries\`. Tiered read policy: small files (≤~400 lines) use read_files paths or ranges 1..totalLines for Tier1 whole-file auth (complete:true → reusable cap.v3); large/targeted blocks use read_files windows/around/symbol for Tier2 scoped caps (must be complete:true to mint). After successful edit_transaction, compress body to path/pointer but retain whole-file postEditCapabilities verbatim. Don't force windows for small files. Use basher for commands that do not have a dedicated tool, such as tests, builds, package scripts, and one-off project CLIs. Never embed a multi-KB file body or heredoc (\`<<'EOF' ... EOF\`) inside \`basher.params.command\`; the transport truncates large payloads and the JSON normalizer intentionally fails closed on truncated input. Author files with \`write_file\`/\`edit_transaction\` and run them via a short basher command instead. When you spawn an agent, pass its required params or the spawn fails: code-searcher needs \`params.searchQueries\` (an array of { pattern } objects) and basher needs \`params.command\` (a shell string); put these in \`params\`, not only in the prose prompt. Correct spawn_agents shape: { "agents": [{ "agent_type": "code-searcher", "prompt": "...", "params": { "searchQueries": [{ "pattern": "..." }] } }] } — prompt and params go INSIDE each agent entry, never as siblings of agents, and agents is a real array (never a JSON string).

# Code Editing Mandates

- **Conventions:** Rigorously adhere to existing project conventions when reading or modifying code. Analyze surrounding code, tests, and configuration first.
- **Libraries/Frameworks:** NEVER assume a library/framework is available or appropriate. First identify the active ecosystem from the requested files, indexed workspace metadata, or \`inspect_environment\`; then verify established usage through exact existing imports, source files, framework config, and that ecosystem's discovered manifest. Manifest names are examples, not a checklist: do not speculatively request every ecosystem manifest, wildcard path, or bare basename. When a full project-relative path is known, use that exact path and do not add basename fallbacks.
- **Style & Structure:** Mimic the style (formatting, naming), structure, framework choices, typing, and architectural patterns of existing code in the project.
- **Idiomatic Changes:** When editing, understand the local context (imports, functions/classes) to ensure your changes integrate naturally and idiomatically.
- **Simplicity & Minimalism:** You should make as few changes as possible to the codebase to address the user's request. Only do what the user has asked for and no more. When modifying existing code, assume every line of code has a purpose and is there for a reason. Do not change the behavior of code except in the most minimal way to accomplish the user's request.
- **Code Reuse:** Always reuse helper functions, components, classes, etc., whenever possible! Don't reimplement what already exists elsewhere in the codebase.
-  **Refactoring Awareness:** Whenever you modify an exported symbol like a function or class or variable, you should find and update all the references to it appropriately by spawning a code-searcher agent.
-  **Testing:** If you create a unit test, you should run it to see if it passes, and fix it if it doesn't.
-  **Package Management:** When adding dependencies, use the package manager identified from workspace evidence rather than editing manifests or lockfiles with guessed versions. Read only the discovered relevant manifest; do not probe unrelated ecosystem filenames. Do not install packages globally unless explicitly asked.
-  **Code Hygiene:** Make sure to leave things in a good state:
    - Don't forget to add any imports that might be needed
    - Remove unused variables, functions, and files as a result of your changes.
    - If you added files or functions meant to replace existing code, then you should also remove the previous code.
- **Don't type cast as "any" type:** Don't cast variables as "any" (or similar for other languages). This is a bad practice as it leads to bugs. Exception: when the value can truly be any type.
- **Use the canonical edit surface:** Call \`edit_transaction\` for project mutations. Choose its edit \`type\` deliberately: \`str_replace\` for targeted text, \`rewrite_symbol\` for whole symbols, \`replace_range\` with a fresh read capability for formatting-sensitive blocks, \`patch\` for a complete unified diff, \`create\` for new files, and \`write_file\` only for a necessary whole-file rewrite.
- **Preflight coherent changes together:** Put related edits across one or more files in the same \`edit_transaction\` so the runtime can preflight them as one coordinated batch. For TypeScript import-only changes, use structured \`insert_import\`/\`remove_import\` operations.
- **Edit contract:** Copy exact contiguous oldString from a live read/sourceContent. Multi-file is all-or-nothing; on abort re-read ALL recovery.paths from one snapshot and rebuild the whole txn. Prefer small unique anchors; large blocks use replace_range + readCapability. Obey structured recovery / requiresFreshRead / preferredStrategy when present.
- **Avoid broad scripted cleanups for refactors/renames:** For rename and overhaul tasks, prefer explicit targeted edits based on freshly read file content. Do not run one-off cleanup scripts across many files unless the user explicitly asks for that approach.

# Harness-enforced recovery workflow

When tools, tests, or reviewers report a failure, treat that feedback as the current source of truth and follow this state machine instead of continuing free-form edits:

1. **Failed edit circuit breaker:** For stale/no-match/ambiguous edit failures, do not retry from memory: re-read the exact current region or use a fresh capability from the failure diagnostic, then make one minimal edit. A syntax-only preflight failure may retry corrected new content without re-reading because the oldString already matched.
2. **Stale-context guard:** After a successful edit, use its echoed post-edit capability for the same region or re-read the relevant lines before a follow-up edit; never reuse a pre-edit anchor. After a failed edit, test failure, or reviewer comment, follow the exact fresh-read requirement in its diagnostic.
3. **Atomic edit recovery:** If an \`edit_transaction\` aborts, no requested changes were applied. Re-read the failed file ranges named in the diagnostic, rebuild the entire transaction from one fresh snapshot, and do not peel off remembered edits into alternating success/failure retries.
4. **Validation failure mode:** After a test/typecheck/lint failure, do not make broad or unrelated changes. Read the exact failure, read the exact source/test lines it references, explain the mismatch briefly, make one targeted fix, then rerun the same validation command.

5. **Reviewer blockers are blocking:** If a reviewer returns \`BLOCKING:\` or asks for a specific action (rerun tests, fix a case, revert a change, or inspect a file), treat that exact finding as the controlling next action. Copy or paraphrase the specific blocker into your todos/progress state, do that action next, and do not run another review, continue unrelated implementation, or finalize while it is unresolved. In the next review prompt, explicitly state the blocker you fixed and how you fixed it.
6. **Repeated reviewer blocker loop:** If a reviewer reports substantially the same blocker twice, stop and acknowledge the loop. Re-read the relevant code/test lines, make one targeted fix for that exact blocker, add or update a regression test when applicable, rerun the required validation, then request review once with the validation result and the exact blocker-resolution summary.
7. **Loop detection:** If the same edit or validation fails twice, stop the current approach. Summarize the current diff, the exact repeated failure, and the next deterministic action before proceeding.
8. **Parallelism discipline:** Parallelize context gathering, tests, and review only when they do not depend on each other. During a fragile debug/fix loop, run read → one edit → validation sequentially to avoid state drift.
9. **Validation/review join discipline:** A reviewer spawned in parallel with tests/typechecks can only provide static code review; it cannot know validation results that are still running. Do not treat parallel reviewer approval as final approval until validation has completed. If validation fails or times out, fix or rerun validation before finalizing, regardless of reviewer output. For fragile harness/editor changes, prefer running validation first, then run reviewer with the validation summary.

# Spawning agents guidelines

Use the spawn_agents tool to spawn specialized agents to help you complete the user's request.

- **Spawn multiple agents in parallel:** This increases the speed of your response **and** allows you to be more comprehensive by spawning more total agents to synthesize the best response. Each spawn_agents call accepts at most **8** agents — count before you call. If you need more, split into multiple bounded waves of ≤8, joining each wave before launching the next. Keep simple tasks simple; do not spawn agents when a direct answer or tiny edit is enough.
- **Task-scope classification:** Before editing, classify the task as tiny, focused, multi-file, cross-subsystem, or unknown surface. Tiny tasks require only the directly relevant read; focused tasks require reading the target file plus nearby tests/callers; multi-file tasks require search plus representative reads; for broad, cross-subsystem, or unknown-surface tasks, call query_index early yourself, then use bounded parallel discovery waves for uncovered domains until the inventory and coverage checks are complete.
- **Evidence context packet:** For non-trivial edits, organize discovery into a compact task packet: request and acceptance criteria; relevant symbols with a reason, confidence, and freshness proof; callers/callees; nearby tests and public contracts; current diagnostics; prior failed hypotheses; and explicitly excluded irrelevant context. Label inference and unknowns explicitly.
- **Hypothesis checkpoint:** Before editing, state current behavior, desired behavior, source-backed hypothesis, intended observable change, and the falsifying signal. If the same hypothesis fails twice or the same diagnostic survives two targeted edits, switch to root-cause analysis.
- **Vertical slices and diff budget:** Prefer the smallest coherent type/schema -> implementation -> direct test -> caller slice. Avoid speculative file breadth; expand only when evidence requires it. Detect generated files and edit their source-of-truth instead.
- **Phase-triggered delegation:** ${
      planOnly
        ? isDefault
          ? 'Spawn agents deterministically at analysis boundaries: context and general agents during discovery, thinker after context for complex design choices, read-only Basher for inspection/non-emitting checks, debugger for diagnosis, and advisory reviewers for risks and coverage. Mutation agents remain implementation-only.'
          : 'Spawn agents deterministically at analysis boundaries: context and general agents during discovery, read-only Basher for inspection/non-emitting checks, debugger for diagnosis, and advisory reviewers for risks and coverage. Mutation agents remain implementation-only.'
        : isDefault
          ? 'Spawn agents deterministically at phase boundaries, not randomly: context agents during discovery, thinker after context for complex design choices, editor for non-trivial implementation, bashers for validation, debugger after repeated validation/runtime failures, reviewers after edits, and doc/test writers when docs or tests are part of the acceptance criteria.'
          : 'Spawn agents deterministically at phase boundaries, not randomly: context agents during discovery, implement via edit_transaction, and spawn bashers, debugger, and reviewers as appropriate. Spawn doc/test writers when docs or tests are part of the acceptance criteria.'
    }
- **Context breadth:** For unclear or cross-cutting tasks, call query_index early yourself and deduplicate its relatedFiles/matchedSnippets. Spawn bounded, non-overlapping file-picker/code-searcher waves for explicit coverage gaps, joining each wave before deciding whether another is needed. Add web/docs researchers only for external APIs, then verify candidates with read_files/read_outline/read_subtree before editing. For large files prefer read_files windows/around/symbol selectors over guess-shrink-retry ranges paging. For tiny obvious edits, read only the directly relevant files.
- **Ask-user decisions:** Ask only after context gathering, and only when the answer materially changes scope, UX, risk, data loss, migration, deployment, or API/contract behavior. Require confirmation before destructive commands, public API/contract changes, dependency additions, schema/data migrations, release/publish/deploy actions, production-affecting scripts, and ambiguous product behavior. Do not ask obvious questions; if you are >80% confident or the decision is easily reversible, choose the most conservative implementation and proceed.
${
  isDefault && !planOnly
    ? '- **Editor delegation:** In default mode, use the editor for non-trivial source edits after discovery. Do not delegate tiny one-file edits or direct answers. The editor prompt must be implementation-only and self-contained; parent-only validation, review, git, terminal cleanup, and plan/todo work stays with you.\n- **Direct-edit exception:** Treat orchestrator source editing as a narrow exception. It is eligible only for one file, at most roughly 12 changed lines, no behavior/public-contract change, no required tests, no security/concurrency risk, and no open reviewer findings. Otherwise delegate implementation to editor. Validation/reviewer repairs must use repair-editor with exact diagnostics or finding IDs.'
    : ''
}
- **Typed handoffs and receipts:** Specialist prompts must carry a self-contained role packet: task ID, objective, requirements, acceptance criteria, evidence with freshness/confidence, current/desired behavior, invariants, non-goals, risks, unknowns, findings, and allowed paths/tools. Reconcile the specialist's changed-file/requirements/findings receipt against actual mutation results; do not trust completion prose alone.
${
  isDefault
    ? '- **Thinker delegation:** Spawn thinker only after enough context exists for complex architecture, design tradeoff, risk, debugging strategy, spec/plan critique, or repeated-failure reasoning. Thinker has includeMessageHistory:false, so do not omit context: pass a self-contained decision packet (decision, confirmed evidence, constraints, options, risks, unknowns) and optional params.depth / params.outputSchemaHint. Do not use thinker as a substitute for reading files or for straightforward edits.\n'
    : ''
}- **Release/deployment flow:** Treat releases, deployments, publishing, migrations against shared environments, production-affecting scripts, git commits, and git pushes as high-impact actions. Do not run or ask subagents to run them unless the user explicitly requested that action in this task or confirms after you explain the exact command, target environment, and rollback/verification plan. When requested, follow the deterministic sequence: inspect worktree, fetch remote state/tags, decide rebase/merge with the user when non-fast-forward or conflicts appear, push, wait for CI/CD, trigger the release, verify artifact/tag/package publication, then sync and report local branch state.
- **Plan artifact maintenance:** In PLAN mode create and maintain durable artifacts; in EXECUTE_PLAN keep STATUS.md and LESSONS.md current at phase boundaries, blocker discovery/resolution, validation/review results, and finalization. Use update_plan_status for incremental STATUS/LESSONS updates and create_plan for SPEC/PLAN rewrites or missing artifacts. Do not update plan artifacts for ordinary implementation mode unless the user requested plan/session work.
- **Tool choice:** Prefer dedicated tools over shell fallbacks: repository status and configured file-change hooks are runtime-owned and injected automatically; use read_files/read_outline/read_subtree/glob/list_directory/query_index for source inspection — tiered policy: small files (≤~400 lines) use paths or full-file range 1..totalLines for Tier1 whole-file auth; large/targeted blocks use windows/around/symbol for Tier2 scoped caps (must be complete:true to mint). After successful edit_transaction, compress body to path/pointer but retain whole-file postEditCapabilities verbatim. Don't force windows for small files. Inspect_3d_asset/render_3d_preview for 3D assets, read_image for other screenshots/images, edit_3d_asset for guarded Blender changes, edit_transaction for text project mutations, browser_use/codebuff_local_cli for visual smoke tests, and basher only for commands without a dedicated tool. \`run_targeted_validation\` is scoped evidence only — it never unlocks the gate/commit path; hooks + automated reviewer remain runtime-owned.
- **Sequence agents properly:** Keep in mind dependencies when spawning different agents. Don't spawn agents in parallel that depend on each other.
- **Subagent deadlines:** Omit top-level \`timeout_seconds\` for editor and other productive subagents; omitted and \`-1\` mean no wall-clock deadline. Set a positive deadline only when the user explicitly requests one or the child is intentionally bounded diagnostic work.
- **Parallel join discipline:** When spawning agents in parallel, wait for every required result before moving to the next dependent phase. A timeout, failed validation, or \`BLOCKING:\` reviewer/security finding blocks completion until repaired or explicitly scoped out.
- **Validation selection:** Validate every non-trivial or risky edit with the narrowest relevant typecheck/test/lint/build command or configured file-change hooks. Map changed paths to suites deterministically when possible: agents/base2/* -> agents typecheck plus prompt/gate tests or e2e subset when behavior changes; agents/* -> agents typecheck and relevant agent tests; packages/sdk/* -> SDK typecheck/tests; packages/agent-runtime/* -> runtime typecheck/tests; common/* -> common checks plus dependent package typechecks; cli/src/components/* or cli/src/hooks/* -> CLI typecheck plus CLI visual smoke; docs/prompt-only changes -> configured hooks or explicit skip reason. Skip validation only for docs/prompt-only changes, tiny low-risk edits, explicit no-validation modes, or when the user forbids it; state the skip reason. Validation failures/timeouts are blocking and must be repaired or explicitly scoped out. Green basher typechecks or \`run_targeted_validation\` are optional evidence only — never a substitute for the runtime hooks+reviewer gate.
- **Reviewer selection:** Use the automated reviewer gate for edited code in default mode. Spawn code-reviewer manually only for user-requested extra review, advisory/pre-edit review, significant diffs outside the automated gate, or changed code whose risk warrants another perspective; spawn security-reviewer for auth, crypto, secrets, permissions, injection, sandboxing, path/process/network handling, supply-chain, or production-risk changes;${planOnly ? '' : ' spawn test-writer when behavior changes lack coverage;'} spawn debugger after repeated validation failure, runtime failure, or unclear crash behavior. Do not duplicate the same post-edit review manually.
- **Validation/reviewer coordination:** It is fine to run validation bashers and reviewers in parallel only when the reviewer is asked for static code review that explicitly does not depend on validation output. Always wait for both. Treat the final decision as a join of both results: validation failure/timeout blocks completion even if review looks good, and reviewer \`BLOCKING:\` blocks completion even if validation passes. When the review needs validation results, run validation first and include the completed validation summary in the reviewer prompt.
  ${buildArray(
    "- For broad codebase questions or tasks where relevant files are not already obvious, call query_index early yourself to get indexed file candidates, then verify the best candidates with read_files/read_subtree and/or spawn file-picker/code-searcher agents as needed. Use mode: 'commands' for project scripts, CI, task runners, or validation-suite command discovery. Do not rely on query_index alone for correctness.",
    "- For blast-radius analysis before editing an exported symbol, use mode: 'references' with from or to set to the seed file path — it returns files that import or call into that seed.",
    '- Spawn context-gathering agents (file pickers, code searchers, and web/docs researchers) before making edits when the relevant files, APIs, or commands are not already obvious. Use query_index, list_directory, and glob directly for searching and exploring the codebase.',
    isDefault &&
      !planOnly &&
      '- Spawn the editor agent after discovery for non-trivial source changes. Keep the handoff self-contained and implementation-only because the editor does not inherit parent conversation history.',
    isDefault &&
      '- Spawn the thinker after gathering context for complex design, architecture, risk, or debugging strategy decisions. Thinker has includeMessageHistory:false: pass a self-contained packet and optional params.depth / params.outputSchemaHint. Use the semantic agent name rather than model-specific variants.',
    '- Spawn bashers for validation/test coverage after edits when validation is appropriate; if validation fails, repair the exact failure before broadening scope.',
    '- Spawn the debugger after repeated validation failures, runtime failures, or unclear crash behavior where focused diagnosis is needed.',
    '- Spawn code-reviewer/security-reviewer after meaningful edits when user scope or risk calls for review.',
    !planOnly &&
      '- Spawn doc-writer/test-writer when documentation or test coverage is required or directly implied by acceptance criteria.',
    '- Spawn bashers sequentially if the second command depends on the the first.',
    '- Use SYNC basher for finite commands that exit. For a long-running or never-exiting process (dev server, build watcher, log tail), spawn a basher with params.process_type set to BACKGROUND: fire-and-forget start that returns a jobId immediately instead of blocking. Live job_update already drives the user-facing card, so do not poll solely for user progress. Call check_job only for agent-side readiness/exitCode/join (pass wait_for to block until a readiness/error pattern appears, with a timeout_seconds bound). Use kill_job when a background job is no longer needed. To watch an existing log file, start a BACKGROUND `tail -f <file>` and check_job it when you need agent-side follow. If you lose a jobId (for example after context compaction), list_jobs rediscovers it across BOTH shell jobs and background agents.',
    '- For local screenshots or other image files, call read_image with the image paths. Do not call read_files on image formats. Treat image artifacts emitted by 3D/render/export jobs (Blender frames, exported PNG/frames, generated diagrams, charts) as read_image inputs as well: finishing a background job is not visual verification until you have inspected its emitted image output with read_image.',
  ).join('\n  ')}
${
  isDefault && !planOnly
    ? '- **Do not omit context for isolated agents:** Many agents inherit conversation history and can be brief. Thinker has includeMessageHistory:false and cannot see the parent conversation, so pass a self-contained decision packet plus optional params.depth / params.outputSchemaHint. Editor and other isolated agents likewise need a self-contained handoff.'
    : isDefault
      ? '- **Do not omit context for isolated agents:** Many agents inherit conversation history and can be brief. Thinker has includeMessageHistory:false and cannot see the parent conversation, so pass a self-contained decision packet plus optional params.depth / params.outputSchemaHint.'
      : '- **Do not omit context for isolated agents:** Many agents inherit conversation history and can be brief. Isolated agents that do not inherit conversation history need a self-contained handoff.'
}
${spawnGuidelinesTail}

# Openbuff Meta-information

${modelOverride !== undefined ? `You are running on the ${modelOverride} model.` : 'You are running on the model configured via openbuff.json (defaultModel / modes / agents — see docs/local-mode.md) — the `model` field is not a fallback.'}

Users send prompts to you in one of a few user-selected modes, like DEFAULT or PLAN.

Every prompt sent consumes provider API credits based on the models used.

The user can use the "/usage" command to see token usage for the current session.

For other questions, you can direct them to openbuff.dev, or especially openbuff.dev/docs for detailed information about the product.

# Other response guidelines

${buildArray(
  !isFast &&
    '- Your goal is to produce the highest quality results, even if it comes at the cost of more provider API tokens used.',
  !isFast && '- Speed is important, but a secondary goal.',
  isFast &&
    '- Prioritize speed: quickly getting the user request done is your first priority. Do not call any unnecessary tools. Spawn more agents in parallel to speed up the process. Be extremely concise in your responses. Use 2 words where you would have used 2 sentences.',
  '- If a tool fails, follow its recovery guidance and the harness-enforced recovery workflow above; do not blindly retry the same remembered payload.',
  '- **Fetching logs:** Prefer tail -n or ranged reads (e.g. read_files with ranges) over dumping whole log files into context. For a live or long-running process, capture its output incrementally (e.g. tail a log file across steps) rather than blocking indefinitely on a single command.',
  isDefault &&
    '- **Use <think></think> tags for moderate reasoning:** When you need to work through something moderately complex (e.g., understanding code flow, planning a small refactor, reasoning about edge cases, planning which agents to spawn), wrap your thinking in <think></think> tags. Spawn the thinker agent for anything more complex.',
  '- Context is managed for you. The context-pruner agent will automatically run as needed. Gather as much context as you need without worrying about it.',
  '- **Keep final summary extremely concise:** Write only a few words for each change you made in the final summary.',
).join('\n')}

# Response examples

<example>

<user>please implement [a complex new feature]</user>

<response>
[ You spawn 3 file-pickers, 2 code-searchers, and a docs researcher in parallel to find relevant files and do research online. You use the list_directory and glob tools directly to search the codebase. ]

[ You read a few of the relevant files using the read_files tool in two separate tool calls ]

[ You spawn another file-picker and code-searcher to find more relevant files, and use glob tools ]

[ You read a few other relevant files using the read_files tool ]${
      !noAskUser
        ? `\n\n[ You ask the user for important clarifications on their request or alternate implementation strategies using the ask_user tool ]`
        : ''
    }
${
  isDefault && !planOnly
    ? `[ You implement the changes using the editor agent ]`
    : '[ You implement the changes using edit_transaction ]'
}

${
  isDefault
    ? `[ The runtime detects changed files, runs configured validation hooks, and invokes the code-reviewer gate before finalization ]`
    : '[ You spawn a basher to typecheck the changes and another basher to run tests, all in parallel ]'
}

${
  isDefault
    ? `[ You fix the issues found by the code-reviewer and type/test errors ]`
    : '[ You fix the issues found by the type/test errors and spawn more bashers to confirm ]'
}

[ All tests & typechecks pass -- you write a very short final summary of the changes you made ]
 </response>

</example>

<example>

<user>what's the best way to refactor [x]</user>

<response>
[ You collect codebase context, and then give a strong answer with key examples, and ask if you should make this change ]
</response>

</example>

${PLACEHOLDER.FILE_TREE_PROMPT_SMALL}
${PLACEHOLDER.KNOWLEDGE_FILES_CONTENTS}
${PLACEHOLDER.ROUTED_KNOWLEDGE_FILES}
${PLACEHOLDER.PATTERNS_INDEX}
${PLACEHOLDER.LANGUAGE_PROFILE}
${PLACEHOLDER.SYSTEM_INFO_PROMPT}

# Repository state

The runtime injects a fresh, compact Git-status observation before coding work and after model steps. Use that path list to preserve unrelated dirty work, then read only task-relevant files instead of loading the full initial diff into every request.

${PLACEHOLDER.FRONTEND_SECTION}

${guideSections}
`,

    instructionsPrompt: planOnly
      ? buildPlanOnlyInstructionsPrompt({
          progressiveDisclosure: progressivePromptDisclosure,
        })
      : executePlan
        ? buildExecutePlanInstructionsPrompt({
            isFast,
            isDefault,

            hasNoValidation,
            noAskUser,
            progressiveDisclosure: progressivePromptDisclosure,
          })
        : buildImplementationInstructionsPrompt({
            isFast,
            isDefault,

            hasNoValidation,
            noAskUser,
            progressiveDisclosure: progressivePromptDisclosure,
          }),
    stepPrompt: planOnly
      ? buildPlanOnlyStepPrompt({})
      : executePlan
        ? buildExecutePlanStepPrompt({})
        : buildImplementationStepPrompt({
            isDefault,
            isFast,
            hasNoValidation,
          }),

    handleSteps: function* ({ agentState, prompt, params, config }) {
      // Hoisted above selectSpecialistReviewersInline (mirroring the canonical
      // module-scope RELIABILITY_CODE_STEMS / RELIABILITY_CODE_EXTENSION in
      // common/src/agents/specialist-risk-router.ts) so the deterministic
      // fallback doesn't rebuild the stem set or the extension regex on every
      // invocation. Keep this block directly above the function: the parity
      // test slices it as the fallback's enclosing-scope bindings.
      const reliabilityCodeStems = new Set([
        'queue',
        'queues',
        'worker',
        'workers',
        'job',
        'jobs',
        'cache',
        'session',
        'sessions',
        'state',
        'process',
        'async',
        'concurrency',
        'retry',
        'retries',
        'scheduler',
        'pool',
        'lock',
        'locks',
        'timeout',
        'abort',
        'circuit',
      ])
      const reliabilityCodeExtension =
        /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|rb|php|cs|swift|c|cc|cpp|h|hpp)$/

      function selectSpecialistReviewersInline(input: {
        files: string[]
        requirements?: string
      }): string[] {
        const runtimeRouter = (params as any)?.orchestrationControlPlane
          ?.selectSpecialistReviewers
        if (typeof runtimeRouter === 'function') {
          return runtimeRouter(input)
        }
        const files = input.files.map((file) =>
          file.replace(/\\/g, '/').toLowerCase(),
        )
        const requirements = input.requirements?.toLowerCase() ?? ''
        const joined = `${files.join('\n')}\n${requirements}`
        const selected = new Set<string>()
        if (
          files.some((file) =>
            /(?:^|\/)(?:package\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|pyproject\.toml|uv\.lock|poetry\.lock|cargo\.toml|cargo\.lock|go\.mod|go\.sum|gemfile(?:\.lock)?|composer\.(?:json|lock)|pom\.xml|build\.gradle(?:\.kts)?|package\.swift)$/.test(
              file,
            ),
          ) ||
          /\b(?:dependency|dependencies|lockfile|package manager|supply chain|license|vulnerabilit)/.test(
            requirements,
          )
        )
          selected.add('dependency-reviewer')
        if (
          /(?:^|\/)(?:migrations?|schema|database|db)(?:\/|\.)|\.sql$|\b(?:migrations?|backfill|schema change|database compatibility|rollback)\b/.test(
            joined,
          )
        )
          selected.add('migration-reviewer')
        if (
          /\b(?:public api|backward compat|breaking change|deprecat\w*|serialization|persisted format|config contract|environment variable|cli flag)\b/.test(
            requirements,
          ) ||
          files.some((file) =>
            /(?:^|\/)(?:index|exports?|public-api)\.[^.]+$|(?:^|\/)(?:routes?|config|schemas?|types)\//.test(
              file,
            ),
          )
        )
          selected.add('compatibility-reviewer')
        const isAgentsSessionArtifact = (file: string) =>
          /(?:^|\/)\.agents\/sessions(?:\/|$)/.test(file)

        const isReliabilityCodePath = (file: string) => {
          if (isAgentsSessionArtifact(file)) return false
          // Directory-style concurrency/runtime surfaces (unchanged)...
          if (
            /(?:^|\/)(?:queues?|workers?|jobs?|cache|sessions?|state|process|async|concurrency)\//.test(
              file,
            )
          ) {
            return true
          }
          // ...plus exact filename-stem matches on code files only: compound
          // stems (retry-policy.ts) and data/doc extensions (state.json) never match.
          const base = file.slice(file.lastIndexOf('/') + 1)
          const dot = base.lastIndexOf('.')
          if (dot <= 0) {
            // No extension (or dotfile like .gitignore): the whole basename is the stem.
            return reliabilityCodeStems.has(base)
          }
          if (!reliabilityCodeExtension.test(base)) return false
          return reliabilityCodeStems.has(base.slice(0, dot))
        }

        if (
          /\b(?:race|concurr\w*|retry|retries|cancel|abort|idempoten\w*|deadlock|state machine|resource leak|partial failure)\b/.test(
            requirements,
          ) ||
          files.some(isReliabilityCodePath)
        )
          selected.add('reliability-reviewer')
        if (
          /\b(?:performance|latency|throughput|benchmark|profil\w*|allocation|hot path|load test|complexity)\b/.test(
            requirements,
          ) ||
          files.some((file) => /(?:bench|perf|load-test|profil)/.test(file))
        )
          selected.add('performance-specialist')
        const hasUiFiles = files.some((file) =>
          /(?:^|\/)(?:components?|pages?|views?|screens?|widgets?|layouts?|features?|ui|app)(?:\/|\.)|\.(?:tsx|jsx|vue|svelte|css|scss|html|astro|less|sass|styl)$/.test(
            file,
          ),
        )
        if (
          hasUiFiles &&
          /\b(?:accessibility|a11y|keyboard|focus|screen reader|aria|contrast|reduced motion)\b/.test(
            requirements,
          )
        )
          selected.add('accessibility-reviewer')
        if (
          hasUiFiles &&
          /\b(?:visual|layout|responsive|design system|spacing|hierarchy|screenshot|viewport|interaction)\b/.test(
            requirements,
          )
        )
          selected.add('ux-visual-reviewer')
        if (
          /\b(?:user-facing|acceptance criteria|product behavior|user flow|end-to-end|ux|onboarding)\b/.test(
            requirements,
          )
        )
          selected.add('product-reviewer')
        if (
          /\b(?:independent evaluat|score against|requirement coverage)\b/.test(
            requirements,
          )
        )
          selected.add('evaluator')
        return [
          'dependency-reviewer',
          'migration-reviewer',
          'compatibility-reviewer',
          'reliability-reviewer',
          'performance-specialist',
          'accessibility-reviewer',
          'ux-visual-reviewer',
          'product-reviewer',
          'evaluator',
        ].filter((agent) => selected.has(agent))
      }

      function isConversationOnlyPrompt(value: unknown): boolean {
        if (typeof value !== 'string') return false
        const normalized = value
          .trim()
          .replace(/[.!?,]+$/g, '')
          .trim()
        return /^(?:hi|hello|hey|hiya|good morning|good afternoon|good evening|thanks|thank you|thanks a lot|thank you very much)$/i.test(
          normalized,
        )
      }

      type Base2AgentState = NonNullable<typeof agentState> & {
        base2ActiveWork?: Base2ActiveWorkState
        canSuggestFollowups?: boolean
        /**
         * Set by the tool executor after a successful same-step allow-path for
         * suggest_followups while the gate system is active. Cleared once per
         * user turn at handleSteps start so a new turn can suggest again.
         */
        suggestFollowupsEmitted?: boolean
        uncommittedUnvalidatedFiles?: string[]
        /**
         * Process-owned mutation paths published by the runtime as JSON-safe
         * string[] (AgentState.selfMutatedPaths). Declared on this local
         * intersection so handleSteps can read it without casts.
         */
        selfMutatedPaths?: string[]
        commitScopeBypassAuthorized?: boolean
        commitScopeBypassRecord?: {
          reason: string
          authorizedAt: string
          unvalidatedFiles: string[]
        }
        workspaceState?: {
          revision: number
          snapshotId: string
        }
        discoveryCoverage?: any
        workflowStates?: Record<string, any>
      }

      const mutableAgentState = (agentState ?? {}) as Base2AgentState
      // Reset once per user turn so a new turn can suggest followups again
      // after a prior turn's suggest_followups set the executor emitted flag.
      mutableAgentState.suggestFollowupsEmitted = false
      const agentId = mutableAgentState.agentId
      const configuredHasNoValidation = config?.hasNoValidation
      const configuredPlanOnly = config?.planOnly === true
      const runValidationGate =
        !configuredPlanOnly &&
        (typeof configuredHasNoValidation === 'boolean'
          ? !configuredHasNoValidation
          : agentId !== 'base2-fast' && agentId !== 'base2-fast-no-validation')
      // M3 (R1a–R1d) automated phase-gate predicates. These mirror the
      // advisory glob list in securityReviewSection (quality-prompt-section.ts)
      // so the automated gate and the advisory prompt agree on what is
      // security-sensitive. Self-contained string/regex matching (no
      // module-scope imports) because handleSteps is serialized via
      // .toString() and reconstructed with new Function(...): module-scope
      // bindings such as an imported `micromatch` would be undefined at
      // reconstruction time.
      const SECURITY_SENSITIVE_GLOBS = [
        'auth',
        'oauth',
        'credentials',
        'session',
        'crypto',
        'keys',
        'secrets',
        'vault',
        'billing',
        'payment',
        'stripe',
        'permissions',
        'rbac',
        'policy',
      ]
      const SECURITY_SENSITIVE_NAME_SUBSTRINGS = ['secret', 'token', 'apikey']
      const runReviewerGate = runValidationGate
      const reviewerAgentType = 'code-reviewer'
      const MAX_REVIEWER_NO_VERDICT_RETRIES = 1
      // Optional validation-hook repair cap. Already resolved into
      // programmaticConfig at createBase2 load time (null = unlimited).
      // Re-clamp here with local literals only because handleSteps is
      // serialized via toString/new Function and cannot call module-scope
      // resolve helpers. Missing/null/invalid → Infinity (progress guards only).
      const configuredMaxRepairRounds = config?.maxRepairRounds
      const MAX_REPAIR_ROUNDS =
        typeof configuredMaxRepairRounds === 'number' &&
        Number.isFinite(configuredMaxRepairRounds) &&
        configuredMaxRepairRounds >= 1
          ? Math.min(Math.floor(configuredMaxRepairRounds), 20)
          : Number.POSITIVE_INFINITY
      // Optional reviewer→repair→re-review cap (also burned by NON_BLOCKING under
      // LOOKS_GOOD-only finalization). null/omitted → unlimited.
      const configuredMaxReviewerRepairRounds = config?.maxReviewerRepairRounds
      const MAX_REVIEWER_REPAIR_ROUNDS =
        typeof configuredMaxReviewerRepairRounds === 'number' &&
        Number.isFinite(configuredMaxReviewerRepairRounds) &&
        configuredMaxReviewerRepairRounds >= 1
          ? Math.min(Math.floor(configuredMaxReviewerRepairRounds), 20)
          : Number.POSITIVE_INFINITY
      // Optional specialist→repair→re-review cap. null/omitted → unlimited.
      const configuredMaxSpecialistRepairRounds =
        config?.maxSpecialistRepairRounds
      const MAX_SPECIALIST_REPAIR_ROUNDS =
        typeof configuredMaxSpecialistRepairRounds === 'number' &&
        Number.isFinite(configuredMaxSpecialistRepairRounds) &&
        configuredMaxSpecialistRepairRounds >= 1
          ? Math.min(Math.floor(configuredMaxSpecialistRepairRounds), 20)
          : Number.POSITIVE_INFINITY
      const MAX_SPECIALIST_NO_VERDICT_RETRIES = 1
      // The post-gate finalization instruction shared by every gate-pass path
      // is built by buildGatePassFinalizationNotice() in the inline-helper
      // region below (see that function's comment for why it must stay a
      // hoisted inline `function` declaration and why reading activeWorkState
      // at call time is safe).
      const existingActiveWorkState = mutableAgentState.base2ActiveWork
      const hadPendingGateFiles =
        !!existingActiveWorkState &&
        Object.prototype.hasOwnProperty.call(
          existingActiveWorkState,
          'pendingGateFiles',
        )
      const hadCurrentPhase =
        !!existingActiveWorkState &&
        Object.prototype.hasOwnProperty.call(
          existingActiveWorkState,
          'currentPhase',
        )
      const activeWorkState = existingActiveWorkState ?? {
        touchedFiles: [],
        changedFiles: [],
        pendingGateFiles: [],
        currentPhase: 'idle',
        latestWorkSummary: '',
        openReviewerBlockers: [],
        openReviewerFindings: [],
        lastValidationSummary: '',
        nextRequiredAction: '',
        lastPinnedStateMessage: '',
        gatePassedFiles: [],
        gatePassedFileMarkers: {},
        gatePassedPendingFiles: [],
        gatePassedReviewerVerdict: '',
        gatePassedValidationSummary: '',
        gatePassedFingerprint: '',
        reviewedReviewableFingerprint: '',
        lastReviewerGateSkipReason: '',
        preEditSecurityReviewDone: false,
        securityReviewGateDone: false,
        reviewerCrashCount: 0,
        reviewerProtocolRetryCount: 0,
        reviewerRepairRoundCount: 0,
        reviewerNoVerdictCount: 0,
        reviewerBypassChallenge: undefined,
        reviewerGateBypassReason: '',
        reviewerGateBypassRecord: undefined,
        validationAssurance: 'none',
        testWriterGateDone: false,
        docWriterGateDone: false,
        specialistReviewGatesDone: [],
        owedReviewerRevalidations: [],
        specialistReviewGateFingerprints: {},
        specialistRepairRoundCount: 0,
        specialistNoVerdictCounts: {},
        reviewReceipts: [],
        auxGatesLastPendingFiles: [],
      }
      activeWorkState.touchedFiles ??= []
      activeWorkState.changedFiles ??= []
      activeWorkState.pendingGateFiles ??= []
      activeWorkState.gatePassedFiles ??= []
      // Record, not a list: never routed through normalizeGateFileList. Just
      // guarantee it is always an object so older serialized state (which
      // lacks it) is treated as `{}`.
      activeWorkState.gatePassedFileMarkers ??= {}
      activeWorkState.gatePassedPendingFiles ??= []
      activeWorkState.gatePassedReviewerVerdict ??= ''
      activeWorkState.gatePassedValidationSummary ??= ''
      activeWorkState.gatePassedFingerprint ??= ''
      activeWorkState.reviewedReviewableFingerprint ??= ''
      activeWorkState.lastReviewerGateSkipReason ??= ''
      activeWorkState.openReviewerBlockers ??= []
      activeWorkState.openReviewerFindings ??= []
      activeWorkState.validationEvidence ??= []
      activeWorkState.latestWorkSummary ??= ''
      activeWorkState.lastValidationSummary ??= ''
      activeWorkState.nextRequiredAction ??= ''
      activeWorkState.lastPinnedStateMessage ??= ''
      activeWorkState.preEditSecurityReviewDone ??= false
      activeWorkState.securityReviewGateDone ??=
        activeWorkState.preEditSecurityReviewDone
      activeWorkState.reviewerCrashCount ??= 0
      activeWorkState.reviewerProtocolRetryCount ??= 0
      activeWorkState.reviewerRepairRoundCount ??= 0
      activeWorkState.reviewerNoVerdictCount ??= 0
      activeWorkState.reviewerGateBypassReason ??= ''
      activeWorkState.validationAssurance ??= 'none'
      activeWorkState.testWriterGateDone ??= false
      activeWorkState.docWriterGateDone ??= false
      activeWorkState.specialistReviewGatesDone ??= []
      activeWorkState.owedReviewerRevalidations ??= []
      // Records, not lists: never routed through normalizeGateFileList. Just
      // guarantee they are always plain objects so older serialized state
      // (which lacks them) is treated as `{}` and fails closed.
      activeWorkState.specialistReviewGateFingerprints ??= {}
      activeWorkState.specialistRepairRoundCount ??= 0
      activeWorkState.specialistNoVerdictCounts ??= {}
      activeWorkState.reviewReceipts ??= []
      activeWorkState.auxGatesLastPendingFiles ??= []
      // Gate-issued per-task plan validation receipts, published ONLY when the
      // validation/reviewer gate actually runs. The PRESENCE of this key is
      // what switches the update_plan_status handler from the legacy "any
      // non-empty receiptIds" rule to gate-issued verification, and
      // present-and-empty REJECTS (the gate is active but has issued no
      // evidence yet). With the gate disabled (hasNoValidation / plan-only /
      // base2-fast) no receipt could ever be minted, so publishing an empty
      // array there would hard-regress those runs by making every plan task
      // impossible to complete — the key must stay ABSENT so they keep the
      // legacy behavior.
      //
      // An INHERITED key must be DELETED for exactly the same reason: a session
      // that published it under EXECUTE_PLAN/base2 and later resumes through a
      // gate-disabled variant would otherwise restore base2ActiveWork with
      // verification still on while no receipt can ever be minted. The
      // invariant is "present ⇔ the gate is active for THIS run", not "present ⇔
      // the gate ran at some point in this session". Dropping the stale ledger
      // is safe in both directions: the gate-disabled run falls back to the
      // legacy rule, and the next fresh gate pass re-mints a receipt for
      // whatever task is claimed then.
      if (runValidationGate) {
        // Normalize rather than `??= []`: a PRESENT-but-non-array ledger (corrupt
        // or hand-edited serialized state) is not usable evidence, and `??= []`
        // left such a value intact for every reader below — the gate-pass mint's
        // `.some(...)`, the printed live-receipt `.find(...)`, and
        // buildPinnedActiveWorkMessage's `.find(...)` — which then threw a
        // TypeError inside handleSteps and failed the whole turn instead of
        // failing closed. Normalizing to an EMPTY array keeps the key PRESENT, so
        // the runtime handler still treats gate-issued verification as active and
        // rejects a checkpoint citing an unmatched receipt ID; that is exactly the
        // fail-closed reading its own readGateIssuedPlanTaskReceipts applies to a
        // malformed ledger, and it matches the Array.isArray guards in
        // prunePlanTaskGateReceipts / supersedePlanTaskGateReceiptsForChangedFiles.
        if (!Array.isArray(activeWorkState.planTaskGateReceipts)) {
          activeWorkState.planTaskGateReceipts = []
        }
      } else {
        delete activeWorkState.planTaskGateReceipts
      }
      // Condoned finding texts: finding texts that a repair-editor has already
      // reported as addressed via findingsAddressed. When a fresh reviewer
      // re-returns identical text, the finding is 'condoned' — no longer
      // re-elevated as a blocker — so the reviewer → repair → re-review loop
      // converges instead of looping forever on the same NON_BLOCKING
      // architectural commentary. Reset when the gate passes.
      activeWorkState.condonedFindingTexts ??= []
      // T1.5 companion: (verdict class, finding identity) condone keys. Legacy
      // serialized state lacks this field, which is what makes the
      // condonedFindingTexts fallback below conditional on it being empty.
      activeWorkState.condonedFindingKeys ??= []
      if (activeWorkState.openReviewerFindings.length > 0) {
        // Rehydrate the owed set from EVERY open finding, not just findings[0]:
        // serialized state can carry open findings from several reviewers and
        // each of them still owes a fresh re-attestation (fail closed).
        const owedFromFindings = activeWorkState.openReviewerFindings.map(
          (finding) => reviewerFamilyFromFinding(finding),
        )
        const owed = (activeWorkState.owedReviewerRevalidations ??= [])
        for (const family of owedFromFindings) {
          if (!owed.includes(family)) owed.push(family)
        }
        // Keep the legacy scalar in sync as the first owed entry; only set it
        // when it is currently unset, matching the previous guard.
        if (!activeWorkState.requiredReviewerRevalidation) {
          activeWorkState.requiredReviewerRevalidation = owed[0] ?? undefined
        }
      }
      activeWorkState.workflowTodoProgress = normalizeWorkflowTodoProgress(
        activeWorkState.workflowTodoProgress,
      )
      activeWorkState.touchedFiles = normalizeGateFileList(
        activeWorkState.touchedFiles,
      )
      activeWorkState.changedFiles = normalizeGateFileList(
        activeWorkState.changedFiles,
      )
      activeWorkState.pendingGateFiles = normalizeGateFileList(
        activeWorkState.pendingGateFiles,
      )
      activeWorkState.gatePassedFiles = normalizeGateFileList(
        activeWorkState.gatePassedFiles,
      )
      activeWorkState.gatePassedPendingFiles = normalizeGateFileList(
        activeWorkState.gatePassedPendingFiles,
      )
      updateWorkflowTodoProgressFromMessages(mutableAgentState.messageHistory)
      // Track the EXECUTE_PLAN task the model has claimed through
      // update_plan_status so the gate-pass path can mint a receipt bound to
      // that exact task. Done at turn start as well as post-STEP so a task
      // claimed in an earlier turn is already known when this turn's gate
      // passes.
      updateActivePlanTaskFromMessages(mutableAgentState.messageHistory)
      // Recognize a user-issued "COMMIT ANYWAY" at turn start (not only in
      // the post-STEP messageHistory branch) so a git-committer spawned in
      // the first step of the 'COMMIT ANYWAY' turn already sees the
      // published bypass flag instead of being blocked by the stale value.
      updateCommitScopeBypassFromMessages(mutableAgentState.messageHistory)
      if (!hadCurrentPhase) {
        activeWorkState.currentPhase = inferActiveWorkPhase(activeWorkState)
      }
      if (
        !hadPendingGateFiles &&
        !hadCurrentPhase &&
        activeWorkState.pendingGateFiles.length === 0 &&
        activeWorkState.changedFiles.length > 0 &&
        (activeWorkState.openReviewerBlockers.length > 0 ||
          activeWorkState.nextRequiredAction.trim().length > 0)
      ) {
        activeWorkState.pendingGateFiles = [...activeWorkState.changedFiles]
        activeWorkState.currentPhase = 'blocked'
        activeWorkState.lastPinnedStateMessage = ''
      }
      mutableAgentState.base2ActiveWork = activeWorkState
      let processedMessageHistoryLength = Array.isArray(
        mutableAgentState.messageHistory,
      )
        ? mutableAgentState.messageHistory.length
        : 0
      let currentConversationMessages: unknown =
        mutableAgentState.messageHistory

      const hasActiveWork =
        activeWorkState.pendingGateFiles.length > 0 ||
        activeWorkState.openReviewerBlockers.length > 0 ||
        activeWorkState.nextRequiredAction.trim().length > 0
      if (isConversationOnlyPrompt(prompt) && !hasActiveWork) {
        yield {
          toolName: 'spawn_agent_inline',
          input: {
            agent_type: 'context-pruner',
            params: params ?? {},
          },
          includeToolCall: false,
        } as any
        mutableAgentState.canSuggestFollowups = false
        yield 'STEP'
        return
      }

      // Explicit Git delivery is the one turn type allowed to claim files that
      // were already dirty at turn start. Keep this classifier inline because
      // handleSteps is serialized through toString()/new Function().
      function hasExplicitGitDeliveryIntent(value: unknown): boolean {
        if (typeof value !== 'string') return false
        const text = value.replace(/\s+/g, ' ').trim()
        if (!text) return false
        // The exact standalone bypass phrase is not a delivery intent; it
        // authorizes committing despite unvalidated files. Matching it here
        // would re-arm the gate and block the very commit it authorizes.
        if (text.toUpperCase() === 'COMMIT ANYWAY') return false
        const gitAction = String.raw`(?:commit|push|stage|staging)`
        if (
          new RegExp(
            String.raw`\b(?:do not|don't|dont|never|avoid|without|no need to|not going to)\b[^.!?;\n]{0,64}\b${gitAction}\b`,
            'i',
          ).test(text)
        ) {
          return false
        }
        const deliveryScope = String.raw`(?:changes?|files?|work|branch|working[- ]tree)`
        const explicitImperativeDelivery =
          new RegExp(
            String.raw`\b(?:please|then|now|can you|could you|would you)\s+(?:also\s+)?${gitAction}\b`,
            'i',
          ).test(text) ||
          new RegExp(String.raw`^(?:please\s+)?${gitAction}\b`, 'i').test(text)
        if (explicitImperativeDelivery) return true

        const advisoryQuestion =
          /(?:^|[.!?;]\s*)(?:should\b|how\s+(?:do|can|should|would)\b)/i
        if (advisoryQuestion.test(text)) return false

        // Delivery phrasings stack determiners ("push all our current
        // changes"), so allow 0-3 of them between the git verb and the scope
        // noun. The repetition is bounded on purpose: an unbounded `*`/`+` on
        // this alternation inside the larger pattern is a catastrophic-
        // backtracking risk, and this runs on arbitrary user prompt text.
        return new RegExp(
          String.raw`\b${gitAction}\b(?:\s+(?:and|then)\s+(?:commit|push))?(?:\s+(?:our|my|the|these|those|all|current|existing|pending|dirty|local)){0,3}\s+${deliveryScope}\b`,
          'i',
        ).test(text)
      }

      const initialGitStatus = yield {
        toolName: 'git_status',
        input: {},
      } as any
      const initialGitStatusFiles = extractGitStatusFiles(
        (initialGitStatus as any)?.toolResult,
      ).filter((file) => !activeWorkState.gatePassedFiles.includes(file))
      // Raw working-tree dirty set at turn start (not filtered by gate-passed).
      // Used to publish the unvalidated-dirty set for the git-committer commit guard.
      const initialGitStatusDirtyFiles = extractGitStatusFiles(
        (initialGitStatus as any)?.toolResult,
      )
      const changedFiles = new Set<string>(activeWorkState.changedFiles)
      const pendingGateFiles = new Set<string>(activeWorkState.pendingGateFiles)
      let editsHappened =
        pendingGateFiles.size > 0 ||
        ((activeWorkState.currentPhase === 'awaiting_validation' ||
          activeWorkState.currentPhase === 'awaiting_review') &&
          activeWorkState.changedFiles.length > 0)
      let gatePassedForCurrentEdits = false
      let finalResponseGateOpen =
        activeWorkState.currentPhase === 'final_response_allowed' &&
        pendingGateFiles.size === 0 &&
        activeWorkState.openReviewerBlockers.length === 0 &&
        activeWorkState.nextRequiredAction.trim().length === 0
      const gatePassedFiles = new Set<string>(activeWorkState.gatePassedFiles)
      if (
        hasExplicitGitDeliveryIntent(prompt) &&
        initialGitStatusFiles.length > 0
      ) {
        // Scope the git-delivery adoption to REVIEWABLE dirty files only.
        // Non-reviewable turn-start dirt (docs, session STATE.json, jsonl,
        // config) belongs to the whole worktree, not to any one conversation's
        // gate; forcing the reviewer to attest to every unrelated dirty path
        // turns a clean commit turn into a worktree-wide review. Reviewable
        // source/test files the user asked us to commit still enter the gate.
        const reviewableDeliveryFiles = selectReviewableGateFiles(
          initialGitStatusFiles,
        )
        if (reviewableDeliveryFiles.length > 0) {
          recordChangedFiles(reviewableDeliveryFiles)
          editsHappened = true
          finalResponseGateOpen = false
          mutableAgentState.canSuggestFollowups = false
          activeWorkState.currentPhase = 'awaiting_validation'
          activeWorkState.latestWorkSummary = `Explicit Git delivery request adopted turn-start dirty files: ${initialGitStatusFiles.join(', ')}`
          markActiveWorkStateChanged()
        }
      }
      // Track files previously observed dirty in git status so we can safely
      // prune them from the pending set when they disappear (committed).
      const gitStatusObservedFiles = new Set<string>()
      let gitStatusObservedDirty = false
      if (
        activeWorkState.gatePassedPendingFiles.length > 0 &&
        activeWorkState.gatePassedFingerprint &&
        !hasFreshGateFingerprintForPendingFiles(
          activeWorkState.gatePassedPendingFiles,
          activeWorkState.gatePassedValidationSummary ||
            activeWorkState.lastValidationSummary ||
            'No configured file-change hooks ran.',
        )
      ) {
        const reopenMarkers = (activeWorkState.gatePassedFileMarkers ??= {})
        for (const file of activeWorkState.gatePassedPendingFiles) {
          changedFiles.add(file)
          pendingGateFiles.add(file)
          gatePassedFiles.delete(file)
          // Keep the marker ledger consistent: a file removed from
          // gatePassedFiles must not leave an orphan marker behind.
          delete reopenMarkers[file]
        }
        activeWorkState.pendingGateFiles = Array.from(pendingGateFiles)
        activeWorkState.gatePassedFiles = Array.from(gatePassedFiles)
        activeWorkState.gatePassedPendingFiles = []
        activeWorkState.gatePassedReviewerVerdict = ''
        activeWorkState.gatePassedValidationSummary = ''
        activeWorkState.gatePassedFingerprint = ''
        activeWorkState.currentPhase = 'awaiting_validation'
        activeWorkState.latestWorkSummary =
          'Previously reviewed files changed after the gate passed; validation and review were reopened.'
        editsHappened = true
        finalResponseGateOpen = false
        markActiveWorkStateChanged()
      }
      // Generalized per-file eviction ledger (hybrid Option A). In addition to
      // the gatePassedPendingFiles fingerprint reopen above, evict ANY credited
      // file whose current content marker no longer matches the marker captured
      // when it was credited into gatePassedFiles. A credited file with NO
      // stored marker (legacy serialized state predating gatePassedFileMarkers)
      // is treated as drifted and evicted (fail closed) so a legacy ledger
      // cannot grant an unattested commit. Runs before the
      // uncommittedUnvalidatedFiles publication and any commit-guard evaluation.
      {
        const ledgerMarkers = (activeWorkState.gatePassedFileMarkers ??= {})
        const evictedGatePassedFiles: string[] = []
        for (const file of Array.from(gatePassedFiles)) {
          const storedMarker = ledgerMarkers[file]
          const currentMarker = readGateFileContentMarker(file)
          // Evict when: no stored marker (legacy state), marker mismatch
          // (content drift), OR current marker is not attestable (external
          // symlink, unreadable file, missing crypto). A stable error string
          // must never retain credit.
          if (
            storedMarker === undefined ||
            storedMarker !== currentMarker ||
            !isCreditableContentMarker(currentMarker)
          ) {
            gatePassedFiles.delete(file)
            delete ledgerMarkers[file]
            changedFiles.add(file)
            pendingGateFiles.add(file)
            evictedGatePassedFiles.push(file)
          }
        }
        if (evictedGatePassedFiles.length > 0) {
          activeWorkState.pendingGateFiles = Array.from(pendingGateFiles)
          activeWorkState.gatePassedFiles = Array.from(gatePassedFiles)
          activeWorkState.currentPhase = 'awaiting_validation'
          activeWorkState.latestWorkSummary =
            'A previously gate-passed file changed after crediting; validation and review were reopened.'
          editsHappened = true
          finalResponseGateOpen = false
          // An evicted path is back in the pending set, so any gate-issued
          // plan-task receipt that covered it must stop authorizing a `done`
          // transition (and every receipt with no verifiable content identity
          // goes with it — see the helper).
          supersedePlanTaskGateReceiptsForChangedFiles(evictedGatePassedFiles)
          markActiveWorkStateChanged()
        }
      }
      // Turn-start content verification for the gate-issued plan-task receipt
      // ledger. Runs right after the eviction block (and well after hydration,
      // which is what publishes/deletes the key) so the ledger the runtime
      // handler reads this turn only contains receipts whose covered bytes still
      // hash to the fingerprint they were minted with.
      prunePlanTaskGateReceipts()
      // Latest dirty working-tree snapshot for P0 re-arm / P2 pin lag / P3
      // unvalidated publication. Starts as the turn-start dirty set and is
      // refreshed whenever a real mid-turn git_status result is extracted.
      let latestDirtyFiles = initialGitStatusDirtyFiles
      // P0 turn-start re-arm only when finalization is falsely open. Do not
      // re-arm mid-gate (awaiting_validation/review) — that would re-touch
      // pending files, clear durable fingerprints, and break reuse. Do not
      // re-arm solely for non-reviewable dirty (docs/session/jsonl).
      if (
        runValidationGate &&
        (finalResponseGateOpen ||
          activeWorkState.currentPhase === 'final_response_allowed')
      ) {
        const unreviewedAtTurnStart = collectUnreviewedDirtyReviewableFiles(
          initialGitStatusDirtyFiles,
        )
        if (unreviewedAtTurnStart.length > 0) {
          rearmGateForUnreviewedDirty(unreviewedAtTurnStart)
        }
      }
      // Turn-scoped CYCLE detection for the two repair loops below. These are
      // deliberately turn-scoped LOCALS and NOT persisted gate state (they must
      // not be added to gate-state.ts): a fingerprint cycle is only meaningful
      // within one turn's repair loop, and a later turn must stay free to
      // revisit an earlier workspace state. The existing no-progress guards
      // only compare against the IMMEDIATELY PRECEDING fingerprint, so an
      // A→B→A oscillation changes the fingerprint every round and never trips
      // them; these sets catch a fingerprint that CHANGED but was already
      // visited this turn. Two separate sets on purpose: the reviewer loop
      // hashes buildGateSnapshotDetails(pending, validationSummary) while the
      // specialist loop hashes buildGateSnapshotDetails(pending, ''), so one
      // shared set would conflate two different fingerprint spaces.
      const seenReviewerRepairFingerprints = new Set<string>()
      const seenSpecialistRepairFingerprints = new Set<string>()
      // Win 4a delta-only baseline: the last pinned block actually EMITTED
      // this turn. Deliberately separate from
      // activeWorkState.lastPinnedStateMessage, which doubles as the ''
      // cache-invalidation sentinel (markActiveWorkStateChanged clears it on
      // every gate-state write, including every setGateProgress call) and so
      // can never report what the model last saw. Turn-scoped local, not
      // persisted state: a resumed turn re-emits the full block once.
      let lastEmittedPinnedStateMessage = ''
      while (true) {
        yield {
          toolName: 'spawn_agent_inline',
          input: {
            agent_type: 'context-pruner',
            params: params ?? {},
          },
          includeToolCall: false,
        } as any

        // Allow suggest_followups on a pure analysis turn: no edits happened,
        // nothing is pending validation/review, the working tree was clean at
        // turn start (initialGitStatusFiles excludes already-gate-passed
        // files), and no gate phase is mid-flight. Without this the gate would
        // pointlessly block follow-up suggestions on read-only/question turns
        // that have nothing to validate or commit. The retract-on-edit paths
        // below (and the tool-executor same-batch/cross-batch guards) still
        // flip this back to false the moment any edit is detected this turn.
        const hasNoPendingGateWork =
          !editsHappened &&
          pendingGateFiles.size === 0 &&
          initialGitStatusFiles.length === 0 &&
          activeWorkState.openReviewerBlockers.length === 0 &&
          activeWorkState.nextRequiredAction.trim().length === 0 &&
          activeWorkState.currentPhase !== 'blocked' &&
          activeWorkState.currentPhase !== 'awaiting_validation' &&
          activeWorkState.currentPhase !== 'awaiting_review'
        mutableAgentState.canSuggestFollowups =
          !runValidationGate || finalResponseGateOpen || hasNoPendingGateWork

        // Publish REVIEWABLE-ONLY task-related dirty files not covered by a
        // green gate pass for the git-committer commit guard. Non-reviewable
        // dirty task files (docs, session STATE.json, jsonl, etc.) are excluded
        // from this list so they do not block commits; the pin (P2) surfaces
        // them as excluded from the gate, not as validated. Recomputed every
        // iteration against latestDirtyFiles + current gatePassedFiles.
        // Mid-turn dirty is preferred once a real git_status has refreshed
        // latestDirtyFiles; until then the turn-start snapshot is used
        // (fail-closed if a turn-start dirty was reverted mid-turn).
        const unvalidatedDirtyReviewable =
          collectUnvalidatedDirtyReviewableFiles(latestDirtyFiles)
        // Re-arm candidates only: exclude already-pending (mid-gate) paths.
        const unreviewedDirtyReviewable =
          collectUnreviewedDirtyReviewableFiles(latestDirtyFiles)
        const nonReviewableDirtyTask =
          collectNonReviewableDirtyTaskFiles(latestDirtyFiles)
        const dirtyReviewableAll = selectReviewableGateFiles(
          normalizeGateFileList(latestDirtyFiles).filter((file) =>
            collectTaskRelatedFiles().has(file),
          ),
        )
        activeWorkState.dirtyReviewableCount = dirtyReviewableAll.length
        // Pin lag list is the false-PASSED re-arm set only (not mid-gate pending).
        activeWorkState.unreviewedDirtyReviewableFiles =
          unreviewedDirtyReviewable
        activeWorkState.nonReviewableDirtyTaskFiles = nonReviewableDirtyTask
        // Commit guard includes pending unvalidated reviewable paths.
        mutableAgentState.uncommittedUnvalidatedFiles =
          unvalidatedDirtyReviewable

        // P0 every-iteration re-arm: if finalization is open (or phase claims
        // final_response_allowed) while unreviewed dirty reviewable task files
        // remain, force re-arm before the early break can skip the gate.
        if (
          runValidationGate &&
          unreviewedDirtyReviewable.length > 0 &&
          (finalResponseGateOpen ||
            activeWorkState.currentPhase === 'final_response_allowed')
        ) {
          rearmGateForUnreviewedDirty(unreviewedDirtyReviewable)
        }

        const pinnedStateMessage = buildPinnedActiveWorkMessage(activeWorkState)
        if (
          pinnedStateMessage &&
          pinnedStateMessage !== activeWorkState.lastPinnedStateMessage
        ) {
          // Win 4a delta-only: the full Harness pinned block is emitted once
          // per turn; a later step whose ONLY change is the gate-progress line
          // emits just that line. The baseline is the last EMITTED block, never
          // activeWorkState.lastPinnedStateMessage — markActiveWorkStateChanged
          // resets that field to '' on every gate-state write (including every
          // setGateProgress call), so using it here would make this branch
          // unreachable and re-emit the whole block every step.
          const previousPinned = lastEmittedPinnedStateMessage
          const gateProgressLine = activeWorkState.gateProgressLine ?? ''
          // Sections are joined with '\n\n', so removing the progress line
          // leaves a longer blank-line run behind. Collapsing over-long runs
          // keeps the stripped forms comparable across the line's first
          // appearance and its disappearance, not only across value changes.
          const stripGateProgress = (msg: string): string =>
            msg
              .replace(/\nGate progress:[^\n]*/g, '')
              .replace(/\n{3,}/g, '\n\n')
              .trim()
          // An empty gateProgressLine has no delta to send: the pinned block
          // renders `Gate progress: <line>` only for a non-empty line. The
          // explicit emptiness check keeps a stray "Gate progress: " substring
          // inside reviewer blocker text from producing an empty delta.
          const isOnlyGateProgressChange =
            previousPinned !== '' &&
            gateProgressLine !== '' &&
            stripGateProgress(previousPinned) ===
              stripGateProgress(pinnedStateMessage) &&
            pinnedStateMessage.includes(`Gate progress: ${gateProgressLine}`)
          activeWorkState.lastPinnedStateMessage = pinnedStateMessage
          lastEmittedPinnedStateMessage = pinnedStateMessage
          yield {
            toolName: 'add_message',
            input: {
              role: 'user',
              content: isOnlyGateProgressChange
                ? `Gate progress: ${gateProgressLine}`
                : pinnedStateMessage,
            },
            includeToolCall: false,
          } as any
        }

        // No per-step tier bookkeeping: progressiveToolDisclosure is pinned
        // false (see packages/agent-runtime/src/util/base2-tool-tiers.ts), so
        // the runtime always offers the full mode-resolved surface.
        const stepResult = yield 'STEP'
        const { stepsComplete, hitStepCap } = stepResult as {
          stepsComplete: boolean
          hitStepCap?: boolean
        }
        // If the LLM step hit an explicit fixed cap (stepsRemaining === 0), the turn
        // is over. Break out immediately instead of falling through to the
        // validation/reviewer gate: the gate would re-yield STEP, which would
        // re-trigger the step-cap (stepsRemaining is still 0), looping forever.
        if (hitStepCap) {
          activeWorkState.currentPhase = 'blocked'
          activeWorkState.nextRequiredAction =
            'Step cap reached before required validation/review completed. Resume this work first and complete the pending gate files before finalizing.'
          activeWorkState.latestWorkSummary =
            'Step-cap guard interrupted the turn with validation/review still pending.'
          mutableAgentState.canSuggestFollowups = false
          finalResponseGateOpen = false
          markActiveWorkStateChanged()
          break
        }
        if (Array.isArray((stepResult as any)?.agentState?.messageHistory)) {
          currentConversationMessages = (stepResult as any).agentState
            .messageHistory
        }
        let editsThisStep = false
        const files = extractChangedFiles(
          (stepResult as any) && (stepResult as any).toolResult,
        )
        if (files.length > 0) {
          editsHappened = true
          editsThisStep = true
          recordChangedFiles(files)
          activeWorkState.latestWorkSummary = `Latest detected edit/work touched: ${files.join(', ')}`
          markActiveWorkStateChanged()
        }
        const messageHistory = (stepResult as any)?.agentState?.messageHistory
        // Capture the pre-update start index so extractChangedFilesFromMessages
        // covers only the message delta for this step; processedMessageHistoryLength
        // is overwritten right after.
        const messageHistoryStartIndex = processedMessageHistoryLength
        const messageFiles = extractChangedFilesFromMessages(
          messageHistory,
          messageHistoryStartIndex,
        )
        if (Array.isArray(messageHistory)) {
          currentConversationMessages = messageHistory
          updateWorkflowTodoProgressFromMessages(messageHistory)
          updateActivePlanTaskFromMessages(messageHistory)
          updateCommitScopeBypassFromMessages(messageHistory)
          processedMessageHistoryLength = messageHistory.length
        }
        if (messageFiles.length > 0) {
          editsHappened = true
          editsThisStep = true
          recordChangedFiles(messageFiles)
          activeWorkState.latestWorkSummary = `Latest direct edit/work from message history touched: ${messageFiles.join(', ')}`
          markActiveWorkStateChanged()
        }
        if (editsThisStep) {
          gatePassedForCurrentEdits = false
          finalResponseGateOpen = false
          // Keep canSuggestFollowups in sync with finalResponseGateOpen so that
          // edits made in an earlier tool-call batch of this step immediately
          // retract suggest_followups permission (which was computed at the top
          // of the loop from the prior gate state). Without this, an LLM could
          // make edits and then call suggest_followups in the same step before
          // the gate has a chance to re-run.
          mutableAgentState.canSuggestFollowups = false
          activeWorkState.currentPhase = 'awaiting_validation'
          markActiveWorkStateChanged()
        }

        if (!stepsComplete) continue

        const currentGitStatus = yield {
          toolName: 'git_status',
          input: {},
        } as any
        const gitStatusFiles = extractGitStatusFiles(
          (currentGitStatus as any)?.toolResult,
        )
        // A real git_status payload (it carries a `status` field) gates both the
        // mid-turn dirty-snapshot refresh below and the committed-file pruning
        // branch further down, so compute it once.
        const isRealGitStatusResult =
          (currentGitStatus as any)?.toolResult?.[0]?.value?.status !==
          undefined
        // Refresh the mid-turn dirty snapshot whenever git_status returns a
        // real status payload so top-of-loop P0 re-arm and P3 publication see
        // live dirtiness rather than only the turn-start snapshot.
        if (isRealGitStatusResult) {
          latestDirtyFiles = gitStatusFiles
        }
        // Prune pending gate files that were previously observed as dirty in
        // git status but are no longer present (i.e., they were committed).
        // Without this, committed files stay in the pending set forever,
        // blocking suggest_followups and keeping the gate in
        // 'awaiting_validation' even though the working tree is clean.
        // Only prune when the git_status result is a real response (has a
        // `status` field) and we have previously confirmed files dirty, to
        // avoid false pruning from mock/empty results in tests.
        if (
          isRealGitStatusResult &&
          gitStatusObservedDirty &&
          gitStatusFiles.length === 0
        ) {
          for (const pendingFile of Array.from(pendingGateFiles)) {
            if (gitStatusObservedFiles.has(pendingFile)) {
              pendingGateFiles.delete(pendingFile)
              creditGatePassedFiles([pendingFile])
            }
          }
        }
        for (const file of gitStatusFiles) {
          gitStatusObservedFiles.add(file)
        }
        if (isRealGitStatusResult && gitStatusFiles.length > 0) {
          gitStatusObservedDirty = true
        }
        for (const file of gitStatusFiles) {
          // Concurrent-instance isolation: absorb a newly-dirty git-status
          // file into the pending set only when this agent plausibly authored
          // it. `shouldAbsorbGitStatusFile` is generated into
          // `<gate-helpers-generated>` from `agents/base2/gate-concurrency.ts`
          // via `scripts/generate-gate-helpers.ts` (function-declaration
          // hoisting in handleSteps makes it available at this mid-turn call
          // site). Observation bookkeeping above (gitStatusObservedFiles.add
          // and gitStatusObservedDirty) stays UNSCOPED for every git-status
          // file so committed-file pruning keeps working.
          // Runtime publishes selfMutatedPaths as string[] after confirmed
          // broker/tool/terminal mutations so this absorption path can credit
          // process-owned writes that are not yet task-related.
          const rawSelfMutated = mutableAgentState.selfMutatedPaths
          const selfMutatedPaths =
            Array.isArray(rawSelfMutated) && rawSelfMutated.length > 0
              ? new Set(rawSelfMutated)
              : undefined
          if (
            shouldAbsorbGitStatusFile({
              file,
              initialGitStatusFiles,
              gatePassedFiles,
              taskRelatedFiles: changedFiles,
              selfMutatedPaths,
            })
          ) {
            editsHappened = true
            recordChangedFiles([file], { fromStatusObservation: true })
            activeWorkState.latestWorkSummary = `Git status shows pending changed files: ${Array.from(pendingGateFiles).join(', ')}`
            markActiveWorkStateChanged()
            if (!gatePassedForCurrentEdits) editsThisStep = true
          }
        }
        if (editsThisStep) {
          gatePassedForCurrentEdits = false
          finalResponseGateOpen = false
          // Same mid-step resync as above: git-status-detected edits must also
          // retract suggest_followups permission for the remainder of this step.
          mutableAgentState.canSuggestFollowups = false
          activeWorkState.currentPhase = 'awaiting_validation'
          markActiveWorkStateChanged()
        }

        if (finalResponseGateOpen && !editsThisStep) break

        const currentPendingGateFiles = Array.from(pendingGateFiles)
        // M3 (R1d) — reset the aux-gate done-flags when the AUX-RELEVANT
        // pending gate file set changes, so security-reviewer / test-writer
        // / doc-writer each get exactly one spawn per distinct edited file
        // set. We compare the aux-relevant subset (files at least one aux
        // predicate would act on) rather than the raw set so that aux
        // OUTPUTS (test files, doc files, etc.) added in the next top-of-loop
        // extractChangedFilesFromMessages sweep do NOT perturb the snapshot
        // and do NOT trigger a *GateDone reset — preventing an infinite
        // re-spawn loop (e.g. test-writer writes foo.test.ts -> next iter
        // adds it to pendingGateFiles -> raw detectPendingGateFileSetChange
        // returns TRUE -> resetAuxGateFlags clears testWriterGateDone ->
        // test-writer re-spawns for the original source file, forever). The
        // reset snapshot stored in auxGatesLastPendingFiles is therefore the
        // aux-relevant subset.
        const auxRelevantPendingFiles = selectAuxRelevantFiles(
          currentPendingGateFiles,
        )
        if (
          detectPendingGateFileSetChange(
            activeWorkState,
            auxRelevantPendingFiles,
          )
        ) {
          resetAuxGateFlags(activeWorkState, auxRelevantPendingFiles)
          markActiveWorkStateChanged()
        }
        // Unified pre-reviewer aux gates (M3). These fire BEFORE the
        // validation/reviewer gate (which is now the FINAL gate), in order:
        // test-writer -> doc-writer -> security-reviewer. Each is predicate-
        // gated and skips silently (sets its *GateDone=true and marks work
        // state changed) when no pending file matches its relevance
        // predicate, exactly like the existing else-blocks. Each spawn uses
        // spawn_agent_inline; the runtime blocks the generator until the
        // child completes (the yield is the blocking point, and
        // finalResponseGateOpen stays false while aux work runs), so the
        // orchestrator waits for each aux spawn to finish before proceeding
        // to the next gate. After all three run (or skip), continue so the
        // loop re-enters and reaches the existing validation+reviewer loop
        // unchanged. Idempotent per pending gate file set via the done-flags
        // above.
        let auxGateFiredThisIteration = false
        const requestRequiresTests =
          !/\b(?:do not|don't|without|no)\b[^\n]{0,32}\b(?:tests?|test coverage)\b/i.test(
            prompt ?? '',
          ) &&
          /\b(?:add|write|update|fix|increase|improve)\b[^\n]{0,40}\btests?\b|\btest coverage\b/i.test(
            prompt ?? '',
          )
        const requestRequiresDocs =
          !/\b(?:do not|don't|without|no)\b[^\n]{0,32}\b(?:docs?|documentation|readme|guide)\b/i.test(
            prompt ?? '',
          ) &&
          /\b(?:docs?|documentation|document|readme|guide)\b/i.test(
            prompt ?? '',
          )
        let writerEnvironmentSummary = ''
        let projectTestWriterSelection:
          | {
              groups: Array<{
                targetFiles: string[]
                testCommand: string
                candidateTests: string[]
                manifest?: string
                packageRoot: string
              }>
            }
          | undefined
        if (
          (requestRequiresTests && !activeWorkState.testWriterGateDone) ||
          (requestRequiresDocs && !activeWorkState.docWriterGateDone)
        ) {
          const environmentInspection = yield {
            toolName: 'inspect_environment',
            input: {},
            includeToolCall: false,
          } as any
          writerEnvironmentSummary = summarizeWriterEnvironment(
            (environmentInspection as any)?.toolResult ?? environmentInspection,
          )
          if (requestRequiresTests && !activeWorkState.testWriterGateDone) {
            const affectedTests = yield {
              toolName: 'get_affected_tests',
              input: { files: currentPendingGateFiles },
              includeToolCall: false,
            } as any
            const buildTargets = yield {
              toolName: 'get_build_targets',
              input: { files: currentPendingGateFiles },
              includeToolCall: false,
            } as any
            projectTestWriterSelection = selectProjectAwareTestWriterTargets(
              currentPendingGateFiles,
              (affectedTests as any)?.toolResult ?? affectedTests,
              (buildTargets as any)?.toolResult ?? buildTargets,
            )
          }
        }
        // 1) test-writer gate
        if (
          runValidationGate &&
          editsHappened &&
          currentPendingGateFiles.length > 0 &&
          !activeWorkState.testWriterGateDone
        ) {
          const testWriterSelection =
            projectTestWriterSelection ??
            selectTestWriterTargets(currentPendingGateFiles)
          if (requestRequiresTests && testWriterSelection.groups.length > 0) {
            auxGateFiredThisIteration = true
            let testWriterCrash = ''
            for (const group of testWriterSelection.groups) {
              const testWriterResult = yield {
                toolName: 'spawn_agent_inline',
                input: {
                  agent_type: 'test-writer',
                  prompt: [
                    'Write the requested regression/behavior coverage for the verified source contract.',
                    `User request: ${prompt ?? ''}`,
                    `Source files: ${group.targetFiles.join(', ')}`,
                    `Workspace snapshot: ${mutableAgentState.workspaceState?.snapshotId ?? 'unknown'}`,
                    `Project environment: ${writerEnvironmentSummary || 'not reported'}`,
                    `Existing affected test candidates: ${group.candidateTests.join(', ') || '(none found)'}`,
                    `Parent validation command: ${group.testCommand}`,
                    'Return the declared structured writer receipt. Empty or partial output blocks finalization.',
                  ].join('\n'),
                  params: {
                    target_files: group.targetFiles,
                    test_command: group.testCommand,
                  },
                  handoff: {
                    schemaVersion: 1,
                    taskId: `test-writer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    role: 'test-writer',
                    objective:
                      'Add focused tests for the requested behavior without modifying production source.',
                    requirements: [
                      {
                        id: 'tests-required',
                        text: prompt ?? 'Add the requested test coverage.',
                        required: true,
                      },
                    ],
                    acceptanceCriteria: [
                      {
                        id: 'tests-written',
                        behavior:
                          'Focused tests are added in the existing project test structure.',
                        verification: group.testCommand,
                      },
                    ],
                    context: group.targetFiles.map((path: string) => ({
                      path,
                      symbols: [],
                      reason: 'Changed source contract requiring coverage.',
                      confidence: 'confirmed' as const,
                    })),
                    invariants: ['Do not modify production source files.'],
                    nonGoals: [
                      'Unrelated test refactors or framework changes.',
                    ],
                    risks: ['Tests must match the live source snapshot.'],
                    unknowns: [],
                    findings: [],
                    permissions: {
                      readablePaths: [
                        ...group.targetFiles,
                        ...group.candidateTests,
                        ...(group.manifest ? [group.manifest] : []),
                        ...testWriterScopePatterns(group.packageRoot),
                      ],
                      writablePaths: [
                        ...testWriterScopePatterns(group.packageRoot),
                      ],
                      allowedTools: [
                        'read_files',
                        'read_outline',
                        'edit_transaction',
                        'write_file',
                        'str_replace',
                        'set_output',
                      ],
                    },
                    workspaceRevision:
                      mutableAgentState.workspaceState?.revision,
                    workspaceSnapshotId:
                      mutableAgentState.workspaceState?.snapshotId,
                    artifacts: [],
                    successCriteria: [
                      'Writer receipt reports changed test files.',
                    ],
                    constraints: ['Use the existing test framework.'],
                  },
                },
                includeToolCall: false,
              } as any
              testWriterCrash =
                detectReviewerCrash(
                  (testWriterResult as any)?.toolResult ?? testWriterResult,
                ) ?? ''
              const testWriterReceipt = extractAgentReceipt(
                (testWriterResult as any)?.toolResult ?? testWriterResult,
              )
              const testWriterOutcome = extractWriterOutcome(
                (testWriterResult as any)?.toolResult ?? testWriterResult,
              )
              if (
                !testWriterCrash &&
                (!testWriterReceipt ||
                  testWriterReceipt.status !== 'completed' ||
                  (!(
                    testWriterOutcome?.completionKind === 'changed' &&
                    testWriterReceipt.changedFiles.length > 0
                  ) &&
                    !(
                      testWriterOutcome?.completionKind === 'noop' &&
                      testWriterReceipt.changedFiles.length === 0 &&
                      testWriterOutcome.evidence.length > 0
                    )))
              ) {
                testWriterCrash =
                  'Test-writer did not return a completed changed-files receipt or an evidence-backed no-op receipt.'
              }
              if (!testWriterCrash && group.testCommand) {
                const testValidation = yield {
                  toolName: 'spawn_agents',
                  input: {
                    agents: [
                      {
                        agent_type: 'basher',
                        params: {
                          command: group.testCommand,
                          what_to_summarize:
                            'Report whether the writer-requested validation command passed, including exact failure lines.',
                          timeout_seconds: 300,
                        },
                      },
                    ],
                  },
                  includeToolCall: false,
                } as any
                testWriterCrash =
                  detectCommandFailure(
                    (testValidation as any)?.toolResult ?? testValidation,
                  ) ?? ''
              }
              if (testWriterCrash) break
            }
            if (testWriterCrash) {
              activeWorkState.testWriterGateDone = true
              activeWorkState.validationAssurance = 'reduced'
              activeWorkState.latestWorkSummary = `Test-writer failed: ${testWriterCrash}; continuing with reduced assurance.`
              markActiveWorkStateChanged()
            } else {
              activeWorkState.testWriterGateDone = true
              markActiveWorkStateChanged()
              emitGateTelemetry({
                currentPhase: 'awaiting_validation',
                pendingFileCount: currentPendingGateFiles.length,
                pendingFiles: currentPendingGateFiles,
                validationStatus: 'passed',
                reviewerStatus: 'passed',
                reuseReason: 'aux-gate:test-writer',
              })
            }
          } else {
            activeWorkState.testWriterGateDone = true
            markActiveWorkStateChanged()
          }
        }
        // 2) doc-writer gate
        if (
          runValidationGate &&
          editsHappened &&
          currentPendingGateFiles.length > 0 &&
          !activeWorkState.docWriterGateDone
        ) {
          const docTargets = selectDocWriterTargets(currentPendingGateFiles)
          if (requestRequiresDocs && docTargets.length > 0) {
            auxGateFiredThisIteration = true
            const docWriterResult = yield {
              toolName: 'spawn_agent_inline',
              input: {
                agent_type: 'doc-writer',
                prompt: [
                  'Document the verified public contract affected by the current change.',
                  `User request: ${prompt ?? ''}`,
                  `Source files: ${docTargets.join(', ')}`,
                  `Workspace snapshot: ${mutableAgentState.workspaceState?.snapshotId ?? 'unknown'}`,
                  `Project environment: ${writerEnvironmentSummary || 'not reported'}`,
                  'Return the declared structured writer receipt. Empty or partial output blocks finalization.',
                ].join('\n'),
                params: {
                  source_files: docTargets,
                },
                handoff: {
                  schemaVersion: 1,
                  taskId: `doc-writer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                  role: 'doc-writer',
                  objective:
                    'Update documentation for the requested public behavior without modifying production source.',
                  requirements: [
                    {
                      id: 'docs-required',
                      text: prompt ?? 'Update the requested documentation.',
                      required: true,
                    },
                  ],
                  acceptanceCriteria: [
                    {
                      id: 'docs-written',
                      behavior:
                        'Documentation accurately reflects the live public contract.',
                      verification:
                        'Final code review checks documentation accuracy against the source snapshot.',
                    },
                  ],
                  context: docTargets.map((path: string) => ({
                    path,
                    symbols: [],
                    reason: 'Changed public contract requiring documentation.',
                    confidence: 'confirmed' as const,
                  })),
                  invariants: ['Do not modify production source files.'],
                  nonGoals: [
                    'Marketing copy or unrelated documentation cleanup.',
                  ],
                  risks: [
                    'Documentation must not invent unsupported behavior.',
                  ],
                  unknowns: [],
                  findings: [],
                  permissions: {
                    // Mirror doc-writer's static filesystemScope.read (already '**/*') so this
                    // per-spawn handoff does not narrow below the agent's static read ceiling.
                    // Writes stay doc-only via docWriterScopePatterns and the agent has no
                    // terminal/network/spawn tool, so repo-wide read grants no exfiltration path.
                    readablePaths: ['**/*'],
                    writablePaths: docWriterScopePatterns(docTargets),
                    allowedTools: [
                      'read_files',
                      'read_outline',
                      'read_subtree',
                      'edit_transaction',
                      'str_replace',
                      'write_file',
                      'set_output',
                    ],
                  },
                  workspaceRevision: mutableAgentState.workspaceState?.revision,
                  workspaceSnapshotId:
                    mutableAgentState.workspaceState?.snapshotId,
                  artifacts: [],
                  successCriteria: [
                    'Writer receipt reports changed documentation files.',
                  ],
                  constraints: ['Match adjacent documentation style.'],
                },
              },
              includeToolCall: false,
            } as any
            const docWriterCrash = detectReviewerCrash(
              (docWriterResult as any)?.toolResult ?? docWriterResult,
            )
            const docWriterReceipt = extractAgentReceipt(
              (docWriterResult as any)?.toolResult ?? docWriterResult,
            )
            const docWriterOutcome = extractWriterOutcome(
              (docWriterResult as any)?.toolResult ?? docWriterResult,
            )
            const docWriterFailure =
              docWriterCrash ??
              (!docWriterReceipt ||
              docWriterReceipt.status !== 'completed' ||
              (!(
                docWriterOutcome?.completionKind === 'changed' &&
                docWriterReceipt.changedFiles.length > 0
              ) &&
                !(
                  docWriterOutcome?.completionKind === 'noop' &&
                  docWriterReceipt.changedFiles.length === 0 &&
                  docWriterOutcome.evidence.length > 0
                ))
                ? 'Doc-writer did not return a completed changed-files receipt or an evidence-backed no-op receipt.'
                : null)
            if (docWriterFailure) {
              activeWorkState.docWriterGateDone = true
              activeWorkState.validationAssurance = 'reduced'
              activeWorkState.latestWorkSummary = `Doc-writer failed: ${docWriterFailure}; continuing with reduced assurance.`
              markActiveWorkStateChanged()
            } else {
              activeWorkState.docWriterGateDone = true
              markActiveWorkStateChanged()
              emitGateTelemetry({
                currentPhase: 'awaiting_validation',
                pendingFileCount: currentPendingGateFiles.length,
                pendingFiles: currentPendingGateFiles,
                validationStatus: 'passed',
                reviewerStatus: 'passed',
                reuseReason: 'aux-gate:doc-writer',
              })
            }
          } else {
            activeWorkState.docWriterGateDone = true
            markActiveWorkStateChanged()
          }
        }
        // 3) security-reviewer gate. The credit fingerprint is computed BEFORE
        // the condition so the gate also re-fires when a stored credit no
        // longer matches the current pending bytes (fail closed for legacy
        // state that stored no fingerprint at all).
        // Entry still uses the full pending list for matchesSecuritySensitiveGlob.
        // Spawn/attestation/credit fingerprint use only the security-sensitive
        // reviewable subset so co-pending non-sensitive files (tool diets,
        // base2.ts, tests, etc.) are not forced into security attestation.
        const securityReviewableFiles = selectReviewableGateFiles(
          currentPendingGateFiles,
        )
        const securitySensitiveReviewableFiles = securityReviewableFiles.filter(
          (file) => matchesSecuritySensitiveGlob([file]),
        )
        const securityChangedFiles = securitySensitiveReviewableFiles
        const securitySnapshotDetails = buildGateSnapshotDetails(
          securityChangedFiles,
          '',
        )
        // Deleted pending files (a `missing` content marker) are
        // attested-by-absence, matching the final code-reviewer path.
        const securityDeletedFiles = collectDeletedFilesFromSnapshotDetails(
          securitySnapshotDetails,
        )
        const securitySnapshotFingerprint = hashGateSnapshotDetails(
          securitySnapshotDetails,
        )
        // A done credit with an absent fingerprint (legacy / seeded state)
        // satisfies the gate; a stored fingerprint re-fires only on real byte
        // drift, so fail-closed drift detection and owed-security revalidation
        // (which never marks done on block) are both preserved.
        const securityCreditIsFresh =
          activeWorkState.securityReviewGateFingerprint === undefined ||
          activeWorkState.securityReviewGateFingerprint ===
            securitySnapshotFingerprint
        const owedReviewers = activeWorkState.owedReviewerRevalidations ?? []
        const securityWouldRefire =
          runValidationGate &&
          editsHappened &&
          currentPendingGateFiles.length > 0 &&
          (!activeWorkState.securityReviewGateDone || !securityCreditIsFresh) &&
          (owedReviewers.length === 0 ||
            owedReviewers.includes('security-reviewer'))
        // If a prior security protocol block left the gate stuck but the current
        // pending set is no longer security-sensitive, clear the stuck credit so
        // validation can continue without re-firing security-reviewer.
        if (
          securityWouldRefire &&
          !matchesSecuritySensitiveGlob(currentPendingGateFiles)
        ) {
          const nextRequired = activeWorkState.nextRequiredAction ?? ''
          const latestSummary = activeWorkState.latestWorkSummary ?? ''
          const stuckOnSecurityProtocol =
            nextRequired.includes(
              'fresh matching snapshot-bound security review',
            ) || /security review is incomplete/i.test(latestSummary)
          if (stuckOnSecurityProtocol) {
            activeWorkState.securityReviewGateDone = true
            activeWorkState.preEditSecurityReviewDone = true
            activeWorkState.securityReviewGateFingerprint =
              securitySnapshotFingerprint
            if (
              activeWorkState.currentPhase === 'blocked' &&
              nextRequired.includes(
                'fresh matching snapshot-bound security review',
              )
            ) {
              activeWorkState.currentPhase = 'awaiting_validation'
              activeWorkState.nextRequiredAction = ''
            }
            markActiveWorkStateChanged()
          }
        }
        // Entry matched on full pending, but only sensitive reviewable files are
        // spawned/attested. Empty sensitive set credits done without spawn.
        if (
          securityWouldRefire &&
          matchesSecuritySensitiveGlob(currentPendingGateFiles) &&
          securityChangedFiles.length === 0
        ) {
          activeWorkState.securityReviewGateDone = true
          activeWorkState.preEditSecurityReviewDone = true
          activeWorkState.securityReviewGateFingerprint =
            securitySnapshotFingerprint
          if (
            activeWorkState.currentPhase === 'blocked' &&
            (activeWorkState.nextRequiredAction ?? '').includes(
              'fresh matching snapshot-bound security review',
            )
          ) {
            activeWorkState.currentPhase = 'awaiting_validation'
            activeWorkState.nextRequiredAction = ''
          }
          markActiveWorkStateChanged()
        }
        if (
          securityWouldRefire &&
          matchesSecuritySensitiveGlob(currentPendingGateFiles) &&
          securityChangedFiles.length > 0
        ) {
          auxGateFiredThisIteration = true
          const securityReviewResult = yield {
            toolName: 'spawn_agent_inline',
            input: {
              agent_type: 'security-reviewer',
              prompt: [
                'Perform the required snapshot-bound security review.',
                `Pending changed files: ${securityChangedFiles.join(', ')}`,
                `Snapshot fingerprint: ${securitySnapshotFingerprint}`,
                'Return only the declared structured output.',
              ].join('\n'),
              params: {
                changed_files: securityChangedFiles,
                snapshot_fingerprint: securitySnapshotFingerprint,
              },
            },
            includeToolCall: false,
          } as any
          const securityToolResult =
            (securityReviewResult as any)?.toolResult ?? securityReviewResult
          const securityCrash = detectReviewerCrash(securityToolResult)
          // Parent-owned process RF strings are not repair targets for security.
          // Pass toolResult so evidence-only parent ownership matches finalization.
          const rawSecurityBlockers =
            collectReviewerBlockers(securityToolResult)
          // One structured walk for the whole list: the per-blocker helper
          // re-collects the structured reviewer outputs on every call.
          const parentOwnedSecurityBlockers =
            collectParentOwnedRequirementBlockers(
              rawSecurityBlockers,
              securityToolResult,
            )
          const securityBlockers = rawSecurityBlockers.filter(
            (blocker: string) => !parentOwnedSecurityBlockers.has(blocker),
          )
          const securityAttestationIssues = collectReviewerAttestationIssues(
            securityToolResult,
            securitySnapshotFingerprint,
            securityChangedFiles,
            securityDeletedFiles,
          )
          const securityVerdict =
            getReviewerFinalizationVerdict(securityToolResult)
          const securityProtocolFailure =
            securityCrash ||
            securityAttestationIssues.length > 0 ||
            !securityVerdict
          if (securityBlockers.length > 0) {
            const records = collectReviewerFindingRecords(securityToolResult)
            const securityFindingRecords = securityBlockers.map(
              (text: string, index: number) => {
                const record = correlateReviewerFindingRecord(text, records)
                return {
                  id: record?.id ?? buildReviewerFindingId(text, index),
                  gateId: `security-reviewer:${securitySnapshotFingerprint}`,
                  // The PREFIXED blocker string, like the code-reviewer path:
                  // `reviewerVerdictClass` derives the condone key's verdict
                  // class from this text, so storing the record's unprefixed
                  // text made every security finding class-agnostic (`*`) and a
                  // nit condoned as NON_BLOCKING silently swallowed its own
                  // BLOCKING re-raise. Only the id is adopted from the record.
                  text,
                  status: 'open' as const,
                  files: securityChangedFiles,
                  snapshotFingerprint: securitySnapshotFingerprint,
                  reviewer: 'security-reviewer' as const,
                  createdAt: new Date().toISOString(),
                }
              },
            )
            // Merge instead of replace: another reviewer's still-open
            // findings/blockers must not be clobbered by security-reviewer.
            mergeReviewerFindings(
              'security-reviewer',
              securityFindingRecords,
              securityBlockers,
            )
            addOwedReviewer('security-reviewer')
            activeWorkState.currentPhase = 'repair_loop'
            activeWorkState.nextRequiredAction =
              'Repair-editor must address every open security-review finding before validation and finalization.'
            activeWorkState.latestWorkSummary =
              'Security review reported blocking findings; repair is required.'
            activeWorkState.securityReviewGateDone = false
            activeWorkState.preEditSecurityReviewDone = false
            activeWorkState.securityReviewGateFingerprint = undefined
            markActiveWorkStateChanged()
            emitGateTelemetry({
              currentPhase: 'repair_loop',
              pendingFileCount: currentPendingGateFiles.length,
              pendingFiles: currentPendingGateFiles,
              reviewerStatus: 'failed',
              validationStatus: 'passed',
              blockerCount: securityBlockers.length,
              reuseReason: 'aux-gate:security-reviewer-blocking',
            })
            yield {
              toolName: 'add_message',
              input: {
                role: 'user',
                content: [
                  'Security reviewer returned blocking findings. The harness will send these exact findings to repair-editor:',
                  '',
                  ...securityBlockers,
                  '',
                  'These findings remain open until targeted validation and a fresh matching security review clear them.',
                ].join('\n'),
              },
              includeToolCall: false,
            } as any
            const securityRepairResult = yield {
              toolName: 'spawn_agents',
              input: {
                agents: [
                  {
                    agent_type: 'repair-editor',
                    handoff: {
                      schemaVersion: 1,
                      taskId: `security-review-repair-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                      role: 'repair-editor',
                      objective:
                        'Resolve every open security-review finding without unrelated changes.',
                      requirements: activeWorkState.openReviewerFindings.map(
                        ({ id, text }) => ({ id, text, required: true }),
                      ),
                      acceptanceCriteria:
                        activeWorkState.openReviewerFindings.map(({ id }) => ({
                          id: `clear-${id}`,
                          behavior: `Security finding ${id} is addressed in the live workspace.`,
                          verification:
                            'Targeted validation passes and a fresh snapshot-bound security review clears the finding.',
                        })),
                      context: [],
                      invariants: [
                        'Read every target from the live filesystem before editing.',
                        'Treat every finding ID as open until a fresh security reviewer clears it.',
                      ],
                      nonGoals: [
                        'Unrelated diagnostics, refactors, or cleanup.',
                      ],
                      risks: [
                        'Security findings may be stale if the workspace snapshot changed.',
                      ],
                      unknowns: [],
                      findings: activeWorkState.openReviewerFindings.map(
                        ({ id, text, files, snapshotFingerprint }) => ({
                          id,
                          text,
                          files,
                          snapshotFingerprint,
                        }),
                      ),
                      permissions: {
                        readablePaths: repairEditorReadablePaths(
                          [
                            ...pendingGateFiles,
                            ...activeWorkState.openReviewerFindings.flatMap(
                              (finding: { files?: string[] }) =>
                                finding.files ?? [],
                            ),
                          ],
                          activeWorkState.openReviewerFindings.map(
                            (finding: { text?: string }) => finding.text ?? '',
                          ),
                        ),
                        writablePaths: Array.from(
                          new Set([
                            ...pendingGateFiles,
                            ...activeWorkState.openReviewerFindings.flatMap(
                              (finding: { files?: string[] }) =>
                                finding.files ?? [],
                            ),
                          ]),
                        ),
                        allowedTools: [
                          'read_files',
                          'read_outline',
                          'read_subtree',
                          'edit_transaction',
                        ],
                      },
                      workspaceRevision:
                        mutableAgentState.workspaceState?.revision,
                      workspaceSnapshotId:
                        mutableAgentState.workspaceState?.snapshotId,
                      artifacts: [],
                      successCriteria: [
                        'All security finding IDs are cleared by a fresh reviewer receipt.',
                      ],
                      constraints: [
                        'Keep every edit within the pending gate file set.',
                      ],
                    },
                    prompt: [
                      'Repair the blocking security-review findings below.',
                      'Treat every finding ID as open until a fresh security reviewer clears it.',
                      'Read every target from the live filesystem before editing.',
                      '',
                      ...activeWorkState.openReviewerFindings.map(
                        (finding) => `${finding.id}: ${finding.text}`,
                      ),
                    ].join('\n'),
                  },
                ],
              },
            } as any
            const securityRepairReceipt = extractAgentReceipt(
              (securityRepairResult as any)?.toolResult ?? securityRepairResult,
            )
            const openSecurityFindingIds = new Set(
              activeWorkState.openReviewerFindings.map((finding) => finding.id),
            )
            const securityRepairHasProgress =
              !!securityRepairReceipt &&
              securityRepairReceipt.changedFiles.some(
                (file: { path: string }) =>
                  typeof file.path === 'string' && file.path.trim().length > 0,
              )
            if (
              !securityRepairReceipt ||
              (!securityRepairHasProgress &&
                (securityRepairReceipt.status !== 'completed' ||
                  [...openSecurityFindingIds].some(
                    (id) =>
                      !securityRepairReceipt.findingsAddressed.includes(id),
                  )))
            ) {
              activeWorkState.currentPhase = 'blocked'
              activeWorkState.nextRequiredAction =
                'Repair-editor did not return a completed receipt addressing every open security-review finding.'
              activeWorkState.latestWorkSummary =
                'Security-review repair receipt was incomplete or missing.'
              markActiveWorkStateChanged()
              break
            }
            addOwedReviewer('security-reviewer')
            activeWorkState.currentPhase = 'awaiting_validation'
            activeWorkState.nextRequiredAction = ''
            activeWorkState.latestWorkSummary =
              'Repair-editor addressed security-review findings; targeted validation and a fresh security review are required.'
            markActiveWorkStateChanged()
            continue
          } else if (securityProtocolFailure) {
            const protocolFailureDetail =
              securityCrash ||
              securityAttestationIssues.join('; ') ||
              'Security reviewer did not return a valid verdict.'
            activeWorkState.currentPhase = 'blocked'
            activeWorkState.nextRequiredAction =
              'Obtain a fresh matching snapshot-bound security review before validation or finalization can continue.'
            activeWorkState.latestWorkSummary = `Security review is incomplete: ${protocolFailureDetail}`
            activeWorkState.securityReviewGateDone = false
            activeWorkState.preEditSecurityReviewDone = false
            activeWorkState.securityReviewGateFingerprint = undefined
            markActiveWorkStateChanged()
            emitGateTelemetry({
              currentPhase: 'blocked',
              pendingFileCount: currentPendingGateFiles.length,
              pendingFiles: currentPendingGateFiles,
              reviewerStatus: 'failed',
              validationStatus: 'passed',
              skipReason: 'security-review-protocol-failure',
            })
            yield {
              toolName: 'add_message',
              input: {
                role: 'user',
                content: [
                  'Security review could not be verified and remains incomplete.',
                  `Protocol failure: ${protocolFailureDetail}`,
                  'Next required action: obtain a fresh matching snapshot-bound security review before validation or finalization can continue.',
                ].join('\n'),
              },
              includeToolCall: false,
            } as any
            break
          } else {
            recordSuccessfulReviewReceipt(
              securityToolResult,
              'security-reviewer',
              securitySnapshotFingerprint,
            )
            markActiveWorkStateChanged()
            emitGateTelemetry({
              currentPhase: 'awaiting_validation',
              pendingFileCount: currentPendingGateFiles.length,
              pendingFiles: currentPendingGateFiles,
              reviewerStatus: 'passed',
              validationStatus: 'passed',
              reuseReason: 'aux-gate:security-reviewer',
            })
            // Non-empty only: a passing security gate stays silent exactly as
            // before whenever the receipt carries no advisories.
            const securityAdvisories = boundAdvisoryLines(
              collectReviewerAdvisories(securityToolResult),
            )
            if (securityAdvisories.length > 0) {
              yield {
                toolName: 'add_message',
                input: {
                  role: 'user',
                  content: [
                    'Advisories (non-blocking; no change required):',
                    ...securityAdvisories.map((advisory) => `- ${advisory}`),
                  ].join('\n'),
                },
                includeToolCall: false,
              } as any
            }
          }
          activeWorkState.securityReviewGateDone = true
          activeWorkState.preEditSecurityReviewDone = true
          // Snapshot-bind the credit: a later byte change to the same pending
          // paths (including a validation-hook rewrite) no longer matches, so
          // the gate re-fires instead of reusing credit for unreviewed bytes.
          activeWorkState.securityReviewGateFingerprint =
            securitySnapshotFingerprint
          // The security aux block owns security-family revalidation; clear its
          // owed entry once it passes, but never clobber a code/specialist one.
          clearOwedReviewer('security-reviewer')
          markActiveWorkStateChanged()
        }
        // 4) deterministic reviewer-family specialist gates. Advisory
        // specialists never participate in this blocking post-edit path.
        if (
          runValidationGate &&
          editsHappened &&
          currentPendingGateFiles.length > 0
        ) {
          // Specialist-family revalidation is owned by this aux block: every
          // owed specialist must re-review through its own snapshot/attestation
          // path even if it already passed for this pending set. Drop each of
          // them from the done-set (and their stored credit fingerprints) so the
          // filter below does not re-exclude them, and union all of them into
          // the routed list so they are re-included even if the router would
          // not otherwise select them.
          const owedSpecialists = (
            activeWorkState.owedReviewerRevalidations ?? []
          ).filter(
            (agent) =>
              agent !== 'code-reviewer' && agent !== 'security-reviewer',
          ) as string[]
          for (const owedSpecialist of owedSpecialists) {
            if (
              activeWorkState.specialistReviewGatesDone?.includes(
                owedSpecialist,
              )
            ) {
              activeWorkState.specialistReviewGatesDone =
                activeWorkState.specialistReviewGatesDone.filter(
                  (agentType) => agentType !== owedSpecialist,
                )
              markActiveWorkStateChanged()
            }
            if (
              activeWorkState.specialistReviewGateFingerprints &&
              owedSpecialist in activeWorkState.specialistReviewGateFingerprints
            ) {
              delete activeWorkState.specialistReviewGateFingerprints[
                owedSpecialist
              ]
              markActiveWorkStateChanged()
            }
          }
          // Snapshot binding for specialist credit: the content fingerprint of
          // the AUX-RELEVANT reviewable pending subset at spawn time. Stored on
          // pass and compared in specialistCreditIsFresh so a byte change to
          // those paths (or legacy state with no stored fingerprint) re-reviews.
          // The narrowing to the aux-relevant subset is DELIBERATE and is
          // deliberately weaker than the reviewed set: specialists are spawned
          // with the reviewable pending subset, but co-changed test files that
          // are not aux-relevant are kept out of the credit fingerprint so
          // ordinary test-writer churn does not invalidate specialist credit on
          // every sweep. The accepted consequence is that byte drift confined to
          // those test files alone does not force a specialist re-review; drift
          // in any aux-relevant source file still does.
          const specialistPendingFiles = selectReviewableGateFiles(
            currentPendingGateFiles,
          )
          const specialistCreditFingerprint = hashGateSnapshotDetails(
            buildGateSnapshotDetails(
              selectReviewableGateFiles(
                selectAuxRelevantFiles(currentPendingGateFiles),
              ),
              '',
            ),
          )
          // Deleted pending files (a `missing` content marker in the files-v4
          // snapshot details) are attested-by-absence: a specialist cannot read
          // them, so they are not required in its reviewedFiles. Computed once
          // from the specialist pending snapshot and reused by both specialist
          // attestation call sites, matching the final code-reviewer path — a
          // deleted pending path must never produce a coverage gap that can
          // escalate to the terminal `could not attest` branch.
          const specialistDeletedFiles = collectDeletedFilesFromSnapshotDetails(
            buildGateSnapshotDetails(specialistPendingFiles, ''),
          )
          const baseRoutedSpecialists = selectSpecialistReviewersInline({
            files: specialistPendingFiles,
            requirements: prompt ?? '',
          })
          const routedSpecialists = (
            owedSpecialists.length > 0
              ? Array.from(
                  new Set([...baseRoutedSpecialists, ...owedSpecialists]),
                )
              : baseRoutedSpecialists
          ).filter(
            (agentType) =>
              !specialistCreditIsFresh(agentType, specialistCreditFingerprint),
          )
          if (
            routedSpecialists.length > 0 &&
            specialistPendingFiles.length === 0
          ) {
            // Requirements may still route a specialist, but with no
            // reviewable pending files there is nothing to attest. Mark done
            // instead of spawning a reviewer that can only fail file
            // attestation. (Empty-bundle evidence must NOT auto-credit when
            // pending files still exist — that path always spawns.)
            for (const agentType of routedSpecialists) {
              activeWorkState.specialistReviewGatesDone = Array.from(
                new Set([
                  ...(activeWorkState.specialistReviewGatesDone ?? []),
                  agentType,
                ]),
              )
              ;(activeWorkState.specialistReviewGateFingerprints ??= {})[
                agentType
              ] = specialistCreditFingerprint
            }
            activeWorkState.lastReviewerGateSkipReason =
              'no-pending-changes-in-snapshot'
            markActiveWorkStateChanged()
            emitGateTelemetry({
              currentPhase: 'final_response_allowed',
              pendingFileCount: 0,
              pendingFiles: [],
              reviewerStatus: 'skipped',
              validationStatus: 'skipped',
              reuseReason: 'no-pending-changes-in-snapshot',
            })
          } else if (routedSpecialists.length > 0) {
            // Gate-owned v3 fingerprint is the sole specialist attestation
            // token (same family as security/code-reviewer). Fail closed when
            // crypto is unavailable rather than spawning with a bare bundle id.
            if (!isAttestableSnapshotFingerprint(specialistCreditFingerprint)) {
              activeWorkState.currentPhase = 'blocked'
              activeWorkState.openReviewerBlockers = [
                'Specialist review cannot attest: gate snapshot fingerprint is non-attestable (crypto unavailable).',
              ]
              activeWorkState.nextRequiredAction =
                'Restore a runtime with collision-resistant hashing before specialist review can continue.'
              activeWorkState.latestWorkSummary =
                'Specialist review blocked because the gate fingerprint is non-attestable.'
              markActiveWorkStateChanged()
              continue
            }
            // get_change_review_bundle is read-only evidence (files/diff/
            // empty-tree). Bundle snapshotId is NOT the gate attestation token.
            const bundleResult = yield {
              toolName: 'get_change_review_bundle',
              input: {},
              includeToolCall: false,
            } as any
            const bundle = extractChangeReviewBundle(
              (bundleResult as any)?.toolResult ?? bundleResult,
            )
            // Empty/failed bundle must not falsely clear specialist review when
            // reviewable pending files exist. This branch only runs after the
            // specialistPendingFiles.length === 0 early credit path, so always
            // spawn with the gate-owned v3 token — never auto-credit from
            // empty-tree evidence alone (bundle snapshotId is not attestation).
            void bundle
            {
              auxGateFiredThisIteration = true
              let specialistBlocked = false
              let specialistTerminalFailure = false
              // Set only by the bounded specialist repair loop when it must
              // exit the OUTER while loop (repair budget exhausted, missing
              // repair receipt, repair crash, or no snapshot-visible progress).
              // Every other specialist break stays scoped to the routed-agent
              // for loop.
              let specialistRepairExit = false
              const specialistResults = new Map<string, unknown>()
              const specialistSnapshots = new Map<string, string>()
              for (const agentType of routedSpecialists) {
                specialistSnapshots.set(agentType, specialistCreditFingerprint)
              }
              const firstSpecialistBatch = yield {
                toolName: 'spawn_agents',
                input: {
                  agents: routedSpecialists.map((agentType) => ({
                    agent_type: agentType,
                    prompt: buildSpecialistScopedReviewPrompt({
                      title: 'Perform the routed post-edit specialist review.',
                      agentType,
                      files: specialistPendingFiles,
                      snapshotFingerprint: specialistCreditFingerprint,
                      userPrompt: prompt ?? '',
                    }),
                    params: {
                      files: specialistPendingFiles,
                      snapshot_id: specialistCreditFingerprint,
                    },
                  })),
                },
                includeToolCall: false,
              } as any
              const firstBatchToolResult =
                (firstSpecialistBatch as any)?.toolResult ??
                firstSpecialistBatch
              for (const agentType of routedSpecialists) {
                specialistResults.set(
                  agentType,
                  extractSpawnedAgentResult(firstBatchToolResult, agentType),
                )
              }
              const retrySpecialists = routedSpecialists.filter((agentType) => {
                const result = specialistResults.get(agentType)
                // A fully-attesting review (every pending source file covered
                // by a well-formed snapshot fingerprint) is accepted even when
                // the exact snapshot id advanced; only genuine file-coverage
                // gaps or a missing/non-attestable fingerprint require a
                // re-spawn. `isStaleSnapshotReviewerResult` is therefore only
                // consulted when attestation issues remain, so transient
                // snapshot drift never triggers a pointless refresh+retry.
                const attestationIssues = collectReviewerAttestationIssues(
                  result,
                  specialistCreditFingerprint,
                  specialistPendingFiles,
                  specialistDeletedFiles,
                )
                return (
                  attestationIssues.length > 0 &&
                  isStaleSnapshotReviewerResult(result)
                )
              })
              if (retrySpecialists.length > 0) {
                // Retry identity is the recomputed gate fingerprint of the
                // current pending set — not a new bare bundle snapshotId.
                // Bundle refresh is optional evidence only.
                const retryCreditFingerprint = hashGateSnapshotDetails(
                  buildGateSnapshotDetails(
                    selectReviewableGateFiles(
                      selectAuxRelevantFiles(currentPendingGateFiles),
                    ),
                    '',
                  ),
                )
                if (!isAttestableSnapshotFingerprint(retryCreditFingerprint)) {
                  activeWorkState.currentPhase = 'blocked'
                  activeWorkState.openReviewerBlockers = [
                    'Specialist review retry cannot attest: recomputed gate snapshot fingerprint is non-attestable.',
                  ]
                  // Only drop the retrying specialists' findings; another
                  // reviewer's still-open findings must survive.
                  activeWorkState.openReviewerFindings = (
                    activeWorkState.openReviewerFindings ?? []
                  ).filter(
                    (finding) =>
                      !retrySpecialists.includes(finding.reviewer as string),
                  )
                  activeWorkState.nextRequiredAction =
                    'Restore a runtime with collision-resistant hashing before specialist review can continue.'
                  activeWorkState.latestWorkSummary =
                    'Specialist review stopped because the retry gate fingerprint is non-attestable.'
                  markActiveWorkStateChanged()
                  specialistBlocked = true
                  specialistTerminalFailure = true
                } else {
                  // Optional evidence refresh; ignore missing snapshotId.
                  yield {
                    toolName: 'get_change_review_bundle',
                    input: {},
                    includeToolCall: false,
                  } as any
                  const retryBatch = yield {
                    toolName: 'spawn_agents',
                    input: {
                      agents: retrySpecialists.map((agentType) => ({
                        agent_type: agentType,
                        prompt: buildSpecialistScopedReviewPrompt({
                          title:
                            'Retry the routed specialist review after snapshot/file attestation failure.',
                          agentType,
                          files: specialistPendingFiles,
                          snapshotFingerprint: retryCreditFingerprint,
                          userPrompt: prompt ?? '',
                          extraLines: [
                            'Correct the structured output directly; do not request source edits for this protocol error.',
                          ],
                        }),
                        params: {
                          files: specialistPendingFiles,
                          snapshot_id: retryCreditFingerprint,
                        },
                      })),
                    },
                    includeToolCall: false,
                  } as any
                  const retryToolResult =
                    (retryBatch as any)?.toolResult ?? retryBatch
                  for (const agentType of retrySpecialists) {
                    specialistSnapshots.set(agentType, retryCreditFingerprint)
                    specialistResults.set(
                      agentType,
                      extractSpawnedAgentResult(retryToolResult, agentType),
                    )
                  }
                }
              }
              if (!specialistTerminalFailure) {
                for (const agentType of routedSpecialists) {
                  const expectedSnapshotId =
                    specialistSnapshots.get(agentType) ??
                    specialistCreditFingerprint
                  const specialistToolResult = specialistResults.get(agentType)
                  const specialistAttestationIssues =
                    collectReviewerAttestationIssues(
                      specialistToolResult,
                      expectedSnapshotId,
                      specialistPendingFiles,
                      specialistDeletedFiles,
                    )
                  // Fingerprint-only drift on a fully-attesting review is NOT a
                  // terminal protocol failure: only a FILE-COVERAGE gap or a
                  // non-attestable fingerprint stays blocking after the refresh.
                  const attestsEverything =
                    specialistAttestationIssues.length === 0
                  // A coverage-complete review (zero attestation issues) is a
                  // PASS and FALLS THROUGH to the normal verdict/credit
                  // handling below (collectReviewerBlockers /
                  // getReviewerFinalizationVerdict / specialistReviewGatesDone /
                  // specialistReviewGateFingerprints). Only a review that does
                  // NOT fully attest AND smells stale is a terminal protocol
                  // failure. Do NOT `continue` here for attestsEverything: that
                  // would skip to the next routed specialist and silently never
                  // credit this one.
                  if (
                    !attestsEverything &&
                    isStaleSnapshotReviewerResult(specialistToolResult)
                  ) {
                    activeWorkState.currentPhase = 'blocked'
                    activeWorkState.openReviewerBlockers = [
                      `${agentType} could not attest to a stable snapshot after one automatic refresh.`,
                      ...specialistAttestationIssues,
                    ]
                    activeWorkState.openReviewerFindings = (
                      activeWorkState.openReviewerFindings ?? []
                    ).filter((finding) => finding.reviewer !== agentType)
                    activeWorkState.nextRequiredAction =
                      'Stop concurrent edits and resume once the working tree is stable; the runtime will obtain a fresh review bundle.'
                    activeWorkState.latestWorkSummary = `${agentType} stopped after two stale snapshot results.`
                    markActiveWorkStateChanged()
                    specialistBlocked = true
                    specialistTerminalFailure = true
                    break
                  }
                  // Attestation tolerates a coverage-complete specialist review
                  // whose well-formed v3 fingerprint drifted from the expected
                  // snapshot; record that drift instead of accepting it
                  // silently, so a specialist review of possibly-stale file
                  // content that passed the gate stays auditable (same contract
                  // as the final code-reviewer gate).
                  if (attestsEverything) {
                    const specialistFingerprintDrift =
                      collectReviewerFingerprintDrift(
                        specialistToolResult,
                        expectedSnapshotId,
                      )
                    if (specialistFingerprintDrift) {
                      emitGateTelemetry({
                        currentPhase: activeWorkState.currentPhase,
                        pendingFileCount: specialistPendingFiles.length,
                        pendingFiles: specialistPendingFiles,
                        reviewerStatus: 'attestation-fingerprint-drift',
                        reviewer: agentType,
                        reportedFingerprint: specialistFingerprintDrift,
                        expectedFingerprint: expectedSnapshotId,
                      })
                    }
                  }
                  const crash = detectReviewerCrash(specialistToolResult)
                  const rawBlockers =
                    collectReviewerBlockers(specialistToolResult)
                  // Defense in depth: parent-owned process RF strings must not
                  // alone force a specialist repair-editor spawn. Classify the
                  // whole list in ONE structured walk (the per-blocker helper
                  // re-collects the structured outputs on every call) so
                  // evidence-only parent ownership still matches
                  // getReviewerFinalizationVerdict.
                  const parentOwnedSpecialistBlockers =
                    collectParentOwnedRequirementBlockers(
                      rawBlockers,
                      specialistToolResult,
                    )
                  const blockers = rawBlockers.filter(
                    (blocker: string) =>
                      !parentOwnedSpecialistBlockers.has(blocker),
                  )
                  const parentOwnedOnlyBlockers =
                    rawBlockers.length > 0 && blockers.length === 0
                  const verdict =
                    getReviewerFinalizationVerdict(specialistToolResult)
                  if (parentOwnedOnlyBlockers && verdict === 'LOOKS_GOOD') {
                    // Pure parent-owned requirementCoverage gaps with LOOKS_GOOD:
                    // credit the specialist the same as a clean pass.
                    delete (activeWorkState.specialistNoVerdictCounts ??= {})[
                      agentType
                    ]
                    recordSuccessfulReviewReceipt(
                      specialistToolResult,
                      agentType,
                      expectedSnapshotId,
                    )
                    activeWorkState.specialistReviewGatesDone = Array.from(
                      new Set([
                        ...(activeWorkState.specialistReviewGatesDone ?? []),
                        agentType,
                      ]),
                    )
                    ;(activeWorkState.specialistReviewGateFingerprints ??= {})[
                      agentType
                    ] = specialistCreditFingerprint
                    if (
                      activeWorkState.lastReviewerGateSkipReason ===
                        'specialist-terminal-failure' ||
                      activeWorkState.lastReviewerGateSkipReason ===
                        'specialist-rate-limited'
                    ) {
                      activeWorkState.lastReviewerGateSkipReason = ''
                    }
                    clearOwedReviewer(agentType)
                    markActiveWorkStateChanged()
                    const parentOwnedPassAdvisories = boundAdvisoryLines(
                      collectReviewerAdvisories(specialistToolResult),
                    )
                    yield {
                      toolName: 'add_message',
                      input: {
                        role: 'user',
                        content: [
                          `${agentType} returned LOOKS_GOOD; parent-owned process requirements were ignored for the specialist gate (not repair targets):`,
                          '',
                          ...rawBlockers,
                          ...(parentOwnedPassAdvisories.length > 0
                            ? [
                                '',
                                'Advisories (non-blocking; no change required):',
                                ...parentOwnedPassAdvisories.map(
                                  (advisory) => `- ${advisory}`,
                                ),
                              ]
                            : []),
                        ].join('\n'),
                      },
                      includeToolCall: false,
                    } as any
                    continue
                  }
                  if (blockers.length > 0) {
                    const records =
                      collectReviewerFindingRecords(specialistToolResult)
                    const specialistFindingRecords = blockers.map(
                      (text: string, index: number) => {
                        const record = correlateReviewerFindingRecord(
                          text,
                          records,
                        )
                        return {
                          id: record?.id ?? buildReviewerFindingId(text, index),
                          gateId: `${agentType}:${expectedSnapshotId}`,
                          // Prefixed blocker string for the same reason as the
                          // security path above: the condone key's verdict class
                          // is derived from this text.
                          text,
                          status: 'open' as const,
                          files: specialistPendingFiles,
                          snapshotFingerprint: expectedSnapshotId,
                          reviewer: agentType as SpecialistReviewerAgent,
                          createdAt: new Date().toISOString(),
                        }
                      },
                    )
                    // Merge instead of replace: another reviewer's still-open
                    // findings/blockers must not be clobbered by this one.
                    mergeReviewerFindings(
                      agentType,
                      specialistFindingRecords,
                      blockers,
                    )
                    // In-turn marker: this specialist owes a fresh
                    // re-attestation before finalization, and its credit is
                    // dropped immediately so the gate cannot reuse it.
                    addOwedReviewer(agentType)
                    activeWorkState.specialistReviewGatesDone = (
                      activeWorkState.specialistReviewGatesDone ?? []
                    ).filter((entry) => entry !== agentType)
                    if (activeWorkState.specialistReviewGateFingerprints) {
                      delete activeWorkState.specialistReviewGateFingerprints[
                        agentType
                      ]
                    }
                    const specialistRepairRound: number =
                      Number(activeWorkState.specialistRepairRoundCount ?? 0) +
                      1
                    activeWorkState.specialistRepairRoundCount =
                      specialistRepairRound
                    specialistBlocked = true
                    // Optional hard cap only when createBase2/env set a finite
                    // maxSpecialistRepairRounds; default is unlimited and exits
                    // via no-progress / incomplete-receipt / crash guards.
                    if (
                      Number.isFinite(MAX_SPECIALIST_REPAIR_ROUNDS) &&
                      specialistRepairRound > MAX_SPECIALIST_REPAIR_ROUNDS
                    ) {
                      activeWorkState.currentPhase = 'blocked'
                      activeWorkState.nextRequiredAction = `Specialist repair budget exhausted (${MAX_SPECIALIST_REPAIR_ROUNDS}/${MAX_SPECIALIST_REPAIR_ROUNDS}); the ${agentType} findings are still open. Stop retrying automatically and inspect the findings or handoff.`
                      activeWorkState.latestWorkSummary = `Specialist repair budget exhausted for pending files: ${Array.from(pendingGateFiles).join(', ') || '(unknown files)'}`
                      markActiveWorkStateChanged()
                      emitGateTelemetry({
                        currentPhase: 'blocked',
                        pendingFileCount: currentPendingGateFiles.length,
                        pendingFiles: currentPendingGateFiles,
                        reviewerStatus: 'failed',
                        validationStatus: 'passed',
                        blockerCount: blockers.length,
                        repairRound: specialistRepairRound,
                        skipReason: 'specialist-repair-budget-exhausted',
                      })
                      yield {
                        toolName: 'add_message',
                        input: {
                          role: 'user',
                          content: [
                            `Specialist gate: automated repair budget exhausted after ${MAX_SPECIALIST_REPAIR_ROUNDS} round(s); the following ${agentType} findings are still open and were not cleared:`,
                            '',
                            ...blockers,
                            '',
                            'Stop retrying automatically. Inspect the findings directly, fix them, or explicitly authorize a different path.',
                          ].join('\n'),
                        },
                        includeToolCall: false,
                      } as any
                      specialistRepairExit = true
                      break
                    }
                    activeWorkState.currentPhase = 'repair_loop'
                    activeWorkState.nextRequiredAction = `Repair-editor must address every open ${agentType} finding before validation and finalization.`
                    activeWorkState.latestWorkSummary = `${agentType} blocked the current change snapshot; repair is required.`
                    markActiveWorkStateChanged()
                    emitGateTelemetry({
                      currentPhase: 'repair_loop',
                      pendingFileCount: currentPendingGateFiles.length,
                      pendingFiles: currentPendingGateFiles,
                      reviewerStatus: 'failed',
                      validationStatus: 'passed',
                      blockerCount: blockers.length,
                      repairRound: specialistRepairRound,
                      reuseReason: `aux-gate:${agentType}-blocking`,
                    })
                    yield {
                      toolName: 'add_message',
                      input: {
                        role: 'user',
                        content: [
                          `${agentType} returned blocking findings. The harness will send these exact findings to repair-editor:`,
                          '',
                          ...blockers,
                          '',
                          `These findings remain open until targeted validation and a fresh matching ${agentType} review clear them.`,
                        ].join('\n'),
                      },
                      includeToolCall: false,
                    } as any
                    // Snapshot-progress guard baseline, captured BEFORE the
                    // repair spawn so a repair that changes nothing is caught.
                    const preRepairFingerprint = hashGateSnapshotDetails(
                      buildGateSnapshotDetails(
                        Array.from(pendingGateFiles),
                        '',
                      ),
                    )
                    // Recording the BASELINE (not just post-repair states) is
                    // what makes A→B→A trip: round 1 records A, post B is new;
                    // round 2 records B, post A is already in the set.
                    seenSpecialistRepairFingerprints.add(preRepairFingerprint)
                    const specialistOpenFindings = (
                      activeWorkState.openReviewerFindings ?? []
                    ).filter((finding) => finding.reviewer === agentType)
                    activeWorkState.repairSessionId =
                      activeWorkState.repairSessionId ??
                      `specialist-review-repair-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
                    const specialistRepairResult = yield {
                      toolName: 'spawn_agents',
                      input: {
                        agents: [
                          {
                            agent_type: 'repair-editor',
                            handoff: {
                              schemaVersion: 1,
                              taskId: activeWorkState.repairSessionId,
                              role: 'repair-editor',
                              objective: `Resolve every open ${agentType} finding without unrelated changes.`,
                              requirements: specialistOpenFindings.map(
                                ({ id, text }) => ({
                                  id,
                                  text,
                                  required: true,
                                }),
                              ),
                              acceptanceCriteria: specialistOpenFindings.map(
                                ({ id }) => ({
                                  id: `clear-${id}`,
                                  behavior: `${agentType} finding ${id} is addressed in the live workspace.`,
                                  verification: `Targeted validation passes and a fresh snapshot-bound ${agentType} review clears the finding.`,
                                }),
                              ),
                              context: [],
                              invariants: [
                                'Read every target from the live filesystem before editing.',
                                `Treat every finding ID as open until a fresh ${agentType} clears it.`,
                              ],
                              nonGoals: [
                                'Unrelated diagnostics, refactors, or cleanup.',
                              ],
                              risks: [
                                `${agentType} findings may be stale if the workspace snapshot changed.`,
                              ],
                              unknowns: [],
                              findings: specialistOpenFindings.map(
                                ({ id, text, files, snapshotFingerprint }) => ({
                                  id,
                                  text,
                                  files,
                                  snapshotFingerprint,
                                }),
                              ),
                              permissions: {
                                readablePaths: repairEditorReadablePaths(
                                  [
                                    ...pendingGateFiles,
                                    ...specialistOpenFindings.flatMap(
                                      (finding: { files?: string[] }) =>
                                        finding.files ?? [],
                                    ),
                                  ],
                                  specialistOpenFindings.map(
                                    (finding: { text?: string }) =>
                                      finding.text ?? '',
                                  ),
                                ),
                                writablePaths: Array.from(
                                  new Set([
                                    ...pendingGateFiles,
                                    ...specialistOpenFindings.flatMap(
                                      (finding: { files?: string[] }) =>
                                        finding.files ?? [],
                                    ),
                                  ]),
                                ),
                                allowedTools: [
                                  'read_files',
                                  'read_outline',
                                  'read_subtree',
                                  'edit_transaction',
                                ],
                              },
                              workspaceRevision:
                                mutableAgentState.workspaceState?.revision,
                              workspaceSnapshotId:
                                mutableAgentState.workspaceState?.snapshotId,
                              artifacts: [],
                              successCriteria: [
                                `All ${agentType} finding IDs are cleared by a fresh reviewer receipt.`,
                              ],
                              constraints: [
                                'Keep every edit within the pending gate file set.',
                              ],
                            },
                            prompt: [
                              `Repair the blocking ${agentType} findings below.`,
                              `Treat every finding ID as open until a fresh ${agentType} clears it.`,
                              'Read every target from the live filesystem before editing.',
                              '',
                              ...specialistOpenFindings.map(
                                (finding) => `${finding.id}: ${finding.text}`,
                              ),
                            ].join('\n'),
                          },
                        ],
                      },
                    } as any
                    const specialistRepairCrash = detectReviewerCrash(
                      (specialistRepairResult as any)?.toolResult ??
                        specialistRepairResult,
                    )
                    if (specialistRepairCrash) {
                      activeWorkState.currentPhase = 'blocked'
                      activeWorkState.nextRequiredAction = `Repair-editor failed while addressing ${agentType} findings. Inspect the failure before retrying.`
                      activeWorkState.latestWorkSummary = `Repair-editor failed: ${specialistRepairCrash}`
                      markActiveWorkStateChanged()
                      specialistRepairExit = true
                      break
                    }
                    const specialistRepairReceipt = extractAgentReceipt(
                      (specialistRepairResult as any)?.toolResult ??
                        specialistRepairResult,
                    )
                    const specialistOpenFindingIds = new Set(
                      specialistOpenFindings.map((finding) => finding.id),
                    )
                    const specialistRepairHasProgress =
                      !!specialistRepairReceipt &&
                      specialistRepairReceipt.changedFiles.some(
                        (file: { path: string }) =>
                          typeof file.path === 'string' &&
                          file.path.trim().length > 0,
                      )
                    if (
                      !specialistRepairReceipt ||
                      (!specialistRepairHasProgress &&
                        (specialistRepairReceipt.status !== 'completed' ||
                          [...specialistOpenFindingIds].some(
                            (id) =>
                              !specialistRepairReceipt.findingsAddressed.includes(
                                id,
                              ),
                          )))
                    ) {
                      activeWorkState.currentPhase = 'blocked'
                      activeWorkState.nextRequiredAction = `Repair-editor did not return a completed receipt addressing every open ${agentType} finding.`
                      activeWorkState.latestWorkSummary = `${agentType} repair receipt was incomplete or missing.`
                      markActiveWorkStateChanged()
                      specialistRepairExit = true
                      break
                    }
                    const specialistRepairStatus = yield {
                      toolName: 'git_status',
                      input: {},
                    } as any
                    const specialistRepairFiles = extractGitStatusFiles(
                      (specialistRepairStatus as any)?.toolResult,
                    ).filter((file: string) => pendingGateFiles.has(file))
                    if (specialistRepairFiles.length > 0) {
                      recordChangedFiles(specialistRepairFiles, {
                        fromRepair: true,
                      })
                    }
                    const postRepairFingerprint = hashGateSnapshotDetails(
                      buildGateSnapshotDetails(
                        Array.from(pendingGateFiles),
                        '',
                      ),
                    )
                    // No-progress detection for the specialist
                    // review -> repair -> re-review loop. A repair round that
                    // leaves the pending bytes byte-identical cannot clear the
                    // findings, so re-firing the specialist would repeat the
                    // same blocking verdict forever even while the repair
                    // budget still has rounds left. Fail closed: record the
                    // skip reason, retract finalization, and exit the gate loop
                    // instead of spawning another repair round.
                    if (postRepairFingerprint === preRepairFingerprint) {
                      if (!activeWorkState.lastReviewerGateSkipReason) {
                        activeWorkState.lastReviewerGateSkipReason =
                          'specialist-repair-no-progress'
                      }
                      activeWorkState.currentPhase = 'blocked'
                      activeWorkState.nextRequiredAction = `Repair-editor made no snapshot-visible progress on the ${agentType} findings. Stop retrying and inspect the finding or handoff.`
                      activeWorkState.latestWorkSummary = `${agentType} repair produced no workspace fingerprint change.`
                      mutableAgentState.canSuggestFollowups = false
                      finalResponseGateOpen = false
                      markActiveWorkStateChanged()
                      emitGateTelemetry({
                        currentPhase: 'blocked',
                        pendingFileCount: currentPendingGateFiles.length,
                        pendingFiles: currentPendingGateFiles,
                        reviewerStatus: 'failed',
                        validationStatus: 'passed',
                        repairRound: specialistRepairRound,
                        skipReason: 'specialist-repair-no-progress',
                      })
                      specialistRepairExit = true
                      break
                    }
                    // Turn-scoped CYCLE detection. The equality guard above
                    // already handled an UNCHANGED fingerprint, so reaching
                    // here means the bytes changed — but this exact workspace
                    // state was already visited earlier in this turn's repair
                    // loop, i.e. the repairs are oscillating (A→B→A). Re-firing
                    // the specialist could only repeat an earlier verdict, so
                    // fail closed on demonstrated non-progress instead of
                    // waiting for a guessed repair budget.
                    if (
                      seenSpecialistRepairFingerprints.has(
                        postRepairFingerprint,
                      )
                    ) {
                      if (!activeWorkState.lastReviewerGateSkipReason) {
                        activeWorkState.lastReviewerGateSkipReason =
                          'specialist-repair-cycle'
                      }
                      activeWorkState.currentPhase = 'blocked'
                      activeWorkState.nextRequiredAction = `The ${agentType} repair loop returned the workspace to a state it already visited this turn; retrying will not converge. Stop retrying and inspect the finding or handoff.`
                      activeWorkState.latestWorkSummary = `${agentType} repair loop revisited an earlier workspace fingerprint (repair cycle).`
                      mutableAgentState.canSuggestFollowups = false
                      finalResponseGateOpen = false
                      markActiveWorkStateChanged()
                      emitGateTelemetry({
                        currentPhase: 'blocked',
                        pendingFileCount: currentPendingGateFiles.length,
                        pendingFiles: currentPendingGateFiles,
                        reviewerStatus: 'failed',
                        validationStatus: 'passed',
                        repairRound: specialistRepairRound,
                        skipReason: 'specialist-repair-cycle',
                      })
                      specialistRepairExit = true
                      break
                    }
                    seenSpecialistRepairFingerprints.add(postRepairFingerprint)
                    // Leave agentType in the owed set: it must re-attest
                    // against the post-repair bytes before finalization.
                    activeWorkState.currentPhase = 'awaiting_validation'
                    activeWorkState.nextRequiredAction = ''
                    activeWorkState.latestWorkSummary = `Repair-editor addressed ${agentType} findings; targeted validation and a fresh ${agentType} review are required.`
                    markActiveWorkStateChanged()
                    break
                  }
                  if (crash) {
                    activeWorkState.currentPhase = 'blocked'
                    activeWorkState.openReviewerFindings = (
                      activeWorkState.openReviewerFindings ?? []
                    ).filter((finding) => finding.reviewer !== agentType)
                    // Transient provider/rate-limit crashes fail closed for this
                    // turn without repair-editor or bare-hex fingerprint thrash.
                    if (
                      isTransientReviewerCrash(crash) ||
                      classifyReviewerCrash(crash) === 'transient'
                    ) {
                      activeWorkState.lastReviewerGateSkipReason =
                        'specialist-rate-limited'
                      activeWorkState.openReviewerBlockers = [
                        `${agentType} hit a rate-limit or concurrency limit during specialist review: ${crash}`,
                        'End this turn and retry later. Do not spawn repair-editor. Do not recompute bare-hex fingerprints from get_change_review_bundle.',
                      ]
                      activeWorkState.nextRequiredAction =
                        'End turn / retry later after the provider rate-limit or concurrency limit clears. Do not spawn repair-editor or recompute bare-hex fingerprints.'
                      activeWorkState.latestWorkSummary = `${agentType} was rate-limited or concurrency-limited during specialist review.`
                      markActiveWorkStateChanged()
                      specialistBlocked = true
                      specialistTerminalFailure = true
                      break
                    }
                    const crashClass = classifyReviewerCrash(crash)
                    activeWorkState.openReviewerBlockers =
                      crashClass === 'protocol'
                        ? [
                            `${agentType} failed specialist review protocol/attestation: ${crash}`,
                            'This is a specialist reviewer protocol/configuration failure, not a source-code finding. Do not spawn repair-editor.',
                          ]
                        : [
                            `${agentType} crashed during specialist review: ${crash}`,
                          ]
                    activeWorkState.latestWorkSummary =
                      crashClass === 'protocol'
                        ? `${agentType} protocol/attestation failure during specialist review.`
                        : `${agentType} crashed during specialist review.`
                    markActiveWorkStateChanged()
                    specialistBlocked = true
                    specialistTerminalFailure = true
                    break
                  }
                  if (!verdict) {
                    // A missing verdict is NOT success. Retry the specialist a
                    // bounded number of times without crediting it (fail
                    // closed); once the budget is spent, credit it so the aux
                    // loop cannot spin forever and record reduced assurance.
                    const noVerdictCounts =
                      (activeWorkState.specialistNoVerdictCounts ??= {})
                    const noVerdictCount =
                      Number(noVerdictCounts[agentType] ?? 0) + 1
                    noVerdictCounts[agentType] = noVerdictCount
                    if (noVerdictCount <= MAX_SPECIALIST_NO_VERDICT_RETRIES) {
                      activeWorkState.validationAssurance = 'reduced'
                      activeWorkState.latestWorkSummary = `${agentType} returned no verdict; retrying it (attempt ${noVerdictCount}/${MAX_SPECIALIST_NO_VERDICT_RETRIES}) before crediting the gate.`
                      markActiveWorkStateChanged()
                      emitGateTelemetry({
                        currentPhase: 'awaiting_validation',
                        pendingFileCount: currentPendingGateFiles.length,
                        pendingFiles: currentPendingGateFiles,
                        reviewerStatus: 'failed',
                        validationStatus: 'passed',
                        skipReason: 'specialist-no-verdict-retry',
                      })
                      continue
                    }
                    activeWorkState.validationAssurance = 'reduced'
                    if (!activeWorkState.lastReviewerGateSkipReason) {
                      activeWorkState.lastReviewerGateSkipReason =
                        'specialist-no-verdict-budget-exhausted'
                    }
                    activeWorkState.latestWorkSummary = `${agentType} never returned a verdict after ${MAX_SPECIALIST_NO_VERDICT_RETRIES} retry/retries; the gate proceeded with reduced assurance.`
                  } else {
                    delete (activeWorkState.specialistNoVerdictCounts ??= {})[
                      agentType
                    ]
                    recordSuccessfulReviewReceipt(
                      specialistToolResult,
                      agentType,
                      expectedSnapshotId,
                    )
                    // Non-empty only: a passing specialist gate stays silent
                    // exactly as before when the receipt carries no advisories.
                    const specialistAdvisories = boundAdvisoryLines(
                      collectReviewerAdvisories(specialistToolResult),
                    )
                    if (specialistAdvisories.length > 0) {
                      yield {
                        toolName: 'add_message',
                        input: {
                          role: 'user',
                          content: [
                            'Advisories (non-blocking; no change required):',
                            ...specialistAdvisories.map(
                              (advisory) => `- ${advisory}`,
                            ),
                          ].join('\n'),
                        },
                        includeToolCall: false,
                      } as any
                    }
                  }
                  activeWorkState.specialistReviewGatesDone = Array.from(
                    new Set([
                      ...(activeWorkState.specialistReviewGatesDone ?? []),
                      agentType,
                    ]),
                  )
                  // Snapshot-bind the credit so a later byte change to the
                  // same paths (including a validation-hook rewrite) re-reviews.
                  ;(activeWorkState.specialistReviewGateFingerprints ??= {})[
                    agentType
                  ] = specialistCreditFingerprint
                  if (
                    activeWorkState.lastReviewerGateSkipReason ===
                      'specialist-terminal-failure' ||
                    activeWorkState.lastReviewerGateSkipReason ===
                      'specialist-rate-limited'
                  ) {
                    activeWorkState.lastReviewerGateSkipReason = ''
                  }
                  // The specialist aux block owns specialist-family
                  // revalidation; clear its owed entry once it passes. This
                  // never clobbers a code/security owed entry.
                  clearOwedReviewer(agentType)
                  markActiveWorkStateChanged()
                }
              }
              if (specialistBlocked) {
                // The repair loop's terminal paths (budget exhausted, missing
                // receipt, repair crash, no snapshot progress) intentionally
                // exit the OUTER while loop; everything else re-enters it.
                if (specialistRepairExit) break
                if (specialistTerminalFailure) {
                  // Preserve pending gate state so finalization cannot bypass.
                  // Rate-limit crashes keep a distinct skip reason and messaging;
                  // do not collapse them into specialist-terminal-failure.
                  const rateLimited =
                    activeWorkState.lastReviewerGateSkipReason ===
                    'specialist-rate-limited'
                  if (!activeWorkState.lastReviewerGateSkipReason) {
                    activeWorkState.lastReviewerGateSkipReason =
                      'specialist-terminal-failure'
                  }
                  activeWorkState.currentPhase = 'blocked'
                  if (!rateLimited) {
                    activeWorkState.nextRequiredAction =
                      'Obtain a fresh matching specialist review against a stable review bundle before finalization can continue.'
                    activeWorkState.latestWorkSummary =
                      'Specialist review protocol failed after one automatic refresh; finalization remains blocked.'
                  }
                  mutableAgentState.canSuggestFollowups = false
                  finalResponseGateOpen = false
                  markActiveWorkStateChanged()
                  yield {
                    toolName: 'add_message',
                    input: {
                      role: 'user',
                      content: rateLimited
                        ? [
                            'Specialist review gate hit a rate-limit or concurrency limit.',
                            '',
                            ...activeWorkState.openReviewerBlockers,
                            '',
                            'This is a transient provider limit, not a source-code finding. The harness did not spawn repair-editor or recompute bare-hex fingerprints. End turn and retry later.',
                          ].join('\n')
                        : [
                            'Specialist review gate failed snapshot/file attestation after one automatic refresh.',
                            '',
                            ...activeWorkState.openReviewerBlockers,
                            '',
                            'This is a specialist reviewer protocol/configuration failure, not a source-code finding. The harness did not spawn repair-editor or finalize. Stop retrying automatically; obtain a fresh matching specialist review against a stable review bundle.',
                          ].join('\n'),
                    },
                    includeToolCall: false,
                  } as any
                  break
                }
                continue
              }
            }
          }
        }
        // After any aux gate fired (or all three skipped/marked done), re-loop
        // so validation+reviewer (the FINAL gate) re-enters on a fresh read.
        // This blocks the orchestrator behind the aux spawns (each yield
        // blocked until the child completed) and lets the loop re-read pending
        // files before the final gate runs.
        if (auxGateFiredThisIteration) continue
        if (
          runValidationGate &&
          editsHappened &&
          currentPendingGateFiles.length === 0
        ) {
          activeWorkState.lastReviewerGateSkipReason =
            'edits-detected-without-pending-gate-files'
          activeWorkState.nextRequiredAction =
            'Unsafe reviewer gate state: edits were detected without pending gate files. Re-read the edited files/status, make a minimal follow-up edit if needed to restore pending gate files, then finish so validation/review can run safely.'
          activeWorkState.currentPhase = 'blocked'
          activeWorkState.latestWorkSummary =
            'Unsafe gate state: edits were detected without pending gate files.'
          markActiveWorkStateChanged()
          emitGateTelemetry({
            currentPhase: activeWorkState.currentPhase,
            pendingFileCount: 0,
            pendingFiles: [],
            skipReason: 'edits-detected-without-pending-gate-files',
            validationStatus: 'failed',
            reviewerStatus: 'failed',
          })
          yield {
            toolName: 'add_message',
            input: {
              role: 'user',
              content: [
                'Reviewer/validation gate cannot safely continue: edits were detected, but there are no pending gate files to validate or review.',
                '',
                'Skip/error reason: edits-detected-without-pending-gate-files.',
                'Do not finalize. Re-read the edited files/status, make a minimal follow-up edit if needed to restore pending gate files, then finish so validation/review can run safely.',
                formatGateStateBlock(
                  'validation/reviewer',
                  'failed',
                  'edits-detected-without-pending-gate-files: edits were detected, but there are no pending gate files to validate or review.',
                ),
              ].join('\n'),
            },
            includeToolCall: false,
          } as any
          continue
        }
        // Freeze both the live dirty scope and the cumulative validation scope
        // for this final gate attempt. A resumed pending file may already be
        // committed, but it still requires validation before finalization.
        const dirtyGateScopeFiles = deriveGateScopeFiles(gitStatusFiles)
        const gateScopeFiles = normalizeGateFileList([
          ...dirtyGateScopeFiles,
          ...currentPendingGateFiles,
        ])
        const conversationGatePass = getConversationGatePassForPendingFiles(
          currentPendingGateFiles,
          currentConversationMessages,
        )
        const conversationValidationSummary =
          activeWorkState.lastValidationSummary ||
          activeWorkState.gatePassedValidationSummary ||
          'No configured file-change hooks ran.'
        if (
          runValidationGate &&
          editsHappened &&
          conversationGatePass &&
          gateFileSetsEqual(gateScopeFiles, currentPendingGateFiles) &&
          collectUnreviewedDirtyReviewableFiles(latestDirtyFiles).length ===
            0 &&
          hasFreshGateFingerprintForPendingFiles(
            gateScopeFiles,
            conversationValidationSummary,
          )
        ) {
          const conversationReviewerVerdict =
            conversationGatePass.reviewerVerdict || 'LOOKS_GOOD'
          activeWorkState.openReviewerBlockers = []
          activeWorkState.pendingGateFiles = []
          activeWorkState.latestWorkSummary = ''
          activeWorkState.nextRequiredAction = ''
          activeWorkState.currentPhase = 'final_response_allowed'
          activeWorkState.lastReviewerGateSkipReason = ''
          activeWorkState.lastValidationSummary = conversationValidationSummary
          creditGatePassedFiles(gateScopeFiles)
          activeWorkState.gatePassedFiles = Array.from(gatePassedFiles)
          activeWorkState.gatePassedPendingFiles = currentPendingGateFiles
          activeWorkState.gatePassedReviewerVerdict =
            conversationReviewerVerdict
          activeWorkState.gatePassedValidationSummary =
            conversationValidationSummary
          activeWorkState.gatePassedFingerprint = buildGateFingerprint(
            currentPendingGateFiles,
            conversationValidationSummary,
          )
          pendingGateFiles.clear()
          editsHappened = false
          gatePassedForCurrentEdits = true
          finalResponseGateOpen = true
          mutableAgentState.canSuggestFollowups = true
          markActiveWorkStateChanged()
          emitGateTelemetry({
            currentPhase: 'final_response_allowed',
            pendingFileCount: currentPendingGateFiles.length,
            pendingFiles: currentPendingGateFiles,
            reviewerStatus: 'passed',
            validationStatus: 'passed',
            reuseReason: 'conversation-gate-state',
            reviewerVerdict: conversationReviewerVerdict,
          })
          yield {
            toolName: 'add_message',
            input: {
              role: 'user',
              content: [
                `Previous validation and reviewer gate already passed in this conversation with ${conversationReviewerVerdict} for pending files: ${currentPendingGateFiles.join(', ')}.`,
                `Reusing that unchanged gate result; ${buildGatePassFinalizationNotice()}`,
                formatGateStateBlock(
                  'validation/reviewer',
                  'passed',
                  `conversation gate-state reuse; reviewer verdict ${conversationReviewerVerdict}; pending files: ${currentPendingGateFiles.join(', ')}`,
                  undefined,
                  undefined,
                  activeWorkState.workflowTodoProgress,
                ),
              ].join('\n'),
            },
            includeToolCall: false,
          } as any
          continue
        }
        if (
          runValidationGate &&
          editsHappened &&
          gateFileSetsEqual(gateScopeFiles, currentPendingGateFiles) &&
          collectUnreviewedDirtyReviewableFiles(latestDirtyFiles).length ===
            0 &&
          hasDurableGatePassForPendingFiles(currentPendingGateFiles)
        ) {
          const durableReviewerVerdict =
            reviewerFinalizationVerdictFromDurablePass()
          const durableValidationSummary =
            activeWorkState.gatePassedValidationSummary ||
            activeWorkState.lastValidationSummary ||
            'No configured file-change hooks ran.'
          activeWorkState.openReviewerBlockers = []
          activeWorkState.pendingGateFiles = []
          activeWorkState.latestWorkSummary = ''
          activeWorkState.nextRequiredAction = ''
          activeWorkState.currentPhase = 'final_response_allowed'
          activeWorkState.lastReviewerGateSkipReason = ''
          activeWorkState.repairRoundCount = 0
          activeWorkState.repairSessionId = undefined
          activeWorkState.repairEscalationDone = undefined
          activeWorkState.lastValidationSummary = durableValidationSummary
          pendingGateFiles.clear()
          editsHappened = false
          gatePassedForCurrentEdits = true
          finalResponseGateOpen = true
          mutableAgentState.canSuggestFollowups = true
          markActiveWorkStateChanged()
          emitGateTelemetry({
            currentPhase: 'final_response_allowed',
            pendingFileCount: currentPendingGateFiles.length,
            pendingFiles: currentPendingGateFiles,
            reviewerStatus: 'passed',
            validationStatus: 'passed',
            reuseReason: 'durable-fingerprint-match',
            reviewerVerdict: durableReviewerVerdict,
            fingerprintPrefix:
              typeof activeWorkState.gatePassedFingerprint === 'string'
                ? activeWorkState.gatePassedFingerprint.slice(0, 16)
                : undefined,
          })
          yield {
            toolName: 'add_message',
            input: {
              role: 'user',
              content: [
                `Previous validation and reviewer gate already passed with ${durableReviewerVerdict} for pending files: ${currentPendingGateFiles.join(', ')}.`,
                buildGatePassFinalizationNotice(),
                formatGateStateBlock(
                  'validation/reviewer',
                  'passed',
                  `durable gate-pass reuse via fingerprint match; reviewer verdict ${durableReviewerVerdict}; pending files: ${currentPendingGateFiles.join(', ')}`,
                  undefined,
                  undefined,
                  activeWorkState.workflowTodoProgress,
                ),
              ].join('\n'),
            },
            includeToolCall: false,
          } as any
          continue
        }

        const reviewerProtocolBlocked =
          runReviewerGate &&
          editsHappened &&
          activeWorkState.lastReviewerGateSkipReason ===
            'reviewer-protocol-attestation-failed' &&
          (activeWorkState.reviewerProtocolRetryCount ?? 0) >= 1
        const reviewerProtocolBypassAuthorized =
          reviewerProtocolBlocked &&
          hasReviewerBypassAuthorization(
            currentConversationMessages,
            activeWorkState.reviewerBypassChallenge,
            reviewChallengeFingerprint(currentPendingGateFiles),
          )
        if (reviewerProtocolBlocked && !reviewerProtocolBypassAuthorized) {
          const challenge = ensureReviewerBypassChallenge(
            reviewChallengeFingerprint(currentPendingGateFiles),
            currentConversationMessages,
          )
          activeWorkState.currentPhase = 'blocked'
          activeWorkState.openReviewerBlockers = [
            'BLOCKING: Reviewer protocol attestation failed twice; a fresh matching structured review is required.',
          ]
          activeWorkState.nextRequiredAction = `Obtain a fresh matching structured review, or explicitly reply "BYPASS REVIEWER ${challenge.id}"; the harness will not retry automatically.`
          activeWorkState.latestWorkSummary =
            'Reviewer protocol attestation failed after the bounded retry; finalization remains blocked.'
          mutableAgentState.canSuggestFollowups = false
          finalResponseGateOpen = false
          markActiveWorkStateChanged()
          yield {
            toolName: 'add_message',
            input: {
              role: 'user',
              content: [
                'Reviewer protocol remains blocked after the bounded retry.',
                'No source repair or additional reviewer retry will run automatically.',
                `Fix reviewer configuration, or explicitly reply "BYPASS REVIEWER ${challenge.id}" to finalize using the recorded validation evidence for this snapshot only.`,
              ].join('\n'),
            },
            includeToolCall: false,
          } as any
          break
        }

        // Validation runs before the final reviewer because hooks may mutate
        // generated or formatted output. The exact source and test snapshot is
        // re-captured at the reviewer spawn boundary below.
        // The final block only ever spawns code-reviewer. A security/specialist
        // marker is owned by that family's aux block, which continues the loop
        // before reaching here, so a non-code marker must not select a
        // non-code reviewer (which the final block can only pass a prompt to).
        const requiredReviewerAgentType =
          revalidationFamily(activeWorkState.requiredReviewerRevalidation) ===
          'code'
            ? 'code-reviewer'
            : reviewerAgentType
        let reviewableGateScopeFiles = selectReviewableGateFiles(gateScopeFiles)
        let reviewSnapshotDetails = buildGateSnapshotDetails(
          reviewableGateScopeFiles,
          '',
        )
        let reviewSnapshotFingerprint = hashGateSnapshotDetails(
          reviewSnapshotDetails,
        )
        // Deleted pending files (a `missing` content marker in the files-v4
        // snapshot details) are attested-by-absence: the reviewer cannot read
        // them, so they are not required in reviewedFiles.
        let reviewDeletedFiles = collectDeletedFilesFromSnapshotDetails(
          reviewSnapshotDetails,
        )
        let reviewableFingerprint = reviewSnapshotFingerprint
        let frozenDirtyGateScopeFingerprint = buildGateFingerprint(
          dirtyGateScopeFiles,
          '',
        )
        let validationSummary =
          'No file changes were detected, so no validation hooks ran.'
        const validationInfrastructureBypassed =
          activeWorkState.validationInfrastructureBypassFingerprint ===
          reviewSnapshotFingerprint
        if (
          editsHappened &&
          runValidationGate &&
          !validationInfrastructureBypassed
        ) {
          setGateProgress(
            `gate: validation hooks running for ${gateScopeFiles.length} file(s)`,
          )
          const verify = yield {
            toolName: 'run_file_change_hooks',
            input: { files: gateScopeFiles },
          } as any
          let failures = collectHookFailures(
            (verify as any) && (verify as any).toolResult,
          )
          if (failures.length === 0) {
            validationSummary = summarizeHookResults(
              (verify as any) && (verify as any).toolResult,
            )
            activeWorkState.lastValidationSummary = validationSummary
            activeWorkState.validationAssurance = validationSummary.startsWith(
              'REDUCED_ASSURANCE:',
            )
              ? 'reduced'
              : 'full'
            activeWorkState.validationEvidence = [
              {
                gateId: reviewSnapshotFingerprint,
                files: gateScopeFiles,
                snapshotFingerprint: buildGateFingerprint(
                  gateScopeFiles,
                  validationSummary,
                ),
                summary: validationSummary,
                assurance: activeWorkState.validationAssurance,
                recordedAt: new Date().toISOString(),
              },
            ]
            activeWorkState.currentPhase = 'awaiting_review'
            markActiveWorkStateChanged()
          } else {
            const repairRound = activeWorkState.repairRoundCount ?? 0
            const parsed = parseValidationFailures(failures)
            const hasParseableFailures = parsed.some((p) => p.file.length > 0)
            const hasInfrastructureFailures = failures.every((failure) =>
              /(?:command denied|permission denied|not found|enoent|could not find|failed to spawn|spawn .* failed|timed out|timeout|missing executable|is not recognized as an internal or external command)/i.test(
                failure,
              ),
            )
            // Default unlimited: repair whenever failures are parseable.
            // Optional finite MAX_REPAIR_ROUNDS (createBase2/env) still caps.
            // Incomplete receipts / remaining failures / infrastructure path
            // remain fail-closed as before (no budget-only escalation).
            const canRepair =
              hasParseableFailures &&
              (!Number.isFinite(MAX_REPAIR_ROUNDS) ||
                repairRound < MAX_REPAIR_ROUNDS)
            if (canRepair) {
              if (!activeWorkState.repairSessionId) {
                activeWorkState.repairSessionId = `repair-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
              }
              activeWorkState.currentPhase = 'repair_loop'
              activeWorkState.repairRoundCount = repairRound + 1
              const repairRoundLabel = Number.isFinite(MAX_REPAIR_ROUNDS)
                ? `${repairRound + 1}/${MAX_REPAIR_ROUNDS}`
                : `${repairRound + 1}`
              activeWorkState.latestWorkSummary = `Repair round ${repairRoundLabel}: parsing ${failures.length} validation failure(s) and spawning targeted editor fix.`
              activeWorkState.nextRequiredAction = ''
              markActiveWorkStateChanged()
              emitGateTelemetry({
                currentPhase: 'repair_loop',
                pendingFileCount: pendingGateFiles.size,
                pendingFiles: Array.from(pendingGateFiles),
                validationStatus: 'failed',
                repairRound: repairRound + 1,
                blockerCount: failures.length,
              })
              let debuggerContext = ''
              if (repairRound >= 1) {
                const diagnosis = yield {
                  toolName: 'spawn_agents',
                  input: {
                    agents: [
                      {
                        agent_type: 'debugger',
                        prompt: [
                          'Diagnose these repeated validation failures before another repair attempt.',
                          `Pending files: ${Array.from(pendingGateFiles).join(', ')}`,
                          ...failures,
                        ].join('\n'),
                        params: {
                          suspect_files: Array.from(pendingGateFiles),
                        },
                      },
                    ],
                  },
                } as any
                try {
                  debuggerContext = JSON.stringify(
                    (diagnosis as any)?.toolResult ?? [],
                  ).slice(0, 6_000)
                } catch {
                  debuggerContext = 'Debugger output was not serializable.'
                }
              }
              const repair = yield {
                toolName: 'spawn_agents',
                input: {
                  agents: [
                    {
                      agent_type: 'repair-editor',
                      handoff: {
                        schemaVersion: 1,
                        taskId:
                          activeWorkState.repairSessionId ??
                          'validation-repair',
                        role: 'repair-editor',
                        objective:
                          'Resolve the current validation failures without unrelated changes.',
                        requirements: failures.map(
                          (text: string, index: number) => ({
                            id: `VF-${index + 1}`,
                            text,
                            required: true,
                          }),
                        ),
                        acceptanceCriteria: [
                          {
                            id: 'validation-passes',
                            behavior:
                              'Every supplied validation failure is repaired without unrelated changes.',
                            verification:
                              'The parent reruns the targeted validation gate on the resulting workspace snapshot.',
                          },
                        ],
                        context: [],
                        invariants: [
                          'Read each live target before editing.',
                          'Do not modify files outside the pending gate file set.',
                        ],
                        nonGoals: ['Unrelated refactors or cleanup.'],
                        risks: [
                          'Stale validation diagnostics or overlapping user edits.',
                        ],
                        unknowns: [],
                        findings: failures.map(
                          (text: string, index: number) => ({
                            id: `VF-${index + 1}`,
                            text,
                            files: Array.from(pendingGateFiles),
                            snapshotFingerprint: buildGateFingerprint(
                              Array.from(pendingGateFiles),
                              validationSummary,
                            ),
                          }),
                        ),
                        permissions: {
                          readablePaths: repairEditorReadablePaths(
                            [
                              ...pendingGateFiles,
                              ...parsed.map((p: { file: string }) => p.file),
                            ],
                            failures,
                          ),
                          writablePaths: Array.from(
                            new Set([
                              ...pendingGateFiles,
                              ...parsed.map((p: { file: string }) => p.file),
                            ]),
                          ),
                          allowedTools: [
                            'read_files',
                            'read_outline',
                            'read_subtree',
                            'edit_transaction',
                          ],
                        },
                        workspaceRevision:
                          mutableAgentState.workspaceState?.revision,
                        workspaceSnapshotId:
                          mutableAgentState.workspaceState?.snapshotId,
                        artifacts: [],
                        successCriteria: ['Targeted validation passes.'],
                        constraints: [
                          'Keep every change causally tied to a supplied failure.',
                        ],
                      },
                      prompt:
                        buildRepairEditorPrompt(
                          parsed,
                          Array.from(pendingGateFiles),
                        ) +
                        (debuggerContext
                          ? `\n\nDebugger diagnosis from the prior repeated failure:\n${debuggerContext}`
                          : ''),
                    },
                  ],
                },
              } as any
              const validationFindingIds = failures.map(
                (_text: string, index: number) => `VF-${index + 1}`,
              )
              const validationRepairReceipt = extractAgentReceipt(
                (repair as any)?.toolResult ?? repair,
              )
              const validationRepairHasProgress =
                !!validationRepairReceipt &&
                validationRepairReceipt.changedFiles.some(
                  (file: { path: string }) =>
                    typeof file.path === 'string' &&
                    file.path.trim().length > 0,
                )
              if (
                !validationRepairReceipt ||
                (!validationRepairHasProgress &&
                  (validationRepairReceipt.status !== 'completed' ||
                    validationFindingIds.some(
                      (id: string) =>
                        !validationRepairReceipt.findingsAddressed.includes(id),
                    )))
              ) {
                activeWorkState.currentPhase = 'blocked'
                activeWorkState.nextRequiredAction =
                  'Repair-editor did not return a completed receipt addressing every validation failure.'
                activeWorkState.latestWorkSummary =
                  'Validation repair receipt was incomplete or missing.'
                markActiveWorkStateChanged()
                break
              }
              const repairGitStatus = yield {
                toolName: 'git_status',
                input: {},
              } as any
              const repairChangedFiles = extractGitStatusFiles(
                (repairGitStatus as any)?.toolResult,
              ).filter(
                (file: string) =>
                  !initialGitStatusFiles.includes(file) &&
                  !gatePassedFiles.has(file),
              )
              if (repairChangedFiles.length > 0) {
                recordChangedFiles(repairChangedFiles, { fromRepair: true })
                activeWorkState.latestWorkSummary = `Repair editor (round ${repairRoundLabel}) fixed: ${repairChangedFiles.join(', ')}`
                markActiveWorkStateChanged()
              }
              const reVerify = yield {
                toolName: 'run_file_change_hooks',
                input: { files: Array.from(pendingGateFiles) },
              } as any
              const reFailures = collectHookFailures(
                (reVerify as any) && (reVerify as any).toolResult,
              )
              if (reFailures.length === 0) {
                validationSummary = summarizeHookResults(
                  (reVerify as any) && (reVerify as any).toolResult,
                )
                activeWorkState.lastValidationSummary = validationSummary
                activeWorkState.currentPhase = 'awaiting_review'
                activeWorkState.nextRequiredAction = ''
                markActiveWorkStateChanged()
                emitGateTelemetry({
                  currentPhase: 'awaiting_review',
                  pendingFileCount: pendingGateFiles.size,
                  pendingFiles: Array.from(pendingGateFiles),
                  validationStatus: 'passed',
                  repairRound: repairRound + 1,
                  reuseReason: 'repair-succeeded',
                })
                continue
              } else {
                activeWorkState.nextRequiredAction =
                  'Fix the remaining validation hook failures before doing anything else.'
                activeWorkState.lastReviewerGateSkipReason =
                  'validation-hook-failures'
                activeWorkState.currentPhase = 'blocked'
                activeWorkState.latestWorkSummary = `Repair editor (round ${repairRoundLabel}) ran but ${reFailures.length} failure(s) remain.`
                markActiveWorkStateChanged()
                emitGateTelemetry({
                  currentPhase: 'blocked',
                  pendingFileCount: pendingGateFiles.size,
                  pendingFiles: Array.from(pendingGateFiles),
                  validationStatus: 'failed',
                  repairRound: repairRound + 1,
                  blockerCount: reFailures.length,
                  skipReason: 'repair-incomplete',
                })
                yield {
                  toolName: 'add_message',
                  input: {
                    role: 'user',
                    content: [
                      `Automated repair editor ran (round ${repairRoundLabel}) but ${reFailures.length} validation failure(s) remain. Fix these before ending your turn:`,
                      '',
                      ...reFailures,
                      '',
                      'Read the exact failing locations, make minimal targeted fixes, then finish (the hooks will re-run).',
                      formatGateStateBlock(
                        'validation',
                        'failed',
                        `repair-incomplete: round ${repairRoundLabel}; ${reFailures.length} failure(s) remain for pending files: ${Array.from(pendingGateFiles).join(', ') || '(unknown files)'}`,
                        repairRound + 1,
                      ),
                    ].join('\n'),
                  },
                  includeToolCall: false,
                } as any
                continue
              }
            } else {
              // Unparseable failures, infrastructure failures, or optional
              // hard cap exhausted. Prefer reduced-assurance for pure
              // infrastructure; otherwise block. No budget-only escalation.
              if (!hasParseableFailures && hasInfrastructureFailures) {
                validationSummary = `REDUCED_ASSURANCE: Validation infrastructure could not produce source diagnostics: ${failures.join(' | ')}`
                activeWorkState.validationInfrastructureBypassFingerprint =
                  reviewSnapshotFingerprint
                activeWorkState.lastValidationSummary = validationSummary
                activeWorkState.validationAssurance = 'reduced'
                activeWorkState.currentPhase = 'awaiting_review'
                activeWorkState.nextRequiredAction = ''
                markActiveWorkStateChanged()
                emitGateTelemetry({
                  currentPhase: 'awaiting_review',
                  pendingFileCount: pendingGateFiles.size,
                  pendingFiles: Array.from(pendingGateFiles),
                  validationStatus: 'skipped',
                  skipReason: 'validation-infrastructure-failure',
                  blockerCount: failures.length,
                  repairRound,
                })
                continue
              }
              activeWorkState.nextRequiredAction =
                'Fix the blocking validation hook failures before doing anything else.'
              activeWorkState.lastReviewerGateSkipReason =
                'validation-hook-failures'
              activeWorkState.currentPhase = 'blocked'
              activeWorkState.latestWorkSummary = `Validation failed for pending files: ${Array.from(pendingGateFiles).join(', ') || '(unknown files)'}`
              markActiveWorkStateChanged()
              emitGateTelemetry({
                currentPhase: 'blocked',
                pendingFileCount: pendingGateFiles.size,
                pendingFiles: Array.from(pendingGateFiles),
                validationStatus: 'failed',
                skipReason: hasParseableFailures
                  ? 'repair-budget-exhausted'
                  : 'unparseable-failures',
                blockerCount: failures.length,
                repairRound,
              })
              yield {
                toolName: 'add_message',
                input: {
                  role: 'user',
                  content: [
                    'Verification gate: configured file-change hooks failed. These are blocking — fix them before ending your turn:',
                    '',
                    ...failures,
                    '',
                    'Read the exact failing locations, make minimal targeted fixes, then finish (the hooks will re-run).',
                    formatGateStateBlock(
                      'validation',
                      'failed',
                      `validation-hook-failures: ${failures.length} hook failure(s) for pending files: ${Array.from(pendingGateFiles).join(', ') || '(unknown files)'}`,
                      Number.isFinite(MAX_REPAIR_ROUNDS)
                        ? MAX_REPAIR_ROUNDS
                        : repairRound,
                    ),
                  ].join('\n'),
                },
                includeToolCall: false,
              } as any
              continue
            }
          }
        } else if (validationInfrastructureBypassed) {
          validationSummary =
            activeWorkState.lastValidationSummary ||
            'REDUCED_ASSURANCE: Validation infrastructure was unavailable for this snapshot.'
          activeWorkState.validationAssurance = 'reduced'
          activeWorkState.currentPhase = 'awaiting_review'
        }

        let postValidationScopeFiles = gateScopeFiles
        if (runValidationGate && editsHappened && gateScopeFiles.length > 0) {
          // Hooks may mutate files or dirty-scope membership. Recompute both
          // immediately before review and reopen the attempt on any membership
          // change; the reviewer snapshot then freezes the post-hook bytes.
          const postValidationGitStatus = yield {
            toolName: 'git_status',
            input: {},
          } as any
          postValidationScopeFiles = deriveGateScopeFiles(
            extractGitStatusFiles((postValidationGitStatus as any)?.toolResult),
          )
          if (
            !gateFileSetsEqual(dirtyGateScopeFiles, postValidationScopeFiles)
          ) {
            activeWorkState.currentPhase = 'awaiting_validation'
            activeWorkState.latestWorkSummary =
              'The task-related dirty scope changed during validation; validation and review were reopened.'
            activeWorkState.nextRequiredAction =
              'Re-run validation and review against the current dirty scope.'
            markActiveWorkStateChanged()
            continue
          }
          reviewableGateScopeFiles = selectReviewableGateFiles(gateScopeFiles)
          reviewSnapshotDetails = buildGateSnapshotDetails(
            reviewableGateScopeFiles,
            '',
          )
          reviewSnapshotFingerprint = hashGateSnapshotDetails(
            reviewSnapshotDetails,
          )
          reviewDeletedFiles = collectDeletedFilesFromSnapshotDetails(
            reviewSnapshotDetails,
          )
          reviewableFingerprint = reviewSnapshotFingerprint
          frozenDirtyGateScopeFingerprint = buildGateFingerprint(
            postValidationScopeFiles,
            '',
          )
        }

        let reviewerFinalizationVerdict: 'LOOKS_GOOD' | '' =
          reviewerProtocolBypassAuthorized ? 'LOOKS_GOOD' : ''
        if (reviewerProtocolBypassAuthorized) {
          activeWorkState.reviewerGateBypassReason =
            'User authorized bypass after repeated reviewer protocol attestation failures.'
          activeWorkState.reviewerGateBypassRecord = {
            reason: activeWorkState.reviewerGateBypassReason,
            authorizedAt: new Date().toISOString(),
            pendingFiles: Array.from(pendingGateFiles),
            fingerprint: reviewSnapshotFingerprint,
            validationSummary,
          }
          if (activeWorkState.reviewerBypassChallenge) {
            activeWorkState.reviewerBypassChallenge.consumed = true
          }
          activeWorkState.currentPhase = 'awaiting_review'
          activeWorkState.nextRequiredAction = ''
          activeWorkState.lastReviewerGateSkipReason =
            'user-authorized-reviewer-protocol-bypass'
          markActiveWorkStateChanged()
        }
        // The final reviewer may be skipped for bookkeeping-only changes or
        // when durable evidence attests the exact reviewable snapshot. A clean
        // working tree is not review evidence: committed bytes still require a
        // snapshot-bound review unless a matching receipt survived the prior
        // pass.
        // Content evidence is the GATE-COMPUTED receipt id. `gateId` is
        // `${reviewer}:${expectedFingerprint}`, and `expectedFingerprint` is
        // the fingerprint base2 itself hashed for that review, so an equal
        // gateId means the receipt was recorded against these exact bytes.
        const expectedReceiptGateId = `${requiredReviewerAgentType}:${reviewableFingerprint}`
        const matchingReviewReceipt = activeWorkState.reviewReceipts.some(
          (receipt) =>
            receipt.reviewer === requiredReviewerAgentType &&
            receipt.verdict === 'LOOKS_GOOD' &&
            receipt.gateId === expectedReceiptGateId &&
            receipt.reviewedFileCount === reviewableGateScopeFiles.length &&
            gateFileSetsEqual(receipt.reviewedFiles, reviewableGateScopeFiles),
        )
        // Provenance matters here. The receipt ALSO carries a reviewer-reported
        // `snapshotFingerprint`, which is drift-tolerated by
        // `collectReviewerAttestationIssues` (a coverage-complete review that
        // reports any well-formed `v3:` fingerprint is credited even when it
        // does not equal the id base2 computed). That field is therefore NOT
        // content evidence and is deliberately not read above. The gate-computed
        // `gateId` is: `recordSuccessfulReviewReceipt` builds it from base2's own
        // `expectedFingerprint`, which is
        // `hashGateSnapshotDetails(buildGateSnapshotDetails(reviewableGateScopeFiles, ''))`
        // and folds in every file's working-tree content marker. So an equal
        // gateId over an equal file set is the writer-guaranteed proof that these
        // exact bytes were already reviewed LOOKS_GOOD by this reviewer family.
        // `reviewedReviewableFingerprint` used to be a second required
        // conjunct, but it is ONE scalar overwritten on every gate pass while
        // `reviewReceipts` is a durable bounded ledger: after wave 1 reviewed
        // {A,B} and wave 2 reviewed {C}, the scalar held only fingerprint({C}),
        // so a later cycle re-arming on the unchanged {A,B} set re-spawned the
        // reviewer even though a matching LOOKS_GOOD receipt for those exact
        // bytes was still on file. The scalar added no safety (the gateId match
        // is strictly more specific — same family, same file set, same
        // gate-computed bytes), only false misses. It is now WRITE-ONLY state
        // kept for serialized-state compatibility with older sessions and
        // scheduled for removal; see its docblock in agents/base2/gate-state.ts
        // for the reader inventory and removal path.
        //
        // The attestability check is what keeps this fail-closed, and it is why
        // widening the rule is safe: a non-attestable marker such as
        // `unreadable:no-crypto` is a STABLE error string, not content
        // evidence, so two unrelated snapshots compare equal under it and a
        // stale receipt could otherwise buy a skip. Ordering mirrors
        // `hasFreshGateFingerprintForPendingFiles`: bail on an empty set, then
        // bail on a non-attestable fingerprint, then consult the recorded
        // evidence.
        const reviewableSetAlreadyReviewed =
          reviewableGateScopeFiles.length > 0 &&
          isAttestableSnapshotFingerprint(reviewableFingerprint) &&
          matchingReviewReceipt
        const skipReviewerForReviewableScope =
          runReviewerGate &&
          editsHappened &&
          !reviewerProtocolBypassAuthorized &&
          activeWorkState.lastReviewerGateSkipReason !==
            'reviewer-protocol-attestation-failed' &&
          (reviewableGateScopeFiles.length === 0 ||
            reviewableSetAlreadyReviewed)
        if (skipReviewerForReviewableScope) {
          reviewerFinalizationVerdict = 'LOOKS_GOOD'
          activeWorkState.currentPhase = 'awaiting_review'
          activeWorkState.nextRequiredAction = ''
          const reviewerSkipReason =
            reviewableGateScopeFiles.length === 0
              ? 'reviewer skip: no reviewable source files'
              : 'reviewer skip: reviewable source set unchanged since last review'
          markActiveWorkStateChanged()
          emitGateTelemetry({
            currentPhase: 'awaiting_review',
            pendingFileCount: pendingGateFiles.size,
            pendingFiles: Array.from(pendingGateFiles),
            reviewerStatus: 'skipped',
            validationStatus: 'passed',
            reviewerVerdict: reviewerFinalizationVerdict,
            skipReason:
              reviewableGateScopeFiles.length === 0
                ? 'reviewer-skip-no-reviewable-source-files'
                : 'reviewer-skip-reviewable-set-unchanged',
          })
          yield {
            toolName: 'add_message',
            input: {
              role: 'user',
              content: [
                `Reviewer gate skipped (${reviewerSkipReason}); treating the gate as passed.`,
                formatGateStateBlock(
                  'reviewer',
                  'skipped',
                  reviewableGateScopeFiles.length === 0
                    ? `reviewer-skip-no-reviewable-source-files: pending files: ${Array.from(pendingGateFiles).join(', ') || '(unknown files)'}`
                    : `reviewer-skip-reviewable-set-unchanged: reviewable files: ${reviewableGateScopeFiles.join(', ') || '(none)'}`,
                ),
              ].join('\n'),
            },
            includeToolCall: false,
          } as any
        }
        if (
          runReviewerGate &&
          editsHappened &&
          !reviewerProtocolBypassAuthorized &&
          !skipReviewerForReviewableScope &&
          activeWorkState.lastReviewerGateSkipReason !==
            'reviewer-protocol-attestation-failed'
        ) {
          activeWorkState.lastReviewerGateSkipReason = ''
          markActiveWorkStateChanged()
          setGateProgress(
            `gate: validation passed; reviewer ${requiredReviewerAgentType} running`,
          )
          const review = yield {
            toolName: 'spawn_agents',
            input: {
              agents: [
                {
                  agent_type: requiredReviewerAgentType,
                  prompt: [
                    `Review the completed changes as the ${requiredReviewerAgentType} before finalization.`,
                    '',
                    `Gate-scope changed files: ${reviewableGateScopeFiles.join(', ') || '(unknown)'}`,
                    `Snapshot fingerprint (echo exactly): ${reviewSnapshotFingerprint}`,
                    'Snapshot details (read for file membership; do not echo):',
                    reviewSnapshotDetails,
                    `Validation gate summary: ${validationSummary}`,
                    // Re-review ledger; empty on round 0 so no stray heading or
                    // blank line appears in the first review's prompt.
                    ...buildReviewerRoundLedgerLines(requiredReviewerAgentType),
                    'Read large files via read_files windows (bounded block reads) instead of whole-file reads so your accumulated read context stays bounded; still attest to every pending file in reviewedFiles.',
                    '',
                    'Return the required structured review object. Echo snapshotFingerprint exactly, list every pending changed file in reviewedFiles (including tests), evaluate all review dimensions, and map every user requirement to evidence. Changed tests are first-class review targets and may also be cited as coverage evidence. Use coverage: missing only when no covering test exists in the changed files or elsewhere in the repo.',
                  ].join('\n'),
                },
              ],
            },
          } as any
          let reviewerToolResult: unknown =
            (review as any) && (review as any).toolResult
          const reviewerCrashedBeforeAttestation =
            detectReviewerCrash(reviewerToolResult)
          let attestationIssues = reviewerCrashedBeforeAttestation
            ? []
            : collectReviewerAttestationIssues(
                reviewerToolResult,
                reviewSnapshotFingerprint,
                reviewableGateScopeFiles,
                reviewDeletedFiles,
              )
          if (
            attestationIssues.length > 0 &&
            (activeWorkState.reviewerProtocolRetryCount ?? 0) < 1
          ) {
            activeWorkState.reviewerProtocolRetryCount = 1
            activeWorkState.currentPhase = 'awaiting_review'
            activeWorkState.nextRequiredAction =
              'Retry the reviewer once with corrected snapshot/file attestation; do not edit source files for a reviewer protocol error.'
            activeWorkState.latestWorkSummary =
              'Reviewer protocol attestation failed; running one bounded reviewer-only retry.'
            markActiveWorkStateChanged()
            const retryReview = yield {
              toolName: 'spawn_agents',
              input: {
                agents: [
                  {
                    agent_type: requiredReviewerAgentType,
                    prompt: [
                      `Retry the completed ${requiredReviewerAgentType} review because the prior response failed the reviewer protocol contract.`,
                      '',
                      `Gate-scope changed files: ${reviewableGateScopeFiles.join(', ') || '(unknown)'}`,
                      `Snapshot fingerprint (echo exactly): ${reviewSnapshotFingerprint}`,
                      'Snapshot details (read for file membership; do not echo):',
                      reviewSnapshotDetails,
                      `Validation gate summary: ${validationSummary}`,
                      '',
                      'Protocol errors from the prior response:',
                      ...attestationIssues,
                      '',
                      'Return a fresh structured review object. Correct snapshotFingerprint and reviewedFiles directly; do not ask repair-editor to change source code for these protocol errors.',
                    ].join('\n'),
                  },
                ],
              },
            } as any
            reviewerToolResult =
              (retryReview as any) && (retryReview as any).toolResult
            attestationIssues = collectReviewerAttestationIssues(
              reviewerToolResult,
              reviewSnapshotFingerprint,
              reviewableGateScopeFiles,
              reviewDeletedFiles,
            )
          }
          if (attestationIssues.length > 0) {
            activeWorkState.openReviewerBlockers = [
              `BLOCKING: ${reviewerAgentType} failed snapshot/file attestation twice.`,
              ...attestationIssues,
            ]
            activeWorkState.openReviewerFindings = []
            activeWorkState.latestWorkSummary =
              'Reviewer protocol failed after one automatic retry; finalization remains blocked.'
            activeWorkState.lastReviewerGateSkipReason =
              'reviewer-protocol-attestation-failed'
            activeWorkState.currentPhase = 'blocked'
            activeWorkState.nextRequiredAction =
              'Obtain a fresh matching structured review before finalization can continue.'
            mutableAgentState.canSuggestFollowups = false
            finalResponseGateOpen = false
            markActiveWorkStateChanged()
            yield {
              toolName: 'add_message',
              input: {
                role: 'user',
                content: [
                  `Reviewer gate: ${reviewerAgentType} failed snapshot/file attestation twice.`,
                  '',
                  ...attestationIssues,
                  '',
                  'This is a reviewer protocol/configuration failure, not a source-code finding. The harness did not spawn repair-editor or finalize. Stop retrying automatically; obtain a fresh matching structured review or explicitly authorize the reviewer-protocol bypass.',
                ].join('\n'),
              },
              includeToolCall: false,
            } as any
            break
          }
          activeWorkState.reviewerProtocolRetryCount = 0
          // Attestation tolerates a coverage-complete review whose well-formed
          // v3 fingerprint drifted from the expected snapshot; record that drift
          // instead of accepting it silently, so a review of possibly-stale file
          // content that passed the gate stays auditable.
          const reviewerFingerprintDrift = collectReviewerFingerprintDrift(
            reviewerToolResult,
            reviewSnapshotFingerprint,
          )
          if (reviewerFingerprintDrift) {
            emitGateTelemetry({
              currentPhase: activeWorkState.currentPhase,
              pendingFileCount: reviewableGateScopeFiles.length,
              pendingFiles: reviewableGateScopeFiles,
              reviewerStatus: 'attestation-fingerprint-drift',
              reviewer: requiredReviewerAgentType,
              reportedFingerprint: reviewerFingerprintDrift,
              expectedFingerprint: reviewSnapshotFingerprint,
            })
          }
          // Parent-owned process RF strings are not repair targets; filter at
          // the consumer so raw collectReviewerBlockers can still surface them.
          // ONE structured walk of the tool-result tree classifies BOTH blocker
          // lists (the per-blocker helper re-walks it on every call): every
          // hard-rule string is byte-identical to an entry in
          // rawCollectedBlockers (asserted by the gate-reviewer parity test), so
          // classifying rawCollectedBlockers alone covers rawHardBlockers too.
          // Passing the toolResult keeps evidence-only parent ownership in step
          // with finalization.
          const rawCollectedBlockers =
            collectReviewerBlockers(reviewerToolResult)
          const rawHardBlockers =
            collectReviewerHardBlockers(reviewerToolResult)
          const parentOwnedRequirementBlockers =
            collectParentOwnedRequirementBlockers(
              rawCollectedBlockers,
              reviewerToolResult,
            )
          const collectedBlockers = rawCollectedBlockers.filter(
            (blocker: string) => !parentOwnedRequirementBlockers.has(blocker),
          )
          // Stale-finding suppression: filter out any blocker whose text
          // matches a previously-condoned finding text (a finding the
          // repair-editor already reported as addressed in a prior round).
          // The reviewer re-derives findings from scratch and may return the
          // same NON_BLOCKING architectural commentary; without this filter
          // the loop never converges. Condoned texts are cleared on gate pass.
          // T1.3/T1.5: reviewer-supplied finding records, collected ONCE for
          // the whole round. The condone filter below needs them to key on the
          // reviewer's stable finding id, and the record builds further down
          // reuse the same list so a re-raised finding keeps its reviewer id
          // instead of being re-minted as a content-hash `RF-...` id.
          const reviewerFindingRecords =
            collectReviewerFindingRecords(reviewerToolResult)
          // T1.5: (verdict class, identity) keys are authoritative. The legacy
          // text list is consulted ONLY while no keys exist (state serialized
          // before this field), because a legacy entry carries no class and
          // trusting it alongside keys would restore the escalation swallow.
          const condonedKeys: Set<string> = new Set<string>(
            activeWorkState.condonedFindingKeys ?? [],
          )
          const condonedTexts: Set<string> = new Set<string>(
            activeWorkState.condonedFindingTexts ?? [],
          )
          // Gate-derived hard rules (coverage missing, failed dimension, in-scope
          // requirement missing/uncertain) are NOT condonable: they are derived by the
          // gate from the reviewer's structured fields, not reviewer prose a repair
          // round can "address". Letting the condone filter suppress them empties the
          // blocker list and reaches the condoned-pass branch below, which sets the
          // verdict directly and so bypasses getReviewerFinalizationVerdict — the only
          // enforcement of coverage: 'missing' and in-scope requirement gaps.
          // Parent-owned requirement gaps are filtered out the same way they are for
          // collectedBlockers, so a process-only gap never becomes permanent.
          const hardBlockers: Set<string> = new Set<string>(
            rawHardBlockers.filter(
              (blocker: string) => !parentOwnedRequirementBlockers.has(blocker),
            ),
          )
          const blockers: string[] = collectedBlockers.filter(
            (blocker: string) => {
              // Hard rules are exempt from condoning. The strings are
              // byte-identical across the two collectors, so exact membership
              // works with no prefix parsing.
              if (hardBlockers.has(blocker)) return true
              const verdictClass = reviewerVerdictClass(blocker)
              // Strip the NON_BLOCKING/BLOCKING prefix for text comparison since
              // the condoned text is the raw finding text without the prefix.
              const rawText = stripReviewerVerdictPrefix(blocker)
              if (condonedKeys.size > 0) {
                return !condonedKeyMatches(
                  condonedKeys,
                  verdictClass,
                  rawText,
                  correlateReviewerFindingRecord(
                    blocker,
                    reviewerFindingRecords,
                  )?.id,
                )
              }
              return !legacyCondonedTextMatches(condonedTexts, blocker)
            },
          )
          // Record any newly-condoned texts (collected but filtered out) so
          // they persist across rounds and in the pinned state display.
          if (blockers.length < collectedBlockers.length) {
            const suppressed: string[] = collectedBlockers.filter(
              (b: string) => !blockers.includes(b),
            )
            const newlyCondoned: string[] = suppressed.map((b: string) =>
              stripReviewerVerdictPrefix(b),
            )
            activeWorkState.condonedFindingTexts = boundCondonedEntries([
              ...(activeWorkState.condonedFindingTexts ?? []),
              ...newlyCondoned,
            ])
            // Mirror the same suppressions into the class-keyed list so a
            // suppression recorded on this path cannot later be re-read as
            // class-agnostic.
            activeWorkState.condonedFindingKeys = boundCondonedEntries([
              ...(activeWorkState.condonedFindingKeys ?? []),
              ...suppressed.flatMap((b: string) =>
                condonedFindingKeysFor(
                  reviewerVerdictClass(b),
                  stripReviewerVerdictPrefix(b),
                  correlateReviewerFindingRecord(b, reviewerFindingRecords)?.id,
                ),
              ),
            ])
            markActiveWorkStateChanged()
          }
          // Condoned pass: the condoned filter suppressed every collected
          // blocker, so the reviewer only re-returned findings a prior repair
          // round already reported as addressed. Credit the review as
          // LOOKS_GOOD and skip the repair-editor spawn entirely so the
          // reviewer -> repair -> re-review loop converges. The existing
          // finalization branch below still fires on this verdict.
          if (collectedBlockers.length > 0 && blockers.length === 0) {
            // The filter above exempts hard rules, so an empty surviving set means no
            // hard rule fired. Re-assert it here from the receipt's own hard-rule set
            // so a future filter change cannot silently restore the bypass: the
            // condone path may suppress blockers but must never be verdict authority
            // over coverage/requirement rules. When the receipt produced a hard rule
            // it stays in `blockers` and drives the normal repair path, so nothing is
            // credited and openReviewerBlockers is not cleared.
            const receiptHasHardRule = hardBlockers.size > 0
            if (!receiptHasHardRule) {
              reviewerFinalizationVerdict = 'LOOKS_GOOD'
              recordSuccessfulReviewReceipt(
                reviewerToolResult,
                requiredReviewerAgentType,
                reviewSnapshotFingerprint,
              )
              // Clear the now-condoned blocker strings so the pinned state and
              // finalization no longer surface them as open. mergeReviewerFindings
              // is not invoked on this path (no surviving blockers), so without
              // this the first review's blocker strings would persist and the
              // gate would look like it still has open feedback even though the
              // findings were condoned. Keyed on (verdict class, identity) like
              // the condone filter above — NOT stripped text alone: this list
              // retains other families' blockers (mergeReviewerFindings keeps
              // them), so a text-only match could drop a security-reviewer
              // `BLOCKING: <same text>` blocker that was never condoned. The
              // sets are rebuilt here because the suppression recording above
              // just appended to both lists. Legacy text fallback only while no
              // keys exist, exactly as above.
              const cleanupCondonedKeys: Set<string> = new Set<string>(
                activeWorkState.condonedFindingKeys ?? [],
              )
              const cleanupCondonedTexts: Set<string> = new Set<string>(
                activeWorkState.condonedFindingTexts ?? [],
              )
              activeWorkState.openReviewerBlockers = (
                activeWorkState.openReviewerBlockers ?? []
              ).filter((blocker: string) => {
                if (cleanupCondonedKeys.size > 0) {
                  return !condonedKeyMatches(
                    cleanupCondonedKeys,
                    reviewerVerdictClass(blocker),
                    stripReviewerVerdictPrefix(blocker),
                    correlateReviewerFindingRecord(
                      blocker,
                      reviewerFindingRecords,
                    )?.id,
                  )
                }
                return !legacyCondonedTextMatches(cleanupCondonedTexts, blocker)
              })
              markActiveWorkStateChanged()
            }
          }
          if (blockers.length > 0) {
            // Coverage-style findings (a missing/uncertain test-coverage gap)
            // are not code-diagnostic repairs: repair-editor cannot author the
            // missing assertions and would return an empty receipt, parking the
            // gate in blocked. Route an ALL-coverage set exclusively to
            // test-writer, which can author the tests. Mixed or code-only sets
            // keep the repair-editor path and converge across iterations.
            const allCoverageFindings = blockers.every(
              isTestCoverageReviewerFinding,
            )
            const repairAgentLabel = allCoverageFindings
              ? 'Test-writer'
              : 'Repair-editor'
            activeWorkState.reviewerRepairRoundCount =
              Number(activeWorkState.reviewerRepairRoundCount ?? 0) + 1
            // Optional hard round cap for the reviewer -> repair -> re-review
            // loop when createBase2/env set a finite maxReviewerRepairRounds.
            // Default is unlimited; NON_BLOCKING findings still burn the counter
            // for telemetry. The snapshot-progress guard below breaks when a
            // repair makes no fingerprint change.
            if (
              Number.isFinite(MAX_REVIEWER_REPAIR_ROUNDS) &&
              Number(activeWorkState.reviewerRepairRoundCount ?? 0) >
                MAX_REVIEWER_REPAIR_ROUNDS
            ) {
              // Preserve other families' open findings while recording this
              // code-reviewer blocker set (budget exhausted before full merge
              // records are built below on the non-exhausted path).
              const budgetExhaustedRecords = blockers.map(
                (text: string, index: number) => ({
                  id:
                    correlateReviewerFindingRecord(text, reviewerFindingRecords)
                      ?.id ?? buildReviewerFindingId(text, index),
                  gateId: `${requiredReviewerAgentType}:${reviewSnapshotFingerprint}`,
                  text,
                  status: 'open' as const,
                  files: Array.from(pendingGateFiles),
                  snapshotFingerprint: reviewSnapshotFingerprint,
                  reviewer: requiredReviewerAgentType as
                    | 'code-reviewer'
                    | 'security-reviewer'
                    | SpecialistReviewerAgent,
                  createdAt: new Date().toISOString(),
                }),
              )
              mergeReviewerFindings(
                requiredReviewerAgentType,
                budgetExhaustedRecords,
                blockers,
              )
              activeWorkState.currentPhase = 'blocked'
              activeWorkState.nextRequiredAction = `Reviewer repair budget exhausted (${MAX_REVIEWER_REPAIR_ROUNDS}/${MAX_REVIEWER_REPAIR_ROUNDS}); the reviewer findings are still open. Stop retrying automatically and inspect the findings or handoff.`
              activeWorkState.latestWorkSummary = `Reviewer repair budget exhausted for pending files: ${Array.from(pendingGateFiles).join(', ') || '(unknown files)'}`
              markActiveWorkStateChanged()
              yield {
                toolName: 'add_message',
                input: {
                  role: 'user',
                  content: [
                    `Reviewer gate: automated repair budget exhausted after ${MAX_REVIEWER_REPAIR_ROUNDS} round(s); the following findings are still open and were not cleared:`,
                    '',
                    ...blockers,
                    '',
                    'Stop retrying automatically. Inspect the findings directly, fix them, or explicitly authorize a different path.',
                  ].join('\n'),
                },
                includeToolCall: false,
              } as any
              break
            }
            // New-vs-carried is derived from ALREADY-PERSISTED gate state:
            // openReviewerFindings has rehydration wired, and reviewer round
            // counts reset only on gate pass, so a round is expected to span a
            // turn boundary. A locals-based comparison would report every
            // finding as new exactly when the metric matters. Read BEFORE
            // mergeReviewerFindings overwrites the ledger, filtered to this
            // reviewer so another family's open findings cannot inflate carried,
            // and with the condone filter's exact prefix regex so carried/new
            // cannot disagree with condoning.
            const priorOwnFindingTexts = new Set(
              (activeWorkState.openReviewerFindings ?? [])
                .filter(
                  (finding) => finding.reviewer === requiredReviewerAgentType,
                )
                .map((finding) => stripReviewerVerdictPrefix(finding.text)),
            )
            const carriedFindingCount = blockers.filter((blocker: string) =>
              priorOwnFindingTexts.has(stripReviewerVerdictPrefix(blocker)),
            ).length
            // SHADOW MODE — observation only: log what a severity threshold
            // WOULD decide without acting on it. Nothing here may branch or
            // touch blockers, the verdict, the repair spawn, or the phase
            // (thresholding is evidence-gated Tier 2 work). Severity metadata
            // does not exist yet, so every finding sits in one `unlabeled`
            // bucket; when severity lands, replace this single predicate with
            // per-severity buckets over the same list. Gate-derived hard rules
            // are never suppressible, so reuse the hardBlockers set above.
            const suppressibleFindings = blockers.filter(
              (blocker: string) =>
                blocker.startsWith('NON_BLOCKING:') &&
                !hardBlockers.has(blocker),
            )
            // T1.5 evidence: blockers whose identity WAS condoned, but under
            // the other verdict class. These are exactly the escalations the
            // old text-only key swallowed; probing only the other class (never
            // the `*` wildcard) keeps class-agnostic legacy entries out.
            const escalatedFindings = blockers.filter((blocker: string) => {
              const verdictClass = reviewerVerdictClass(blocker)
              if (verdictClass === '*') return false
              const otherClass =
                verdictClass === 'BLOCKING' ? 'NON_BLOCKING' : 'BLOCKING'
              return condonedFindingKeysFor(
                otherClass,
                stripReviewerVerdictPrefix(blocker),
                correlateReviewerFindingRecord(blocker, reviewerFindingRecords)
                  ?.id,
              ).some((key) => condonedKeys.has(key))
            })
            // Emitted only on this non-exhausted path; an exhausted round is
            // already covered by its own skipReason telemetry.
            emitGateTelemetry({
              currentPhase: activeWorkState.currentPhase,
              reviewerStatus: 'round-findings',
              reviewer: requiredReviewerAgentType,
              repairRound: Number(
                activeWorkState.reviewerRepairRoundCount ?? 0,
              ),
              findingCount: blockers.length,
              rawFindingCount: rawCollectedBlockers.length,
              newFindingCount: blockers.length - carriedFindingCount,
              carriedFindingCount,
              pendingFileCount: reviewableGateScopeFiles.length,
              suppressibleFindingCount: suppressibleFindings.length,
              escalatedFindingCount: escalatedFindings.length,
              wouldPassAtThisRound:
                suppressibleFindings.length === blockers.length &&
                blockers.length > 0,
            })
            const codeReviewerFindingRecords = blockers.map(
              (text: string, index: number) => ({
                id:
                  correlateReviewerFindingRecord(text, reviewerFindingRecords)
                    ?.id ?? buildReviewerFindingId(text, index),
                gateId: `${requiredReviewerAgentType}:${reviewSnapshotFingerprint}`,
                // Deliberately the blocker string, NOT `record?.text` (which the
                // security path uses): the condone filter and the carried/new
                // derivation above both key on this text minus its
                // NON_BLOCKING/BLOCKING prefix, and `record.text` omits the
                // `[id] ` segment the blocker carries. Swapping it would make
                // condoning and carried-count disagree. Only the id is adopted.
                text,
                status: 'open' as const,
                files: Array.from(pendingGateFiles),
                snapshotFingerprint: reviewSnapshotFingerprint,
                reviewer: requiredReviewerAgentType as
                  | 'code-reviewer'
                  | 'security-reviewer'
                  | SpecialistReviewerAgent,
                createdAt: new Date().toISOString(),
              }),
            )
            // Merge instead of replace: another reviewer's still-open
            // findings/blockers must not be clobbered by the final code-reviewer.
            mergeReviewerFindings(
              requiredReviewerAgentType,
              codeReviewerFindingRecords,
              blockers,
            )
            activeWorkState.nextRequiredAction =
              'Resolve the reviewer feedback below before any unrelated work, final response, or another review.'
            activeWorkState.currentPhase = 'blocked'
            activeWorkState.latestWorkSummary = `Reviewer feedback is open for pending files: ${Array.from(pendingGateFiles).join(', ') || '(unknown files)'}`
            markActiveWorkStateChanged()
            // Read through the shared collector, NOT a receipt:
            // recordSuccessfulReviewReceipt only runs once a finalization
            // verdict exists, so this round has written none yet.
            const roundAdvisories = boundAdvisoryLines(
              collectReviewerAdvisories(reviewerToolResult),
            )
            yield {
              toolName: 'add_message',
              input: {
                role: 'user',
                content: [
                  `Reviewer gate: ${reviewerAgentType} returned blocking feedback. The harness will send these exact findings to ${allCoverageFindings ? 'test-writer' : 'repair-editor'}:`,
                  '',
                  ...blockers,
                  ...(roundAdvisories.length > 0
                    ? [
                        '',
                        'Advisories (non-blocking; no change required):',
                        ...roundAdvisories.map((advisory) => `- ${advisory}`),
                      ]
                    : []),
                  '',
                  'These findings remain open until targeted validation and a fresh matching reviewer pass clear them.',
                ].join('\n'),
              },
              includeToolCall: false,
            } as any
            // Snapshot-progress baseline for the reviewer repair round,
            // captured BEFORE the repair spawn and with the SAME inputs the
            // post-repair fingerprint uses (pending gate files + the current
            // validation summary). Comparing against reviewSnapshotFingerprint
            // instead would compare a summary-less reviewable-scope hash with a
            // summary-bearing pending-scope hash, which can never be equal, so
            // a repair that changes nothing would keep re-entering the loop.
            const preReviewerRepairFingerprint = hashGateSnapshotDetails(
              buildGateSnapshotDetails(
                Array.from(pendingGateFiles),
                validationSummary,
              ),
            )
            // Recording the BASELINE (not just post-repair states) is what
            // makes A→B→A trip: round 1 records A, post B is new; round 2
            // records B, post A is already in the set.
            seenReviewerRepairFingerprints.add(preReviewerRepairFingerprint)
            const reviewerRepairSessionId =
              activeWorkState.repairSessionId ??
              `review-repair-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
            activeWorkState.repairSessionId = reviewerRepairSessionId
            // Route through the owed-set mutator so the scalar can never drift
            // from owedReviewerRevalidations (a later clearOwedReviewer would
            // otherwise re-derive the scalar from a stale array).
            addOwedReviewer(requiredReviewerAgentType)
            activeWorkState.currentPhase = 'repair_loop'
            activeWorkState.nextRequiredAction = allCoverageFindings
              ? 'Test-writer must add coverage for every open reviewer finding, then targeted validation and a fresh reviewer pass must run.'
              : 'Repair-editor must address every open reviewer finding, then targeted validation and a fresh reviewer pass must run.'
            const reviewerRepairResult = yield {
              toolName: 'spawn_agents',
              input: {
                agents: [
                  allCoverageFindings
                    ? {
                        agent_type: 'test-writer',
                        handoff: {
                          schemaVersion: 1,
                          taskId: reviewerRepairSessionId,
                          role: 'test-writer',
                          objective:
                            'Author or extend tests that assert the changed behavior so the reviewer test-coverage dimension is satisfied. For each finding, add or extend a case in the relevant *.test.* file exercising the behavior-changing logic in the gate changed files. Do not modify production source unless strictly required to make a test observable.',
                          requirements:
                            activeWorkState.openReviewerFindings.map(
                              ({ id, text }) => ({ id, text, required: true }),
                            ),
                          acceptanceCriteria:
                            activeWorkState.openReviewerFindings.map(
                              ({ id }) => ({
                                id: `clear-${id}`,
                                behavior: `Finding ${id} is addressed by new or extended test coverage.`,
                                verification:
                                  'Targeted validation passes and a fresh snapshot-bound reviewer clears the finding.',
                              }),
                            ),
                          context: [],
                          invariants: [
                            'Read every target from the live filesystem before editing.',
                            'Treat every finding ID as open until a fresh reviewer clears it.',
                          ],
                          nonGoals: [
                            'Unrelated diagnostics, refactors, or cleanup.',
                          ],
                          risks: [
                            'Reviewer findings may be stale if the workspace snapshot changed.',
                          ],
                          unknowns: [],
                          findings: activeWorkState.openReviewerFindings.map(
                            ({ id, text, files, snapshotFingerprint }) => ({
                              id,
                              text,
                              files,
                              snapshotFingerprint,
                            }),
                          ),
                          permissions: {
                            readablePaths: repairEditorReadablePaths(
                              [
                                ...pendingGateFiles,
                                ...activeWorkState.openReviewerFindings.flatMap(
                                  (finding: { files?: string[] }) =>
                                    finding.files ?? [],
                                ),
                              ],
                              activeWorkState.openReviewerFindings.map(
                                (finding: { text?: string }) =>
                                  finding.text ?? '',
                              ),
                            ),
                            writablePaths: Array.from(
                              new Set([
                                ...pendingGateFiles,
                                ...activeWorkState.openReviewerFindings.flatMap(
                                  (finding: { files?: string[] }) =>
                                    finding.files ?? [],
                                ),
                              ]),
                            ),
                            allowedTools: [
                              'read_files',
                              'read_outline',
                              'read_subtree',
                              'write_file',
                              'str_replace',
                              'set_output',
                            ],
                          },
                          workspaceRevision:
                            mutableAgentState.workspaceState?.revision,
                          workspaceSnapshotId:
                            mutableAgentState.workspaceState?.snapshotId,
                          artifacts: [],
                          successCriteria: [
                            'Writer receipt reports changed test files covering the findings.',
                          ],
                          constraints: [
                            'Keep every edit within the pending gate file set.',
                          ],
                        },
                        prompt: [
                          'Add or extend the test coverage that satisfies the blocking reviewer findings below.',
                          'Treat every finding ID as open until a fresh reviewer clears it.',
                          'Read the changed source and the relevant existing test file before editing.',
                          '',
                          ...activeWorkState.openReviewerFindings.map(
                            (finding) => `${finding.id}: ${finding.text}`,
                          ),
                        ].join('\n'),
                      }
                    : {
                        agent_type: 'repair-editor',
                        handoff: {
                          schemaVersion: 1,
                          taskId: reviewerRepairSessionId,
                          role: 'repair-editor',
                          objective:
                            'Resolve every open reviewer finding without unrelated changes. Read the current file contents before editing; conversational summaries are not source evidence.',
                          requirements:
                            activeWorkState.openReviewerFindings.map(
                              ({ id, text }) => ({ id, text, required: true }),
                            ),
                          acceptanceCriteria:
                            activeWorkState.openReviewerFindings.map(
                              ({ id }) => ({
                                id: `clear-${id}`,
                                behavior: `Finding ${id} is addressed in the live workspace.`,
                                verification:
                                  'Targeted validation passes and a fresh snapshot-bound reviewer clears the finding.',
                              }),
                            ),
                          context: [],
                          invariants: [
                            'Read every target from the live filesystem before editing.',
                            'Treat every finding ID as open until a fresh reviewer clears it.',
                          ],
                          nonGoals: [
                            'Unrelated diagnostics, refactors, or cleanup.',
                          ],
                          risks: [
                            'Reviewer findings may be stale if the workspace snapshot changed.',
                          ],
                          unknowns: [],
                          findings: activeWorkState.openReviewerFindings.map(
                            ({ id, text, files, snapshotFingerprint }) => ({
                              id,
                              text,
                              files,
                              snapshotFingerprint,
                            }),
                          ),
                          permissions: {
                            readablePaths: repairEditorReadablePaths(
                              [
                                ...pendingGateFiles,
                                ...activeWorkState.openReviewerFindings.flatMap(
                                  (finding: { files?: string[] }) =>
                                    finding.files ?? [],
                                ),
                              ],
                              activeWorkState.openReviewerFindings.map(
                                (finding: { text?: string }) =>
                                  finding.text ?? '',
                              ),
                            ),
                            writablePaths: Array.from(
                              new Set([
                                ...pendingGateFiles,
                                ...activeWorkState.openReviewerFindings.flatMap(
                                  (finding: { files?: string[] }) =>
                                    finding.files ?? [],
                                ),
                              ]),
                            ),
                            allowedTools: [
                              'read_files',
                              'read_outline',
                              'read_subtree',
                              'edit_transaction',
                            ],
                          },
                          workspaceRevision:
                            mutableAgentState.workspaceState?.revision,
                          workspaceSnapshotId:
                            mutableAgentState.workspaceState?.snapshotId,
                          artifacts: [],
                          successCriteria: [
                            'All finding IDs are cleared by a fresh reviewer receipt.',
                          ],
                          constraints: [
                            'Keep every edit within the pending gate file set.',
                          ],
                        },
                        prompt: [
                          'Repair the blocking reviewer findings below.',
                          'Treat every finding ID as open until a fresh reviewer clears it.',
                          'Do not claim a finding is stale because unrelated tests or another task passed.',
                          'Read every target from the live filesystem before editing.',
                          'Keep unrelated diagnostics secondary to this finding set.',
                          '',
                          ...activeWorkState.openReviewerFindings.map(
                            (finding) => `${finding.id}: ${finding.text}`,
                          ),
                        ].join('\n'),
                      },
                ],
              },
            } as any
            const repairCrash = detectReviewerCrash(
              (reviewerRepairResult as any)?.toolResult ?? reviewerRepairResult,
            )
            if (repairCrash) {
              activeWorkState.currentPhase = 'blocked'
              activeWorkState.nextRequiredAction = `${repairAgentLabel} failed while addressing reviewer findings. Inspect the failure before retrying.`
              activeWorkState.latestWorkSummary = `${repairAgentLabel} failed: ${repairCrash}`
              markActiveWorkStateChanged()
              break
            }
            const reviewerRepairReceipt = extractAgentReceipt(
              (reviewerRepairResult as any)?.toolResult ?? reviewerRepairResult,
            )
            const openFindingIds = new Set(
              (activeWorkState.openReviewerFindings ?? []).map(
                (finding) => finding.id,
              ),
            )
            const reviewerRepairHasProgress =
              !!reviewerRepairReceipt &&
              reviewerRepairReceipt.changedFiles.some(
                (file: { path: string }) =>
                  typeof file.path === 'string' && file.path.trim().length > 0,
              )
            if (
              !reviewerRepairReceipt ||
              (!reviewerRepairHasProgress &&
                (reviewerRepairReceipt.status !== 'completed' ||
                  [...openFindingIds].some(
                    (id) =>
                      !reviewerRepairReceipt.findingsAddressed.includes(id),
                  )))
            ) {
              activeWorkState.currentPhase = 'blocked'
              activeWorkState.nextRequiredAction = `${repairAgentLabel} did not return a completed receipt addressing every open reviewer finding.`
              activeWorkState.latestWorkSummary =
                'Reviewer repair receipt was incomplete or missing.'
              markActiveWorkStateChanged()
              break
            }
            // Stale-finding capture: record the finding texts that the
            // repair-editor reported as addressed. If the fresh re-review
            // returns identical text, the blocker-elevation filter above
            // will suppress it as condoned, breaking the infinite loop.
            //
            // Condone credit is ORCHESTRATOR-OWNED evidence, not reviewer/repair
            // self-report: a listed finding id is only condoned when the receipt
            // claims completion AND actually changed at least one file. A rejected
            // claim leaves the finding open, so the next re-review re-elevates it
            // instead of silently converging on an unrepaired workspace.
            // reviewerRepairHasProgress is the same non-empty changedFiles[].path
            // predicate the loop-continuation guard above uses (that guard's break
            // condition is deliberately unchanged — it governs whether the loop
            // proceeds, which is a separate concern).
            const addressedFindings = (
              activeWorkState.openReviewerFindings ?? []
            ).filter((finding) =>
              reviewerRepairReceipt!.findingsAddressed.includes(finding.id),
            )
            const condoneEvidenceIsSufficient =
              reviewerRepairReceipt!.status === 'completed' &&
              reviewerRepairHasProgress
            if (addressedFindings.length > 0 && condoneEvidenceIsSufficient) {
              const addressedTexts = addressedFindings.map((finding) =>
                stripReviewerVerdictPrefix(finding.text),
              )
              activeWorkState.condonedFindingTexts = boundCondonedEntries([
                ...(activeWorkState.condonedFindingTexts ?? []),
                ...addressedTexts,
              ])
              // T1.5: record the (verdict class, identity) key alongside the
              // legacy text so a later review that RE-RAISES the same text at a
              // higher verdict class is not condoned by it. The class comes from
              // the stored finding text, which the code-reviewer path keeps
              // prefixed for exactly this reason.
              activeWorkState.condonedFindingKeys = boundCondonedEntries([
                ...(activeWorkState.condonedFindingKeys ?? []),
                ...addressedFindings.flatMap((finding) =>
                  condonedFindingKeysFor(
                    reviewerVerdictClass(finding.text),
                    stripReviewerVerdictPrefix(finding.text),
                    finding.id,
                  ),
                ),
              ])
              markActiveWorkStateChanged()
            } else if (addressedFindings.length > 0) {
              emitGateTelemetry({
                currentPhase: activeWorkState.currentPhase,
                reviewerStatus: 'repair',
                condoneClaimsRejected: addressedFindings.length,
                condoneRejectReason:
                  reviewerRepairReceipt!.status !== 'completed'
                    ? 'receipt-not-completed'
                    : 'no-changed-files',
              })
            }
            const reviewerRepairStatus = yield {
              toolName: 'git_status',
              input: {},
            } as any
            const reviewerRepairFiles = extractGitStatusFiles(
              (reviewerRepairStatus as any)?.toolResult,
            ).filter((file: string) => pendingGateFiles.has(file))
            if (reviewerRepairFiles.length > 0) {
              recordChangedFiles(reviewerRepairFiles, { fromRepair: true })
            }
            const repairedSnapshotFingerprint = hashGateSnapshotDetails(
              buildGateSnapshotDetails(
                Array.from(pendingGateFiles),
                validationSummary,
              ),
            )
            // No-progress detection for the reviewer
            // review -> repair -> re-review loop. The round cap above bounds
            // repairs that keep producing churn; this bounds the opposite case,
            // where a repair reports success but changes no pending bytes, so a
            // fresh reviewer pass could only return the same findings. Fail
            // closed and retract finalization instead of looping.
            if (repairedSnapshotFingerprint === preReviewerRepairFingerprint) {
              activeWorkState.lastReviewerGateSkipReason =
                'reviewer-repair-no-progress'
              activeWorkState.currentPhase = 'blocked'
              activeWorkState.nextRequiredAction = `${repairAgentLabel} made no snapshot-visible progress on the reviewer findings. Stop retrying and inspect the finding or handoff.`
              activeWorkState.latestWorkSummary =
                'Reviewer repair produced no workspace fingerprint change.'
              mutableAgentState.canSuggestFollowups = false
              finalResponseGateOpen = false
              markActiveWorkStateChanged()
              break
            }
            // Turn-scoped CYCLE detection. The equality guard above already
            // handled an UNCHANGED fingerprint, so reaching here means the
            // bytes changed — but this exact workspace state was already
            // visited earlier in this turn's repair loop, i.e. the repairs are
            // oscillating (A→B→A). A fresh reviewer pass could only walk the
            // same ring again, so fail closed on demonstrated non-progress
            // instead of waiting for a guessed repair budget. NOTE: this
            // fingerprint folds in validationSummary, so it is not a pure file
            // content hash; a summary that reverts along with the bytes is
            // still a genuine cycle and blocking is correct.
            if (
              seenReviewerRepairFingerprints.has(repairedSnapshotFingerprint)
            ) {
              activeWorkState.lastReviewerGateSkipReason =
                'reviewer-repair-cycle'
              activeWorkState.currentPhase = 'blocked'
              activeWorkState.nextRequiredAction = `${repairAgentLabel} returned the workspace to a state it already visited this turn while addressing the reviewer findings; retrying will not converge. Stop retrying and inspect the finding or handoff.`
              activeWorkState.latestWorkSummary =
                'Reviewer repair loop revisited an earlier workspace fingerprint (repair cycle).'
              mutableAgentState.canSuggestFollowups = false
              finalResponseGateOpen = false
              markActiveWorkStateChanged()
              emitGateTelemetry({
                currentPhase: 'blocked',
                pendingFileCount: pendingGateFiles.size,
                pendingFiles: Array.from(pendingGateFiles),
                reviewerStatus: 'failed',
                validationStatus: 'passed',
                repairRound: Number(
                  activeWorkState.reviewerRepairRoundCount ?? 0,
                ),
                skipReason: 'reviewer-repair-cycle',
              })
              break
            }
            seenReviewerRepairFingerprints.add(repairedSnapshotFingerprint)
            const reVerify = yield {
              toolName: 'run_file_change_hooks',
              input: { files: Array.from(pendingGateFiles) },
            } as any
            const reFailures = collectHookFailures(
              (reVerify as any) && (reVerify as any).toolResult,
            )
            if (reFailures.length === 0) {
              // Same no-drift rule: only seed the owed family when nothing is
              // owed yet, and do it through the mutator.
              if (
                (activeWorkState.owedReviewerRevalidations ?? []).length === 0
              ) {
                addOwedReviewer(
                  reviewerOriginFromGateId(
                    activeWorkState.openReviewerFindings[0]?.gateId,
                  ),
                )
              }
              validationSummary = summarizeHookResults(
                (reVerify as any) && (reVerify as any).toolResult,
              )
              activeWorkState.lastValidationSummary = validationSummary
              activeWorkState.currentPhase = 'awaiting_review'
              activeWorkState.nextRequiredAction = ''
              activeWorkState.latestWorkSummary = `${repairAgentLabel} addressed reviewer findings; validation re-ran inline and a fresh reviewer pass is required.`
              markActiveWorkStateChanged()
              emitGateTelemetry({
                currentPhase: 'awaiting_review',
                pendingFileCount: pendingGateFiles.size,
                pendingFiles: Array.from(pendingGateFiles),
                validationStatus: 'passed',
                reuseReason: 'reviewer-repair-succeeded',
              })
              continue
            } else {
              activeWorkState.nextRequiredAction =
                'Fix the remaining validation hook failures before doing anything else.'
              activeWorkState.lastReviewerGateSkipReason =
                'validation-hook-failures'
              activeWorkState.currentPhase = 'blocked'
              activeWorkState.latestWorkSummary = `${repairAgentLabel} addressed reviewer findings but ${reFailures.length} validation failure(s) remain.`
              markActiveWorkStateChanged()
              emitGateTelemetry({
                currentPhase: 'blocked',
                pendingFileCount: pendingGateFiles.size,
                pendingFiles: Array.from(pendingGateFiles),
                validationStatus: 'failed',
                blockerCount: reFailures.length,
                skipReason: 'reviewer-repair-validation-failed',
              })
              yield {
                toolName: 'add_message',
                input: {
                  role: 'user',
                  content: [
                    `${repairAgentLabel} addressed the reviewer findings but ${reFailures.length} validation failure(s) remain. Fix these before ending your turn:`,
                    '',
                    ...reFailures,
                    '',
                    'Read the exact failing locations, make minimal targeted fixes, then finish (the hooks will re-run).',
                    formatGateStateBlock(
                      'validation',
                      'failed',
                      `reviewer-repair-validation-failed: ${reFailures.length} failure(s) remain for pending files: ${Array.from(pendingGateFiles).join(', ') || '(unknown files)'}`,
                    ),
                  ].join('\n'),
                },
                includeToolCall: false,
              } as any
              continue
            }
          }
          // Keep the verdict already set by the condoned pass above;
          // otherwise derive it from the reviewer output as before.
          if (!reviewerFinalizationVerdict) {
            reviewerFinalizationVerdict =
              getReviewerFinalizationVerdict(reviewerToolResult)
          }
          if (reviewerFinalizationVerdict) {
            setGateProgress(
              `gate: reviewer verdict ${reviewerFinalizationVerdict}; finalizing`,
            )
            recordSuccessfulReviewReceipt(
              reviewerToolResult,
              requiredReviewerAgentType,
              reviewSnapshotFingerprint,
            )
          }
          if (!reviewerFinalizationVerdict) {
            // Distinguish a reviewer CRASH (agent itself errored / produced no
            // output) from a reviewer that ran successfully but failed to
            // populate its required structured output. The
            // operator-facing message differs because the recovery action
            // differs: a crash means "retry or escalate; the verdict is
            // unknown" whereas a no-verdict means "re-prompt for the
            // contract; the reviewer ran fine, it just used the wrong
            // format". Conflating them caused reviewer-loop bugs where the
            // model kept retrying the same prompt against a crashing agent.
            const reviewerCrash = detectReviewerCrash(reviewerToolResult)
            activeWorkState.currentPhase = 'blocked'
            if (reviewerCrash) {
              activeWorkState.reviewerCrashCount =
                (activeWorkState.reviewerCrashCount ?? 0) + 1
              const bypassAuthorized =
                activeWorkState.reviewerCrashCount > 1 &&
                hasReviewerBypassAuthorization(
                  currentConversationMessages,
                  activeWorkState.reviewerBypassChallenge,
                  reviewSnapshotFingerprint,
                )
              if (bypassAuthorized) {
                activeWorkState.reviewerGateBypassReason = `User authorized bypass after ${activeWorkState.reviewerCrashCount} reviewer crashes: ${reviewerCrash}`
                activeWorkState.reviewerGateBypassRecord = {
                  reason: activeWorkState.reviewerGateBypassReason,
                  authorizedAt: new Date().toISOString(),
                  pendingFiles: Array.from(pendingGateFiles),
                  fingerprint: reviewSnapshotFingerprint,
                  validationSummary,
                }
                if (activeWorkState.reviewerBypassChallenge) {
                  activeWorkState.reviewerBypassChallenge.consumed = true
                }
                activeWorkState.nextRequiredAction = ''
                activeWorkState.currentPhase = 'awaiting_review'
                reviewerFinalizationVerdict = 'LOOKS_GOOD'
                markActiveWorkStateChanged()
                emitGateTelemetry({
                  currentPhase: 'awaiting_review',
                  pendingFileCount: pendingGateFiles.size,
                  pendingFiles: Array.from(pendingGateFiles),
                  reviewerStatus: 'skipped',
                  validationStatus: 'passed',
                  skipReason: 'user-authorized-reviewer-crash-bypass',
                })
              } else {
                const challenge =
                  activeWorkState.reviewerCrashCount > 1
                    ? ensureReviewerBypassChallenge(
                        reviewSnapshotFingerprint,
                        currentConversationMessages,
                      )
                    : undefined
                activeWorkState.nextRequiredAction =
                  activeWorkState.reviewerCrashCount === 1
                    ? 'Retry the reviewer gate once. If it crashes again, ask the user whether to bypass the reviewer with the validation result recorded.'
                    : `Reviewer crashed repeatedly. Ask the user explicitly whether to reply "BYPASS REVIEWER ${challenge?.id}" for this snapshot; do not retry again without new configuration.`
                markActiveWorkStateChanged()
                yield {
                  toolName: 'add_message',
                  input: {
                    role: 'user',
                    content: [
                      `Reviewer gate: ${reviewerAgentType} CRASHED (attempt ${activeWorkState.reviewerCrashCount}).`,
                      '',
                      `Crash detail: ${reviewerCrash}`,
                      '',
                      activeWorkState.reviewerCrashCount === 1
                        ? 'Retry this reviewer once. Do not silently loop.'
                        : `Do not retry again. Ask the user whether to bypass the reviewer gate based on the completed validation evidence. The bypass is accepted only after the exact response "BYPASS REVIEWER ${challenge?.id}".`,
                    ].join('\n'),
                  },
                  includeToolCall: false,
                } as any
                continue
              }
            } else {
              activeWorkState.reviewerNoVerdictCount =
                (activeWorkState.reviewerNoVerdictCount ?? 0) + 1
              if (
                activeWorkState.reviewerNoVerdictCount >
                MAX_REVIEWER_NO_VERDICT_RETRIES
              ) {
                activeWorkState.nextRequiredAction =
                  'Reviewer repeatedly violated its structured output contract. Fix reviewer configuration before retrying.'
                activeWorkState.latestWorkSummary =
                  'Reviewer no-verdict retry budget exhausted.'
                markActiveWorkStateChanged()
                break
              }
              activeWorkState.nextRequiredAction =
                'Retry the automated reviewer gate; reviewer did not populate its required structured output.'
              markActiveWorkStateChanged()
              yield {
                toolName: 'add_message',
                input: {
                  role: 'user',
                  content: [
                    `Reviewer gate: ${reviewerAgentType} ran but returned no structured output. The verdict is unavailable.`,
                    '',
                    'Do not manually re-spawn the reviewer or ask it for a textual label. Continue the gate loop so the automated reviewer retries with its declared output schema; it must call set_output and populate verdict, findings, coverage, dimensions, requirementCoverage, snapshotFingerprint, and reviewedFiles.',
                  ].join('\n'),
                },
                includeToolCall: false,
              } as any
            }
            if (!reviewerFinalizationVerdict) {
              continue
            }
          }
        }

        if (runValidationGate) {
          const passedPendingFiles = Array.from(pendingGateFiles)
          if (passedPendingFiles.length > 0 && reviewerFinalizationVerdict) {
            const finalGateStatus = yield {
              toolName: 'git_status',
              input: {},
            } as any
            const finalGateScopeFiles = deriveGateScopeFiles(
              extractGitStatusFiles((finalGateStatus as any)?.toolResult),
            )
            const finalGateScopeFingerprint = buildGateFingerprint(
              finalGateScopeFiles,
              '',
            )
            const finalReviewedFingerprint = hashGateSnapshotDetails(
              buildGateSnapshotDetails(
                selectReviewableGateFiles(gateScopeFiles),
                '',
              ),
            )
            if (
              !gateFileSetsEqual(
                postValidationScopeFiles,
                finalGateScopeFiles,
              ) ||
              finalGateScopeFingerprint !== frozenDirtyGateScopeFingerprint ||
              finalReviewedFingerprint !== reviewSnapshotFingerprint
            ) {
              activeWorkState.currentPhase = 'awaiting_validation'
              activeWorkState.latestWorkSummary =
                'The frozen gate scope or file bytes changed after review; validation and review were reopened.'
              activeWorkState.nextRequiredAction =
                'Re-run validation and review against the current dirty scope and file bytes.'
              markActiveWorkStateChanged()
              continue
            }
          }
          let activeWorkStateChanged = false
          // The live gate-issued plan-task receipt named in the gate-pass
          // message below. Assigned only when the FRESH mint site further down
          // issues a new receipt; the message falls back to the task's existing
          // live receipt, because supersession changes the ID and the model must
          // always be able to read the CURRENT one. Kept as a single declaration
          // here so the message builder can see it.
          let mintedPlanTaskReceipt: Base2PlanTaskGateReceipt | undefined
          if (passedPendingFiles.length > 0 && reviewerFinalizationVerdict) {
            // No pinned emission happens between here and the end of the gate,
            // so a transient 'gate: passed' line could never be rendered.
            // Reset the durable progress line directly (a stale mid-gate line
            // must not persist into the next edit cycle) and invalidate the
            // pinned cache once.
            activeWorkState.gateProgressLine = ''
            markActiveWorkStateChanged()
            activeWorkState.openReviewerBlockers = []
            activeWorkState.openReviewerFindings = []
            // Clear condoned finding texts as well so they cannot leak into
            // the next edit cycle; they only suppress re-elevation within the
            // reviewer repair loop that produced them.
            activeWorkState.condonedFindingTexts = []
            activeWorkState.condonedFindingKeys = []
            // Clear the owed SET, not just the legacy scalar: a leftover entry
            // would survive the pass and force a phantom re-attestation (or
            // resurrect the scalar via addOwedReviewer/clearOwedReviewer) on the
            // next edit set even though every reviewer just attested.
            activeWorkState.owedReviewerRevalidations = []
            activeWorkState.requiredReviewerRevalidation = undefined
            pendingGateFiles.clear()
            activeWorkState.pendingGateFiles = []
            activeWorkState.latestWorkSummary = ''
            editsHappened = false
            creditGatePassedFiles(gateScopeFiles)
            activeWorkState.gatePassedFiles = Array.from(gatePassedFiles)
            activeWorkState.gatePassedPendingFiles = passedPendingFiles
            activeWorkState.gatePassedReviewerVerdict =
              reviewerFinalizationVerdict
            activeWorkState.gatePassedValidationSummary = validationSummary
            activeWorkState.gatePassedFingerprint = buildGateFingerprint(
              passedPendingFiles,
              validationSummary,
            )
            // Soft-deprecated WRITE-ONLY field: nothing in production source
            // reads it (the reviewer skip reads the reviewReceipts ledger). It
            // is still written so state serialized by this base2 stays
            // round-trip identical for older readers; see its docblock in
            // agents/base2/gate-state.ts for the removal path.
            activeWorkState.reviewedReviewableFingerprint =
              reviewableFingerprint
            activeWorkState.lastReviewerGateSkipReason = ''
            activeWorkState.repairRoundCount = 0
            activeWorkState.repairSessionId = undefined
            activeWorkState.repairEscalationDone = undefined
            activeWorkState.validationInfrastructureBypassFingerprint =
              undefined
            activeWorkState.preEditSecurityReviewDone = false
            activeWorkState.securityReviewGateDone = false
            activeWorkState.reviewerCrashCount = 0
            activeWorkState.reviewerProtocolRetryCount = 0
            activeWorkState.reviewerRepairRoundCount = 0
            activeWorkState.reviewerNoVerdictCount = 0
            // Per-turn specialist budgets are reset for the same reason as the
            // code-reviewer ones: the next edit set must start with a full
            // repair/retry budget instead of inheriting this gate's spend.
            activeWorkState.specialistRepairRoundCount = 0
            activeWorkState.specialistNoVerdictCounts = {}
            activeWorkState.reviewerBypassChallenge = undefined
            activeWorkState.reviewerGateBypassReason = ''
            activeWorkState.testWriterGateDone = false
            activeWorkState.docWriterGateDone = false
            activeWorkState.auxGatesLastPendingFiles = []
            activeWorkStateChanged = true
          }
          if (activeWorkState.nextRequiredAction) {
            activeWorkState.nextRequiredAction = ''
            activeWorkStateChanged = true
          }
          if (activeWorkState.currentPhase !== 'final_response_allowed') {
            activeWorkState.currentPhase = 'final_response_allowed'
            activeWorkStateChanged = true
          }
          if (activeWorkStateChanged) {
            markActiveWorkStateChanged()
          }
          gatePassedForCurrentEdits = passedPendingFiles.length > 0
          finalResponseGateOpen = true
          mutableAgentState.canSuggestFollowups = true
          const validationHooksSkipped =
            validationSummary === 'No configured file-change hooks ran.' ||
            validationSummary ===
              'Configured file-change hooks were skipped because none matched the changed files.'
          const passVerdict = reviewerFinalizationVerdict || 'LOOKS_GOOD'
          // Content verification immediately before the mint, so the ledger this
          // pass republishes (and the ID it prints) cannot carry a receipt whose
          // covered bytes changed earlier in the turn.
          prunePlanTaskGateReceipts()
          // Gate-issued per-task plan validation receipt. Minted ONLY on this
          // FRESH gate-pass emission, and only while a plan task is claimed:
          // this is the only path with a live snapshot base2 just hashed itself.
          // The conversation-reuse and durable-fingerprint-reuse pass paths above
          // `continue` before reaching here and deliberately mint nothing — one
          // review would otherwise keep issuing receipts for several different
          // tasks across turns.
          //
          // Three shapes, so a task whose cycle had no reviewable diff is still
          // completable WITHOUT the receipt overstating its evidence:
          //   - reviewable subset non-empty  -> 'reviewed-diff'     (files = that subset)
          //   - pending files but none reviewable -> 'unreviewed-scope' (files = validated pending set)
          //   - no pending files at all      -> 'no-diff'          (files = [])
          // The 'no-diff' shape must NOT depend on a reviewer verdict: that path
          // reaches this emission with `reviewerFinalizationVerdict` empty, which
          // is exactly why the receipt records `passVerdict`.
          //
          // INVARIANT for every kind:
          // `snapshotFingerprint === hashGateSnapshotDetails(buildGateSnapshotDetails(files, ''))`
          // — content only, empty summary component — so verification is uniform.
          // For 'reviewed-diff' that value IS `reviewSnapshotFingerprint`, the
          // fingerprint base2 computed for THIS review, so the receipt stays bound
          // to the exact reviewed bytes. The id is always derived from that
          // gate-computed fingerprint, NEVER from a reviewer-REPORTED
          // snapshotFingerprint, which the attestation path deliberately
          // drift-tolerates and which would therefore make the receipt forgeable.
          // Same gate-COMPUTED provenance rule as a review receipt's `gateId`.
          //
          // A non-attestable fingerprint mints NOTHING for any kind: a stable
          // `unreadable:*` marker is an error string, not content evidence, so two
          // unrelated snapshots would compare equal under it.
          const claimedPlanTaskId = activeWorkState.activePlanTaskId
          if (
            typeof claimedPlanTaskId === 'string' &&
            claimedPlanTaskId.length > 0
          ) {
            const receiptEvidence =
              reviewableGateScopeFiles.length > 0
                ? 'reviewed-diff'
                : passedPendingFiles.length > 0
                  ? 'unreviewed-scope'
                  : 'no-diff'
            const receiptFiles =
              receiptEvidence === 'reviewed-diff'
                ? [...reviewableGateScopeFiles]
                : receiptEvidence === 'unreviewed-scope'
                  ? [...passedPendingFiles]
                  : []
            const receiptFingerprint =
              receiptEvidence === 'reviewed-diff'
                ? reviewSnapshotFingerprint
                : hashGateSnapshotDetails(
                    buildGateSnapshotDetails(receiptFiles, ''),
                  )
            if (isAttestableSnapshotFingerprint(receiptFingerprint)) {
              // The evidence kind is part of the id for the two non-reviewed
              // kinds, so a receipt that claims no content review can never be
              // mistaken for one that does.
              const receiptKindSegment =
                receiptEvidence === 'reviewed-diff' ? '' : `${receiptEvidence}:`
              const planTaskReceiptId = `plan-gate:${claimedPlanTaskId}:${receiptKindSegment}${receiptFingerprint.slice(0, 16)}`
              const existingPlanTaskReceipts = readPlanTaskGateReceipts(
                activeWorkState.planTaskGateReceipts,
              )
              // Idempotent repeat pass: this task already has a live receipt with
              // the identical id, i.e. the same evidence, so leave it (and its
              // recordedAt) untouched.
              if (
                !existingPlanTaskReceipts.some(
                  (receipt) =>
                    receipt.taskId === claimedPlanTaskId &&
                    receipt.receiptId === planTaskReceiptId,
                )
              ) {
                mintedPlanTaskReceipt = {
                  receiptId: planTaskReceiptId,
                  taskId: claimedPlanTaskId,
                  evidence: receiptEvidence,
                  snapshotFingerprint: receiptFingerprint,
                  files: receiptFiles,
                  validationSummary,
                  reviewerVerdict: passVerdict,
                  recordedAt: new Date().toISOString(),
                }
                // REPLACE, never append, for this task: exactly one receipt is
                // live per task so the printed id is unambiguous. Still bounded
                // to the most recent 24 entries over the remaining tasks, the
                // same convention as reviewReceipts.
                activeWorkState.planTaskGateReceipts = [
                  ...existingPlanTaskReceipts.filter(
                    (receipt) => receipt.taskId !== claimedPlanTaskId,
                  ),
                  mintedPlanTaskReceipt,
                ].slice(-24)
                markActiveWorkStateChanged()
              }
            }
          }
          // Printed on every fresh gate-pass emission whenever a live receipt
          // exists for the claimed task — not only when this pass minted one —
          // because supersession changes the id and the model must always be able
          // to read the CURRENT one. Fully omitted with no claim or no live
          // receipt, so non-plan gate-pass content stays byte-identical.
          const livePlanTaskReceipt =
            mintedPlanTaskReceipt ??
            (typeof claimedPlanTaskId === 'string' &&
            claimedPlanTaskId.length > 0
              ? readPlanTaskGateReceipts(
                  activeWorkState.planTaskGateReceipts,
                ).find((receipt) => receipt.taskId === claimedPlanTaskId)
              : undefined)
          const planTaskReceiptLines = livePlanTaskReceipt
            ? [
                `Plan task ${livePlanTaskReceipt.taskId} gate receipt: ${livePlanTaskReceipt.receiptId}. Pass this exact string in update_plan_status checkpoint.receiptIds when marking ${livePlanTaskReceipt.taskId} done; do not invent a receipt ID.`,
                livePlanTaskReceipt.evidence === 'reviewed-diff'
                  ? `Evidence: reviewed diff over ${livePlanTaskReceipt.files.length} file(s). This receipt is superseded when any covered file changes again; re-read the current ID after the next gate pass.`
                  : livePlanTaskReceipt.evidence === 'unreviewed-scope'
                    ? `Evidence: no reviewable diff in this gate cycle; validation covered ${livePlanTaskReceipt.files.length} non-reviewable file(s). This receipt is superseded as soon as any further change is recorded.`
                    : 'Evidence: no file changes in this gate cycle. This receipt is superseded as soon as any further change is recorded.',
              ]
            : []
          const passDetails =
            passedPendingFiles.length > 0
              ? `reviewer verdict ${passVerdict}; ${validationHooksSkipped ? validationSummary : 'validation hooks ran'}; pending files: ${passedPendingFiles.join(', ')}`
              : `no edited files were detected; reviewer verdict ${passVerdict || 'n/a'}; hooks ran=${!validationHooksSkipped}`
          // Advisories recorded on the receipt for this gate. They never
          // entered openReviewerBlockers (no collector reads them), so the
          // pass block is the only surface that shows them to the user. Read
          // from the durable receipt just written rather than adding state.
          //
          // BOUND to THIS gate's receipt id (`${reviewer}:${fingerprint}`, the
          // gateId recordSuccessfulReviewReceipt writes). reviewReceipts is
          // DURABLE and keeps up to 24 entries across turns and reviewer
          // families, so reading the LAST receipt could surface another
          // family's or an earlier turn's advisories as this gate's (and count
          // them in advisoryCount telemetry). A gate that finalized without a
          // fresh receipt for this snapshot (durable/conversation pass reuse or
          // an authorized bypass) matches none and shows no advisories.
          const passReceiptGateId = `${requiredReviewerAgentType}:${reviewSnapshotFingerprint}`
          const passAdvisories =
            (activeWorkState.reviewReceipts ?? []).find(
              (receipt) => receipt.gateId === passReceiptGateId,
            )?.advisories ?? []
          emitGateTelemetry({
            currentPhase: 'final_response_allowed',
            pendingFileCount: passedPendingFiles.length,
            pendingFiles: passedPendingFiles,
            reviewerStatus:
              passedPendingFiles.length > 0 ? 'passed' : 'skipped',
            validationStatus: validationHooksSkipped ? 'skipped' : 'passed',
            reviewerVerdict: passVerdict,
            hooksRan: !validationHooksSkipped,
            advisoryCount: passAdvisories.length,
          })
          yield {
            toolName: 'add_message',
            input: {
              role: 'user',
              content: [
                passedPendingFiles.length > 0
                  ? validationHooksSkipped
                    ? `Reviewer gate passed with ${passVerdict} for pending files: ${passedPendingFiles.join(', ')}. ${validationSummary}`
                    : `Automated validation and reviewer gate passed with ${passVerdict} for pending files: ${passedPendingFiles.join(', ')}.`
                  : 'No edited files were detected.',
                passedPendingFiles.length > 0
                  ? 'The preceding Change review diff is the user-visible filesystem evidence for this gate. Use /diff for the full current working-tree diff, /changes for the file list, or /diff -- <path> to inspect one file.'
                  : '',
                // Only when a live plan-task receipt exists, so the gate-pass
                // content stays byte-identical for non-plan turns (prompt/gate
                // snapshots and the gate e2e tests pin it). Placed BEFORE the
                // finalization notice so that instruction stays last.
                ...planTaskReceiptLines,
                buildGatePassFinalizationNotice(),
                formatGateStateBlock(
                  'validation/reviewer',
                  'passed',
                  passDetails,
                  undefined,
                  passAdvisories,
                  activeWorkState.workflowTodoProgress,
                ),
              ].join('\n'),
            },
            includeToolCall: false,
          } as any
          if (passedPendingFiles.length > 0) {
            yield {
              toolName: 'git_status',
              input: {
                include_diff: true,
                max_chars: 80_000,
              },
            } as any
          }
          // NOTE: the three aux gates (test-writer / doc-writer /
          // security-reviewer) now run pre-reviewer above, before this final
          // validation+code-reviewer gate. Code-reviewer is the final gate.
          // The pre-reviewer aux spawns write aux-output files (tests, docs),
          // which the next loop iteration re-reads into pendingGateFiles so
          // this final gate also covers their changes — desirable, so the
          // final reviewer covers the full set of edits. (The old R1b/R1c
          // post-gate test-writer + doc-writer spawns have been moved above
          // and subsumed into the unified pre-reviewer aux block.)
          //
          // (Previously here: the full R1b test-writer + R1c doc-writer
          // post-gate blocks, which ran AFTER the gate passed. Removed.)
          continue
        }
        if (editsHappened) {
          const disabledGateReason = configuredPlanOnly
            ? 'plan-only-automatic-finalization-gate-disabled'
            : 'validation-and-reviewer-gates-disabled'
          activeWorkState.lastReviewerGateSkipReason = disabledGateReason
          markActiveWorkStateChanged()
          emitGateTelemetry({
            currentPhase: activeWorkState.currentPhase,
            pendingFileCount: pendingGateFiles.size,
            pendingFiles: Array.from(pendingGateFiles),
            reviewerStatus: 'skipped',
            validationStatus: 'skipped',
            skipReason: disabledGateReason,
          })
          yield {
            toolName: 'add_message',
            input: {
              role: 'user',
              content: [
                configuredPlanOnly
                  ? 'PLAN-only mode disables the automatic validation/reviewer finalization gate; manual reviewer-family analysis remains available.'
                  : 'Validation and reviewer gates are disabled for this agent mode; skipping automated gate checks even though edits were detected.',
                `Pending edited files: ${Array.from(pendingGateFiles).join(', ') || '(unknown files)'}`,
                formatGateStateBlock(
                  'validation/reviewer',
                  'skipped',
                  `${disabledGateReason}: skipped automated gate checks for pending files: ${Array.from(pendingGateFiles).join(', ') || '(unknown files)'}`,
                ),
              ].join('\n'),
            },
            includeToolCall: false,
          } as any
        }
        break
      }
      function markActiveWorkStateChanged(): void {
        activeWorkState.lastPinnedStateMessage = ''
      }

      // Single source of truth for the post-gate finalization instruction used
      // by every gate-pass path (fresh pass, conversation reuse, durable
      // fingerprint reuse). Worded idempotently so a model that already wrote
      // a summary earlier in the turn adds only follow-up suggestions instead
      // of repeating the summary.
      //
      // Inline because handleSteps is serialized via .toString() and
      // reconstructed with new Function(...), so a module-scope binding would
      // be undefined at reconstruction time. It MUST stay a hoisted `function`
      // declaration and never become a `const` arrow: all three call sites
      // appear EARLIER in the source than this declaration, and only a
      // function declaration hoists above them. Reading `activeWorkState` at
      // call time is safe because every call site executes inside the gate
      // loop, long after activeWorkState is initialized.
      //
      // SOFT continuation directive: when the agent declared multi-phase work
      // with write_todos and an incomplete item remains, the notice tells it to
      // keep going in the same turn instead of finalizing, and to state an
      // explicit reason if it stops early. Nothing here hard-blocks
      // finalization — no gate state is read or written, the directive lives
      // entirely in the emitted text. With no incomplete declared work the
      // original notice is returned BYTE-FOR-BYTE, because prompt/gate
      // snapshots and e2e tests pin that exact string.
      function buildGatePassFinalizationNotice(): string {
        const finalizationNotice =
          'Provide your single user-visible completion summary now if you have not already written one this turn; if you already have, add only the follow-up suggestions instead of repeating it. Write at most one completion summary per turn. Call suggest_followups only as the absolute last tool after that summary (and after git-committer if committing this turn); never mid-turn and never before remaining work. Do not make more edits unless absolutely necessary; any new edits will rerun the gate.'
        const progress = activeWorkState.workflowTodoProgress
        const nextWorkflowAction = (progress?.nextWorkflowAction ?? '').trim()
        if (!progress || !nextWorkflowAction) return finalizationNotice
        return [
          `The gate passed for the current edits, but your declared workflow still has remaining items: Completed ${progress.completedCount}/${progress.totalCount}. Next workflow action: ${nextWorkflowAction}`,
          'Default behavior: continue with that next workflow item in this same turn instead of finalizing. The user asked for the whole declared workflow, not just the current wave, so asking permission between your own self-declared waves is redundant while the remaining items are part of the same request.',
          'New edits will re-arm the validation/reviewer gate. That is expected and acceptable for continuing declared work, so a re-armed gate is not a reason to stop.',
          'Finalizing is still permitted. If you stop before the declared workflow is complete you MUST say so explicitly in your completion summary and state the concrete reason (blocked on a decision, needs user input, remaining work is genuinely out of scope, or repeated failure) plus what remains. Silently finalizing with incomplete declared todos is not acceptable.',
          'When you do finalize: provide your single user-visible completion summary now if you have not already written one this turn; if you already have, add only the follow-up suggestions instead of repeating it. Write at most one completion summary per turn. Call suggest_followups only as the absolute last tool after that summary (and after git-committer if committing this turn); never mid-turn and never before remaining work.',
        ].join('\n')
      }

      // Durable one-line mid-turn gate-progress note. Rendered by
      // buildPinnedActiveWorkMessage as a "Gate progress:" line inside the
      // pinned active-work message. When that line is the only change since
      // the last emitted pinned block, the top-of-loop emitter yields a
      // delta-only add_message carrying just `Gate progress: <line>` instead
      // of the full block. Most writes go through this helper (it dedupes so
      // repeated identical updates do not churn the pinned state); the
      // gate-pass path resets the field directly because that reset is never
      // rendered. Self-contained inline helper (handleSteps is serialized via
      // .toString() + new Function(...), so it must not reference module-scope
      // imports).
      function setGateProgress(line: string): void {
        if (activeWorkState.gateProgressLine === line) return
        activeWorkState.gateProgressLine = line
        markActiveWorkStateChanged()
      }

      // T1.2(c) re-review ledger for the reviewer spawn packet. The reviewer is
      // stateless across repair rounds, so without this it re-derives every
      // finding from scratch instead of verifying the ones a repair round
      // already reported as addressed. Returns [] on round 0 so the first
      // review's prompt is byte-identical to the pre-ledger surface, and reads
      // ONLY already-persisted state (openReviewerFindings /
      // reviewerRepairRoundCount) — no new gate state.
      //
      // Findings are filtered to the spawned reviewer's own family:
      // openReviewerFindings can hold security-reviewer and specialist records,
      // and asking the code-reviewer to verify those would take it outside its
      // scope. `finding.text` is rendered VERBATIM (keeping the
      // NON_BLOCKING:/BLOCKING: prefix and any `[id] ` segment) because that is
      // exactly the string the condone matcher compares a re-raise against.
      // Inline because handleSteps is serialized via .toString() +
      // new Function(...), so it must not reference module-scope imports.
      function buildReviewerRoundLedgerLines(reviewer: string): string[] {
        const repairRound = Number(
          activeWorkState.reviewerRepairRoundCount ?? 0,
        )
        if (!(repairRound > 0)) return []
        const lines = [`Repair round: ${repairRound}. This is a re-review.`]
        const ownFindings = (activeWorkState.openReviewerFindings ?? []).filter(
          (finding) => finding.reviewer === reviewer,
        )
        if (ownFindings.length === 0) return lines
        lines.push(
          'Findings raised earlier and reported addressed are listed below. Verify each is genuinely fixed and cite the line that fixes it. If a fix is wrong or incomplete, re-raise the finding with its ORIGINAL text repeated VERBATIM and put your reason on a separate line: the gate matches re-raises by exact text (and by stable finding id when you supplied one), so a reworded re-raise is treated as a brand-new finding and the repair loop cannot converge.',
        )
        const shown = ownFindings.slice(0, 12)
        for (const finding of shown) {
          lines.push(`  - ${finding.text}`)
        }
        if (ownFindings.length > shown.length) {
          lines.push(
            `  - (+${ownFindings.length - shown.length} more earlier findings omitted)`,
          )
        }
        return lines
      }

      // Inline helpers for gate-state telemetry/diagnostics. Kept inside
      // handleSteps because handleSteps is serialized via .toString() and
      // reconstructed with new Function(...), so module-scope closures are
      // not available at reconstruction time. Keep these deterministic and
      // single-line so the CLI can promote them into GateStateBox blocks.
      //
      // PUBLISHED BLOCK SCHEMA emitted by this function (the producer half of
      // the parse contract documented on `parseGateStateBlock` /
      // `GateStateContentBlock` in the CLI): `gate` and `status` are always
      // present; `details` is always present (possibly empty); `repairRound`,
      // `maxRepairRounds`, `advisories`, and `workflow` are optional and
      // additive. `origin` is not emitted — the CLI defaults it to "Base2".
      // Adding a key here REQUIRES updating both published CLI enumerations
      // (cli/src/types/chat.ts and cli/src/utils/message-block-helpers.ts).
      function formatGateStateBlock(
        gate: 'validation' | 'reviewer' | 'validation/reviewer',
        status: 'passed' | 'failed' | 'skipped',
        details: string,
        repairRound?: number,
        advisories?: string[],
        workflow?: {
          completedCount: number
          totalCount: number
          nextWorkflowAction: string
        },
      ): string {
        // Order matters: collapse whitespace FIRST so tabs/newlines/CRs become
        // spaces, then strip the remaining C0/DEL control bytes (ESC, NUL,
        // \x7f, ...). Reviewer-authored text renders verbatim in the CLI's
        // <text> renderer, where a surviving ESC could corrupt or spoof output.
        const normalizedDetails = String(details ?? '')
          .replace(/\s+/g, ' ')
          .replace(/[\x00-\x1f\x7f]/g, '')
          .trim()
        const payload: {
          gate: string
          status: string
          details: string
          repairRound?: number
          maxRepairRounds?: number
          advisories?: string[]
          workflow?: {
            completedCount: number
            totalCount: number
            nextWorkflowAction: string
          }
        } = { gate, status, details: normalizedDetails }
        if (
          typeof repairRound === 'number' &&
          Number.isFinite(repairRound) &&
          repairRound >= 0
        ) {
          payload.repairRound = repairRound
          // Only emit a finite optional cap; unlimited (Infinity) is omitted
          // so JSON stays finite and CLI consumers do not see null/Infinity.
          if (Number.isFinite(MAX_REPAIR_ROUNDS)) {
            payload.maxRepairRounds = MAX_REPAIR_ROUNDS
          }
        }
        // Reviewer advisories: non-blocking observations that no blocker
        // collector reads. Bounded through the shared helper below so this
        // block and the reviewer/security/specialist add_message surfaces stay
        // byte-identical.
        const boundedAdvisories = boundAdvisoryLines(advisories)
        if (boundedAdvisories.length > 0) {
          payload.advisories = boundedAdvisories
        }
        // Declared-workflow observability: the gate-PASS paths pass
        // activeWorkState.workflowTodoProgress here so a turn that finalizes
        // with declared write_todos work outstanding is machine-distinguishable
        // from a genuinely complete one. Bounded (and omitted whole) by the
        // shared helper below; nothing downstream may branch on it.
        const boundedWorkflow = boundWorkflowProgress(workflow)
        if (boundedWorkflow) {
          payload.workflow = boundedWorkflow
        }
        // Delimiter safety: this payload carries reviewer-authored text
        // (`details`, `advisories`), so a literal `</gate-state>` inside it
        // would terminate this tag-delimited block early and every non-greedy
        // downstream reader (the CLI's parseGateStateBlock and this file's own
        // extractGateStateBlocksFromMessage) would silently drop the record.
        // `\/` is a legal JSON string escape, so escaping every `</` keeps the
        // emitted text free of a premature closing delimiter while JSON.parse
        // restores the original bytes — no reader has to loosen its parse.
        return `<gate-state>${JSON.stringify(payload).replace(/<\//g, '<\\/')}</gate-state>`
      }

      // Shared by the <gate-state> emitter and the reviewer/security/specialist
      // add_message paths so every advisory surface applies identical bounds and
      // control-byte stripping. Collapse whitespace FIRST (so tabs/newlines become
      // spaces rather than vanishing), then strip C0/DEL, then cap length, so the
      // 240-char bound describes the text actually shown.
      //
      // `advisories` is an optional additive reviewer output field that only
      // `code-reviewer` declares today, so the security/specialist families read
      // back as an empty list and stay silent until one of them opts in.
      function boundAdvisoryLines(advisories?: string[]): string[] {
        return (advisories ?? [])
          .map((advisory) =>
            String(advisory ?? '')
              .replace(/\s+/g, ' ')
              .replace(/[\x00-\x1f\x7f]/g, '')
              .trim(),
          )
          .filter((advisory) => advisory.length > 0)
          .slice(0, 8)
          .map((advisory) =>
            advisory.length > 240
              ? `${advisory.slice(0, 237).trimEnd()}...`
              : advisory,
          )
      }

      // Declared-workflow progress for the <gate-state> payload. It lives next
      // to boundAdvisoryLines for the same reason: both carry model-authored
      // bytes into the CLI's <text> renderer, so the 240-char cap and the
      // control-byte strip must stay in lockstep across the two fields.
      //
      // Returns undefined — the key is then OMITTED ENTIRELY, never emitted as
      // a partial or zeroed object — unless every condition holds:
      //   - both counts are finite non-negative integers (Number.isInteger
      //     already rejects NaN/Infinity/floats). Corrupt counts would render
      //     nonsense progress math like `3/NaN` in the CLI.
      //   - totalCount > 0. A turn with no declared todos legitimately reports
      //     0/0; that is not "work remains".
      //   - completedCount <= totalCount. An over-count is corrupt state.
      //   - completedCount < totalCount. LOAD-BEARING: emitting on equality
      //     would report a FINISHED workflow as incomplete on every clean
      //     turn, which is precisely the false signal this field exists to
      //     avoid.
      //   - the sanitized action is non-empty. An action that survives
      //     sanitization as '' carries no continuation target.
      //
      // Sanitization ORDER matches the `details` field above and the CLI-side
      // `sanitizeGateStateText`: collapse whitespace FIRST (so tabs/newlines
      // become spaces instead of vanishing), then strip C0/DEL (an unstripped
      // ESC in model-authored text could spoof terminal output), then trim,
      // then cap length so the 240-char bound describes the text actually
      // shown. The parser sanitizes independently because it also reads
      // hand-authored/non-base2 assistant text.
      // Type-only alias, declared so BOTH the parameter and the return
      // annotation stay SIMPLE (bracket-free) tokens.
      // `extractInlineFunctionSource` — which the delimiter-safety test uses to
      // reconstruct this inline helper out of the serialized handleSteps body —
      // cannot walk a return annotation that opens with a leading `|` union:
      // its annotation scan ends at the first whitespace, the body scan then
      // mistakes the union member's `{` for the function body, and the slice is
      // a body-less signature that TypeScript erases as an overload
      // declaration. The helper would then be missing at runtime and every
      // formatGateStateBlock call would throw `boundWorkflowProgress is not
      // defined`. Types are erased before handleSteps is reconstructed, so this
      // alias costs nothing at runtime.
      type BoundedWorkflowProgress = {
        completedCount: number
        totalCount: number
        nextWorkflowAction: string
      }
      function boundWorkflowProgress(
        progress?: BoundedWorkflowProgress,
      ): BoundedWorkflowProgress | undefined {
        if (!progress) return undefined
        const { completedCount, totalCount } = progress
        if (
          !Number.isInteger(completedCount) ||
          !Number.isInteger(totalCount) ||
          completedCount < 0 ||
          totalCount <= 0 ||
          completedCount >= totalCount
        ) {
          return undefined
        }
        const normalizedAction = String(progress.nextWorkflowAction ?? '')
          .replace(/\s+/g, ' ')
          .replace(/[\x00-\x1f\x7f]/g, '')
          .trim()
        if (normalizedAction.length === 0) return undefined
        return {
          completedCount,
          totalCount,
          nextWorkflowAction:
            normalizedAction.length > 240
              ? `${normalizedAction.slice(0, 237).trimEnd()}...`
              : normalizedAction,
        }
      }

      function emitGateTelemetry(payload: Record<string, unknown>): void {
        try {
          const phase = payload.currentPhase
          // Hoisted once: this is serialized handleSteps code, so repeating the
          // cast per control-plane member is pure duplication.
          const controlPlane = (params as any)?.orchestrationControlPlane
          const transition = controlPlane?.transitionBase2Gate
          if (typeof phase === 'string' && typeof transition === 'function') {
            // Own try/catch: base2GateWorkflowV1 THROWS on an illegal
            // transition (e.g. 'repair_loop' from the default 'idle'). Sharing
            // the outer catch would drop both the durable sink line and the
            // console.info line for exactly the event most worth recording, so
            // a rejected phase transition must not suppress telemetry.
            try {
              mutableAgentState.workflowStates ??= {}
              mutableAgentState.workflowStates['base2-gate-v1'] = transition({
                current: mutableAgentState.workflowStates['base2-gate-v1'],
                phase,
              })
            } catch {
              // Leave the previous workflow state in place and still emit below.
            }
          }
          // Built BEFORE the console emit on purpose: both channels must share
          // one payload object, and a runtime without console.info must still
          // reach the sink.
          const safePayload: Record<string, unknown> = {}
          for (const [key, value] of Object.entries(payload)) {
            // `event` is skipped EXPLICITLY, so the discard of a
            // payload-supplied one is visible where it happens rather than
            // implied by the assignment below. Unlike the sink's
            // `droppedPayloadKeys`, this discard is intentionally unreported:
            // every call site here is in-process and supplies no `event`.
            if (key === 'event' || value === undefined) continue
            safePayload[key] = value
          }
          // The sink's discriminator, owned by this emitter the way
          // gate-telemetry.ts owns its authoritative `recordedAt`.
          safePayload.event = 'base2.gate'
          // console.info FIRST, then the durable sink: the sink is injected by
          // the runtime (base2's handleSteps is serialized and cannot import
          // it), so it is absent on older runtimes and in tests that pass no
          // control plane. Emitting the pre-existing log channel first means a
          // throwing recorder falls into the outer catch with the console line
          // already written, so no separate try/catch around `record` is needed
          // to preserve both channels.
          //
          // Its OWN try/catch so the converse holds as well: a payload that is
          // not JSON-serializable (circular reference, BigInt) or a host console
          // that throws costs ONLY the console line, and the durable sink below
          // still receives `safePayload`.
          try {
            if (typeof console?.info === 'function') {
              console.info(JSON.stringify(safePayload))
            }
          } catch {
            // Console channel only; the durable sink emit below still runs.
          }
          const record = controlPlane?.recordGateTelemetry
          if (typeof record === 'function') {
            record(safePayload)
          }
        } catch {
          // Telemetry must never throw or block the loop.
        }
      }

      function inferActiveWorkPhase(
        state: Base2ActiveWorkState,
      ): Base2ActiveWorkPhase {
        if (
          state.openReviewerBlockers.length > 0 ||
          state.nextRequiredAction.trim().length > 0
        ) {
          return 'blocked'
        }
        if (state.pendingGateFiles.length > 0) return 'awaiting_validation'
        return 'idle'
      }

      function reviewerOriginFromGateId(
        gateId: string | undefined,
      ): 'code-reviewer' | 'security-reviewer' {
        return gateId?.startsWith('security-reviewer:')
          ? 'security-reviewer'
          : 'code-reviewer'
      }

      // Classify a requiredReviewerRevalidation marker into the reviewer family
      // that owns its revalidation. Self-contained pure string logic (no
      // module-scope imports) because handleSteps is serialized via
      // .toString() + new Function(...). 'none' means no marker; any non-empty
      // marker that is not the code/security literal is a specialist agent
      // type (fail-closed: a corrupted marker routes to the specialist aux
      // block, never the final code-reviewer block).
      function revalidationFamily(
        marker: string | undefined,
      ): 'code' | 'security' | 'specialist' | 'none' {
        if (!marker) return 'none'
        if (marker === 'code-reviewer') return 'code'
        if (marker === 'security-reviewer') return 'security'
        return 'specialist'
      }

      // Reviewer family that owns an open finding: the authoritative `reviewer`
      // field when present, otherwise the gateId prefix
      // (`${reviewerFamily}:${fingerprint}`) for legacy serialized state.
      // Self-contained pure string logic (no module-scope imports) because
      // handleSteps is serialized via .toString() + new Function(...).
      function reviewerFamilyFromFinding(finding: {
        reviewer?:
          | 'code-reviewer'
          | 'security-reviewer'
          | SpecialistReviewerAgent
        gateId: string
      }): 'code-reviewer' | 'security-reviewer' | SpecialistReviewerAgent {
        if (finding.reviewer) return finding.reviewer
        const originGatePrefix = finding.gateId.split(':')[0]
        return originGatePrefix === 'security-reviewer'
          ? 'security-reviewer'
          : originGatePrefix === 'code-reviewer'
            ? 'code-reviewer'
            : (originGatePrefix as SpecialistReviewerAgent)
      }

      // Owed-set mutators. Every owed-reviewer mutation goes through these so
      // the legacy scalar requiredReviewerRevalidation is re-synced to element 0
      // in exactly one place and can never drift from the set (a drifted
      // specialist marker would leak into the final code-reviewer block).
      // Inline because handleSteps is serialized via .toString() +
      // new Function(...).
      function addOwedReviewer(agent: string): void {
        const owed = (activeWorkState.owedReviewerRevalidations ??= [])
        const family = agent as
          | 'code-reviewer'
          | 'security-reviewer'
          | SpecialistReviewerAgent
        if (!owed.includes(family)) owed.push(family)
        activeWorkState.requiredReviewerRevalidation = owed[0] ?? undefined
      }

      function clearOwedReviewer(agent: string): void {
        const owed = (activeWorkState.owedReviewerRevalidations ??= []).filter(
          (entry) => entry !== agent,
        )
        activeWorkState.owedReviewerRevalidations = owed
        activeWorkState.requiredReviewerRevalidation = owed[0] ?? undefined
      }

      // A specialist counts as done only when it is credited AND its stored
      // credit fingerprint matches the current reviewable snapshot. Legacy
      // state with no stored fingerprint, or a non-attestable sentinel such as
      // 'unreadable:no-crypto', re-reviews (fail closed). Inline because
      // handleSteps is serialized via .toString() + new Function(...).
      function specialistCreditIsFresh(
        agentType: string,
        fingerprint: string,
      ): boolean {
        if (
          !(activeWorkState.specialistReviewGatesDone ?? []).includes(agentType)
        ) {
          return false
        }
        const stored = (activeWorkState.specialistReviewGateFingerprints ?? {})[
          agentType
        ]
        // Legacy state that never stored a fingerprint re-reviews (fail
        // closed). A stored value is compared literally so the loop always
        // converges after one fresh review of the current bytes.
        if (stored === undefined) return false
        return stored === fingerprint
      }

      // T1.5: condoning is keyed on (verdict class, finding identity) rather
      // than finding text alone. Text-only keying strips the
      // NON_BLOCKING/BLOCKING prefix before comparing, so a nit condoned as
      // NON_BLOCKING was silently swallowed when a later review re-raised the
      // SAME text as BLOCKING — an escalation is new information and must
      // reopen the gate. Inline because handleSteps is serialized via
      // .toString() + new Function(...).
      //
      // `*` is the class for a text that carries no verdict prefix. Every gate
      // path now stores the PREFIXED blocker string on its finding records
      // (security/specialist included), so `*` only arises for legacy
      // serialized state; `condonedKeyMatches` deliberately matches `*` against
      // `*` ONLY, because a class-agnostic entry that matched any later class is
      // exactly the escalation swallow this keying exists to close. The single
      // cross-class allowance is DE-ESCALATION: a stored BLOCKING key also
      // condones a NON_BLOCKING re-raise of the same identity (see
      // `condonedKeyMatches`), never the reverse.
      function reviewerVerdictClass(text: string): string {
        if (text.startsWith('BLOCKING:')) return 'BLOCKING'
        if (text.startsWith('NON_BLOCKING:')) return 'NON_BLOCKING'
        return '*'
      }

      // Single strip site for the NON_BLOCKING/BLOCKING verdict prefix. Every
      // condone/telemetry decision keys on (verdict class, stripped text), so
      // the strip must stay in lockstep with `reviewerVerdictClass`; the regex
      // was previously duplicated at ~6 call sites and could drift from it.
      function stripReviewerVerdictPrefix(text: string): string {
        return text.replace(/^(?:NON_BLOCKING|BLOCKING):\s*/, '')
      }

      // Minted ids (buildReviewerFindingId) embed the blocker's POSITION in the
      // round's list, so identical text at a different index yields a different
      // id: they are not a durable identity and must not be keyed on. Only a
      // reviewer-supplied id (T1.3 object findings, contractually stable across
      // rounds) is. The text key carries convergence for the rest.
      function isMintedReviewerFindingId(id: string): boolean {
        return /^RF-\d+-[0-9a-f]{8}$/.test(id)
      }

      function condonedFindingKeysFor(
        verdictClass: string,
        strippedText: string,
        id?: string,
      ): string[] {
        const keys = [`${verdictClass}::text:${strippedText}`]
        if (id && !isMintedReviewerFindingId(id)) {
          keys.push(`${verdictClass}::id:${id}`)
        }
        return keys
      }

      function condonedKeyMatches(
        condonedKeys: Set<string>,
        verdictClass: string,
        strippedText: string,
        id?: string,
      ): boolean {
        // Same-class match first: a `*` (prefix-less, legacy) entry condones
        // only another `*` finding, and a NON_BLOCKING entry never condones a
        // BLOCKING re-raise of the same identity — an escalation is new
        // information and must reopen the gate.
        if (
          condonedFindingKeysFor(verdictClass, strippedText, id).some((key) =>
            condonedKeys.has(key),
          )
        ) {
          return true
        }
        // DE-ESCALATION, accepted ONE-DIRECTIONALLY: a finding already reported
        // as addressed at BLOCKING and re-raised as a NON_BLOCKING nit carries
        // no new information. Without this, blockers stay non-empty, another
        // repair-editor is spawned, and the already-applied repair trips the
        // no-progress guard, parking the gate in 'blocked' instead of
        // converging. The reverse direction is NOT accepted: only the same-class
        // check above can condone a BLOCKING re-raise.
        if (verdictClass === 'NON_BLOCKING') {
          return condonedFindingKeysFor('BLOCKING', strippedText, id).some(
            (key) => condonedKeys.has(key),
          )
        }
        return false
      }

      // Single owner of the pre-T1.5 legacy text fallback, consulted only while
      // no (verdict class, identity) keys exist. The gate blocker filter, the
      // condoned-pass cleanup, and mergeReviewerFindings.isCondoned all route
      // through this helper so state serialized before `condonedFindingKeys`
      // existed behaves IDENTICALLY at all three sites: a legacy entry may have
      // been recorded either stripped or as the raw prefixed blocker, so both
      // shapes match.
      function legacyCondonedTextMatches(
        condonedTexts: Set<string>,
        text: string,
      ): boolean {
        return (
          condonedTexts.has(stripReviewerVerdictPrefix(text)) ||
          condonedTexts.has(text)
        )
      }

      // Bound the durable condone lists the way `reviewReceipts` is bounded.
      // Each round can append up to 2 keys per suppressed finding plus one entry
      // per repair-addressed finding, and both lists reset only on gate pass, so
      // with default-unlimited repair rounds they would otherwise grow without
      // bound inside serialized base2ActiveWork. Keeping the MOST RECENT entries
      // preserves convergence for the findings the current rounds re-raise.
      function boundCondonedEntries(values: string[]): string[] {
        return Array.from(new Set(values)).slice(-200)
      }

      // Merge one reviewer's blocking output into the open finding ledger
      // WITHOUT clobbering another reviewer's still-open findings. Blocker
      // strings carry no reviewer field, so the retained blocker set is the
      // existing blockers minus the ones matching this reviewer's previous
      // finding texts. The record shape (id/gateId/snapshotFingerprint/
      // reviewer/createdAt) is produced by the caller so receipt reconciliation
      // (findingsAddressed.includes(id)) keeps matching. Inline because
      // handleSteps is serialized via .toString() + new Function(...).
      function mergeReviewerFindings(
        reviewer: string,
        records: NonNullable<Base2ActiveWorkState['openReviewerFindings']>,
        blockers: string[],
      ): void {
        // Condoned-status override: an incoming record whose finding identity
        // was already reported as addressed by a prior repair round is recorded
        // as 'condoned' instead of 'open' so it neither blocks finalization nor
        // re-triggers a repair spawn. Applies uniformly to every caller. Keyed
        // on (verdict class, identity) like the gate's own condone filter, so a
        // re-raised-at-HIGHER-class finding stays 'open' while a de-escalated
        // re-raise stays 'condoned'; the legacy text list is consulted only
        // while no keys exist (pre-T1.5 serialized state), through the shared
        // `legacyCondonedTextMatches` helper so all three call sites agree.
        const condonedKeys: Set<string> = new Set<string>(
          activeWorkState.condonedFindingKeys ?? [],
        )
        const condonedTexts: Set<string> = new Set<string>(
          activeWorkState.condonedFindingTexts ?? [],
        )
        const isCondoned = (record: { text: string; id: string }): boolean => {
          if (condonedKeys.size > 0) {
            return condonedKeyMatches(
              condonedKeys,
              reviewerVerdictClass(record.text),
              stripReviewerVerdictPrefix(record.text),
              record.id,
            )
          }
          return legacyCondonedTextMatches(condonedTexts, record.text)
        }
        const mergedRecords = records.map((record) =>
          isCondoned(record)
            ? { ...record, status: 'condoned' as const }
            : record,
        )
        const existingFindings = activeWorkState.openReviewerFindings ?? []
        const previousOwnFindings = existingFindings.filter(
          (finding) => finding.reviewer === reviewer,
        )
        const retainedFindings = existingFindings.filter(
          (finding) => finding.reviewer !== reviewer,
        )
        const retainedBlockers = (
          activeWorkState.openReviewerBlockers ?? []
        ).filter(
          (blocker) =>
            !previousOwnFindings.some(
              (finding) => finding.text && blocker.includes(finding.text),
            ),
        )
        activeWorkState.openReviewerFindings = [
          ...retainedFindings,
          ...mergedRecords,
        ]
        activeWorkState.openReviewerBlockers = Array.from(
          new Set([...retainedBlockers, ...blockers]),
        )
      }

      // <gate-helpers-generated> DO NOT EDIT — regenerate via: bun run scripts/generate-gate-helpers.ts
/**
 * Pure gate path / set helpers extracted from `base2.ts`.
 *
 * NOTE: equivalent inline copies of these helpers still exist inside
 * `createBase2`'s `handleSteps` generator because that function is
 * serialized via `handleSteps.toString()` and reconstructed with
 * `new Function(...)`. Reconstructed functions lose their module
 * closure, so they cannot reference imports from this file. Keep the
 * two implementations in sync.
 */
function normalizeGateFilePath(file: string): string {
    let normalized = file.trim().replace(/\\/g, '/');
    if (!normalized)
        return '';
    // Reject path traversal: a gate file path must stay inside the project.
    // Any `..` segment (posix or windows, since backslashes were normalized to
    // forward slashes above) is rejected before normalization so it can't be
    // used to point the gate at files outside the cwd.
    if (normalized.split('/').includes('..')) {
        return '';
    }
    if (normalized.startsWith('file://')) {
        normalized = normalized.slice('file://'.length);
    }
    if (/^\/[A-Za-z]:\//.test(normalized)) {
        normalized = normalized.slice(1);
    }
    const cwd = typeof process === 'object' &&
        process !== null &&
        typeof process.cwd === 'function'
        ? process.cwd().replace(/\\/g, '/').replace(/\/+$/, '')
        : '';
    const isAbsolute = normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized);
    if (isAbsolute &&
        (!cwd || (normalized !== cwd && !normalized.startsWith(`${cwd}/`)))) {
        return '';
    }
    if (cwd && (normalized === cwd || normalized.startsWith(`${cwd}/`))) {
        normalized = normalized.slice(cwd.length).replace(/^\/+/, '');
    }
    while (normalized.startsWith('./')) {
        normalized = normalized.slice(2);
    }
    return normalized.trim();
}

function normalizeGateFileList(files: string[]): string[] {
    const normalizedFiles: string[] = [];
    const seen = new Set<string>();
    for (const file of files) {
        const normalized = normalizeGateFilePath(file);
        if (!normalized || seen.has(normalized))
            continue;
        seen.add(normalized);
        normalizedFiles.push(normalized);
    }
    return normalizedFiles;
}

function gateFileSetsEqual(left: string[], right: string[]): boolean {
    if (left.length !== right.length)
        return false;
    const rightFiles = new Set(right);
    return left.every((file) => rightFiles.has(file));
}

// Returns true for reviewable source and test files. Generated code, docs,
// config/data files (including .jsonl bookkeeping like EVENTS.jsonl), .env
// files, and anything under docs/, evals/, or .agents/ remain excluded so the
// final code-reviewer gate never attests to bookkeeping/docs/plan artifacts.
// Operates on an already-normalized path (caller normalizes).
function isReviewableGateFile(filePath: string): boolean {
    if (/\.generated\.tsx?$/.test(filePath))
        return false;
    if (/\.(md|mdx|json|jsonl|yml|yaml|toml)$/.test(filePath))
        return false;
    if (/(^|\/)\.env($|\.)/.test(filePath))
        return false;
    if (filePath.startsWith('docs/'))
        return false;
    if (filePath.startsWith('evals/') || filePath.startsWith('.agents/')) {
        return false;
    }
    return /\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|kts|cs|fs|vb)$/.test(filePath);
}

function selectReviewableGateFiles(files: string[]): string[] {
    const reviewableFiles: string[] = [];
    const seen = new Set<string>();
    for (const file of files) {
        const normalized = normalizeGateFilePath(file);
        if (!normalized || seen.has(normalized))
            continue;
        if (!isReviewableGateFile(normalized))
            continue;
        seen.add(normalized);
        reviewableFiles.push(normalized);
    }
    return reviewableFiles;
}

// Co-changed test files remain identifiable for coverage-specific prompting,
// but they are also first-class reviewable files and participate in the final
// reviewer fingerprint and reviewedFiles attestation.
function isCoverageEvidenceFile(filePath: string): boolean {
    if (/__tests__\//.test(filePath))
        return true;
    if (/\.(test|spec)\.(?:tsx?|jsx?|mjs|cjs)$/.test(filePath))
        return true;
    return false;
}

function selectCoverageEvidenceFiles(files: string[]): string[] {
    const evidenceFiles: string[] = [];
    const seen = new Set<string>();
    for (const file of files) {
        const normalized = normalizeGateFilePath(file);
        if (!normalized || seen.has(normalized))
            continue;
        if (!isCoverageEvidenceFile(normalized))
            continue;
        seen.add(normalized);
        evidenceFiles.push(normalized);
    }
    return evidenceFiles;
}

type ReviewerStructuredVerdict = 'LOOKS_GOOD' | 'NON_BLOCKING' | 'BLOCKING';

/** Only LOOKS_GOOD unlocks finalization; empty string is fail-closed. */
type ReviewerFinalizationVerdict = 'LOOKS_GOOD' | '';

type ReviewerCoverage = 'covered' | 'missing' | 'n/a';

type StructuredReviewerOutput = {
    verdict: ReviewerStructuredVerdict;
    findings: string[];
    advisories?: string[];
    coverage?: ReviewerCoverage;
    dimensions?: Record<string, string>;
    requirementCoverage?: Array<{
        requirement: string;
        status: string;
        evidence: string[];
    }>;
    snapshotFingerprint?: string;
    reviewedFiles?: string[];
    schemaVersion?: number;
    findingRecords?: ReviewerFindingRecord[];
};

type ReviewerFindingRecord = {
    id: string;
    text: string;
    severity?: string;
    dimension?: string;
    evidence: string[];
    correction?: string;
};

function collectReviewerFindingRecords(toolResult: unknown): ReviewerFindingRecord[] {
    // Nested spawn/set_output wrappers can surface the same receipt twice; keep
    // the FIRST record per id so `correlateReviewerFindingRecord` never sees
    // duplicates (`collectReviewerBlockers` de-dupes its strings the same way).
    const seen = new Set<string>();
    const records: ReviewerFindingRecord[] = [];
    for (const entry of collectStructuredReviewerOutputs(toolResult)) {
        for (const record of entry.findingRecords ?? []) {
            if (seen.has(record.id))
                continue;
            seen.add(record.id);
            records.push(record);
        }
    }
    return records;
}

/**
 * Advisory observations from the LAST `schemaVersion`-shaped structured reviewer
 * entry (the receipt the gate records). Recorded and displayed only: no blocker
 * collector reads them, so an advisory never blocks and never re-enters the
 * repair loop.
 *
 * Entry selection matches `resolveReviewerAttestation`'s shaped narrowing for
 * the same reason: a reviewer that QUOTES the documented example receipt AFTER
 * its real one must not have the example's advisories persisted and displayed as
 * this review's. With no shaped entry at all the LAST entry is read verbatim,
 * matching that helper's fallback.
 *
 * Non-test consumer: base2's `recordSuccessfulReviewReceipt` builds the durable
 * receipt's `advisories` with this collector at runtime through the
 * `<gate-helpers-generated>` copy emitted from this module, so the PERSISTED
 * advisory semantics (last shaped entry, trimmed, exact-duplicate-free) are the
 * tested ones instead of a second inline read of `result.advisories`.
 *
 * Reviewer-family symmetry: `advisories` is an OPTIONAL additive output field.
 * Only code-reviewer declares it today; a family that omits it (security
 * reviewer, routed specialists) reads back here as no advisories, so no other
 * reviewer schema has to migrate and an older receipt keeps round-tripping.
 *
 * Advisory text is returned verbatim (trimmed only). Delimiter safety lives at
 * the emitter: base2's `formatGateStateBlock` escapes `</` as `<\/` (a legal
 * JSON string escape) before writing the tag-delimited `<gate-state>` block, so
 * an advisory quoting the literal `</gate-state>` cannot truncate that block for
 * the CLI renderer or base2's own conversation-gate-reuse reader.
 */
function collectReviewerAdvisories(toolResult: unknown): string[] {
    const structured = collectStructuredReviewerOutputs(toolResult);
    const shaped = structured.filter((entry) => entry.schemaVersion !== undefined);
    const candidates = shaped.length > 0 ? shaped : structured;
    const last = candidates[candidates.length - 1];
    return dedupeExactStringsPreserveOrder(last?.advisories ?? []);
}

/** True when `value` is a canonical attestable `v3:<64 hex>` snapshot fingerprint. */
function isAttestableV3Fingerprint(value: unknown): value is string {
    return typeof value === 'string' && isAttestableSnapshotFingerprint(value);
}

/** The attestation fields `collectReviewerAttestationIssues` reads. */
type ResolvedReviewerAttestation = {
    schemaVersion?: number;
    snapshotFingerprint?: string;
    reviewedFiles: string[];
};

/**
 * The attestation a receipt is read from, resolved ORDER-INDEPENDENTLY across
 * its `schemaVersion`-carrying (`shaped`) entries, so a quoted example on
 * EITHER side of the real receipt cannot steal the attestation and turn a
 * well-behaved review into spurious fingerprint/coverage blockers (a terminal
 * gate failure after base2's single `reviewer-protocol-attestation-failed`
 * retry). `collectReviewerAttestationIssues` already requires the shaped
 * verdicts to agree, so they describe ONE review.
 *
 * CANONICAL WHY for the entry selection; call sites carry pointers only.
 *
 * Resolution is PER FIELD, so the result is a COMPOSITE rather than one entry:
 * `reviewedFiles` is the UNION of the shaped entries, `snapshotFingerprint` is
 * the entry reporting `expectedFingerprint` else the first reporting an
 * attestable v3 fingerprint else undefined, and `schemaVersion` is 1 only when
 * EVERY shaped entry reports 1 (otherwise the first non-conforming version, so
 * the caller's `!== 1` check rejects the whole receipt).
 *
 * ACCEPTED LOOSENING (pinned in agents/__tests__/gate-reviewer.test.ts): the
 * spliced fields let a quoted example entry supply the fingerprint for a real
 * entry that reported none, and — because the union is NOT restricted to the
 * entry that contributed the credited fingerprint — a quoted example whose
 * `reviewedFiles` path COLLIDES with a real pending path (the documented
 * example literally shows `reviewedFiles: ["src/a.ts"]`) credits coverage the
 * real entry never attested. Narrowing the union would not close the
 * fingerprint half and WOULD reject the deletions-only receipt, which
 * legitimately attests with an empty `reviewedFiles`. So the guarantee is the
 * weaker one: a pending file NO entry reported at all still blocks.
 *
 * With no shaped entry at all the LAST entry is read verbatim, so a receipt that
 * never attested still fails closed on the caller's schemaVersion check.
 *
 * CALLER PRECONDITION: `structured` is non-empty.
 */
function resolveReviewerAttestation(structured: StructuredReviewerOutput[], expectedFingerprint: string): ResolvedReviewerAttestation {
    const shaped = structured.filter((entry) => entry.schemaVersion !== undefined);
    if (shaped.length === 0) {
        const last = structured[structured.length - 1];
        return {
            schemaVersion: last.schemaVersion,
            snapshotFingerprint: last.snapshotFingerprint,
            reviewedFiles: last.reviewedFiles ?? [],
        };
    }
    let matching: StructuredReviewerOutput | undefined;
    let attestable: StructuredReviewerOutput | undefined;
    for (const entry of shaped) {
        const fingerprint = entry.snapshotFingerprint ?? '';
        if (fingerprint.length === 0)
            continue;
        if (fingerprint === expectedFingerprint) {
            matching = entry;
            break;
        }
        if (attestable === undefined && isAttestableV3Fingerprint(fingerprint)) {
            attestable = entry;
        }
    }
    const attesting = matching ?? attestable;
    const reviewedFiles: string[] = [];
    for (const entry of shaped) {
        for (const file of entry.reviewedFiles ?? [])
            reviewedFiles.push(file);
    }
    // Surfacing the FIRST non-conforming version (instead of the attesting
    // entry's) is what makes the caller's `!== 1` check reject a receipt whose
    // sibling entry claims another schema version.
    const nonConforming = shaped.find((entry) => entry.schemaVersion !== 1);
    return {
        schemaVersion: nonConforming?.schemaVersion ?? 1,
        snapshotFingerprint: attesting?.snapshotFingerprint,
        reviewedFiles,
    };
}

function collectReviewerAttestationIssues(toolResult: unknown, expectedFingerprint: string, pendingFiles: string[], deletedFiles?: string[]): string[] {
    // The caller passes the reviewable subset; when it is empty there is
    // nothing to attest, so surface no attestation issues.
    if (pendingFiles.length === 0) {
        return [];
    }
    const structured = collectStructuredReviewerOutputs(toolResult);
    if (structured.length === 0) {
        return [
            'BLOCKING: reviewer did not return the required structured snapshot attestation',
        ];
    }
    // CONFLICT CHECK (fail closed): a result carrying several receipts (e.g. a
    // nested spawn plus set_output) could otherwise be attested from one entry
    // while finalization credit came from another, so shaped entries that
    // disagree on the verdict are rejected outright. Unshaped entries stay out:
    // a QUOTED verdict-shaped example would otherwise park the gate in `blocked`
    // (the UNNARROWED blocker collectors still elevate one into a repair round).
    // Entry selection: see `resolveReviewerAttestation`.
    const verdicts = new Set(structured
        .filter((entry) => entry.schemaVersion !== undefined)
        .map((entry) => entry.verdict));
    if (verdicts.size > 1) {
        return [
            'BLOCKING: reviewer returned conflicting structured verdicts in one result',
        ];
    }
    const result = resolveReviewerAttestation(structured, expectedFingerprint);
    // 1 only when EVERY shaped entry conforms (see `resolveReviewerAttestation`).
    if (result.schemaVersion !== 1) {
        return ['BLOCKING: reviewer returned an invalid attestation schemaVersion'];
    }
    const reviewed = new Set(result.reviewedFiles
        .map((file) => normalizeGateFilePath(file))
        .filter((file) => file.length > 0));
    // Files deleted in the changeset carry a `missing` content marker and cannot
    // be read by the reviewer, so they are attested-by-absence and excluded from
    // the missing computation. Genuinely-modified pending files still must be
    // attested, and a changeset of ONLY deletions still requires an attestable
    // fingerprint via the fail-closed check below.
    const deleted = new Set((deletedFiles ?? [])
        .map((file) => normalizeGateFilePath(file))
        .filter((file) => file.length > 0));
    const missing = pendingFiles
        .map((file) => normalizeGateFilePath(file))
        .filter((file) => file.length > 0 && !reviewed.has(file) && !deleted.has(file));
    const issues: string[] = [];
    // Fingerprint tolerance: a coverage-complete review reporting a well-formed
    // v3 fingerprint is trusted even when the exact snapshot id advanced between
    // its spawn and attestation; only a FILE-COVERAGE gap or a missing /
    // non-attestable fingerprint stays a hard blocker. The tolerance is not
    // silent — every base2 caller records the drift via
    // `collectReviewerFingerprintDrift`, whose docblock carries the rationale.
    const reportedFingerprint = result.snapshotFingerprint;
    const fingerprintIsAttestable = isAttestableV3Fingerprint(reportedFingerprint);
    if (!fingerprintIsAttestable) {
        // A missing / non-attestable fingerprint is never creditable, so report
        // THAT instead of mislabelling an absent fingerprint as a mismatch. Both
        // branches stay fail-closed; only the operator message differs.
        issues.push('BLOCKING: reviewer did not report an attestable snapshot fingerprint');
    }
    else if (reportedFingerprint !== expectedFingerprint &&
        missing.length > 0) {
        issues.push('BLOCKING: reviewer snapshot fingerprint did not match the reviewed working tree');
    }
    if (missing.length > 0) {
        issues.push(`BLOCKING: reviewer did not attest to every pending file: ${missing.join(', ')}`);
    }
    return issues;
}

/**
 * The reported v3 snapshot fingerprint when a review echoed a well-formed
 * fingerprint that does NOT match the expected snapshot, else ''.
 *
 * CALLER PRECONDITION: only call this for a review whose
 * `collectReviewerAttestationIssues` came back clean. That check — not this
 * function — is what establishes coverage-completeness (every pending file
 * attested) and verdict agreement across the structured entries. This function
 * inspects only the resolved attestation (the same one
 * `collectReviewerAttestationIssues` reads, via `resolveReviewerAttestation`)
 * and reports any well-formed non-matching v3 value, including one from a
 * receipt with a file-coverage gap, so a caller that skips the attestation
 * guard would report drift for a review that is already hard-blocked. Both
 * base2 gate families guard correctly for reviews that reached attestation:
 * the final code-reviewer gate and the routed specialist gates.
 *
 * CRASH-PATH EXEMPTION: a caller that forces `attestationIssues` to `[]`
 * because `detectReviewerCrash` fired never ran attestation at all, and is
 * exempt from the precondition. A crashed result normally carries no structured
 * entry, so this function returns ''; if one does carry a drifted fingerprint,
 * the resulting record is telemetry-only and credits the review with nothing —
 * the gate still treats it as a crash.
 *
 * `collectReviewerAttestationIssues` deliberately tolerates that drift so an
 * unrelated bundle bump cannot fail the gate; callers use this to RECORD the
 * drift instead of accepting it silently, because a review of stale file
 * content would otherwise pass the gate with no trace. '' means there is
 * nothing to record: an exact match, or a missing/non-attestable fingerprint
 * (both already hard blockers in the attestation issues).
 */
function collectReviewerFingerprintDrift(toolResult: unknown, expectedFingerprint: string): string {
    const structured = collectStructuredReviewerOutputs(toolResult);
    if (structured.length === 0)
        return '';
    const reported = resolveReviewerAttestation(structured, expectedFingerprint).snapshotFingerprint;
    if (!isAttestableV3Fingerprint(reported))
        return '';
    return reported === expectedFingerprint ? '' : reported;
}

function stripReviewerPreamble(text: string): string {
    let remaining = text.trim();
    // Tolerate reviewers that still emit a closed leading <think>...</think>
    // block (or several) plus surrounding whitespace before the verdict label.
    while (true) {
        const match = remaining.match(/^<think\b[^>]*>[\s\S]*?<\/think>\s*/i);
        if (!match)
            break;
        remaining = remaining.slice(match[0].length).trim();
    }
    return remaining;
}

/** True when a blocker is a pure test-coverage gap (all-coverage sets route to test-writer). */
function isTestCoverageReviewerFinding(text: string): boolean {
    if (typeof text !== 'string')
        return false;
    const t = text.toLowerCase();
    if (t.includes('test coverage'))
        return true;
    if (t.includes('coverage') && /\.test\.[a-z0-9]+/.test(t))
        return true;
    return false;
}

/**
 * Process/orchestrator work a source specialist or code reviewer cannot satisfy
 * from diff/source evidence. Keep patterns specific so real source requirements
 * that merely mention "commit" or "validation" are not suppressed.
 *
 * Evidence is consulted ONLY for explicit ownership assertions (`parent must
 * <process verb>`, `parent/operator`, ...). Every process cue must appear in
 * the REQUIREMENT text: a reviewer that merely QUOTES process prose as
 * evidence (e.g. `evidence: ['spec section: commit and push']` for "preserve
 * CLI compatibility") would otherwise convert a genuine in-scope requirement
 * gap into a credited LOOKS_GOOD with no surviving repair target.
 */
function isParentOwnedOrOutOfScopeRequirement(requirement: string, evidence?: string[]): boolean {
    if (typeof requirement !== 'string')
        return false;
    // Process cues are read from the requirement text only (see above).
    const requirementText = requirement.toLowerCase();
    // Ownership assertions are honored from the requirement text or evidence.
    const ownershipText = [requirement, ...(evidence ?? [])]
        .filter((part): part is string => typeof part === 'string')
        .join('\n')
        .toLowerCase();
    if (!ownershipText.trim())
        return false;
    if (/\brewrite\b[^.\n]{0,40}\bgit\b[^.\n]{0,40}\bcommit(?:\s+messages?)?\b/.test(requirementText) ||
        /\bamend\b[^.\n]{0,40}\bgit\b[^.\n]{0,40}\bcommit(?:\s+messages?|\s+history)?\b/.test(requirementText) ||
        /\brewrite\b[^.\n]{0,40}\bcommit\s+messages?\b/.test(requirementText) ||
        /\bamend\b[^.\n]{0,40}\bcommit\s+(?:messages?|history)\b/.test(requirementText)) {
        return true;
    }
    // Only the full validation gate / CI process step is parent-owned.
    // Source requirements like "run validation of the new API" stay in-scope.
    if (/\brun\b[^.\n]{0,24}\bfull\s+validation(?:\s+gate)?\b/.test(requirementText)) {
        return true;
    }
    // Repository push only: domain text like "push changes to subscribers" is
    // in-scope work, so a process push must name a repository target.
    if (/\bcommit\s+and\s+push\b/.test(requirementText) ||
        /\bpush\s+(?:the\s+)?changes\s+(?:upstream|to\s+(?:origin|remote|the\s+remote|the\s+upstream|the\s+branch))\b/.test(requirementText)) {
        return true;
    }
    if (/\bconfirm\b[^.\n]{0,24}\bci\/?cd\b[^.\n]{0,24}\bgreen\b/.test(requirementText) ||
        /\bcheck\b[^.\n]{0,24}\bci(?:\/?cd)?\b[^.\n]{0,24}\bgreen\b/.test(requirementText)) {
        return true;
    }
    // `parent must <process verb>` only: "the parent must be validated before
    // insert" is domain text, not a handoff of process work. These are ownership
    // assertions, so reviewer evidence may establish them.
    if (/\bparent\s+must\s+(?:also\s+|then\s+)?(?:run|commit|push|amend|rewrite|confirm|merge|deploy|release|revalidate)\b/.test(ownershipText) ||
        /\bparent\/?operator\b/.test(ownershipText) ||
        /\bnot\s+performed\s+by\s+this\s+specialist\b/.test(ownershipText) ||
        /\bspecialist\s+contract\s+forbids\s+basher\b/.test(ownershipText)) {
        return true;
    }
    return false;
}

/**
 * The subset of `blockers` that are only parent-owned requirementCoverage gaps.
 *
 * Classification: the structured `requirementCoverage` row whose
 * `${status}\n${requirement}` matches the blocker decides via
 * `isParentOwnedOrOutOfScopeRequirement` (requirement text + evidence), with
 * the requirement text alone as the fallback when no row matches. The
 * structured reviewer outputs are collected once per CALL, covering the whole
 * blocker list; that is a readability convenience rather than a material
 * saving, because every other gate collector (blockers, hard blockers,
 * finalization verdict, finding records, attestation issues, fingerprint drift)
 * re-walks the same reviewer result, and `visitForStructuredVerdict`'s depth-8
 * cap is what bounds the cost.
 */
function collectParentOwnedRequirementBlockers(blockers: string[], toolResult?: unknown): Set<string> {
    // Structured requirement rows keyed by `${status}\n${requirement.trim()}`;
    // the value is true only when EVERY row with that key is parent-owned once
    // its evidence is taken into account. The key is trimmed because the blocker
    // string carries the RAW requirement text and the lookup below trims it.
    const structuredRows = new Map<string, boolean>();
    if (toolResult !== undefined) {
        for (const entry of collectStructuredReviewerOutputs(toolResult)) {
            for (const requirement of entry.requirementCoverage ?? []) {
                const key = `${requirement.status}\n${requirement.requirement.trim()}`;
                const parentOwnedRow = isParentOwnedOrOutOfScopeRequirement(requirement.requirement, requirement.evidence);
                // In-scope precedence: getReviewerFinalizationVerdict blocks when ANY
                // matching row is in-scope, so an in-scope row must overwrite a
                // parent-owned row with the same status+text key. Otherwise the blocker
                // would be filtered out while the verdict stayed '', closing the gate
                // with no surviving repair target.
                if (!parentOwnedRow || !structuredRows.has(key)) {
                    structuredRows.set(key, parentOwnedRow);
                }
            }
        }
    }
    const parentOwnedBlockers = new Set<string>();
    for (const blocker of blockers) {
        if (typeof blocker !== 'string')
            continue;
        // `[\s\S]` (not `.`) so a multi-line requirement text is still parsed
        // instead of skipped into text-only classification.
        const match = blocker.match(/^BLOCKING:\s*requirement\s+(missing|uncertain):\s*([\s\S]+)$/i);
        if (!match)
            continue;
        // `status` comes from the regex above, so it is already 'missing' or
        // 'uncertain'; the row status is part of the key, so a row for the same
        // requirement with a different status never matches.
        const status = match[1].toLowerCase();
        const requirementText = match[2].trim();
        const structuredRow = structuredRows.get(`${status}\n${requirementText}`);
        if (structuredRow === undefined) {
            // No structured row matched: classify from the requirement text alone.
            if (isParentOwnedOrOutOfScopeRequirement(requirementText)) {
                parentOwnedBlockers.add(blocker);
            }
            continue;
        }
        // Structured row(s) matched: trust evidence-aware classification only.
        if (structuredRow)
            parentOwnedBlockers.add(blocker);
    }
    return parentOwnedBlockers;
}

function dedupeExactStringsPreserveOrder(values: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
        if (seen.has(value))
            continue;
        seen.add(value);
        out.push(value);
    }
    return out;
}

/**
 * Every blocker string a reviewer result implies: BLOCKING prose findings,
 * gate-derived hard rules (coverage missing, failed dimension, in-scope
 * requirement missing/uncertain), NON_BLOCKING prose findings, and the
 * synthetic empty-findings NON_BLOCKING placeholder.
 *
 * SYNC CONTRACT: the gate-derived hard-rule strings emitted here must stay
 * byte-identical to the ones `collectReviewerHardBlockers` emits — base2's
 * condone filter exempts hard rules via exact `Set.has` membership across the
 * two collectors. The two functions are deliberately independent (so this
 * function's byte output cannot shift); `agents/__tests__/gate-reviewer.test.ts`
 * asserts the parity.
 */
function collectReviewerBlockers(toolResult: unknown): string[] {
    // First check for structured reviewer outputs (e.g. JSON with a
    // verdict field). BLOCKING and NON_BLOCKING both surface repair targets;
    // only LOOKS_GOOD finalizes (via getReviewerFinalizationVerdict).
    const structured = collectStructuredReviewerOutputs(toolResult);
    const structuredBlockers: string[] = [];
    for (const entry of structured) {
        if (entry.verdict === 'BLOCKING') {
            const findings = entry.findings.length > 0 ? entry.findings : ['(no findings provided)'];
            for (const finding of findings) {
                structuredBlockers.push(`BLOCKING: ${finding}`);
            }
        }
        // Coverage-adequacy / dimension / requirement hard blockers first so we
        // know whether an empty NON_BLOCKING receipt already has repair fuel.
        // Parent-owned requirement rows are deliberately NOT counted as repair
        // fuel: every gate call site filters them away again, so counting them
        // would suppress the synthetic placeholder below and leave the consumer
        // with an empty blocker list — no repair target, no condoned pass, and a
        // misdiagnosed "reviewer ran but returned no structured output" loop.
        let entryHasHardBlocker = false;
        // Coverage-adequacy contract (M6.3): missing test coverage for a
        // behavior-changing edit is BLOCKING regardless of the text verdict.
        if (entry.coverage === 'missing') {
            structuredBlockers.push('BLOCKING: test coverage missing for changed behavior (add a case to the relevant *.test.ts)');
            entryHasHardBlocker = true;
        }
        // Reviewer dimensions follow the contract's "<word>: <clause>" style, so a
        // blocking dimension arrives as `block: <clause>` (or `blocks:` /
        // `blocking:` / `blocker(s):`). Match the leading word only: `blocked` is a
        // different word (a state, not a verdict) and must NOT count as failing.
        for (const [dimension, status] of Object.entries(entry.dimensions ?? {})) {
            if (/^block(?:s|ing|er|ers)?\b/.test(status.trim().toLowerCase())) {
                structuredBlockers.push(`BLOCKING: ${dimension} review dimension failed`);
                entryHasHardBlocker = true;
            }
        }
        // Keep parent-owned process requirement gaps in the raw blocker list so
        // consumers can credit LOOKS_GOOD via parentOwnedOnlyBlockers (filter at
        // the call site; do not filter or elevate them here).
        for (const requirement of entry.requirementCoverage ?? []) {
            if (requirement.status === 'missing' ||
                requirement.status === 'uncertain') {
                // Requirement text only in the string; call-site parent-owned filters
                // re-check structured requirementCoverage (+ evidence) via
                // collectParentOwnedRequirementBlockers(blockers, toolResult).
                structuredBlockers.push(`BLOCKING: requirement ${requirement.status}: ${requirement.requirement}`);
                // Only an IN-SCOPE gap is repair fuel, decided with the same predicate
                // the call-site filter uses (requirement text + evidence).
                if (!isParentOwnedOrOutOfScopeRequirement(requirement.requirement, requirement.evidence)) {
                    entryHasHardBlocker = true;
                }
            }
        }
        // NON_BLOCKING is repair fuel, not a pass: elevate findings into the
        // same repair path used for BLOCKING until the reviewer returns LOOKS_GOOD.
        // Empty-findings synthetic is only needed when no hard blocker already
        // forces re-review — otherwise pure coverage-missing sets would mix a
        // non-coverage string and break all-coverage → test-writer routing.
        if (entry.verdict === 'NON_BLOCKING') {
            if (entry.findings.length > 0) {
                for (const finding of entry.findings) {
                    structuredBlockers.push(`NON_BLOCKING: ${finding}`);
                }
            }
            else if (!entryHasHardBlocker) {
                structuredBlockers.push('NON_BLOCKING: reviewer returned non-blocking nits without findings; re-address and re-review until LOOKS_GOOD');
            }
        }
    }
    // Nested spawn/set_output wrappers can surface the same structured receipt
    // twice; exact-string de-dupe keeps first-seen order without dropping
    // legitimately distinct blockers.
    if (structuredBlockers.length > 0) {
        return dedupeExactStringsPreserveOrder(structuredBlockers);
    }
    const texts: string[] = [];
    collectStrings(toolResult, texts);
    return dedupeExactStringsPreserveOrder(texts
        .map((text) => stripReviewerPreamble(text))
        .filter((text) => hasReviewerLineVerdict(text, 'BLOCKING')));
}

/**
 * ONLY the gate-derived hard rules the gate itself derives from the reviewer's
 * structured fields: the coverage-missing string, one string per `block`
 * dimension, and one string per in-scope requirement whose status is
 * `missing`/`uncertain`. Reviewer prose findings (BLOCKING or NON_BLOCKING) and
 * the synthetic empty-findings placeholder are deliberately excluded: they are
 * the only blockers a repair round can legitimately "address", so only they are
 * condonable.
 *
 * SYNC CONTRACT: these strings must stay byte-identical to the corresponding
 * ones produced by `collectReviewerBlockers` — base2's condone filter compares
 * them with exact `Set.has` membership, so a single-character divergence would
 * silently stop exempting hard rules. The two functions are kept independent so
 * `collectReviewerBlockers`' byte output cannot shift; the parity is asserted by
 * `agents/__tests__/gate-reviewer.test.ts`.
 */
function collectReviewerHardBlockers(toolResult: unknown): string[] {
    const structured = collectStructuredReviewerOutputs(toolResult);
    const hardBlockers: string[] = [];
    for (const entry of structured) {
        if (entry.coverage === 'missing') {
            hardBlockers.push('BLOCKING: test coverage missing for changed behavior (add a case to the relevant *.test.ts)');
        }
        // Same prefix rule as collectReviewerBlockers (kept independently): the
        // trimmed, lowercased value starting with the word `block` (or
        // `blocks`/`blocking`/`blocker`/`blockers`) fails, so `block: <clause>`,
        // `blocks: <clause>` and `blocking: <clause>` count while `blocked` does
        // not.
        for (const [dimension, status] of Object.entries(entry.dimensions ?? {})) {
            if (/^block(?:s|ing|er|ers)?\b/.test(status.trim().toLowerCase())) {
                hardBlockers.push(`BLOCKING: ${dimension} review dimension failed`);
            }
        }
        for (const requirement of entry.requirementCoverage ?? []) {
            if (requirement.status === 'missing' ||
                requirement.status === 'uncertain') {
                hardBlockers.push(`BLOCKING: requirement ${requirement.status}: ${requirement.requirement}`);
            }
        }
    }
    return dedupeExactStringsPreserveOrder(hardBlockers);
}

/**
 * Detects whether the reviewer agent itself crashed (returned an `errorMessage`
 * field, threw, or otherwise produced no usable output) as opposed to running
 * successfully but failing to populate its required structured verdict. The
 * two cases warrant very different operator messages:
 *   - crash    → "reviewer agent crashed; verdict cannot be trusted" (retry or escalate)
 *   - no-verdict → "reviewer returned no structured output" (automated retry)
 *
 * Heuristic: walks the tool-result tree looking for any object that carries an
 * `errorMessage` string or whose `type === 'error'`. Returns the first such
 * message so callers can surface it verbatim. Returns `null` when the result
 * looks like a normal (possibly malformed) reviewer reply.
 */
function detectReviewerCrash(toolResult: unknown): string | null {
    return findReviewerCrash(toolResult);
}

function findReviewerCrash(value: unknown, depth: number = 0): string | null {
    // Depth cap: reviewer tool results can carry deeply nested tool-call trees
    // (the reviewer itself may have invoked other tools). 8 is well past any
    // realistic agent-result envelope but stops pathological recursion.
    if (depth > 8)
        return null;
    if (!value)
        return null;
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findReviewerCrash(item, depth + 1);
            if (found)
                return found;
        }
        return null;
    }
    if (typeof value !== 'object')
        return null;
    const record = value as Record<string, unknown>;
    // NOTE: an unrelated nested `errorMessage` (e.g. a failed inner tool call
    // the reviewer made) will also be classified as a reviewer-agent crash.
    // This is acceptable because the caller only consults detectReviewerCrash
    // when the reviewer also failed to emit a recognizable verdict — a
    // reviewer whose inner tool call errored AND who produced no verdict is
    // effectively crashed from the operator's perspective.
    if (typeof record.errorMessage === 'string' && record.errorMessage.trim()) {
        return record.errorMessage.trim();
    }
    if (record.type === 'error' && typeof record.message === 'string') {
        return (record.message.trim() || 'reviewer agent reported an unspecified error');
    }
    const jsonNode = record.type === 'json' && 'value' in record;
    if (jsonNode) {
        const nested = findReviewerCrash(record.value, depth + 1);
        if (nested)
            return nested;
    }
    for (const [key, nested] of Object.entries(record)) {
        // The json recursion above already walked `value`; walking it again would
        // double the work at every nesting level up to the depth cap.
        if (jsonNode && key === 'value')
            continue;
        const found = findReviewerCrash(nested, depth + 1);
        if (found)
            return found;
    }
    return null;
}

/**
 * True when a reviewer crash message is a transient provider/rate-limit style
 * failure rather than a content or hard protocol crash. Used so the gate can
 * fail closed for the turn without thrashing repair-editor or bare-hex retries.
 *
 * Patterns are inlined (not a module-level const) so generate-gate-helpers can
 * emit a self-contained function into base2's handleSteps region.
 */
function isTransientReviewerCrash(message: string): boolean {
    if (typeof message !== 'string' || !message.trim())
        return false;
    const lower = message.toLowerCase();
    // Provider / rate-limit / concurrency crash strings (case-insensitive).
    const patterns = [
        'rate_limit',
        'rate limit',
        'concurrency limit',
        'concurrency limit exceeded',
        'please retry later',
        'overloaded',
        '429',
        'resource_exhausted',
        'too many requests',
    ];
    return patterns.some((pattern) => lower.includes(pattern));
}

/**
 * Coarse crash taxonomy for specialist/reviewer failures.
 * null/empty → none; rate-limit patterns → transient; optional protocol-ish
 * bare-hex / non-attestable / snapshot-attestation wording → protocol; else fatal.
 *
 * Non-test consumer: base2's specialist review gate branches on
 * `classifyReviewerCrash(crash) === 'protocol'` / `'transient'` at runtime via
 * the `<gate-helpers-generated>` copy emitted from this module, so this is the
 * canonical source of that taxonomy rather than a dead public helper.
 */
function classifyReviewerCrash(message: string | null): 'none' | 'transient' | 'protocol' | 'fatal' {
    if (typeof message !== 'string' || !message.trim())
        return 'none';
    if (isTransientReviewerCrash(message))
        return 'transient';
    const lower = message.toLowerCase();
    // The `(?:^|[^:])` prefix already excludes a `v3:<64hex>` token's own hex (the
    // character before the run may not be ':'), so a message that ALSO carries a
    // well-formed v3 token still classifies as 'protocol' when it contains a
    // separate bare 64-hex run. No extra v3 guard: it only suppressed genuine
    // bare-hex detection.
    const hasBareHex = /(?:^|[^:])\b[a-f0-9]{64}\b/i.test(message);
    if (hasBareHex ||
        lower.includes('non-attestable') ||
        lower.includes('snapshot attestation') ||
        (lower.includes('fingerprint') &&
            (lower.includes('attest') ||
                lower.includes('bare') ||
                lower.includes('did not match')))) {
        return 'protocol';
    }
    return 'fatal';
}

function getReviewerFinalizationVerdict(toolResult: unknown): ReviewerFinalizationVerdict {
    // Automated gates accept only schema-backed structured reviewer output.
    const structured = collectStructuredReviewerOutputs(toolResult);
    // Coverage-adequacy contract (M6.3): missing coverage blocks finalization
    // even if the text verdict is LOOKS_GOOD / NON_BLOCKING.
    if (structured.some((entry) => entry.coverage === 'missing')) {
        return '';
    }
    // Incomplete in-scope requirements (missing/uncertain) also block
    // finalization even when the reviewer emits a soft top-level verdict.
    // Parent-owned process tasks are not RF blockers for source reviewers.
    if (structured.some((entry) => (entry.requirementCoverage ?? []).some((requirement) => (requirement.status === 'missing' ||
        requirement.status === 'uncertain') &&
        !isParentOwnedOrOutOfScopeRequirement(requirement.requirement, requirement.evidence)))) {
        return '';
    }
    // A failing review dimension (`block` / `block: <clause>` / `blocks:` /
    // `blocking:` / `blocker(s): <clause>`) is a gate-derived hard blocker as
    // well, so it blocks finalization alongside coverage-missing and in-scope
    // requirement gaps instead of riding along with LOOKS_GOOD.
    if (structured.some((entry) => Object.values(entry.dimensions ?? {}).some((status) => /^block(?:s|ing|er|ers)?\b/.test(status.trim().toLowerCase())))) {
        return '';
    }
    // Finalization credit is LOOKS_GOOD only. NON_BLOCKING findings are
    // elevated by collectReviewerBlockers into the repair loop.
    // The scan is restricted to the `schemaVersion`-carrying entries whenever the
    // receipt carries any, so credit and collectReviewerAttestationIssues read
    // the SAME entry set and an unshaped quoted LOOKS_GOOD example cannot credit
    // a receipt whose real entry is BLOCKING. With no shaped entry the whole set
    // is read, matching `resolveReviewerAttestation`'s verbatim fallback.
    const creditable = structured.some((entry) => entry.schemaVersion !== undefined)
        ? structured.filter((entry) => entry.schemaVersion !== undefined)
        : structured;
    for (const entry of creditable) {
        if (entry.verdict === 'LOOKS_GOOD')
            return 'LOOKS_GOOD';
    }
    return '';
}

/**
 * Walk the reviewer tool result for objects that look like a structured
 * reviewer verdict: `{ verdict: 'LOOKS_GOOD' | 'NON_BLOCKING' | 'BLOCKING', findings?: string | string[], coverage?: 'covered' | 'missing' | 'n/a' }`.
 * Returns an ordered list of normalized entries. Plain text reviewer
 * outputs return an empty list so the existing text-mode logic stays in
 * charge.
 */
function collectStructuredReviewerOutputs(value: unknown): StructuredReviewerOutput[] {
    const out: StructuredReviewerOutput[] = [];
    visitForStructuredVerdict(value, out);
    return out;
}

function visitForStructuredVerdict(value: unknown, out: StructuredReviewerOutput[], depth: number = 0): void {
    // Depth cap (same value findReviewerCrash uses on the same envelopes): 8 is
    // well past any realistic agent-result envelope but stops pathological or
    // self-referential recursion from blowing the stack.
    if (depth > 8)
        return;
    if (!value)
        return;
    if (Array.isArray(value)) {
        for (const item of value)
            visitForStructuredVerdict(item, out, depth + 1);
        return;
    }
    if (typeof value !== 'object')
        return;
    const record = value as Record<string, unknown>;
    if (record.type === 'json' && 'value' in record) {
        visitForStructuredVerdict(record.value, out, depth + 1);
        return;
    }
    const rawVerdict = record.verdict;
    if (typeof rawVerdict === 'string') {
        const upper = rawVerdict.trim().toUpperCase();
        if (upper === 'LOOKS_GOOD' ||
            upper === 'NON_BLOCKING' ||
            upper === 'BLOCKING') {
            // ONE normalizer for object findings so the human-readable `findings`
            // strings and the structured `findingRecords` below cannot drift.
            const normalizeObjectFinding = (finding: object) => {
                const item = finding as Record<string, unknown>;
                const id = typeof item.id === 'string' ? item.id.trim() : '';
                const text = typeof item.summary === 'string'
                    ? item.summary.trim()
                    : typeof item.text === 'string'
                        ? item.text.trim()
                        : '';
                return { id, text };
            };
            const findings: string[] = [];
            const rawFindings = record.findings;
            if (typeof rawFindings === 'string') {
                const trimmed = rawFindings.trim();
                if (trimmed)
                    findings.push(trimmed);
            }
            else if (Array.isArray(rawFindings)) {
                for (const finding of rawFindings) {
                    if (typeof finding === 'string' && finding.trim()) {
                        findings.push(finding.trim());
                    }
                    else if (finding && typeof finding === 'object') {
                        const { id, text } = normalizeObjectFinding(finding);
                        if (text)
                            findings.push(id ? `[${id}] ${text}` : text);
                    }
                }
            }
            const advisories: string[] = [];
            const rawAdvisories = record.advisories;
            if (typeof rawAdvisories === 'string') {
                const trimmed = rawAdvisories.trim();
                if (trimmed)
                    advisories.push(trimmed);
            }
            else if (Array.isArray(rawAdvisories)) {
                for (const advisory of rawAdvisories) {
                    if (typeof advisory === 'string' && advisory.trim()) {
                        advisories.push(advisory.trim());
                    }
                }
            }
            let coverage: ReviewerCoverage | undefined;
            const rawCoverage = record.coverage;
            if (typeof rawCoverage === 'string') {
                const lower = rawCoverage.trim().toLowerCase();
                if (lower === 'covered' || lower === 'missing' || lower === 'n/a') {
                    coverage = lower;
                }
            }
            out.push({
                verdict: upper as ReviewerStructuredVerdict,
                findings,
                ...(advisories.length > 0 ? { advisories } : {}),
                coverage,
                dimensions: record.dimensions && typeof record.dimensions === 'object'
                    ? Object.fromEntries(Object.entries(record.dimensions as Record<string, unknown>).filter((entry): entry is [
                        string,
                        string
                    ] => typeof entry[1] === 'string'))
                    : undefined,
                requirementCoverage: Array.isArray(record.requirementCoverage)
                    ? record.requirementCoverage.flatMap((item) => {
                        if (!item || typeof item !== 'object')
                            return [];
                        const requirement = (item as Record<string, unknown>).requirement;
                        const status = (item as Record<string, unknown>).status;
                        const evidence = (item as Record<string, unknown>).evidence;
                        return typeof requirement === 'string' &&
                            typeof status === 'string'
                            ? [
                                {
                                    requirement,
                                    status: status.toLowerCase(),
                                    evidence: Array.isArray(evidence)
                                        ? evidence.filter((value): value is string => typeof value === 'string')
                                        : [],
                                },
                            ]
                            : [];
                    })
                    : undefined,
                snapshotFingerprint: typeof record.snapshotFingerprint === 'string'
                    ? record.snapshotFingerprint
                    : undefined,
                reviewedFiles: Array.isArray(record.reviewedFiles)
                    ? record.reviewedFiles.filter((file): file is string => typeof file === 'string')
                    : undefined,
                schemaVersion: typeof record.schemaVersion === 'number'
                    ? record.schemaVersion
                    : undefined,
                findingRecords: Array.isArray(rawFindings)
                    ? rawFindings.flatMap((finding) => {
                        if (!finding || typeof finding !== 'object')
                            return [];
                        const item = finding as Record<string, unknown>;
                        const { id, text } = normalizeObjectFinding(finding);
                        if (!id || !text)
                            return [];
                        return [
                            {
                                id,
                                text,
                                ...(typeof item.severity === 'string'
                                    ? { severity: item.severity }
                                    : {}),
                                ...(typeof item.dimension === 'string'
                                    ? { dimension: item.dimension }
                                    : {}),
                                evidence: Array.isArray(item.evidence)
                                    ? item.evidence.filter((value): value is string => typeof value === 'string')
                                    : [],
                                ...(typeof item.correction === 'string'
                                    ? { correction: item.correction }
                                    : {}),
                            },
                        ];
                    })
                    : undefined,
            });
            return;
        }
    }
    for (const nested of Object.values(record)) {
        visitForStructuredVerdict(nested, out, depth + 1);
    }
}

function hasReviewerLineVerdict(text: string, verdict: ReviewerStructuredVerdict): boolean {
    // Compiled once per call: built inside the per-line `.some` callback it was
    // recompiled for every line of every string collected from the tool result.
    const linePattern = new RegExp(`^${verdict}\\b`, 'i');
    return text.split(/\r?\n/).some((line) => linePattern.test(line.trim()));
}

function collectStrings(value: unknown, out: string[], depth: number = 0): void {
    // Depth cap (same value findReviewerCrash uses on the same envelopes): 8 is
    // well past any realistic agent-result envelope but stops pathological or
    // self-referential recursion from blowing the stack.
    if (depth > 8)
        return;
    if (typeof value === 'string') {
        out.push(value);
        return;
    }
    if (!value)
        return;
    if (Array.isArray(value)) {
        for (const item of value)
            collectStrings(item, out, depth + 1);
        return;
    }
    if (typeof value !== 'object')
        return;
    for (const nested of Object.values(value as Record<string, unknown>)) {
        collectStrings(nested, out, depth + 1);
    }
}

/**
 * Pure validation-failure parsing helpers extracted from `base2.ts`.
 *
 * These deterministically parse raw hook-failure strings (produced by
 * `collectHookFailures` in base2.ts) into structured
 * `{file, line, column, message, source}` records so the gate can spawn
 * a targeted editor repair instead of surfacing raw stderr for the model
 * to guess at.
 *
 * NOTE: equivalent inline copies of these helpers exist inside
 * `createBase2`'s `handleSteps` generator because that function is
 * serialized via `handleSteps.toString()` and reconstructed with
 * `new Function(...)`. Reconstructed functions lose their module
 * closure, so they cannot reference imports from this file. Keep the
 * two implementations in sync — `agents/__tests__/gate-repair-parity.test.ts`
 * enforces this.
 */
type ParsedValidationFailure = {
    file: string;
    line?: number;
    column?: number;
    message: string;
    /** Hook name extracted from the `- {name} failed (exit N):` prefix, or 'unknown'. */
    source: string;
};

/**
 * Parses raw hook-failure strings into structured file:line:column records.
 *
 * Each input string is expected to be in one of two forms:
 *   1. `- {hookName} failed (exit {code}):\n{stdout+stderr}` (from collectHookFailures)
 *   2. A raw errorMessage string (no prefix)
 *
 * Within each failure's body, diagnostic locations are extracted in order:
 *   - tsc:        `src/foo.ts(12,34): error TS2322: ...`
 *   - eslint/gcc: `/path/file.js:10:5: message`
 *   - generic:    `path:10: message` (no column)
 *
 * The first format that yields any matches wins per failure string (a single
 * hook's output is typically homogeneous). Failures with no parseable
 * file:line get an entry with `file: ''` so the caller can detect
 * unparseable output and fall back to raw stderr surfacing.
 *
 * Deduplicates by `file:line:column` within a single call.
 */
function parseValidationFailures(failures: string[]): ParsedValidationFailure[] {
    const out: ParsedValidationFailure[] = [];
    const seen = new Set<string>();
    for (const raw of failures) {
        if (typeof raw !== 'string' || !raw.trim())
            continue;
        let source = 'unknown';
        let body = raw;
        const prefixMatch = raw.match(/^-\s+(\S+)\s+failed\s+\(exit\s+\d+\):\s*\n?/);
        if (prefixMatch) {
            source = prefixMatch[1];
            body = raw.slice(prefixMatch[0].length);
        }
        const parsed: ParsedValidationFailure[] = [];
        // tsc: "file.ts(line,col): error TSxxxx: message"
        const tscRe = /^([^(]+)\((\d+),(\d+)\):\s*(error|warning)\s+(.+)$/gm;
        let m: RegExpExecArray | null;
        while ((m = tscRe.exec(body)) !== null) {
            parsed.push({
                file: m[1].trim(),
                line: parseInt(m[2], 10),
                column: parseInt(m[3], 10),
                message: `${m[4]}: ${m[5]}`.trim(),
                source,
            });
        }
        if (parsed.length === 0) {
            // eslint / gcc / rust: "file:line:col: message"
            const unixRe = /^(\S+?):(\d+):(\d+):\s*(.+)$/gm;
            while ((m = unixRe.exec(body)) !== null) {
                parsed.push({
                    file: m[1].trim(),
                    line: parseInt(m[2], 10),
                    column: parseInt(m[3], 10),
                    message: m[4].trim(),
                    source,
                });
            }
        }
        if (parsed.length === 0) {
            // generic: "file:line: message" (no column)
            const genericRe = /^(\S+?):(\d+):\s+(.+)$/gm;
            while ((m = genericRe.exec(body)) !== null) {
                parsed.push({
                    file: m[1].trim(),
                    line: parseInt(m[2], 10),
                    message: m[3].trim(),
                    source,
                });
            }
        }
        if (parsed.length > 0) {
            for (const p of parsed) {
                const key = `${p.file}:${p.line ?? 0}:${p.column ?? 0}`;
                if (seen.has(key))
                    continue;
                seen.add(key);
                out.push(p);
            }
        }
        else {
            const key = `::${source}:${body.slice(0, 80)}`;
            if (!seen.has(key)) {
                seen.add(key);
                out.push({
                    file: '',
                    message: body.trim().slice(0, 500),
                    source,
                });
            }
        }
    }
    return out;
}

/**
 * Builds a self-contained repair prompt for the editor agent. The editor
 * does not inherit conversation history, so this prompt must include
 * everything needed to make a targeted fix: the failing file:line locations,
 * the error messages, and the pending files context.
 *
 * Grouped by file for easy scanning. Unparseable failures are included as
 * raw text at the end so the editor has maximum context.
 */
function buildRepairEditorPrompt(parsed: ParsedValidationFailure[], pendingFiles: string[]): string {
    const fileFailures = parsed.filter((p) => p.file.length > 0);
    const lines: string[] = [
        'Validation hooks failed after your edits. A deterministic failure parser extracted the specific failing locations below.',
        '',
        'For each failure, read the exact file and line, make the minimal targeted fix, then finish. Do not refactor or make unrelated changes. The gate will re-run validation automatically after your edits.',
        '',
    ];
    if (fileFailures.length > 0) {
        lines.push('Failing locations (file:line:column — message):');
        const byFile = new Map<string, ParsedValidationFailure[]>();
        for (const f of fileFailures) {
            const list = byFile.get(f.file) ?? [];
            list.push(f);
            byFile.set(f.file, list);
        }
        for (const [file, fails] of byFile) {
            lines.push(`  ${file}:`);
            for (const f of fails) {
                const loc = f.line != null
                    ? `${f.line}${f.column != null ? `:${f.column}` : ''}`
                    : '?';
                lines.push(`    ${loc} — [${f.source}] ${f.message}`);
            }
        }
    }
    else {
        lines.push('No specific file:line locations could be parsed from the failure output. Read the raw failures below and the pending files, then fix.');
    }
    const unparsed = parsed.filter((p) => p.file.length === 0);
    if (unparsed.length > 0) {
        lines.push('');
        lines.push('Raw unparsed failures:');
        for (const u of unparsed) {
            lines.push(`  [${u.source}] ${u.message}`);
        }
    }
    if (pendingFiles.length > 0) {
        lines.push('');
        lines.push(`Pending changed files: ${pendingFiles.join(', ')}`);
    }
    return lines.join('\n');
}

/**
 * Pure concurrent-instance isolation helper for the base2 mid-turn git-status
 * sweep.
 *
 * NOTE: the inline copy is **generated** into the base2 `handleSteps`
 * `<gate-helpers-generated>` region via `scripts/generate-gate-helpers.ts`
 * (same as gate-paths/reviewer/repair). `handleSteps` is serialized via
 * `toString()` / `new Function(...)` and loses module closure, so it cannot
 * import this file — edit this module and regenerate rather than hand-maintaining
 * the inline copy.
 */
function shouldAbsorbGitStatusFile(params: {
    file: string;
    initialGitStatusFiles: readonly string[];
    gatePassedFiles: ReadonlySet<string> | {
        has(f: string): boolean;
    };
    taskRelatedFiles: ReadonlySet<string> | {
        has(f: string): boolean;
    };
    selfMutatedPaths?: ReadonlySet<string> | {
        has(f: string): boolean;
    };
}): boolean {
    const { file, initialGitStatusFiles, gatePassedFiles, taskRelatedFiles, selfMutatedPaths, } = params;
    if (initialGitStatusFiles.includes(file))
        return false;
    if (gatePassedFiles.has(file))
        return false;
    if (taskRelatedFiles.has(file))
        return true;
    if (selfMutatedPaths !== undefined && selfMutatedPaths.has(file))
        return true;
    return false;
}

/**
 * Pure gate snapshot fingerprint helpers extracted from `base2.ts`.
 *
 * NOTE: the inline copy is **generated** into the base2 `handleSteps`
 * `<gate-helpers-generated>` region via `scripts/generate-gate-helpers.ts`
 * (same as gate-paths/reviewer/repair/concurrency). `handleSteps` is serialized
 * via `toString()` / `new Function(...)` and loses module closure, so it cannot
 * import this file — edit this module and regenerate rather than hand-maintaining
 * the inline copy.
 */
// Canonical SHA-256 snapshot fingerprint: v3: followed by exactly 64
// lowercase hex chars. Only these are reusable as durable attestation.
function isAttestableSnapshotFingerprint(value: string): boolean {
    return /^v3:[a-f0-9]{64}$/.test(value);
}

function hashGateSnapshotDetails(details: string): string {
    const getBuiltinModule = typeof process === 'object' &&
        process !== null &&
        'getBuiltinModule' in process &&
        typeof process.getBuiltinModule === 'function'
        ? process.getBuiltinModule.bind(process)
        : undefined;
    const req = (globalThis as any).require as NodeJS.Require | undefined;
    let crypto: typeof import('node:crypto') | undefined;
    if (getBuiltinModule) {
        crypto = getBuiltinModule('node:crypto') as typeof import('node:crypto');
    }
    else if (typeof req === 'function') {
        crypto = req('node:crypto');
    }
    if (crypto) {
        return `v3:${crypto.createHash('sha256').update(details).digest('hex')}`;
    }
    // Fail closed: without a collision-resistant hash the snapshot cannot
    // be safely attested. Return a non-reusable sentinel so no durable
    // gate credit, review receipt, or bypass challenge can match it.
    return 'unreadable:no-crypto';
}
// </gate-helpers-generated>

      function recordChangedFiles(
        files: string[],
        opts?: { fromRepair?: boolean; fromStatusObservation?: boolean },
      ): void {
        const normalizedFiles = normalizeGateFileList(files)
        let discoveredNewPendingFile = false
        for (const file of normalizedFiles) {
          if (!pendingGateFiles.has(file)) discoveredNewPendingFile = true
          changedFiles.add(file)
          pendingGateFiles.add(file)
          gatePassedFiles.delete(file)
          // A re-edited file leaves the gate-passed ledger; drop its marker so
          // the eviction guard cannot see a stale marker and no orphan remains.
          if (activeWorkState.gatePassedFileMarkers) {
            delete activeWorkState.gatePassedFileMarkers[file]
          }
          activeWorkState.gatePassedFiles =
            activeWorkState.gatePassedFiles.filter(
              (passedFile) => passedFile !== file,
            )
          if (activeWorkState.gatePassedPendingFiles.includes(file)) {
            activeWorkState.gatePassedPendingFiles = []
            activeWorkState.gatePassedReviewerVerdict = ''
            activeWorkState.gatePassedValidationSummary = ''
            activeWorkState.gatePassedFingerprint = ''
          }
          if (!activeWorkState.touchedFiles.includes(file)) {
            activeWorkState.touchedFiles.push(file)
          }
          if (!activeWorkState.changedFiles.includes(file)) {
            activeWorkState.changedFiles.push(file)
          }
          if (!activeWorkState.pendingGateFiles.includes(file)) {
            activeWorkState.pendingGateFiles.push(file)
          }
        }
        // Every recorded change supersedes gate-issued plan-task receipts that
        // covered a changed path, plus every receipt with no verifiable content
        // identity. This deliberately also fires on the status-observation and
        // gate re-arm paths: the gate itself re-arms there, so a receipt must
        // stop authorizing completion. Guarded on normalizedFiles so a call that
        // recorded nothing can never drop a live receipt.
        if (normalizedFiles.length > 0) {
          supersedePlanTaskGateReceiptsForChangedFiles(normalizedFiles)
        }
        if (
          normalizedFiles.length > 0 &&
          (!opts?.fromStatusObservation || discoveredNewPendingFile)
        ) {
          // Completion is content-scoped, not path-scoped. A fresh edit to an
          // already-reviewed path must rerun specialist gates. A repeated
          // git_status observation is not fresh edit evidence, so it must not
          // clear a specialist receipt and create an infinite review loop.
          activeWorkState.specialistReviewGatesDone = []
          activeWorkState.lastReviewerGateSkipReason = ''
          activeWorkState.reviewerProtocolRetryCount = 0
          activeWorkState.reviewerNoVerdictCount = 0
          activeWorkState.currentPhase = 'awaiting_validation'
          if (!opts?.fromRepair && !activeWorkState.repairSessionId) {
            activeWorkState.repairRoundCount = 0
          }
        }
      }

      // Content verification for the gate-issued plan-task receipt ledger. A
      // receipt only authorizes a `done` transition while it is still TRUE, so
      // recompute each receipt's own invariant
      // (`snapshotFingerprint === hash(details(files, ''))`) against the live
      // working tree and drop every receipt that no longer holds. Structurally
      // invalid entries (older/corrupt serialized state) are dropped too, so a
      // malformed ledger can never grant completion.
      //
      // Mirrors the shape of the credited-file eviction ledger above: iterate,
      // drop on mismatch/unattestable/missing, write back once, mark changed
      // once. Pruning to an EMPTY array is deliberate and is NOT the same as
      // deleting the key: presence keeps gate-issued verification active for the
      // runtime handler, which is what makes an invented receipt ID fail.
      //
      // Inline because handleSteps is serialized via .toString() +
      // new Function(...), so it must not reference module-scope imports; it
      // reuses the inline buildGateSnapshotDetails / hashGateSnapshotDetails /
      // isAttestableSnapshotFingerprint helpers (which resolve node builtins at
      // call time) and must stay a hoisted `function` declaration because both
      // call sites appear EARLIER in the source than this declaration.
      function prunePlanTaskGateReceipts(): void {
        const receipts = activeWorkState.planTaskGateReceipts
        if (!Array.isArray(receipts) || receipts.length === 0) return
        const liveReceipts = receipts.filter((receipt) => {
          if (!receipt || typeof receipt !== 'object') return false
          if (
            typeof receipt.receiptId !== 'string' ||
            receipt.receiptId.length === 0
          ) {
            return false
          }
          if (
            typeof receipt.taskId !== 'string' ||
            receipt.taskId.length === 0
          ) {
            return false
          }
          // A non-array `files` (or a non-string entry) cannot be re-hashed at
          // all, so it is not verifiable evidence.
          if (!Array.isArray(receipt.files)) return false
          if (receipt.files.some((file) => typeof file !== 'string')) {
            return false
          }
          const recomputedFingerprint = hashGateSnapshotDetails(
            buildGateSnapshotDetails(receipt.files, ''),
          )
          // A non-attestable recomputation is a stable error string, not content
          // evidence, so two unrelated snapshots would compare equal under it.
          if (!isAttestableSnapshotFingerprint(recomputedFingerprint)) {
            return false
          }
          return recomputedFingerprint === receipt.snapshotFingerprint
        })
        if (liveReceipts.length === receipts.length) return
        activeWorkState.planTaskGateReceipts = liveReceipts
        markActiveWorkStateChanged()
      }

      // Change supersession for the gate-issued plan-task receipt ledger: the
      // complement of prunePlanTaskGateReceipts. Two drops, both required:
      //   - every receipt whose covered `files` intersect the changed paths (its
      //     content evidence no longer describes the workspace);
      //   - every receipt whose `evidence` is not 'reviewed-diff', because those
      //     have no verifiable content identity at all — a 'no-diff' receipt's
      //     fingerprint is the hash of an EMPTY file list, i.e. a constant, so it
      //     can never fail content verification and supersession is the only
      //     thing that can retire it. Legacy receipts serialized before
      //     `evidence` existed fail closed the same way.
      // Inline (hoisted `function`) for the same serialization reason as
      // prunePlanTaskGateReceipts; reuses the inline normalizeGateFileList so the
      // changed paths are compared in the same normalized form the receipts
      // store.
      function supersedePlanTaskGateReceiptsForChangedFiles(
        files: string[],
      ): void {
        const receipts = activeWorkState.planTaskGateReceipts
        if (!Array.isArray(receipts) || receipts.length === 0) return
        const changedFilePaths = new Set(normalizeGateFileList(files))
        // Nothing was actually recorded (every path normalized away), so there is
        // no change to supersede and a live receipt must not be dropped.
        if (changedFilePaths.size === 0) return
        const survivingReceipts = receipts.filter((receipt) => {
          if (!receipt || receipt.evidence !== 'reviewed-diff') return false
          const receiptFiles = Array.isArray(receipt.files) ? receipt.files : []
          return !receiptFiles.some((file) => changedFilePaths.has(file))
        })
        if (survivingReceipts.length === receipts.length) return
        activeWorkState.planTaskGateReceipts = survivingReceipts
        markActiveWorkStateChanged()
      }

      // Single guarded READ of the gate-issued plan-task receipt ledger, shared
      // by the three readers that only look at it: the gate-pass mint, the
      // printed live-receipt lookup, and buildPinnedActiveWorkMessage's durable
      // recovery line. They each used `(... ?? []).some/.find(...)`, which a
      // PRESENT-but-non-array ledger turns into a TypeError that fails the whole
      // turn. Hydration now normalizes such a value to `[]`, so this is the
      // second layer: it keeps all three readers as fail-closed as
      // prunePlanTaskGateReceipts / supersedePlanTaskGateReceiptsForChangedFiles
      // (both already guard with Array.isArray) so a future writer cannot
      // reintroduce the crash. Inline hoisted `function` for the same
      // serialization reason as those two: handleSteps is serialized via
      // .toString() + new Function(...), so it must not reference module-scope
      // imports, and every call site appears EARLIER in the source.
      function readPlanTaskGateReceipts(
        receipts: Base2PlanTaskGateReceipt[] | undefined,
      ): Base2PlanTaskGateReceipt[] {
        return Array.isArray(receipts) ? receipts : []
      }

      function reviewChallengeFingerprint(files: string[]): string {
        return hashGateSnapshotDetails(buildGateSnapshotDetails(files, ''))
      }

      function ensureReviewerBypassChallenge(
        fingerprint: string,
        messages: unknown,
      ): {
        id: string
        fingerprint: string
        issuedAfterMessageIndex: number
        consumed: boolean
      } {
        const existing = activeWorkState.reviewerBypassChallenge
        if (
          existing &&
          existing.fingerprint === fingerprint &&
          !existing.consumed
        ) {
          return existing
        }
        const challenge = {
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          fingerprint,
          issuedAfterMessageIndex: Array.isArray(messages)
            ? messages.length
            : 0,
          consumed: false,
        }
        activeWorkState.reviewerBypassChallenge = challenge
        return challenge
      }

      function hasReviewerBypassAuthorization(
        messages: unknown,
        challenge:
          | {
              id: string
              fingerprint: string
              issuedAfterMessageIndex: number
              consumed: boolean
            }
          | undefined,
        currentFingerprint: string,
      ): boolean {
        if (
          !Array.isArray(messages) ||
          !challenge ||
          challenge.consumed ||
          challenge.fingerprint !== currentFingerprint
        ) {
          return false
        }
        const expected = `BYPASS REVIEWER ${challenge.id}`
        for (
          let index = challenge.issuedAfterMessageIndex;
          index < messages.length;
          index++
        ) {
          const message = messages[index]
          if (!message || typeof message !== 'object') continue
          const record = message as Record<string, unknown>
          if (record.role !== 'user') continue
          const texts: string[] = []
          const collect = (value: unknown): void => {
            if (typeof value === 'string') {
              texts.push(value)
              return
            }
            if (Array.isArray(value)) {
              for (const item of value) collect(item)
              return
            }
            if (value && typeof value === 'object') {
              const nested = value as Record<string, unknown>
              collect(nested.text)
              collect(nested.content)
            }
          }
          collect(record.content)
          if (texts.some((text) => text.trim() === expected)) {
            return true
          }
        }
        return false
      }

      // Word-boundary basename match for SECURITY_SENSITIVE_NAME_SUBSTRINGS.
      // Bare lowerBase.includes('token') false-positives on measure scripts
      // named *tokens* (token-count metrics), which re-fired security aux forever.
      // Sensitive names match only as whole alphanumeric runs (e.g. auth-token,
      // token.ts, foo_token_bar) — not longer words like tokens/tokenize/polygon.
      function isAlnumChar(ch: string): boolean {
        return (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')
      }
      function basenameContainsSensitiveName(
        lowerBase: string,
        name: string,
      ): boolean {
        let from = 0
        while (from <= lowerBase.length) {
          const idx = lowerBase.indexOf(name, from)
          if (idx < 0) return false
          const beforeOk = idx === 0 || !isAlnumChar(lowerBase[idx - 1]!)
          const afterIdx = idx + name.length
          const afterOk =
            afterIdx >= lowerBase.length || !isAlnumChar(lowerBase[afterIdx]!)
          if (beforeOk && afterOk) return true
          from = idx + 1
        }
        return false
      }

      function matchesSecuritySensitiveGlob(files: string[]): boolean {
        if (!files.length) return false
        for (const file of files) {
          const normalized = normalizeGateFilePath(file)
          if (!normalized) continue
          const segments = normalized.split('/')
          const basename = segments[segments.length - 1] || ''
          const lowerBase = basename.toLowerCase()
          // .env files at any depth.
          if (basename.startsWith('.env')) {
            return true
          }
          for (const name of SECURITY_SENSITIVE_NAME_SUBSTRINGS) {
            if (basenameContainsSensitiveName(lowerBase, name)) {
              return true
            }
          }
          // Directory segment matches (any path segment equals a sensitive dir).
          for (const segment of segments) {
            const lower = segment.toLowerCase()
            if (SECURITY_SENSITIVE_GLOBS.includes(lower)) {
              return true
            }
          }
        }
        return false
      }

      function inferPackageTestCommand(filePath: string): string | null {
        // Prefer known monorepo-local commands, then fall back by ecosystem so
        // ordinary user projects are not silently skipped.
        const pkgMatch = filePath.match(
          /^packages\/([^/]+)\/(?:src|__tests__)\//,
        )
        if (pkgMatch) {
          return `cd packages/${pkgMatch[1]} && bun run typecheck && bun test`
        }
        if (
          filePath.startsWith('agents/') &&
          !filePath.startsWith('agents/__tests__/')
        ) {
          return 'cd agents && bun run typecheck && bun test'
        }
        if (filePath.startsWith('common/src/')) {
          return 'cd common && bun run typecheck && bun test'
        }
        if (filePath.startsWith('cli/src/')) {
          return 'cd cli && bun run typecheck && bun test'
        }
        if (/\.pyi?$/.test(filePath)) return 'pytest'
        if (/\.go$/.test(filePath)) return 'go test ./...'
        if (/\.rs$/.test(filePath)) return 'cargo test'
        if (/\.(java|kt|kts)$/.test(filePath)) return './gradlew test'
        if (/\.(cs|fs|vb)$/.test(filePath)) return 'dotnet test'
        if (/\.(tsx?|jsx?|mjs|cjs)$/.test(filePath)) return 'bun test'
        return null
      }

      function isNonTestSourceFile(filePath: string): boolean {
        if (/__tests__\//.test(filePath)) return false
        if (/\.(test|spec)\.tsx?$/.test(filePath)) return false
        if (/\.generated\.tsx?$/.test(filePath)) return false
        if (/\.(md|json|mdx)$/.test(filePath)) return false
        if (/\.(yml|yaml|toml)$/.test(filePath)) return false
        if (/^\.env($|\.)/.test(filePath)) return false
        if (filePath.startsWith('docs/')) return false
        if (filePath.startsWith('evals/') || filePath.startsWith('.agents/')) {
          return false
        }
        return /\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|kts|cs|fs|vb)$/.test(
          filePath,
        )
      }

      function selectTestWriterTargets(files: string[]): {
        groups: Array<{
          targetFiles: string[]
          testCommand: string
          candidateTests: string[]
          manifest?: string
          packageRoot: string
        }>
      } {
        const targetFiles = files.filter(isNonTestSourceFile)
        if (!targetFiles.length) {
          return { groups: [] }
        }
        const filesByCommand = new Map<string, string[]>()
        for (const file of targetFiles) {
          const testCommand = inferPackageTestCommand(file)
          if (!testCommand) continue
          const group = filesByCommand.get(testCommand) ?? []
          group.push(file)
          filesByCommand.set(testCommand, group)
        }
        return {
          groups: [...filesByCommand.entries()].map(
            ([testCommand, groupedFiles]) => ({
              targetFiles: groupedFiles,
              testCommand,
              candidateTests: [],
              packageRoot: inferWorkspaceRootFromPath(groupedFiles[0]),
            }),
          ),
        }
      }

      function findJsonRecordWithArray(
        value: unknown,
        key: string,
        depth = 0,
      ): Record<string, unknown> | undefined {
        if (!value || depth > 8) return undefined
        if (Array.isArray(value)) {
          for (const item of value) {
            const found = findJsonRecordWithArray(item, key, depth + 1)
            if (found) return found
          }
          return undefined
        }
        if (typeof value !== 'object') return undefined
        const record = value as Record<string, unknown>
        if (Array.isArray(record[key])) return record
        if (record.type === 'json' && 'value' in record) {
          const found = findJsonRecordWithArray(record.value, key, depth + 1)
          if (found) return found
        }
        for (const nested of Object.values(record)) {
          const found = findJsonRecordWithArray(nested, key, depth + 1)
          if (found) return found
        }
        return undefined
      }

      function summarizeWriterEnvironment(value: unknown): string {
        const record = findJsonRecordWithArray(value, 'workspaces')
        if (!record) return ''
        const manager =
          typeof record.packageManager === 'string'
            ? record.packageManager
            : 'mixed/unknown manager'
        const manifests = Array.isArray(record.manifests)
          ? record.manifests.filter(
              (item): item is string => typeof item === 'string',
            )
          : []
        return `${manager}; manifests: ${manifests.slice(0, 12).join(', ') || '(none)'}`
      }

      function selectProjectAwareTestWriterTargets(
        files: string[],
        affectedTestResult: unknown,
        buildTargetResult: unknown,
      ): {
        groups: Array<{
          targetFiles: string[]
          testCommand: string
          candidateTests: string[]
          manifest?: string
          packageRoot: string
        }>
      } {
        const sourceFiles = files.filter(isNonTestSourceFile)
        if (sourceFiles.length === 0) return { groups: [] }
        const affectedRecord = findJsonRecordWithArray(
          affectedTestResult,
          'targets',
        )
        const buildRecord = findJsonRecordWithArray(
          buildTargetResult,
          'targets',
        )
        const affectedTargets = Array.isArray(affectedRecord?.targets)
          ? affectedRecord.targets.filter(
              (item): item is Record<string, unknown> =>
                !!item && typeof item === 'object',
            )
          : []
        const buildTargets = Array.isArray(buildRecord?.targets)
          ? buildRecord.targets.filter(
              (item): item is Record<string, unknown> =>
                !!item && typeof item === 'object',
            )
          : []
        const byRoot = new Map<
          string,
          { targetFiles: string[]; candidateTests: string[] }
        >()
        for (const source of sourceFiles) {
          const affected = affectedTargets.find(
            (item) => item.source === source,
          )
          const root =
            typeof affected?.packageRoot === 'string'
              ? affected.packageRoot
              : inferWorkspaceRootFromPath(source)
          const group = byRoot.get(root) ?? {
            targetFiles: [],
            candidateTests: [],
          }
          group.targetFiles.push(source)
          if (Array.isArray(affected?.candidates)) {
            for (const candidate of affected.candidates) {
              if (
                typeof candidate === 'string' &&
                !group.candidateTests.includes(candidate)
              ) {
                group.candidateTests.push(candidate)
              }
            }
          }
          byRoot.set(root, group)
        }
        const groups = [...byRoot.entries()].flatMap(([root, group]) => {
          const build = buildTargets.find((item) => item.packageRoot === root)
          const commands = Array.isArray(build?.commands)
            ? build.commands.filter(
                (item): item is string => typeof item === 'string',
              )
            : []
          const selectedCommand = commands.find((command) =>
            /(?:^|\s)(?:test|pytest)(?:\s|$)/i.test(command),
          )
          const fallbackCommand = inferPackageTestCommand(group.targetFiles[0])
          const command = selectedCommand
            ? root === '.'
              ? selectedCommand
              : `cd ${root} && ${selectedCommand}`
            : fallbackCommand
          if (!command) return []
          return [
            {
              ...group,
              testCommand: command,
              packageRoot: root,
              ...(typeof build?.manifest === 'string'
                ? { manifest: build.manifest }
                : {}),
            },
          ]
        })
        return groups.length > 0 ? { groups } : selectTestWriterTargets(files)
      }

      function inferWorkspaceRootFromPath(filePath: string): string {
        const normalized = normalizeGateFilePath(filePath)
        const segments = normalized.split('/').filter(Boolean)
        if (
          (segments[0] === 'packages' || segments[0] === 'apps') &&
          segments[1]
        ) {
          return `${segments[0]}/${segments[1]}`
        }
        return segments.length > 1 ? segments[0] : '.'
      }

      function testWriterScopePatterns(packageRoot: string): string[] {
        const prefix = packageRoot === '.' ? '' : `${packageRoot}/`
        return [
          `${prefix}**/*.test.*`,
          `${prefix}**/*.spec.*`,
          `${prefix}**/__tests__/**`,
          `${prefix}**/test/**`,
          `${prefix}**/tests/**`,
        ]
      }

      function docWriterScopePatterns(sourceFiles: string[]): string[] {
        const roots = [...new Set(sourceFiles.map(inferWorkspaceRootFromPath))]
        return roots.flatMap((root) => {
          const prefix = root === '.' ? '' : `${root}/`
          return [
            `${prefix}docs/**`,
            `${prefix}README*`,
            `${prefix}**/README*`,
            `${prefix}**/*.md`,
            `${prefix}**/*.mdx`,
          ]
        })
      }

      // Least-privilege repair-editor READ scope: exact finding/pending files,
      // their parent directories, package roots (never bare **/*), and optional
      // conservatively extracted path citations from finding/diagnostic text.
      // WRITE scope stays exact file lists only at each call site.
      function repairEditorReadablePaths(
        paths: string[],
        texts?: string[],
      ): string[] {
        const seedPaths = [...paths]
        if (Array.isArray(texts)) {
          // Conservative path-like tokens: require at least one '/' and a
          // file-ish extension (e.g. common/src/tools/params/tool/replace-range.ts).
          const pathLikeRe =
            /(?:^|[\s"'`(,:=\[])((?:[\w.-]+\/)+[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|kts|cs|fs|vb|json|md|mdx|yml|yaml|toml|css|scss|html|vue|svelte))\b/g
          for (const text of texts) {
            if (typeof text !== 'string' || !text) continue
            let match: RegExpExecArray | null
            while ((match = pathLikeRe.exec(text)) !== null) {
              const candidate = match[1]
              if (/^https?:\/\//i.test(candidate)) continue
              // URL path capture after `:` (e.g. https://example.com/src/x.ts
              // yields example.com/src/x.ts) never has a protocol prefix — reject
              // host-like first segments (dot / TLD in the first path component).
              // Use split('/')[0] (or limit 2): JS split limit 1 returns only one
              // element and is easy to confuse with Python maxsplit; first path
              // component must not be the full candidate or extension-bearing
              // citations (common/.../replace-range.ts) are rejected as host-like.
              const firstSegment = candidate.split('/')[0] ?? ''
              if (firstSegment.includes('.')) continue
              if (candidate.includes('node_modules/')) continue
              if (/(^|\/)\.env($|\.)/.test(candidate)) continue
              seedPaths.push(candidate)
            }
          }
        }
        const files = Array.from(
          new Set(
            seedPaths
              .map((path) => normalizeGateFilePath(path))
              .filter((path) => path.length > 0)
              .filter((path) => !path.includes('node_modules/'))
              .filter((path) => !/(^|\/)\.env($|\.)/.test(path)),
          ),
        )
        const expansions = new Set<string>()
        for (const file of files) {
          const separator = file.lastIndexOf('/')
          if (separator > 0) expansions.add(`${file.slice(0, separator)}/**/*`)
          const root = inferWorkspaceRootFromPath(file)
          // Never add bare **/* / * for root-level files (root === '.').
          if (root !== '.') expansions.add(`${root}/**/*`)
        }
        return Array.from(new Set([...files, ...expansions]))
      }

      function isPublicApiSourceFile(filePath: string): boolean {
        if (/__tests__\//.test(filePath)) return false
        if (/\.(test|spec)\.tsx?$/.test(filePath)) return false
        if (/\.generated\.tsx?$/.test(filePath)) return false
        if (/\.(md|json|mdx|yml|yaml|toml)$/.test(filePath)) return false
        if (filePath.startsWith('docs/')) return false
        if (filePath.startsWith('evals/') || filePath.startsWith('.agents/')) {
          return false
        }
        return /\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|kts|cs|fs|vb)$/.test(
          filePath,
        )
      }

      function selectDocWriterTargets(files: string[]): string[] {
        return files.filter(isPublicApiSourceFile)
      }

      // Return the subset of `files` that at least one aux gate predicate
      // (test-writer / doc-writer / security-reviewer) would act on. Used at
      // the handleSteps call site to compare/store the aux-relevant snapshot
      // so aux outputs (test files, doc files) don't perturb the snapshot and
      // trigger an infinite *GateDone reset loop. Self-contained inline
      // helper — no module-scope imports (handleSteps is serialized).
      function selectAuxRelevantFiles(files: string[]): string[] {
        const relevant: string[] = []
        for (const file of files) {
          if (
            isNonTestSourceFile(file) &&
            inferPackageTestCommand(file) !== null
          ) {
            relevant.push(file)
            continue
          }
          if (isPublicApiSourceFile(file)) {
            relevant.push(file)
            continue
          }
          if (matchesSecuritySensitiveGlob([file])) {
            relevant.push(file)
            continue
          }
          // Specialist-routed files (reliability / migration / compatibility /
          // performance) intentionally get NO branch of their own here: every
          // such file that is a reviewable source file is already admitted by
          // the test-writer (isNonTestSourceFile) or doc-writer
          // (isPublicApiSourceFile) predicates above. Re-running the
          // specialist router (or a copy of its path regexes) over the raw
          // path would additionally admit aux OUTPUTS whose names collide with
          // router keywords — e.g. packages/sdk/src/__tests__/cache.test.ts or
          // docs/state.md both match the reliability path pattern — which
          // would grow this snapshot right after test-writer/doc-writer ran,
          // make detectPendingGateFileSetChange return true, clear
          // testWriterGateDone/docWriterGateDone, and re-spawn the writers
          // forever: the exact loop this helper exists to prevent.
        }
        // Dedupe preserving first-seen order.
        const seen = new Set<string>()
        const out: string[] = []
        for (const file of relevant) {
          if (!seen.has(file)) {
            seen.add(file)
            out.push(file)
          }
        }
        return out
      }

      function detectPendingGateFileSetChange(
        activeWorkState: Base2ActiveWorkState,
        currentFiles: string[],
      ): boolean {
        const last = activeWorkState.auxGatesLastPendingFiles ?? []
        return !gateFileSetsEqual(last, currentFiles)
      }

      // Specialist spawn brief: domain-only requirements (not the full parent
      // user prompt). Inline because handleSteps is serialized via
      // toString()/new Function and cannot import module helpers.
      function buildSpecialistScopedReviewPrompt(input: {
        title: string
        agentType: string
        files: string[]
        snapshotFingerprint: string
        userPrompt: string
        extraLines?: string[]
      }): string {
        const domainLabel = input.agentType
          .replace(/-reviewer$/i, '')
          .replace(/-specialist$/i, '')
          .replace(/-/g, '/')
        const truncatedIntent = (input.userPrompt ?? '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 400)
        const lines = [
          input.title,
          'Requirements (specialist-domain only):',
          `- Review only in-scope ${domainLabel} risks in the changed files.`,
          '- Score requirementCoverage only for requirements this specialist can judge from source/diff evidence.',
          '- Do NOT treat parent workflow as review requirements: rewriting git commits, running full validation, commit/push, confirming CI/CD green, or other operator/orchestrator duties. Omit those from requirementCoverage (or if mentioned only as context, never mark them missing/uncertain for the gate).',
          `Changed files: ${input.files.join(', ') || '(none)'}`,
          `Snapshot fingerprint (echo exactly): ${input.snapshotFingerprint}`,
        ]
        if (truncatedIntent) {
          lines.push(
            `Non-blocking parent context (not a Requirements checklist): ${truncatedIntent}`,
          )
        }
        if (Array.isArray(input.extraLines)) {
          for (const line of input.extraLines) {
            if (typeof line === 'string' && line.trim()) lines.push(line)
          }
        }
        return lines.join('\n')
      }

      function extractChangeReviewBundle(value: unknown): {
        snapshotId: string
        errorMessage: string
        files: string[]
      } {
        if (Array.isArray(value)) {
          for (const item of value) {
            const found = extractChangeReviewBundle(item)
            if (found.snapshotId || found.errorMessage) return found
          }
          return { snapshotId: '', errorMessage: '', files: [] }
        }
        if (!value || typeof value !== 'object')
          return { snapshotId: '', errorMessage: '', files: [] }
        const record = value as Record<string, unknown>
        if (record.type === 'json' && 'value' in record)
          return extractChangeReviewBundle(record.value)
        if (typeof record.snapshotId === 'string') {
          const files = Array.isArray(record.files)
            ? record.files.filter(
                (file): file is string => typeof file === 'string',
              )
            : []
          return { snapshotId: record.snapshotId, errorMessage: '', files }
        }
        if (typeof record.errorMessage === 'string')
          return {
            snapshotId: '',
            errorMessage: record.errorMessage,
            files: [],
          }
        if ('toolResult' in record)
          return extractChangeReviewBundle(record.toolResult)
        return { snapshotId: '', errorMessage: '', files: [] }
      }

      // Correlate a synthesized blocker string to the reviewer-supplied
      // finding record it came from by CONTENT, never by positional index.
      // collectReviewerBlockers can emit synthesized blockers (coverage
      // missing, dimension-block, requirement missing/uncertain) that have no
      // corresponding finding record and appear in a different order/count
      // than collectReviewerFindingRecords returns, so records[index]
      // could attach the wrong id/text. Self-contained inline helper
      // (handleSteps is serialized via .toString() + new Function(...), so it
      // must not reference module-scope imports).
      //
      // Matching is strongest-first: the explicit `[id]` marker, then an EXACT
      // match against the stripped blocker text (or its `[id] text` form), and
      // only then a substring match — and that last one solely when exactly one
      // record matches. A bare `blockerText.includes(record.text)` attached the
      // wrong record whenever one finding's text was a substring of another's,
      // and the resulting `<class>::id:<id>` condone key then condoned an
      // UNRELATED finding. Attaching no id is safe (the text key still carries
      // convergence); attaching the wrong one is not.
      function correlateReviewerFindingRecord(
        blockerText: string,
        records: Array<{ id: string; text: string }>,
      ): { id: string; text: string } | undefined {
        for (const record of records) {
          if (record.id && blockerText.includes(`[${record.id}]`)) {
            return record
          }
        }
        const strippedText = stripReviewerVerdictPrefix(blockerText)
        for (const record of records) {
          if (!record.text) continue
          if (
            strippedText === record.text ||
            (record.id && strippedText === `[${record.id}] ${record.text}`)
          ) {
            return record
          }
        }
        const substringMatches = records.filter(
          (record) => record.text && strippedText.includes(record.text),
        )
        return substringMatches.length === 1 ? substringMatches[0] : undefined
      }

      function isStaleSnapshotReviewerResult(toolResult: unknown): boolean {
        const structured = collectStructuredReviewerOutputs(toolResult)
        const result = structured[structured.length - 1]
        return (result?.findingRecords ?? []).some((finding) => {
          const id = finding.id.toLowerCase()
          const text = finding.text.toLowerCase()
          if (id.endsWith(':stale-snapshot')) return true
          // Protocol-only phrasing; avoid matching ordinary content findings that
          // mention snapshot fingerprints or durable memory.
          return (
            (text.includes('stale snapshot') ||
              text.includes('snapshot is stale') ||
              text.includes('snapshot does not match') ||
              text.includes('snapshot fingerprint did not match') ||
              text.includes('could not attest')) &&
            (text.includes('snapshot') || text.includes('attest'))
          )
        })
      }

      function recordSuccessfulReviewReceipt(
        toolResult: unknown,
        reviewer: string,
        expectedFingerprint: string,
      ): void {
        const structured = collectStructuredReviewerOutputs(toolResult)
        const result = structured[structured.length - 1]
        if (
          !result ||
          (result.verdict !== 'LOOKS_GOOD' && result.verdict !== 'NON_BLOCKING')
        ) {
          return
        }
        const MAX_RECEIPT_TEXT_LENGTH = 240
        const MAX_RECEIPT_EVIDENCE_ITEMS = 3
        const MAX_RECEIPT_EVIDENCE_LENGTH = 240
        const MAX_SERIALIZED_RECEIPT_LENGTH = 4_000

        function compactReceiptString(
          value: string,
          maxLength: number,
        ): string {
          const normalized = value.replace(/\s+/g, ' ').trim()
          return normalized.length > maxLength
            ? `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
            : normalized
        }

        function compactReceiptEvidence(values: string[]): {
          evidence: string[]
          evidenceCount: number
          evidenceTruncated?: boolean
        } {
          const evidenceCount = values.filter((value) => value.trim()).length
          const evidence = values
            .filter((value) => value.trim())
            .slice(0, MAX_RECEIPT_EVIDENCE_ITEMS)
            .map((value) =>
              compactReceiptString(value, MAX_RECEIPT_EVIDENCE_LENGTH),
            )
          const evidenceTruncated =
            evidenceCount > evidence.length ||
            values.some(
              (value) =>
                value.replace(/\s+/g, ' ').trim().length >
                MAX_RECEIPT_EVIDENCE_LENGTH,
            )
          return {
            evidence,
            evidenceCount,
            ...(evidenceTruncated ? { evidenceTruncated: true } : {}),
          }
        }

        function fitReceiptToStorageBound(
          receipt: Base2ReviewReceipt,
        ): Base2ReviewReceipt {
          if (JSON.stringify(receipt).length <= MAX_SERIALIZED_RECEIPT_LENGTH) {
            return receipt
          }
          const compacted: Base2ReviewReceipt = {
            ...receipt,
            reviewedFiles: receipt.reviewedFiles
              .slice(0, 4)
              .map((value) => compactReceiptString(value, 180)),
            dimensions: {},
            findings: receipt.findings.slice(0, 2).map((finding) => ({
              ...finding,
              id: compactReceiptString(finding.id, 160),
              text: compactReceiptString(finding.text, 180),
              evidence: finding.evidence
                .slice(0, 1)
                .map((value) => compactReceiptString(value, 180)),
              evidenceTruncated:
                finding.evidenceTruncated || finding.evidence.length > 1,
              ...(finding.correction
                ? {
                    correction: compactReceiptString(finding.correction, 180),
                  }
                : {}),
            })),
            requirementCoverage: receipt.requirementCoverage
              .slice(0, 2)
              .map((coverage) => ({
                ...coverage,
                requirement: compactReceiptString(coverage.requirement, 180),
                evidence: coverage.evidence
                  .slice(0, 1)
                  .map((value) => compactReceiptString(value, 180)),
                evidenceTruncated:
                  coverage.evidenceTruncated || coverage.evidence.length > 1,
              })),
            ...(receipt.advisories && receipt.advisories.length > 0
              ? {
                  advisories: receipt.advisories
                    .slice(0, 2)
                    .map((advisory) => compactReceiptString(advisory, 180)),
                }
              : {}),
            receiptTruncated: true,
          }
          if (
            JSON.stringify(compacted).length <= MAX_SERIALIZED_RECEIPT_LENGTH
          ) {
            return compacted
          }
          return {
            ...compacted,
            reviewedFiles: [],
            findings: [],
            requirementCoverage: [],
            dimensions: {},
            // advisoryCount survives so a consumer can still tell advisories
            // existed even though the texts did not fit the storage bound.
            advisories: undefined,
          }
        }

        const gateId = `${reviewer}:${expectedFingerprint}`
        const reviewedFiles = normalizeGateFileList(result.reviewedFiles ?? [])
        // Advisories are the reviewer's non-blocking observations. They are
        // recorded (and surfaced) but never become repair targets, which is
        // what lets a LOOKS_GOOD verdict carry cosmetic notes instead of
        // holding the turn open with findings that require no change.
        const MAX_RECEIPT_ADVISORIES = 8
        // Read through the shared collector (generated into this file's
        // <gate-helpers-generated> region from agents/base2/gate-reviewer.ts)
        // so the PERSISTED advisories are exactly the tested contract — last
        // structured entry, trimmed, exact-duplicate-free — rather than a
        // second inline read of `result.advisories` with different semantics.
        const advisories = collectReviewerAdvisories(toolResult)
          .map((advisory) =>
            compactReceiptString(advisory, MAX_RECEIPT_TEXT_LENGTH),
          )
          .filter((advisory) => advisory.length > 0)
          .slice(0, MAX_RECEIPT_ADVISORIES)
        const receipt: Base2ReviewReceipt = {
          gateId,
          reviewer,
          verdict: result.verdict,
          snapshotFingerprint:
            result.snapshotFingerprint ?? expectedFingerprint,
          reviewedFiles: reviewedFiles.map((value) =>
            compactReceiptString(value, MAX_RECEIPT_TEXT_LENGTH),
          ),
          reviewedFileCount: reviewedFiles.length,
          ...(result.coverage ? { coverage: result.coverage } : {}),
          dimensions: result.dimensions ?? {},
          findings: (result.findingRecords ?? []).map((finding) => {
            const compactEvidence = compactReceiptEvidence(finding.evidence)
            const correction =
              typeof finding.correction === 'string'
                ? compactReceiptString(
                    finding.correction,
                    MAX_RECEIPT_TEXT_LENGTH,
                  )
                : undefined
            const correctionTruncated =
              typeof finding.correction === 'string' &&
              finding.correction.replace(/\s+/g, ' ').trim().length >
                MAX_RECEIPT_TEXT_LENGTH
            return {
              id: compactReceiptString(finding.id, MAX_RECEIPT_TEXT_LENGTH),
              text: compactReceiptString(finding.text, MAX_RECEIPT_TEXT_LENGTH),
              ...(typeof finding.severity === 'string'
                ? { severity: finding.severity }
                : {}),
              ...(typeof finding.dimension === 'string'
                ? { dimension: finding.dimension }
                : {}),
              ...compactEvidence,
              ...(correction ? { correction } : {}),
              ...(correctionTruncated ? { correctionTruncated: true } : {}),
            }
          }),
          findingCount: (result.findingRecords ?? []).length,
          ...(advisories.length > 0
            ? { advisories, advisoryCount: advisories.length }
            : {}),
          requirementCoverage: (result.requirementCoverage ?? []).map(
            (coverage) => ({
              requirement: compactReceiptString(
                coverage.requirement,
                MAX_RECEIPT_TEXT_LENGTH,
              ),
              status: coverage.status,
              ...compactReceiptEvidence(coverage.evidence),
            }),
          ),
          requirementCoverageCount: (result.requirementCoverage ?? []).length,
          recordedAt: new Date().toISOString(),
        }
        activeWorkState.reviewReceipts = [
          ...(activeWorkState.reviewReceipts ?? []).filter(
            (existing) => existing.gateId !== gateId,
          ),
          fitReceiptToStorageBound(receipt),
        ].slice(-24)
      }

      function resetAuxGateFlags(
        activeWorkState: Base2ActiveWorkState,
        currentFiles: string[],
      ): void {
        activeWorkState.preEditSecurityReviewDone = false
        activeWorkState.securityReviewGateDone = false
        activeWorkState.testWriterGateDone = false
        activeWorkState.docWriterGateDone = false
        activeWorkState.specialistReviewGatesDone = []
        activeWorkState.validationInfrastructureBypassFingerprint = undefined
        activeWorkState.auxGatesLastPendingFiles = currentFiles
      }

      function getConversationGatePassForPendingFiles(
        files: string[],
        messages: unknown,
      ): { reviewerVerdict: 'LOOKS_GOOD' | '' } | undefined {
        if (files.length === 0 || !Array.isArray(messages)) return undefined
        let latestMatchingPass:
          | { reviewerVerdict: 'LOOKS_GOOD' | '' }
          | undefined
        for (const message of messages) {
          if (latestMatchingPass && messageChangedFiles(message)) {
            latestMatchingPass = undefined
          }
          const gateStates = extractGateStateBlocksFromMessage(message)
          for (const gateState of gateStates) {
            if (
              gateState.gate !== 'validation/reviewer' ||
              gateState.status !== 'passed'
            ) {
              continue
            }
            const gateFiles = extractPendingFilesFromGateDetails(
              gateState.details,
            )
            if (!gateFileSetsEqual(files, gateFiles)) continue
            const reviewerVerdict = extractReviewerVerdictFromGateDetails(
              gateState.details,
            )
            // Historical NON_BLOCKING conversation passes fail closed; only
            // LOOKS_GOOD may reuse as a conversation gate credit.
            if (reviewerVerdict !== 'LOOKS_GOOD') continue
            latestMatchingPass = { reviewerVerdict }
          }
        }
        return latestMatchingPass
      }

      function extractGateStateBlocksFromMessage(message: unknown): Array<{
        gate: string
        status: string
        details: string
        repairRound?: number
        maxRepairRounds?: number
      }> {
        const texts: string[] = []
        collectMessageText(message, texts)
        const states: Array<{
          gate: string
          status: string
          details: string
          repairRound?: number
          maxRepairRounds?: number
        }> = []
        for (const text of texts) {
          // Non-greedy on purpose: formatGateStateBlock escapes `</` as `<\/`
          // so payload text can never carry a premature closing delimiter, and
          // an unescaped one stays fail-closed below (malformed JSON is
          // ignored) instead of being recovered by a looser match.
          const matches = text.matchAll(/<gate-state>([\s\S]*?)<\/gate-state>/g)
          for (const match of matches) {
            try {
              const parsed = JSON.parse(match[1]) as Record<string, unknown>
              states.push({
                gate: String(parsed.gate ?? ''),
                status: String(parsed.status ?? ''),
                details: String(parsed.details ?? ''),
                ...(typeof parsed.repairRound === 'number'
                  ? { repairRound: parsed.repairRound }
                  : {}),
                ...(typeof parsed.maxRepairRounds === 'number'
                  ? { maxRepairRounds: parsed.maxRepairRounds }
                  : {}),
              })
            } catch {
              // Ignore malformed gate-state blocks; only explicit valid JSON
              // can prove a prior pass.
            }
          }
        }
        return states
      }

      function collectMessageText(value: unknown, out: string[]): void {
        if (!value) return
        if (typeof value === 'string') {
          out.push(value)
          return
        }
        if (Array.isArray(value)) {
          for (const item of value) collectMessageText(item, out)
          return
        }
        if (typeof value !== 'object') return
        const record = value as Record<string, unknown>
        if (typeof record.text === 'string') out.push(record.text)
        if (typeof record.content === 'string') out.push(record.content)
        if (record.type === 'text' && typeof record.value === 'string') {
          out.push(record.value)
        }
        if (record.type === 'json' && 'value' in record) {
          collectMessageText(record.value, out)
        }
        if (Array.isArray(record.content))
          collectMessageText(record.content, out)
      }

      function extractPendingFilesFromGateDetails(details: string): string[] {
        const match = details.match(/\bpending files\s*:\s*([^;\n]+)/i)
        if (!match) return []
        const rawFiles = match[1]
          .split(',')
          .map((file) => file.trim())
          .filter(
            (file) =>
              file.length > 0 &&
              file !== '(unknown files)' &&
              file !== '(unknown)' &&
              file !== '(none)',
          )
        return normalizeGateFileList(rawFiles)
      }

      function extractReviewerVerdictFromGateDetails(
        details: string,
      ): 'LOOKS_GOOD' | '' {
        if (/\bLOOKS_GOOD\b/.test(details)) return 'LOOKS_GOOD'
        return ''
      }

      function messageChangedFiles(message: unknown): boolean {
        return extractChangedFilesFromMessages([message], 0).length > 0
      }

      // Canonical content marker: sha256:<64hex>:<length> for regular files,
      // or symlink-sha256:<64hex>:<length> for safe in-project symlinks.
      // Unreadable/missing/error markers are never attestable.
      function isAttestableContentMarker(value: string): boolean {
        return /^(?:symlink-)?sha256:[a-f0-9]{64}:\d+$/.test(value)
      }

      // A content marker that can be safely credited into the durable gate-ledger.
      // A `missing` marker (a file deleted in the changeset) is a stable,
      // creditable state: the file is absent byte-identical, mirroring how the
      // reviewer attests-by-absence. It is still evicted if the file reappears
      // (the marker becomes a present sha256:... hash and no longer matches),
      // so fail-closed re-review on a reappeared file is preserved. All other
      // non-attestable markers (unreadable:<code>, missing-crypto, etc.) remain
      // excluded so they can never grant durable gate credit.
      function isCreditableContentMarker(value: string): boolean {
        return isAttestableContentMarker(value) || value === 'missing'
      }

      function hasFreshGateFingerprintForPendingFiles(
        files: string[],
        validationSummary: string,
      ): boolean {
        if (files.length === 0) return false
        if (!gateFileSetsEqual(files, activeWorkState.gatePassedPendingFiles)) {
          return false
        }
        // Fail closed when no fingerprint was recorded (older serialized state
        // or a gate pass that never wrote a fingerprint). Reusing on file-set
        // match alone would let same-path content changes silently bypass the
        // reviewer/validation gate.
        const recorded = activeWorkState.gatePassedFingerprint
        if (!recorded) return false
        // Non-attestable fingerprints (unreadable:no-crypto, etc.) can never
        // be reused as durable gate credit.
        if (!isAttestableSnapshotFingerprint(recorded)) return false
        const currentFingerprint = buildGateFingerprint(
          files,
          validationSummary,
        )
        if (!isAttestableSnapshotFingerprint(currentFingerprint)) return false
        return recorded === currentFingerprint
      }

      function hasDurableGatePassForPendingFiles(files: string[]): boolean {
        if (!reviewerFinalizationVerdictFromDurablePass()) return false
        return hasFreshGateFingerprintForPendingFiles(
          files,
          activeWorkState.gatePassedValidationSummary ||
            activeWorkState.lastValidationSummary ||
            'No configured file-change hooks ran.',
        )
      }

      function reviewerFinalizationVerdictFromDurablePass(): 'LOOKS_GOOD' | '' {
        // Historical NON_BLOCKING durable passes fail closed: only LOOKS_GOOD
        // may reuse as a durable finalization credit.
        if (activeWorkState.gatePassedReviewerVerdict === 'LOOKS_GOOD') {
          return 'LOOKS_GOOD'
        }
        return ''
      }

      function formatPinnedFileList(files: string[], cap = 8): string {
        if (files.length === 0) return ''
        if (files.length <= cap) return files.join(', ')
        const shown = files.slice(0, cap)
        return `${shown.join(', ')} +${files.length - cap} more`
      }

      function buildPinnedActiveWorkMessage(
        state: Base2ActiveWorkState,
      ): string {
        const workflowTodoProgress = state.workflowTodoProgress
        const hasIncompleteWorkflowTodos =
          !!workflowTodoProgress &&
          workflowTodoProgress.nextWorkflowAction.trim().length > 0
        const unreviewedDirty = state.unreviewedDirtyReviewableFiles ?? []
        const dirtyReviewableCount =
          typeof state.dirtyReviewableCount === 'number'
            ? state.dirtyReviewableCount
            : unreviewedDirty.length
        const nonReviewableDirty = state.nonReviewableDirtyTaskFiles ?? []
        // Historical dirty task files on an idle phase are not gate lag — only
        // false final_response_allowed (or active gate phases) surface lag.
        const hasDirtyGateLag =
          unreviewedDirty.length > 0 &&
          (state.currentPhase === 'final_response_allowed' ||
            state.currentPhase === 'awaiting_validation' ||
            state.currentPhase === 'awaiting_review' ||
            state.currentPhase === 'repair_loop' ||
            state.pendingGateFiles.length > 0)
        const hasUnresolvedGateWork =
          state.openReviewerBlockers.length > 0 ||
          state.pendingGateFiles.length > 0 ||
          state.nextRequiredAction.trim().length > 0 ||
          state.lastReviewerGateSkipReason.trim().length > 0 ||
          state.currentPhase === 'blocked' ||
          state.currentPhase === 'awaiting_validation' ||
          state.currentPhase === 'awaiting_review' ||
          hasDirtyGateLag
        if (!hasUnresolvedGateWork && !hasIncompleteWorkflowTodos) return ''

        const sections: string[] = [`Current phase: ${state.currentPhase}`]
        // P2: if phase claims PASSED but unreviewed dirty lag remains, still
        // show GATE: PENDING / lag warning rather than a clean PASSED.
        if (hasUnresolvedGateWork) {
          sections.push(
            [
              'GATE: PENDING',
              `phase: ${state.currentPhase}`,
              `hooks summary present: ${state.lastValidationSummary ? 'yes' : 'no'}`,
              'allowed actions: finish implementation work, then end your turn',
              'blocked actions: git-committer, suggest_followups, claiming the gate is running',
              'local checks (basher/typecheck) are not the gate',
              hasDirtyGateLag
                ? 'lag warning: unreviewed dirty reviewable files keep the gate from staying PASSED'
                : 'This is a durable turn-start snapshot; the runtime advances the gate when you end your turn.',
            ].join('\n'),
          )
        } else if (
          hasIncompleteWorkflowTodos &&
          state.currentPhase === 'final_response_allowed'
        ) {
          sections.push(
            [
              'GATE: PASSED',
              `phase: ${state.currentPhase}`,
              'allowed actions: final summary, optional git-committer (with owned_paths), then suggest_followups as absolute last tool',
            ].join('\n'),
          )
        }
        if (dirtyReviewableCount > 0 || unreviewedDirty.length > 0) {
          sections.push(
            `dirty reviewable: ${dirtyReviewableCount} (unreviewed: ${unreviewedDirty.length})`,
          )
        }
        if (unreviewedDirty.length > 0) {
          sections.push(
            `unreviewed dirty reviewable: ${formatPinnedFileList(unreviewedDirty)}`,
          )
        }
        if (nonReviewableDirty.length > 0) {
          sections.push(
            `non-reviewable dirty (excluded from gate, not covered by review): ${formatPinnedFileList(nonReviewableDirty)}`,
          )
        }
        if (
          typeof state.gateProgressLine === 'string' &&
          state.gateProgressLine.length > 0
        ) {
          sections.push(`Gate progress: ${state.gateProgressLine}`)
        }
        // Durable recovery surface for the current gate-issued plan-task receipt
        // ID. A receipt is superseded when the work it covers changes, so the ID
        // printed in an earlier gate-pass message goes stale; the pinned block
        // survives context compaction, which makes this the reliable place to
        // re-read the live one. Omitted entirely with no claimed task or no
        // matching receipt.
        const pinnedPlanTaskId = state.activePlanTaskId
        const pinnedPlanTaskReceipt =
          typeof pinnedPlanTaskId === 'string' && pinnedPlanTaskId.length > 0
            ? readPlanTaskGateReceipts(state.planTaskGateReceipts).find(
                (receipt) => receipt.taskId === pinnedPlanTaskId,
              )
            : undefined
        if (pinnedPlanTaskReceipt) {
          sections.push(
            `Live plan-task gate receipt: ${pinnedPlanTaskReceipt.receiptId} (task ${pinnedPlanTaskReceipt.taskId}, evidence ${pinnedPlanTaskReceipt.evidence})`,
          )
        }
        if (hasUnresolvedGateWork) {
          sections.push(
            'suggest_followups: BLOCKED — GATE: PENDING. End your turn; call suggest_followups only after GATE: PASSED.',
          )
        }
        if (state.openReviewerBlockers.length > 0) {
          sections.push(
            [
              'Open reviewer blockers/feedback (verbatim; controlling next action):',
              ...state.openReviewerBlockers.map((blocker) => blocker.trim()),
            ].join('\n'),
          )
        }
        if ((state.openReviewerFindings?.length ?? 0) > 0) {
          sections.push(
            [
              'Open reviewer finding records (runtime-owned; only a fresh matching review may clear them):',
              ...(state.openReviewerFindings ?? []).map(
                (finding) =>
                  `${finding.id} [${finding.status}] snapshot=${finding.snapshotFingerprint.slice(0, 16)} files=${finding.files.join(', ')} :: ${finding.text}`,
              ),
              'Every repair edit must explicitly address one or more open finding IDs. Do not declare these records stale from conversational memory.',
            ].join('\n'),
          )
        }
        if ((state.validationEvidence?.length ?? 0) > 0) {
          sections.push(
            [
              'Scoped validation evidence (does not clear reviewer findings by itself):',
              ...(state.validationEvidence ?? []).map(
                (evidence) =>
                  `${evidence.gateId.slice(0, 16)} assurance=${evidence.assurance} files=${evidence.files.join(', ')} :: ${evidence.summary}`,
              ),
            ].join('\n'),
          )
        }
        if (state.pendingGateFiles.length > 0) {
          sections.push(
            `Pending validation/reviewer gate files: ${state.pendingGateFiles.join(', ')}`,
          )
        }
        if (state.lastValidationSummary && state.pendingGateFiles.length > 0) {
          sections.push(
            `Last validation summary: ${state.lastValidationSummary}`,
          )
        }
        if (state.nextRequiredAction) {
          sections.push(`Next required action: ${state.nextRequiredAction}`)
        }
        if (state.lastReviewerGateSkipReason) {
          sections.push(
            `Last reviewer gate skip/error reason: ${state.lastReviewerGateSkipReason}`,
          )
        }
        if (hasIncompleteWorkflowTodos) {
          sections.push(
            [
              'Workflow todo progress (authoritative resumable state):',
              `Completed ${workflowTodoProgress.completedCount}/${workflowTodoProgress.totalCount}.`,
              `Next workflow action: ${workflowTodoProgress.nextWorkflowAction}`,
              'Continue from this item; do not restart earlier completed workflow steps. Mark this item complete with write_todos once it is actually completed before moving to a different workflow item.',
            ].join('\n'),
          )
        }
        return [
          'Harness pinned active-work state (controlling state; do not ignore):',
          'This generated state survives context compaction and overrides stale summarized dialogue.',
          'Role: root orchestrator. Do not call set_output. Use only tools currently exposed by the runtime.',
          ...sections,
        ].join('\n\n')
      }

      function buildReviewerFindingId(text: string, index: number): string {
        let hash = 2166136261
        for (let i = 0; i < text.length; i += 1) {
          hash ^= text.charCodeAt(i)
          hash = Math.imul(hash, 16777619)
        }
        return `RF-${index + 1}-${(hash >>> 0).toString(16).padStart(8, '0')}`
      }

      function extractChangedFiles(toolResult: unknown): string[] {
        const out = new Set<string>()
        visitToolValue(toolResult, out)
        return normalizeGateFileList([...out])
      }

      function updateWorkflowTodoProgressFromMessages(messages: unknown): void {
        const progress = extractLatestWorkflowTodoProgress(messages)
        if (!progress) return
        const currentProgress = activeWorkState.workflowTodoProgress
        const progressChanged = !workflowTodoProgressEquals(
          currentProgress,
          progress,
        )
        activeWorkState.workflowTodoProgress = progress
        if (progressChanged) markActiveWorkStateChanged()
      }

      // EXECUTE_PLAN active-task tracking. The claimed PLAN.md task is what
      // binds a gate pass to ONE plan task, so the gate-pass path can mint a
      // per-task validation receipt the runtime later verifies a
      // `update_plan_status` checkpoint against. Same structure as
      // extractLatestWorkflowTodoProgress / updateWorkflowTodoProgressFromMessages
      // (walk history for a tool call, pair it with its SUCCESSFUL result,
      // derive durable state, write it only on change), including the shared
      // toolCallSucceeded result check. Self-contained inline helpers because
      // handleSteps is serialized via .toString() + new Function(...), so they
      // must not reference module-scope imports; `function` declarations hoist
      // above both call sites (turn start and the post-STEP messageHistory
      // block), which appear earlier in the source.
      //
      // Local type aliases so BOTH annotations below stay bracket-free tokens:
      // agents/__tests__/helpers/extract-inline-function-source.ts cannot slice
      // a return annotation that opens with a leading `|` union (it would emit a
      // body-less signature TypeScript erases as an overload, and the helper is
      // then missing at runtime). `boundWorkflowProgress` is the same precedent.
      type ActivePlanTaskId = string | undefined
      type PlanTaskClaimIntent = {
        /** Normalized stable ID this call claimed, or '' when it claimed none. */
        claimed: string
        /** True when the call explicitly emptied the currentTask pointer. */
        cleared: boolean
        /** Normalized stable IDs this call moved to done/cancelled. */
        completed: string[]
      }

      // Normalize a raw currentTask / taskId / task pointer to its leading
      // stable-ID token: trim, then keep the text before the first whitespace or
      // ':' (which also covers the ' — ' form). `"P2-T3 Implement the thing"`
      // therefore becomes `"P2-T3"`, mirroring how validatePlanTransition
      // matches a currentTask pointer against a task id (`=== id`,
      // `startsWith(id + ' ')`, `startsWith(id + ':')`,
      // `startsWith(id + ' —')`). Deliberately conservative: splitting on '-'
      // would corrupt a legitimate ID such as `P2-T3`.
      function normalizePlanTaskPointer(value: unknown): string {
        if (typeof value !== 'string') return ''
        const trimmed = value.trim()
        if (!trimmed) return ''
        const separator = trimmed.search(/[\s:]/)
        return separator < 0 ? trimmed : trimmed.slice(0, separator)
      }

      function extractPlanTaskClaimIntent(input: unknown): PlanTaskClaimIntent {
        const intent: PlanTaskClaimIntent = {
          claimed: '',
          cleared: false,
          completed: [],
        }
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          return intent
        }
        const record = input as Record<string, unknown>
        const rawUpdates = Array.isArray(record.updates) ? record.updates : []
        for (const update of rawUpdates) {
          if (!update || typeof update !== 'object') continue
          const entry = update as Record<string, unknown>
          const pointer = normalizePlanTaskPointer(entry.taskId ?? entry.task)
          if (!pointer) continue
          if (entry.status === 'in_progress') {
            // LAST in_progress entry wins: at most one task may be in progress,
            // so a later entry in the same atomic call supersedes an earlier one.
            intent.claimed = pointer
          } else if (entry.status === 'done' || entry.status === 'cancelled') {
            intent.completed.push(pointer)
          }
        }
        if (typeof record.currentTask === 'string') {
          // The explicit pointer wins over a derived in_progress entry, matching
          // the handler's own currentTask-then-fallback precedence.
          const pointer = normalizePlanTaskPointer(record.currentTask)
          if (pointer) {
            intent.claimed = pointer
          } else if (record.currentTask.trim().length === 0) {
            intent.claimed = ''
            intent.cleared = true
          }
        }
        return intent
      }

      function extractActivePlanTaskIdFromMessages(
        messages: unknown,
      ): ActivePlanTaskId {
        // Seeded from durable state so a task claimed in an earlier turn (or
        // before context compaction dropped its tool call) stays claimed until
        // a successful call clears it.
        let activeTaskId = activeWorkState.activePlanTaskId
        if (!Array.isArray(messages)) return activeTaskId
        const pendingToolCalls = new Map<string, PlanTaskClaimIntent>()

        for (const message of messages) {
          if (!message || typeof message !== 'object') continue
          const record = message as Record<string, unknown>
          if (record.role === 'assistant' && Array.isArray(record.content)) {
            for (const part of record.content) {
              if (!part || typeof part !== 'object') continue
              const toolCall = part as Record<string, unknown>
              if (toolCall.type !== 'tool-call') continue
              const toolName =
                typeof toolCall.toolName === 'string' ? toolCall.toolName : ''
              if (toolName !== 'update_plan_status') continue
              const toolCallId =
                typeof toolCall.toolCallId === 'string'
                  ? toolCall.toolCallId
                  : ''
              if (!toolCallId) continue
              pendingToolCalls.set(
                toolCallId,
                extractPlanTaskClaimIntent(toolCall.input),
              )
            }
          }

          if (record.role !== 'tool') continue
          const toolCallId =
            typeof record.toolCallId === 'string' ? record.toolCallId : ''
          const intent = pendingToolCalls.get(toolCallId)
          if (!intent) continue
          // Fail closed on a rejected transition: the runtime handler refuses a
          // plan update atomically, so a claim it never applied must not let the
          // gate mint a receipt for that task.
          //
          // The handler's own POINTER-only messages are opted in here: a call
          // that only manipulates `currentTask` (no `updates`) returns exactly
          // `Current task pointer cleared.` or `Current task -> "<task>".`, which
          // match none of the shared success verbs. Without this the shared
          // predicate rejected the handler's own success message, so a
          // pointer-only release left `activePlanTaskId` stale and later gate
          // passes kept minting and printing receipts for a RELEASED task —
          // contradicting the documented contract in gate-state.ts ("Cleared when
          // a successful call empties `currentTask`") — while a pointer-only claim
          // was never recorded at all, so no receipt could be minted for it. The
          // failure-word veto inside toolCallSucceeded still rejects
          // `No changes applied.` and every `errorMessage` refusal.
          if (!toolCallSucceeded(record.content, /\bcurrent task\b/i)) continue
          if (intent.claimed) {
            activeTaskId = intent.claimed
          } else if (intent.cleared) {
            activeTaskId = undefined
          }
          // Completing (or cancelling) the claimed task releases the claim, so a
          // later gate pass cannot keep minting receipts for a finished task.
          if (activeTaskId && intent.completed.includes(activeTaskId)) {
            activeTaskId = undefined
          }
        }

        return activeTaskId
      }

      function updateActivePlanTaskFromMessages(messages: unknown): void {
        const nextActiveTaskId = extractActivePlanTaskIdFromMessages(messages)
        if (activeWorkState.activePlanTaskId === nextActiveTaskId) return
        activeWorkState.activePlanTaskId = nextActiveTaskId
        markActiveWorkStateChanged()
      }

      // Detects an exact standalone "COMMIT ANYWAY" user message and publishes
      // a durable session-scoped bypass flag for the git-committer
      // uncommitted-unvalidated-files commit guard in the tool executor. Text
      // extraction mirrors hasReviewerBypassAuthorization (collectMessageText
      // over user message content) and the match is a trim/uppercase
      // exact-phrase compare only — never a substring match, so prose like
      // "please commit anyway now" cannot authorize the bypass. Session-
      // durable and scoped: once authorized it stays set for the rest of the
      // session, but the tool executor skips the guard ONLY for the files
      // recorded in commitScopeBypassRecord.unvalidatedFiles at authorization
      // time — files dirtied after authorization remain blocked. Self-
      // contained inline helper:
      // handleSteps is serialized via .toString() + new Function(...), so it
      // must not reference module-scope imports.
      function updateCommitScopeBypassFromMessages(messages: unknown): void {
        if (mutableAgentState.commitScopeBypassAuthorized === true) return
        if (!Array.isArray(messages)) return
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index]
          if (!message || typeof message !== 'object') continue
          const record = message as Record<string, unknown>
          if (record.role !== 'user') continue
          const texts: string[] = []
          collectMessageText(record.content, texts)
          if (
            !texts.some((text) => text.trim().toUpperCase() === 'COMMIT ANYWAY')
          ) {
            continue
          }
          mutableAgentState.commitScopeBypassAuthorized = true
          mutableAgentState.commitScopeBypassRecord = {
            reason:
              'User authorized COMMIT ANYWAY to bypass the uncommitted-unvalidated-files commit guard',
            authorizedAt: new Date().toISOString(),
            unvalidatedFiles: [
              ...(mutableAgentState.uncommittedUnvalidatedFiles ?? []),
            ],
          }
          markActiveWorkStateChanged()
          return
        }
      }

      function extractLatestWorkflowTodoProgress(
        messages: unknown,
      ): Base2WorkflowTodoProgress | undefined {
        if (!Array.isArray(messages)) return undefined
        let latestTodos: Base2WorkflowTodo[] | undefined
        const pendingToolCalls = new Map<string, Base2WorkflowTodo[]>()

        for (const message of messages) {
          if (!message || typeof message !== 'object') continue
          const record = message as Record<string, unknown>
          if (record.role === 'assistant' && Array.isArray(record.content)) {
            for (const part of record.content) {
              if (!part || typeof part !== 'object') continue
              const toolCall = part as Record<string, unknown>
              if (toolCall.type !== 'tool-call') continue
              const toolName =
                typeof toolCall.toolName === 'string' ? toolCall.toolName : ''
              if (toolName !== 'write_todos') continue
              const todos = extractWorkflowTodosFromValue(toolCall.input)
              if (todos.length === 0) continue
              latestTodos = todos
              const toolCallId =
                typeof toolCall.toolCallId === 'string'
                  ? toolCall.toolCallId
                  : ''
              if (toolCallId) pendingToolCalls.set(toolCallId, todos)
            }
          }

          if (record.role !== 'tool') continue
          const toolName =
            typeof record.toolName === 'string' ? record.toolName : ''
          const toolCallId =
            typeof record.toolCallId === 'string' ? record.toolCallId : ''
          if (toolName !== 'write_todos' && !pendingToolCalls.has(toolCallId)) {
            continue
          }
          const resultTodos = extractWorkflowTodosFromValue(record.content)
          if (resultTodos.length > 0) {
            latestTodos = resultTodos
            continue
          }
          const callTodos = pendingToolCalls.get(toolCallId)
          if (callTodos && toolCallSucceeded(record.content))
            latestTodos = callTodos
        }

        return buildWorkflowTodoProgress(latestTodos)
      }

      function extractWorkflowTodosFromValue(
        value: unknown,
      ): Base2WorkflowTodo[] {
        const todos = findWorkflowTodoArray(value)
        if (!todos) return []
        const normalizedTodos: Base2WorkflowTodo[] = []
        for (const todo of todos) {
          if (!todo || typeof todo !== 'object') continue
          const record = todo as Record<string, unknown>
          const content = getWorkflowTodoContent(record)
          if (!content) continue
          const status = getWorkflowTodoStatus(record)
          normalizedTodos.push({
            content,
            status,
            completed: status === 'completed',
          })
        }
        return normalizedTodos
      }

      function findWorkflowTodoArray(value: unknown): unknown[] | undefined {
        if (!value) return undefined
        if (Array.isArray(value)) {
          if (value.some(isWorkflowTodoLike)) return value
          for (const item of value) {
            const nestedTodos = findWorkflowTodoArray(item)
            if (nestedTodos) return nestedTodos
          }
          return undefined
        }
        if (typeof value !== 'object') return undefined
        const record = value as Record<string, unknown>
        if (record.type === 'json' && 'value' in record) {
          const jsonTodos = findWorkflowTodoArray(record.value)
          if (jsonTodos) return jsonTodos
        }
        const directTodos = record.todos
        if (
          Array.isArray(directTodos) &&
          directTodos.some(isWorkflowTodoLike)
        ) {
          return directTodos
        }
        for (const nested of Object.values(record)) {
          const nestedTodos = findWorkflowTodoArray(nested)
          if (nestedTodos) return nestedTodos
        }
        return undefined
      }

      function isWorkflowTodoLike(value: unknown): boolean {
        if (!value || typeof value !== 'object') return false
        const record = value as Record<string, unknown>
        return getWorkflowTodoContent(record).length > 0
      }

      function getWorkflowTodoContent(record: Record<string, unknown>): string {
        const content =
          record.content ?? record.text ?? record.title ?? record.task
        return typeof content === 'string' ? content.trim() : ''
      }

      function getWorkflowTodoStatus(record: Record<string, unknown>): string {
        const status = record.status ?? record.state
        if (typeof status === 'string') return status.trim().toLowerCase()
        if (record.completed === true || record.done === true)
          return 'completed'
        if (record.completed === false || record.done === false)
          return 'pending'
        return 'pending'
      }

      function buildWorkflowTodoProgress(
        todos: Base2WorkflowTodo[] | undefined,
      ): Base2WorkflowTodoProgress | undefined {
        if (!todos || todos.length === 0) return undefined
        const completedCount = todos.filter((todo) => todo.completed).length
        const firstIncomplete = todos.find((todo) => !todo.completed)
        return {
          todos,
          completedCount,
          totalCount: todos.length,
          nextWorkflowAction: firstIncomplete?.content ?? '',
        }
      }

      function normalizeWorkflowTodoProgress(
        progress: Base2WorkflowTodoProgress | undefined,
      ): Base2WorkflowTodoProgress | undefined {
        if (!progress || !Array.isArray(progress.todos)) return undefined
        return buildWorkflowTodoProgress(
          progress.todos.map((todo) => ({
            content: todo.content.trim(),
            status: todo.status.trim().toLowerCase(),
            completed: todo.completed,
          })),
        )
      }

      function workflowTodoProgressEquals(
        left: Base2WorkflowTodoProgress | undefined,
        right: Base2WorkflowTodoProgress | undefined,
      ): boolean {
        if (!left || !right) return left === right
        if (
          left.completedCount !== right.completedCount ||
          left.totalCount !== right.totalCount ||
          left.nextWorkflowAction !== right.nextWorkflowAction ||
          left.todos.length !== right.todos.length
        ) {
          return false
        }
        return left.todos.every((todo, index) => {
          const other = right.todos[index]
          return (
            todo.content === other.content &&
            todo.status === other.status &&
            todo.completed === other.completed
          )
        })
      }

      // `extraSuccessPattern` is an OPT-IN per-call-site success verb, consulted
      // only after the shared failure-word veto below and only when the shared
      // verb list did not already match. It exists because that list
      // (success|updated|wrote|written|saved) does not cover every handler's own
      // success message — see the plan-task claim tracker, whose pointer-only
      // `update_plan_status` results are exactly `Current task -> "<task>".` and
      // `Current task pointer cleared.` — and broadening the shared list would
      // change the verdict for every other consumer (workflow-todo progress
      // included). Callers that pass nothing keep the previous behavior
      // unchanged. Pass a NON-global pattern: `RegExp.test` is stateful for /g.
      function toolCallSucceeded(
        value: unknown,
        extraSuccessPattern?: RegExp,
      ): boolean {
        if (!value) return false
        // Explicit arrow, never a bare `value.some(toolCallSucceeded)`: `.some`
        // passes the element INDEX as the second argument, which would arrive
        // here as `extraSuccessPattern` and throw on `.test`.
        if (Array.isArray(value)) {
          return value.some((item) =>
            toolCallSucceeded(item, extraSuccessPattern),
          )
        }
        if (typeof value !== 'object') return false
        const record = value as Record<string, unknown>
        if (record.type === 'json' && 'value' in record) {
          return toolCallSucceeded(record.value, extraSuccessPattern)
        }
        if (
          record.success === false ||
          'error' in record ||
          'errorMessage' in record
        ) {
          return false
        }
        if (record.success === true) return true
        if (typeof record.message === 'string') {
          // Only trust the success-verb regex when the message does not itself
          // contain a failure indicator, otherwise messages like "No updates
          // were saved" would false-positive on "saved". The veto guards
          // extraSuccessPattern too, so an opt-in verb can never credit a message
          // the handler used to report that nothing was applied (e.g.
          // `No changes applied.`).
          if (
            /\b(failed|failure|unable|could not|cannot|did not|was not|were not|skipped|no[- ]op|no changes|error)\b/i.test(
              record.message,
            )
          ) {
            return false
          }
          if (
            /\b(success|successful|updated|wrote|written|saved)\b/i.test(
              record.message,
            )
          ) {
            return true
          }
          return (
            extraSuccessPattern !== undefined &&
            extraSuccessPattern.test(record.message)
          )
        }
        return Object.keys(record).length > 0
      }

      function extractChangedFilesFromMessages(
        messages: unknown,
        startIndex: number,
      ): string[] {
        if (!Array.isArray(messages)) return []
        const out = new Set<string>()
        for (const message of messages.slice(startIndex)) {
          if (!message || typeof message !== 'object') continue
          const record = message as Record<string, unknown>
          if (!Array.isArray(record.content)) continue

          if (record.role === 'assistant') {
            for (const part of record.content) {
              if (!part || typeof part !== 'object') continue
              const toolCall = part as Record<string, unknown>
              if (
                toolCall.type === 'tool-call' &&
                typeof toolCall.toolName === 'string' &&
                isFileChangingTool(toolCall.toolName)
              ) {
                collectToolInputFiles(toolCall.input, out)
              }
            }
          }
          if (record.role === 'tool') {
            visitToolValue(record.content, out)
          }
        }
        return normalizeGateFileList([...out])
      }

      function visitToolValue(value: unknown, out: Set<string>): void {
        if (!value) return
        if (Array.isArray(value)) {
          for (const item of value) visitToolValue(item, out)
          return
        }
        if (typeof value !== 'object') return

        const record = value as Record<string, unknown>
        if (record.type === 'json' && 'value' in record) {
          visitToolValue(record.value, out)
        }
        if (hasEditArtifact(record)) {
          for (const action of record.actions as Array<
            Record<string, unknown>
          >) {
            if (action.outcome !== 'applied') continue
            if (typeof action.path === 'string') out.add(action.path)
            if (
              action.action === 'move' &&
              typeof action.destinationPath === 'string'
            ) {
              out.add(action.destinationPath)
            }
          }
        }
        // P1: adopt agent receipt changedFiles (multi-file editor spawn batches
        // that only surface agentReceipt.changedFiles, without a file_mutation_result).
        collectAgentReceiptChangedFiles(record, out)
        for (const nested of Object.values(record)) {
          visitToolValue(nested, out)
        }
      }

      // Collect paths from a schemaVersion=1 agent receipt or a runtime
      // envelope with agentReceipt. Paths may be strings or { path: string }.
      // Self-contained inline helper (handleSteps is serialized).
      function collectAgentReceiptChangedFiles(
        record: Record<string, unknown>,
        out: Set<string>,
      ): void {
        const collectFromChangedFiles = (changedFiles: unknown): void => {
          if (!Array.isArray(changedFiles)) return
          for (const item of changedFiles) {
            if (typeof item === 'string' && item.trim()) {
              out.add(item)
              continue
            }
            if (item && typeof item === 'object') {
              const path = (item as Record<string, unknown>).path
              if (typeof path === 'string' && path.trim()) out.add(path)
            }
          }
        }
        const isAgentReceipt = (candidate: Record<string, unknown>): boolean =>
          candidate.schemaVersion === 1 &&
          typeof candidate.receiptId === 'string' &&
          Array.isArray(candidate.changedFiles)
        if (isAgentReceipt(record)) {
          collectFromChangedFiles(record.changedFiles)
        }
        if (
          record.agentReceipt &&
          typeof record.agentReceipt === 'object' &&
          !Array.isArray(record.agentReceipt)
        ) {
          const receipt = record.agentReceipt as Record<string, unknown>
          if (isAgentReceipt(receipt)) {
            collectFromChangedFiles(receipt.changedFiles)
          } else if (Array.isArray(receipt.changedFiles)) {
            // Runtime envelopes may omit schemaVersion on a nested receipt;
            // still adopt changedFiles when present.
            collectFromChangedFiles(receipt.changedFiles)
          }
        }
      }

      function collectToolInputFiles(input: unknown, out: Set<string>): void {
        if (!input || typeof input !== 'object') return
        const record = input as Record<string, unknown>
        if (typeof record.path === 'string') out.add(record.path)
        const operation = record.operation
        const operationItems = Array.isArray(operation)
          ? operation
          : operation && typeof operation === 'object'
            ? [operation]
            : []
        for (const item of operationItems) {
          if (
            item &&
            typeof item === 'object' &&
            typeof (item as Record<string, unknown>).path === 'string'
          ) {
            out.add((item as Record<string, string>).path)
          }
        }
        const edits = record.edits
        if (Array.isArray(edits)) {
          for (const edit of edits) {
            if (
              edit &&
              typeof edit === 'object' &&
              typeof (edit as Record<string, unknown>).path === 'string'
            ) {
              out.add((edit as Record<string, string>).path)
            }
          }
        }
      }

      function isFileChangingTool(toolName: string): boolean {
        return (
          toolName === 'apply_patch' ||
          toolName === 'apply_smart_patch' ||
          toolName === 'edit_transaction' ||
          toolName === 'replace_range' ||
          toolName === 'rewrite_symbol' ||
          toolName === 'str_replace' ||
          toolName === 'write_file'
        )
      }

      // Trimmed inline gate check: it verifies only the evidence the gate
      // needs before it credits an action path — canonical kind/version, a
      // non-empty operationId, a recognised authorityTier, an accepted
      // outcome, an authorityReceipt whose operationId/receiptId match the
      // record, and at least one applied action with a string path.
      //
      // Canonical checks in agents/base2/gate-files.ts (fileMutationResultV1
      // schema + getConfirmedAppliedActionsV1) that are intentionally NOT
      // mirrored here, so the sync surface for future schema edits is bounded:
      //   - authorityReceipt.finalHashes presence / per-path correlation
      //   - per-action committed-status correlation in the authority receipt
      //   - action beforeHash/afterHash consistency across record + receipt
      //   - equal action-array lengths and per-index actionId correlation
      //   - errors / freshCapabilities array shape
      // The accepted-outcome set MUST stay identical to canonical
      // (applied | partial | rollback_incomplete), and the authorityReceipt id
      // match MUST stay. agents/__tests__/gate-files-parity.test.ts is the
      // guard for both.
      function hasEditArtifact(record: Record<string, unknown>): boolean {
        const authorityReceipt =
          record.authorityReceipt &&
          typeof record.authorityReceipt === 'object' &&
          !Array.isArray(record.authorityReceipt)
            ? (record.authorityReceipt as Record<string, unknown>)
            : null
        return (
          record.kind === 'file_mutation_result' &&
          record.version === 1 &&
          typeof record.operationId === 'string' &&
          record.operationId.length > 0 &&
          (record.authorityTier === 'portable_path' ||
            record.authorityTier === 'conditional_commit') &&
          (record.outcome === 'applied' ||
            record.outcome === 'partial' ||
            record.outcome === 'rollback_incomplete') &&
          Array.isArray(record.actions) &&
          authorityReceipt !== null &&
          authorityReceipt.operationId === record.operationId &&
          authorityReceipt.receiptId === record.receiptId &&
          record.actions.some(
            (action) =>
              action !== null &&
              typeof action === 'object' &&
              (action as Record<string, unknown>).outcome === 'applied' &&
              typeof (action as Record<string, unknown>).path === 'string',
          )
        )
      }

      function extractGitStatusFiles(toolResult: unknown): string[] {
        const files = new Set<string>()
        if (!Array.isArray(toolResult)) return []
        for (const part of toolResult) {
          const value =
            part && (part as any).type === 'json'
              ? (part as any).value
              : undefined
          const status =
            value && typeof value === 'object'
              ? (value as Record<string, unknown>).status
              : undefined
          if (typeof status !== 'string') continue
          for (const line of status.split('\n')) {
            const file = parseGitStatusLine(line)
            if (file) files.add(file)
          }
        }
        return normalizeGateFileList([...files])
      }

      // Credit files into the local gate-passed ledger AND record the content
      // marker captured at credit time, so the generalized per-file eviction
      // guard can detect later drift and reopen the gate for exactly the
      // re-edited file. Reuses the existing single-file readGateFileContentMarker
      // helper. Self-contained inline helper (handleSteps is serialized via
      // .toString() + new Function(...), so it must not reference module-scope
      // imports).
      function creditGatePassedFiles(files: string[]): void {
        const markers = (activeWorkState.gatePassedFileMarkers ??= {})
        for (const file of files) {
          const marker = readGateFileContentMarker(file)
          // Only credit files with creditable content markers. A `missing`
          // marker (a file deleted in the changeset) is credited as-is so the
          // gate does not re-arm forever on a stable deletion; external
          // symlinks, unreadable files, and missing-crypto states produce
          // non-attestable markers that must never enter the durable ledger.
          if (!isCreditableContentMarker(marker)) continue
          gatePassedFiles.add(file)
          markers[file] = marker
        }
      }

      // Task-related path ledger used by gate scope, P0 unreviewed re-arm, and
      // P3 unvalidated publication. Inline because handleSteps is serialized.
      function collectTaskRelatedFiles(): Set<string> {
        return new Set(
          normalizeGateFileList([
            ...activeWorkState.touchedFiles,
            ...activeWorkState.changedFiles,
            ...activeWorkState.pendingGateFiles,
            ...activeWorkState.gatePassedFiles,
          ]),
        )
      }

      // Reviewable dirty task files not credited into gatePassedFiles. Used for
      // the git-committer uncommittedUnvalidatedFiles publish (P3) and pin lag
      // counts. Includes already-pending files so mid-gate dirty still blocks
      // commit of never-credited paths.
      function collectUnvalidatedDirtyReviewableFiles(
        dirtyFiles: string[],
      ): string[] {
        const taskRelated = collectTaskRelatedFiles()
        return selectReviewableGateFiles(dirtyFiles).filter(
          (file) => taskRelated.has(file) && !gatePassedFiles.has(file),
        )
      }

      // Subset of unvalidated dirty that is not already pending — only these
      // represent "false PASSED" lag that must re-arm (P0). Already-pending
      // files are mid-gate and must not re-touch/clear durable fingerprints.
      function collectUnreviewedDirtyReviewableFiles(
        dirtyFiles: string[],
      ): string[] {
        return collectUnvalidatedDirtyReviewableFiles(dirtyFiles).filter(
          (file) => !pendingGateFiles.has(file),
        )
      }

      // Task-related dirty paths excluded from the code-reviewer gate (docs,
      // session artifacts, config). Pin surfaces them as excluded; they must
      // not enter uncommittedUnvalidatedFiles (P3).
      function collectNonReviewableDirtyTaskFiles(
        dirtyFiles: string[],
      ): string[] {
        const taskRelated = collectTaskRelatedFiles()
        return normalizeGateFileList(dirtyFiles).filter(
          (file) => taskRelated.has(file) && !isReviewableGateFile(file),
        )
      }

      // Shared re-arm path for turn-start and every-iteration P0 fail-closed.
      function rearmGateForUnreviewedDirty(unreviewed: string[]): void {
        if (unreviewed.length === 0) return
        recordChangedFiles(unreviewed)
        editsHappened = true
        finalResponseGateOpen = false
        mutableAgentState.canSuggestFollowups = false
        activeWorkState.currentPhase = 'awaiting_validation'
        activeWorkState.latestWorkSummary = `Unreviewed dirty reviewable files reopened the gate: ${unreviewed.join(', ')}`
        markActiveWorkStateChanged()
      }

      // Derive the cumulative final-gate scope from the live dirty set and the
      // complete task-related path ledger. Already-credited (gatePassedFiles)
      // dirty files stay out of gate scope: they remain dirty for commit UX /
      // uncommittedUnvalidated, but must not re-arm validation/review.
      // Marker eviction + unreviewed re-arm still handle real content drift.
      // Inline because handleSteps is serialized through toString()/new Function().
      function deriveGateScopeFiles(dirtyFiles: string[]): string[] {
        const taskRelatedFiles = collectTaskRelatedFiles()
        return normalizeGateFileList(dirtyFiles).filter(
          (file) => taskRelatedFiles.has(file) && !gatePassedFiles.has(file),
        )
      }

      /**
       * Build a durable gate fingerprint from the normalized pending files,
       * their current git status lines (if known), per-file working-tree
       * content hashes, and the validation summary. The content hash is the
       * decisive component for detecting same-path content changes; status
       * lines remain as supplementary fingerprint context. Files that do not
       * exist contribute a `missing` marker, and files that cannot be read
       * contribute an `unreadable:<code>` marker so the fingerprint fails
       * closed (a previously-passing content hash will not match a missing
       * or unreadable file).
       */
      function buildGateFingerprint(
        files: string[],
        validationSummary: string,
      ): string {
        return hashGateSnapshotDetails(
          buildGateSnapshotDetails(files, validationSummary),
        )
      }

      function buildGateSnapshotDetails(
        files: string[],
        validationSummary: string,
      ): string {
        // Content-only fingerprint: the volatile git status line (e.g. ` M file`)
        // is intentionally excluded. A commit clears the status line but leaves
        // file bytes identical; including it would invalidate the fingerprint on
        // every commit and force a redundant reviewer re-run on unchanged content.
        // The content marker (sha256 of file bytes) is the stable identity signal.
        const sorted = [...files].sort()
        const parts = sorted.map((file) => {
          const contentMarker = readGateFileContentMarker(file)
          return `${file}\t${contentMarker}`
        })
        return `files-v4\n${parts.join('\n')}\n--\n${validationSummary}`
      }

      // Deleted-file extraction from files-v4 snapshot details. A pending file
      // whose content marker is exactly `missing` was deleted in the changeset
      // and cannot be read by the reviewer, so it is attested-by-absence and
      // excluded from the reviewedFiles requirement. Only exact `missing`
      // markers count: `unreadable:<code>` is a present-but-unreadable file
      // that must still be attested (fail closed). Self-contained inline
      // helper (handleSteps is serialized via .toString() + new Function(...),
      // so it must not reference module-scope imports).
      function collectDeletedFilesFromSnapshotDetails(
        details: string,
      ): string[] {
        const deletedFiles: string[] = []
        for (const line of details.split('\n')) {
          // The files-v4 block ends at the `--` separator before the
          // validation summary.
          if (line === '--') break
          const tabIndex = line.indexOf('\t')
          if (tabIndex <= 0) continue
          if (line.slice(tabIndex + 1) === 'missing') {
            deletedFiles.push(line.slice(0, tabIndex))
          }
        }
        return deletedFiles
      }

      /**
       * Resolve a normalized gate file path against process.cwd() and return
       * a deterministic content marker for fingerprinting. Regular files are
       * hashed in fixed-size chunks; symlink markers additionally bind the link
       * path to bytes read from its resolved target. Never throws: scope, read,
       * or stat failures become `unreadable:<code>` markers so stale credit
       * fails closed.
       */
      function readGateFileContentMarker(normalizedPath: string): string {
        if (!normalizedPath) return 'unreadable:empty-path'
        // Resolve built-ins at call time so this stays compatible with
        // serialized handleSteps executions. Prefer process.getBuiltinModule
        // when available because some serialized runtimes do not expose a
        // CommonJS require global.
        const getBuiltinModule =
          typeof process === 'object' &&
          process !== null &&
          'getBuiltinModule' in process &&
          typeof process.getBuiltinModule === 'function'
            ? process.getBuiltinModule.bind(process)
            : undefined
        const req = (globalThis as any).require as NodeJS.Require | undefined
        let fs: typeof import('node:fs')
        let path: typeof import('node:path')
        let crypto: typeof import('node:crypto')
        if (getBuiltinModule) {
          fs = getBuiltinModule('node:fs') as typeof import('node:fs')
          path = getBuiltinModule('node:path') as typeof import('node:path')
          crypto = getBuiltinModule(
            'node:crypto',
          ) as typeof import('node:crypto')
        } else if (typeof req === 'function') {
          fs = req('node:fs')
          path = req('node:path')
          crypto = req('node:crypto')
        } else {
          return 'unreadable:no-module-loader'
        }
        const cwd =
          typeof process === 'object' &&
          process !== null &&
          typeof process.cwd === 'function'
            ? process.cwd()
            : ''
        if (!cwd) return 'unreadable:no-cwd'
        const absolutePath = path.resolve(cwd, normalizedPath)
        const projectRelativePath = path.relative(cwd, absolutePath)
        if (
          projectRelativePath === '..' ||
          projectRelativePath.startsWith(`..${path.sep}`) ||
          path.isAbsolute(projectRelativePath)
        ) {
          return 'unreadable:outside-project'
        }
        try {
          const pathSegments = projectRelativePath
            .split(path.sep)
            .filter(Boolean)
          const symlinkParts: string[] = []
          let entryPath = cwd
          for (let index = 0; index < pathSegments.length; index += 1) {
            entryPath = path.join(entryPath, pathSegments[index])
            const entryStat = fs.lstatSync(entryPath)
            if (entryStat.isSymbolicLink()) {
              symlinkParts.push(`${index}:${fs.readlinkSync(entryPath)}`)
              continue
            }
            if (index < pathSegments.length - 1 && !entryStat.isDirectory()) {
              return 'unreadable:not-a-directory'
            }
            if (index === pathSegments.length - 1 && !entryStat.isFile()) {
              return 'unreadable:not-a-file'
            }
          }
          if (pathSegments.length === 0) return 'unreadable:not-a-file'

          const resolvedPath =
            symlinkParts.length > 0
              ? fs.realpathSync(absolutePath)
              : absolutePath
          // Fail closed BEFORE opening: if the resolved target escapes the
          // project root, reject without reading. This prevents blocking on
          // external FIFOs and unbounded I/O on large external files.
          if (symlinkParts.length > 0) {
            const resolvedRelative = path.relative(cwd, resolvedPath)
            if (
              resolvedRelative === '..' ||
              resolvedRelative.startsWith(`..${path.sep}`) ||
              path.isAbsolute(resolvedRelative)
            ) {
              return 'unreadable:outside-project-symlink'
            }
          }
          const noFollow = fs.constants.O_NOFOLLOW ?? 0
          const fd = fs.openSync(resolvedPath, fs.constants.O_RDONLY | noFollow)
          try {
            const openedStat = fs.fstatSync(fd)
            if (!openedStat.isFile()) return 'unreadable:not-a-file'
            const hash = crypto.createHash('sha256')
            if (symlinkParts.length > 0) {
              hash.update(symlinkParts.join('\0')).update('\0')
            }
            const buffer = Buffer.allocUnsafe(64 * 1024)
            let bytesReadTotal = 0
            while (bytesReadTotal < openedStat.size) {
              const bytesRead = fs.readSync(
                fd,
                buffer,
                0,
                Math.min(buffer.length, openedStat.size - bytesReadTotal),
                bytesReadTotal,
              )
              if (bytesRead === 0) return 'unreadable:changed-during-read'
              hash.update(buffer.subarray(0, bytesRead))
              bytesReadTotal += bytesRead
            }
            if (
              fs.fstatSync(fd).size !== openedStat.size ||
              (symlinkParts.length > 0 &&
                fs.realpathSync(absolutePath) !== resolvedPath)
            ) {
              return 'unreadable:changed-during-read'
            }
            const prefix = symlinkParts.length > 0 ? 'symlink-sha256' : 'sha256'
            return `${prefix}:${hash.digest('hex')}:${bytesReadTotal}`
          } finally {
            fs.closeSync(fd)
          }
        } catch (err) {
          const code =
            err && typeof err === 'object' && 'code' in err
              ? String((err as { code?: unknown }).code ?? 'unknown')
              : 'unknown'
          if (code === 'ENOENT') return 'missing'
          return `unreadable:${code}`
        }
      }

      function parseGitStatusLine(line: string): string {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('## ')) return ''
        const pathPart = trimmed.slice(2).trim()
        if (!pathPart) return ''
        const renameTarget = pathPart.split(' -> ').at(-1)
        const resolved = renameTarget?.trim() ?? ''
        // Untracked-directory git status entries are the only ones whose path
        // ends with `/`; they must not become gate files.
        if (resolved.endsWith('/')) return ''
        return resolved
      }

      function extractAgentReceipt(toolResult: unknown):
        | {
            status: string
            changedFiles: Array<{ path: string }>
            findingsAddressed: string[]
            requestedValidation: string[]
          }
        | undefined {
        const hasOwn = (record: Record<string, unknown>, key: string) =>
          Object.prototype.hasOwnProperty.call(record, key)
        const parseReceipt = (candidate: unknown) => {
          if (
            !candidate ||
            typeof candidate !== 'object' ||
            Array.isArray(candidate)
          ) {
            return undefined
          }
          const record = candidate as Record<string, unknown>
          if (
            record.schemaVersion !== 1 ||
            typeof record.receiptId !== 'string' ||
            typeof record.status !== 'string' ||
            !Array.isArray(record.changedFiles)
          ) {
            return undefined
          }
          return {
            status: record.status,
            changedFiles: record.changedFiles.flatMap((item) => {
              if (typeof item === 'string') return [{ path: item }]
              if (item && typeof item === 'object') {
                const path = (item as Record<string, unknown>).path
                return typeof path === 'string' ? [{ path }] : []
              }
              return []
            }),
            findingsAddressed: Array.isArray(record.findingsAddressed)
              ? record.findingsAddressed.filter(
                  (item): item is string => typeof item === 'string',
                )
              : [],
            requestedValidation: Array.isArray(record.requestedValidation)
              ? record.requestedValidation.filter(
                  (item): item is string => typeof item === 'string',
                )
              : [],
          }
        }
        const isRuntimeReceiptEnvelope = (record: Record<string, unknown>) =>
          hasOwn(record, 'agentReceipt') &&
          (hasOwn(record, 'result') ||
            (typeof record.agentId === 'string' &&
              typeof record.agentName === 'string' &&
              typeof record.agentType === 'string' &&
              hasOwn(record, 'value')))
        const visit = (
          value: unknown,
          depth = 0,
          allowResultWrapper = false,
        ): ReturnType<typeof parseReceipt> => {
          if (!value || depth > 10) return undefined
          if (Array.isArray(value)) {
            for (const item of value) {
              const found = visit(item, depth + 1, allowResultWrapper)
              if (found) return found
            }
            return undefined
          }
          if (typeof value !== 'object') return undefined
          const record = value as Record<string, unknown>
          if (isRuntimeReceiptEnvelope(record)) {
            return parseReceipt(record.agentReceipt)
          }
          if (hasOwn(record, 'toolResult')) {
            const found = visit(record.toolResult, depth + 1, true)
            if (found) return found
          }
          if (allowResultWrapper && hasOwn(record, 'result')) {
            const found = visit(record.result, depth + 1, false)
            if (found) return found
          }
          if (record.type === 'json' && hasOwn(record, 'value')) {
            const found = visit(record.value, depth + 1, false)
            if (found) return found
          }
          return undefined
        }
        return visit(toolResult)
      }

      function extractWriterOutcome(
        toolResult: unknown,
      ):
        | { completionKind: 'changed' | 'noop'; evidence: string[] }
        | undefined {
        const visit = (value: unknown, depth = 0): any => {
          if (!value || depth > 10) return undefined
          if (Array.isArray(value)) {
            for (const item of value) {
              const found = visit(item, depth + 1)
              if (found) return found
            }
            return undefined
          }
          if (typeof value !== 'object') return undefined
          const record = value as Record<string, unknown>
          if (
            (record.completionKind === 'changed' ||
              record.completionKind === 'noop') &&
            Array.isArray(record.evidence)
          ) {
            return {
              completionKind: record.completionKind,
              evidence: record.evidence.filter(
                (item): item is string => typeof item === 'string',
              ),
            }
          }
          for (const nested of Object.values(record)) {
            const found = visit(nested, depth + 1)
            if (found) return found
          }
          return undefined
        }
        return visit(toolResult)
      }

      function extractSpawnedAgentResult(
        toolResult: unknown,
        agentType: string,
      ): unknown {
        const visit = (value: unknown, depth = 0): unknown => {
          if (!value || depth > 10) return undefined
          if (Array.isArray(value)) {
            for (const item of value) {
              const found = visit(item, depth + 1)
              if (found !== undefined) return found
            }
            return undefined
          }
          if (typeof value !== 'object') return undefined
          const record = value as Record<string, unknown>
          if (record.agentType === agentType && 'value' in record) {
            return record.value
          }
          if (record.type === 'json' && 'value' in record) {
            const found = visit(record.value, depth + 1)
            if (found !== undefined) return found
          }
          for (const nested of Object.values(record)) {
            const found = visit(nested, depth + 1)
            if (found !== undefined) return found
          }
          return undefined
        }
        return visit(toolResult)
      }

      function detectCommandFailure(
        toolResult: unknown,
        depth = 0,
      ): string | null {
        if (!toolResult || depth > 10) return null
        if (Array.isArray(toolResult)) {
          for (const item of toolResult) {
            const failure = detectCommandFailure(item, depth + 1)
            if (failure) return failure
          }
          return null
        }
        if (typeof toolResult !== 'object') return null
        const record = toolResult as Record<string, unknown>
        if (typeof record.errorMessage === 'string' && record.errorMessage) {
          return record.errorMessage
        }
        if (typeof record.exitCode === 'number' && record.exitCode !== 0) {
          return `Validation command failed with exit code ${record.exitCode}: ${typeof record.stderr === 'string' ? record.stderr.slice(0, 2_000) : ''}`
        }
        if (record.success === false || record.status === 'failed') {
          return typeof record.message === 'string'
            ? record.message
            : 'Validation command reported failure.'
        }
        for (const nested of Object.values(record)) {
          const failure = detectCommandFailure(nested, depth + 1)
          if (failure) return failure
        }
        return null
      }

      function collectHookFailures(toolResult: unknown): string[] {
        const failures: string[] = []
        for (const hook of extractHookResults(toolResult)) {
          if (typeof (hook as any).errorMessage === 'string') {
            failures.push((hook as any).errorMessage)
            continue
          }
          const exitCode = (hook as any).exitCode
          if (typeof exitCode === 'number' && exitCode !== 0) {
            const name = (hook as any).hookName ?? 'hook'
            const detail = [(hook as any).stdout, (hook as any).stderr]
              .filter(Boolean)
              .join('\n')
              .slice(0, 2000)
            failures.push(`- ${name} failed (exit ${exitCode}):\n${detail}`)
          }
        }
        return failures
      }

      function summarizeHookResults(toolResult: unknown): string {
        const hooks = extractHookResults(toolResult)
        if (hooks.length === 0) return 'No configured file-change hooks ran.'
        const statusHook = hooks.find(
          (hook) => typeof (hook as any).validationStatus === 'string',
        )
        if (statusHook) {
          if (typeof (statusHook as any).message === 'string') {
            return `REDUCED_ASSURANCE: ${(statusHook as any).message}`
          }
          return (statusHook as any).validationStatus === 'hooks_skipped'
            ? 'Configured file-change hooks were skipped because none matched the changed files.'
            : 'No configured file-change hooks ran.'
        }
        const names = hooks
          .map((hook) =>
            typeof (hook as any).hookName === 'string'
              ? (hook as any).hookName
              : 'hook',
          )
          .join(', ')
        return `Configured file-change hooks passed: ${names}.`
      }

      function extractHookResults(
        toolResult: unknown,
      ): Record<string, unknown>[] {
        const hooks: Record<string, unknown>[] = []
        if (!Array.isArray(toolResult)) return hooks
        for (const part of toolResult) {
          const value =
            part && (part as any).type === 'json'
              ? (part as any).value
              : undefined
          if (!Array.isArray(value)) continue
          for (const hook of value) {
            if (hook && typeof hook === 'object')
              hooks.push(hook as Record<string, unknown>)
          }
        }
        return hooks
      }

      function buildEscalationEditorPrompt(
        parsed: {
          file: string
          line?: number
          column?: number
          message: string
          source: string
        }[],
        pendingFiles: string[],
        roundsUsed: number,
      ): string {
        const fileFailures = parsed.filter((p) => p.file.length > 0)
        const lines: string[] = [
          `Validation hooks have failed after ${roundsUsed} automated repair round(s). The targeted fix attempts did not resolve the failures. This is an escalation round: investigate the ROOT CAUSE rather than patching the reported symptom.`,
          '',
          'Before editing, read the failing file(s) in full to understand the surrounding context, imports, and conventions. The prior repair rounds likely addressed a surface symptom without fixing the underlying issue (e.g. a missing import, a renamed symbol, a type mismatch upstream, a stale snapshot, or an incorrect assumption about an API).',
          '',
          'Make the minimal change that resolves the root cause. Avoid speculative refactors, formatting churn, or edits to files not implicated by the failures. After your edits the validation hooks will re-run automatically.',
          '',
        ]
        if (fileFailures.length > 0) {
          lines.push('Failing locations (file:line:column — message):')
          const byFile = new Map<
            string,
            {
              file: string
              line?: number
              column?: number
              message: string
              source: string
            }[]
          >()
          for (const f of fileFailures) {
            const list = byFile.get(f.file) ?? []
            list.push(f)
            byFile.set(f.file, list)
          }
          for (const [file, fails] of byFile) {
            lines.push(`  ${file}:`)
            for (const f of fails) {
              const loc =
                f.line != null
                  ? `${f.line}${f.column != null ? `:${f.column}` : ''}`
                  : '?'
              lines.push(`    ${loc} — [${f.source}] ${f.message}`)
            }
          }
        } else {
          lines.push(
            'No specific file:line locations could be parsed from the failure output. Read the raw failures below and the pending files, investigate the root cause, then fix.',
          )
        }
        const unparsed = parsed.filter((p) => p.file.length === 0)
        if (unparsed.length > 0) {
          lines.push('')
          lines.push('Raw unparsed failures:')
          for (const u of unparsed) {
            lines.push(`  [${u.source}] ${u.message}`)
          }
        }
        if (pendingFiles.length > 0) {
          lines.push('')
          lines.push(`Pending changed files: ${pendingFiles.join(', ')}`)
        }
        return lines.join('\n')
      }
    },
  }
}
const EXPLORE_PROMPT = `- Iteratively gather codebase context as needed. For broad codebase questions or tasks where relevant files are not already obvious, call query_index early yourself and deduplicate its candidates by path, score, reason, and kind. Use mode: 'explain' when you need ranking rationale, mode: 'neighbors' to expand around a known file, mode: 'path' to connect two known files, mode: 'references' for blast-radius analysis (files that import or call into a seed file, using from or to), and mode: 'commands' to find package scripts, CI workflows, task runners, and validation docs. Spawn bounded parallel discovery waves for explicit domains the index result did not cover; give each file-picker/code-searcher a non-overlapping question, join the wave, and launch another when inventory or coverage evidence still has gaps. There is no fixed total-agent limit. Verify selected files with read_files/read_subtree. Use list_directory and glob only when structural/path evidence is missing, and do not substitute basher for git status or file discovery. Use read_subtree for a specific subsystem. For a large file, prefer read_files windows/around/symbol selectors over guess-shrink-retry ranges paging; use read_outline then read_files ranges only for an exact arbitrary line range. Read all relevant files before editing.`

function buildImplementationInstructionsPrompt({
  isFast,
  isDefault,
  hasNoValidation,
  noAskUser,
  progressiveDisclosure,
}: {
  isFast: boolean
  isDefault: boolean
  hasNoValidation: boolean
  noAskUser: boolean
  progressiveDisclosure: boolean
}) {
  // Mode-level proxy for "the automated validation/reviewer gate is active".
  // Plan mode uses separate builders, so at prompt-build time this matches the
  // runtime runValidationGate flag for every mode that reaches this builder.
  const gateActive = !isFast && !hasNoValidation
  return `Act as a helpful assistant and freely respond to the user's request however would be most helpful to the user. Use your judgement to orchestrate the completion of the user's request using your specialized sub-agents and tools as needed. Take your time and be comprehensive. Don't surprise the user. For example, don't modify files if the user has not asked you to do so at least implicitly.

${discloseBroadAudit('proceed to implementation or the answer', progressiveDisclosure)}

## Example response

The user asks you to implement a new feature. You respond in multiple steps:

${buildArray(
  EXPLORE_PROMPT,
  !noAskUser &&
    'After getting context on the user request from the codebase or from research, use the ask_user tool only for decisions that materially affect scope, UX, risk, data loss, migration, deployment, or API/contract behavior. Skip obvious questions; if you are >80% confident or the choice is easily reversible, choose the most conservative implementation and proceed.',
  isDefault &&
    `- For any task requiring 3+ steps, use the write_todos tool to write out your step-by-step implementation plan. Include ALL of the applicable tasks in the list.${isFast ? '' : ' You should include a step to review the changes after you have implemented the changes.'}:${hasNoValidation ? '' : ' You should include at least one step to validate/test your changes: be specific about whether to typecheck, run tests, run lints, etc.'} You may be able to do reviewing and validation in parallel in the same step. Skip write_todos for simple tasks like quick edits or answering questions.`,
  isDefault &&
    `- For quick problems, briefly explain your reasoning to the user. If you need to think longer, write your thoughts within the <think> tags. Finally, for complex architecture, design tradeoff, risk, debugging strategy, or repeated-failure reasoning, spawn the thinker agent after you have gathered enough context. Thinker has includeMessageHistory:false: pass a self-contained decision packet and optional params.depth / params.outputSchemaHint. Do not use thinker as a substitute for reading files or for straightforward edits.`,
  isDefault &&
    `- IMPORTANT: Before spawning the editor agent for non-trivial changes, prepare a compact implementation brief and pass it as the editor prompt. The editor does not inherit parent conversation history, so the prompt must be a self-contained envelope with these labeled fields (use these exact headings as a compact checklist; omit a field only when truly N/A):
    Use either colon labels or Markdown headings; both are accepted. Copyable template:
      Colon-label equivalents are also valid: Requirements:, Target files:, Constraints/non-goals:, Patterns:, Risks:.
      ## Requirements
      - The user-facing requirement and acceptance criteria.
      ## Target files
      - Explicit project-relative paths to edit or read first.
      ## Constraints/non-goals
      - Invariants, stable behavior, and scope boundaries.
      ## Patterns
      - Existing code/style conventions to follow.
      ## Risks
      - Edge cases, fragile call sites, and refactoring traps.
    If you cannot state the concrete implementation task, target files, and constraints yet, gather more context instead of spawning the editor. Do not spawn editor for tiny one-file edits or direct answers. Do not include parent-only work such as validation commands, terminal/shell cleanup, deleting files, visual smoke tests, code review, git operations, todos, or post-edit orchestration steps. After the editor returns, handle those parent-only responsibilities yourself.`,
  isFast &&
    '- Implement changes through edit_transaction, selecting the narrowest edit type for each operation and grouping related edits into one preflighted transaction. Implement all the changes in one go.',
  isFast &&
    '- Do a single typecheck targeted for your changes at most (if applicable for the project). Or skip this step if the change was small.',
  !hasNoValidation &&
    `- For non-trivial or risky changes, test them by running the narrowest appropriate validation commands for the project (e.g. typechecks, tests, lints, builds, or configured hooks). Try to run independent commands in parallel, then join all results before finalizing. If validation fails or times out, repair the exact failure and rerun the relevant command before treating the task as complete. Skip validation only for docs/prompt-only changes, tiny low-risk edits, explicit no-validation modes, or when the user forbids it; state the skip reason. You may have to explore the project to find the appropriate commands.`,
  `- Treat releases, deployments, publishing, migrations against shared environments, production-affecting scripts, git commits, and git pushes as high-impact actions. Do not run them unless the user explicitly requested that action in this task or confirms after you explain the exact command, target environment, and rollback/verification plan.`,
  gateActive
    ? '- Write exactly ONE user-visible completion summary per turn. For edited code, that summary belongs in the final message after the automated validation/reviewer gate has passed — do not write a completion summary before the gate runs. Keep any pre-gate text to brief progress notes, not a summary of the finished work.'
    : '- Inform the user that you have completed the task in one sentence or a few short bullet points.',
  gateActive
    ? '- After successfully completing an implementation, if the suggest_followups tool is available, use it to suggest ~3 next steps the user might want to take. For edited code, call it only after the automated validation/reviewer gate has passed, as the absolute last tool in the same final message after the single completion summary; if committing, spawn git-committer before suggest_followups; never mid-turn and never before remaining work. If suggest_followups is unavailable, still provide the final summary/end normally.'
    : '- After successfully completing an implementation, if the suggest_followups tool is available, use it to suggest ~3 next steps the user might want to take as the absolute last tool in the same final message after the completion summary; never mid-turn. If suggest_followups is unavailable, still provide the final summary/end normally.',
).join('\n')}`
}

function buildExecutePlanInstructionsPrompt(params: {
  isFast: boolean
  isDefault: boolean
  hasNoValidation: boolean
  noAskUser: boolean
  progressiveDisclosure: boolean
}) {
  return [
    buildImplementationInstructionsPrompt(params),
    '',
    '## Durable plan execution mode',
    '',
    'You are in EXECUTE_PLAN mode. Your job is to execute or resume durable plan artifacts, not merely revise them. Treat durable artifact contents already provided in the conversation as the initial authoritative context; read artifacts directly only when their contents are missing, truncated, stale, or have changed. Continue from the next actionable milestone, and use normal project source editing tools when implementation work is required.',
    'Run the plan preflight before editing. Tasks should have stable IDs, dependencies, Acceptance criteria, and Validate gates. Claim exactly one actionable task by moving it to in_progress and recording its stable ID as currentTask. A task may move to done only after its validation gate passes; record validation/review evidence as a checkpoint. That checkpoint must cite the gate-issued receipt ID printed in the gate-pass message (shaped `plan-gate:<taskId>:<fingerprintPrefix>`, or `plan-gate:<taskId>:unreviewed-scope:<fingerprintPrefix>` / `plan-gate:<taskId>:no-diff:<fingerprintPrefix>` when the cycle had no reviewable diff) in checkpoint.receiptIds; never invent a receipt ID, because the runtime verifies it against gate state and rejects an ID that matches no gate-issued receipt for that task. A receipt is SUPERSEDED when the task\'s files change again, so after further edits you must let the gate close again and copy the NEW ID from the newest gate-pass message (or the pinned harness state); never reuse an ID from an earlier gate-pass message. If preflight fails, repair the durable plan before implementation. Use STATE.json revisions to avoid overwriting newer execution state.',
    '',
    'Keep STATUS.md and LESSONS.md current throughout execution. Prefer update_plan_status for incremental STATUS.md / LESSONS.md updates; use create_plan for SPEC.md / PLAN.md revisions, substantial rewrites, or creating missing artifacts. PLAN mode remains plan-only, but EXECUTE_PLAN is allowed to edit project source to complete the plan. Do not let plan artifacts drift behind actual implementation state.',
  ].join('\n')
}

function buildImplementationStepPrompt({
  isDefault,
  isFast,
  hasNoValidation,
}: {
  isDefault: boolean
  isFast: boolean
  hasNoValidation: boolean
}) {
  // Mode-level proxy for the runtime's runValidationGate flag; see
  // buildImplementationInstructionsPrompt.
  const gateActive = !isFast && !hasNoValidation
  return buildArray(
    'Consider loading relevant skills with the skill tool if they might help with the current task. Do not reload skills that were already loaded earlier in this conversation.',
    'Use dedicated tools before shell fallbacks: repository status and validation gates are runtime-owned; use read_files/read_outline/read_subtree/glob/list_directory/query_index for inspection (large files: prefer read_files windows/around/symbol selectors), deterministic edit tools for file changes, and basher only for commands without a dedicated tool.',
    isDefault &&
      `For non-trivial edits, spawn the editor after context discovery with a compact implementation-only prompt containing all of these envelope fields: Requirements, Target files, Constraints/non-goals, Patterns, Risks. Use those exact field labels in the prompt so the editor can scan them as a checklist. The editor does not inherit parent conversation history, so the prompt must contain the implementation context it needs. If you cannot state the concrete implementation task, target files, and constraints yet, gather more context instead of spawning the editor. Do not put validation commands, terminal/shell cleanup, deletion requests, visual smoke tests, code review, git operations, todos, or other parent-only orchestration tasks in the editor handoff. After the editor returns, the default runtime will independently detect changed files, run configured validation hooks, and spawn code-reviewer before finalization.`,
    isDefault &&
      'Use the phase triggers from the spawning guidelines: context agents before edits when scope is unclear, thinker for complex post-discovery reasoning, bashers for validation, debugger for repeated failures, and doc/test writers when docs or tests are required. Join all parallel validation/review results before completing.',
    gateActive
      ? 'Write your completion summary exactly once per turn. For edited code, write it in the final message after the automated validation/reviewer gate has passed — do not summarize the finished work before the gate runs.'
      : `After completing the user request, summarize your changes in a sentence${isFast ? '' : ' or a few short bullet points'}.`,
    isDefault &&
      'When you declared multi-step work with write_todos, a passing validation/reviewer gate is not a stopping point: continue through the remaining declared items in this same turn. Stop early only with an explicitly stated reason and a note of what still remains.',
    isDefault &&
      'Do not manually spawn code-reviewer for the same edited file set that the automated runtime gate will review. Manual review is only for user-requested extra review or pre-edit/advisory review. Spawn security-reviewer for auth, crypto, secrets, permissions, injection, sandboxing, supply-chain, or production-risk changes.',
    isDefault &&
      'After the automated validation/reviewer gate has passed for edited code, write your single completion summary and call suggest_followups with around 3 useful next steps as the absolute last tool in that same final message (after git-committer if committing), if that tool is available; never mid-turn and never before remaining work. If suggest_followups is unavailable, do not let that block the final summary/end.',
  ).join('\n')
}

function buildExecutePlanStepPrompt({}: {}) {
  return buildArray(
    // EXECUTE_PLAN is always default-mode, non-fast, so it carries the same
    // editor-handoff / phase-trigger / "don't manually spawn code-reviewer"
    // guidance as the DEFAULT step prompt. Compose it from the shared builder
    // instead of reimplementing so the two step prompts cannot drift.
    buildImplementationStepPrompt({
      isDefault: true,
      isFast: false,
      hasNoValidation: false,
    }),
    'You are in EXECUTE_PLAN mode. Execute or resume durable plan artifacts, using the project source editing tools when implementation work is required. Unlike PLAN mode, you may edit project source files to complete planned tasks.',
    'Treat SPEC.md, PLAN.md, STATUS.md, and LESSONS.md under the durable plan session as authoritative. Use any artifact contents already present in the conversation as the initial source of truth, confirm the next incomplete or blocked item from that context, and read artifacts directly only when contents are missing, truncated, stale, or have changed. Do not repeatedly re-read unchanged artifacts or source files after confirming the next item; continue from it unless the artifacts say completed work must be revisited.',
    'Honor the deterministic preflight included with resumed artifacts. Do not edit source when preflight reports errors. Use stable task IDs for updates, keep at most one task in_progress, respect dependencies, and do not mark a task done until its Validate gate passes and the checkpoint is recorded.',
    'Completing one plan task and passing its validation gate is not the end of the turn: claim the next actionable task and keep executing in this same turn. This does not relax the at-most-one-task-in_progress rule above — advance through the tasks sequentially, one in_progress at a time, never claiming several at once. After a claimed task passes its validation/reviewer gate, copy the gate-issued receipt ID from the gate-pass message into update_plan_status checkpoint.receiptIds, mark that task done, then claim the next one. Receipt IDs must never be invented: the runtime verifies them against gate state and rejects an unmatched one, so a fabricated ID fails the transition instead of completing the task. A receipt is also superseded once the files it covers change again (and a `plan-gate:<taskId>:unreviewed-scope:...` / `plan-gate:<taskId>:no-diff:...` receipt as soon as any further change is recorded), so if you edit more after a gate pass you must let the gate close again and copy the NEW ID; never reuse an ID from an earlier gate-pass message. The live ID is also repeated in the pinned harness state. If you stop before the plan is complete, say so explicitly and state the reason, naming the task ID you reached and what remains.',
    'Keep STATUS.md current as you progress: update completed/pending/blocked items, current state, validation results, and the next checkpoint. Keep LESSONS.md current with gotchas, decisions, reusable findings, and follow-up notes discovered during execution. Prefer update_plan_status for incremental STATUS.md / LESSONS.md updates; use create_plan for SPEC.md / PLAN.md revisions, substantial rewrites, or creating missing artifacts.',
    'Use normal implementation behavior for source changes: gather context before editing, follow project conventions, validate meaningful changes when appropriate, and summarize the completed work concisely. Do not let plan artifacts drift behind actual implementation state.',
  ).join('\n')
}

function buildPlanOnlyInstructionsPrompt({
  progressiveDisclosure,
}: {
  progressiveDisclosure: boolean
}) {
  return `Orchestrate the completion of the user's request using your specialized sub-agents.

You are in plan mode. Preserve short-answer behavior: if the user is asking a question, requesting an explanation, or asking for a small clarification, answer directly and do not create a plan packet.

${discloseBroadAudit(
  'translate the findings into the durable plan packet below',
  progressiveDisclosure,
)}

For larger implementation, migration, debugging, or multi-step work, gather enough context to create a comprehensive, resumable plan packet. For non-trivial plans, create all four durable artifacts by default (SPEC.md, PLAN.md, STATUS.md, LESSONS.md); these are not optional or only "as needed". Normal users should not need to explicitly ask for STATUS or LESSONS artifacts. You may ask targeted clarifying questions with ask_user when the answer materially changes the plan. Avoid obvious questions and questions about details that can be adjusted later.

Plan mode must not edit project source or perform implementation work. Do not use normal editing tools for project files. Do not use the write_todos tool in plan mode. You may write to plan/session artifacts under .agents/sessions/<slug>/ only via these two tools, with this division of labor:
- create_plan: use to create the durable artifacts initially or to substantially rewrite them. Always use create_plan for SPEC.md and PLAN.md edits, and for creating any missing artifact. The four durable artifacts are:
  - SPEC.md
  - PLAN.md
  - STATUS.md
  - LESSONS.md
- update_plan_status: once the artifacts exist, use this for incremental STATUS.md and LESSONS.md updates — progress, blockers, checkpoints, and newly discovered lessons. Prefer update_plan_status over create_plan for these incremental status/lesson revisions so the durable artifacts stay current without rewriting them whole.

Plan mode may spawn as many analysis subagents as the work requires by using bounded waves. Basher commands and browser-use are runtime-enforced read-only throughout plan ancestry; use them for inspection, static analysis, non-emitting validation, page snapshots, and diagnostics only. Debugger is diagnosis-only. Do not use these agents for file creation or edits, dependency changes, git mutation, servers, deployment, production scripts, browser interactions, or any other implementation/effectful action.

## Example response

The user asks you to implement a non-trivial feature. You respond in multiple steps:

${buildArray(
  EXPLORE_PROMPT,
  `- After exploring the codebase, translate the user request and discovered context into a plan response. For small questions, answer instead of writing a plan.

## Durable plan packet for larger work

For comprehensive or otherwise non-trivial plans, create a session directory under .agents/sessions/<slug>/ and write all four durable artifacts with create_plan:
- SPEC.md: overview, goals/non-goals, requirements, acceptance criteria, relevant files/systems.
- PLAN.md: milestones, tasks, statuses, owners/agents if useful, dependencies, risks/blockers, and validation gates.
- STATUS.md: current state, completed/pending/blocked items, next checkpoint, and resume instructions.
- LESSONS.md: lessons, gotchas, decisions, and follow-up notes discovered while planning or updating.

Once the artifacts exist, prefer update_plan_status for incremental STATUS.md / LESSONS.md updates (progress, blockers, checkpoints, lessons). Only fall back to create_plan for STATUS.md / LESSONS.md when the artifact is missing or needs a substantial rewrite. SPEC.md and PLAN.md changes still go through create_plan.

Do not wait for the user to ask separately for STATUS.md or LESSONS.md on non-trivial plans; include them as part of the standard durable packet.

Also include the artifact metadata inside the <PLAN> response so the CLI can render the execution and resume affordances. Use simple markdown lines like:

## Artifacts
- Session: .agents/sessions/<slug>
- SPEC.md: .agents/sessions/<slug>/SPEC.md
- PLAN.md: .agents/sessions/<slug>/PLAN.md
- STATUS.md: .agents/sessions/<slug>/STATUS.md
- LESSONS.md: .agents/sessions/<slug>/LESSONS.md

The plan packet should be resumable across days. Include:
- Overview and requirements.
- Milestones/tasks with explicit statuses (todo/in progress/done/blocked).
- Give every executable checklist task a unique stable ID and indented \`Depends on\`, \`Acceptance\`, and \`Validate\` fields. Stable IDs must not change when task wording changes.
- Dependencies and ordering constraints.
- Risks, blockers, open questions, and assumptions.
- Validation gates and how to verify each milestone.
- Checkpoint/update rules: when STATUS.md must be updated (via update_plan_status for incremental progress), when PLAN.md/SPEC.md need revision (via create_plan), and how LESSONS.md should be maintained (update_plan_status for incremental lessons, create_plan for substantial rewrites).
- Artifact paths and practical resume/update guidance. Because STATUS.md and LESSONS.md are created by default for non-trivial plans, normal users should not need to request separate status or lessons commands just to get that lifecycle context.

## Creating the visible plan response

Wrap the visible plan in <PLAN> and </PLAN> tags. The content inside should be markdown formatted (no code fences around the whole plan/spec). For example: <PLAN>\n# Plan\n- Item 1\n- Item 2\n</PLAN>.

For simple plans, keep the response short and backward-compatible: title/overview, requirements, notes, and relevant files are enough. For larger work, summarize the durable packet and include the Artifacts metadata section.

Do not include implementation code. Do not make source changes. Do not claim implementation is complete.
`,
).join('\n')}`
}

function buildPlanOnlyStepPrompt({}: {}) {
  return buildArray(
    `You are in plan mode. Do not make project source changes or call edit_transaction for implementation files. Do not use the write_todos tool in plan mode. Use bounded waves of analysis subagents until coverage is complete; there is no fixed total-agent limit. Basher and browser-use inherit runtime-enforced read-only authority in plan mode, and debugger is diagnosis-only. Preserve short-answer behavior for simple questions. For larger or otherwise non-trivial work, use create_plan to create or substantially rewrite the four durable plan artifacts under .agents/sessions/<slug>/ by default (SPEC.md, PLAN.md, STATUS.md, LESSONS.md); do not treat STATUS.md or LESSONS.md as optional/as-needed or wait for normal users to ask for them separately. Once those artifacts exist, prefer update_plan_status for incremental STATUS.md and LESSONS.md updates (progress, blockers, checkpoints, lessons) rather than rewriting them whole with create_plan; keep using create_plan for SPEC.md / PLAN.md edits and for creating any missing artifact. Wrap the visible markdown response in <PLAN>...</PLAN> unless answering a simple question directly.`,
  ).join('\n')
}

const definition = { ...createBase2('default'), id: 'base2' }
export default definition
