import { inspectHarnessEnvironment } from '../services/harness-intelligence'
import type { ToolchainExecutionContext } from '../services/toolchain-execution'
import type { CodebuffToolOutput } from '../../../common/src/tools/list'
export async function inspectEnvironment(
  cwd: string,
  signal?: AbortSignal,
  executionContext?: ToolchainExecutionContext,
): Promise<CodebuffToolOutput<'inspect_environment'>> {
  return [
    { type: 'json', value: await inspectHarnessEnvironment(cwd, signal, executionContext) },
  ]
}
