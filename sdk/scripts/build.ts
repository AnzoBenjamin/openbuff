// Build script for @openbuff/sdk using Bun's bundler with dual package support
// Creates ESM + CJS bundles with TypeScript declarations

import { mkdir, cp, readFile, writeFile, rm } from 'fs/promises'
import { createHash } from 'crypto'
import { spawnSync } from 'child_process'
import Module from 'module'
import { delimiter, join, resolve } from 'path'

import { generateDtsBundle } from 'dts-bundle-generator'
import { resolveGrammarWasmSource } from '../../packages/code-map/src/grammar-wasm-repair'
import { LANGUAGE_WASM_FILES } from '../../packages/code-map/src/wasm-files'
import { normalizeEntryReexports, repairCjsExportGetters, repairEsmExportRenames } from './esm-export-fixup'
import { verifyPublicDeclarations } from './verify-public-declarations'

const workspaceNodeModules = join(import.meta.dir, '..', 'node_modules')
const existingNodePath = process.env.NODE_PATH ?? ''
const nodePathEntries = existingNodePath
  ? new Set(existingNodePath.split(delimiter))
  : new Set<string>()

if (!nodePathEntries.has(workspaceNodeModules)) {
  nodePathEntries.add(workspaceNodeModules)
  process.env.NODE_PATH = Array.from(nodePathEntries).join(delimiter)
  const moduleWithInit = Module as unknown as { _initPaths?: () => void }
  moduleWithInit._initPaths?.()
}

