import {
  providerConfigFileSchema,
  resolveConfiguredAgentModelConfig,
} from '@openbuff/sdk'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { loadAgentDefinitions } from '../utils/local-agent-registry'

import { sliceTextCells } from '../utils/text-boundaries'
import { OutputReaderScreen } from './output-reader-screen'
import { createTextDocument } from '../utils/output-document'
import { MultilineInput } from './multiline-input'
import { SelectableList } from './selectable-list'
import { useTerminalLayout } from '../hooks/use-terminal-layout'
import { useTheme } from '../hooks/use-theme'
import { createTextPasteHandler } from '../utils/strings'
import {
  clearAgentRouteOverride,
  getEditableConfig,
  getFailoverModels,
  setFailoverModels,
  getKnownModelOptions,
  persistModelToProviderConfig,
  setRouteModel,
  writeMergedConfig,
} from '../utils/openbuff-provider'

import type { SelectableListItem } from './selectable-list'
import type {
  ModelRouteTarget,
  ReasoningEffortInput,
} from '../utils/openbuff-provider'
import type {
  OpenbuffReasoningEffort,
  ProviderConfigFileInput,
} from '@openbuff/sdk'

type RoutableModelValue =
  | string
  | { model: string; reasoningEffort?: OpenbuffReasoningEffort }

/** Extract display string from a routable model value (string or { model, reasoningEffort }). */
function displayModel(
  route: RoutableModelValue | undefined,
): string | undefined {
  if (!route) return undefined
  if (typeof route === 'string') return route
  return route.model
}

// --- Reasoning effort types and options ---\n
type ReasoningChoice = Exclude<ReasoningEffortInput, undefined>

interface ReasoningOption {
  value: ReasoningChoice
  label: string
  description: string
}

const REASONING_OPTIONS: ReasoningOption[] = [
  {
    value: 'default',
    label: 'Default',
    description: 'Use the agent/provider default reasoning effort',
  },
  {
    value: 'low',
    label: 'Low',
    description: 'Fast tool loops; good for straightforward edits',
  },
  {
    value: 'medium',
    label: 'Medium',
    description: 'Balanced reasoning for most tasks',
  },
  {
    value: 'high',
    label: 'High',
    description: 'More reasoning for planning and hard problems',
  },
  {
    value: 'minimal',
    label: 'Minimal',
    description: 'Cheapest/fastest where supported',
  },
  {
    value: 'none',
    label: 'None',
    description: 'Disable reasoning where supported',
  },
]

/** Read the current reasoning effort override for a route target from config. */
function getRouteReasoningEffort(
  config: ProviderConfigFileInput,
  target: ModelRouteTarget,
): OpenbuffReasoningEffort | undefined {
  const normalize = (
    effort: OpenbuffReasoningEffort | null | undefined,
  ): OpenbuffReasoningEffort | undefined => effort ?? undefined

  if (target.type === 'default') {
    return normalize(config.defaultReasoningEffort)
  }
  if (target.type === 'mode') {
    return normalize(config.modeReasoningEfforts?.[target.mode])
  }
  return normalize(config.agentReasoningEfforts?.[target.agentId])
}

/** Format reasoning effort for display in route labels. */
function formatReasoning(effort: OpenbuffReasoningEffort | undefined): string {
  return effort ? String(effort) : 'default'
}

interface RouteItem {
  id: string
  label: string
  secondary: string
  target?: ModelRouteTarget
  currentModel: string | undefined
  currentReasoningEffort: OpenbuffReasoningEffort | undefined
  isHeader?: boolean
  inherited?: boolean
}

interface ModelRoutePickerProps {
  onClose: () => void
  onConfigUpdated?: () => void
  dependencies?: {
    readConfig: typeof getEditableConfig
    models: typeof getKnownModelOptions
    agents: typeof loadAgentDefinitions
    writeConfig: typeof writeMergedConfig
  }
}

type PickerPane = 'left' | 'right'
type RightView = 'model-select' | 'reasoning-select' | 'failover-edit'

const isHeaderItem = (item: SelectableListItem | undefined): boolean =>
  item?.id.startsWith('section-') ?? false

const firstSelectableIndex = (items: SelectableListItem[]): number => {
  const index = items.findIndex((item) => !isHeaderItem(item))
  return index === -1 ? 0 : index
}

