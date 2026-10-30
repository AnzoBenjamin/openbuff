/**
 * Markdown helpers retained after the OpenTUI 0.5 native <markdown> adoption
 * (D47 Stage 2); the rendering pipeline lives in @opentui/core's
 * MarkdownRenderable (see components/blocks/content-with-markdown.tsx).
 */

export interface MarkdownPalette {
  inlineCodeFg: string
  codeBackground: string
  codeHeaderFg: string
  headingFg: Record<number, string>
  listBulletFg: string
  blockquoteBorderFg: string
  blockquoteTextFg: string
  dividerFg: string
  codeTextFg: string
  codeMonochrome: boolean
  linkFg: string
}

export function hasMarkdown(content: string): boolean {
  return /[*_`#>\-\+]|\[[^\]]*\]\([^)]*\)|```/.test(content)
}

export function hasIncompleteCodeFence(content: string): boolean {
  let fenceCount = 0
  const fenceRegex = /```/g
  while (fenceRegex.exec(content)) {
    fenceCount += 1
  }
  return fenceCount % 2 === 1
}
