import { createNodeFileSystem } from '/home/ben/Code/CLI/openbuff/sdk/src/tools/node-filesystem'
const fs = createNodeFileSystem()
import { getFilesStructured } from '/home/ben/Code/CLI/openbuff/sdk/src/tools/read-files'
import { simplifyToolResultContent } from '/home/ben/Code/CLI/openbuff/packages/agent-runtime/src/util/simplify-tool-results'
import { readFilesResultV1Schema } from '/home/ben/Code/CLI/openbuff/common/src/tools/results/filesystem'
import { decodeReadCapabilityToken } from '/home/ben/Code/CLI/openbuff/common/src/util/content-hash'

const logger = { info() {}, warn() {}, error: console.error, debug() {} } as any
const value = await getFilesStructured({
  filePaths: ['src/big.ts'], cwd: '/tmp/verify-runtime/proj', fs: fs as any,
  ranges: [{ path: 'src/big.ts', startLine: 10, endLine: 20 }],
  capabilityIssuer: { projectId: '/tmp/verify-runtime/proj', runId: 'verify-run-1' },
})
const before = [{ type: 'json', value }] as any
const after = simplifyToolResultContent({ toolName: 'read_files', content: before, logger }) as any
const show = (items: any[]) => items.map((e: any) => ({
  selector: e.selector, status: e.status, complete: e.complete,
  hasContent: typeof e.content === 'string', contentLen: e.content?.length,
  hasSourceContent: typeof e.sourceContent === 'string',
  contentOmittedForLength: e.contentOmittedForLength,
  hasRawSourceContent: typeof e.rawSourceContent === 'string',
  editAnchor: e.editAnchor && { startLine: e.editAnchor.startLine, endLine: e.editAnchor.endLine,
    scope: e.editAnchor.rawBasis?.scope, capPrefix: e.editAnchor.readCapability.slice(0, 12) },
  truncation: e.truncation,
}))
console.log('BEFORE', JSON.stringify(show(value.results), null, 1))
console.log('AFTER ', JSON.stringify(show(after[0].value.results), null, 1))
const same = after[0].value.results.map((e: any, i: number) => e.editAnchor?.readCapability === value.results[i].editAnchor?.readCapability)
console.log('readCapability token unchanged per item:', same)
for (const e of after[0].value.results) if (e.editAnchor) {
  const d = decodeReadCapabilityToken(e.editAnchor.readCapability) as any
  console.log('decoded', e.selector, d && { startLine: d.startLine, endLine: d.endLine, scope: d.rawBasis?.scope, hashMatches: d.hash === e.editAnchor.contentHash })
}
const parsed = readFilesResultV1Schema.safeParse(after[0].value)
console.log('trimmed result passes readFilesResultV1Schema:', parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues).slice(0, 400))
console.log('tokens(chars) before/after:', JSON.stringify(before).length, JSON.stringify(after).length)
