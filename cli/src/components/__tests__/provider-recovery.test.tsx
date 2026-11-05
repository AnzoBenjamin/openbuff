import { expect, test } from 'bun:test'
import React from 'react'
import {
  ProviderPickerScreen,
  type ProviderPickerPreset,
  type ProviderPickerSelection,
} from '../provider-picker-screen'
import { MultipleChoiceForm } from '../ask-user'
import { ChatGptConnectBanner } from '../chatgpt-connect-banner'
import { initializeThemeStore } from '../../hooks/use-theme'

async function renderFixture(
  node: React.ReactNode,
  options: Parameters<typeof import('@opentui/react/test-utils').testRender>[1],
) {
  const { testRender } = await import('@opentui/react/test-utils')
  let setup!: Awaited<ReturnType<typeof testRender>>
  await React.act(async () => {
    setup = await testRender(node, options)
  })
  return setup
}

initializeThemeStore()
const renderTest = process.env.NODE_ENV === 'production' ? test.skip : test

renderTest(
  'Kitty plain Enter opens provider setup instead of inserting a newline',
  async () => {
    const setup = await renderFixture(
      <ProviderPickerScreen onSelect={() => {}} />,
      { width: 60, height: 18, kittyKeyboard: true },
    )
    try {
      await React.act(async () => {
        await setup.mockInput.typeText('custom')
        setup.mockInput.pressEnter()
      })
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('Custom provider · Step 1/6')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'first ordinary choice click from Custom selects it and keeps the Custom draft for return',
  async () => {
    const answers: any[] = []
    const setup = await renderFixture(
      <MultipleChoiceForm
        questions={[
          {
            question: 'Choose behavior',
            options: ['First choice', 'Second choice'],
          },
        ]}
        onSubmit={(value) => answers.push(value)}
        onSkip={() => {}}
      />,
      { width: 80, height: 24 },
    )
    const clickText = async (text: string) => {
      await setup.renderOnce()
      const lines = setup.captureCharFrame().split('\n')
      const row = lines.findIndex((line) => line.includes(text))
      expect(row).toBeGreaterThanOrEqual(0)
      await React.act(async () =>
        setup.mockMouse.click(lines[row].indexOf(text) + 1, row),
      )
      await setup.renderOnce()
    }
    try {
      await clickText('Custom')
      await React.act(async () =>
        setup.mockInput.typeText('retained custom draft'),
      )
      await clickText('Second choice')
      await clickText('Submit')
      expect(answers[0]?.[0]?.selectedOption).toBe('Second choice')
      await clickText('Choose behavior')
      await clickText('Custom')
      expect(setup.captureCharFrame()).toContain('retained custom draft')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'rejected custom validation focuses the retained input so correcting text can submit',
  async () => {
    const answers: any[] = []
    const setup = await renderFixture(
      <MultipleChoiceForm
        questions={[
          {
            question: 'Enter at least three letters',
            options: ['Preset'],
            validation: { minLength: 3 },
          },
        ]}
        onSubmit={(value) => answers.push(value)}
        onSkip={() => {}}
      />,
      { width: 80, height: 24 },
    )
    try {
      await React.act(async () => setup.mockInput.pressArrow('down'))
      await React.act(async () => setup.mockInput.pressEnter())
      await React.act(async () => {
        await setup.mockInput.typeText('ab')
        setup.mockInput.pressEnter()
      })
      await React.act(async () => setup.mockInput.pressEnter())
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('Min 3 characters')
      await React.act(async () => {
        await setup.mockInput.typeText('c')
        setup.mockInput.pressEnter()
      })
      await React.act(async () => setup.mockInput.pressEnter())
      expect(answers[0]?.[0]?.otherText).toBe('abc')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'short provider picker keeps every late selection visible before activation',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    const presets = Array.from({ length: 30 }, (_, index) => ({
      id: 'openai',
      label: `Provider ${index + 1}`,
      description: 'Long description '.repeat(20),
      category: 'API Providers',
    })) as ProviderPickerPreset[]
    let selected: ProviderPickerSelection | undefined
    const setup = await renderFixture(
      <ProviderPickerScreen
        presets={presets}
        onSelect={(value) => {
          selected = value
        }}
      />,
      { width: 40, height: 12 },
    )
    try {
      await React.act(async () => {
        for (let index = 0; index < 29; index++)
          setup.mockInput.pressArrow('down')
        await Bun.sleep(50)
      })
      expect(setup.captureCharFrame()).toContain('Provider 30')
      expect(setup.captureCharFrame()).toContain('30/32')
      await React.act(async () => setup.mockInput.pressEnter())
      expect(selected).toEqual({ type: 'preset', preset: 'openai' })
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'invalid custom fields and failed save preserve the draft in the mounted wizard',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    let saved: ProviderPickerSelection | undefined
    const setup = await renderFixture(
      <ProviderPickerScreen
        onSelect={async (value) => {
          saved = value
          throw new Error('Disk is read only')
        }}
      />,
      { width: 60, height: 18 },
    )
    const enterText = async (value: string) => {
      await React.act(async () => {
        await setup.mockInput.typeText(value)
        setup.mockInput.pressEnter()
      })
      await setup.renderOnce()
    }
    try {
      await enterText('custom')
      await enterText('-bad')
      expect(setup.captureCharFrame()).toContain('Provider id must use')
      for (let index = 0; index < 4; index++)
        await React.act(async () => setup.mockInput.pressBackspace())
      await enterText('local')
      await enterText('')
      await enterText('https://example.test/v1')
      await enterText('LOCAL_KEY')
      await enterText('kept-model')
      await React.act(async () => setup.mockInput.pressEnter())
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('Disk is read only')
      expect(setup.captureCharFrame()).toContain('kept-model')
      expect(saved).toEqual({
        type: 'custom',
        provider: {
          id: 'local',
          type: 'openai-compatible',
          baseURL: 'https://example.test/v1',
          apiKeyEnv: 'LOCAL_KEY',
          models: ['kept-model'],
        },
      })
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  '100 choices stay bounded, last focus is visible and stopping requires draft confirmation',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    let stopped = 0
    const setup = await renderFixture(
      <MultipleChoiceForm
        questions={[
          {
            question: 'Question '.repeat(100),
            options: Array.from(
              { length: 100 },
              (_, index) => `Choice ${index + 1}`,
            ),
            multiSelect: true,
          },
        ]}
        onSubmit={() => {}}
        onSkip={() => {}}
        onStop={() => stopped++}
      />,
      { width: 40, height: 15, exitOnCtrlC: false },
    )
    try {
      for (let index = 0; index < 99; index++)
        await React.act(async () => setup.mockInput.pressArrow('down'))
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('Choice 100')
      expect(setup.captureCharFrame()).toContain('Submit')
      await React.act(async () => {
        setup.mockInput.pressKey(' ')
      })
      await React.act(async () => {
        setup.mockInput.pressKey('c', { ctrl: true })
        await Bun.sleep(50)
      })
      await setup.renderOnce()
      expect(stopped).toBe(0)
      expect(setup.captureCharFrame()).toContain('discard 1 draft')
      await React.act(async () => setup.mockInput.pressKey('n'))
      expect(stopped).toBe(0)
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'headless OAuth exposes manual callback, invalid state stays inline and successful exchange connects',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    let exchanged = ''
    const dependencies = {
      connect: () => ({
        authUrl: 'https://auth.example.test',
        browserOpened: Promise.resolve(false),
        credentials: new Promise<never>(() => {}),
      }),
      exchange: async (value: string) => {
        exchanged = value
        if (value === 'bad') throw new Error('OAuth state mismatch')
        return {} as never
      },
      status: () =>
        ({ connected: false }) as ReturnType<
          typeof import('../../utils/chatgpt-oauth').getChatGptOAuthStatus
        >,
      stop: () => {},
      open: async () => false,
      hasCodexProvider: () => true,
    }
    const setup = await renderFixture(
      <ChatGptConnectBanner dependencies={dependencies} />,
      { width: 80, height: 24 },
    )
    try {
      await React.act(async () => Bun.sleep(30))
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('Browser could not open')
      await React.act(async () => {
        await setup.mockInput.typeText('bad')
        setup.mockInput.pressEnter()
        await Bun.sleep(40)
      })
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('OAuth state mismatch')
      expect(setup.captureCharFrame()).toContain('Submit callback')
      await React.act(async () => {
        await setup.mockInput.typeText('valid-callback')
        setup.mockInput.pressEnter()
        await Bun.sleep(40)
      })
      await setup.renderOnce()
      expect(exchanged).toBe('valid-callback')
      expect(setup.captureCharFrame()).toContain('ChatGPT connected')
      expect(setup.captureCharFrame()).not.toContain('valid-callback')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'diagnostics show partial results beside a hung check and cancel without late rows',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    const setup = await renderFixture(
      <ProviderPickerScreen
        onSelect={() => {}}
        diagnosticsDependencies={{
          providers: () => ['hung', 'fast-one', 'fast-two'],
          check: async (id) =>
            id === 'hung'
              ? new Promise<never>(() => {})
              : { ok: true, message: `${id}: connected` },
        }}
      />,
      { width: 60, height: 18 },
    )
    try {
      await React.act(async () => {
        await setup.mockInput.typeText('Test connections')
        setup.mockInput.pressEnter()
      })
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('fast-one: connected')
      expect(setup.captureCharFrame()).toContain('fast-two: connected')
      await React.act(async () => setup.mockInput.pressKey('c'))
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('hung: Cancelled')
      expect(setup.captureCharFrame()).toContain('fast-two: connected')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)

renderTest(
  'malformed diagnostic config is visible and recoverable inside the picker',
  async () => {
    const { testRender } = await import('@opentui/react/test-utils')
    const setup = await renderFixture(
      <ProviderPickerScreen
        onSelect={() => {}}
        diagnosticsDependencies={{
          providers: () => {
            throw new Error('Invalid provider JSON')
          },
          check: async () => ({ ok: true, message: '' }),
        }}
      />,
      { width: 60, height: 18 },
    )
    try {
      await React.act(async () => {
        await setup.mockInput.typeText('Test connections')
        setup.mockInput.pressEnter()
      })
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain('Invalid provider JSON')
      expect(setup.captureCharFrame()).toContain('Retry all')
    } finally {
      await React.act(async () => setup.renderer.destroy())
    }
  },
)
