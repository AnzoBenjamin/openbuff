import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createConfiguredEmbedder } from '../impl/embeddings'
import { PROVIDER_CONFIG_ENV_VAR } from '../provider-config'

test('local embeddings keep batches bounded, ordered and serial', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openbuff-embedding-test-'))
  const batches: string[][] = []
  let active = 0
  let maximumActive = 0
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { input: string[] }
      batches.push(body.input)
      active++
      maximumActive = Math.max(maximumActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      return Response.json({
        data: body.input.map((value) => ({ embedding: [Number(value), 1] })),
      })
    },
  })
  try {
    const configPath = join(root, 'openbuff.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        providers: {
          local: {
            type: 'openai-compatible',
            baseURL: `http://127.0.0.1:${server.port}/v1`,
            models: ['embedding-model'],
          },
        },
        defaultModel: 'local/embedding-model',
      }),
    )
    const embed = createConfiguredEmbedder('local/embedding-model', {
      [PROVIDER_CONFIG_ENV_VAR]: configPath,
    })
    expect(embed).not.toBeNull()
    expect(embed!.maxBatchSize).toBe(8)
    expect(
      await embed!(Array.from({ length: 17 }, (_, i) => String(i))),
    ).toEqual(Array.from({ length: 17 }, (_, i) => [i, 1]))
    expect(batches.map((batch) => batch.length)).toEqual([8, 8, 1])
    expect(maximumActive).toBe(1)
  } finally {
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})
