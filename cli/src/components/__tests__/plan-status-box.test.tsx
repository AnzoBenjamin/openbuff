import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { formatPlanSessionListRow } from '../../commands/plan-artifacts'
import { initializeThemeStore } from '../../hooks/use-theme'
import { chatThemes } from '../../utils/theme-system'
import { PlanStatusBox } from '../renderers/plan-status-box'

import type { PlanSessionSummary } from '../../commands/plan-artifacts'
import type { PlanStatusContentBlock } from '../../types/chat'

initializeThemeStore()

const theme = chatThemes.dark

const escapeForRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A whole rendered cell: one text element whose entire content is `content`.
 * Matching the whole cell keeps assertions specific to the segment under test
 * instead of any occurrence of its text anywhere in the markup.
 */
const cellRegExp = (content: string): RegExp =>
  new RegExp(`<text[^>]*>${escapeForRegExp(content)}</text>`)

/**
 * One whole rendered session row: the marker, badge and label cells emitted
 * back-to-back, derived from the canonical row formatter so row spacing stays
 * owned by plan-artifacts instead of being duplicated as literals here.
 *
 * Matching the row's own cell sequence is what keeps row assertions specific
 * without first locating a rows container: an inactive row's marker cell is
 * whitespace-only, so a bare marker match would depend on HarnessBox never
 * emitting a whitespace-only text element of its own. Anchoring on the row
 * instead of on HarnessBox's DOM shape means these assertions survive any
 * change to the surrounding box structure.
 */
const sessionRow = (session: PlanSessionSummary): RegExp => {
  const row = formatPlanSessionListRow(session)
  return new RegExp(
    [row.activeMarker, `${row.badge} `, row.label]
      .map((cell) => `<text[^>]*>${escapeForRegExp(cell)}</text>`)
      .join(''),
  )
}

/**
 * A blank report line is rendered as a whole placeholder row: a text element
 * whose entire content is one space. Pinning the surrounding element shape (not
 * just the loose '> </text>' fragment) keeps the negative assertion from going
 * vacuous if the row markup changes.
 */
const BLANK_LINE_ROW = cellRegExp(' ')

const countMatches = (markup: string, pattern: RegExp): number =>
  markup.match(new RegExp(pattern.source, 'g'))?.length ?? 0

/**
 * Opening tag of the first nested text element whose content starts with
 * `content`. Asserting the color of a specific segment (rather than anywhere in
 * the markup) is what makes the color assertions non-vacuous: theme.muted is
 * also applied to every row's active marker.
 */
const styleOfSegment = (markup: string, content: string): string => {
  const match = markup.match(
    new RegExp(`<text[^>]*>\\s*${escapeForRegExp(content)}`),
  )
  expect(
    match,
    `expected a text segment starting with "${content}"`,
  ).not.toBeNull()
  return match![0]
}

const makeStatusBlock = (
  overrides: Partial<PlanStatusContentBlock> = {},
): PlanStatusContentBlock => ({
  type: 'plan-status',
  mode: 'status',
  reportText:
    'Plan status header\n[active] my-plan 1/3 done\n  current: "task one"',
  isStatusReport: true,
  ...overrides,
})

/**
 * Single session-row fixture. Session directories are derived from the resolved
 * slug so an overridden slug cannot drift from its paths.
 */
const makeSession = (
  overrides: Partial<PlanSessionSummary> = {},
): PlanSessionSummary => {
  const slug = overrides.slug ?? 'alpha'
  return {
    slug,
    sessionDir: `.agents/sessions/${slug}`,
    absSessionDir: `/tmp/.agents/sessions/${slug}`,
    artifacts: ['PLAN.md'],
    status: 'active',
    currentTask: 'task one',
    // Fixed timestamp so the fixture stays deterministic if an assertion ever
    // reads `updatedAt`.
    updatedAt: '2024-01-01T00:00:00.000Z',
    progress: { done: 1, total: 3 },
    isActive: true,
    ...overrides,
  }
}

/**
 * The two fixture rows used by makeListBlock: one project-wide active session
 * and one inactive session.
 */
const FIXTURE_ACTIVE_SESSION = makeSession()
const FIXTURE_INACTIVE_SESSION = makeSession({
  slug: 'beta',
  artifacts: ['SPEC.md'],
  status: 'paused',
  currentTask: null,
  progress: { done: 0, total: 0 },
  isActive: false,
})

const makeListBlock = (
  overrides: Partial<PlanStatusContentBlock> = {},
): PlanStatusContentBlock => ({
  type: 'plan-status-list',
  mode: 'list',
  reportText: '',
  isStatusReport: false,
  sessions: [FIXTURE_ACTIVE_SESSION, FIXTURE_INACTIVE_SESSION],
  ...overrides,
})

