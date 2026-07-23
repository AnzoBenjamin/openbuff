import { describe, expect, test } from 'bun:test'

import { PLACEHOLDER } from '@codebuff/agent-runtime/templates/types'

import { createBaseDeep } from '../base2/base-deep'
import { createBase2 } from '../base2/base2'
import { frontendSection } from '@codebuff/common/constants/prompt-sections'

import { createCodeEditor } from '../editor/editor'
import {
  buildBroadAuditSection,
  gateAwarenessSection,
  gitDisciplineSection,
  qualitySection,
  securityReviewSection,
  specialistRoutingSection,
} from '../base2/quality-prompt-section'

/**
 * `qualitySection` is byte-frozen: any accidental drift across the three
 * consumers (base2.ts, base-deep.ts, editor.ts) is caught here at test time.
 *
 * `frontendSection` is intentionally NOT byte-frozen — it is the one section
 * allowed to evolve as frontend best practices change (SPEC AC7 / R1.3).
 */
describe('shared craftsmanship prompt sections', () => {
  test('qualitySection is byte-stable (snapshot)', () => {
    expect(qualitySection).toMatchSnapshot()
  })

  test('qualitySection contains the required craftsmanship headings', () => {
    // Guard the semantic content without freezing the exact wording, so a
    // future tightening of prose does not silently drop a required topic.
    expect(qualitySection).toContain('# Code Craftsmanship')
    expect(qualitySection).toContain('**Conventions:**')
    expect(qualitySection).toContain('**Libraries/Frameworks:**')
    expect(qualitySection).toContain('identify the active ecosystem')
    expect(qualitySection).toContain('not a checklist')
    expect(qualitySection).toContain('do not add basename fallbacks')
    expect(qualitySection).toContain('do not probe unrelated ecosystem')
    expect(qualitySection).toContain('**Style & Structure:**')
    expect(qualitySection).toContain('**Simplicity & Minimalism:**')
    expect(qualitySection).toContain('**Code Reuse:**')
    expect(qualitySection).toContain('**Code Hygiene:**')
  })

  test('frontendSection contains the required frontend topics (not byte-frozen)', () => {
    // frontendSection is allowed to evolve; only assert topic coverage.
    expect(frontendSection).toContain('# Frontend Development')
    expect(frontendSection).toContain('Accessibility')
    expect(frontendSection).toContain('Responsive Design')
    expect(frontendSection).toContain('Performance')
  })

  test('buildBroadAuditSection contains broad-audit production-readiness guidance (not byte-frozen)', () => {
    // Broad audit guidance is allowed to evolve; only assert topic coverage.
    const broadAuditSection = buildBroadAuditSection('finalize')
    expect(broadAuditSection).toContain('Broad audit / exploration requests')
    expect(broadAuditSection).toContain(
      'assess this codebase for how production ready it is on a feature, security and code level',
    )
    expect(broadAuditSection).toContain('inspect_codebase_structure')
    expect(broadAuditSection).toContain('UI page wiring')
    expect(broadAuditSection).toContain('auth/error/loading states')
    expect(broadAuditSection).toContain('accessibility')
    expect(broadAuditSection).toContain('responsiveness')
    expect(broadAuditSection).toContain(
      'explicitly mark frontend/UI coverage out-of-scope',
    )
    expect(broadAuditSection).toContain('vertical feature slices')
    expect(broadAuditSection).toContain('language/framework capability packet')
    expect(broadAuditSection).toContain('inspect_feature_completeness')
    expect(broadAuditSection).toContain('evaluate_audit_coverage')
    expect(broadAuditSection).toContain('structuralReceipt')
    expect(broadAuditSection).toContain('coverageReceipt')
    expect(broadAuditSection).toContain('evidence_kind')
    expect(broadAuditSection).toContain('block a complete audit')
  })

  test('gitDisciplineSection contains the required git-discipline topics (not byte-frozen)', () => {
    // gitDisciplineSection is advisory guidance that may evolve; only assert
    // topic coverage so future tightening does not silently drop a rule.
    expect(gitDisciplineSection).toContain('# Git Discipline')
    expect(gitDisciplineSection).toContain('git-committer')
    expect(gitDisciplineSection).toContain('Never push')
    expect(gitDisciplineSection).toContain('Never alter git config')
    expect(gitDisciplineSection).toContain('secrets')
    expect(gitDisciplineSection).toContain('runtime injects Git status')
    expect(gitDisciplineSection).toContain('git_branch')
  })

  test('gitDisciplineSection tells the orchestrator to pass owned_paths in git-committer params', () => {
    // git-committer requires params.owned_paths; a prompt-only or empty-params
    // spawn fails outright. Guard that the guidance names the required key so
    // the orchestrator supplies it instead of relying on the prose prompt.
    expect(gitDisciplineSection).toContain('owned_paths')
    expect(gitDisciplineSection).toContain('in params')
  })

  test('gitDisciplineSection warns that an empty/prompt-only git-committer spawn fails the spawn', () => {
    // Regression guard for the observed failure: spawning git-committer with
    // empty params ({}) fails with "Missing required: owned_paths". The
    // guidance must mark owned_paths REQUIRED and explain that omitting it via
    // an empty or prompt-only spawn fails outright, so the orchestrator does
    // not rely on the prose prompt alone and hit the same spawn rejection.
    expect(gitDisciplineSection).toContain('REQUIRED')
    expect(gitDisciplineSection).toContain('required field')
    expect(gitDisciplineSection).toContain('empty or prompt-only spawn')
    expect(gitDisciplineSection).toContain('fails the spawn')
  })

  test('gitDisciplineSection names the literal owned_paths key and the gate-block on early git-committer spawns', () => {
    // Two observed failures this guidance targets: (1) passing a wrong key
    // name (filePaths) instead of the literal owned_paths, and (2) attempting
    // the git-committer spawn before the gate passed. Guard that the guidance
    // names the exact key and the runtime gate-block message.
    expect(gitDisciplineSection).toContain('literally `owned_paths`')
    expect(gitDisciplineSection).toContain('filePaths')
    expect(gitDisciplineSection).toContain('Missing required: owned_paths')
    expect(gitDisciplineSection).toContain(
      'Spawning git-committer is not available yet',
    )
  })

  test('gateAwarenessSection contains the required gate-awareness topics (not byte-frozen)', () => {
    // gateAwarenessSection is advisory guidance that may evolve; only assert
    // topic coverage so future tightening does not silently drop the
    // don't-double-spawn-code-reviewer guidance.
    expect(gateAwarenessSection).toContain('# Automated Validation & Review Gate')
    expect(gateAwarenessSection).toContain('code-reviewer')
    expect(gateAwarenessSection).toContain('validation hooks')
    expect(gateAwarenessSection).toContain('before finalization')
  })

  test('securityReviewSection contains the required security-review topics (not byte-frozen)', () => {
    // securityReviewSection is advisory guidance that may evolve; only assert
    // topic coverage so future tightening does not silently drop a rule.
    expect(securityReviewSection).toContain(
      '# Security-Sensitive File Patterns',
    )
    expect(securityReviewSection).toContain('security-reviewer')
    expect(securityReviewSection).toContain('advisory')
    expect(securityReviewSection).toContain('pre-edit')
    expect(securityReviewSection).toContain('auth')
    expect(securityReviewSection).toContain('secrets')
    expect(securityReviewSection).toContain('read-only')
  })

  test('specialistRoutingSection names the exact snapshot param contract for reviewer-family specialists', () => {
    // Reviewer-family specialists require params.snapshot_id from
    // get_change_review_bundle, while security-reviewer requires
    // changed_files + snapshot_fingerprint. Guard that the guidance names both
    // contracts so a spawn does not fail on the wrong/missing snapshot key.
    expect(specialistRoutingSection).toContain('snapshot_id')
    expect(specialistRoutingSection).toContain('get_change_review_bundle')
    expect(specialistRoutingSection).toContain('changed_files')
    expect(specialistRoutingSection).toContain('snapshot_fingerprint')
  })

  test('all three consumers interpolate shared sections and leave conditional sections gated', () => {
    // Frontend and language guidance are runtime placeholders so unrelated
    // repos do not receive prompt pollution.
    const base2 = createBase2('default')
    const baseDeep = createBaseDeep()
    const editor = createCodeEditor({ model: 'opus' })

    expect(base2.systemPrompt).toContain(qualitySection)
    expect(base2.systemPrompt).toContain(PLACEHOLDER.FRONTEND_SECTION)
    expect(base2.systemPrompt).toContain(PLACEHOLDER.LANGUAGE_PROFILE)
    expect(base2.systemPrompt).not.toContain(frontendSection)
    expect(base2.systemPrompt).toContain(gateAwarenessSection)
    expect(base2.systemPrompt).toContain(gitDisciplineSection)
    expect(base2.systemPrompt).toContain(securityReviewSection)

    expect(baseDeep.systemPrompt).toContain(qualitySection)
    expect(baseDeep.systemPrompt).toContain(PLACEHOLDER.FRONTEND_SECTION)
    expect(baseDeep.systemPrompt).toContain(PLACEHOLDER.LANGUAGE_PROFILE)
    expect(baseDeep.systemPrompt).not.toContain(frontendSection)
    expect(baseDeep.systemPrompt).toContain(gateAwarenessSection)
    expect(baseDeep.systemPrompt).toContain(gitDisciplineSection)
    expect(baseDeep.systemPrompt).toContain(securityReviewSection)

    // gitDisciplineSection is intentionally NOT interpolated into the editor —
    // the editor is for code editing, not git work; the git-committer agent
    // owns the detailed commit workflow.
    // securityReviewSection is intentionally NOT interpolated into the editor
    // — the orchestrator decides when to spawn security-reviewer; the editor
    // implements the (already-reviewed) change.
    expect(editor.instructionsPrompt).toContain(qualitySection)
    expect(editor.instructionsPrompt).toContain(PLACEHOLDER.FRONTEND_SECTION)
    expect(editor.instructionsPrompt).toContain(PLACEHOLDER.LANGUAGE_PROFILE)
    expect(editor.instructionsPrompt).not.toContain(frontendSection)
  })

  test('base2 system prompt routes ripgrep-style search through code-searcher', () => {
    // The root orchestrator is not granted code_search/find_files_matching_content;
    // its prompt must tell it to spawn code-searcher instead of calling them
    // directly (otherwise the runtime rejects the call). Guard the semantic
    // content without freezing the exact wording.
    const base2 = createBase2('default')

    expect(base2.systemPrompt).toContain('code-searcher')
    expect(base2.systemPrompt).toContain('code_search')
    expect(base2.systemPrompt).toContain('find_files_matching_content')
    expect(base2.systemPrompt).toContain('not granted to you as root')
  })

  test('base2 system prompt names required spawn params for code-searcher and basher', () => {
    // Regression guard for observed spawn failures: code-searcher requires
    // params.searchQueries and basher requires params.command. The prompt
    // must name both required keys so the orchestrator supplies them in
    // params instead of relying on the prose prompt and hitting a spawn
    // rejection.
    const base2 = createBase2('default')

    expect(base2.systemPrompt).toContain('params.searchQueries')
    expect(base2.systemPrompt).toContain('params.command')
  })
})
