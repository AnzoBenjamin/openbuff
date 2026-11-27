import { TextAttributes, parseColor } from '@opentui/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import { defineToolComponent } from './types'
import { useTheme } from '../../hooks/use-theme'
import { safeOpen } from '../../utils/open-url'
import { copyTextToClipboard } from '../../utils/clipboard'
import { Button } from '../button'
import type { ToolRenderConfig } from './types'
import type { RenderUIButtonWidget } from '@codebuff/common/tools/params/tool/render-ui'
import type { ChatTheme } from '../../types/theme-system'

type Variant = NonNullable<RenderUIButtonWidget['variant']>
export interface RenderUILinkDependencies {
  open: (url: string) => Promise<boolean>
  copy: (text: string) => Promise<void>
}
const dependencies: RenderUILinkDependencies = {
  open: safeOpen,
  copy: (text) => copyTextToClipboard(text, { suppressGlobalMessage: true }),
}

const isButtonWidget = (value: unknown): value is RenderUIButtonWidget => {
  if (!value || typeof value !== 'object') return false
  const widget = value as Partial<RenderUIButtonWidget>
  return (
    widget.type === 'button' &&
    typeof widget.text === 'string' &&
    Boolean(widget.text.trim()) &&
    typeof widget.link === 'string' &&
    Boolean(widget.link.trim()) &&
    (widget.variant === undefined ||
      widget.variant === 'primary' ||
      widget.variant === 'secondary')
  )
}

/** Choose the higher-contrast opaque foreground for a controlled primary fill. */
export function primaryButtonForeground(background: string): string {
  let color
  try {
    color = parseColor(background)
  } catch {
    return '#111827'
  }
  const channels = [color.r, color.g, color.b]
    .map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    )
  const luminance =
    channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05)
    ? '#000000'
    : '#ffffff'
}
export function getRenderUIButtonColors(
  theme: ChatTheme,
  variant: Variant,
  hovered: boolean,
) {
  return variant === 'secondary'
    ? {
        backgroundColor: hovered ? theme.surfaceHover : theme.surface,
        foregroundColor: theme.foreground,
      }
    : {
        backgroundColor: theme.primary,
        foregroundColor: primaryButtonForeground(theme.primary),
      }
}

export function RenderUIButton({
  widget,
  services = dependencies,
}: {
  widget: RenderUIButtonWidget
  services?: RenderUILinkDependencies
}) {
  const theme = useTheme()
  const [hovered, setHovered] = useState(false)
  const [state, setState] = useState<
    'idle' | 'opening' | 'launched' | 'failed' | 'copied' | 'copy_failed'
  >('idle')
  const pending = useRef(false)
  const generation = useRef(0)
  const launchedAt = useRef(-Infinity)
  const colors = getRenderUIButtonColors(
    theme,
    widget.variant ?? 'primary',
    hovered,
  )
  useEffect(() => {
    generation.current++
    pending.current = false
    launchedAt.current = -Infinity
    setState('idle')
    return () => {
      generation.current++
    }
  }, [widget.link])
  const open = useCallback(async () => {
    if (pending.current || performance.now() - launchedAt.current < 300) return
    pending.current = true
    const attempt = generation.current
    setState('opening')
    try {
      const launched = await services.open(widget.link)
      if (attempt !== generation.current) return
      if (launched) launchedAt.current = performance.now()
      setState(launched ? 'launched' : 'failed')
    } catch {
      if (attempt === generation.current) setState('failed')
    } finally {
      if (attempt === generation.current) pending.current = false
    }
  }, [services, widget.link])
  const copy = useCallback(async () => {
    if (pending.current) return
    pending.current = true
    const attempt = generation.current
    try {
      await services.copy(widget.link)
      if (attempt === generation.current) setState('copied')
    } catch {
      if (attempt === generation.current) setState('copy_failed')
    } finally {
      if (attempt === generation.current) pending.current = false
    }
  }, [services, widget.link])
  const feedback =
    state === 'opening'
      ? 'Opening browser…'
      : state === 'launched'
        ? 'Browser launch requested'
        : state === 'failed'
          ? 'Browser launch unavailable · copy the address to open it manually'
          : state === 'copied'
            ? 'Address copied'
            : state === 'copy_failed'
              ? 'Copy failed · the address remains available for manual selection'
              : ''
  return (
    <box style={{ flexDirection: 'column', width: '100%' }}>
      <Button
        onClick={open}
        onMouseOver={() => setHovered(true)}
        onMouseOut={() => setHovered(false)}
        style={{
          backgroundColor: colors.backgroundColor,
          paddingLeft: 1,
          paddingRight: 1,
          alignSelf: 'flex-start',
        }}
      >
        <text style={{ wrapMode: 'word' }}>
          <span
            fg={colors.foregroundColor}
            attributes={hovered ? TextAttributes.BOLD : undefined}
          >
            {widget.text}
          </span>
        </text>
      </Button>
      {feedback ? (
        <text
          fg={
            state === 'failed' || state === 'copy_failed'
              ? theme.warning
              : theme.muted
          }
          style={{ wrapMode: 'word' }}
        >
          {feedback}
        </text>
      ) : null}
      {state === 'failed' || state === 'copy_failed' || state === 'copied' ? (
        <box style={{ flexDirection: 'column' }}>
          <text fg={theme.foreground} style={{ wrapMode: 'word' }}>
            {widget.link.length > 220
              ? `${widget.link.slice(0, 220)}… · Inspect submitted input for the full address`
              : widget.link}
          </text>
          <Button onClick={copy}>
            <text fg={theme.link}>Copy address</text>
          </Button>
        </box>
      ) : null}
    </box>
  )
}
export const RenderUIComponent = defineToolComponent({
  toolName: 'render_ui',
  render(block): ToolRenderConfig {
    const widget = block.input?.widget
    if (!isButtonWidget(widget)) return { content: null }
    return {
      content: <RenderUIButton widget={widget} />,
      collapsedPreview: `${widget.text} -> ${widget.link}`,
    }
  },
})
