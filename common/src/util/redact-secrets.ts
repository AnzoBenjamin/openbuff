/**
 * Conservative secret redaction for prompt bytes, debug/error logs, and
 * serialized error payloads (M1-T5 / audit R4).
 *
 * Design contract: a line that carries NEITHER a sensitive-keyword assignment
 * NOR a well-known token shape passes through UNCHANGED, so normal code and
 * diff text are never mangled. Only the listed shapes are touched.
 */

/** Assignment variable names that indicate a secret VALUE on the right side. */
const SENSITIVE_KEYWORD =
  /(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_?KEY|ACCESS_?KEY|SESSION|BEARER)/i

/** Value shapes that are secrets regardless of the variable name. */
const TOKEN_SHAPES: Array<[RegExp, string]> = [
  [/(sk-[A-Za-z0-9_-]{16,})/g, '[REDACTED]'],
  [/(ghp_[A-Za-z0-9]{20,})/g, '[REDACTED]'],
  [/(gh[o rus]_[A-Za-z0-9]{20,})/g, '[REDACTED]'],
  [/(AKIA[0-9A-Z]{16})/g, '[REDACTED]'],
  [/(Bearer\s+[A-Za-z0-9._\-~+/=]{20,})/g, 'Bearer [REDACTED]'],
]

/**
 * `scheme://user:pass@host` → `scheme://[REDACTED]@host` (userinfo credentials
 * embedded in a URL).
 */
const URL_CREDENTIALS = /(\w+:\/\/)[^/@\s:]+:[^/@\s]+@/g

/**
 * `KEY=value` / `export KEY=value` / `set KEY=value` / `KEY: value` where the
 * key names a secret: the value side is replaced wholesale.
 */
function redactSensitiveAssignments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (!SENSITIVE_KEYWORD.test(line)) return line
      // Only treat it as an assignment when the sensitive keyword is the
      // (possibly decorated) leading name of a `name=value` or `name: value`
      // pair — not a mere mention inside prose.
      return line.replace(
        /^(\s*(?:export\s+|set\s+)?[A-Za-z_][A-Za-z0-9_]*(?:[A-Za-z0-9_]*?(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_?KEY|ACCESS_?KEY|SESSION|BEARER)[A-Za-z0-9_]*)|\s*(?:export\s+|set\s+)?[A-Za-z_][A-Za-z0-9_]*)(\s*[:=]\s*).+$/,
        (match, name: string, separator: string) =>
          SENSITIVE_KEYWORD.test(name) ? `${name}${separator}[REDACTED]` : match,
      )
    })
    .join('\n')
}

function redactTokenShapes(text: string): string {
  let redacted = text
  for (const [pattern, replacement] of TOKEN_SHAPES) {
    redacted = redacted.replace(pattern, replacement)
  }
  return redacted
}

/**
 * Redact obvious secrets from arbitrary text. Conservative by construction:
 * only sensitive-keyword assignments, well-known token shapes, and URL-embedded
 * credentials are rewritten; everything else passes through unchanged.
 */
export function redactSecretValues(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text
  return redactTokenShapes(
    redactSensitiveAssignments(text.replace(URL_CREDENTIALS, '$1[REDACTED]@')),
  )
}
