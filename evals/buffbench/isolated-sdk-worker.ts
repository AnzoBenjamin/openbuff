import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Launched from an empty owned cwd with --no-env-file and a replacement env.
const [requestPath, responsePath, eventsPath] = process.argv.slice(2)
if (!requestPath || !responsePath || !eventsPath)
  throw new Error('Missing isolated SDK worker paths')
const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'))
const fetchObservation = {
  scope: 'SDK globalThis.fetch transport only; no OS/network confinement',
  attempted: 0,
  forwarded: 0,
  refused: 0,
  refuseForFixture: request.refuseFetchForFixture === true,
}
const originalFetch = globalThis.fetch
globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
  fetchObservation.attempted++
  if (fetchObservation.refuseForFixture) {
    fetchObservation.refused++
    throw new Error('Fixture refused SDK fetch before network dispatch')
  }
  fetchObservation.forwarded++
  return originalFetch(...args)
}, originalFetch)
const observation = {
  scope: 'child_process_replacement_environment',
  agentId: request.input.agent,
  pid: process.pid,
  cwd: process.cwd(),
  home: os.homedir(),
  controllerSentinelPresent: process.env.B30_CONTROLLER_SENTINEL !== undefined,
  ambientProviderConfigPresent:
    process.env.OPENBUFF_PROVIDER_CONFIG !== undefined,
  defaultUserConfigPresent: fs.existsSync(
    path.join(os.homedir(), '.config', 'openbuff'),
  ),
  envNames: Object.keys(process.env).sort(),
  fetch: fetchObservation,
  providerConfigSourcePaths: [] as string[],
  selectedProviderCredentials: [] as {
    providerId: string
    credentialEnv: string
    present: boolean
  }[],
}
try {
  let eventBytes = 0
  let eventLimitExceeded = false
  const { OpenbuffClient } = await import('../../sdk/src/index')
  const { loadProviderConfigSync } =
    await import('../../sdk/src/provider-config')
  const loadedConfig = loadProviderConfigSync()
  observation.providerConfigSourcePaths = loadedConfig.sourceFilePaths
  observation.selectedProviderCredentials = Object.entries(
    loadedConfig.config.providers,
  ).flatMap(([providerId, provider]) =>
    'apiKeyEnv' in provider && provider.apiKeyEnv
      ? [
          {
            providerId,
            credentialEnv: provider.apiKeyEnv,
            present: Boolean(process.env[provider.apiKeyEnv]),
          },
        ]
      : [],
  )
  const client = new OpenbuffClient({
    cwd: request.input.cwd,
    projectFiles: {},
    harnessStateDir: path.join(os.homedir(), 'harness'),
  })
  const result = await client.run({
    ...request.input,
    inheritEnv: false,
    handleEvent: (event) => {
      const line = JSON.stringify(event) + '\n'
      if (eventBytes + Buffer.byteLength(line) > 8 * 1024 * 1024) {
        eventLimitExceeded = true
        throw new Error('Isolated SDK event evidence exceeds 8 MiB')
      }
      fs.appendFileSync(eventsPath, line)
      eventBytes += Buffer.byteLength(line)
    },
  })
  if (eventLimitExceeded)
    throw new Error('Isolated SDK event evidence exceeds 8 MiB')
  fs.writeFileSync(responsePath, JSON.stringify({ result, observation }), {
    flag: 'wx',
  })
} catch (error) {
  fs.writeFileSync(
    responsePath,
    JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      observation,
    }),
    { flag: 'wx' },
  )
  process.exitCode = 1
}