async function build() {
  console.log('🧹 Cleaning dist directory...')
  await rm('dist', { recursive: true, force: true })

  await mkdir('./dist', { recursive: true })

  // Read external dependencies from package.json
  const pkgText = await Bun.file('./package.json').text()
  const pkg = JSON.parse(pkgText)
  const external = [
    // Only exclude actual npm dependencies, not workspace packages
    ...Object.keys(pkg.dependencies || {}).filter(
      (dep) => !dep.startsWith('@codebuff/'),
    ),
    // Add Node.js built-ins
    'fs',
    'path',
    'child_process',
    'os',
    'crypto',
    'stream',
    'util',
    'ws',
    'bufferutil',
    'utf-8-validate',
    'http',
    'https',
    'net',
    'tls',
    'url',
    'events',
  ]

  // Keep named reexports as local live bindings before Bun's tree shaking.
  // A post-build alias fix cannot recover a function removed with its module.
  const sdkEntry = resolve('src/index.ts')
  const publicReexports: import('bun').BunPlugin = {
    name: 'sdk-public-reexports',
    setup(builder) {
      builder.onLoad({ filter: /[/\\]src[/\\]index\.ts$/ }, async (args) => {
        if (args.path !== sdkEntry) return undefined
        return { contents: normalizeEntryReexports(await readFile(args.path, 'utf8')), loader: 'ts' }
      })
    },
  }

  console.log('📦 Building ESM format...')
  await Bun.build({
    entrypoints: ['src/index.ts'],
    outdir: 'dist',
    target: 'node',
    format: 'esm',
    minify: false,
    sourcemap: 'linked',
    // lodash is CommonJS and Node cannot reliably import its named exports
    // from an ESM bundle. Bundle it in the ESM artifact so the SDK's named
    // lodash imports work in Node; the CJS artifact keeps it external.
    external: external.filter((dependency) => dependency !== 'lodash'),
    naming: '[dir]/index.mjs',
    // Disable env inlining so the published bundle uses runtime `process.env.X`
    // lookups with source-code defaults, not build-time values that could leak
    // local dev config (e.g. support email) into the npm package.
    env: 'disable',
    loader: {
      '.scm': 'text',
    },
    plugins: [publicReexports],
  })

  console.log('📦 Building CJS format...')
  await Bun.build({
    entrypoints: ['src/index.ts'],
    outdir: 'dist',
    target: 'node',
    format: 'cjs',
    minify: false,
    sourcemap: 'linked',
    external,
    naming: '[dir]/index.cjs',
    define: {
      'import.meta.url': 'undefined',
      'import.meta': 'undefined',
    },
    // Disable env inlining so the published bundle uses runtime `process.env.X`
    // lookups with source-code defaults, not build-time values that could leak
    // local dev config (e.g. support email) into the npm package.
    env: 'disable',
    loader: {
      '.scm': 'text',
    },
    plugins: [publicReexports],
  })

  console.log('📝 Generating and bundling TypeScript declarations...')
  try {
    const [bundle] = generateDtsBundle(
      [
        {
          filePath: 'src/index.ts',
          // The generator imports third-party types by default, including MCP
          // and Zod. An importedLibraries allowlist drops every unlisted import
          // while retaining its type references in the public declaration.
          libraries: {
            // Inline the private type helper so Node consumers do not need Bun.
            inlinedLibraries: ['bun-types'],
          },
          output: {
            exportReferencedTypes: false,
          },
        },
      ],
      {
        preferredConfigPath: join(import.meta.dir, '..', 'tsconfig.build.json'),
      },
    )

    await writeFile('dist/index.d.ts', bundle)
    await fixDuplicateImports()
    verifyPublicDeclarations(
      join(import.meta.dir, 'fixtures/custom-tool-consumer.ts'),
      resolve('dist/index.d.ts'),
    )
    console.log('  ✓ Verified public consumer and SDK declaration')
    console.log('  ✓ Created bundled type definitions')
  } catch (error) {
    console.error(
      '❌ TypeScript declaration bundling failed:',
      error instanceof Error ? error.message : String(error),
    )
    process.exit(1)
  }

  console.log('📂 Copying WASM files for tree-sitter...')
  await copyWasmFiles()

  console.log('📂 Copying vendored ripgrep binaries...')
  await copyRipgrepVendor()

  // Work around Bun bundler tree-shaking: the `ToolHelpers` aggregation object
  // (from `sdk/src/tools/index.ts`) is only re-exported, never used internally,
  // so the bundler can strip its definition. The
  // individual tool functions ARE bundled (they're used by `sdk/src/run.ts`).
  // This step reconstructs `ToolHelpers` from those already-bundled functions
  // and adds it to the export block.
  await fixToolHelpers()

  // Work around Bun CJS bundler bug: some `export { X } from './module'`
  // statements produce export getters referencing `import_X.Y` but drop the
  // `var import_X = ...` declaration, causing "import_X is not defined" at
  // runtime. This patches the CJS bundle to replace those broken references.
  await fixCjsImportVars()

  // Work around Bun ESM bundler bug: some re-exports produce dedup renames
  // like `X2 as X` where `X2` is not defined as a variable in the bundle,
  // causing "Export 'X2' is not defined in module" at runtime. This patches
  // the ESM bundle to replace broken `X2 as X` with just `X`.
  await fixEsmExportRenames()

  // The repair steps above must not turn missing public exports into a
  // successful build. Exercise both published entry points in Node, including
  // symbols that Bun can emit as later bindings in a multi-variable statement.
  const requiredExports = [
    'CodebuffClient',
    'run',
    'createMcpServer',
    'getCustomToolDefinition',
    'supportsStreamDirectory',
    'isMemoryArtifactPersistenceAllowed',
    'ToolHelpers',
  ]
  for (const [format, expression] of [
    ['ESM', "import('./dist/index.mjs')"],
    ['CJS', "Promise.resolve(require('./dist/index.cjs'))"],
  ]) {
    const script = `${expression}.then(m => { const missing = ${JSON.stringify(requiredExports)}.filter(name => m[name] == null); if (missing.length) { console.error('Missing SDK exports: ' + missing.join(', ')); process.exitCode = 1 } }).catch(error => { console.error(error); process.exitCode = 1 })`
    const result = spawnSync('node', ['-e', script], {
      encoding: 'utf8',
      timeout: 30_000,
    })
    if (result.error || result.status !== 0) {
      throw new Error(
        `${format} SDK bundle verification failed: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`,
      )
    }
  }

  console.log('✅ Build complete!')
  console.log('  📄 dist/index.mjs (ESM)')
  console.log('  📄 dist/index.cjs (CJS)')
  console.log('  📄 dist/index.d.ts (Types)')
}

/**
 * Fix duplicate imports in the generated index.d.ts file
 */
