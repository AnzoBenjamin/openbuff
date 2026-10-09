import { describe, expect, it } from 'bun:test'

import { detectSyntaxErrorViaTreeSitter } from '@codebuff/code-map'

import {
  preflightValidateSyntax,
  formatPreflightErrorMessage,
  getBunTranspilerLoader,
  isJavaScriptLikePath,
  countDelimitersOutsideStringsAndComments,
} from '../util/preflight-syntax-validation'

describe('preflightValidateSyntax — JS/TS (Bun.Transpiler)', () => {
  it('accepts valid TypeScript', async () => {
    const result = await preflightValidateSyntax(
      'example.ts',
      'const x: number = 42\n',
    )
    expect(result.valid).toBe(true)
  })

  it('accepts valid TSX with JSX', async () => {
    const result = await preflightValidateSyntax(
      'component.tsx',
      'const App = () => <div>Hello</div>\n',
    )
    expect(result.valid).toBe(true)
  })

  it('accepts valid JavaScript', async () => {
    const result = await preflightValidateSyntax(
      'script.js',
      'function foo() { return 1 }\n',
    )
    expect(result.valid).toBe(true)
  })

  it('rejects TypeScript with missing closing brace', async () => {
    const result = await preflightValidateSyntax(
      'broken.ts',
      'function foo() {\n  return 1\n',
    )
    expect(result.valid).toBe(false)
    expect(result.message.length).toBeGreaterThan(0)
  })

  it('rejects TypeScript with unclosed string template', async () => {
    const result = await preflightValidateSyntax(
      'broken.ts',
      'const x = `unclosed template\n',
    )
    expect(result.valid).toBe(false)
  })

  it('rejects TypeScript with syntax error in JSX', async () => {
    const result = await preflightValidateSyntax(
      'broken.tsx',
      'const App = () => <div>{</div>\n',
    )
    expect(result.valid).toBe(false)
  })

  it('accepts valid TypeScript with comments and strings containing braces', async () => {
    const content = [
      '// This { is in a comment }',
      'const x = "string with { braces }"',
      'const y = `template ${1 + 1}`',
      'export { x, y }',
    ].join('\n')
    const result = await preflightValidateSyntax('ok.ts', content)
    expect(result.valid).toBe(true)
  })
})

describe('preflightValidateSyntax — Python', () => {
  it('accepts valid Python', async () => {
    const content = [
      'def foo():',
      '    return 1',
      '',
      'class Bar:',
      '    def method(self):',
      '        pass',
    ].join('\n')
    const result = await preflightValidateSyntax('example.py', content)
    expect(result.valid).toBe(true)
  })

  it('rejects Python with unbalanced parentheses', async () => {
    const content = 'def foo(:\n    return 1\n'
    const result = await preflightValidateSyntax('broken.py', content)
    expect(result.valid).toBe(false)
    expect(result.message).toContain('Unbalanced')
  })

  it('[COR-M10] accepts syntactically valid Python with tab indentation', async () => {
    const content = 'def foo():\n\treturn 1\n'
    const result = await preflightValidateSyntax('tabs.py', content)
    expect(result.valid).toBe(true)
  })

  it('rejects Python indentation increase without colon', async () => {
    const content = 'x = 1\n    y = 2\n'
    const result = await preflightValidateSyntax('indent.py', content)
    expect(result.valid).toBe(false)
    expect(result.message).toContain('indentation')
  })

  it('accepts Python with triple-quoted strings containing colons', async () => {
    const content = [
      'doc = """',
      'This is a docstring with: colons',
      'and fake if: statements',
      '"""',
      'x = 1',
    ].join('\n')
    const result = await preflightValidateSyntax('triple.py', content)
    expect(result.valid).toBe(true)
  })

  it('accepts Python with inline comments', async () => {
    const content = ['x = 1  # this: is a comment', 'y = 2'].join('\n')
    const result = await preflightValidateSyntax('comments.py', content)
    expect(result.valid).toBe(true)
  })

  it('rejects Python block opener without colon', async () => {
    const content = 'if x\n    pass\n'
    const result = await preflightValidateSyntax('nocolon.py', content)
    expect(result.valid).toBe(false)
  })
})

