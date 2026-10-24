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
const HARNESS_TAG_PAIR =
  /[ \t]*<system_[a-z0-9]+>([^]*?)<\/system_[a-z0-9]+>[ \t]*\n?/g

/**
 * Collapse paired `<system_*>` harness tags (and their content) out of the
 * text being rendered. Returns the cleaned string; whitespace-only remainders
 * collapse to '' so the caller's empty-content skip still drops the block.
 */
export function collapseHarnessTags(text: string): string {
  if (!text.includes('<system_')) return text
  const collapsed = text.replace(HARNESS_TAG_PAIR, '')
  return collapsed.trim().length > 0 ? collapsed : ''
}
