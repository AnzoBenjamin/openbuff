import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import React from 'react'
import { createCliRenderer } from '@opentui/core'
import { createRoot, useKeyboard } from '@opentui/react'
import { OutputReaderScreen } from '../src/components/output-reader-screen'
import { initializeThemeStore } from '../src/hooks/use-theme'
import { exportOutputDocument } from '../src/utils/output-export'
import { studyDocuments } from './ui-study-fixtures'

initializeThemeStore()
if (process.argv.includes('--plain')) {
  const destination = await mkdtemp(path.join(tmpdir(), 'openbuff-ui-study-'))
  for (const [name, document] of Object.entries(studyDocuments)) {
    const exported = await exportOutputDocument(document)
    try {
      await writeFile(
        path.join(destination, `${name}.txt`),
        await readFile(exported),
        { mode: 0o600 },
      )
    } finally {
      await rm(path.dirname(exported), { recursive: true, force: true })
    }
  }
  console.log(destination)
} else {
  function Study() {
    const [selected, setSelected] = React.useState<
      keyof typeof studyDocuments | null
    >(process.argv.includes('--changes') ? 'changes' : 'log')
    useKeyboard((key) => {
      if (selected) return
      if (key.name === '1') setSelected('log')
      if (key.name === '2') setSelected('changes')
      if (key.name === '3') setSelected('search')
    })
    if (selected)
      return (
        <OutputReaderScreen
          key={selected}
          messages={[]}
          initialDocument={studyDocuments[selected]}
          onClose={() => setSelected(null)}
        />
      )
    return (
      <box flexDirection="column" padding={1}>
        <text>Reader study fixtures</text>
        <text>1 · Captured validation log</text>
        <text>2 · Captured changes</text>
        <text>3 · Captured search matches</text>
        <text>Ctrl+C · Exit</text>
      </box>
    )
  }
  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  createRoot(renderer).render(<Study />)
}
