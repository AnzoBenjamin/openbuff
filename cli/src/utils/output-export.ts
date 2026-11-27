import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stripAnsiSequences } from '@opentui/core'
import type { OutputDocument } from './output-document'

/** Export the captured view with its availability labels for linear reading. */
export async function exportOutputDocument(document: OutputDocument): Promise<string> {
  if (Buffer.byteLength(document.text, 'utf8') > 8 * 1024 * 1024)
    throw new Error('This captured view exceeds the 8 MiB export limit')
  const directory = await mkdtemp(path.join(tmpdir(), 'openbuff-output-'))
  const destination = path.join(directory, 'captured-output.txt')
  const header = [document.title, document.notice, document.provenance?.identity,
    document.provenance ? `Source: ${document.provenance.source} · ${document.provenance.freshness}` : null]
    .filter(Boolean).join('\n')
  const plainText = stripAnsiSequences(`${header}\n\n${document.text}\n`)
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
  await writeFile(destination, plainText, { encoding: 'utf8', mode: 0o600 })
  return destination
}
