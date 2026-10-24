import { inspectHarnessEnvironment } from '../services/harness-intelligence'
import type { CodebuffToolOutput } from '../../../common/src/tools/list'
export async function inspectEnvironment(
  cwd: string,
  signal?: AbortSignal,
): Promise<CodebuffToolOutput<'inspect_environment'>> {
  return [
    { type: 'json', value: await inspectHarnessEnvironment(cwd, signal) },
  ]
}
