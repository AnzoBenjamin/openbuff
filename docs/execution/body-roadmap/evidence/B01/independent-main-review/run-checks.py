#!/usr/bin/env python3
"""Read-only independent checks of the leader-owned B01 implementation."""
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[6]
EVIDENCE = Path(__file__).resolve().parent
BUN = Path('/home/ben/.bun/install/cache/@oven/bun-linux-x64@1.3.5@@@1/bin/bun')
PRIMARY = [
    'sdk/src/services/audit-intelligence.ts', 'sdk/src/tools/audit-intelligence.ts',
    'common/src/tools/params/tool/audit-intelligence.ts',
    'agents/base2/gate-reviewer.ts', 'agents/base2/base2.ts', 'agents/reviewer/code-reviewer.ts',
    'sdk/src/__tests__/audit-intelligence.test.ts', 'agents/__tests__/gate-reviewer.test.ts',
    'agents/__tests__/code-reviewer.test.ts', 'agents/__tests__/base2.test.ts',
    'agents/__tests__/base2-writer-spawn-rules.test.ts',
]
TESTS = [
    'sdk/src/__tests__/audit-intelligence.test.ts',
    'common/src/tools/params/__tests__/write-audit-findings.test.ts',
    'sdk/src/__tests__/write-audit-findings.test.ts',
    'common/src/util/__tests__/audit-receipt.test.ts',
    'agents/__tests__/gate-reviewer.test.ts', 'agents/__tests__/code-reviewer.test.ts',
    'agents/__tests__/gate-reviewer-parity.test.ts', 'agents/__tests__/audit-contracts.test.ts',
    'agents/__tests__/base2.test.ts', 'agents/__tests__/base2-writer-spawn-rules.test.ts',
    'agents/__tests__/review-rubric-parity.test.ts', 'agents/e2e/reviewer-spawn-conditions.e2e.test.ts',
]
DEPENDENCIES = [
    'sdk/src/tools/write-audit-findings.ts', 'common/src/util/audit-receipt.ts',
    'common/src/tools/params/tool/write-audit-findings.ts',
    'common/src/tools/compile-tool-definitions.ts', 'common/src/types/json.ts',
    'common/src/tools/list.ts', 'common/src/tools/params/utils.ts',
    'agents/base2/gate-paths.ts', 'agents/base2/gate-repair.ts', 'agents/base2/gate-concurrency.ts',
    'agents/base2/gate-fingerprint.ts', 'agents/base2/gate-committed-surface.ts',
    'agents/base2/quality-prompt-section.ts', 'agents/base2/tool-tiers.ts', 'agents/base2/spawn-contract.ts',
    'agents/specialists/create-specialist.ts', 'agents/specialists/reliability-reviewer.ts',
    'agents/security-reviewer/security-reviewer.ts',
    'common/src/agents/specialist-risk-router.ts', 'agents/types/util-types.ts',
    'agents/types/secret-agent-definition.ts', 'agents/constants.ts',
    'agents/__tests__/helpers/base2-step-fixtures.ts',
    'agents/__tests__/helpers/extract-inline-function-source.ts',
    'scripts/generate-gate-helpers.ts', 'scripts/generate-tool-definitions.ts',
    'agents/types/tools.ts', 'common/src/templates/initial-agents-dir/types/tools.ts', '.agents/types/tools.ts',
    'cli/src/data/initial-agent-type-sources.generated.ts',
    *[file for file in TESTS if file not in PRIMARY],
]
CONFIGS = [
    'package.json', 'sdk/package.json', 'common/package.json', 'agents/package.json',
    'tsconfig.json', 'tsconfig.base.json', 'sdk/tsconfig.json', 'common/tsconfig.json',
    'agents/tsconfig.json', 'bunfig.toml', 'bun.lock',
]
FROZEN = ['.agents/sessions/body-capability-review-2026-11-05/PLAN.md', '.agents/sessions/body-capability-review-2026-11-05/SPEC.md']

def binding(name):
    return {'path': name, 'sha256': hashlib.sha256((ROOT / name).read_bytes()).hexdigest()}