describe('PlanStatusBox', () => {
  test('smoke renders status mode title Plan status and report lines', () => {
    const markup = renderToStaticMarkup(
      <PlanStatusBox block={makeStatusBlock()} />,
    )

    expect(markup).toContain('Plan status')
    expect(markup).toContain('Plan status header')
  })

  test('status mode colors the current-task line muted and other lines foreground', () => {
    const markup = renderToStaticMarkup(
      <PlanStatusBox block={makeStatusBlock()} />,
    )
    expect(markup).toContain('current:')
    expect(styleOfSegment(markup, 'current:')).toContain(theme.muted)
    expect(styleOfSegment(markup, 'Plan status header')).toContain(
      theme.foreground,
    )
    expect(styleOfSegment(markup, 'Plan status header')).not.toContain(
      theme.muted,
    )
  })

  test('status mode colors a badge that follows leading text', () => {
    const markup = renderToStaticMarkup(
      <PlanStatusBox
        block={makeStatusBlock({ reportText: 'session foo [paused] 0/2 done' })}
      />,
    )

    // The badge is not at index 0, so this takes the `before`-non-empty branch:
    // leading text, badge, and trailing text render as separate segments.
    expect(styleOfSegment(markup, '[paused]')).toContain(theme.warning)
    expect(markup).toContain('>session foo </text>')
    expect(styleOfSegment(markup, 'session foo')).toContain(theme.foreground)
    expect(markup).toContain('> 0/2 done</text>')
  })

  /**
   * The badge heuristic matches the first `[status]` token anywhere on a report
   * line, so STATUS.md prose that happens to mention one is colorized too. The
   * renderer cannot distinguish a badge from body text, so this case pins the
   * accepted consequence deliberately instead of leaving it incidental.
   */
  test('status mode colors a status token that appears in STATUS.md body text', () => {
    const markup = renderToStaticMarkup(
      <PlanStatusBox
        block={makeStatusBlock({
          reportText: 'STATUS.md:\nwaiting until the [paused] gate clears',
        })}
      />,
    )

    expect(styleOfSegment(markup, '[paused]')).toContain(theme.warning)
    expect(markup).toContain('>waiting until the </text>')
  })

  test('smoke renders list mode title Plan sessions and sessions', () => {
    const markup = renderToStaticMarkup(
      <PlanStatusBox block={makeListBlock()} />,
    )

    expect(markup).toContain('Plan sessions')
    expect(markup).toContain('alpha')
    expect(markup).toContain('1/3 done')
    expect(markup).toContain('current: &quot;task one&quot;')
    expect(markup).toContain('beta')
  })

  test('list mode colors each badge by status and the current task muted', () => {
    const markup = renderToStaticMarkup(
      <PlanStatusBox block={makeListBlock()} />,
    )
    expect(styleOfSegment(markup, '[active]')).toContain(theme.success)
    expect(styleOfSegment(markup, '[paused]')).toContain(theme.warning)
    // The slug/progress segment stays foreground, so a muted match here would
    // not be coming from the current-task segment.
    expect(styleOfSegment(markup, 'alpha')).toContain(theme.foreground)
    expect(styleOfSegment(markup, 'current:')).toContain(theme.muted)
  })

  test('list mode active marker is emitted for the active row only', () => {
    const activeSession = FIXTURE_ACTIVE_SESSION
    const inactiveSession = FIXTURE_INACTIVE_SESSION

    const activeOnly = renderToStaticMarkup(
      <PlanStatusBox block={makeListBlock({ sessions: [activeSession] })} />,
    )
    const inactiveOnly = renderToStaticMarkup(
      <PlanStatusBox block={makeListBlock({ sessions: [inactiveSession] })} />,
    )
    const both = renderToStaticMarkup(<PlanStatusBox block={makeListBlock()} />)

    expect(activeOnly).toMatch(sessionRow(activeSession))
    expect(activeOnly).toContain('alpha')
    // The formatter distinguishes the two markers, so the negative assertion
    // below cannot pass vacuously.
    expect(sessionRow(activeSession).source).not.toBe(
      sessionRow(inactiveSession).source,
    )
    // A non-active row gets the blank marker cell, never the active marker.
    expect(inactiveOnly).not.toMatch(sessionRow(activeSession))
    expect(inactiveOnly).toMatch(sessionRow(inactiveSession))
    expect(inactiveOnly).toContain('beta')
    // Exactly one marked row when both sessions are listed.
    expect(countMatches(both, sessionRow(activeSession))).toBe(1)
  })

  /**
   * formatPlanListReport's stale-active-session note never reaches this box:
   * with sessions present the rows come from `sessions` and `reportText` is
   * ignored. `/plans` therefore emits the note as its own text block (pinned by
   * command-args.test.ts) so it stays visible in the rendered UI. Pinned here so
   * the omission stays a deliberate contract.
   */
  test('list mode with sessions ignores reportText, including a stale-pointer note', () => {
    const staleNote =
      'Stale active session: ghost (no listed plan session matches .agents/ACTIVE_SESSION). Use /plan-use <slug> to point at an existing session.'
    const markup = renderToStaticMarkup(
      <PlanStatusBox
        block={makeListBlock({
          sessions: [FIXTURE_INACTIVE_SESSION],
          reportText: ['Plan sessions (1):', '', staleNote].join('\n'),
        })}
      />,
    )

    // The session row still renders from `sessions`...
    expect(markup).toMatch(sessionRow(FIXTURE_INACTIVE_SESSION))
    expect(markup).toContain('beta')
    // ...and nothing from reportText — the note included — is rendered.
    expect(markup).not.toContain('Stale active session')
    expect(markup).not.toContain('Plan sessions (1):')
  })

  test('handles empty sessions list by rendering the empty-state report text', () => {
    // The real `/plans`-empty path: with no sessions the component falls through
    // to the reportText branch, which carries formatPlanListReport's
    // empty-state message.
    const markup = renderToStaticMarkup(
      <PlanStatusBox
        block={makeListBlock({
          sessions: [],
          reportText: [
            'No plan sessions found under .agents/sessions/.',
            'Use /mode:plan to start one.',
          ].join('\n'),
        })}
      />,
    )
    expect(markup).toContain('Plan sessions')
    expect(markup).toContain('No plan sessions found under .agents/sessions/.')
    expect(markup).toContain('Use /mode:plan to start one.')
    // No session rows rendered: whole rows only exist in the list branch.
    expect(markup).not.toMatch(sessionRow(FIXTURE_ACTIVE_SESSION))
    expect(markup).not.toMatch(sessionRow(FIXTURE_INACTIVE_SESSION))
  })

  /**
   * The zero-sessions `/plans` path with a stale pointer: formatPlanListReport
   * appends the note to reportText and this branch renders it, so `/plans` must
   * not also carry the note as its own text block (pinned by
   * command-args.test.ts) or the user would see it twice.
   */
  test('empty sessions list renders a stale-pointer note from reportText exactly once', () => {
    // The note's `<slug>` suffix is HTML-escaped in the rendered markup, so the
    // countable anchor is its bracket-free head.
    const noteHead =
      'Stale active session: ghost (no listed plan session matches .agents/ACTIVE_SESSION).'
    const markup = renderToStaticMarkup(
      <PlanStatusBox
        block={makeListBlock({
          sessions: [],
          reportText: [
            'No plan sessions found under .agents/sessions/.',
            'Use /mode:plan to start one.',
            '',
            `${noteHead} Use /plan-use <slug> to point at an existing session.`,
          ].join('\n'),
        })}
      />,
    )

    expect(markup).toContain('No plan sessions found under .agents/sessions/.')
    expect(countMatches(markup, new RegExp(escapeForRegExp(noteHead)))).toBe(1)
  })

  test('handles empty reportText boundary without emitting placeholder rows', () => {
    const markup = renderToStaticMarkup(
      <PlanStatusBox block={makeStatusBlock({ reportText: '' })} />,
    )
    expect(markup).toContain('Plan status')
    // reportText '' takes the `lines === []` path: no rows at all. A
    // `''.split('\n')` implementation would emit one `' '` placeholder row, so
    // this row-specific marker is the assertion that pins the branch. Status
    // mode renders no whitespace-only cells of its own (the list branch's blank
    // markers are not in play), so the match is specific to the placeholder row.
    expect(markup).not.toMatch(BLANK_LINE_ROW)

    // Control: a report that does contain a blank line renders the placeholder
    // row between the two non-empty rows.
    const withBlankLine = renderToStaticMarkup(
      <PlanStatusBox
        block={makeStatusBlock({ reportText: 'first\n\nlast' })}
      />,
    )
    expect(withBlankLine).toMatch(BLANK_LINE_ROW)
    expect(withBlankLine).toMatch(
      new RegExp(
        `>first</text>[\\s\\S]*${BLANK_LINE_ROW.source}[\\s\\S]*>last</text>`,
      ),
    )
  })

  test('list mode completed and archived badges use secondary/muted', () => {
    const markup = renderToStaticMarkup(
      <PlanStatusBox
        block={makeListBlock({
          sessions: [
            makeSession({
              slug: 'gamma',
              artifacts: [],
              status: 'completed',
              currentTask: null,
              progress: { done: 2, total: 2 },
              isActive: false,
            }),
            makeSession({
              slug: 'delta',
              artifacts: [],
              status: 'archived',
              currentTask: null,
              progress: { done: 0, total: 1 },
              isActive: false,
            }),
          ],
        })}
      />,
    )
    expect(markup).toContain('[completed]')
    expect(markup).toContain('[archived]')
    // Assert the badge segments themselves: theme.muted is also applied to
    // every row's active marker, so a bare toContain would pass without the
    // archived badge being colored at all.
    expect(styleOfSegment(markup, '[completed]')).toContain(theme.secondary)
    expect(styleOfSegment(markup, '[archived]')).toContain(theme.muted)
    expect(styleOfSegment(markup, '[archived]')).not.toContain(theme.secondary)
  })
})
