import { TextAttributes } from '@opentui/core'
import { memo, useMemo } from 'react'

import { useTheme } from '../../hooks/use-theme'
import { calculateDisplaySize } from '../../utils/image-display'
import {
  supportsInlineImages,
  getImageSupportDescription,
} from '../../utils/terminal-images'

import type { ImageContentBlock } from '../../types/chat'

interface ImageBlockProps {
  block: ImageContentBlock
  availableWidth: number
}

export const ImageBlock = memo(({ block, availableWidth }: ImageBlockProps) => {
  const theme = useTheme()

  const { image, mediaType, filename, size, width, height, imageRedacted } =
    block

  // Calculate display dimensions based on actual image dimensions
  const displaySize = useMemo(
    () => calculateDisplaySize({ width, height, availableWidth }),
    [width, height, availableWidth],
  )

  // D47 Stage 4: gate native <image> rendering on our own protocol detection
  // module (kept as the source of truth per the migration plan). OpenTUI
  // 0.5.12's ImageRenderable picks the actual wire protocol itself via
  // protocol: 'auto' (options verified against
  // node_modules/@opentui/core/renderables/Image.d.ts).
  const canRenderNatively = useMemo(() => {
    if (!image.trim()) {
      return false
    }

    return supportsInlineImages()
  }, [image])

  // Format file size
  const formattedSize = useMemo(() => {
    if (!size) return null
    if (size < 1024) return `${size}B`
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`
    return `${(size / (1024 * 1024)).toFixed(1)}MB`
  }, [size])

  // Get file extension for display
  const fileExtension = useMemo(() => {
    if (filename) {
      const parts = filename.split('.')
      return parts.length > 1 ? parts[parts.length - 1].toUpperCase() : null
    }
    // Extract from mediaType
    const match = mediaType.match(/image\/(\w+)/)
    return match ? match[1].toUpperCase() : null
  }, [filename, mediaType])

  if (canRenderNatively) {
    // Native inline image via OpenTUI 0.5.12's <image> renderable
    // (jsx-namespace.d.ts declares `image: ImageProps`). The source is a
    // data-URI string — ImageSource accepts string (verified against
    // node_modules/@opentui/core/image.d.ts) — sized in cells by
    // calculateDisplaySize via the renderable's style width/height.
    return (
      <box style={{ flexDirection: 'column', gap: 0 }}>
        {/* Image caption/metadata */}
        <text style={{ wrapMode: 'none', fg: theme.muted }}>
          <span>{filename || 'Image'}</span>
          {formattedSize && (
            <span attributes={TextAttributes.DIM}> ({formattedSize})</span>
          )}
        </text>

        {/* The actual inline image - native renderable */}
        <image
          source={`data:${mediaType};base64,${image}`}
          protocol="auto"
          style={{ width: displaySize.width, height: displaySize.height }}
        />
      </box>
    )
  }

  // Fallback: Display image metadata when inline rendering not supported
  return (
    <box
      style={{
        flexDirection: 'column',
        gap: 0,
        paddingLeft: 1,
        borderStyle: 'single',
        borderColor: theme.border,
      }}
    >
      {/* Header */}
      <text style={{ wrapMode: 'none', fg: theme.foreground }}>
        <span attributes={TextAttributes.BOLD}>Image attachment</span>
      </text>

      {/* Filename */}
      {filename && (
        <text style={{ wrapMode: 'none', fg: theme.foreground }}>
          <span attributes={TextAttributes.DIM}>Name: </span>
          <span>{filename}</span>
        </text>
      )}

      {/* Type */}
      <text style={{ wrapMode: 'none', fg: theme.muted }}>
        <span attributes={TextAttributes.DIM}>Type: </span>
        <span>{fileExtension || mediaType}</span>
      </text>

      {/* Size */}
      {formattedSize && (
        <text style={{ wrapMode: 'none', fg: theme.muted }}>
          <span attributes={TextAttributes.DIM}>Size: </span>
          <span>{formattedSize}</span>
        </text>
      )}

      {imageRedacted && (
        <text style={{ wrapMode: 'word', fg: theme.muted }}>
          Image data omitted from saved chat state.
        </text>
      )}

      {/* Hint about terminal support */}
      {!imageRedacted && (
        <text
          style={{ wrapMode: 'word', fg: theme.muted, marginTop: 1 }}
          attributes={TextAttributes.DIM}
        >
          {`(${getImageSupportDescription()} - use iTerm2 or Kitty for inline display)`}
        </text>
      )}
    </box>
  )
})
