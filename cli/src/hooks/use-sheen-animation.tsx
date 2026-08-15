import React, { useCallback, useEffect, useState } from 'react'

import {
  SHADOW_CHARS,
  SHEEN_STEP,
  SHEEN_INTERVAL_MS,
  getSheenColor,
} from '../components/logo-constants'

interface UseSheenAnimationParams {
  logoColor: string
  accentColor: string
  blockColor: string
  terminalWidth: number | undefined
  sheenPosition: number
  setSheenPosition: (value: number | ((prev: number) => number)) => void
  enabled?: boolean
}

export function useSheenAnimation({
  logoColor,
  accentColor,
  blockColor,
  terminalWidth,
  sheenPosition,
  setSheenPosition,
  enabled = true,
}: UseSheenAnimationParams) {
  const [isReversing, setIsReversing] = useState(false)

  useEffect(() => {
    if (!enabled) return

    const maxPosition = Math.max(10, Math.min((terminalWidth || 80) - 4, 100))
    const step = SHEEN_STEP

    const interval = setInterval(() => {
      setSheenPosition((prev) => {
        const next = prev + step
        if (next >= maxPosition) {
          setIsReversing((wasReversing) => !wasReversing)
          return 0
        }
        return next
      })
    }, SHEEN_INTERVAL_MS)

    return () => {
      clearInterval(interval)
    }
  }, [enabled, terminalWidth, setSheenPosition])

  const applySheenToChar = useCallback(
    (char: string, charIndex: number) => {
      if (char === ' ' || char === '\n') {
        return <span key={charIndex}>{char}</span>
      }

      const color = getSheenColor(
        char,
        charIndex,
        sheenPosition,
        logoColor,
        SHADOW_CHARS,
        accentColor,
        blockColor,
        isReversing,
      )

      return (
        <span key={charIndex} fg={color}>
          {char}
        </span>
      )
    },
    [sheenPosition, logoColor, accentColor, blockColor, isReversing],
  )

  return {
    applySheenToChar,
  }
}
