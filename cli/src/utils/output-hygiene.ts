/**
 * Display-level hygiene for harness-injected pseudo-XML.
 *
 * Models sometimes echo internal annotation tags — `<system_warning>…</system_warning>`
 * and siblings — into their visible text (nothing in this repository emits
 * them; they are model-authored self-notes that survive into the transcript).
 * The PROMPT side forbids the habit (agents/base2 quality-prompt-section's
 * output hygiene section); this helper is the render side: it collapses such
 * tag pairs out of DISPLAYED text so users never see raw markup.
 *
 * DISPLAY-ONLY by contract: it runs at the render sites on the content string
 * being prepared for a <text> renderable, and never mutates the stored block
 * or the persisted transcript. An unclosed tag is left untouched — over-eager
 * stripping of partial streaming input could eat legitimate text that merely
 * starts like a tag.
 */

// Paired harness-style tags: `<system_warning>`, `<system_note>`, … — an
// optional underscore segment keeps it to harness-ish names without matching
// arbitrary XML the user might legitimately paste (e.g. `<system>` config).
const HARNESS_TAG_PAIR = /[ \t]*<(system_[a-z0-9]+)>([^]*?)<\/\1>[ \t]*\n?/g

/** Fold prose annotations while retaining Markdown source examples byte-for-byte. */
function collapseProse(text: string): string {
  // Code spans may cross lines; pair only backtick runs of the same length.
  const runs = Array.from(text.matchAll(/`+/g))
  const next = new Map<number, number>()
  const partners = new Map<number, number>()
  for (let i = runs.length - 1; i >= 0; i--) {
    const length = runs[i][0].length
    const partner = next.get(length)
    if (partner !== undefined) partners.set(i, partner)
    next.set(length, i)
  }
  const parts: string[] = []
  let start = 0
  for (let i = 0; i < runs.length; i++) {
    const partner = partners.get(i)
    if (partner === undefined) continue
    const opening = runs[i].index!
    const end = runs[partner].index! + runs[partner][0].length
    parts.push(text.slice(start, opening).replace(HARNESS_TAG_PAIR, ''))
    parts.push(text.slice(opening, end))
    start = end
    i = partner
  }
  parts.push(text.slice(start).replace(HARNESS_TAG_PAIR, ''))
  return parts.join('')
}

/**
 * Collapse paired `<system_*>` harness tags (and their content) out of the
 * text being rendered. Returns the cleaned string; whitespace-only remainders
 * collapse to '' so the caller's empty-content skip still drops the block.
 */
export function collapseHarnessTags(text: string): string {
  if (!text.includes('<system_')) return text
  const parts: string[] = []
  let prose = ''
  let fence: { marker: string; length: number } | undefined
  for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    const line = match[0]
    if (!line) continue
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line)
    if (fence) {
      parts.push(line)
      if (
        marker &&
        marker[1][0] === fence.marker &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      )
        fence = undefined
    } else if (marker && (marker[1][0] !== '`' || !marker[2].includes('`'))) {
      parts.push(collapseProse(prose), line)
      prose = ''
      fence = { marker: marker[1][0], length: marker[1].length }
    } else prose += line
  }
  parts.push(collapseProse(prose))
  const collapsed = parts.join('')
  return collapsed.trim().length > 0 ? collapsed : ''
}
