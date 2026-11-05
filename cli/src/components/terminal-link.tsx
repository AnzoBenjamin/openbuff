import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from './button'
import { useTheme } from '../hooks/use-theme'
import { safeOpen } from '../utils/open-url'

type FormatLinesFn = (text: string, maxWidth?: number) => string[]

export interface TerminalLinkProps {
  text: string
  maxWidth?: number
  formatLines?: FormatLinesFn
  color?: string
  activeColor?: string
  underlineOnHover?: boolean
  isActive?: boolean
  onActivate?: () => void | Promise<any>
  containerStyle?: Record<string, unknown>
  lineWrap?: boolean
  inline?: boolean
}

const defaultFormatLines: FormatLinesFn = (text) => [text]
const PREFIXES_TO_STRIP = ['https://', 'http://']

export const TerminalLink: React.FC<TerminalLinkProps> = ({
  text,
  maxWidth,
  formatLines = defaultFormatLines,
  color,
  activeColor,
  underlineOnHover = true,
  isActive = false,
  onActivate,
  containerStyle,
  lineWrap = false,
  inline = false,
}) => {
  const theme = useTheme()

  // Use theme colors as defaults if not provided
  const linkColor = color ?? theme.link
  const linkActiveColor = activeColor ?? theme.success
  const [isHovered, setIsHovered] = useState(false)
  const [openState, setOpenState] = useState<
    'idle' | 'opening' | 'opened' | 'completed' | 'failed'
  >('idle')
  const pending = useRef<{ id: symbol; target: string } | null>(null)
  const currentTarget = useRef(text)
  currentTarget.current = text
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    setOpenState('idle')
  }, [text])

  const displayLines = useMemo(() => {
    let displayText = text.trim()
    for (const prefix of PREFIXES_TO_STRIP) {
      if (displayText.startsWith(prefix)) {
        displayText = displayText.slice(prefix.length)
      }
    }

    const formatted = formatLines(displayText, maxWidth)
    if (formatted.length <= 1) {
      return formatted
    }
    return formatted.filter((line) => line.trim().length > 0)
  }, [formatLines, maxWidth, text])

  const displayColor = isActive ? linkActiveColor : linkColor
  const shouldUnderline = underlineOnHover && isHovered

  const handleActivate = useCallback(async () => {
    if (pending.current?.target === text) return
    const owner = Symbol('link-open')
    pending.current = { id: owner, target: text }
    setOpenState('opening')
    try {
      const result = await (onActivate ? onActivate() : safeOpen(text))
      if (
        mounted.current &&
        pending.current?.id === owner &&
        currentTarget.current === text
      )
        setOpenState(
          result === false
            ? 'failed'
            : result === true
              ? 'opened'
              : 'completed',
        )
    } catch {
      if (
        mounted.current &&
        pending.current?.id === owner &&
        currentTarget.current === text
      )
        setOpenState('failed')
    } finally {
      if (pending.current?.id === owner) pending.current = null
    }
  }, [onActivate, text])

  // For inline mode, render without hover/click support (spans don't support mouse events)
  if (inline) {
    return <span fg={displayColor}>{text}</span>
  }

  return (
    <Button
      style={{
        flexDirection: 'column',
        alignItems: 'flex-start',
        width: '100%',
        gap: 0,
        ...containerStyle,
      }}
      onMouseOver={() => setIsHovered(true)}
      onMouseOut={() => setIsHovered(false)}
      onClick={handleActivate}
    >
      {displayLines.map((line: string, index: number) => {
        const coloredText = <span fg={displayColor}>{line}</span>
        return (
          <text key={index} style={{ wrapMode: lineWrap ? 'word' : 'none' }}>
            {shouldUnderline ? <u>{coloredText}</u> : coloredText}
          </text>
        )
      })}
      {openState !== 'idle' && (
        <text
          fg={openState === 'failed' ? theme.error : theme.muted}
          style={{ wrapMode: 'word' }}
        >
          {openState === 'failed'
            ? `Could not open ${text}. Open or copy this destination manually; activate again to retry.`
            : openState === 'opening'
              ? 'Opening…'
              : openState === 'opened'
                ? 'Opened in browser'
                : 'Link action completed'}
        </text>
      )}
    </Button>
  )
}
