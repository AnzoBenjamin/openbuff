import {
  getCustomToolDefinition,
  createDirectHostExecution,
  runTerminalCommand,
  type CodebuffSpawn,
  type Correlation,
  type CustomToolDefinition,
  type ExecutionAdapterContext,
  type JobOwner,
  type ProfileRequest,
  type RunHostServices,
  type WorkspaceIdentitySource,
} from '@openbuff/sdk'
import { z } from 'zod/v4'

const schema = z.object({
  count: z.string().default('3').transform(Number),
  source: z.string().transform((value) => value.toUpperCase()),
})
const tool = getCustomToolDefinition({
  toolName: 'public_typed_transform',
  inputSchema: schema,
  description: 'Public declaration consumer',
  exampleInputs: [{ source: 'data' }, { count: '7', source: 'data' }],
  execute: ({ count, source }, context) => {
    const parsedNumber: number = count
    const parsedSource: string = source
    const signal: AbortSignal | undefined = context?.signal
    const canonicalPath: string | undefined =
      context?.authorizedPaths?.[0]?.path
    void signal
    void canonicalPath
    return [{ type: 'json', value: { parsedNumber, parsedSource } }]
  },
})
const definition: CustomToolDefinition<
  'public_typed_transform',
  z.output<typeof schema>,
  z.input<typeof schema>
> = tool
const rawInput: (typeof tool)['exampleInputs'][number] = { source: 'data' }
const invalidInput: (typeof tool)['exampleInputs'][number] = {
  // @ts-expect-error Raw examples retain strings before transformation.
  count: 3,
  source: 'data',
}

getCustomToolDefinition({
  toolName: 'public_invalid_example',
  inputSchema: schema,
  description: 'Reject invalid raw input at the factory call',
  exampleInputs: [
    {
      // @ts-expect-error Factory examples are inferred only from the input schema.
      count: 3,
      source: 'data',
    },
  ],
  execute: ({ count }) => [{ type: 'json', value: { count } }],
})

getCustomToolDefinition<
  'public_explicit',
  { count: number },
  { count: string }
>({
  toolName: 'public_explicit',
  inputSchema: z.object({ count: z.string().transform(Number) }),
  description: 'Explicit generic compatibility',
  exampleInputs: [{ count: '5' }],
  execute: ({ count }) => [{ type: 'json', value: { count } }],
})
void definition
void rawInput
void invalidInput

// Compile the direct execution API through the published entrypoint without
// importing workspace aliases or running a command during declaration checks.
async function publicExecutionConsumer(cwd: string, spawn?: CodebuffSpawn) {
  const profile: ProfileRequest = { policy: 'full-access', preferredBackend: 'portable-ts', required: ['exact-env'], allowBackendFallback: false }
  const host = createDirectHostExecution({ cwd, profile, spawn, env: { REMOVE_ME: undefined }, limit: { kind: 'finite', durationMs: 30_000 } })
  if (!host.ok) return host
  const services: RunHostServices = host.value.hostServices
  const executionContext: ExecutionAdapterContext = host.value.executionContext
  const owner: JobOwner = { clientSessionId: 'client', rootRunId: 'run', parentRunId: 'run', parentAgentId: 'agent' }
  const identitySource: WorkspaceIdentitySource = 'git-observed'
  const registration = services.execution.actionRegistration(executionContext.execution)
  if (registration.ok) {
    const correlation: Correlation = registration.value.correlation
    const requestSignal: AbortSignal = registration.value.signal
    void correlation
    void requestSignal
  }
  void owner
  void identitySource
  return runTerminalCommand({ command: 'git status --short', process_type: 'SYNC', cwd, timeout_seconds: 30,
    executionContext, terminalShell: services.terminalShell, getTerminalLaunchMetadata: services.getTerminalLaunchMetadata })
}
void publicExecutionConsumer
