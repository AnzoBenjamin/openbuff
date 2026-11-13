import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { normalizeEntryReexports, repairCjsExportGetters, repairEsmExportRenames } from '../../scripts/esm-export-fixup'

describe('SDK ESM export fixup', () => {
  test('repairs dedup aliases without altering strings, comments or export names', () => {
    const source = [
      'const hint = "export{ original2 as original";',
      '// original2 as original',
      'const original = 1;',
      'var first = 1, second = 2;',
      'export {',
      '  original2 as original,',
      '  second,',
      '  original3 as publicAlias,',
      '};',
      '//# sourceMappingURL=index.mjs.map',
      '',
    ].join('\n')
    const result = repairEsmExportRenames(source)
    expect(result.fixCount).toBe(2)
    expect(result.removalCount).toBe(0)
    expect(result.content).toContain('const hint = "export{ original2 as original";')
    expect(result.content).toContain('// original2 as original')
    expect(result.content).toContain('  original as original,\n  second,\n  original as publicAlias,')
    expect(result.content).toContain('//# sourceMappingURL=index.mjs.map')
    expect(() => new Bun.Transpiler({ loader: 'js' }).transformSync(result.content)).not.toThrow()
  })

  test('recognizes multiline bindings, destructuring, imports and generators', () => {
    const source = [
      'import { readFile as imported } from "node:fs";',
      'var first,',
      '  second;',
      'const { nested: { value: renamed }, other = 1 } = { nested: { value: 3 } };',
      'let [item] = [1];',
      'function* generate() { yield item }',
      'class Thing {}',
      'export { second, renamed, other, item, generate, Thing, imported as publicImport };',
    ].join('\n')
    expect(repairEsmExportRenames(source)).toEqual({ content: source, fixCount: 0, removalCount: 0 })
  })

  test('does not delete unresolved public exports or use nested/string declarations', () => {
    for (const source of [
      'const present=1; export { present, missing };',
      'function inner() { const missing=1 } export { missing };',
      'const text=`\nvar missing=1;\n`; export { missing };',
      'const expected=1; export { unrelated as expected };',
    ]) expect(() => repairEsmExportRenames(source)).toThrow('Unresolved ESM exports')
  })

  test('leaves source without local export blocks untouched', () => {
    const source = 'const hint = "export{";\nexport { readFile } from "node:fs";\n'
    expect(repairEsmExportRenames(source)).toEqual({ content: source, fixCount: 0, removalCount: 0 })
  })
})

const cjsHelpers = 'const __export=(target, all)=>{for(const [key,get] of Object.entries(all)) Object.defineProperty(target,key,{get})}; const __toCommonJS=x=>x;'

describe('SDK CJS export getter fixup', () => {
  test('resolves a missing namespace to a declared source alias without altering text', () => {
    const source = [
      cjsHelpers,
      'const hint="createMcpServer: () => import_server2.createMcpServer";',
      'var first, exports_server;',
      'exports_server={};',
      '__export(exports_server,{createMcpServer:()=>actualServer});',
      'const actualServer=()=>42;',
      'var exports_entry={};',
      '__export(exports_entry,{createMcpServer:()=>import_server2.createMcpServer});',
      'module.exports=__toCommonJS(exports_entry);',
    ].join('\n')
    const result = repairCjsExportGetters(source)
    expect(result.fixCount).toBe(1)
    expect(result.content).toContain('const hint="createMcpServer: () => import_server2.createMcpServer";')
    const module = { exports: {} as { createMcpServer(): number } }
    new Function('module', result.content)(module)
    expect(module.exports.createMcpServer()).toBe(42)
  })

  test('retains real import bindings later in multiline declarations and ignores ordinary objects', () => {
    const source = [
      cjsHelpers,
      'var first,',
      ' import_server2={createMcpServer:()=>7};',
      'const unrelated={missing:()=>import_missing.value};',
      'var exports_entry={};',
      '__export(exports_entry,{createMcpServer:()=>import_server2.createMcpServer});',
      'module.exports=__toCommonJS(exports_entry);',
    ].join('\n')
    expect(repairCjsExportGetters(source)).toEqual({ content: source, fixCount: 0 })
  })

  test('refuses missing and ambiguous sources instead of emitting broken getters', () => {
    expect(() => repairCjsExportGetters('var exports_entry={}; __export(exports_entry,{createMcpServer:()=>import_server2.createMcpServer}); module.exports=__toCommonJS(exports_entry);'))
      .toThrow('Unresolved CJS exports')
    expect(() => repairCjsExportGetters([
      'const first=1, second=2; var exports_a={},exports_b={},exports_entry={};',
      '__export(exports_a,{value:()=>first}); __export(exports_b,{value:()=>second});',
      '__export(exports_entry,{value:()=>import_missing.value}); module.exports=__toCommonJS(exports_entry);',
    ].join('\n'))).toThrow('ambiguous')
  })
})

