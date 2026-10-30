import { describe, test, expect, beforeEach, mock } from 'bun:test'
import stringWidth from 'string-width'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { useChatInput, estimatedAgentModeToggleWidth } from '../use-chat-input'

import type { InputValue } from '../../types/store'
import type { AgentMode } from '../../utils/constants'

// Minimal renderHook shim using SSR. The hook only uses React hooks and
// zustand, no DOM APIs, so server-side rendering is sufficient to invoke it.
//
// Note: Zustand's useSyncExternalStore returns getServerSnapshot() during SSR,
// which snapshots the initial store state. Mutating the store via setState
// before render is NOT visible during SSR, so inputMode-dependent tests can't
// rely on store mutation. The isCompactHeight and isNarrowWidth props exercise
// the same estimatedToggleWidth=0 branch that bash mode would trigger.
const renderHook = <T, P>(
  hook: (props: P) => T,
  initialProps: P,
): { result: { current: T }; rerender: (props: P) => void } => {
  let result: T
  let props = initialProps

  const Comp = () => {
    result = hook(props)
    return null as unknown as React.ReactElement
  }

  const render = () => {
    void renderToStaticMarkup(React.createElement(Comp as React.FC))
  }
  render()

  return {
    result: {
      get current() {
        return result!
      },
    },
    rerender: (nextProps: P) => {
      props = nextProps
      render()
    },
  }
}

const baseOptions = {
  setAgentMode: mock((mode: AgentMode) => {}),
  setInputValue: mock((value: InputValue) => {}),
  separatorWidth: 80,
  initialPrompt: null as string | null,
  onSubmitPrompt: mock((_content: string, _mode: AgentMode) => {}),
  isCompactHeight: false,
  isNarrowWidth: false,
  // Default mode renders no label/icon box in front of the input, so the text
  // wraps at the full content width and the expectations below stay literal.
  modeWidthAdjustment: 0,
}

