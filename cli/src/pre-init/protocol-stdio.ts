import { isNonRendererCommandArgv } from '../cli-args'

type DiagnosticConsole = Pick<Console, 'log' | 'info' | 'debug' | 'error'>

/**
 * Reserve stdout for headless/protocol output before the SDK's import-time
 * diagnostics run. Explicit wire writes still use process.stdout directly;
 * renderer launches and version/help fast paths keep their existing console.
 */
export function routeProtocolDiagnostics(
  argv: string[],
  output: DiagnosticConsole = console,
): () => void {
  if (!isNonRendererCommandArgv(argv)) return () => {}
  const methods = ['log', 'info', 'debug'] as const
  const originals = methods.map((method) => output[method])
  const diagnostic = output.error.bind(output)
  for (const method of methods) output[method] = diagnostic
  return () => {
    methods.forEach((method, index) => {
      if (output[method] === diagnostic) output[method] = originals[index]
    })
  }
}

routeProtocolDiagnostics(process.argv)
