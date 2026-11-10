import { expect, test } from 'bun:test'
import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
} from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'

import {
  captureNativeReadingAnchor,
  nativeReadingAnchorDelta,
} from '../native-reading-anchor'

test('captures a source anchor through the scroll content facade and restores it after reflow', async () => {
  const setup = await createTestRenderer({ width: 40, height: 8 })
  try {
    const scroll = new ScrollBoxRenderable(setup.renderer, {
      id: 'conversation',
      width: '100%',
      height: '100%',
      scrollY: true,
    })
    const message = new BoxRenderable(setup.renderer, {
      id: 'transcript-message-answer',
      width: '100%',
    })
    const text = new TextRenderable(setup.renderer, {
      id: 'answer',
      content:
        'A readable answer with enough words to wrap onto several terminal rows.\nSecond source line.\nThird source line.',
      wrapMode: 'word',
      width: '100%',
    })
    message.add(text)
    scroll.add(message)
    setup.renderer.root.add(scroll)
    await setup.renderOnce()
    const anchor = captureNativeReadingAnchor(
      scroll.content,
      scroll.viewport.y,
      scroll.viewport.height,
    )
    expect(anchor?.messageId).toBe('answer')
    expect(anchor?.node).toBe(text)
    expect(scroll.content.getChildren()).toEqual([message])
    setup.resize(24, 8)
    await setup.renderOnce()
    expect(nativeReadingAnchorDelta(anchor!, scroll.viewport.y)).toBe(0)
    message.remove(text)
    expect(nativeReadingAnchorDelta(anchor!, scroll.viewport.y)).toBeNull()
  } finally {
    await setup.dispose()
  }
})

test('ignores messages outside the visible viewport', async () => {
  const setup = await createTestRenderer({ width: 40, height: 4 })
  try {
    const scroll = new ScrollBoxRenderable(setup.renderer, {
      id: 'conversation',
      width: '100%',
      height: '100%',
      scrollY: true,
    })
    scroll.add(new BoxRenderable(setup.renderer, { id: 'spacer', height: 10 }))
    const message = new BoxRenderable(setup.renderer, {
      id: 'transcript-message-below',
      width: '100%',
    })
    message.add(
      new TextRenderable(setup.renderer, {
        id: 'below',
        content: 'Below the viewport',
      }),
    )
    scroll.add(message)
    setup.renderer.root.add(scroll)
    await setup.renderOnce()
    expect(
      captureNativeReadingAnchor(
        scroll.content,
        scroll.viewport.y,
        scroll.viewport.height,
      ),
    ).toBeNull()
    scroll.scrollTo(10)
    await setup.renderOnce()
    expect(
      captureNativeReadingAnchor(
        scroll.content,
        scroll.viewport.y,
        scroll.viewport.height,
      )?.messageId,
    ).toBe('below')
  } finally {
    await setup.dispose()
  }
})