describe('useChatInput', () => {
  beforeEach(() => {
    baseOptions.setAgentMode.mockClear()
    baseOptions.setInputValue.mockClear()
    baseOptions.onSubmitPrompt.mockClear()
  })

  test('handleBuildFast sets EXECUTE_PLAN mode and fills "Build it!"', () => {
    const { result } = renderHook(useChatInput, {
      ...baseOptions,
      agentMode: 'DEFAULT' as AgentMode,
    })

    result.current.handleBuildFast()

    expect(baseOptions.setAgentMode).toHaveBeenCalledWith('EXECUTE_PLAN')
    const setCalls = baseOptions.setInputValue.mock.calls as Array<[InputValue]>
    // The first call sets the "Build it!" text
    expect(setCalls[0][0]).toMatchObject({
      text: 'Build it!',
      cursorPosition: 9,
      lastEditDueToNav: true,
    })
  })

  test('handleBuildFast submits the prompt and clears input asynchronously', async () => {
    const { result } = renderHook(useChatInput, {
      ...baseOptions,
      agentMode: 'DEFAULT' as AgentMode,
    })

    result.current.handleBuildFast()

    // Wait for the setTimeout(0) to fire
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(baseOptions.onSubmitPrompt).toHaveBeenCalledWith(
      'Build it!',
      'EXECUTE_PLAN',
    )

    const setCalls = baseOptions.setInputValue.mock.calls as Array<[InputValue]>
    // The last call clears the input
    const lastCall = setCalls[setCalls.length - 1][0]
    expect(lastCall).toMatchObject({
      text: '',
      cursorPosition: 0,
      lastEditDueToNav: false,
    })
  })

  test('computes non-zero toggle width in default mode on normal width', () => {
    const { result } = renderHook(useChatInput, {
      ...baseOptions,
      agentMode: 'DEFAULT' as AgentMode,
      separatorWidth: 80,
    })

    // estimatedToggleWidth = stringWidth(`< DEFAULT`) + 6 = 9 + 6 = 15
    // inputWidth = max(1, 80 - 2 - 15) = 63
    expect(result.current.inputWidth).toBe(63)
  })

  test('hides toggle width when isCompactHeight is true', () => {
    // isCompactHeight exercises the same estimatedToggleWidth=0 branch as
    // bash mode (inputMode !== 'default'), without needing store mutation
    // which is invisible during SSR via useSyncExternalStore.
    const { result } = renderHook(useChatInput, {
      ...baseOptions,
      agentMode: 'DEFAULT' as AgentMode,
      separatorWidth: 80,
      isCompactHeight: true,
    })

    // Toggle width = 0, so inputWidth = 80 - 2 = 78
    expect(result.current.inputWidth).toBe(78)
  })

  test('hides toggle width when isNarrowWidth is true', () => {
    const { result } = renderHook(useChatInput, {
      ...baseOptions,
      agentMode: 'DEFAULT' as AgentMode,
      separatorWidth: 80,
      isNarrowWidth: true,
    })

    // Toggle width = 0, so inputWidth = 80 - 2 = 78
    expect(result.current.inputWidth).toBe(78)
  })

  test('subtracts the active mode prefix from the input width', () => {
    // bash mode renders ` ! ` plus padding (widthAdjustment 4) in front of the
    // text, so the rows the box wraps and the rows the caller measured only
    // agree if the text width excludes those columns.
    const { result } = renderHook(useChatInput, {
      ...baseOptions,
      agentMode: 'DEFAULT' as AgentMode,
      separatorWidth: 80,
      isCompactHeight: true,
      modeWidthAdjustment: 4,
    })

    expect(result.current.inputWidth).toBe(80 - 2 - 4)
  })

  test('clamps inputWidth to at least 1 for tiny separators', () => {
    const { result } = renderHook(useChatInput, {
      ...baseOptions,
      agentMode: 'DEFAULT' as AgentMode,
      separatorWidth: 1,
    })

    expect(result.current.inputWidth).toBeGreaterThanOrEqual(1)
  })
})

describe('estimatedAgentModeToggleWidth', () => {
  // The gate mirrors the RENDER condition: the bar draws the toggle when the
  // mode config says so and it is full-height and non-narrow. The SSR shim
  // above cannot see store mutations, so the mode-dependent half of the gate
  // is tested through this pure function instead of the hook.
  test('a mode that keeps the toggle drawn estimates its width (help, homeDir)', () => {
    // Both keep showAgentModeToggle: true while not being 'default' — the old
    // `inputMode !== 'default'` gate estimated 0 for them, overstating the
    // drawable columns by the toggle's width.
    expect(estimatedAgentModeToggleWidth('help', 'DEFAULT', false, false)).toBe(
      stringWidth('< DEFAULT') + 6,
    )
    expect(
      estimatedAgentModeToggleWidth('homeDir', 'DEFAULT', false, false),
    ).toBe(stringWidth('< DEFAULT') + 6)
  })

  test('a mode without the toggle estimates zero (bash)', () => {
    expect(
      estimatedAgentModeToggleWidth('bash', 'DEFAULT', false, false),
    ).toBe(0)
  })

  test('compact height and narrow width estimate zero in every mode', () => {
    expect(estimatedAgentModeToggleWidth('default', 'DEFAULT', true, false)).toBe(0)
    expect(estimatedAgentModeToggleWidth('default', 'DEFAULT', false, true)).toBe(0)
  })
})

describe('useChatInput width clamping', () => {
  test('clamps inputWidth to at least one column when estimates exceed it', () => {
    const { result } = renderHook(useChatInput, {
      ...baseOptions,
      agentMode: 'DEFAULT' as AgentMode,
      separatorWidth: 10,
    })
    // 10 - 2 padding - 15 toggle is negative; the drawable area never drops
    // below one column, which the wrap measurement needs to stay well-defined.
    expect(result.current.inputWidth).toBe(1)
  })
})
