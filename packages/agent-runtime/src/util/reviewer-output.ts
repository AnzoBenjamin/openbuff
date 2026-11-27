/** Detect reviewer-family receipts that cannot carry a gate verdict. */
export function reviewerVerdictIssue(
  agentType: string | null | undefined,
  value: unknown,
): string | undefined {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  const id = agentType ?? ''
  const isGateReviewer = /(?:^|\/)(?:code|security)-reviewer(?:@|$)/i.test(id)
  const isReviewer = isGateReviewer || record?.family === 'reviewer'
  if (!isReviewer) return undefined
  if (
    !['LOOKS_GOOD', 'NON_BLOCKING', 'BLOCKING'].includes(
      String(record?.verdict),
    )
  ) {
    return 'The reviewer receipt is missing a valid verdict. Set verdict to LOOKS_GOOD, NON_BLOCKING, or BLOCKING based on your completed review.'
  }
  return undefined
}