describe('SDK entry reexport normalization', () => {
  test('preserves types, aliased names and collision-free local bindings', () => {
    const source = 'const __sdkReexport0=0;\nexport type { Type } from "./dep";\nexport { original as publicName, type Value } from "./dep";\nexport * from "./other";\n'
    const result = normalizeEntryReexports(source)
    expect(result).toContain('const __sdkReexport0=0;')
    expect(result).toContain('export type { Type } from "./dep";')
    expect(result).toContain('import { original as __sdkReexport1 } from "./dep";')
    expect(result).toContain('export { __sdkReexport1 as publicName };')
    expect(result).toContain('export type { Value } from "./dep";')
    expect(result).toContain('export * from "./other";')
  })

  for (const format of ['esm', 'cjs'] as const) test(`retains unused named reexports and live aliases in a real ${format} fixture bundle`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdk-export-fixup-'))
    try {
      await writeFile(join(root, 'package.json'), JSON.stringify({ sideEffects: false }))
      await writeFile(join(root, 'dep.ts'), [
        'export type Value=string;',
        'export function createMcpServer(){return "server"}',
        'export const supportsStreamDirectory=()=>true;',
        'export const isMemoryArtifactPersistenceAllowed=()=>false;',
        'export let count=0; export function increment(){count++}',
        'export default class Client {}',
      ].join('\n'))
      const source = 'export {createMcpServer, supportsStreamDirectory, isMemoryArtifactPersistenceAllowed, count as liveCount, increment, default as CodebuffClient, type Value} from "./dep";'
      await writeFile(join(root, 'index.ts'), source)
      const built = await Bun.build({ entrypoints: [join(root, 'index.ts')], target: 'node', format,
        plugins: [{ name: 'normalize-fixture-entry', setup(builder) {
          builder.onLoad({ filter: /index\.ts$/ }, () => ({ contents: normalizeEntryReexports(source), loader: 'ts' }))
        } }],
      })
      expect(built.success).toBe(true)
      const output = await built.outputs[0].text()
      const repaired = format === 'esm' ? repairEsmExportRenames(output).content : repairCjsExportGetters(output).content
      let api: Record<string, any>
      if (format === 'esm') {
        const entry = join(root, 'bundle.mjs')
        await writeFile(entry, repaired)
        api = await import(pathToFileURL(entry).href)
      } else {
        const module = { exports: {} }
        new Function('module', 'exports', repaired)(module, module.exports)
        api = module.exports
      }
      expect(Object.keys(api).sort()).toEqual(['CodebuffClient','createMcpServer','increment','isMemoryArtifactPersistenceAllowed','liveCount','supportsStreamDirectory'].sort())
      expect(api.createMcpServer()).toBe('server')
      expect(api.supportsStreamDirectory()).toBe(true)
      expect(api.isMemoryArtifactPersistenceAllowed()).toBe(false)
      expect(api.liveCount).toBe(0)
      api.increment()
      expect(api.liveCount).toBe(1)
      expect(new api.CodebuffClient()).toBeInstanceOf(api.CodebuffClient)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