with tempfile.TemporaryDirectory(prefix='b01-independent-review-env-') as owned:
    home = Path(owned) / 'home'; config = Path(owned) / 'config'
    home.mkdir(); config.mkdir()
    env = {'PATH': f'{BUN.parent}:/usr/local/bin:/usr/bin:/bin', 'HOME': str(home),
           'XDG_CONFIG_HOME': str(config), 'TMPDIR': '/tmp', 'LANG': 'C.UTF-8'}
    sources_before = [binding(name) for name in PRIMARY + DEPENDENCIES]
    configs_before = [binding(name) for name in CONFIGS if (ROOT / name).is_file()]
    commands = [
        ('tests', [str(BUN), '--no-env-file', 'test', '--isolate', *TESTS]),
        ('probe', [str(BUN), '--no-env-file', 'run', str(EVIDENCE / 'probe.ts')]),
        ('ordinary-consumer', [str(BUN), '--no-env-file', 'run', str(EVIDENCE / 'ordinary-consumer.ts')]),
        ('specialist-consumer', [str(BUN), '--no-env-file', 'run', str(EVIDENCE / 'specialist-consumer.ts')]),
        ('sdk-typecheck', [str(BUN), '--no-env-file', 'run', '--cwd', 'sdk', 'typecheck']),
        ('agent-typecheck', [str(BUN), '--no-env-file', 'run', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'agents/tsconfig.json']),
        ('generated-gate-parity', [str(BUN), '--no-env-file', 'run', 'scripts/generate-gate-helpers.ts', '--check', 'agents/base2/base2.ts']),
        ('whitespace', ['git', 'diff', '--check', '--', *PRIMARY]),
    ]
    receipts = []
    for name, argv in commands:
        with (EVIDENCE / f'{name}.log').open('w') as log:
            result = subprocess.run(argv, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
        (EVIDENCE / f'{name}.exit').write_text(str(result.returncode) + '\n')
        receipts.append({'name': name, 'argv': argv, 'cwd': str(ROOT), 'exitCode': result.returncode,
                         'log': str((EVIDENCE / f'{name}.log').relative_to(ROOT)),
                         'exitFile': str((EVIDENCE / f'{name}.exit').relative_to(ROOT))})
        print(f'{name}: exit {result.returncode}', flush=True)
    sources_after = [binding(name) for name in PRIMARY + DEPENDENCIES]
    configs_after = [binding(name) for name in CONFIGS if (ROOT / name).is_file()]
    source_stable = sources_before == sources_after
    config_stable = configs_before == configs_after
    blocking = json.loads((EVIDENCE / 'probe-report.json').read_text())['blocking']
    blocking += [{'id': 'specialist-credit:' + case} for case in json.loads((EVIDENCE / 'specialist-consumer-report.json').read_text())['blockingCounterexamples']]
    patch = subprocess.run(['git', 'diff', '--', *PRIMARY], cwd=ROOT, env=env, capture_output=True, check=True).stdout
    (EVIDENCE / 'reviewed-current.diff').write_bytes(patch)
    manifest = {
        'schemaVersion': 1, 'card': 'B01', 'scope': 'Independent review of leader-owned coverage/maturity/source inventory and reviewer gating only',
        'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'baselineHead': subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT, env=env, capture_output=True, text=True, check=True).stdout.strip(),
        'toolchain': {'bun': {'executable': str(BUN), 'version': subprocess.run([str(BUN), '--version'], env=env, capture_output=True, text=True, check=True).stdout.strip(),
                             'sha256': hashlib.sha256(BUN.read_bytes()).hexdigest()},
                      'git': subprocess.run(['git', '--version'], env=env, capture_output=True, text=True, check=True).stdout.strip()},
        'environment': {'replacement': True, 'keys': sorted(env), 'home': 'owned ephemeral empty directory',
                        'xdgConfigHome': 'owned ephemeral empty directory', 'bunEnvFileLoading': False},
        'commands': receipts, 'reviewedSources': sources_after[:len(PRIMARY)],
        'dependencyBindings': sources_after[len(PRIMARY):], 'configBindings': configs_after,
        'frozenPlanBindings': [binding(name) for name in FROZEN],
        'sourceStableDuringChecks': source_stable, 'configStableDuringChecks': config_stable,
        'blockingCounterexamples': blocking,
        'requiredChecksPass': all(item['exitCode'] == 0 for item in receipts) and source_stable and config_stable and not blocking,
        'artifacts': [binding(str(file.relative_to(ROOT))) for file in sorted(EVIDENCE.iterdir()) if file.is_file() and file.name != 'manifest.json'],
        'exclusions': ['No independent approval of the reviewer-owned B01 tail/store subset.', 'No model/provider request or whole OS/network/filesystem confinement claim.', 'No production/test edit or ledger acceptance by this verifier.'],
    }
    (EVIDENCE / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'requiredChecksPass': manifest['requiredChecksPass'], 'sourceStableDuringChecks': source_stable,
                      'blockingCounterexamples': [item['id'] for item in blocking]}))
    raise SystemExit(0 if manifest['requiredChecksPass'] else 1)
