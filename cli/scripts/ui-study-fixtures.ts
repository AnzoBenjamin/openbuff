import {
  createJsonDocument,
  createTextDocument,
} from '../src/utils/output-document'

export const studyDocuments = {
  log: createTextDocument({
    id: 'study-log',
    title: 'Captured validation log',
    kind: 'log',
    text: Array.from({ length: 10_000 }, (_, index) =>
      index === 9799
        ? 'FAILURE E_PARSE_17: parser rejected the trailing delimiter in src/parser.ts'
        : index === 9849
          ? 'FAILURE E_READER_04: reader expected an additional source row'
          : `validation step ${index + 1}: captured output`,
    ).join('\n'),
    provenance: {
      source: 'capture',
      identity: 'study-fixture/v1/log',
      freshness: 'captured',
      exact: true,
    },
  }),
  changes: createTextDocument({
    id: 'study-changes',
    title: 'Captured changes',
    kind: 'diff',
    text: ['parser.ts', 'reader.ts', 'app.tsx']
      .map(
        (file) =>
          `diff --git a/src/${file} b/src/${file}\n--- a/src/${file}\n+++ b/src/${file}\n` +
          Array.from(
            { length: 4 },
            (_, index) =>
              `@@ -${index * 20 + 1},3 +${index * 20 + 1},3 @@\n context\n-before_${index}\n+after_${index}`,
          ).join('\n'),
      )
      .join('\n'),
    provenance: {
      source: 'capture',
      identity: 'study-fixture/v1/changes',
      freshness: 'captured',
      exact: true,
    },
  }),
  search: createJsonDocument(
    'study-search',
    '300 captured search matches',
    Array.from({ length: 300 }, (_, index) => ({
      path: `src/file${index + 1}.ts`,
      line: index + 10,
      evidence: `captured match ${index + 1}`,
    })),
  ),
}
