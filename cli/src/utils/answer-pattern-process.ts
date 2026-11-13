export const ANSWER_PATTERN_RESULT_PREFIX = 'openbuff-answer-pattern-result:'

/** Self-contained: source-mode checks serialize this function for Bun/Node -e. */
export function runAnswerPatternProcess(): void {
  const prefix = 'openbuff-answer-pattern-result:'
  let input = ''
  let replied = false
  const reply = (value: { matches?: boolean; invalidPattern?: boolean }) => {
    if (replied) return
    replied = true
    process.stdout.write(prefix + JSON.stringify(value) + '\n', () =>
      process.exit(0),
    )
  }
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    input += chunk
    if (Buffer.byteLength(input, 'utf8') > 64 * 1024)
      reply({ invalidPattern: true })
  })
  process.stdin.on('end', () => {
    if (replied) return
    try {
      const value = JSON.parse(input) as { text?: unknown; pattern?: unknown }
      if (
        !value ||
        typeof value.text !== 'string' ||
        typeof value.pattern !== 'string' ||
        value.pattern.length > 4096
      )
        return reply({ invalidPattern: true })
      reply({ matches: new RegExp(value.pattern).test(value.text) })
    } catch {
      reply({ invalidPattern: true })
    }
  })
  process.stdin.on('error', () => reply({ invalidPattern: true }))
}
