import { useKeyboard } from '@opentui/react'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { loadProviderConfigSync } from '@openbuff/sdk'
import { OutputReaderScreen } from './output-reader-screen'
import { createTextDocument } from '../utils/output-document'
import { Button } from './button'
import { sliceTextCells } from '../utils/text-boundaries'
import {
  testProviderConnection,
  validateCustomOpenbuffProvider,
} from '../utils/openbuff-provider'
import {
  runProviderDiagnostics,
  type ProviderDiagnostic,
} from '../utils/provider-diagnostics'

import { MultilineInput } from './multiline-input'
import { useTerminalLayout } from '../hooks/use-terminal-layout'
import { useTheme } from '../hooks/use-theme'
import { getSystemProcessEnv } from '../utils/env'
import { createTextPasteHandler } from '../utils/strings'

import type { KeyEvent } from '@opentui/core'

export type ProviderPickerPresetId =
  | 'opencode-go'
  | 'openrouter'
  | 'openai'
  | 'anthropic'
  | 'ollama'
  | 'codex'
  | 'glm'
  | 'bedrock'
  | 'freemodel'

export type ProviderPickerSelection =
  | { type: 'test-connections' }
  | { type: 'preset'; preset: ProviderPickerPresetId }
  | { type: 'connect-codex' }
  | {
      type: 'custom'
      provider: {
        id: string
        type: CustomProviderType
        baseURL: string
        apiKeyEnv?: string
        models: string[]
      }
    }
  | { type: 'cancel' }

export type ProviderPickerPreset = {
  id: ProviderPickerPresetId
  label: string
  description: string
  category: 'Subscriptions' | 'API Providers'
  env?: string
  aliases?: string[]
  available?: boolean
}

const DEFAULT_PRESETS: ProviderPickerPreset[] = [
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    description:
      'OpenCode Go subscription endpoint with coding-focused models.',
    env: 'OPENCODE_GO_API_KEY',
    category: 'Subscriptions',
    aliases: ['opencode', 'go', 'zai', 'glm', 'kimi', 'qwen'],
  },
  {
    id: 'codex',
    label: 'Codex / ChatGPT',
    description: 'Connect a ChatGPT subscription with the existing OAuth flow.',
    category: 'Subscriptions',
    aliases: ['chatgpt', 'chat gpt', 'oauth'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'GPT models through OpenAI.',
    env: 'OPENAI_API_KEY',
    category: 'API Providers',
    aliases: ['gpt'],
  },
  {
    id: 'anthropic',
    label: 'Anthropic / Claude',
    description:
      'Claude models through the native Anthropic Messages API or compatible gateways.',
    env: 'ANTHROPIC_API_KEY',
    category: 'API Providers',
    aliases: ['anthropic', 'claude', 'sonnet', 'opus'],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'Use any OpenRouter model with your OpenRouter API key.',
    env: 'OPENROUTER_API_KEY',
    category: 'API Providers',
    aliases: ['router', 'open router'],
  },
  {
    id: 'ollama',
    label: 'Ollama',
    description: 'Local Ollama models, usually without an API key.',
    category: 'API Providers',
    aliases: ['local'],
  },
  {
    id: 'glm',
    label: 'GLM / Z.ai',
    description: 'GLM OpenAI-compatible endpoint for coding plans.',
    env: 'GLM_API_KEY',
    category: 'API Providers',
    aliases: ['zai', 'z.ai', 'bigmodel'],
  },
  {
    id: 'bedrock',
    label: 'AWS Bedrock',
    description:
      'AWS Bedrock OpenAI-compatible endpoint. Update baseURL to your region.',
    env: 'AWS_BEARER_TOKEN_BEDROCK',
    category: 'API Providers',
    aliases: ['aws', 'amazon bedrock', 'bedrock'],
  },
  {
    id: 'freemodel',
    label: 'Free Model',
    description:
      'Free Model endpoints for GPT and Claude-compatible coding models.',
    env: 'FREEMODEL_API_KEY',
    category: 'API Providers',
    aliases: ['freemodel', 'free model', 'gpt-5.5-free'],
  },
]