describe('preflightValidateSyntax — Go', () => {
  it('accepts valid Go', async () => {
    const content = [
      'package main',
      '',
      'func main() {',
      '    x := 1',
      '}',
    ].join('\n')
    const result = await preflightValidateSyntax('main.go', content)
    expect(result.valid).toBe(true)
  })

  it('rejects Go without package declaration', async () => {
    const content = 'func main() {\n    x := 1\n}\n'
    const result = await preflightValidateSyntax('nmain.go', content)
    expect(result.valid).toBe(false)
    expect(result.message).toContain('package')
  })

  it('rejects Go with unbalanced braces', async () => {
    const content = 'package main\n\nfunc main() {\n    x := 1\n'
    const result = await preflightValidateSyntax('unbalanced.go', content)
    expect(result.valid).toBe(false)
    expect(result.message).toContain('Unbalanced')
  })

  it('accepts Go with block statements and proper braces', async () => {
    const content = [
      'package main',
      '',
      'func main() {',
      '    if x > 0 {',
      '        y := 1',
      '    } else {',
      '        y := 2',
      '    }',
      '}',
    ].join('\n')
    const result = await preflightValidateSyntax('blocks.go', content)
    expect(result.valid).toBe(true)
  })

  it('accepts Go with line comments', async () => {
    const content = [
      'package main',
      '',
      '// This: is a comment { with braces }',
      'func main() {',
      '    x := 1 // inline comment',
      '}',
    ].join('\n')
    const result = await preflightValidateSyntax('comments.go', content)
    expect(result.valid).toBe(true)
  })
})

describe('preflightValidateSyntax — tree-sitter languages', () => {
  // These 10 languages route through the fail-open tree-sitter parse. Valid
  // content must always pass regardless of grammar availability. Broken content
  // is rejected ONLY when the grammar loaded locally (available === true);
  // otherwise the fail-open contract keeps it valid with a skip message. Each
  // case cross-checks detectSyntaxErrorViaTreeSitter so the assertion is
  // deterministic in whichever environment the test runs.
  const validSamples: Record<string, string> = {
    'sample.c': '#include <stdio.h>\nint main(void) { return 0; }\n',
    'sample.cpp': '#include <vector>\nint main() { std::vector<int> v; return 0; }\n',
    'sample.cs': 'class C { static void Main() { } }\n',
    'sample.java': 'class C { public static void main(String[] a) { } }\n',
    'sample.php': '<?php\nfunction foo() { return 1; }\n',
    'sample.rb': "def foo\n  1\nend\n",
    'sample.rs': 'fn main() {\n    let x = 1;\n}\n',
    'sample.swift': 'func foo() -> Int {\n    return 1\n}\n',
    'sample.kt': 'fun foo(): Int {\n    return 1\n}\n',
    'sample.gd': 'func foo():\n    return 1\n',
  }

  const brokenSamples: Record<string, string> = {
    'broken.c': 'int main(void) { return 0;\n',
    'broken.cpp': 'int main() { std::vector<int> v; return 0;\n',
    'broken.cs': 'class C { static void Main() { }\n',
    'broken.java': 'class C { public static void main(String[] a) {\n',
    'broken.php': '<?php\nfunction foo() { return 1;\n',
    'broken.rb': 'def foo\n  1\n',
    'broken.rs': 'fn main() {\n    let x = 1;\n',
    'broken.swift': 'func foo() -> Int {\n    return 1\n',
    'broken.kt': 'fun foo(): Int {\n    return 1\n',
    'broken.gd': 'func foo(\n    return 1\n',
  }

  for (const [file, content] of Object.entries(validSamples)) {
    it(`accepts valid ${file}`, async () => {
      const result = await preflightValidateSyntax(file, content)
      expect(result.valid).toBe(true)
    })
  }

  for (const [file, content] of Object.entries(brokenSamples)) {
    it(`rejects broken ${file} when grammar is available (fail-open otherwise)`, async () => {
      const detection = await detectSyntaxErrorViaTreeSitter(file, content)
      const result = await preflightValidateSyntax(file, content)
      if (detection.available && detection.hasError) {
        expect(result.valid).toBe(false)
        expect(result.message).toContain(file)
        expect(result.message).toContain('syntax error')
      } else {
        // Fail-open: grammar not locally available or over-tolerant parse.
        expect(result.valid).toBe(true)
      }
    })
  }

  it('does not route JS/TS/Python/Go through tree-sitter (message differs)', async () => {
    const ts = await preflightValidateSyntax('a.ts', 'const x = 1\n')
    expect(ts.valid).toBe(true)
    expect(ts.message).not.toContain('Tree-sitter')
    const py = await preflightValidateSyntax('a.py', 'x = 1\n')
    expect(py.valid).toBe(true)
    expect(py.message).not.toContain('Tree-sitter')
    const go = await preflightValidateSyntax(
      'a.go',
      'package main\n\nfunc main() {}\n',
    )
    expect(go.valid).toBe(true)
    expect(go.message).not.toContain('Tree-sitter')
  })
})

