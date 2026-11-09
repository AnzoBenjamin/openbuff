import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createIsolatedEvaluationClient } from '../../evals/buffbench/isolated-sdk-client'
import { runAgentOnCommit } from '../../evals/buffbench/agent-runner'
import { runTerminalCommand } from '../../sdk/src/tools/run-terminal-command'
import { createDirectHostExecution } from '../../sdk/src/host-execution'
import { runTask } from '../../evals/buffbench/run-buffbench'
import { analyzeAllTasks } from '../../evals/buffbench/meta-analyzer'
import { withEvaluationEnvironment } from '../../evals/buffbench/evaluation-environment'

const nominalModel = 'openai/gpt-4.1'
function agent(id: string, value: unknown) {
  return {
    id,
    displayName: id,
    model: nominalModel,
    toolNames: ['set_output'],
    outputMode: 'structured_output',
    handleSteps: `function* () { yield {toolName:'set_output',input:${JSON.stringify(value)}} }`,
  } as any
}

/** Real child source SDK, serialized deterministic generators, no model request. */
export async function runEvaluatorIsolationFixture(root: string) {
  fs.mkdirSync(root, { recursive: true })
  const previousSentinel = process.env.B30_CONTROLLER_SENTINEL
  const previousConfig = process.env.OPENBUFF_PROVIDER_CONFIG
  const controllerConfig = path.join(root, 'controller-provider-config.json')
  fs.writeFileSync(
    controllerConfig,
    JSON.stringify({ defaultModel: 'controller-only/invalid-model' }),
  )
  process.env.B30_CONTROLLER_SENTINEL = 'controller-only'
  process.env.OPENBUFF_PROVIDER_CONFIG = controllerConfig
  try {
    const workspace = path.join(root, 'repo')
    fs.mkdirSync(workspace)
    fs.writeFileSync(path.join(workspace, 'README.md'), 'fixture\n')
    execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore' })
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.com',
        'add',
        '.',
      ],
      { cwd: workspace, stdio: 'ignore' },
    )
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.com',
        'commit',
        '-m',
        'fixture',
      ],
      { cwd: workspace, stdio: 'ignore' },
    )
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: workspace,
      encoding: 'utf8',
    }).trim()
    const mainAgent = {
      ...agent('isolation-fixture', {}),
      toolNames: ['run_terminal_command', 'set_output'],
      handleSteps: `function* () {
      const terminal = yield {toolName:'run_terminal_command',input:{command:"printf 'sentinel=%s\\nhome=%s\\n' \\\"$B30_CONTROLLER_SENTINEL\\\" \\\"$HOME\\\"",process_type:'SYNC'}};
      const init = yield {toolName:'run_terminal_command',input:{command:'cat init-env.json',process_type:'SYNC'}};
      yield {toolName:'set_output',input:{controller:process.env.B30_CONTROLLER_SENTINEL ?? null,providerConfig:process.env.OPENBUFF_PROVIDER_CONFIG ?? null,home:process.env.HOME,terminal:terminal.toolResult[0].value,init:JSON.parse(init.toolResult[0].value.stdout)}};
    }`,
    }
    const score = {
      analysis: 'fixture',
      strengths: [],
      weaknesses: [],
      completionScore: 10,
      codeQualityScore: 10,
      overallScore: 10,
    }
    const adapter = createIsolatedEvaluationClient({
      agentDefinitions: [
        mainAgent,
        agent('judge-gpt', score),
        agent('judge-gemini', score),
        agent('buffbench-lessons-extractor', { lessons: [], proposals: [] }),
        agent('trace-analyzer', {
          overallAnalysis: 'fixture',
          agentFeedback: [],
        }),
        agent('buffbench-meta-analyzer', {
          overallComparison: 'fixture',
          agentInsights: [],
          keyFindings: [],
          recommendations: [],
        }),
      ],
    })
    const commit = {
      id: 'isolation-task',
      sha,
      parentSha: sha,
      spec: 'fixture',
      prompt: 'fixture',
      supplementalFiles: [],
      fileDiffs: [],
      languages: ['typescript'],
    }
    const main = await runAgentOnCommit({
      client: adapter.client,
      agentId: 'isolation-fixture',
      commit,
      repoUrl: `file://${workspace}`,
      localAgentDefinitions: [],
      printEvents: false,
      executionScope: 'key_free_environment',
      initCommand: `node -e 'require("node:fs").writeFileSync("init-env.json",JSON.stringify({sentinel:process.env.B30_CONTROLLER_SENTINEL ?? null,home:process.env.HOME}))'`,
      finalCheckCommands: [
        `node -e 'console.log(JSON.stringify({sentinel:process.env.B30_CONTROLLER_SENTINEL ?? null,home:process.env.HOME}))'`,
      ],
    })
    if (main.error) throw new Error(main.error)
    const outputEvent = main.trace.find(
      (event: any) =>
        event.type === 'tool_call' && event.toolName === 'set_output',
    ) as any
    const output = outputEvent?.input
    const observedMain = adapter.observations[0]!
    if (
      observedMain.controllerSentinelPresent ||
      observedMain.ambientProviderConfigPresent ||
      observedMain.home === process.env.HOME ||
      fs.existsSync(String(observedMain.home))
    )
      throw new Error('Main SDK worker inherited controller state')
    if (
      output?.controller !== null ||
      output?.providerConfig !== null ||
      output?.terminal?.stdout !== `sentinel=\nhome=${observedMain.home}\n` ||
      output?.terminal?.exitCode !== 0 ||
      output?.init?.sentinel !== null ||
      output?.init?.home === process.env.HOME ||
      fs.existsSync(output?.init?.home)
    )
      throw new Error(
        'Actual SDK generator, terminal or init inherited controller state',
      )
    const final = JSON.parse(main.finalCheckOutputs![0]!.stdout)
    if (
      final.sentinel !== null ||
      final.home === process.env.HOME ||
      fs.existsSync(final.home)
    )
      throw new Error('Final check inherited controller state')
    const task = await runTask({
      client: adapter.client,
      commit,
      agents: ['isolation-fixture'],
      repoUrl: `file://${workspace}`,
      logsDir: path.join(root, 'task'),
      index: 0,
      totalTasks: 1,
      executionScope: 'key_free_environment',
      localAgentDefinitions: [],
      analyzerContext: {
        agentDefinitions: [],
        agentTypeDefinition: '',
        testedAgentIds: [],
      },
      extractLessons: true,
      printEvents: false,
      initCommand: `node -e 'require("node:fs").writeFileSync("init-env.json",JSON.stringify({sentinel:process.env.B30_CONTROLLER_SENTINEL ?? null,home:process.env.HOME}))'`,
      finalCheckCommands: [
        `node -e 'console.log(JSON.stringify({sentinel:process.env.B30_CONTROLLER_SENTINEL ?? null,home:process.env.HOME}))'`,
      ],
    })
    await withEvaluationEnvironment(
      'key_free_environment',
      undefined,
      async (env) =>
        analyzeAllTasks({
          client: adapter.client,
          env,
          inheritEnv: false,
          logsDir: path.join(root, 'task'),
          agents: ['isolation-fixture'],
          analyzerContext: {
            agentDefinitions: [],
            agentTypeDefinition: '',
            testedAgentIds: [],
          },
        }),
    )
    if (
      adapter.observations.length !== 7 ||
      JSON.stringify(
        adapter.observations.map((observation) => observation.agentId).sort(),
      ) !==
        JSON.stringify(
          [
            'isolation-fixture',
            'isolation-fixture',
            'judge-gpt',
            'judge-gemini',
            'buffbench-lessons-extractor',
            'trace-analyzer',
            'buffbench-meta-analyzer',
          ].sort(),
        ) ||
      adapter.observations.some(
        (observation) =>
          observation.controllerSentinelPresent ||
          observation.ambientProviderConfigPresent ||
          observation.defaultUserConfigPresent ||
          observation.home === process.env.HOME ||
          fs.existsSync(String(observation.home)),
      )
    )
      throw new Error('Auxiliary SDK worker inherited controller state')
    const noKeys = createIsolatedEvaluationClient({
      refuseFetchForFixture: true,
    })
    const missingAgent = await noKeys.client.run({
      agent: 'base2',
      prompt: 'fixture',
      cwd: workspace,
    })
    if (
      missingAgent.output.type !== 'error' ||
      !missingAgent.output.message.startsWith('Invalid agent ID: "base2"') ||
      missingAgent.runOutcome?.termination === 'completed'
    )
      throw new Error(
        'Missing-agent control did not refuse the unavailable definition',
      )
    const missingCredentialConfig = path.join(
      root,
      'missing-credential-provider.json',
    )
    const missingCredentialModel = 'b30-no-key/gpt-4.1'
    const missingCredentialEnv = 'B30_MISSING_API_KEY'
    fs.writeFileSync(
      missingCredentialConfig,
      JSON.stringify({
        defaultModel: missingCredentialModel,
        providers: {
          'b30-no-key': {
            type: 'openai-compatible',
            baseURL: 'https://b30-provider.invalid/v1',
            apiKeyEnv: missingCredentialEnv,
            models: ['gpt-4.1'],
          },
        },
      }),
    )
    const unavailable = await noKeys.client.run({
      agent: 'valid-no-key-fixture',
      prompt: 'fixture',
      cwd: workspace,
      env: { OPENBUFF_PROVIDER_CONFIG: missingCredentialConfig },
      agentDefinitions: [
        {
          id: 'valid-no-key-fixture',
          displayName: 'Valid no-key fixture',
          model: missingCredentialModel,
          toolNames: [],
          systemPrompt: 'Fixture agent',
        },
      ],
    })
    const expectedMissingCredential = `Agent run error: Missing environment variable '${missingCredentialEnv}' required for configured provider 'b30-no-key' and model '${missingCredentialModel}'.`
    const noKeyObservation = noKeys.observations[1] as any
    if (
      unavailable.output.type !== 'error' ||
      unavailable.output.message !== expectedMissingCredential ||
      unavailable.runOutcome?.termination === 'completed' ||
      noKeyObservation.fetch.attempted !== 0 ||
      noKeyObservation.fetch.forwarded !== 0 ||
      JSON.stringify(noKeyObservation.providerConfigSourcePaths) !==
        JSON.stringify([missingCredentialConfig]) ||
      JSON.stringify(noKeyObservation.selectedProviderCredentials) !==
        JSON.stringify([
          {
            providerId: 'b30-no-key',
            credentialEnv: missingCredentialEnv,
            present: false,
          },
        ]) ||
      noKeyObservation.controllerSentinelPresent ||
      noKeyObservation.defaultUserConfigPresent ||
      noKeyObservation.home === process.env.HOME ||
      fs.existsSync(noKeyObservation.home)
    )
      throw new Error(
        'Valid selected provider did not refuse missing credentials before fetch',
      )
    const fetchGuardControl = await noKeys.client.run({
      agent: 'fetch-guard-fixture',
      prompt: 'fixture',
      cwd: workspace,
      agentDefinitions: [
        {
          id: 'fetch-guard-fixture',
          displayName: 'Fetch guard fixture',
          model: nominalModel,
          toolNames: ['set_output'],
          outputMode: 'structured_output',
          handleSteps: `function* () {
          fetch('https://b30-provider.invalid/guard-control').catch(() => {});
          yield {toolName:'set_output',input:{initiated:true}};
        }`,
        },
      ],
    } as any)
    const fetchGuardObservation = noKeys.observations[2] as any
    if (
      fetchGuardControl.output.type !== 'structuredOutput' ||
      fetchGuardControl.output.value?.initiated !== true ||
      fetchGuardObservation.fetch.attempted !== 1 ||
      fetchGuardObservation.fetch.refused !== 1 ||
      fetchGuardObservation.fetch.forwarded !== 0
    )
      throw new Error(
        'Fetch observation/refusal control did not record pre-dispatch refusal',
      )
    let rejectedCallback = false
    try {
      await adapter.client.run({
        agent: 'fixture',
        prompt: 'fixture',
        requestApproval: async () => true,
      } as any)
    } catch {
      rejectedCallback = true
    }
    if (!rejectedCallback)
      throw new Error('Nonserializable host callback was accepted')
    const trustedStop = new AbortController()
    const trustedHost = createDirectHostExecution({
      cwd: workspace, projectRoot: workspace, signal: trustedStop.signal,
      limit: { kind: 'finite', durationMs: 10_000 },
      hostConfiguration: {
        environment: { ...process.env }, platform: process.platform,
        invocationCwd: workspace, projectRoot: workspace,
        home: { kind: 'none' }, globals: { kind: 'disabled' }, selection: { kind: 'none' },
        trust: { ancestorConfig: false, projectReadableRoots: false },
      },
    })
    if (!trustedHost.ok) throw new Error(`Trusted SDK host unavailable: ${trustedHost.cause}`)
    const { executionContext, hostServices } = trustedHost.value
    const trusted = await runTerminalCommand({
      command: 'printf \'sentinel=%s\n\' "$B30_CONTROLLER_SENTINEL"',
      process_type: 'SYNC',
      mode: 'assistant',
      permission_profile: 'workspace-write',
      cwd: workspace,
      projectRoot: workspace,
      timeout_seconds: 10,
      executionContext,
      terminalShell: hostServices.terminalShell,
      getTerminalLaunchMetadata: hostServices.getTerminalLaunchMetadata,
    }).finally(() => trustedStop.abort(new Error('Trusted SDK fixture settled')))
    if ((trusted[0] as any)?.value?.stdout !== 'sentinel=controller-only\n')
      throw new Error('Trusted SDK environment compatibility changed')
    const report = {
      trusted,
      scope:
        'actual child source SDK with replacement process env and ephemeral home; no OS/network confinement claim',
      main,
      output,
      final,
      task: task.agentResults,
      observations: adapter.observations,
      unavailable: {
        agentId: 'valid-no-key-fixture',
        selectedModel: missingCredentialModel,
        expectedMissingCredential,
        providerConfig: missingCredentialConfig,
        output: unavailable.output,
        runOutcome: unavailable.runOutcome,
        observations: noKeys.observations,
      },
      missingAgent: {
        output: missingAgent.output,
        runOutcome: missingAgent.runOutcome,
        observation: noKeys.observations[0],
      },
      fetchGuardControl: {
        output: fetchGuardControl.output,
        observation: fetchGuardObservation,
      },
      rejectedCallback,
    }
    fs.writeFileSync(
      path.join(root, 'isolation-report.json'),
      JSON.stringify(report, null, 2),
    )
    return report
  } finally {
    if (previousSentinel === undefined)
      delete process.env.B30_CONTROLLER_SENTINEL
    else process.env.B30_CONTROLLER_SENTINEL = previousSentinel
    if (previousConfig === undefined)
      delete process.env.OPENBUFF_PROVIDER_CONFIG
    else process.env.OPENBUFF_PROVIDER_CONFIG = previousConfig
  }
}
if (import.meta.main) {
  if (!process.argv[2]) throw new Error('Provide an owned fixture root')
  await runEvaluatorIsolationFixture(path.resolve(process.argv[2]))
}