/** Filter out section headers that have no visible child routes. */
function filterOrphanHeaders(
  filtered: SelectableListItem[],
): SelectableListItem[] {
  const routeIds = new Set(
    filtered.filter((item) => !isHeaderItem(item)).map((item) => item.id),
  )

  const headerPrefixes = new Map<string, string[]>([
    ['section-default', ['route-default']],
    ['section-modes', ['route-mode-']],
    ['section-agents', ['route-agent-']],
    ['section-failover', ['failover-']],
  ])

  return filtered.filter((item) => {
    if (!isHeaderItem(item)) return true
    const prefixes = headerPrefixes.get(item.id)
    if (!prefixes) return false
    return prefixes.some((prefix) =>
      [...routeIds].some((routeId) => routeId.startsWith(prefix)),
    )
  })
}

const nextSelectableIndex = (
  items: SelectableListItem[],
  currentIndex: number,
  direction: 1 | -1,
): number => {
  if (items.length === 0) return 0

  let index = Math.max(0, Math.min(items.length - 1, currentIndex))
  for (let step = 0; step < items.length; step++) {
    index = Math.max(0, Math.min(items.length - 1, index + direction))
    if (!isHeaderItem(items[index])) return index
    if (index === 0 || index === items.length - 1) break
  }

  return isHeaderItem(items[currentIndex])
    ? firstSelectableIndex(items)
    : currentIndex
}

