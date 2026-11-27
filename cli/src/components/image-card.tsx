import { useState } from 'react'

import { AttachmentCard } from './attachment-card'
import { ImageThumbnail } from './image-thumbnail'
import { useTheme } from '../hooks/use-theme'
import { supportsInlineImages } from '../utils/terminal-images'
import { useTerminalDimensions } from '../hooks/use-terminal-dimensions'
import { fitAttachmentName } from '../utils/attachment-names'
import { createAttachmentDocument } from '../utils/attachment-document'
import { useOutputReaderStore } from '../state/output-reader-store'

// Image card display constants
const MAX_FILENAME_LENGTH = 16
const IMAGE_CARD_WIDTH = 18
const THUMBNAIL_WIDTH = 14
const THUMBNAIL_HEIGHT = 3

export interface ImageCardImage {
  path: string
  filename: string
  status?: 'processing' | 'ready' | 'error' // Defaults to 'ready' if not provided
  note?: string // Display note: 'compressed' | error message
  processedImage?: {
    base64: string
    mediaType: string
  }
}

interface ImageCardProps {
  image: ImageCardImage
  onRemove?: () => void
  showRemoveButton?: boolean
  onInspect?: () => void
  onRetry?: () => void
}

export const ImageCard = ({
  image,
  onRemove,
  showRemoveButton = true,
  onInspect,
  onRetry,
}: ImageCardProps) => {
  const theme = useTheme()
  const { terminalWidth } = useTerminalDimensions()
  const width = Math.max(4, Math.min(IMAGE_CARD_WIDTH, terminalWidth - 10))
  const [thumbnailState, setThumbnailState] = useState<
    'loading' | 'ready' | 'error'
  >('loading')
  const [previewRetry, setPreviewRetry] = useState(0)
  const [failedSource, setFailedSource] = useState<string | null>(null)
  const canShowInlineImages = supportsInlineImages()

  const source = image.processedImage
    ? `data:${image.processedImage.mediaType};base64,${image.processedImage.base64}`
    : image.path.startsWith('clipboard:')
      ? null
      : image.path

  const truncatedName = fitAttachmentName(
    image.filename,
    Math.min(MAX_FILENAME_LENGTH, width - 4),
  )
  const previewNote =
    (image.status ?? 'ready') === 'processing'
      ? 'processing…'
      : image.status === 'error'
        ? (image.note ?? 'Image failed')
        : image.processedImage?.base64 === ''
          ? 'Empty capture'
          : failedSource === source ||
              (!canShowInlineImages && thumbnailState === 'error')
            ? 'Preview failed'
            : image.note

  return (
    <AttachmentCard
      width={width}
      onRemove={onRemove}
      showRemoveButton={showRemoveButton}
      onRetry={() => {
        setFailedSource(null)
        setThumbnailState('loading')
        setPreviewRetry((value) => value + 1)
        onRetry?.()
      }}
      onInspect={
        onInspect ??
        (() =>
          useOutputReaderStore.getState().open({
            document: createAttachmentDocument({
              ...image,
              kind: 'image',
              status: image.status ?? 'ready',
            }),
          }))
      }
    >
      {/* Thumbnail or icon area */}
      <box
        style={{
          height: THUMBNAIL_HEIGHT,
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        {canShowInlineImages &&
        source &&
        failedSource !== source &&
        (image.status ?? 'ready') === 'ready' ? (
          <image
            source={source}
            protocol="auto"
            onError={() => setFailedSource(source)}
            style={{ width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT }}
          />
        ) : (
          <ImageThumbnail
            image={image}
            width={THUMBNAIL_WIDTH}
            height={THUMBNAIL_HEIGHT}
            fallback={<text style={{ fg: theme.muted }}>img</text>}
            onLoadState={setThumbnailState}
            retryToken={previewRetry}
          />
        )}
      </box>

      {/* Filename - full width */}
      <box
        style={{
          paddingLeft: 1,
          paddingRight: 1,
          flexDirection: 'column',
        }}
      >
        <text
          style={{
            fg: theme.foreground,
            wrapMode: 'none',
          }}
        >
          {truncatedName}
        </text>
        {previewNote && (
          <text
            style={{
              fg:
                image.status === 'error' ||
                previewNote === 'Empty capture' ||
                previewNote === 'Preview failed'
                  ? theme.error
                  : theme.muted,
              wrapMode: 'none',
            }}
          >
            {previewNote}
          </text>
        )}
      </box>
    </AttachmentCard>
  )
}
