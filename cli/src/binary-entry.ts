import { runAnswerPatternProcess } from './utils/answer-pattern-process'

// Validation children must start without initializing the CLI, SDK or OpenTUI.
// Normal commands still enter the existing pre-init and main lifecycle.
if (process.argv.includes('--answer-pattern-worker')) {
  runAnswerPatternProcess()
} else {
  await import('./index')
}
