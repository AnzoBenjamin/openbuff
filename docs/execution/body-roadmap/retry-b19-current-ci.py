#!/usr/bin/env python3
"""Retry failed package-test commands from one B19 CI replay, retaining failures."""

import argparse
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import yaml


SPEC = importlib.util.spec_from_file_location('current_ci', Path(__file__).with_name('run-b19-current-ci.py'))
ci = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ci)
ROOT = ci.ROOT


def verified(reference):
    file = (ROOT / reference['path']).resolve(strict=True)
    assert file.is_relative_to(ROOT) and ci.sha(file) == reference['sha256'], reference
    return file


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--from-results', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    prior_path = args.from_results.resolve(strict=True)
    out = args.out.resolve()
    assert prior_path.is_relative_to(ci.BASE) and out.is_relative_to(ci.BASE)
    prior = json.loads(prior_path.read_text())
    assert prior['kind'] == ci.KIND and prior['complete'] and not prior['passed']
    assert not prior.get('retryFrom'), 'This proof runner performs one successor attempt'
    dispatch = json.loads(verified(prior['dispatchManifest']).read_text())
    assert verified(dispatch['recorder']) == Path(ci.__file__).resolve()
    assert dispatch['sourceManifest'] == prior['manifest']
    manifest = json.loads(verified(prior['manifest']).read_text())
    assert ci.git('rev-parse', 'HEAD') == manifest['head']
    ci.compare_input_files(manifest['inputs'])
    compiler = Path(dispatch['toolchain']['bun']['path']).resolve(strict=True)
    node = Path(dispatch['toolchain']['node']['path']).resolve(strict=True)
    assert ci.sha(compiler) == dispatch['toolchain']['bun']['sha256']
    assert ci.sha(node) == dispatch['toolchain']['node']['sha256']
    verified(dispatch['toolchain']['node']['requirement'])
    verified(dispatch['toolchain']['node']['provenance'])
    rosters = json.loads(verified(dispatch['rosters']).read_text())
    workflow = yaml.safe_load(verified(rosters['workflow']).read_text())
    tests = next(s for s in workflow['jobs']['test']['steps'] if s.get('id') == 'tests')
    assert int(tests['with']['max_attempts']) >= 2, 'Workflow no longer permits a successor attempt'
    planned = dispatch['commands']
    packages, typechecks, expected_rosters, commands = ci.plan(
        manifest, compiler, dispatch['provenanceRange']['head'], dispatch['provenanceRange']['base'])
    assert planned == commands and packages == prior['ciMatrix'] and typechecks == prior['typecheckWorkspaces']
    assert expected_rosters == rosters['rosters']
    assert len(prior['commands']) == len(planned)
    failed = [row for row in prior['commands'] if not row['passed']]
    assert failed and all(row['category'] == 'test' and row['sourceStable'] and row['toolchainStable'] for row in failed)
    out.mkdir(mode=0o700, parents=True, exist_ok=False)
    rows = []
    for ordinal, (row, original) in enumerate(zip(prior['commands'], planned)):
        assert all(row[name] == value for name, value in original.items())
        verified(row['log'])
        assert json.loads(verified(row['sourceBefore']).read_text()) == manifest['inputs']
        assert json.loads(verified(row['sourceAfter']).read_text()) == manifest['inputs']
        if row['passed']:
            assert row['exitCode'] == 0
            rows.append(row)
            continue
        actual_prior = prior_path.parent / f'{ordinal:02d}-{row["name"]}' / 'invocation.json'
        assert json.loads(actual_prior.read_text()) == row
        output = out / f'{ordinal:02d}-{row["name"]}'
        output.mkdir(mode=0o700)
        before = ci.write(output / 'source-before.json', ci.compare_input_files(manifest['inputs']))
        started = datetime.now(timezone.utc).isoformat()
        cwd = (ROOT / row['cwd']).resolve()
        with tempfile.TemporaryDirectory(prefix='openbuff-b19-ci-retry-') as temporary:
            root = Path(temporary)
            for name in ['home', 'xdg', 'tmp']:
                (root / name).mkdir(mode=0o700)
            environment = {
                'PATH': os.pathsep.join([str(node.parent), str(compiler.parent), os.environ['PATH']]),
                'HOME': str(root / 'home'), 'XDG_CONFIG_HOME': str(root / 'xdg'), 'TMPDIR': str(root / 'tmp'),
                'DO_NOT_TRACK': '1', 'OPENBUFF_TELEMETRY': '0', 'TERM': 'xterm-256color', 'LANG': 'C.UTF-8',
                'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_TERMINAL_PROMPT': '0',
                'BUN_OPTIONS': '--no-env-file', **row['environment'],
            }
            log = output / 'command.log'
            with log.open('xb') as stream:
                process = subprocess.Popen(row['argv'], cwd=cwd, env=environment, stdin=subprocess.DEVNULL,
                                           stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
                try:
                    exit_code = process.wait(timeout=1500)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                    exit_code = 124
        after = ci.write(output / 'source-after.json', ci.compare_input_files(manifest['inputs']))
        assert ci.sha(compiler) == dispatch['toolchain']['bun']['sha256']
        assert ci.sha(node) == dispatch['toolchain']['node']['sha256']
        verified(dispatch['toolchain']['node']['requirement'])
        text = log.read_text(errors='replace')
        summary = ci.summarize(text, rosters['rosters'][row['cwd']]['files'], cwd)
        passed = exit_code == 0 and summary['nonVacuous'] and not summary['missingDiscoveredFilesInLog'] and summary['reportedFailureCounts'] == [0]
        successor = {**original, 'passed': passed, 'exitCode': exit_code, 'sourceStable': True, 'toolchainStable': True,
                     'sourceBefore': before, 'sourceAfter': after, 'testSummary': summary, 'observedTypechecks': None,
                     'log': ci.ref(log), 'startedAt': started, 'finishedAt': datetime.now(timezone.utc).isoformat(),
                     'priorFailedInvocation': ci.ref(actual_prior)}
        ci.write(output / 'invocation.json', successor)
        rows.append(successor)
        print(row['name'], 'PASS' if passed else 'FAIL', summary['counts'], flush=True)
        if not passed:
            print('\n'.join(text.splitlines()[-24:]), flush=True)
    complete = len(rows) == len(prior['commands']) and all(row['passed'] for row in rows)
    ci.write(out / 'results.json', {**prior, 'commands': rows, 'passed': complete,
             'retryFrom': ci.ref(prior_path), 'retryRecorder': ci.ref(Path(__file__))})
    return 0 if complete else 1


if __name__ == '__main__':
    raise SystemExit(main())