async function fixDuplicateImports() {
  try {
    let content = await readFile('dist/index.d.ts', 'utf-8')

    // Remove any duplicate zod default imports (handle various whitespace)
    const zodDefaultImportRegex = /import\s+z\s+from\s+['"]zod\/v4['"];?\n?/g
    const zodNamedImportRegex =
      /import\s+\{\s*z\s*\}\s+from\s+['"]zod\/v4['"];?/

    // If we have both imports, remove all default imports and keep only the named one
    if (
      content.match(zodNamedImportRegex) &&
      content.match(zodDefaultImportRegex)
    ) {
      content = content.replace(zodDefaultImportRegex, '')
    }

    // Node's legacy and node: specifiers name the same declarations. Merge
    // their named imports so the generated file defines each binding once.
    const childProcessImports =
      /import\s+\{([^}]+)\}\s+from\s+(['"])(?:node:)?child_process\2;?/g
    const imports = [...content.matchAll(childProcessImports)]
    if (imports.length > 1) {
      const names = [
        ...new Set(
          imports.flatMap((match) =>
            match[1]
              .split(',')
              .map((name) => name.trim())
              .filter(Boolean),
          ),
        ),
      ]
      let first = true
      content = content.replace(childProcessImports, () => {
        if (!first) return ''
        first = false
        return `import { ${names.join(', ')} } from 'node:child_process';`
      })
    }

    await writeFile('dist/index.d.ts', content)
    console.log('  ✓ Fixed duplicate imports in bundled types')
  } catch (error) {
    console.warn(
      '  ⚠ Warning: Could not fix duplicate imports:',
      error instanceof Error ? error.message : String(error),
    )
  }
}

/**
 * Work around Bun CJS bundler bug: `export { X } from './module'` can produce
 * export getters referencing `import_module.X` but drop the `var import_module
 * = ...` declaration, causing "import_module is not defined" at runtime.
 *
 * This post-build fixup scans the CJS bundle for export getters that reference
 * undeclared `import_*` variables and replaces them with direct symbol
 * references (function names, constants, or the module's internal `exports_*`
 * object).
 */
async function fixCjsImportVars() {
  const cjsPath = 'dist/index.cjs'
  const result = repairCjsExportGetters(await readFile(cjsPath, 'utf8'))
  await writeFile(cjsPath, result.content)
  console.log(`  ✓ CJS import vars fixup: replaced ${result.fixCount} broken export getters`)
}

/** Repair declared dedup aliases; unresolved exports fail instead of disappearing. */
async function fixEsmExportRenames() {
  const esmPath = 'dist/index.mjs'
  const { content, fixCount } = repairEsmExportRenames(await readFile(esmPath, 'utf8'))
  await writeFile(esmPath, content)
  console.log(`  ✓ ESM export renames fixup: replaced ${fixCount} dedup renames`)
}

/**
 * Work around Bun bundler tree-shaking of the `ToolHelpers` aggregation object.
 *
 * `ToolHelpers` is defined in `sdk/src/tools/index.ts` as an object literal
 * aggregating individual tool functions. It is only re-exported from the SDK
 * entry point, never used internally, so the
 * bundler strips its definition entirely. The individual tool functions ARE
 * bundled (they're used by `sdk/src/run.ts`), so we reconstruct `ToolHelpers`
 * from those already-bundled functions and add it to the export block.
 */
async function fixToolHelpers() {
  const toolHelpersDef =
    'var ToolHelpers = { runTerminalCommand, codeSearch, findFilesMatchingContent, glob, listDirectory, getFilesStructured, replaceRange, runFileChangeHooks, changeFile, changeFiles, readImages, inspect3dAsset, render3dPreview, edit3dAsset, writeAuditFindings, listJobs };'

  // --- ESM bundle ---
  const esmPath = 'dist/index.mjs'
  let esmContent = await readFile(esmPath, 'utf-8')

  // Only inject if ToolHelpers is not already defined as a variable.
  if (!/^var\s+ToolHelpers\b/m.test(esmContent)) {
    // Insert the ToolHelpers definition right before the final export block.
    const lastExportIdx = esmContent.lastIndexOf('\nexport {')
    if (lastExportIdx !== -1) {
      const insertPos = lastExportIdx + 1 // start after the newline
      esmContent =
        esmContent.slice(0, insertPos) +
        toolHelpersDef +
        '\n' +
        esmContent.slice(insertPos)

      // Add `ToolHelpers` to the export block if it's not already there.
      // Find the closing `}` of the export block by counting braces.
      const exportStart = esmContent.indexOf(
        '{',
        insertPos + toolHelpersDef.length,
      )
      if (exportStart !== -1) {
        let depth = 0
        let exportEnd = -1
        for (let i = exportStart; i < esmContent.length; i++) {
          if (esmContent[i] === '{') depth++
          else if (esmContent[i] === '}') {
            depth--
            if (depth === 0) {
              exportEnd = i
              break
            }
          }
        }
        if (exportEnd !== -1) {
          const exportBlockContent = esmContent.slice(exportStart, exportEnd)
          if (!/\bToolHelpers\b/.test(exportBlockContent)) {
            esmContent =
              esmContent.slice(0, exportEnd) +
              '  ToolHelpers,\n' +
              esmContent.slice(exportEnd)
          }
        }
      }
    }
    await writeFile(esmPath, esmContent)
  }

  // --- CJS bundle ---
  const cjsPath = 'dist/index.cjs'
  let cjsContent = await readFile(cjsPath, 'utf-8')

  // Only inject if ToolHelpers is not already defined as a variable.
  if (!/^var\s+ToolHelpers\b/m.test(cjsContent)) {
    // Insert the ToolHelpers definition on its own line before the first
    // `__esm` wrapper. Ensure we start at a line boundary to avoid
    // concatenating with partial tokens on the previous line.
    let insertIdx = cjsContent.indexOf('__esm')
    if (insertIdx === -1) {
      // Fallback: insert before the broken getter reference.
      insertIdx = cjsContent.indexOf('ToolHelpers: () => import_tools.')
    }
    if (insertIdx !== -1) {
      // Walk back to the start of the line to avoid mid-line insertion.
      while (insertIdx > 0 && cjsContent[insertIdx - 1] !== '\n') {
        insertIdx--
      }
      cjsContent =
        cjsContent.slice(0, insertIdx) +
        toolHelpersDef +
        '\n' +
        cjsContent.slice(insertIdx)

      // Fix the broken getter: replace `import_tools.ToolHelpers` (or any
      // `import_X.ToolHelpers` reference) with just `ToolHelpers`.
      cjsContent = cjsContent.replace(
        /ToolHelpers:\s*\(\)\s*=>\s*import_\w+\.ToolHelpers/g,
        'ToolHelpers: () => ToolHelpers',
      )
    }
    await writeFile(cjsPath, cjsContent)
  }

  console.log('  ✓ ToolHelpers reconstruction: injected aggregation object')
}

/**
 * Copy every advertised language grammar to the shared dist/wasm directory.
 */
async function copyWasmFiles() {
  const wasmFiles = ['tree-sitter.wasm', ...LANGUAGE_WASM_FILES]
  const wasmDir = resolve('dist/wasm')

  // Create shared wasm directory
  await mkdir(wasmDir, { recursive: true })

  const manifest: Record<string, string> = {}
  for (const wasmFile of wasmFiles) {
    const sourceName =
      wasmFile === 'tree-sitter-c-sharp.wasm'
        ? 'tree-sitter-c_sharp.wasm'
        : wasmFile
    const candidates =
      wasmFile === 'tree-sitter.wasm'
        ? [`../node_modules/web-tree-sitter/${wasmFile}`]
        : [
            `../node_modules/tree-sitter-wasms/out/${sourceName}`,
            `../node_modules/@vscode/tree-sitter-wasm/wasm/${wasmFile}`,
            // Reuse a previously built local grammar only after the shared
            // resolver verifies it against the same immutable SHA-256 pin.
            `../cli/bin/${wasmFile}`,
          ]
    const source =
      wasmFile === 'tree-sitter.wasm'
        ? candidates.find((candidate) => Bun.file(candidate).size > 0)
        : await resolveGrammarWasmSource({
            wasmFile,
            candidates,
            repairDir: wasmDir,
          })
    if (!source)
      throw new Error(
        `Missing required tree-sitter asset ${wasmFile}; searched ${candidates.join(', ')}`,
      )
    const bytes = await readFile(source)
    const target = join(wasmDir, wasmFile)
    if (resolve(source) !== target) await cp(source, target)
    manifest[wasmFile] = createHash('sha256').update(bytes).digest('hex')
    console.log(`  ✓ Copied ${wasmFile}`)
  }
  await writeFile(
    join(wasmDir, 'tree-sitter-manifest.json'),
    `${JSON.stringify({ schemaVersion: 1, files: manifest }, null, 2)}\n`,
  )
}

async function copyRipgrepVendor() {
  const vendorSrc = 'vendor/ripgrep'
  const vendorDest = 'dist/vendor/ripgrep'
  try {
    await mkdir(vendorDest, { recursive: true })
    await cp(vendorSrc, vendorDest, { recursive: true })
    console.log('  ✓ Copied vendored ripgrep binaries')
  } catch (e) {
    console.warn(
      '  ⚠ No vendored ripgrep found; skipping (use fetch-ripgrep.ts first)',
    )
  }
}

if (import.meta.main) {
  build().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
