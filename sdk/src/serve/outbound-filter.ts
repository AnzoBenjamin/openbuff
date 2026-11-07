/**
 * Last-line outbound redactor for text about to cross the ACP wire.
 *
 * Mirrors P1-T1-DESIGN §12.1 SEC-1 ("no cap.v3 token / secret value leaves the
 * process"). This is DEFENSE-IN-DEPTH, not the only guard: the serve bridge
 * already structurally DROPS `tool_call`/`tool_result` events and forwards only
 * model-visible assistant text, so a secret-bearing tool result never reaches
 * this filter in the first place. `sanitizeOutbound` is the second layer that
 * catches a secret or capability token that slipped into free-form assistant
 * text anyway.
 *
 * Every pattern is deliberately bounded (character classes with a single `+`
 * or a fixed `{20,}` lower bound, no nested quantifiers over overlapping
 * classes) so matching stays linear and cannot catastrophically backtrack on
 * adversarial input. The function is pure, never throws, and returns the input
 * unchanged when nothing matches.
 */

/**
 * Active read/edit capability tokens are `cap.v3.` followed by a run of
 * base64url / `.` / `-` characters. Bounded single-`+` run, so it is linear.
 */
const CAP_V3_TOKEN_RE = /cap\.v3\.[A-Za-z0-9._-]+/g

/**
 * `KEY=value` provider-secret env pairs. The key prefix is preserved and only
 * the value (`\S+`, a bounded non-whitespace run) is redacted, so an operator
 * still sees WHICH variable leaked without seeing its value.
 */
const ENV_KEY_PAIR_RE =
  /(OPENROUTER_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY)=\S+/g

/**
 * Bare provider secrets by value shape. Ordered most-specific first so
 * `sk-or-v1-...` and `sk-ant-...` win over the generic `sk-<20+>` fallback.
 * Each alternative is a single bounded run over one character class.
 */
const PROVIDER_SECRET_RE =
  /sk-or-v1-[A-Za-z0-9._-]+|sk-ant-[A-Za-z0-9._-]+|sk-[A-Za-z0-9]{20,}/g

/**
 * Redacts capability tokens and provider secrets from outbound text. Env-pair
 * redaction runs before the bare-secret pass so the `KEY=` prefix is kept even
 * when the value itself is a recognizable `sk-` secret.
 */
export function sanitizeOutbound(text: string): string {
  if (text.length === 0) return text
  return text
    .replace(CAP_V3_TOKEN_RE, '[REDACTED_CAPABILITY]')
    .replace(ENV_KEY_PAIR_RE, '$1=[REDACTED_SECRET]')
    .replace(PROVIDER_SECRET_RE, '[REDACTED_SECRET]')
}
