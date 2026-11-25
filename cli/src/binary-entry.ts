import { runFastCliPath } from './fast-cli'

// Validation children must start without initializing the CLI, SDK or OpenTUI.
// Normal commands still enter the existing pre-init and main lifecycle.
if (await runFastCliPath(process.argv)) {
  // Version and help have completed without importing the main CLI graph.
} else if (process.argv.includes('--answer-pattern-worker')) {
  const { runAnswerPatternProcess } =
    await import('./utils/answer-pattern-process')
  runAnswerPatternProcess()
} else {
  await import('./index')
}
