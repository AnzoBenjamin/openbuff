import * as fs from 'fs'
import * as path from 'path'
import { createRequire } from 'module'
import { describe, it, expect, mock } from 'bun:test'

import {
  languageTable,
  WASM_FILES,
  SUPPORTED_CODE_EXTENSIONS,
  setWasmDir,
  getWasmDir,
  findLanguageConfigByExtension,
  getLanguageConfig,
  createLanguageConfig,
  type LanguageConfig,
  type RuntimeLanguageLoader,
} from '../src/languages'
import { getDirnameDynamically } from '../src/utils'

const nodeRequire = createRequire(import.meta.url)

describe('languages module', () => {
  describe('languageTable', () => {
    it('should contain all expected language configurations', () => {
      expect(languageTable).toBeDefined()
      expect(Array.isArray(languageTable)).toBe(true)
      expect(languageTable.length).toBe(15) // Current number of supported languages
    })

    it('should have proper structure for each language config', () => {
      languageTable.forEach((config) => {
        expect(config).toHaveProperty('extensions')
        expect(config).toHaveProperty('wasmFile')
        expect(config).toHaveProperty('queryPathOrContent')
        expect(Array.isArray(config.extensions)).toBe(true)
        expect(config.extensions.length).toBeGreaterThan(0)
        expect(typeof config.wasmFile).toBe('string')
        expect(typeof config.queryPathOrContent).toBe('string')
      })
    })

    it('should support TypeScript files', () => {
      const tsConfig = languageTable.find((c) => c.extensions.includes('.ts'))
      expect(tsConfig).toBeDefined()
      expect(tsConfig?.wasmFile).toBe('tree-sitter-typescript.wasm')
      expect(tsConfig?.queryPathOrContent).toBeDefined()
    })

    it('should support TSX files', () => {
      const tsxConfig = languageTable.find((c) => c.extensions.includes('.tsx'))
      expect(tsxConfig).toBeDefined()
      expect(tsxConfig?.wasmFile).toBe('tree-sitter-tsx.wasm')
    })

    it('should support JavaScript files', () => {
      const jsConfig = languageTable.find((c) => c.extensions.includes('.js'))
      expect(jsConfig).toBeDefined()
      expect(jsConfig?.wasmFile).toBe('tree-sitter-javascript.wasm')
      expect(jsConfig?.extensions).toEqual(
        expect.arrayContaining(['.jsx', '.mjs', '.cjs']),
      )
    })

    it('should support Python files', () => {
      const pyConfig = languageTable.find((c) => c.extensions.includes('.py'))
      expect(pyConfig).toBeDefined()
      expect(pyConfig?.wasmFile).toBe('tree-sitter-python.wasm')
    })

    it('should support all documented languages', () => {
      const expectedLanguages = [
        { ext: '.ts', wasm: 'tree-sitter-typescript.wasm' },
        { ext: '.tsx', wasm: 'tree-sitter-tsx.wasm' },
        { ext: '.js', wasm: 'tree-sitter-javascript.wasm' },
        { ext: '.jsx', wasm: 'tree-sitter-javascript.wasm' },
        { ext: '.py', wasm: 'tree-sitter-python.wasm' },
        { ext: '.java', wasm: 'tree-sitter-java.wasm' },
        { ext: '.cs', wasm: 'tree-sitter-c-sharp.wasm' },
        { ext: '.cpp', wasm: 'tree-sitter-cpp.wasm' },
        { ext: '.hpp', wasm: 'tree-sitter-cpp.wasm' },
        { ext: '.rs', wasm: 'tree-sitter-rust.wasm' },
        { ext: '.rb', wasm: 'tree-sitter-ruby.wasm' },
        { ext: '.go', wasm: 'tree-sitter-go.wasm' },
        { ext: '.php', wasm: 'tree-sitter-php.wasm' },
        { ext: '.swift', wasm: 'tree-sitter-swift.wasm' },
        { ext: '.kt', wasm: 'tree-sitter-kotlin.wasm' },
        { ext: '.kts', wasm: 'tree-sitter-kotlin.wasm' },
        { ext: '.gd', wasm: 'tree-sitter-gdscript.wasm' },
      ]

      expectedLanguages.forEach(({ ext, wasm }) => {
        const config = languageTable.find((c) => c.extensions.includes(ext))
        expect(config).toBeDefined()
        expect(config?.wasmFile).toBe(wasm)
      })
    })
  })

  describe('WASM_FILES', () => {
    it('should contain all required WASM files', () => {
      const expectedFiles = [
        'tree-sitter-c-sharp.wasm',
        'tree-sitter-cpp.wasm',
        'tree-sitter-go.wasm',
        'tree-sitter-java.wasm',
        'tree-sitter-javascript.wasm',
        'tree-sitter-python.wasm',
        'tree-sitter-ruby.wasm',
        'tree-sitter-rust.wasm',
        'tree-sitter-tsx.wasm',
        'tree-sitter-typescript.wasm',
        'tree-sitter-kotlin.wasm',
        'tree-sitter-php.wasm',
        'tree-sitter-swift.wasm',
        'tree-sitter-gdscript.wasm',
      ] as const

      expectedFiles.forEach((file) => {
        expect(WASM_FILES[file as keyof typeof WASM_FILES]).toBe(file)
      })
    })

    it('should have consistent keys and values', () => {
      Object.entries(WASM_FILES).forEach(([key, value]) => {
        expect(key).toBe(value)
      })
    })

    it('should keep every language entry paired with a query and declared wasm file', () => {
      for (const config of languageTable) {
        expect(Object.values(WASM_FILES)).toContain(config.wasmFile)
        // queryPathOrContent now carries the bare .scm file name (resolved
        // to an absolute path and read from disk at query-load time).
        expect(config.queryPathOrContent.endsWith('.scm')).toBe(true)
        const queryPath = path.join(
          __dirname,
          '..',
          'src',
          'tree-sitter-queries',
          config.queryPathOrContent,
        )
        expect(fs.existsSync(queryPath)).toBe(true)
        expect(
          fs.readFileSync(queryPath, 'utf8').trim().length,
        ).toBeGreaterThan(0)
      }
    })
  })

  describe('WASM directory management', () => {
    it('should set and get custom WASM directory', () => {
      const testDir = '/custom/wasm/path'
      setWasmDir(testDir)
      // P8.7 (restored public contract): the directory is stored verbatim;
      // relative values resolve against the process cwd at grammar-load time.
      expect(getWasmDir()).toBe(testDir)

      // Reset for other tests
      setWasmDir('')
    })

    it('should return undefined when no custom directory is set', () => {
      setWasmDir('')
      expect(getWasmDir()).toBeUndefined()
    })

    it('should store relative and traversal-containing directories verbatim', () => {
      const validDir = '/custom/wasm/path'
      setWasmDir(validDir)
      expect(getWasmDir()).toBe(validDir)

      // P8.7 (restored public contract): every caller-supplied value is kept
      // verbatim — silently dropping it back to the default location with no
      // error would be a breaking API change. Strict validation applies only
      // to the untrusted CODEBUFF_WASM_DIR env override.
      setWasmDir('relative/wasm/path')
      expect(getWasmDir()).toBe('relative/wasm/path')

      setWasmDir('/custom/../..//etc/wasm')
      expect(getWasmDir()).toBe('/custom/../..//etc/wasm')

      // Reset for other tests
      setWasmDir('')
    })

    it('should allow changing WASM directory multiple times', () => {
      setWasmDir('/first/path')
      expect(getWasmDir()).toBe('/first/path')

      setWasmDir('/second/path')
      expect(getWasmDir()).toBe('/second/path')

      // Reset for other tests
      setWasmDir('')
    })
  })

  describe('findLanguageConfigByExtension', () => {
    it('should find config for TypeScript files', () => {
      const config = findLanguageConfigByExtension('test.ts')
      expect(config).toBeDefined()
      expect(config?.extensions).toContain('.ts')
      expect(config?.wasmFile).toBe('tree-sitter-typescript.wasm')
    })

    it('should find config for JavaScript files', () => {
      const config = findLanguageConfigByExtension('test.js')
      expect(config).toBeDefined()
      expect(config?.extensions).toContain('.js')
      expect(config?.wasmFile).toBe('tree-sitter-javascript.wasm')
    })

    it('should find config for Python files', () => {
      const config = findLanguageConfigByExtension('test.py')
      expect(config).toBeDefined()
      expect(config?.extensions).toContain('.py')
      expect(config?.wasmFile).toBe('tree-sitter-python.wasm')
    })

    it('should route C sources and headers to the dedicated C grammar', () => {
      const cConfig = findLanguageConfigByExtension('fixture.c')
      expect(cConfig).toBeDefined()
      expect(cConfig?.extensions).toContain('.c')
      expect(cConfig?.wasmFile).toBe('tree-sitter-c.wasm')

      const hConfig = findLanguageConfigByExtension('fixture.h')
      expect(hConfig).toBeDefined()
      expect(hConfig?.extensions).toContain('.h')
      expect(hConfig?.wasmFile).toBe('tree-sitter-c.wasm')

      // The C row and C++ row must expose the same query/wasm pairing.
      expect(cConfig?.queryPathOrContent).toBe(hConfig?.queryPathOrContent)
    })

    it('should keep C++ sources and headers on the C++ grammar', () => {
      const cppConfig = findLanguageConfigByExtension('fixture.cpp')
      expect(cppConfig).toBeDefined()
      expect(cppConfig?.extensions).toContain('.cpp')
      expect(cppConfig?.wasmFile).toBe('tree-sitter-cpp.wasm')

      const ccConfig = findLanguageConfigByExtension('fixture.cc')
      expect(ccConfig).toBeDefined()
      expect(ccConfig?.extensions).toContain('.cc')
      expect(ccConfig?.wasmFile).toBe('tree-sitter-cpp.wasm')
    })

    it('should return undefined for unsupported extensions', () => {
      const config = findLanguageConfigByExtension('test.unknown')
      expect(config).toBeUndefined()
    })

    it('should handle files without extensions', () => {
      const config = findLanguageConfigByExtension('Makefile')
      expect(config).toBeUndefined()
    })

    it('should handle nested file paths', () => {
      const config = findLanguageConfigByExtension('src/components/Button.tsx')
      expect(config).toBeDefined()
      expect(config?.extensions).toContain('.tsx')
    })

    it('should handle files with multiple dots', () => {
      const config = findLanguageConfigByExtension('test.spec.ts')
      expect(config).toBeDefined()
      expect(config?.extensions).toContain('.ts')
    })

    it('should normalize extension casing', () => {
      const config = findLanguageConfigByExtension('test.TS')
      expect(config).toBeDefined()
      expect(config?.extensions).toContain('.ts')
    })

    it('should expose a frozen canonical supported code extension list', () => {
      expect(SUPPORTED_CODE_EXTENSIONS).toEqual(
        languageTable.flatMap((config) => config.extensions),
      )
      expect(SUPPORTED_CODE_EXTENSIONS).toEqual(
        expect.arrayContaining([
          '.ts',
          '.mts',
          '.cts',
          '.tsx',
          '.js',
          '.mjs',
          '.php',
          '.swift',
          '.pyi',
          '.c',
          '.h',
          '.kt',
          '.kts',
          '.gd',
        ]),
      )
      expect(Object.isFrozen(SUPPORTED_CODE_EXTENSIONS)).toBe(true)
    })
  })

  describe('createLanguageConfig', () => {
    it('should return undefined for unsupported file extensions', async () => {
      const mockLoader: RuntimeLanguageLoader = {
        initParser: mock(async () => {}),
        loadLanguage: mock(async () => ({})),
      }

      const result = await createLanguageConfig('test.unknown', mockLoader)
      expect(result).toBeUndefined()
      expect(mockLoader.initParser).not.toHaveBeenCalled()
      expect(mockLoader.loadLanguage).not.toHaveBeenCalled()
    })

    it('should have proper function signature for createLanguageConfig', () => {
      // Just verify that the function exists and has the right signature
      expect(typeof createLanguageConfig).toBe('function')
      expect(createLanguageConfig.length).toBe(2) // filePath and runtimeLoader parameters
    })
  })

  describe('LanguageConfig interface', () => {
    it('should have proper type structure', () => {
      const config: LanguageConfig = {
        extensions: ['.test'],
        wasmFile: 'test.wasm',
        queryPathOrContent: 'test query',
      }

      expect(config.extensions).toEqual(['.test'])
      expect(config.wasmFile).toBe('test.wasm')
      expect(config.queryPathOrContent).toBe('test query')
      expect(config.parser).toBeUndefined()
      expect(config.query).toBeUndefined()
      expect(config.language).toBeUndefined()
    })
  })

  describe('RuntimeLanguageLoader interface', () => {
    it('should enforce proper interface implementation', () => {
      const loader: RuntimeLanguageLoader = {
        initParser: async () => {},
        loadLanguage: async (wasmFile: string) => ({}),
      }

      expect(typeof loader.initParser).toBe('function')
      expect(typeof loader.loadLanguage).toBe('function')
    })
  })

  describe('GDScript (.gd) language config', () => {
    it('should find config for GDScript files via extension lookup', () => {
      const cfg = findLanguageConfigByExtension('player.gd')
      expect(cfg).toBeDefined()
      expect(cfg?.extensions).toContain('.gd')
      expect(cfg?.wasmFile).toBe('tree-sitter-gdscript.wasm')
      expect(typeof cfg?.queryPathOrContent).toBe('string')
      expect(cfg?.queryPathOrContent.length).toBeGreaterThan(0)
    })

    it('should register the GDScript wasm in the manifest', () => {
      expect(WASM_FILES['tree-sitter-gdscript.wasm']).toBe(
        'tree-sitter-gdscript.wasm',
      )
      expect(
        languageTable.some((c) => c.wasmFile === 'tree-sitter-gdscript.wasm'),
      ).toBe(true)
    })

    it('should include .gd in SUPPORTED_CODE_EXTENSIONS', () => {
      expect(SUPPORTED_CODE_EXTENSIONS).toContain('.gd')
    })

    it('getLanguageConfig(.gd) does not throw when the wasm is absent', async () => {
      const cfg = await getLanguageConfig('player.gd')
      expect(
        cfg === undefined || cfg?.wasmFile === 'tree-sitter-gdscript.wasm',
      ).toBe(true)
    }, 15_000)

    it('should find config via case-insensitive .GD extension', () => {
      const cfg = findLanguageConfigByExtension('PlayerController.GD')
      expect(cfg).toBeDefined()
      expect(cfg?.extensions).toContain('.gd')
      expect(cfg?.wasmFile).toBe('tree-sitter-gdscript.wasm')
    })

    it('should find config for nested .gd paths', () => {
      const cfg = findLanguageConfigByExtension(
        'scripts/player/PlayerController.gd',
      )
      expect(cfg).toBeDefined()
      expect(cfg?.extensions).toContain('.gd')
      expect(cfg?.wasmFile).toBe('tree-sitter-gdscript.wasm')
    })

    it('should return undefined for non-.gd files with similar names', () => {
      // Files that look like GDScript but aren't
      const cfg = findLanguageConfigByExtension('gdscript.txt')
      expect(cfg).toBeUndefined()
    })

    it('should have a tag query containing GDScript-specific AST patterns', () => {
      const cfg = findLanguageConfigByExtension('player.gd')
      expect(cfg).toBeDefined()
      expect(typeof cfg?.queryPathOrContent).toBe('string')
      expect(cfg?.queryPathOrContent.trim().length).toBeGreaterThan(0)
      // In Bun, .scm imports may resolve to a file path rather than content.
      // Read the actual .scm file to verify the query patterns.
      let query = cfg?.queryPathOrContent ?? ''
      if (
        query.includes('tree-sitter-gdscript-tags.scm') &&
        !query.includes('function_definition')
      ) {
        query = fs.readFileSync(
          path.join(
            __dirname,
            '..',
            'src',
            'tree-sitter-queries',
            'tree-sitter-gdscript-tags.scm',
          ),
          'utf8',
        )
      }
      // These patterns match the tree-sitter-gdscript grammar node types
      expect(query).toContain('function_definition')
      expect(query).toContain('class_definition')
      expect(query).toContain('variable_statement')
      expect(query).toContain('const_statement')
      expect(query).toContain('call')
      // The query must NOT capture the entire constructor body (reviewer fix)
      expect(query).not.toContain('constructor_definition')
    })

    it('should pair the GDScript table entry with the correct query import', () => {
      // Every languageTable entry must reference its query non-empty string
      const gdEntry = languageTable.find((c) => c.extensions.includes('.gd'))
      expect(gdEntry).toBeDefined()
      expect(typeof gdEntry?.queryPathOrContent).toBe('string')
      expect(gdEntry?.queryPathOrContent.trim().length).toBeGreaterThan(0)
      // The wasmFile must match the manifest entry
      expect(WASM_FILES[gdEntry!.wasmFile]).toBe(gdEntry!.wasmFile)
    })

    it('createLanguageConfig delegates the runtime loader for .gd files', async () => {
      // Reset the cached parser on the GDScript entry so the mock loader
      // is actually exercised (languageTable entries are shared singletons).
      const gdEntry = languageTable.find((c) => c.extensions.includes('.gd'))!
      gdEntry.parser = undefined
      gdEntry.language = undefined
      gdEntry.query = undefined

      const initParser = mock(async () => {})
      const loadLanguage = mock(async (_wasmFile: string) => {
        throw new Error('WASM not available in test')
      })
      const mockLoader: RuntimeLanguageLoader = {
        initParser,
        loadLanguage,
      }

      // The mock loader throws, so createLanguageConfig should propagate.
      await expect(
        createLanguageConfig('player.gd', mockLoader),
      ).rejects.toThrow('WASM not available in test')

      // The loader's methods were called with GDScript-specific args
      expect(initParser).toHaveBeenCalledTimes(1)
      // loadLanguage receives the wasm filename
      expect(loadLanguage).toHaveBeenCalledWith('tree-sitter-gdscript.wasm')
    }, 15_000)
  })

  describe('query loading works from any cwd (regression pin for a62135c5d)', () => {
    it('getDirnameDynamically resolves to an existing directory', () => {
      const dir = getDirnameDynamically()
      expect(typeof dir).toBe('string')
      expect(fs.existsSync(dir!)).toBe(true)
      expect(fs.statSync(dir!).isDirectory()).toBe(true)
    })

    it('getLanguageConfig(.ts) returns a defined config (undefined is the fail-open symptom of a broken query read)', async () => {
      const cfg = await getLanguageConfig('sample.ts')
      expect(cfg).toBeDefined()
      expect(cfg?.parser).toBeDefined()
    }, 15_000)
  })

  describe('missing tags query keeps the grammar cached (compiled-binary reload-storm pin)', () => {
    it('createLanguageConfig memoizes language+parser even when the .scm query is absent', async () => {
      // Simulate a compiled binary whose release layout omits the tags .scm
      // files: the real typescript.tsx ngx stream of Language.load succeeds
      // (Parser.init already ran in the cwd regression pin above) but the
      // query path points at a nonexistent file. The OLD behavior threw
      // AFTER the load and left cfg.parser unset, so every parsed file
      // re-ran a full Language.load on the same grammar (observed: one
      // grammar wasm opened 853 times in a single boot, ~5GB of instance
      // churn). The new contract: grammar cached first, query fail-open.
      const tsEntry = languageTable.find((c) => c.extensions.includes('.ts'))!
      const original = {
        parser: tsEntry.parser,
        language: tsEntry.language,
        query: tsEntry.query,
        queryPathOrContent: tsEntry.queryPathOrContent,
      }
      tsEntry.parser = undefined
      tsEntry.language = undefined
      tsEntry.query = undefined
      tsEntry.queryPathOrContent = 'definitely-not-on-disk-tags.scm'
      try {
        // parser.setLanguage validates its argument, so the mock must return
        // a REAL Language instance. Prefer the one the real loader cached
        // above (the cwd regression pin runs first); fall back to an explicit
        // load from the monorepo's package-resolvable wasm.
        const realLanguage =
          original.language ??
          (await (await import('web-tree-sitter')).Language.load(
nodeRequire.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm')
          ))
        const loadLanguage = mock(async (_wasmFile: string) => realLanguage)
        const mockLoader: RuntimeLanguageLoader = {
          initParser: mock(async () => {}),
          loadLanguage,
        }

        const cfg = await createLanguageConfig('sample.ts', mockLoader)
        expect(cfg).toBeDefined()
        // Grammar stays cached even though the tags query is unavailable.
        expect(cfg?.parser).toBeDefined()
        expect(cfg?.query).toBeUndefined()
        // Grammar loaded exactly once — no per-file reload.
        expect(loadLanguage).toHaveBeenCalledTimes(1)

        // A second call is a cheap cache hit: no re-load, same config.
        const again = await createLanguageConfig('sample.ts', mockLoader)
        expect(again).toBe(cfg)
        expect(again?.parser).toBeDefined()
        expect(loadLanguage).toHaveBeenCalledTimes(1)
      } finally {
        tsEntry.parser = original.parser
        tsEntry.language = original.language
        tsEntry.query = original.query
        tsEntry.queryPathOrContent = original.queryPathOrContent
      }
    })
  })
})
