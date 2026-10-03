export type {
  IndexedFile,
  IndexingConfig,
  MetadataIndex,
  QueryIndexResult,
  EdgeConfidence,
  IndexNodeType,
  IndexNode,
  IndexEdgeType,
  IndexEdge,
  IndexGraph,
  IndexQueryData,
  IndexCoverage,
  IndexStatus,
  IndexBuildError,
  IndexMutationDelta,
  IndexSnapshotIdentity,
  PageRankOptions,
  QueryIndexMode,
  RelatedFile,
} from './types'
export { IndexManager } from './index-manager'
export { buildMetadataIndex, updateMetadataIndex } from './metadata-indexer'
export {
  loadIndex,
  saveIndex,
  loadSemanticVectors,
  saveSemanticVectors,
  isIndexStale,
  isIndexReady,
} from './index-store'
export { queryIndex, evaluateQueryIndexQuality } from './query'
export {
  buildIndexQueryData,
  collectFilePostingTokens,
  getPostingCandidates,
  getPostingDocumentFrequency,
} from './query-data'
export {
  buildRepoMap,
  compareRetrievalStrategies,
  formatRetrievalComparisonReport,
  queryRepoMap,
  rankedRepoMap,
} from './repo-map'
export type {
  RankedRepoMapEntry,
  RepoMapEntry,
  RepoMapOptions,
  RepoMapResult,
  RetrievalComparisonCase,
  RetrievalComparisonReport,
  RetrievalStrategyMetrics,
} from './repo-map'
export { getPageRankAdjacency, personalizedPageRank } from './pagerank'
export type { PageRankEdge, PersonalizedPageRankParams } from './pagerank'
export { walkProject } from './file-walker'
export type { WalkedFile } from './file-walker'
export { extractAssetRefs, extractGodotScriptRefs } from './asset-refs'
export type { AssetRef } from './asset-refs'
export type {
  QueryOptions,
  QueryQualityCase,
  QueryQualityReport,
} from './query'
export {
  isSemanticIndexingAvailable,
  cosineSimilarity,
  buildFileVectors,
  semanticSearch,
  blendSemanticScores,
  fileEmbeddingText,
  fileEmbeddingHash,
  getSemanticConfigFingerprint,
} from './semantic'
export type { EmbedFn, FileVector, SemanticHit } from './semantic'
export { evaluateRetrievalQuality } from './retrieval-quality'
export type {
  RetrievalQualityCase,
  RetrievalQualityCorpus,
  RetrievalQualityDocument,
  RetrievalQualityEvaluationOptions,
  RetrievalQualityMetrics,
} from './retrieval-quality'
export {
  mergeScipIntoIndex,
  parseScipJson,
  SCIP_MAX_MERGED_EDGES,
  SCIP_MAX_OCCURRENCES_PER_DOCUMENT,
  ScipIngestError,
} from './scip-ingest'
export type {
  ScipDocument,
  ScipIndex,
  ScipIngestErrorCode,
  ScipOccurrence,
} from './scip-ingest'
