import { expect, test } from 'bun:test'
import { AcpRemoteBackend } from '../client/acp-client'

test('remote ACP refuses an unnegotiated per-run model before opening its transport', async () => {
  const backend = new AcpRemoteBackend({
    kind: 'socket',
    socketPath: '/never-connect-run-model',
    token: 'fixture',
  })
  try {
    const result = await backend.run({
      agent: 'base2',
      prompt: 'Must not run a different model',
      model: 'provider/selected',
    })
    expect(result.output).toMatchObject({
      type: 'error',
      message: expect.stringContaining('model'),
    })
    expect(result.runOutcome).toMatchObject({
      termination: 'failed',
      cause: { code: 'remote_model_override_unavailable' },
    })
  } finally {
    await backend.close()
  }
})
