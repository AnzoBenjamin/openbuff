import { describe, expect, test } from 'bun:test'

import { repairEsmExportRenames } from '../../scripts/esm-export-fixup'

describe('SDK ESM export fixup', () => {
  test('repairs and removes individual entries sharing an export line', () => {
    const source =
      'const original = 1;\nconst present = 2;\nexport {\n  original2 as original, present, missing,\n};\n'
    const result = repairEsmExportRenames(source)
    expect(result.fixCount).toBe(1)
    expect(result.removalCount).toBe(1)
    expect(result.content).toContain('export {\n  original,\n  present,\n};')
    expect(() =>
      new Bun.Transpiler({ loader: 'js' }).transformSync(result.content),
    ).not.toThrow()
  })
  test('rewrites only the final export block, leaving strings and comments intact', () => {
    const source = [
      'const hint = "export{";',
      'const example = "original2 as original";',
      'const original = 1;',
      'const present = 2;',
      'var first = 1, second = 2;',
      'export {',
      '  original2 as original,',
      '  present,',
      '  second,',
      '  missing,',
      '};',
      '//# sourceMappingURL=index.mjs.map',
      '',
    ].join('\n')
    const result = repairEsmExportRenames(source)
    expect(result.fixCount).toBe(1)
    expect(result.removalCount).toBe(1)
    expect(result.content).toContain('const hint = "export{";')
    expect(result.content).toContain('const example = "original2 as original";')
    expect(result.content).toContain(
      'export {\n  original,\n  present,\n  second,\n};',
    )
    expect(result.content).toContain('//# sourceMappingURL=index.mjs.map')
    expect(() =>
      new Bun.Transpiler({ loader: 'js' }).transformSync(result.content),
    ).not.toThrow()
  })

  test('leaves bundles without a final export block untouched', () => {
    const source = 'const hint = "export{";\n'
    expect(repairEsmExportRenames(source)).toEqual({
      content: source,
      fixCount: 0,
      removalCount: 0,
    })
  })
})