describe('detectSyntaxErrorViaTreeSitter', () => {
  it('reports available:false for unconfigured extensions', async () => {
    const result = await detectSyntaxErrorViaTreeSitter('notes.md', '# Title\n')
    expect(result.available).toBe(false)
    expect(result.hasError).toBe(false)
  })

  it('never throws and returns a well-formed result', async () => {
    const result = await detectSyntaxErrorViaTreeSitter(
      'sample.rs',
      'fn main() {}\n',
    )
    expect(typeof result.available).toBe('boolean')
    expect(typeof result.hasError).toBe('boolean')
  })
})

describe('preflightValidateSyntax — other file types', () => {
  it('returns valid for unknown file types (markdown)', async () => {
    const result = await preflightValidateSyntax('README.md', '# Title\n\nContent')
    expect(result.valid).toBe(true)
  })

  it('returns valid for JSON files', async () => {
    const result = await preflightValidateSyntax('config.json', '{"key": "value"}')
    expect(result.valid).toBe(true)
  })

  it('returns valid for empty content', async () => {
    const result = await preflightValidateSyntax('empty.ts', '')
    expect(result.valid).toBe(true)
  })

  it('returns valid for unknown extension with broken content', async () => {
    const result = await preflightValidateSyntax('file.xyz', '{{{ broken')
    expect(result.valid).toBe(true)
  })
})

describe('getBunTranspilerLoader', () => {
  it('returns "tsx" for .tsx files', () => {
    expect(getBunTranspilerLoader('component.tsx')).toBe('tsx')
  })

  it('returns "jsx" for .jsx files', () => {
    expect(getBunTranspilerLoader('component.jsx')).toBe('jsx')
  })

  it('returns "ts" for .ts files', () => {
    expect(getBunTranspilerLoader('module.ts')).toBe('ts')
  })

  it('returns "js" for .js files', () => {
    expect(getBunTranspilerLoader('script.js')).toBe('js')
  })

  it('returns null for non-JS/TS files', () => {
    expect(getBunTranspilerLoader('file.py')).toBe(null)
    expect(getBunTranspilerLoader('file.go')).toBe(null)
    expect(getBunTranspilerLoader('file.md')).toBe(null)
  })
})

