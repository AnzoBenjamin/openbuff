import { createLspMultiplexer, LspExecutionError } from '../services/lsp-multiplexer'
import type { LspMultiplexer, LspMultiplexerOptions, LspResourceFacade } from '../services/lsp-multiplexer'
import type { UsePermit } from '@codebuff/common/types/contracts/execution-context'
import { executionFixture } from './toolchain-execution-fixture'

/** Explicit admission double for existing protocol tests, never authority evidence. */
export function createTestLspMultiplexer(options: LspMultiplexerOptions): LspMultiplexer {
  const fixture = executionFixture()
  const context = { execution: fixture.context.execution }
  const resource = (): LspResourceFacade => ({
    async admitSpawn(spec) {
      const prepared = context.execution.prepareTarget({ target: {
        executable: spec.argv[0], argv: spec.argv.slice(1), cwd: spec.cwd,
        projectRoot: spec.cwd, allowedPaths: [spec.cwd], profile: fixture.context.profile,
        mode: 'assistant', processType: 'BACKGROUND', family: 'lsp', branchId: 'lsp.cold-start',
        adapterOptions: { runtime: 'node' },
      } })
      if (!prepared.ok) return prepared
      const admitted = await prepared.value.admit()
      return admitted.ok ? { ok: true, value: { launch: prepared.value, permit: admitted.value.permit } } : admitted
    },
    nextGeneration() { return { ok: true, value: resource() } },
    request() {
      const permit = {} as UsePermit
      let used = false
      return { ok: true, value: {
        prepareLaunch() { return { ok: false, reason: 'unavailable', cause: 'Use-only test lease' } },
        async admitUse() { return { ok: true, value: permit } },
        useNow(token, use) {
          if (token !== permit || used) return { ok: false, reason: 'already-consumed', cause: 'Fixture permit consumed' }
          used = true
          return { ok: true, value: use() }
        },
        release() { return { ok: true, value: undefined } },
      } }
    },
  })
  const mux = createLspMultiplexer({ ...options, resourceFactory: () => ({ ok: true, value: resource() }),
    spawner(spec, admitted) {
      const dispatched = admitted.launch.dispatchNow(admitted.permit, () => options.spawner(spec, admitted))
      if (!dispatched.ok) throw new LspExecutionError(dispatched)
      return dispatched.value.handle
    },
  })
  return {
    ...mux,
    definition: (params, request = context) => mux.definition(params, request),
    references: (params, request = context) => mux.references(params, request),
    hover: (params, request = context) => mux.hover(params, request),
    prepareRenameParams: (params, request = context) => mux.prepareRenameParams(params, request),
    rename: (params, request = context) => mux.rename(params, request),
    codeAction: (params, request = context) => mux.codeAction(params, request),
    executeCommand: (params, request = context) => mux.executeCommand(params, request),
    documentSymbol: (params, request = context) => mux.documentSymbol(params, request),
    workspaceSymbol: (query, path, request = context) => mux.workspaceSymbol(query, path, request),
    syncFile: (params, request = context) => mux.syncFile(params, request),
  }
}
