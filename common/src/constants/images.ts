/**
 * Image-related constants shared across the codebase
 */

/**
 * Extension to MIME type mapping for supported image formats
 */
export const IMAGE_EXTENSION_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
}

/**
 * Supported image extensions (derived from IMAGE_EXTENSION_TO_MIME)
 */
export const SUPPORTED_IMAGE_EXTENSIONS = new Set(
  Object.keys(IMAGE_EXTENSION_TO_MIME),
)

/**
 * Check if a file extension is a supported image format
 */
export function isSupportedImageExtension(ext: string): boolean {
  return SUPPORTED_IMAGE_EXTENSIONS.has(ext.toLowerCase())
}

/**
 * Get MIME type for an image extension
 */
export function getImageMimeType(ext: string): string | null {
  return IMAGE_EXTENSION_TO_MIME[ext.toLowerCase()] ?? null
}

/**
 * Detect an image MIME type from raw bytes by matching magic-number signatures.
 * Returns null when the bytes do not match a supported image format.
 */
export function detectImageMediaTypeFromBytes(
  bytes: Uint8Array | Buffer,
): string | null {
  const hasPrefix = (signature: number[], offset = 0): boolean => {
    if (bytes.length < offset + signature.length) {
      return false
    }
    for (let i = 0; i < signature.length; i++) {
      if (bytes[offset + i] !== signature[i]) {
        return false
      }
    }
    return true
  }
  const hasAscii = (text: string, offset = 0): boolean => {
    if (bytes.length < offset + text.length) {
      return false
    }
    for (let i = 0; i < text.length; i++) {
      if (bytes[offset + i] !== text.charCodeAt(i)) {
        return false
      }
    }
    return true
  }

  if (hasPrefix([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png'
  }
  if (hasPrefix([0xff, 0xd8, 0xff])) {
    return 'image/jpeg'
  }
  // "GIF8" covers both GIF87a and GIF89a.
  if (hasAscii('GIF8')) {
    return 'image/gif'
  }
  if (hasAscii('BM')) {
    return 'image/bmp'
  }
  if (hasAscii('RIFF') && hasAscii('WEBP', 8)) {
    return 'image/webp'
  }
  if (
    hasPrefix([0x49, 0x49, 0x2a, 0x00]) ||
    hasPrefix([0x4d, 0x4d, 0x00, 0x2a])
  ) {
    return 'image/tiff'
  }
  return null
}

/**
 * Image extensions as a regex alternation pattern (without dots)
 * e.g., "jpg|jpeg|png|webp|gif|bmp|tiff|tif"
 */
export const IMAGE_EXTENSIONS_PATTERN = Object.keys(IMAGE_EXTENSION_TO_MIME)
  .map((ext) => ext.slice(1)) // Remove leading dot
  .join('|')

// Size limits for image uploads
// Research shows Claude/GPT-4V support up to 20MB, but we use practical limits
// for good performance and token efficiency
export const MAX_IMAGE_FILE_SIZE = 10 * 1024 * 1024 // 10MB - allow larger files since we can compress
export const MAX_IMAGE_BASE64_SIZE = 1 * 1024 * 1024 // 1MB max for base64 after compression
export const MAX_TOTAL_IMAGE_SIZE = 5 * 1024 * 1024 // 5MB total for multiple images