describe('isJavaScriptLikePath', () => {
  it('returns true for JS-like extensions', () => {
    expect(isJavaScriptLikePath('a.ts')).toBe(true)
    expect(isJavaScriptLikePath('a.tsx')).toBe(true)
    expect(isJavaScriptLikePath('a.js')).toBe(true)
    expect(isJavaScriptLikePath('a.jsx')).toBe(true)
  })

  it('returns false for non-JS extensions', () => {
    expect(isJavaScriptLikePath('a.py')).toBe(false)
    expect(isJavaScriptLikePath('a.go')).toBe(false)
    expect(isJavaScriptLikePath('a.md')).toBe(false)
  })
})

describe('countDelimitersOutsideStringsAndComments', () => {
  it('counts braces outside strings', () => {
    const counts = countDelimitersOutsideStringsAndComments(
      'const x = "string with } brace" { }',
      'javascript',
    )
    expect(counts.openBraces).toBe(1)
    expect(counts.closeBraces).toBe(1)
  })

  it('counts parentheses outside comments', () => {
    const counts = countDelimitersOutsideStringsAndComments(
      '// comment with ( paren\nfoo()',
      'javascript',
    )
    expect(counts.openParens).toBe(1)
    expect(counts.closeParens).toBe(1)
  })

  it('counts brackets outside block comments', () => {
    const counts = countDelimitersOutsideStringsAndComments(
      '/* [ bracket ] */ array[0]',
      'javascript',
    )
    expect(counts.openBrackets).toBe(1)
    expect(counts.closeBrackets).toBe(1)
  })

  it('handles Python triple-quoted strings', () => {
    const counts = countDelimitersOutsideStringsAndComments(
      'doc = """string with { brace"""\nx = { }',
      'python',
    )
    expect(counts.openBraces).toBe(1)
    expect(counts.closeBraces).toBe(1)
  })

  it('handles Go line comments', () => {
    const counts = countDelimitersOutsideStringsAndComments(
      '// comment with ( paren\nfunc main() {}',
      'go',
    )
    expect(counts.openParens).toBe(1)
    expect(counts.closeParens).toBe(1)
    expect(counts.openBraces).toBe(1)
    expect(counts.closeBraces).toBe(1)
  })
})

describe('formatPreflightErrorMessage', () => {
  it('includes the tool name, path, and syntax message', () => {
    const msg = formatPreflightErrorMessage(
      'str_replace',
      'foo.ts',
      'Unexpected token',
    )
    expect(msg).toContain('str_replace')
    expect(msg).toContain('foo.ts')
    expect(msg).toContain('Unexpected token')
  })

  it('includes recovery guidance for str_replace', () => {
    const msg = formatPreflightErrorMessage('str_replace', 'bar.ts', 'Error')
    expect(msg).toContain('NOT written to disk')
    expect(msg).toContain('Recovery')
  })

  it('includes edit_transaction-specific guidance for imports', () => {
    const msg = formatPreflightErrorMessage(
      'edit_transaction',
      'baz.ts',
      'Error',
    )
    expect(msg).toContain('NO files were changed')
    expect(msg).toContain('insert_import')
    expect(msg).toContain('remove_import')
  })

  it('includes write_file recovery guidance', () => {
    const msg = formatPreflightErrorMessage('write_file', 'qux.ts', 'Error')
    expect(msg).toContain('NOT written to disk')
    expect(msg).toContain('Recovery')
  })

  it('includes apply_smart_patch recovery guidance', () => {
    const msg = formatPreflightErrorMessage(
      'apply_smart_patch',
      'patched.ts',
      'Error',
    )
    expect(msg).toContain('apply_smart_patch')
    expect(msg).toContain('smart patch was NOT written to disk')
    expect(msg).toContain('Recovery')
  })

  it('[ERR-M03] accurately says the rejected candidate left the current file unchanged', () => {
    const msg = formatPreflightErrorMessage(
      'write_file',
      'candidate.ts',
      'Unexpected token',
    )
    expect(msg).toContain('current file remains unchanged')
    expect(msg).toContain('Correct or rebuild the candidate content')
    expect(msg).not.toContain('current lines of the broken file')
  })
})
