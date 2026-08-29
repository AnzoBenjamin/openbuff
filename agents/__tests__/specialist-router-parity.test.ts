import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

import { selectSpecialistReviewers } from '../base2/specialist-risk-router'
import { extractInlineFunctionSource } from './helpers/extract-inline-function-source'

// Parity: the inline fallback mirror inside base2's serialized handleSteps
// must stay behaviorally identical to the canonical selectSpecialistReviewers
// export (common/src/agents/specialist-risk-router.ts, re-exported by
// agents/base2/specialist-risk-router.ts) that the runtime control plane uses.
// Drift here means the orchestrator and the sandboxed fallback disagree about
// which specialists a pending change routes to.

type SelectSpecialistReviewersInput = {
  files: string[]
  // Optional to match the canonical input contract; REPRESENTATIVE_INPUTS
  // includes omitted-requirements cases that exercise the `?? ''` default.
  requirements?: string
}

type InlineRouterHelpers = {
  selectSpecialistReviewersInline: (
    input: SelectSpecialistReviewersInput,
  ) => string[]
}

type InlineRouterFactory = (params: unknown) => InlineRouterHelpers

/**
 * Builds the inline fallback from the live base2.ts source using the shared
 * transpile+extract pattern (see gate-reviewer-parity and
 * base2-writer-spawn-rules). The inline body's first statement reads the
 * closure variable `params` (it prefers
 * params?.orchestrationControlPlane?.selectSpecialistReviewers), so `params`
 * is bound as a factory argument and invoked with `{}` — the runtime-router
 * branch is skipped and the deterministic fallback logic runs. The only extra
 * extraction is the reliability constant pair hoisted above the inline
 * function in handleSteps (bound alongside the helper in the factory below);
 * normalizeFilePath et al. are editor-side only and stay out of the
 * reconstruction.
 */
function loadInlineSpecialistRouter(): InlineRouterHelpers {
  const base2Source = readFileSync(
    new URL('../base2/base2.ts', import.meta.url),
    'utf8',
  )
  const transpiler = new Bun.Transpiler({ loader: 'ts' })
  const base2JavaScript = transpiler.transformSync(base2Source)
  const helperSource = extractInlineFunctionSource(
    base2JavaScript,
    'selectSpecialistReviewersInline',
  )
  // The fallback's reliability stem set and code-extension regex are hoisted
  // above the inline function in handleSteps (mirroring the canonical
  // module-scope RELIABILITY_CODE_STEMS / RELIABILITY_CODE_EXTENSION), so the
  // reconstruction binds them in the same synthetic enclosing scope: slice the
  // contiguous declarations sitting directly before the function.
  const hoistStart = base2JavaScript.indexOf('const reliabilityCodeStems')
  const inlineFnStart = base2JavaScript.indexOf(
    'function selectSpecialistReviewersInline(',
  )
  if (hoistStart < 0 || inlineFnStart < 0 || hoistStart > inlineFnStart) {
    throw new Error(
      'Unable to find hoisted reliability constants before selectSpecialistReviewersInline',
    )
  }
  const hoistedConstantsSource = base2JavaScript.slice(
    hoistStart,
    inlineFnStart,
  )
  const buildHelpers = new Function(
    'params',
    `"use strict";\n${hoistedConstantsSource}\n${helperSource}\nreturn { selectSpecialistReviewersInline }`,
  ) as InlineRouterFactory

  return buildHelpers({})
}

// Multi-family input reused by the stable-order pin below; also the last entry
// of the representative-input list so the parity loop covers it too.
const MULTI_FAMILY_INPUT: SelectSpecialistReviewersInput = {
  files: [
    'package.json',
    'src/migrations/002.sql',
    'src/public-api.ts',
    'src/session/store.ts',
    'bench/run.ts',
  ],
  requirements:
    'Make the retry state machine idempotent and cut benchmark latency.',
}

