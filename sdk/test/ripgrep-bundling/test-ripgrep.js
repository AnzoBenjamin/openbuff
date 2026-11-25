#!/usr/bin/env node
// Test ripgrep bundling functionality in runtime environment
import { writeFileSync, mkdirSync, existsSync, mkdtempSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

console.log('🧪 Testing ripgrep bundling functionality...')

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const testDir = mkdtempSync(join(__dirname, '.test-files-'))

// Create test files for searching
function setupTestFiles() {
  console.log('\n📁 Setting up test files...')

  if (!existsSync(testDir)) {
    mkdirSync(testDir, { recursive: true })
  }

  writeFileSync(
    join(testDir, 'example.js'),
    `
// Test file for ripgrep search
function testFunction() {
  console.log('This is a test function');
  const specialPattern = 'UNIQUE_SEARCH_TERM';
  return specialPattern;
}

module.exports = { testFunction };
`,
  )

  writeFileSync(
    join(testDir, 'example.ts'),
    `
// TypeScript test file
interface TestInterface {
  name: string;
  value: number;
}

class TestClass implements TestInterface {
  name = 'UNIQUE_SEARCH_TERM';
  value = 42;
}

export { TestClass };
`,
  )

  writeFileSync(
    join(testDir, 'config.json'),
    `{
  "name": "test-config",
  "setting": "UNIQUE_SEARCH_TERM",
  "enabled": true
}`,
  )

  console.log('✅ Test files created')
}

// Clean up test files
async function cleanupTestFiles() {
  try {
    const { rmSync } = await import('fs')
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
    console.log('✅ Test files cleaned up')
  } catch (error) {
    console.warn('⚠️ Could not clean up test files:', error.message)
  }
}

let host
try {
  setupTestFiles()

  // Test 1: Import ripgrep functions via Tools namespace
  console.log('\n1. Testing ripgrep imports...')
  const { getBundledRgPath, ToolHelpers, createConfiguredDirectHostExecution } =
    await import('@openbuff/sdk')

  if (typeof getBundledRgPath !== 'function') {
    throw new Error(
      `Expected getBundledRgPath to be a function, got ${typeof getBundledRgPath}`,
    )
  }

  if (typeof ToolHelpers.codeSearch !== 'function') {
    throw new Error(
      `Expected Tools.codeSearch to be a function, got ${typeof ToolHelpers.codeSearch}`,
    )
  }

  console.log('✅ Ripgrep functions imported successfully')

  // Test 2: Get bundled ripgrep path
  console.log('\n2. Testing getBundledRgPath...')
  const rgPath = getBundledRgPath(import.meta.url)

  if (typeof rgPath !== 'string' || rgPath.length === 0) {
    throw new Error(`Expected valid ripgrep path, got: ${rgPath}`)
  }

  console.log('✅ Ripgrep path found:', rgPath)

  // Test 3: Verify ripgrep binary exists
  console.log('\n3. Testing ripgrep binary existence...')
  if (!existsSync(rgPath)) {
    throw new Error(`Ripgrep binary not found at: ${rgPath}`)
  }

  console.log('✅ Ripgrep binary exists on filesystem')

  // Test 4: Verify we're using bundled ripgrep (not @vscode/ripgrep)
  console.log('\n4. Testing bundled binary location...')
  if (rgPath.includes('@vscode/ripgrep')) {
    throw new Error('Still using @vscode/ripgrep instead of bundled binary!')
  }

  if (!rgPath.includes('vendor/ripgrep')) {
    throw new Error(
      `Expected bundled ripgrep path to contain 'vendor/ripgrep', got: ${rgPath}`,
    )
  }

  console.log('✅ Using bundled ripgrep binary (not @vscode/ripgrep)')

  // Test 5: Direct tool calls need host-captured execution authority.
  console.log('\n5. Testing code search authority requirement...')
  const searchResult = await ToolHelpers.codeSearch({
    projectPath: testDir,
    pattern: 'UNIQUE_SEARCH_TERM',
    maxResults: 10,
  })

  const refusal = searchResult[0]?.value?.executionRefusal
  if (refusal?.reason !== 'unavailable') {
    throw new Error(
      'Expected missing execution authority to refuse code search',
    )
  }

  console.log('✅ Code search refuses without captured execution authority')

  const created = await createConfiguredDirectHostExecution({
    cwd: testDir,
    projectRoot: testDir,
    hostConfiguration: {
      environment: { PATH: process.env.PATH },
      platform: process.platform,
      invocationCwd: testDir,
      projectRoot: testDir,
      home: { kind: 'none' },
      globals: { kind: 'disabled' },
      selection: { kind: 'none' },
      trust: { ancestorConfig: false, projectReadableRoots: false },
    },
    mode: 'user',
    approvalMode: 'allow-all',
    profile: {
      policy: 'full-access',
      preferredBackend: 'portable-ts',
      required: ['exact-env'],
      allowBackendFallback: false,
    },
    limit: { kind: 'finite', durationMs: 60_000 },
  })
  if (!created.ok)
    throw new Error(`Could not create search host: ${created.cause}`)
  host = created.value

  const runBundledSearch = async (pattern, flags) => {
    const operation = host.hostServices.directOperation({ mode: 'user' })
    if (!operation.ok) throw new Error(operation.cause)
    const result = await ToolHelpers.codeSearch({
      projectPath: testDir,
      pattern,
      flags,
      maxResults: 10,
      executionContext: operation.value.executionContext,
    })
    const value = result[0]?.value
    if (typeof value?.stdout !== 'string' || value.errorMessage) {
      throw new Error(`SDK code search failed: ${JSON.stringify(value)}`)
    }
    if (value.processCleanup?.status !== 'complete') {
      throw new Error('SDK code search did not complete process cleanup')
    }
    return value.stdout
  }

  // Test 6: Verify search results contain expected matches
  console.log('\n6. Testing SDK code search results...')
  const stdout = await runBundledSearch('UNIQUE_SEARCH_TERM')
  const lines = stdout.split('\n').filter((line) => line.trim())

  if (lines.length < 3) {
    throw new Error(`Expected at least 3 matches, got ${lines.length}`)
  }

  // Check that all our test files were found
  const hasJsMatch = lines.some((line) => line.includes('example.js'))
  const hasTsMatch = lines.some((line) => line.includes('example.ts'))
  const hasJsonMatch = lines.some((line) => line.includes('config.json'))

  if (!hasJsMatch || !hasTsMatch || !hasJsonMatch) {
    throw new Error('Missing expected file matches in search results')
  }

  console.log('✅ Search found all expected files')

  // Test 7: Test search with flags
  console.log('\n7. Testing search with flags...')
  const flaggedStdout = await runBundledSearch('unique_search_term', '-i')
  if (!flaggedStdout) {
    throw new Error('Expected results from case-insensitive search')
  }

  console.log('✅ Search with flags works correctly')

  // Test 8: Test search with file type filtering
  console.log('\n8. Testing file type filtering...')
  const typeFilteredStdout = await runBundledSearch(
    'UNIQUE_SEARCH_TERM',
    '-t js',
  )
  const typeFilteredLines = typeFilteredStdout
    .split('\n')
    .filter((line) => !line.startsWith(' ') && line.endsWith(':'))

  // Should only find JS file, not TS or JSON
  if (
    typeFilteredLines.length !== 1 ||
    !/(?:^|\/)example\.js:$/.test(typeFilteredLines[0])
  ) {
    throw new Error('Expected file type filtering to match only example.js')
  }
  console.log('✅ File type filtering works correctly')

  // Test 9: Test error handling for invalid directory
  console.log('\n9. Testing error handling...')
  const _invalidResult = await ToolHelpers.codeSearch({
    projectPath: '/nonexistent/directory',
    pattern: 'test',
    maxResults: 1,
  })

  // Should not throw, but may return empty results or error
  console.log('✅ Error handling works (no crashes)')

  // Test 10: Test environment variable override
  console.log('\n10. Testing environment variable override...')
  const originalPath = process.env.CODEBUFF_RG_PATH

  // Use the active Node executable so the override satisfies the production
  // resolver's executable-file check on every supported platform.
  const overrideTarget = process.execPath
  process.env.CODEBUFF_RG_PATH = overrideTarget

  try {
    const overridePath = getBundledRgPath(import.meta.url)
    if (overridePath !== overrideTarget) {
      throw new Error('Environment variable override not working')
    }
    console.log('✅ Environment variable override works')
  } finally {
    // Restore original value
    if (originalPath) {
      process.env.CODEBUFF_RG_PATH = originalPath
    } else {
      delete process.env.CODEBUFF_RG_PATH
    }
  }

  console.log('\n🎉 All ripgrep bundling tests passed!')
} catch (error) {
  console.error('\n❌ Ripgrep bundling test failed:', error.message)
  console.error('Stack trace:', error.stack)
  process.exitCode = 1
} finally {
  try {
    await host?.close()
  } finally {
    await cleanupTestFiles()
  }
}
