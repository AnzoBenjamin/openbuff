import { runFastCliPath } from './fast-cli'

// Validation children must start without initializing the CLI, SDK or OpenTUI.
// Normal commands still enter the existing pre-init and main lifecycle.
if (process.argv[2] === '--internal-replayable-child') {
  const { handleSupervisedReplayWorker } = await import('@openbuff/sdk')
  process.exit((await handleSupervisedReplayWorker(process.argv)) ?? 1)
} else if (await runFastCliPath(process.argv)) {
  // Version and help have completed without importing the main CLI graph.
} else if (process.argv.includes('--answer-pattern-worker')) {
  const { runAnswerPatternProcess } =
    await import('./utils/answer-pattern-process')
  runAnswerPatternProcess()
} else {
  await import('./index')
}
