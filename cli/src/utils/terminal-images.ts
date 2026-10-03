/**
 * Terminal image rendering utilities
 * Supports iTerm2 inline images protocol and Kitty graphics protocol
 */

import { getCliEnv } from './env'

import type { CliEnv } from '../types/env'

export type TerminalImageProtocol = 'iterm2' | 'kitty' | 'sixel' | 'none'

let cachedProtocol: TerminalImageProtocol | null = null

/**
 * Detect which image protocol the terminal supports
 */
export function detectTerminalImageSupport(
  env: CliEnv = getCliEnv(),
): TerminalImageProtocol {
  if (cachedProtocol !== null) {
    return cachedProtocol
  }

  // Check for iTerm2
  if (env.TERM_PROGRAM === 'iTerm.app') {
    cachedProtocol = 'iterm2'
    return cachedProtocol
  }

  // Check for Kitty
  if (env.TERM === 'xterm-kitty' || env.KITTY_WINDOW_ID !== undefined) {
    cachedProtocol = 'kitty'
    return cachedProtocol
  }

  // Check for Sixel support (less common)
  if (env.TERM?.includes('sixel') || env.SIXEL_SUPPORT === 'true') {
    cachedProtocol = 'sixel'
    return cachedProtocol
  }

  cachedProtocol = 'none'
  return cachedProtocol
}

/**
 * Check if terminal supports inline images
 */
export function supportsInlineImages(): boolean {
  return detectTerminalImageSupport() !== 'none'
}

/**
 * Generate iTerm2 inline image escape sequence
 * @param base64Data - Base64 encoded image data
 * @param options - Display options
 */
function generateITerm2ImageSequence(
  base64Data: string,
  options: {
    width?: number | string // cells or 'auto'
    height?: number | string // cells or 'auto'
    preserveAspectRatio?: boolean
    inline?: boolean
    name?: string
  } = {},
): string {
  const {
    width = 'auto',
    height = 'auto',
    preserveAspectRatio = true,
    inline = true,
    name,
  } = options

  // Build the parameter string
  const params: string[] = []

  if (inline) {
    params.push('inline=1')
  }

  if (width !== 'auto') {
    params.push(`width=${width}`)
  }

  if (height !== 'auto') {
    params.push(`height=${height}`)
  }

  if (!preserveAspectRatio) {
    params.push('preserveAspectRatio=0')
  }

  if (name) {
    params.push(`name=${Buffer.from(name).toString('base64')}`)
  }

  // Add size parameter (required)
  params.push(`size=${base64Data.length}`)

  const paramString = params.join(';')

  // Format: ESC ] 1337 ; File = [params] : base64data BEL
  // Using \x1b for ESC and \x07 for BEL
  return `\x1b]1337;File=${paramString}:${base64Data}\x07`
}

/**
 * Generate Kitty graphics protocol escape sequence
 * @param base64Data - Base64 encoded image data
 * @param options - Display options
 */
function generateKittyImageSequence(
  base64Data: string,
  options: {
    width?: number // cells
    height?: number // cells
    id?: number
  } = {},
): string {
  const { width, height, id } = options

  // Build key-value pairs for the control data
  const kvPairs: string[] = [
    'a=T', // action: transmit and display
    'f=100', // format: PNG (100) - let Kitty auto-detect
    't=d', // transmission: direct (data follows)
  ]

  if (width) {
    kvPairs.push(`c=${width}`) // columns
  }

  if (height) {
    kvPairs.push(`r=${height}`) // rows
  }

  if (id) {
    kvPairs.push(`i=${id}`) // image id
  }

  const controlData = kvPairs.join(',')

  // Kitty requires chunked transmission for large images
  // For simplicity, we'll send in one chunk if small enough
  const CHUNK_SIZE = 4096

  if (base64Data.length <= CHUNK_SIZE) {
    // Single chunk: ESC _ G <control> ; <data> ESC \
    return `\x1b_G${controlData};${base64Data}\x1b\\`
  }

  // Multi-chunk transmission
  const chunks: string[] = []
  for (let i = 0; i < base64Data.length; i += CHUNK_SIZE) {
    const chunk = base64Data.slice(i, i + CHUNK_SIZE)
    const isLast = i + CHUNK_SIZE >= base64Data.length
    const chunkControl = isLast ? controlData : `${controlData},m=1` // m=1 means more chunks coming
    chunks.push(`\x1b_G${chunkControl};${chunk}\x1b\\`)
  }

  return chunks.join('')
}

/**
 * Render an image inline in the terminal
 * @param base64Data - Base64 encoded image data
 * @param options - Display options
 * @returns The escape sequence string, or null if not supported
 */
export function renderInlineImage(
  base64Data: string,
  options: {
    width?: number
    height?: number
    filename?: string
  } = {},
): string | null {
  const protocol = detectTerminalImageSupport()

  switch (protocol) {
    case 'iterm2':
      return generateITerm2ImageSequence(base64Data, {
        width: options.width,
        height: options.height,
        name: options.filename,
      })

    case 'kitty':
      return generateKittyImageSequence(base64Data, {
        width: options.width,
        height: options.height,
      })

    case 'sixel':
      // Sixel is more complex and requires actual image decoding
      // For now, return null and fall back to metadata display
      return null

    case 'none':
    default:
      return null
  }
}

/**
 * P1-T7: parse a DA1 (Primary Device Attributes) response for image-capable
 * terminals. DA1 answers look like `\x1b[?1;2;6;...c` where the numeric params
 * list the terminal's attributes. This is a PURE parser: no IO, no timing —
 * the (opt-in, time-bounded) query that produces the response string lives in
 * the wiring layer, not here.
 *
 * The mapping is heuristic and conservative: kitty (xtgettcap/kitty graphics)
 * and iTerm2 are recognized; sixel is reported when its attribute (4) or an
 * explicit sixel marker appears; anything else (including an empty/unparseable
 * response) is 'none'. Never throws.
 */
export function parseDa1ImageCapability(
  response: string,
): TerminalImageProtocol {
  if (!response || typeof response !== 'string') return 'none'

  // Strip the CSI introducer and trailing 'c', then split the `?`-params.
  // Accepts `\x1b[?1;2c`, `\x9b?1;2c`, and a bare `?1;2c` fragment.
  const match = /\?([0-9;]*)c/.exec(response)
  if (!match) return 'none'
  const params = match[1]
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

  // Sixel: DA1 attribute 4 (device supports sixel graphics).
  if (params.includes('4')) return 'sixel'

  // kitty advertises image support via XTGETTCAP rather than DA1 params; when
  // a combined probe response carries the kitty marker, prefer it.
  if (/kitty/i.test(response)) return 'kitty'
  if (/iTerm/i.test(response)) return 'iterm2'

  return 'none'
}

/**
 * Get a user-friendly description of the terminal image support
 */
export function getImageSupportDescription(): string {
  const protocol = detectTerminalImageSupport()

  switch (protocol) {
    case 'iterm2':
      return 'iTerm2 inline images'
    case 'kitty':
      return 'Kitty graphics protocol'
    case 'sixel':
      return 'Sixel graphics'
    case 'none':
      return 'No inline image support'
  }
}
