import {
  connectChildBridge,
  buildBridgedChildDeps,
} from '../../child-bridge-client'
import {
  decodeReadCapabilityToken,
  readCapabilityMatchesScope,
} from '@codebuff/common/util/content-hash'
import { authenticateReadFilesItem } from '../../../util/authenticated-read-source'

const [socketPath, bridgeNonce, projectId, parentTokensJson] = process.argv.slice(2)
const client = await connectChildBridge(socketPath!)
try {
  const deps = buildBridgedChildDeps(client, { bridgeNonce })
  const results = []
  for (const agentId of ['child-agent', 'descendant-agent']) {
    const runId = await deps.startAgentRun({
      apiKey: '',
      agentId,
      ancestorRunIds: [],
      logger: {} as never,
    })
    if (!runId) throw new Error('Host failed to register a run')
    const issuer = { projectId: projectId!, runId }
    const result = await deps.requestFiles({
      filePaths: ['file.ts'],
      ranges: [{ path: 'file.ts', startLine: 2, endLine: 2 }],
      capabilityIssuer: issuer,
    })
    results.push({
      runId,
      result,
      authenticated: result.results.map(item =>
        Boolean(authenticateReadFilesItem(item, issuer)),
      ),
      localScopes: result.results.map(item => {
        if (item.status !== 'ok' || !('editAnchor' in item) || !item.editAnchor)
          return false
        const capability = decodeReadCapabilityToken(item.editAnchor.readCapability)
        return typeof capability !== 'string' &&
          readCapabilityMatchesScope(capability, { ...issuer, path: item.path })
      }),
    })
  }
  console.log(JSON.stringify({
    results,
    parentTokensRejected: (JSON.parse(parentTokensJson!) as string[])
      .map(token => typeof decodeReadCapabilityToken(token) === 'string'),
  }))
} finally {
  client.close()
}