// Representative inputs covering every routed family plus the documented
// negatives. The parity loop compares both implementations on every entry;
// targeted tests afterwards pin the specific regression intents.
const REPRESENTATIVE_INPUTS: SelectSpecialistReviewersInput[] = [
  // Empty inputs route nothing.
  { files: [], requirements: '' },
  { files: [], requirements: 'No risk signals here.' },
  // Omitted requirements default to '' in both implementations instead of
  // throwing on the undefined read.
  { files: [] },
  { files: ['src/session/store.ts'] },
  // Dependency family: manifest/lockfile paths and keyword fallback.
  { files: ['package.json', 'bun.lock'], requirements: '' },
  {
    files: [],
    requirements: 'Refresh dependencies and regenerate the lockfile.',
  },
  // Migration family: sql/migrations path and keyword fallback.
  { files: ['src/migrations/001.sql'], requirements: '' },
  {
    files: [],
    requirements: 'Plan the schema change, backfill, and rollback.',
  },
  // Compatibility family: public-api file, types directory, keyword.
  { files: ['src/public-api.ts', 'src/types/x.ts'], requirements: '' },
  {
    files: [],
    requirements: 'Preserve backward compat through the breaking change.',
  },
  // Reliability family: session/state directory surfaces plus exact
  // filename-stem matches on code files.
  { files: ['src/session/store.ts'], requirements: '' },
  { files: ['src/cache/client.ts'], requirements: '' },
  { files: ['src/scheduler.ts'], requirements: '' },
  { files: ['src/state.ts'], requirements: '' },
  { files: ['src/cache/index.ts'], requirements: '' },
  // Reliability negatives: compound stems and non-code extensions never
  // match; artifacts excluded.
  { files: ['src/gate-state.ts'], requirements: '' },
  { files: ['src/retry-policy.ts'], requirements: '' },
  { files: ['state.json'], requirements: '' },
  {
    files: ['.agents/sessions/read-tool-unification/STATE.json'],
    requirements: '',
  },
  // Reliability keywords still route without any path signal.
  { files: [], requirements: 'Make the retry state machine idempotent.' },
  // Keyword-stem inflections (\w*-suffixed stems) must route identically in
  // both implementations.
  { files: [], requirements: 'Make the upload handler idempotent.' },
  { files: [], requirements: 'Deprecate the feature flag.' },
  // Performance family: bench path and keyword fallback.
  { files: ['bench/load.ts'], requirements: '' },
  { files: [], requirements: 'Cut latency and allocations on the hot path.' },
  // Accessibility family: UI file required, weak and strong keywords alike.
  {
    files: ['src/components/Dialog.tsx'],
    requirements: 'Fix keyboard focus contrast.',
  },
  { files: ['src/pages/Dashboard.jsx'], requirements: 'Run an a11y audit.' },
  { files: ['src/utils/dom.ts'], requirements: 'Fix keyboard focus.' },
  { files: [], requirements: 'Audit screen reader semantics.' },
  {
    files: ['src/widgets/Chart.astro'],
    requirements: 'Check keyboard focus and visual hierarchy.',
  },
  {
    files: ['src/features/dashboard/page.html'],
    requirements: 'Check keyboard focus and visual hierarchy.',
  },
  // UX-visual family: same always-required UI-file rule.
  {
    files: ['src/views/Chart.vue'],
    requirements: 'Tighten visual hierarchy and responsive spacing.',
  },
  { files: ['src/styles/theme.css'], requirements: 'Screenshot the viewport.' },
  { files: ['src/lib/render.ts'], requirements: 'Adjust the layout spacing.' },
  // Product + evaluator families: requirements-only routing.
  {
    files: ['cli/src/chat.tsx'],
    requirements: 'Verify the user-facing end-to-end onboarding flow.',
  },
  { files: [], requirements: 'Independently evaluate requirement coverage.' },
  { files: [], requirements: 'Score against the acceptance criteria.' },
  MULTI_FAMILY_INPUT,
]

