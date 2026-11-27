import type { JSONSchema7 } from 'ai'

/** Add constraints that Zod refinements cannot express in JSON Schema.
 * Call this for every published representation of a built-in input schema.
 */
export function applyToolSchemaConstraints(
  schema: JSONSchema7,
  toolName?: string,
): JSONSchema7 {
  // Zod refinements do not survive JSON Schema conversion. Publish the
  // cross-field requirements explicitly so an empty object is not advertised
  // as a valid call to providers with native schema enforcement.
  const alternatives: Record<string, JSONSchema7[]> = {
    read_files: [
      'paths',
      'ranges',
      'windows',
      'around',
      'symbol',
      'symbols',
    ].map((name) => ({
      required: [name],
      properties: { [name]: { minItems: 1 } },
    })),
    read_logs: [{ required: ['path'] }, { required: ['jobId'] }],
    recall_context: [{ required: ['query'] }, { required: ['toolCallId'] }],
    update_plan_status: [
      { required: ['updates'], properties: { updates: { minItems: 1 } } },
      { required: ['append'] },
      { required: ['sessionStatus'] },
      { required: ['currentTask'] },
      { required: ['checkpoint'] },
      {
        required: ['requestCommittedSurfaceReview'],
        properties: { requestCommittedSurfaceReview: { const: true } },
      },
    ],
    query_index: [
      { required: ['query'], properties: { query: { minLength: 1 } } },
      { required: ['mode'], properties: { mode: { const: 'commands' } } },
      {
        required: ['mode', 'query'],
        properties: {
          mode: { enum: ['search', 'explain'] },
          query: { minLength: 1 },
        },
      },
      {
        required: ['mode', 'from'],
        properties: {
          mode: { enum: ['neighbors', 'references'] },
          from: { minLength: 1 },
        },
      },
      {
        required: ['mode', 'query'],
        properties: { mode: { const: 'neighbors' }, query: { minLength: 1 } },
      },
      {
        required: ['mode', 'to'],
        properties: { mode: { const: 'references' }, to: { minLength: 1 } },
      },
      {
        required: ['mode', 'query'],
        properties: { mode: { const: 'references' }, query: { minLength: 1 } },
      },
      {
        required: ['mode', 'from', 'to'],
        properties: {
          mode: { const: 'path' },
          from: { minLength: 1 },
          to: { minLength: 1 },
        },
      },
      {
        required: ['mode', 'query'],
        properties: { mode: { const: 'path' }, query: { minLength: 1 } },
      },
    ],
  }
  if (toolName && alternatives[toolName]) {
    schema.anyOf = alternatives[toolName]
  }
  if (toolName === 'update_plan_status') {
    const updates = schema.properties?.updates as JSONSchema7 | undefined
    if (
      updates &&
      !Array.isArray(updates.items) &&
      typeof updates.items === 'object'
    ) {
      updates.items.anyOf = [{ required: ['taskId'] }, { required: ['task'] }]
    }
  }
  return schema
}
