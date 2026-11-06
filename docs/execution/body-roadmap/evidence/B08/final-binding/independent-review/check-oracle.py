#!/usr/bin/env python3
"""Check recorded configured-adapter observations against explicit B08 expectations."""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent
inputs = json.loads((OUT / 'precommitted-inputs.json').read_text())
observed = json.loads((OUT / 'fixture/observations.json').read_text())
cases = {row['case']: row for row in observed['controls']}
hints = ['missing', '9', '0', '-5', '3.5', 'hostile', 'nonfinite', 'http-date']
expected = {f'{protocol}-503-hint-{hint}' for protocol in ['http', 'sse'] for hint in hints}
expected.update([
    'wrapped-policy-and-abort-override-status', 'http-policy-503-no-retry', 'sse-policy-503-no-retry',
    'total-wait-exhaustion-no-backup', 'abort-before-dispatch', 'abort-active', 'abort-backoff',
    'abort-real-timer', *[f'delivered-{kind}-no-replay' for kind in ['text', 'reasoning', 'tool', 'text-tool']],
    'buffered-tool-discard-on-retry', 'dormant-key-healthy-primary',
    'vision-metadata-skips-dormant-key-validation', 'vision-route-cannot-reselect-excluded-oauth',
    'selected-backup-key-error-retains-primary',
    *[f'reasoning-{provider}-{kind}' for provider in ['local', 'custom-gateway', 'openai'] for kind in ['override', 'configured']],
    *[f'configured-oauth-{kind}' for kind in ['skip', 'rate-limit', 'skip-no-backup']],
    'nonstream-text-owned-retries', 'nonstream-structured-owned-retries',
])
failures = []

def require(condition, message):
    if not condition: failures.append(message)

require(len(expected) == 44 and set(cases) == expected and len(observed['controls']) == 44,
        'Exactly the independently enumerated 44 controls must occur once')
require(observed['policy'] == inputs['policy'], 'Fixture policy must match precommitted canonical values')
require(observed['refusedFetches'] == 0, 'No unexpected fetch may occur')
for name, case in cases.items():
    require(case['passed'] is True, name + ': producer oracle failed')
    require(sum(case['waits']) <= 600, name + ': cumulative retry wait exceeds fixture allowance')
    require(len(case['requests']) <= 4, name + ': total requests exceed fixture attempt allowance')
    if '-503-hint-' in name:
        hint = name.split('-503-hint-')[1]
        ledger = ['primary' if 'primary.' in row['url'] else 'backup' for row in case['requests']]
        require(ledger == ['primary', 'primary', 'primary', 'backup'], name + ': incorrect actual request ledger')
        waits = [250, 250] if hint in ['9', 'http-date'] else [0, 0] if hint == '0' else [100, 200]
        require(case['waits'] == waits, name + ': incorrect Retry-After/backoff waits')
        status = [row['action']['chunk'] for row in case['statuses']]
        require([row.get('attempt') for row in status if row['status'] == 'retrying'] == [2, 3], name + ': retry attempt metadata')
        require(all(row.get('statusCode') == 503 for row in status if row['status'] != 'recovered'), name + ': typed HTTP/SSE status lost')
    if name.endswith('policy-503-no-retry'):
        require(len(case['requests']) == 1 and case['waits'] == [], name + ': policy retried')
        require(case['detail']['statusCode'] == 503 and case['detail']['code'] == 'provider_content_policy', name + ': typed policy status lost')
    if name in ['abort-active', 'abort-backoff', 'abort-real-timer']:
        require(len(case['requests']) == 1 and case['elapsedMs'] < 350, name + ': request/cancellation allowance')
        require(case['detail']['name'] == 'AbortError', name + ': cancellation cause lost')
    if name.startswith('delivered-'):
        require(len(case['requests']) == 1 and case['waits'] == [], name + ': delivered output replayed')
    if name.startswith('nonstream-'):
        require(len(case['requests']) == 3 and case['waits'] == [100, 200], name + ': nonstream request ownership differs')
require(cases['abort-before-dispatch']['requests'] == [], 'Pre-dispatch abort admitted a request')
require(len(cases['dormant-key-healthy-primary']['requests']) == 1, 'Dormant backup prevented healthy primary')
require(cases['vision-metadata-skips-dormant-key-validation']['requests'] == [], 'Metadata inspection dispatched inference')
require(cases['vision-route-cannot-reselect-excluded-oauth']['requests'] == [], 'Excluded OAuth dispatched')
require(cases['configured-oauth-skip-no-backup']['requests'] == [], 'Excluded OAuth without eligible backup dispatched')
route = json.loads((OUT / 'route-metadata/observations.json').read_text())
result = {'schemaVersion': 1, 'independentlyEnumeratedProducerControlCount': len(expected),
          'producerControlFailures': failures, 'producerControlsPass': not failures,
          'additionalIndependentControlCount': 1, 'additionalRouteControlPass': route['passed'],
          'blockingCounterexamples': ([] if route['passed'] else ['B08-F1-actual-vision-failover-route-metadata']),
          'allRequiredOraclesPass': not failures and route['passed']}
(OUT / 'oracle-results.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
