import { afterAll } from 'bun:test'
import { AppContext } from '@opentui/react'
import { createTestRenderer } from '@opentui/core/testing'
import React from 'react'
import { renderToStaticMarkup as renderMarkup } from 'react-dom/server'

// Native styles belong to a renderer's scene in OpenTUI 0.6+. Static React
// assertions still need that owner even though they do not draw a frame.
const setup = await createTestRenderer({ width: 80, height: 24 })
export const staticRenderer = setup.renderer
afterAll(async () => setup.dispose())

export function renderToStaticMarkup(node: React.ReactNode): string {
  return renderMarkup(
    <AppContext.Provider value={{ renderer: staticRenderer, keyHandler: null }}>
      {node}
    </AppContext.Provider>,
  )
}
