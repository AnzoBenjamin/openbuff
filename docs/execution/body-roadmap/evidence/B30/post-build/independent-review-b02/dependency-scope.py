"""Bound local dependency context from declared contracts and actual argv roots."""
from pathlib import Path
import json
import re

SPECIFIERS = re.compile(r"(?:\bfrom\s*|\b(?:import|require)\s*\(\s*|\bimport\s*)['\"]([^'\"]+)['\"]")
LITERALS = re.compile(r"import\s*\(\s*path\.join\(\s*(?:root|repository)\s*,\s*['\"]((?:sdk|cli|common|evals|agents|packages|test|scripts)/[^'\"\n]+)['\"]")

def build_scope(root, out, contracts, argv_roots):
    root = Path(root)
    reasons = {name: {'declared accepted source contract'} for name in contracts}
    queue = []
    edges = []
    unresolved = []
    aliases = {
        '@codebuff/common/': 'common/src/',
        '@codebuff/evals/': 'evals/',
        '@openbuff/sdk/': 'sdk/src/',
        '@codebuff/sdk/': 'sdk/',
        '@codebuff/agent-runtime/': 'packages/agent-runtime/src/',
        '@codebuff/internal/': 'packages/internal/src/',
        '@codebuff/code-map/': 'packages/code-map/',
    }
    exact = {
        '@openbuff/sdk': 'sdk/src/index.ts',
        '@codebuff/sdk': 'sdk/src/index.ts',
        '@codebuff/agent-runtime': 'packages/agent-runtime/src/index.ts',
        '@codebuff/internal': 'packages/internal/src/index.ts',
    }
    packages = {}
    candidates = [root / name for name in ['cli', 'sdk', 'common', 'evals', 'agents']]
    candidates += [path for path in (root / 'packages').iterdir() if path.is_dir()]
    for folder in candidates:
        manifest = folder / 'package.json'
        if manifest.is_file():
            data = json.loads(manifest.read_text())
            packages[data['name']] = (folder, data)

    def resolve_file(path):
        path = Path(path).resolve()
        if not path.is_relative_to(root):
            return None
        for option in [path, Path(str(path) + '.ts'), Path(str(path) + '.tsx'), Path(str(path) + '.js'), Path(str(path) + '.mjs'), path / 'index.ts', path / 'index.tsx', path / 'index.js']:
            if option.is_file() and option.suffix in ['.ts', '.tsx', '.js', '.mjs', '.json']:
                return str(option.relative_to(root))
        return None

    def preferred(value):
        if isinstance(value, str):
            return value
        if isinstance(value, dict):
            for condition in ['bun', 'import', 'default', 'types', 'require']:
                if condition in value:
                    result = preferred(value[condition])
                    if result:
                        return result
        return None

    def resolve(specifier, importer):
        if specifier.startswith('.'):
            return resolve_file((root / importer).parent / specifier)
        if specifier in exact:
            return resolve_file(root / exact[specifier])
        for prefix, target in aliases.items():
            if specifier.startswith(prefix):
                found = resolve_file(root / (target + specifier[len(prefix):]))
                if found:
                    return found
        for name, (folder, manifest) in packages.items():
            if specifier != name and not specifier.startswith(name + '/'):
                continue
            subpath = '.' if specifier == name else './' + specifier[len(name) + 1:]
            exports = manifest.get('exports', {})
            value = exports.get(subpath) if isinstance(exports, dict) else exports
            if value is None and isinstance(exports, dict):
                for pattern, entry in exports.items():
                    if '*' not in pattern:
                        continue
                    first, last = pattern.split('*')
                    if subpath.startswith(first) and subpath.endswith(last):
                        value = preferred(entry)
                        if value:
                            value = value.replace('*', subpath[len(first):len(subpath) - len(last) if last else None])
                            break
            value = preferred(value) or manifest.get('module') or manifest.get('main')
            if value:
                found = resolve_file(folder / value)
                if found:
                    return found
        return None

    def add(name, reason):
        if name not in reasons:
            reasons[name] = set()
        reasons[name].add(reason)
        # Accepted contracts already exist in reasons. An actual root/import
        # still needs traversal; visited suppresses duplicate work and cycles.
        queue.append(name)

    
    for name in argv_roots:
        add(name, 'actual command argv or explicit fixture worker root')
    for filename in ['run.py', 'dependency-scope.py', 'assess.py', 'source-inputs.json', 'provider-config.json', 'offline-preload.ts', 'offline-test-preload.ts']:
        add(str((out / filename).relative_to(root)), 'owned command runner/preload/oracle/configuration')
    for name in ['package.json', 'bun.lock', 'bunfig.toml', 'tsconfig.json', 'tsconfig.base.json']:
        add(name, 'workspace runtime/resolution/lock configuration')
    visited = set()
    while queue:
        name = queue.pop()
        if name in visited:
            continue
        visited.add(name)
        file = root / name
        assert file.is_file(), name
        if file.suffix not in ['.ts', '.tsx', '.js', '.mjs']:
            continue
        for ancestor in file.parents:
            if ancestor == root:
                break
            if (ancestor / 'package.json').is_file():
                add(str((ancestor / 'package.json').relative_to(root)), 'package manifest for ' + name)
                if (ancestor / 'tsconfig.json').is_file():
                    add(str((ancestor / 'tsconfig.json').relative_to(root)), 'package resolution for ' + name)
                break
        source = file.read_text()
        for specifier in sorted(set(SPECIFIERS.findall(source))):
            target = resolve(specifier, name)
            if target:
                add(target, 'workspace import/export/require from ' + name)
                edges.append({'from': name, 'specifier': specifier, 'to': target})
            else:
                unresolved.append({'from': name, 'specifier': specifier, 'boundary': 'builtin/external package locked by bun.lock, optional/nonliteral or unresolved source string'})
        # Bind explicit dynamic imports in the copied independent probes.
        # Arbitrary prompt/path strings are not module dependency edges.
        for literal in sorted(set(LITERALS.findall(source))):
            target = resolve_file(root / literal)
            if target:
                add(target, 'literal dynamic source reference from ' + name)
                edges.append({'from': name, 'specifier': literal, 'to': target, 'dynamicLiteral': True})

    excluded = 'sdk/src/__tests__/3d-assets.test.ts'
    assert excluded not in reasons, 'Unrelated 3D integration test is not a dependency root'
    report = {
        'schemaVersion': 1,
        'policy': 'All declared contracts directly bound plus actual argv-root static workspace import/export/require closure and explicit dynamic path.join imports, owned harness and package/runtime/lock/resolution configuration. No directory-wide source or unrelated-test enumeration.',
        'files': [{'path': name, 'reasons': sorted(reasons[name])} for name in sorted(reasons)],
        'edges': edges,
        'unresolvedSpecifiers': unresolved,
        'excludedUnrelatedTest': excluded,
        'limits': 'Source-context binding, not universal module-loader tracing, installed-package assurance or independent implementation approval of all reachable modules. External package versions remain lock/manifest-bound; native/installed behavior is excluded.',
    }
    (out / 'dependency-scope.json').write_text(json.dumps(report, indent=2) + '\n')
    return sorted(reasons)