type CustomProviderType = 'openai-compatible' | 'anthropic-compatible'
type EditableCustomField =
  | 'id'
  | 'providerType'
  | 'baseURL'
  | 'apiKeyEnv'
  | 'models'
type CustomField = EditableCustomField | 'review'

type CustomProviderDraft = {
  id: string
  providerType: string
  baseURL: string
  apiKeyEnv: string
  models: string
}

type PickerItem =
  | (ProviderPickerPreset & { kind: 'preset' })
  | {
      kind: 'test'
      id: 'test-connections'
      label: string
      description: string
      category: 'Diagnostics'
      env?: undefined
      aliases: string[]
    }
  | {
      kind: 'custom'
      id: 'custom'
      label: string
      description: string
      category: 'Custom'
      env?: undefined
      aliases: string[]
    }

type DisplayRow =
  | { type: 'header'; label: string }
  | { type: 'item'; item: PickerItem; selectableIndex: number }

type Props = {
  presets?: ProviderPickerPreset[]
  onSelect: (selection: ProviderPickerSelection) => void | Promise<void>
  diagnosticsDependencies?: {
    providers: () => string[]
    check: typeof testProviderConnection
  }
}

const FIELD_LABELS: Record<EditableCustomField, string> = {
  id: 'Provider id',
  providerType: 'Provider type (openai-compatible or anthropic-compatible)',
  baseURL: 'Base URL',
  apiKeyEnv: 'API key env (blank for none)',
  models: 'Models (comma-separated)',
}

const FIELD_ORDER: EditableCustomField[] = [
  'id',
  'providerType',
  'baseURL',
  'apiKeyEnv',
  'models',
]

function providerMatches(item: PickerItem, query: string): boolean {
  const haystack = [
    item.id,
    item.label,
    item.description,
    item.env ?? '',
    ...(item.aliases ?? []),
  ]
    .join(' ')
    .toLowerCase()

  return haystack.includes(query.toLowerCase())
}

function normalizeModels(value: string): string[] {
  return value
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean)
}

function normalizeCustomProviderType(value: string): CustomProviderType | null {
  const normalized = value.trim().toLowerCase()
  if (
    normalized === '1' ||
    normalized === 'openai' ||
    normalized === 'openai-compatible'
  ) {
    return 'openai-compatible'
  }
  if (
    normalized === '2' ||
    normalized === 'anthropic' ||
    normalized === 'anthropic-compatible' ||
    normalized === 'claude'
  ) {
    return 'anthropic-compatible'
  }
  return null
}

function envStatus(env: string | undefined): string | null {
  if (!env) return null
  return getSystemProcessEnv()[env] ? '✓' : '!'
}

function isEditableCustomField(
  field: CustomField,
): field is EditableCustomField {
  return field !== 'review'
}

function getPreviousCustomField(field: CustomField): CustomField {
  if (field === 'review') return 'models'
  const index = FIELD_ORDER.indexOf(field)
  return index <= 0 ? 'id' : FIELD_ORDER[index - 1]
}

function getNextCustomField(field: EditableCustomField): CustomField {
  const index = FIELD_ORDER.indexOf(field)
  return index === FIELD_ORDER.length - 1 ? 'review' : FIELD_ORDER[index + 1]
}

function canSubmitCustomProvider(provider: CustomProviderDraft): boolean {
  return Boolean(
    provider.id.trim() &&
    normalizeCustomProviderType(provider.providerType) !== null &&
    provider.baseURL.trim() &&
    normalizeModels(provider.models).length > 0,
  )
}