describe('specialist-router inline fallback — parity with canonical export', () => {
  test('selectSpecialistReviewersInline matches selectSpecialistReviewers across representative inputs', () => {
    const { selectSpecialistReviewersInline } = loadInlineSpecialistRouter()

    for (const input of REPRESENTATIVE_INPUTS) {
      expect(selectSpecialistReviewersInline({ ...input })).toEqual(
        selectSpecialistReviewers({ ...input }),
      )
    }
  })

  test('representative inputs collectively cover every routed specialist family', () => {
    // Guards the parity loop against silently shrinking to a subset: every
    // family must appear in at least one representative input's canonical
    // output, or the comparison no longer covers that family.
    const routed = new Set(
      REPRESENTATIVE_INPUTS.flatMap((input) =>
        selectSpecialistReviewers({ ...input }),
      ),
    )
    expect([...routed].sort()).toEqual([
      'accessibility-reviewer',
      'compatibility-reviewer',
      'dependency-reviewer',
      'evaluator',
      'migration-reviewer',
      'performance-specialist',
      'product-reviewer',
      'reliability-reviewer',
      'ux-visual-reviewer',
    ])
  })

  test('compound stems and non-code extensions never route reliability', () => {
    // Regression guard: reliability paths are directory segments PLUS exact
    // filename stems on code files only — compound stems (gate-state.ts,
    // lockfile.ts) and data/doc extensions (state.json) never match even
    // though they contain a keyword substring.
    const { selectSpecialistReviewersInline } = loadInlineSpecialistRouter()

    for (const files of [
      ['src/gate-state.ts'],
      ['state.json'],
      ['lockfile.ts'],
    ]) {
      expect(selectSpecialistReviewers({ files, requirements: '' })).toEqual([])
      expect(
        selectSpecialistReviewersInline({ files, requirements: '' }),
      ).toEqual([])
    }
  })

  test('.agents/sessions/** artifacts never route reliability', () => {
    const { selectSpecialistReviewersInline } = loadInlineSpecialistRouter()
    const files = [
      '.agents/sessions/read-tool-unification-2026-07/STATE.json',
      '.agents/sessions/read-tool-unification-2026-07/EVENTS.jsonl',
    ]
    expect(selectSpecialistReviewers({ files, requirements: '' })).toEqual([])
    expect(
      selectSpecialistReviewersInline({ files, requirements: '' }),
    ).toEqual([])
  })

  test('UI specialists require a UI-ish file even for their strongest keywords', () => {
    // Regression guard for the doc drift: there is no strong-keyword-only
    // route — accessibility/ux-visual keywords only fire alongside a UI-ish
    // file (dir segment components/pages/views/screens/ui/app or extension
    // tsx/jsx/vue/svelte/css/scss).
    const { selectSpecialistReviewersInline } = loadInlineSpecialistRouter()
    const uiLessInputs: SelectSpecialistReviewersInput[] = [
      {
        files: [],
        requirements:
          'Full accessibility audit with aria and reduced motion fixes.',
      },
      {
        files: [],
        requirements: 'Responsive screenshot review of the design system.',
      },
      {
        files: ['src/core/logic.ts'],
        requirements: 'Keyboard navigation is broken.',
      },
    ]
    for (const input of uiLessInputs) {
      expect(selectSpecialistReviewers({ ...input })).toEqual([])
      expect(selectSpecialistReviewersInline({ ...input })).toEqual([])
    }

    // The same keywords DO route when a UI-ish file is present.
    const uiInput: SelectSpecialistReviewersInput = {
      files: ['src/components/Modal.tsx'],
      requirements: 'Accessibility and responsive design-system fixes.',
    }
    expect(selectSpecialistReviewers({ ...uiInput })).toEqual([
      'accessibility-reviewer',
      'ux-visual-reviewer',
    ])
    expect(selectSpecialistReviewersInline({ ...uiInput })).toEqual([
      'accessibility-reviewer',
      'ux-visual-reviewer',
    ])
  })

  test('multi-family inputs keep the stable family order', () => {
    const { selectSpecialistReviewersInline } = loadInlineSpecialistRouter()

    expect(selectSpecialistReviewers({ ...MULTI_FAMILY_INPUT })).toEqual([
      'dependency-reviewer',
      'migration-reviewer',
      'compatibility-reviewer',
      'reliability-reviewer',
      'performance-specialist',
    ])
    expect(selectSpecialistReviewersInline({ ...MULTI_FAMILY_INPUT })).toEqual(
      selectSpecialistReviewers({ ...MULTI_FAMILY_INPUT }),
    )
  })
})