export const ModelRoutePicker: React.FC<ModelRoutePickerProps> = ({
  onClose,
  onConfigUpdated,
  dependencies = {
    readConfig: getEditableConfig,
    models: getKnownModelOptions,
    agents: loadAgentDefinitions,
    writeConfig: writeMergedConfig,
  },
}) => {
  const theme = useTheme()
  const { terminalWidth, terminalHeight } = useTerminalLayout()

  // Master State: Dual-Pane split screen Dashboard
  const [inspectedText, setInspectedText] = useState<string | null>(null)
  const [activePane, setActivePane] = useState<PickerPane>('left')
  const [leftSearchQuery, setLeftSearchQuery] = useState('')
  // Track the input cursor so paste inserts at the cursor (not always the end).
  const [leftSearchCursor, setLeftSearchCursor] = useState(0)
  const [leftFocusedIndex, setLeftFocusedIndex] = useState(0)

  const [rightView, setRightView] = useState<RightView>('model-select')
  const [rightSearchQuery, setRightSearchQuery] = useState('')
  const [rightSearchCursor, setRightSearchCursor] = useState(0)
  const [rightFocusedIndex, setRightFocusedIndex] = useState(0)

  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)
  const [selectedModelDiscovered, setSelectedModelDiscovered] = useState(false)

  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const statusClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [configKey, setConfigKey] = useState(0) // Force refresh after writes
  const [failoverEditIndex, setFailoverEditIndex] = useState<number | null>(
    null,
  )
  const [failoverAppendMode, setFailoverAppendMode] = useState(false)

  // Load current config
  const loaded = useMemo(() => {
    void configKey
    try {
      return { config: dependencies.readConfig(), error: null }
    } catch (error) {
      return {
        config: {} as ProviderConfigFileInput,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }, [configKey, dependencies.readConfig])
  const config = loaded.config

  // Build route items from config
  const routeItems: RouteItem[] = useMemo(() => {
    const items: RouteItem[] = []

    items.push({
      id: 'section-default',
      label: 'Default',
      secondary: '',
      currentModel: undefined,
      currentReasoningEffort: undefined,
      isHeader: true,
    })

    // Default model
    const defaultModel = displayModel(config.defaultModel)
    items.push({
      id: 'route-default',
      label: 'default',
      secondary: defaultModel ?? '(not set)',
      target: { type: 'default' },
      currentModel: defaultModel ?? undefined,
      currentReasoningEffort: getRouteReasoningEffort(config, {
        type: 'default',
      }),
    })

    items.push({
      id: 'section-modes',
      label: 'Modes',
      secondary: '',
      currentModel: undefined,
      currentReasoningEffort: undefined,
      isHeader: true,
    })

    // Modes
    const modes: Array<'default' | 'plan' | 'executePlan'> = [
      'default',
      'plan',
      'executePlan',
    ]
    for (const mode of modes) {
      const model = displayModel(config.modes?.[mode])
      items.push({
        id: `route-mode-${mode}`,
        label: `mode:${mode === 'executePlan' ? 'execute-plan' : mode}`,
        secondary: model ?? '(not set)',
        target: { type: 'mode', mode },
        currentModel: model ?? undefined,
        currentReasoningEffort: getRouteReasoningEffort(config, {
          type: 'mode',
          mode,
        }),
      })
    }

    items.push({
      id: 'section-agents',
      label: 'Agent overrides',
      secondary: '',
      currentModel: undefined,
      currentReasoningEffort: undefined,
      isHeader: true,
    })

    // Agent overrides
    const definitions = dependencies.agents()
    const normalizedConfig = providerConfigFileSchema.parse(config)
    const agentIds = new Set([
      ...definitions.map((agent) => agent.id),
      ...Object.keys(config.agents ?? {}),
    ])
    for (const agentId of agentIds) {
      const model = config.agents?.[agentId]
      const withoutOverride = {
        ...normalizedConfig,
        agents: { ...normalizedConfig.agents },
        agentReasoningEfforts: { ...normalizedConfig.agentReasoningEfforts },
      }
      delete withoutOverride.agents[agentId]
      delete withoutOverride.agentReasoningEfforts[agentId]
      let inheritedModel: string | undefined
      try {
        inheritedModel = resolveConfiguredAgentModelConfig({
          agentId,
          model: definitions.find((agent) => agent.id === agentId)?.model,
          loadedConfig: { config: withoutOverride, sourceFilePaths: [] },
        }).model
      } catch {
        inheritedModel = undefined
      }
      const inherited = model === undefined
      items.push({
        id: `route-agent-${agentId}`,
        label: `agent:${agentId}`,
        secondary: inherited
          ? `inherited: ${inheritedModel ?? '(not set)'}`
          : (displayModel(model) ?? '(not set)'),
        inherited,
        target: { type: 'agent', agentId },
        currentModel: displayModel(model) ?? undefined,
        currentReasoningEffort: getRouteReasoningEffort(config, {
          type: 'agent',
          agentId,
        }),
      })
    }

    items.push({
      id: 'section-failover',
      label: 'Failover chain',
      secondary: '',
      currentModel: undefined,
      currentReasoningEffort: undefined,
      isHeader: true,
    })

    // Failover chain: models tried, in order, after the primary fails. This
    // previously existed only as a hand-edited openbuff.json key.
    const failoverModels = config.failoverModels ?? []
    failoverModels.forEach((model, index) => {
      items.push({
        id: `failover-${index}`,
        label: `failover:${index + 1}`,
        secondary: model,
        currentModel: model,
        currentReasoningEffort: undefined,
      })
    })
    items.push({
      id: 'failover-add',
      label: 'failover:+ add model',
      secondary: 'tried in order after the primary fails',
      currentModel: undefined,
      currentReasoningEffort: undefined,
    })

    return items
  }, [config])

  // Convert to SelectableListItem format with reasoning in label
  const selectableRouteItems: SelectableListItem[] = useMemo(
    () =>
      routeItems.map((route) => {
        const reasoningSuffix =
          !route.isHeader && route.currentReasoningEffort
            ? ` (reasoning: ${formatReasoning(route.currentReasoningEffort)})`
            : ''
        return {
          id: route.id,
          label: route.isHeader
            ? route.label
            : `${route.label} → ${route.secondary}${reasoningSuffix}`,
          icon: route.isHeader ? '' : route.currentModel ? '✓' : '○',
          secondary: route.secondary,
          hideSecondary: true,
          accent: route.isHeader,
        }
      }),
    [routeItems],
  )

  const filteredRoutes = useMemo(() => {
    const raw = selectableRouteItems.filter((item) => {
      if (!leftSearchQuery.trim()) return true
      const q = leftSearchQuery.toLowerCase()
      return (
        item.label.toLowerCase().includes(q) ||
        (item.secondary ?? '').toLowerCase().includes(q)
      )
    })
    return filterOrphanHeaders(raw)
  }, [selectableRouteItems, leftSearchQuery])

  // Track currently highlighted Left Pane Route
  const highlightedRoute = useMemo(() => {
    const item = filteredRoutes[leftFocusedIndex]
    if (!item) return null
    return routeItems.find((r) => r.id === item.id) || null
  }, [filteredRoutes, leftFocusedIndex, routeItems])

  // Right Pane Model Options
  const availableModels = useMemo(() => {
    void configKey
    if (loaded.error) return []
    return dependencies.models()
  }, [configKey, loaded.error])

  const selectableModelItems: SelectableListItem[] = useMemo(
    () =>
      availableModels.map((option) => ({
        id: option.model,
        label: option.capabilitiesSummary
          ? `${option.model} | ${option.capabilitiesSummary}`
          : option.model,
        secondary: option.capabilitiesSummary,
      })),
    [availableModels],
  )

  const filteredModels = useMemo(() => {
    if (!rightSearchQuery.trim()) return selectableModelItems
    const q = rightSearchQuery.toLowerCase()
    return selectableModelItems.filter((item) =>
      item.label.toLowerCase().includes(q),
    )
  }, [selectableModelItems, rightSearchQuery])

  // Right Pane Reasoning Effort Options
  const currentReasoningForRoute = highlightedRoute?.currentReasoningEffort
  const selectableReasoningItems: SelectableListItem[] = useMemo(
    () =>
      REASONING_OPTIONS.map((option) => ({
        id: option.value,
        label:
          option.value === (currentReasoningForRoute ?? 'default')
            ? `${option.label} ✓`
            : option.label,
        secondary: option.description,
      })),
    [currentReasoningForRoute],
  )

  const filteredReasoningOptions = useMemo(() => {
    if (!rightSearchQuery.trim()) return selectableReasoningItems
    const q = rightSearchQuery.toLowerCase()
    return selectableReasoningItems.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        (item.secondary ?? '').toLowerCase().includes(q),
    )
  }, [selectableReasoningItems, rightSearchQuery])

  // Right Pane Items & Empty Messages
  const failoverEditItems = useMemo<SelectableListItem[]>(() => {
    const chain = config.failoverModels ?? []
    const index = failoverEditIndex
    const model = index !== null ? chain[index] : undefined
    return [
      {
        id: 'failover-op-up',
        label: `Move up${index !== null && index === 0 ? ' (already first)' : ''}`,
        secondary: model ?? '',
      },
      {
        id: 'failover-op-down',
        label: `Move down${index !== null && index === chain.length - 1 ? ' (already last)' : ''}`,
        secondary: model ?? '',
      },
      {
        id: 'failover-op-remove',
        label: 'Remove from chain',
        secondary: model ?? '',
      },
    ]
  }, [failoverEditIndex, config])

  const rightItems = useMemo(() => {
    if (rightView === 'failover-edit') return failoverEditItems
    return rightView === 'model-select'
      ? highlightedRoute?.target?.type === 'agent' && !failoverAppendMode
        ? [
            {
              id: 'use-inherited',
              label: 'Use inherited route',
              secondary: 'Clear this agent’s model and reasoning override',
            },
            ...filteredModels,
          ]
        : filteredModels
      : filteredReasoningOptions
  }, [
    rightView,
    filteredModels,
    filteredReasoningOptions,
    failoverEditItems,
    highlightedRoute,
    failoverAppendMode,
  ])

  const rightEmptyMessage = useMemo(() => {
    if (rightView === 'model-select') {
      return rightSearchQuery ? 'No matching models' : 'No models available'
    }
    return 'No reasoning options'
  }, [rightView, rightSearchQuery])

  // Bound indexes dynamically
  useEffect(() => {
    setLeftFocusedIndex((prev) =>
      Math.min(Math.max(0, filteredRoutes.length - 1), prev),
    )
  }, [filteredRoutes])

  useEffect(() => {
    setRightFocusedIndex((prev) =>
      Math.min(Math.max(0, rightItems.length - 1), prev),
    )
  }, [rightItems])

  useEffect(() => {
    return () => {
      if (statusClearTimerRef.current) {
        clearTimeout(statusClearTimerRef.current)
      }
    }
  }, [])

  // Core Keyboard Dashboard Navigation Interceptor
  const handleKeyIntercept = useCallback(
    (
      key: { name?: string; shift?: boolean; ctrl?: boolean },
      selection?: { pane: PickerPane; index: number },
    ) => {
      if (key.ctrl && key.name === 'r') {
        setConfigKey((k) => k + 1)
        return true
      }
      if (key.ctrl && key.name === 'o') {
        setInspectedText(
          activePane === 'left'
            ? `${highlightedRoute?.label ?? 'Route'}\nModel: ${highlightedRoute?.secondary ?? 'unavailable'}\nReasoning: ${formatReasoning(highlightedRoute?.currentReasoningEffort)}`
            : `${highlightedRoute?.label ?? 'Route'}\nCurrent model: ${highlightedRoute?.secondary ?? 'unavailable'}\nPending model: ${selectedModelId ?? rightItems[rightFocusedIndex]?.id ?? 'unavailable'}\nReasoning: ${rightView === 'reasoning-select' ? rightItems[rightFocusedIndex]?.id : formatReasoning(highlightedRoute?.currentReasoningEffort)}`,
        )
        return true
      }
      const pane = selection?.pane ?? activePane
      const leftIndex =
        selection?.pane === 'left' ? selection.index : leftFocusedIndex
      const rightIndex =
        selection?.pane === 'right' ? selection.index : rightFocusedIndex
      // Global exit key
      if (key.name === 'c' && key.ctrl) {
        onClose()
        return true
      }

      if (pane === 'left') {
        if (key.name === 'escape') {
          if (leftSearchQuery.length > 0) {
            setLeftSearchQuery('')
            return true
          }
          onClose()
          return true
        }
        if (key.name === 'up') {
          setLeftFocusedIndex((prev) =>
            nextSelectableIndex(filteredRoutes, prev, -1),
          )
          return true
        }
        if (key.name === 'down') {
          setLeftFocusedIndex((prev) =>
            nextSelectableIndex(filteredRoutes, prev, 1),
          )
          return true
        }
        if (
          key.name === 'return' ||
          key.name === 'enter' ||
          key.name === 'right' ||
          key.name === 'tab'
        ) {
          const focused = filteredRoutes[leftIndex]
          if (focused && !isHeaderItem(focused)) {
            setActivePane('right')
            setRightSearchQuery('')
            setRightFocusedIndex(0)
            if (focused.id === 'failover-add') {
              setFailoverAppendMode(true)
              setRightView('model-select')
            } else if (focused.id.startsWith('failover-')) {
              setFailoverEditIndex(Number(focused.id.slice('failover-'.length)))
              setRightView('failover-edit')
            } else {
              setFailoverAppendMode(false)
              setRightView('model-select')
            }
          }
          return true
        }
      } else if (pane === 'right') {
        if (key.name === 'escape' || key.name === 'left') {
          if (rightSearchQuery.length > 0) {
            setRightSearchQuery('')
            return true
          }
          setActivePane('left')
          return true
        }
        if (key.name === 'tab') {
          setActivePane('left')
          return true
        }
        if (key.name === 'up') {
          setRightFocusedIndex((prev) => Math.max(0, prev - 1))
          return true
        }
        if (key.name === 'down') {
          setRightFocusedIndex((prev) =>
            Math.min(rightItems.length - 1, prev + 1),
          )
          return true
        }
        if (key.name === 'return' || key.name === 'enter') {
          const focusedItem = rightItems[rightIndex]
          if (!focusedItem) return true

          if (rightView === 'failover-edit') {
            const chain = getFailoverModels()
            const index = failoverEditIndex
            if (index === null || chain[index] === undefined) {
              setActivePane('left')
              return true
            }
            let next = [...chain]
            let msg = ''
            if (focusedItem.id === 'failover-op-up' && index > 0) {
              ;[next[index - 1], next[index]] = [next[index]!, next[index - 1]!]
              msg = `✓ Moved ${chain[index]} up`
            } else if (
              focusedItem.id === 'failover-op-down' &&
              index < chain.length - 1
            ) {
              ;[next[index + 1], next[index]] = [next[index]!, next[index + 1]!]
              msg = `✓ Moved ${chain[index]} down`
            } else if (focusedItem.id === 'failover-op-remove') {
              next = next.filter((_, i) => i !== index)
              msg = `✓ Removed ${chain[index]} from failover chain`
            }
            if (msg) {
              try {
                setFailoverModels(next)
                setConfigKey((k) => k + 1)
                setStatusMessage(msg)
                setActivePane('left')
                setFailoverEditIndex(null)
                onConfigUpdated?.()
              } catch (error) {
                setStatusMessage(
                  `✗ ${error instanceof Error ? error.message : String(error)}`,
                )
              }
            } else {
              setActivePane('left')
            }
            return true
          }

          if (rightView === 'model-select') {
            if (
              focusedItem.id === 'use-inherited' &&
              highlightedRoute?.target?.type === 'agent'
            ) {
              try {
                const next = dependencies.readConfig()
                clearAgentRouteOverride(next, highlightedRoute.target.agentId)
                dependencies.writeConfig(next)
                setConfigKey((k) => k + 1)
                setStatusMessage(
                  `✓ ${highlightedRoute.label} now uses inherited routing`,
                )
                setActivePane('left')
                onConfigUpdated?.()
              } catch (error) {
                setStatusMessage(
                  `✗ ${error instanceof Error ? error.message : String(error)}`,
                )
              }
              return true
            }
            if (failoverAppendMode) {
              // Append the chosen model to the failover chain; no reasoning
              // step (failover inherits the route's reasoning config).
              try {
                const modelOption = availableModels.find(
                  (opt) => opt.model === focusedItem.id,
                )
                if (modelOption?.discovered) {
                  const slashIndex = focusedItem.id.indexOf('/')
                  if (
                    slashIndex > 0 &&
                    slashIndex < focusedItem.id.length - 1
                  ) {
                    persistModelToProviderConfig(
                      focusedItem.id.slice(0, slashIndex),
                      focusedItem.id.slice(slashIndex + 1),
                    )
                  }
                }
                const chain = getFailoverModels()
                if (chain.includes(focusedItem.id)) {
                  setStatusMessage(
                    `${focusedItem.id} is already in the failover chain`,
                  )
                } else {
                  setFailoverModels([...chain, focusedItem.id])
                  setConfigKey((k) => k + 1)
                  setStatusMessage(
                    `✓ Added ${focusedItem.id} to failover chain`,
                  )
                  onConfigUpdated?.()
                }
                setActivePane('left')
                setFailoverAppendMode(false)
              } catch (error) {
                setStatusMessage(
                  `✗ ${error instanceof Error ? error.message : String(error)}`,
                )
              }
              return true
            }
            // Model Selected! Progress to reasoning select
            const modelOption = availableModels.find(
              (opt) => opt.model === focusedItem.id,
            )
            setSelectedModelId(focusedItem.id)
            setSelectedModelDiscovered(modelOption?.discovered ?? false)
            setRightView('reasoning-select')
            setRightSearchQuery('')
            setRightFocusedIndex(
              Math.max(
                0,
                REASONING_OPTIONS.findIndex(
                  (option) =>
                    option.value ===
                    (highlightedRoute?.currentReasoningEffort ?? 'default'),
                ),
              ),
            )
          } else {
            // Reasoning Selected! Commit config to disk
            if (!highlightedRoute?.target || !selectedModelId) return true
            const reasoningChoice = focusedItem.id as ReasoningChoice

            try {
              if (selectedModelDiscovered) {
                const slashIndex = selectedModelId.indexOf('/')
                if (slashIndex > 0 && slashIndex < selectedModelId.length - 1) {
                  const providerId = selectedModelId.slice(0, slashIndex)
                  const modelId = selectedModelId.slice(slashIndex + 1)
                  persistModelToProviderConfig(providerId, modelId)
                }
              }

              const editableConfig = dependencies.readConfig()
              setRouteModel(
                editableConfig,
                highlightedRoute.target,
                selectedModelId,
                reasoningChoice,
              )
              dependencies.writeConfig(editableConfig)

              const reasoningDisplay =
                reasoningChoice === 'default' ? 'default' : reasoningChoice
              const msg = `✓ Saved: ${highlightedRoute.label} → ${selectedModelId} (reasoning: ${reasoningDisplay})`
              setStatusMessage(msg)

              if (statusClearTimerRef.current) {
                clearTimeout(statusClearTimerRef.current)
              }
              statusClearTimerRef.current = setTimeout(() => {
                setStatusMessage((current) =>
                  current === msg ? null : current,
                )
              }, 4000)

              setConfigKey((k) => k + 1)
              setActivePane('left')
              setSelectedModelId(null)
              setSelectedModelDiscovered(false)
              onConfigUpdated?.()
            } catch (error) {
              setStatusMessage(
                `✗ ${error instanceof Error ? error.message : String(error)}`,
              )
            }
          }
          return true
        }
      }
      return false
    },
    [
      activePane,
      leftSearchQuery,
      filteredRoutes,
      leftFocusedIndex,
      rightSearchQuery,
      rightItems,
      rightFocusedIndex,
      rightView,
      selectedModelId,
      selectedModelDiscovered,
      highlightedRoute,
      availableModels,
      onClose,
      onConfigUpdated,
    ],
  )

  if (inspectedText !== null)
    return (
      <OutputReaderScreen
        messages={[]}
        initialDocument={createTextDocument({
          id: 'route-details',
          title: 'Model route details',
          text: inspectedText,
        })}
        onClose={() => setInspectedText(null)}
      />
    )

  {
    const items = activePane === 'left' ? filteredRoutes : rightItems
    const focus = activePane === 'left' ? leftFocusedIndex : rightFocusedIndex
    const size = Math.max(
      1,
      terminalHeight - (statusMessage || loaded.error ? 7 : 6),
    )
    const start = Math.max(
      0,
      Math.min(focus - Math.floor(size / 2), items.length - size),
    )
    const search = activePane === 'left' ? leftSearchQuery : rightSearchQuery
    const cursor = activePane === 'left' ? leftSearchCursor : rightSearchCursor
    const updateSearch = ({
      text,
      cursorPosition,
    }: {
      text: string
      cursorPosition: number
    }) => {
      if (activePane === 'left') {
        setLeftSearchQuery(text)
        setLeftSearchCursor(cursorPosition)
      } else {
        setRightSearchQuery(text)
        setRightSearchCursor(cursorPosition)
      }
    }
    return (
      <box
        style={{
          width: '100%',
          height: '100%',
          flexDirection: 'column',
          paddingLeft: 1,
          paddingRight: 1,
          backgroundColor: theme.surface,
        }}
      >
        <text fg={theme.foreground} wrapMode="none" style={{ flexShrink: 0 }}>
          {sliceTextCells(
            `${activePane === 'left' ? 'Routes' : (highlightedRoute?.label ?? 'Models')} · ${items.length ? focus + 1 : 0}/${items.length}`,
            0,
            terminalWidth - 2,
          )}
        </text>
        <MultilineInput
          value={search}
          onChange={updateSearch}
          onSubmit={() => {}}
          onPaste={createTextPasteHandler(search, cursor, updateSearch)}
          onKeyIntercept={handleKeyIntercept}
          placeholder={
            activePane === 'left'
              ? 'Search routes…'
              : rightView === 'model-select'
                ? 'Search models…'
                : 'Search choices…'
          }
          focused
          cursorPosition={cursor}
          minHeight={1}
          maxHeight={1}
        />
        <box style={{ flexGrow: 1, flexShrink: 1, overflow: 'hidden' }}>
          <SelectableList
            items={items.slice(start, start + size)}
            focusedIndex={focus - start}
            onSelect={(item) => {
              const index = items.findIndex((row) => row.id === item.id)
              if (isHeaderItem(item)) return
              if (activePane === 'left') setLeftFocusedIndex(index)
              else setRightFocusedIndex(index)
              handleKeyIntercept({ name: 'enter' }, { pane: activePane, index })
            }}
            onFocusChange={(index) => {
              const global = index + start
              if (isHeaderItem(items[global])) return
              if (activePane === 'left') setLeftFocusedIndex(global)
              else setRightFocusedIndex(global)
            }}
            emptyMessage={
              loaded.error
                ? 'Config unavailable'
                : activePane === 'right'
                  ? rightEmptyMessage
                  : 'No matching routes'
            }
          />
        </box>
        <text fg={theme.muted} wrapMode="none" style={{ flexShrink: 0 }}>
          {sliceTextCells(
            rightView === 'reasoning-select' && selectedModelId
              ? `Pending: ${selectedModelId}`
              : `Model: ${highlightedRoute?.secondary ?? 'unavailable'}`,
            0,
            terminalWidth - 2,
          )}
        </text>
        {rightView === 'reasoning-select' && (
          <text fg={theme.muted} wrapMode="none" style={{ flexShrink: 0 }}>
            Reasoning: {rightItems[rightFocusedIndex]?.id ?? 'default'}
          </text>
        )}
        {(statusMessage || loaded.error) && (
          <text
            fg={
              loaded.error || statusMessage?.startsWith('✗')
                ? theme.error
                : statusMessage?.startsWith('✓')
                  ? theme.success
                  : theme.warning
            }
            style={{ flexShrink: 0 }}
          >
            {statusMessage ??
              `Config unavailable: ${loaded.error} · Ctrl+R retry`}
          </text>
        )}
        <text fg={theme.muted} wrapMode="none" style={{ flexShrink: 0 }}>
          Enter select · Ctrl+O details · Esc back
        </text>
      </box>
    )
  }
}
