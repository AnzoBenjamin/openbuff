import { expect, test } from 'bun:test'
import { readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { createTextDocument } from '../output-document'
import { exportOutputDocument } from '../output-export'

test('linear export cannot replay terminal controls and retains availability and readable evidence', async () => {
  const captured = '\u001b[31mFAILURE\u001b[0m\r\nline\t2\u0000\u0007\u001b]52;c;ZmFrZQ==\u0007\u001b[2J'
  const document = createTextDocument({
    id: 'controls', title: 'Captured failure', text: captured,
    availability: 'limited', notice: 'Only two lines captured',
    provenance: { source: 'capture', identity: 'fixture\u001b[2J', freshness: 'captured', exact: true },
  })
  const destination = await exportOutputDocument(document)
  try {
    const exported = await readFile(destination, 'utf8')
    expect(exported).toContain('FAILURE\nline\t2')
    expect(exported).toContain('Only two lines captured')
    expect(exported).toContain('Source: capture · captured')
    expect(exported).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/)
    expect(exported).not.toContain('ZmFrZQ==')
    expect(document.copyLine(0)).toContain('\u001b[31m')
    if (process.platform !== 'win32') expect((await stat(destination)).mode & 0o777).toBe(0o600)
  } finally {
    await rm(path.dirname(destination), { recursive: true, force: true })
  }
})
