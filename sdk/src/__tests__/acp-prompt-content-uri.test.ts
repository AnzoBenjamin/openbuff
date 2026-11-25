import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  createAcpPromptContentControl as control,
  expectAcpPromptRefusal as refused,
} from './fixtures/acp-prompt-content'

const linux = process.platform === 'linux' ? describe : describe.skip
const home = process.env.HOME
let root: string
beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'acp-valid-uri-')),
  )
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  expect(process.env.HOME).toBe(home)
})

linux('ACP legitimate file URI encoding', () => {
  test('percent-encoded legitimate Unicode and spaces are decoded once', async () => {
    const c = control(root)
    const file = path.join(root, 'café notes.txt')
    fs.writeFileSync(file, 'UNICODE-PATH-BYTES')
    await c.promptHandler(
      c.input({
        promptContent: [
          {
            type: 'resource_link',
            uri: pathToFileURL(file).href,
            name: 'notes',
          },
        ],
      }),
    )
    expect(c.runs[0].prompt).toContain('UNICODE-PATH-BYTES')
  })
  test('a legitimate percent-encoded URI can exceed 4 KiB without exceeding filesystem path limits', async () => {
    const c = control(root)
    const parent = path.join(
      root,
      ...Array.from({ length: 10 }, () => 'á'.repeat(100)),
    )
    fs.mkdirSync(parent, { recursive: true })
    const file = path.join(parent, 'notes.txt')
    fs.writeFileSync(file, 'LONG-ENCODED-URI-BYTES')
    expect(pathToFileURL(file).href.length).toBeGreaterThan(4096)
    await c.promptHandler(
      c.input({
        promptContent: [
          {
            type: 'resource_link',
            uri: pathToFileURL(file).href,
            name: 'notes',
          },
        ],
      }),
    )
    expect(c.runs[0].prompt).toContain('LONG-ENCODED-URI-BYTES')
  })
  test('oversized URI labels have an accurate typed limit reason and no file opens', async () => {
    const c = control(root)
    const open = spyOn(fs.promises, 'open')
    try {
      await refused(
        c.promptHandler(
          c.input({
            promptContent: [
              {
                type: 'resource',
                resource: {
                  uri: `urn:${'x'.repeat(16 * 1024)}`,
                  text: 'embedded',
                },
              },
            ],
          }),
        ),
        'limit_exceeded',
        'uri_too_large',
      )
      expect(c.runs).toEqual([])
      expect(open).not.toHaveBeenCalled()
    } finally {
      open.mockRestore()
    }
  })
})
