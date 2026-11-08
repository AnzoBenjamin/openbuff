import ts from 'typescript'

/** Check the published API without inheriting workspace source aliases. */
export function verifyPublicDeclarations(
  consumerPath: string,
  declarationPath: string,
): void {
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: ['node'],
    esModuleInterop: true,
  }

  // Keep the repository's dependency-checking policy for the consumer. Check
  // our generated declaration separately so missing imports and duplicate
  // bindings cannot hide behind skipLibCheck.
  const consumer = ts.createProgram([consumerPath], {
    ...options,
    skipLibCheck: true,
  })
  const declarations = ts.createProgram([consumerPath], {
    ...options,
    skipLibCheck: false,
  })
  const source = declarations.getSourceFile(declarationPath)
  if (!source) {
    throw new Error(`Public consumer did not resolve ${declarationPath}`)
  }

  const diagnostics = [
    ...ts.getPreEmitDiagnostics(consumer),
    ...declarations.getSyntacticDiagnostics(source),
    ...declarations.getSemanticDiagnostics(source),
  ]
  if (diagnostics.length > 0) {
    throw new Error(
      `Public declaration verification failed:\n${ts.formatDiagnostics(
        diagnostics,
        {
          getCanonicalFileName: (fileName) => fileName,
          getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
          getNewLine: () => '\n',
        },
      )}`,
    )
  }
}
