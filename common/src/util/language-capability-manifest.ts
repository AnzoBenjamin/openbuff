import z from 'zod/v4'

import {
  LANGUAGE_CAPABILITY_REGISTRY,
  SUPPORTED_LANGUAGE_IDS,
  type LanguageCapability,
  type SupportedLanguageId,
} from './language-capabilities'

/**
 * Version of the serialized language capability manifest shape. Bump this
 * whenever the manifest shape or its validation contract changes (fields
 * added, removed, or renamed) so consumers can pin or migrate. The manifest
 * builder and its golden-fixture test are frozen against this version.
 */
export const LANGUAGE_CAPABILITY_MANIFEST_VERSION = 1

/**
 * Plain-JSON-serializable snapshot of the language capability registry.
 * Unlike the readonly registry types, this shape is safe to serialize, ship,
 * and validate as data.
 */
export type LanguageCapabilityManifestV1 = {
  schemaVersion: 1
  languages: Record<SupportedLanguageId, LanguageCapability>
}

const languageToolRoleSchema = z.enum([
  'parser',
  'languageServer',
  'formatter',
  'linter',
  'typeChecker',
  'compiler',
  'testRunner',
  'importOrganizer',
])

const languageValidationStageSchema = z.enum([
  'syntax',
  'format',
  'lint',
  'typecheck',
  'compile',
  'test',
])

const languageServerTransportSchema = z.enum(['stdio', 'tcp'])

const languageToolSpecSchema = z.object({
  role: languageToolRoleSchema,
  argv: z.array(z.string()),
  transport: languageServerTransportSchema.optional(),
  port: z.number().int().positive().optional(),
  detect: z.array(z.string()).optional(),
  rootMarkers: z.array(z.string()).optional(),
  minVersion: z.string().min(1).optional(),
})

const languageCapabilitySchema = z.object({
  id: z.enum(SUPPORTED_LANGUAGE_IDS),
  displayName: z.string().min(1),
  extensions: z.array(z.string().regex(/^\.[a-z0-9]+$/)).min(1),
  manifestNames: z.array(z.string().min(1)),
  manifestExtensions: z.array(z.string().regex(/^\.[a-z0-9]+$/)),
  taskAliases: z.array(z.string().min(1)),
  guidance: z.string().min(1),
  idiomGuidance: z.array(z.string().min(1)),
  tools: z.record(languageToolRoleSchema, z.array(z.string())),
  validation: z.object({
    focused: z.array(languageValidationStageSchema).min(1),
    project: z.array(languageValidationStageSchema).min(1),
  }),
  toolSpecs: z.array(languageToolSpecSchema).optional(),
})

/**
 * Validates the serialized {@link LanguageCapabilityManifestV1} shape: every
 * supported language must be present exactly once, every tools record must
 * cover all eight LanguageToolRole keys, and validation stages and tool
 * transports must be known values.
 */
export const languageCapabilityManifestV1Schema = z.object({
  schemaVersion: z.literal(LANGUAGE_CAPABILITY_MANIFEST_VERSION),
  languages: z.record(z.enum(SUPPORTED_LANGUAGE_IDS), languageCapabilitySchema),
})

/**
 * Builds the versioned capability manifest from the canonical registry.
 * Entries are deep-cloned through a JSON round-trip, which both proves the
 * registry is plain-JSON serializable and detaches the manifest from the
 * readonly registry objects. Languages are inserted in
 * SUPPORTED_LANGUAGE_IDS order, so JSON.stringify output is deterministic.
 */
export function buildLanguageCapabilityManifest(): LanguageCapabilityManifestV1 {
  const languages: Partial<Record<SupportedLanguageId, LanguageCapability>> = {}
  for (const id of SUPPORTED_LANGUAGE_IDS) {
    languages[id] = JSON.parse(JSON.stringify(LANGUAGE_CAPABILITY_REGISTRY[id]))
  }
  return {
    schemaVersion: LANGUAGE_CAPABILITY_MANIFEST_VERSION,
    // The loop above inserts every SUPPORTED_LANGUAGE_IDS entry in order.
    languages: languages as Record<SupportedLanguageId, LanguageCapability>,
  }
}