export function ProviderPickerScreen({
  presets,
  onSelect,
  diagnosticsDependencies = {
    providers: () => Object.keys(loadProviderConfigSync().config.providers),
    check: testProviderConnection,
  },
}: Props) {
  const theme = useTheme()
  const { terminalWidth, terminalHeight } = useTerminalLayout()
  const contentWidth = Math.max(1, terminalWidth - 4)
  const maxRenderedRows = Math.max(1, terminalHeight - 9)

  const allPresets = presets?.length ? presets : DEFAULT_PRESETS
  const visiblePresets = allPresets.filter(
    (preset) => preset.available !== false,
  )

  const [inspectedText, setInspectedText] = useState<string | null>(null)
  const [diagnosticIndex, setDiagnosticIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [diagnostics, setDiagnostics] = useState<ProviderDiagnostic[] | null>(
    null,
  )
  const [diagnosticsRunning, setDiagnosticsRunning] = useState(false)
  const diagnosticsController = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      diagnosticsController.current?.abort()
    }
  }, [])
  const saveSelection = useCallback(
    async (selection: ProviderPickerSelection) => {
      if (saving) return
      setSaving(true)
      setError(null)
      try {
        await onSelect(selection)
      } catch (cause) {
        if (mounted.current)
          setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (mounted.current) setSaving(false)
      }
    },
    [onSelect, saving],
  )
  const startDiagnostics = useCallback(
    async (onlyId?: string) => {
      diagnosticsController.current?.abort()
      const controller = new AbortController()
      diagnosticsController.current = controller
      setError(null)
      try {
        const ids = onlyId ? [onlyId] : diagnosticsDependencies.providers()
        setDiagnostics((rows) =>
          onlyId
            ? (rows ?? []).map((row) =>
                row.id === onlyId
                  ? { ...row, state: 'running', message: `Checking ${row.id}…` }
                  : row,
              )
            : ids.map((id) => ({
                id,
                state: 'running',
                message: `Waiting to check ${id}…`,
              })),
        )
        setDiagnosticsRunning(true)
        await runProviderDiagnostics({
          ids,
          signal: controller.signal,
          check: diagnosticsDependencies.check,
          onResult: (result) => {
            if (mounted.current && !controller.signal.aborted)
              setDiagnostics((rows) =>
                (rows ?? []).map((row) =>
                  row.id === result.id ? result : row,
                ),
              )
          },
        })
      } catch (cause) {
        if (mounted.current && !controller.signal.aborted) {
          setDiagnostics([])
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      } finally {
        if (mounted.current && diagnosticsController.current === controller)
          setDiagnosticsRunning(false)
      }
    },
    [diagnosticsDependencies],
  )
  const cancelDiagnostics = () => {
    diagnosticsController.current?.abort()
    setDiagnosticsRunning(false)
    setDiagnostics(
      (rows) =>
        rows?.map((row) =>
          row.state === 'running'
            ? { ...row, state: 'cancelled', message: `${row.id}: Cancelled` }
            : row,
        ) ?? null,
    )
  }

  const [query, setQuery] = useState('')
  const [queryCursor, setQueryCursor] = useState(0)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [mode, setMode] = useState<'picker' | 'custom'>('picker')
  const [customField, setCustomField] = useState<CustomField>('id')
  const [customCursor, setCustomCursor] = useState(0)
  const [customProvider, setCustomProvider] = useState<CustomProviderDraft>({
    id: '',
    providerType: 'openai-compatible',
    baseURL: '',
    apiKeyEnv: '',
    models: '',
  })

  const filteredItems = useMemo(() => {
    const pickerItems: PickerItem[] = [
      ...visiblePresets.map((preset) => ({
        ...preset,
        kind: 'preset' as const,
      })),
      {
        kind: 'test' as const,
        id: 'test-connections',
        label: 'Test connections',
        description:
          'Live-check every configured provider endpoint and API key via model discovery.',
        category: 'Diagnostics' as const,
        aliases: ['test', 'check', 'validate', 'ping'],
      },
      {
        kind: 'custom' as const,
        id: 'custom',
        label: 'Custom OpenAI/Anthropic-compatible provider',
        description:
          'Enter an id, provider type, base URL, API key environment variable, and model ids.',
        category: 'Custom' as const,
        aliases: [
          'custom',
          'openai compatible',
          'anthropic compatible',
          'claude',
        ],
      },
    ]

    const trimmedQuery = query.trim()
    return trimmedQuery
      ? pickerItems.filter((item) => providerMatches(item, trimmedQuery))
      : pickerItems
  }, [query, visiblePresets])

  const displayRows = useMemo<DisplayRow[]>(() => {
    const rows: DisplayRow[] = []
    const categories = Array.from(
      new Set(filteredItems.map((item) => item.category)),
    )
    let selectableIndex = 0

    for (const category of categories) {
      rows.push({ type: 'header', label: category })
      for (const item of filteredItems) {
        if (item.category !== category) continue
        rows.push({ type: 'item', item, selectableIndex })
        selectableIndex++
      }
    }

    return rows
  }, [filteredItems])

  const maxSelectable = filteredItems.length - 1

  useEffect(() => {
    setSelectedIndex((index) => Math.min(index, Math.max(0, maxSelectable)))
  }, [maxSelectable])

  const selectCurrentItem = useCallback(
    (submittedQuery?: string) => {
      const selectedRow =
        submittedQuery !== undefined && submittedQuery !== query
          ? displayRows.find(
              (row) =>
                row.type === 'item' &&
                providerMatches(row.item, submittedQuery.trim()),
            )
          : displayRows.find(
              (row) =>
                row.type === 'item' && row.selectableIndex === selectedIndex,
            )
      if (!selectedRow || selectedRow.type !== 'item') return

      const item = selectedRow.item
      if (item.kind === 'test') {
        void startDiagnostics()
        return
      }
      if (item.kind === 'custom') {
        setMode('custom')
        setCustomField('id')
        setCustomCursor(customProvider.id.length)
        return
      }
      if (item.id === 'codex') {
        void saveSelection({ type: 'connect-codex' })
        return
      }
      void saveSelection({ type: 'preset', preset: item.id })
    },
    [
      customProvider.id.length,
      displayRows,
      saveSelection,
      selectedIndex,
      startDiagnostics,
      query,
    ],
  )

  const handlePickerKey = useCallback(
    (key: KeyEvent): boolean => {
      if (inspectedText !== null) return false
      if (key.ctrl && key.name === 'o' && diagnostics === null) {
        const row = displayRows.find(
          (row) => row.type === 'item' && row.selectableIndex === selectedIndex,
        )
        if (row?.type === 'item')
          setInspectedText(
            `${row.item.label}\n${row.item.category}\n\n${row.item.description}\n${row.item.env ?? ''}`,
          )
        return true
      }
      if (diagnostics !== null) {
        if (key.name === 'escape') {
          cancelDiagnostics()
          setDiagnostics(null)
          return true
        }
        if (key.name === 'c') {
          cancelDiagnostics()
          return true
        }
        if (key.name === 'up') {
          setDiagnosticIndex((index) => Math.max(0, index - 1))
          return true
        }
        if (key.name === 'down') {
          setDiagnosticIndex((index) =>
            Math.min(Math.max(0, diagnostics.length - 1), index + 1),
          )
          return true
        }
        if (key.ctrl && key.name === 'o') {
          const row = diagnostics[diagnosticIndex]
          if (row || error) setInspectedText(row?.message ?? error ?? '')
          return true
        }
        if (
          (key.name === 'return' || key.name === 'enter') &&
          !diagnosticsRunning
        ) {
          const row = diagnostics[diagnosticIndex]
          if (row) void startDiagnostics(row.id)
          return true
        }
        if (key.name === 'r' && !diagnosticsRunning) {
          void startDiagnostics()
          return true
        }
        return false
      }
      if (mode !== 'picker') return false

      if (key.name === 'escape') {
        key.preventDefault()
        if (query.length > 0) {
          setQuery('')
          setQueryCursor(0)
          setSelectedIndex(0)
        } else {
          onSelect({ type: 'cancel' })
        }
        return true
      }
      if (key.name === 'q' && query.length === 0) {
        key.preventDefault()
        onSelect({ type: 'cancel' })
        return true
      }
      if (key.name === 'up') {
        key.preventDefault()
        setSelectedIndex((index) => Math.max(0, index - 1))
        return true
      }
      if (key.name === 'down') {
        key.preventDefault()
        setSelectedIndex((index) => Math.min(maxSelectable, index + 1))
        return true
      }
      return false
    },
    [
      maxSelectable,
      mode,
      onSelect,
      query.length,
      diagnostics,
      diagnosticsRunning,
      diagnosticIndex,
      selectedIndex,
      displayRows,
      inspectedText,
      error,
      startDiagnostics,
    ],
  )

  const submitCustomValue = useCallback(
    (input?: { text: string }) => {
      if (!isEditableCustomField(customField)) return
      const draft = input
        ? { ...customProvider, [customField]: input.text }
        : customProvider
      setCustomProvider(draft)
      const providerType = normalizeCustomProviderType(draft.providerType)
      const validation = validateCustomOpenbuffProvider({
        id: draft.id,
        type: providerType ?? 'openai-compatible',
        baseURL: draft.baseURL,
        apiKeyEnv: draft.apiKeyEnv,
        models: normalizeModels(draft.models),
      })
      if (customField === 'providerType' && !providerType) {
        setError('Choose openai-compatible or anthropic-compatible.')
        return
      }
      if (validation?.field === customField) {
        setError(validation.message)
        return
      }
      setError(null)
      const nextField = getNextCustomField(customField)
      setCustomField(nextField)
      setCustomCursor(nextField === 'review' ? 0 : draft[nextField].length)
    },
    [customField, customProvider],
  )

  const handleCustomKey = useCallback(
    (key: KeyEvent): boolean => {
      if (mode !== 'custom') return false

      if (key.name === 'escape') {
        key.preventDefault()
        if (customField === 'id') {
          setMode('picker')
          setError(null)
          setCustomCursor(0)
          return true
        }
        const previousField = getPreviousCustomField(customField)
        setCustomField(previousField)
        setCustomCursor(
          previousField === 'review' ? 0 : customProvider[previousField].length,
        )
        return true
      }

      if (customField !== 'review') return false

      if (key.name === 'return' || key.name === 'enter' || key.name === 'y') {
        key.preventDefault()
        const models = normalizeModels(customProvider.models)
        const providerType = normalizeCustomProviderType(
          customProvider.providerType,
        )
        if (!providerType || !canSubmitCustomProvider(customProvider))
          return true
        const validation = validateCustomOpenbuffProvider({
          id: customProvider.id,
          type: providerType,
          baseURL: customProvider.baseURL,
          apiKeyEnv: customProvider.apiKeyEnv,
          models,
        })
        if (validation) {
          setError(validation.message)
          setCustomField(validation.field)
          setCustomCursor(customProvider[validation.field].length)
          return true
        }
        void saveSelection({
          type: 'custom',
          provider: {
            id: customProvider.id.trim(),
            type: providerType,
            baseURL: customProvider.baseURL.trim(),
            apiKeyEnv: customProvider.apiKeyEnv.trim() || undefined,
            models,
          },
        })
        return true
      }
      if (key.name === 'n') {
        key.preventDefault()
        setCustomField('models')
        setCustomCursor(customProvider.models.length)
        return true
      }
      return false
    },
    [customField, customProvider, mode, saveSelection],
  )

  useKeyboard(
    useCallback(
      (key: KeyEvent) => {
        if (inspectedText !== null) return
        if (diagnostics !== null) {
          handlePickerKey(key)
          return
        }
        if (mode === 'custom' && customField === 'review') {
          handleCustomKey(key)
        }
      },
      [
        customField,
        handleCustomKey,
        mode,
        diagnostics,
        diagnosticsRunning,
        inspectedText,
        handlePickerKey,
      ],
    ),
  )

  if (inspectedText !== null)
    return (
      <OutputReaderScreen
        messages={[]}
        initialDocument={createTextDocument({
          id: 'provider-details',
          title: 'Provider details',
          text: inspectedText,
        })}
        onClose={() => setInspectedText(null)}
      />
    )

  if (diagnostics !== null)
    return (
      <box
        style={{
          width: '100%',
          height: '100%',
          flexDirection: 'column',
          padding: 1,
          backgroundColor: theme.surface,
        }}
      >
        <text fg={theme.foreground} style={{ flexShrink: 0 }}>
          Provider connections · {diagnosticsRunning ? 'Checking' : 'Finished'}
        </text>
        <scrollbox style={{ flexGrow: 1, flexShrink: 1 }} scrollX={false}>
          {diagnostics
            .slice(
              Math.max(0, diagnosticIndex - 1),
              Math.max(0, diagnosticIndex - 1) +
                Math.max(1, terminalHeight - 8),
            )
            .map((row) => (
              <box key={row.id} style={{ flexDirection: 'column' }}>
                <text
                  wrapMode="none"
                  fg={
                    row.id === diagnostics[diagnosticIndex]?.id
                      ? theme.primary
                      : row.state === 'failed'
                        ? theme.error
                        : row.state === 'succeeded'
                          ? theme.success
                          : theme.muted
                  }
                >
                  {sliceTextCells(
                    `${row.id === diagnostics[diagnosticIndex]?.id ? '›' : ' '} ${row.message}`,
                    0,
                    contentWidth,
                  )}
                </text>
              </box>
            ))}
          {diagnostics.length === 0 && !error && (
            <text fg={theme.muted}>
              No configured providers. Add one first.
            </text>
          )}
        </scrollbox>
        {error && (
          <text fg={theme.error} style={{ flexShrink: 0 }} wrapMode="none">
            {sliceTextCells(error, 0, contentWidth)}
          </text>
        )}
        <text fg={theme.muted} style={{ flexShrink: 0 }} wrapMode="none">
          ↑↓ · Enter retry · Ctrl+O details
        </text>
        <Button
          style={{ flexShrink: 0 }}
          onClick={() => {
            cancelDiagnostics()
            setDiagnostics(null)
          }}
        >
          <text fg={theme.primary}>Back (Esc)</text>
        </Button>
        <Button
          style={{ flexShrink: 0 }}
          onClick={() =>
            diagnosticsRunning ? cancelDiagnostics() : void startDiagnostics()
          }
        >
          <text fg={theme.primary}>
            {diagnosticsRunning ? 'Cancel checks (C)' : 'Retry all (R)'}
          </text>
        </Button>
      </box>
    )

  if (mode === 'custom') {
    const currentField = isEditableCustomField(customField) ? customField : null
    const currentValue = currentField ? customProvider[currentField] : ''
    const canSubmit = canSubmitCustomProvider(customProvider)

    return (
      <box
        style={{
          width: '100%',
          height: '100%',
          backgroundColor: theme.surface,
          paddingLeft: 2,
          paddingRight: 2,
          flexDirection: 'column',
        }}
      >
        <text fg={theme.foreground} style={{ flexShrink: 0 }} wrapMode="none">
          Custom provider · Step{' '}
          {customField === 'review' ? 6 : FIELD_ORDER.indexOf(customField) + 1}
          /6
        </text>
        {currentField ? (
          <box style={{ flexDirection: 'column', flexGrow: 1 }}>
            <text fg={theme.primary} style={{ flexShrink: 0 }}>
              {FIELD_LABELS[currentField]}
            </text>
            <MultilineInput
              value={currentValue}
              onChange={({ text, cursorPosition }) => {
                setCustomProvider((provider) => ({
                  ...provider,
                  [currentField]: text,
                }))
                setCustomCursor(cursorPosition)
              }}
              onSubmit={submitCustomValue}
              onPaste={createTextPasteHandler(
                currentValue,
                customCursor,
                ({ text, cursorPosition }) => {
                  setCustomProvider((provider) => ({
                    ...provider,
                    [currentField]: text,
                  }))
                  setCustomCursor(cursorPosition)
                },
              )}
              onKeyIntercept={handleCustomKey}
              placeholder={FIELD_LABELS[currentField]}
              focused
              maxHeight={2}
              minHeight={1}
              cursorPosition={customCursor}
            />
          </box>
        ) : (
          <scrollbox style={{ flexGrow: 1 }} scrollX={false}>
            <text fg={theme.foreground}>ID: {customProvider.id}</text>
            <text fg={theme.foreground}>
              Type: {customProvider.providerType}
            </text>
            <text fg={theme.foreground}>
              Base URL: {customProvider.baseURL}
            </text>
            <text fg={theme.foreground}>
              API key env: {customProvider.apiKeyEnv || 'none'}
            </text>
            <text fg={theme.foreground}>Models: {customProvider.models}</text>
          </scrollbox>
        )}
        {error && (
          <text fg={theme.error} style={{ flexShrink: 0 }}>
            {error}
          </text>
        )}
        {saving && (
          <text fg={theme.muted} style={{ flexShrink: 0 }}>
            Saving provider…
          </text>
        )}
        <text
          fg={canSubmit ? theme.muted : theme.error}
          style={{ flexShrink: 0 }}
          wrapMode="none"
        >
          {currentField
            ? 'Enter next · Esc back'
            : 'Enter save · N edit · Esc back'}
        </text>
      </box>
    )
  }

  const itemRows = displayRows.filter(
    (row): row is Extract<DisplayRow, { type: 'item' }> => row.type === 'item',
  )
  const windowStart = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(maxRenderedRows / 2),
      itemRows.length - maxRenderedRows,
    ),
  )
  const renderedRows: DisplayRow[] = itemRows.slice(
    windowStart,
    windowStart + maxRenderedRows,
  )
  const selectedItem = itemRows[selectedIndex]?.item

  return (
    <box
      style={{
        width: '100%',
        height: '100%',
        backgroundColor: theme.surface,
        paddingLeft: 2,
        paddingRight: 2,
        flexDirection: 'column',
      }}
    >
      <text fg={theme.foreground}>
        Add provider · {itemRows.length ? selectedIndex + 1 : 0}/
        {itemRows.length}
      </text>
      <MultilineInput
        value={query}
        onChange={({ text, cursorPosition }) => {
          setQuery(text)
          setQueryCursor(cursorPosition)
          setSelectedIndex(0)
        }}
        onSubmit={(input) => selectCurrentItem(input?.text)}
        onPaste={createTextPasteHandler(
          query,
          queryCursor,
          ({ text, cursorPosition }) => {
            setQuery(text)
            setQueryCursor(cursorPosition)
            setSelectedIndex(0)
          },
        )}
        onKeyIntercept={handlePickerKey}
        placeholder="Search providers…"
        focused
        maxHeight={1}
        minHeight={1}
        cursorPosition={queryCursor}
      />
      <box style={{ flexGrow: 1, overflow: 'hidden', flexDirection: 'column' }}>
        {renderedRows.map(
          (row) =>
            row.type === 'item' && (
              <Button
                key={`${row.item.id}-${row.selectableIndex}`}
                onClick={() => {
                  setSelectedIndex(row.selectableIndex)
                  const item = row.item
                  if (item.kind === 'custom') {
                    setMode('custom')
                    setCustomField('id')
                  } else if (item.kind === 'test') void startDiagnostics()
                  else
                    void saveSelection(
                      item.id === 'codex'
                        ? { type: 'connect-codex' }
                        : { type: 'preset', preset: item.id },
                    )
                }}
              >
                <text
                  fg={
                    row.selectableIndex === selectedIndex
                      ? theme.primary
                      : theme.foreground
                  }
                  wrapMode="none"
                >
                  {sliceTextCells(
                    `${row.selectableIndex === selectedIndex ? '›' : ' '} ${row.item.label}`,
                    0,
                    contentWidth,
                  )}
                </text>
              </Button>
            ),
        )}
        {!itemRows.length && (
          <text fg={theme.muted}>No matching providers.</text>
        )}
      </box>
      {selectedItem && (
        <text fg={theme.muted} wrapMode="none">
          {sliceTextCells(
            `${selectedItem.category} · ${selectedItem.env ? `${selectedItem.env} ${envStatus(selectedItem.env)}` : selectedItem.description}`,
            0,
            contentWidth,
          )}
        </text>
      )}
      {error && <text fg={theme.error}>{error}</text>}
      {saving && <text fg={theme.muted}>Saving provider…</text>}
      <text fg={theme.muted}>
        ↑↓ choose · Enter select · Ctrl+O details · Esc back
      </text>
    </box>
  )
}

export default ProviderPickerScreen
