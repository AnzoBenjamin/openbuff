import { afterEach, describe, expect, test } from 'bun:test'
import {
  createAcpPromptContentControl as control,
  expectAcpPromptRefusal as refused,
  acpPromptTestImage as image,
} from './fixtures/acp-prompt-content'

const home = process.env.HOME
afterEach(() => expect(process.env.HOME).toBe(home))

describe('ACP image and resource encoding controls', () => {
  test.each([
    '!',
    'a===',
    'AA=A',
    'YQ',
    'YQ==\n',
    'Zh==',
    'YWJ=',
    'a-b_',
    'data:image/png;base64,YQ==',
  ])('invalid or noncanonical base64 %s is refused', async (data) => {
    const c = control()
    await refused(
      c.promptHandler(c.input({ promptContent: [{ ...image, data }] })),
      'invalid_prompt_content',
      'invalid_base64',
    )
    expect(c.runs).toEqual([])
  })
  test.each(['image/svg+xml', 'application/pdf', 'audio/wav'])(
    'unsupported image MIME %s is refused',
    async (mimeType) => {
      const c = control()
      await refused(
        c.promptHandler(c.input({ promptContent: [{ ...image, mimeType }] })),
        'unsupported_prompt_content',
        'unsupported_mime',
      )
      expect(c.runs).toEqual([])
    },
  )
  test.each([
    {
      uri: 'urn:bad-utf8',
      mimeType: 'text/plain',
      blob: Buffer.from([0xc3, 0x28]).toString('base64'),
    },
    { uri: 'urn:bad-utf8', mimeType: 'text/plain', text: '\ud800' },
  ])('resource text must be lossless UTF-8', async (resource) => {
    const c = control()
    await refused(
      c.promptHandler(
        c.input({ promptContent: [{ type: 'resource', resource }] }),
      ),
      'invalid_prompt_content',
      'invalid_utf8',
    )
    expect(c.runs).toEqual([])
  })
  test('blob MIME and charset are validated rather than relabelled as text', async () => {
    for (const mimeType of [
      'application/octet-stream',
      'application/pdf',
      'audio/wav',
      'text/plain; charset=iso-8859-1',
    ]) {
      const c = control()
      await refused(
        c.promptHandler(
          c.input({
            promptContent: [
              {
                type: 'resource',
                resource: { uri: 'urn:unknown', mimeType, blob: 'YQ==' },
              },
            ],
          }),
        ),
        'unsupported_prompt_content',
        'unsupported_mime',
      )
      expect(c.runs).toEqual([])
    }
  })
  test('resource blobs validate base64 and preserve UTF-8 BOM and whitespace', async () => {
    const c = control()
    await refused(
      c.promptHandler(
        c.input({
          promptContent: [
            {
              type: 'resource',
              resource: {
                uri: 'urn:bad-blob',
                mimeType: 'text/plain',
                blob: 'not base64',
              },
            },
          ],
        }),
      ),
      'invalid_prompt_content',
      'invalid_base64',
    )
    const text = '\ufeff  café\r\n'
    await c.promptHandler(
      c.input({
        promptContent: [
          {
            type: 'resource',
            resource: {
              uri: 'urn:bom',
              mimeType: 'text/plain; charset=utf-8',
              blob: Buffer.from(text).toString('base64'),
            },
          },
        ],
      }),
    )
    expect(c.runs[0].prompt).toContain(text)
  })
})
