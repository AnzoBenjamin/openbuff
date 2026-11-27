import React, { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from './button'
import { useTheme } from '../hooks/use-theme'

interface ErrorBoundaryProps {
  children: ReactNode
  fallback: ReactNode
  componentName?: string
  allowRetry?: boolean
  maxRetries?: number
  onInspect?: () => void
}

interface ErrorBoundaryState {
  failed: boolean
  retries: number
}

function RenderRecovery({
  onRetry,
  onInspect,
  retries,
  limit,
}: {
  onRetry?: () => void
  onInspect?: () => void
  retries: number
  limit: number
}) {
  const theme = useTheme()
  return (
    <box style={{ flexDirection: 'column' }}>
      <text fg={theme.error}>
        View failed · retained results are unchanged.
      </text>
      {onInspect && (
        <Button onClick={onInspect}>
          <text fg={theme.primary}>Inspect retained source</text>
        </Button>
      )}
      {onRetry ? (
        <Button onClick={onRetry}>
          <text fg={theme.primary}>
            Retry view ({retries + 1}/{limit})
          </text>
        </Button>
      ) : (
        retries >= limit && (
          <text fg={theme.muted}>
            Retry limit reached · retained source remains available.
          </text>
        )
      )}
    </box>
  )
}

/** A real React render error boundary for nested TUI subtrees. */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { failed: false, retries: 0 }

  static getDerivedStateFromError(): Partial<ErrorBoundaryState> {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      `[${this.props.componentName ?? 'ErrorBoundary'}] Render failed:`,
      error,
      info.componentStack,
    )
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    if (!this.props.allowRetry && !this.props.onInspect)
      return this.props.fallback
    const limit = Math.max(0, Math.min(10, this.props.maxRetries ?? 3))
    return (
      <box style={{ flexDirection: 'column' }}>
        {this.props.fallback}
        <RenderRecovery
          retries={this.state.retries}
          limit={limit}
          onInspect={this.props.onInspect}
          onRetry={
            this.props.allowRetry && this.state.retries < limit
              ? () =>
                  this.setState((state) => ({
                    failed: false,
                    retries: state.retries + 1,
                  }))
              : undefined
          }
        />
      </box>
    )
  }
}

export const ErrorBoundaryPlaceholder = ErrorBoundary

export function withErrorFallback<T>(
  renderFn: () => T,
  fallback: T,
  componentName?: string,
): T {
  try {
    return renderFn()
  } catch (error) {
    console.error(
      `[${componentName ?? 'withErrorFallback'}] Error caught:`,
      error,
    )
    return fallback
  }
}
