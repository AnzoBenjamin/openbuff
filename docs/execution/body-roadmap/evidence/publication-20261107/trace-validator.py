#!/usr/bin/env python3
"""Observe the unchanged validator's file reads; do not modify its semantics."""
import datetime
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[5]
OUT = Path(__file__).resolve().parent
VALIDATOR = ROOT / 'docs/execution/body-roadmap/validate-ledger.py'
LEDGER = ROOT / 'docs/execution/body-roadmap/ledger.json'
assert hashlib.sha256(VALIDATOR.read_bytes()).hexdigest() == '6aa69375eeeae93f4850a6a068e1c17d39ba08b7a7b4d14c8ebe10e552d36c4c'
assert hashlib.sha256(LEDGER.read_bytes()).hexdigest() == '108ed649f9f89f7a767651382f8966d5fdd2a16b50d4d1f43551e7548a833758'
objects = {}
calls = {}
loads = set()


def remember(value, name):
    if isinstance(value, (dict, list)):
        objects[id(value)] = name
        for child in value.values() if isinstance(value, dict) else value:
            remember(child, name)


def trace(frame, event, arg):
    if frame.f_code.co_filename != str(VALIDATOR):
        return None
    if event == 'return' and frame.f_code.co_name == 'load' and arg is not None:
        path = frame.f_locals.get('path')
        if path is not None:
            name = str(Path(path).relative_to(ROOT))
            loads.add(name)
            remember(arg, name)
    if event == 'call' and frame.f_code.co_name == 'file_binding':
        values = frame.f_locals
        path, expected, label = values.get('path'), values.get('expected'), values.get('label')
        owner = None
        ancestor = frame.f_back
        functions = []
        while ancestor is not None and ancestor.f_code.co_filename == str(VALIDATOR):
            functions.append(ancestor.f_code.co_name)
            if owner is None:
                for key in ['value', 'document', 'bindings', 'selected', 'origin', 'review_origin', 'review_document', 'command', 'manifest', 'receipt', 'ledger']:
                    found = objects.get(id(ancestor.f_locals.get(key)))
                    if found is not None:
                        owner = found
                        break
            ancestor = ancestor.f_back
        kind = 'current_source_or_context' if any(key in functions for key in ('current_sources', 'matching_sources')) or str(label).endswith(' current source') else 'hashed_artifact_or_authority'
        item = {'path': path, 'expectedSha256': expected, 'label': label, 'originDocument': owner, 'validatorCallers': functions, 'referenceKind': kind}
        calls[(path, expected, label, owner)] = item
    return trace


ledger = json.loads(LEDGER.read_text())
remember(ledger, str(LEDGER.relative_to(ROOT)))
spec = importlib.util.spec_from_file_location('frozen_publication_validator', VALIDATOR)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
sys.settrace(trace)
try:
    result = module.validate(ledger)
finally:
    sys.settrace(None)
document = {'schemaVersion': 1, 'kind': 'literal_frozen_validator_reference_trace', 'validatorSha256': hashlib.sha256(VALIDATOR.read_bytes()).hexdigest(), 'ledgerSha256': hashlib.sha256(LEDGER.read_bytes()).hexdigest(), 'validation': result, 'fileBindingCalls': list(calls.values()), 'semanticallyLoadedDocuments': sorted(loads), 'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'sourceOrLedgerEdited': False}
with (OUT / 'validator-reference-trace-v2.json.gz').open('xb') as raw:
    with gzip.GzipFile(fileobj=raw, mode='wb', mtime=0) as handle:
        handle.write(json.dumps(document, separators=(',', ':')).encode())
names = {row['path'] for row in calls.values()}
scratch = sorted(name for name in names if '.pile' in name or '/home/' in name or name.endswith(('.sqlite', '.db')))
print(json.dumps({'valid': result['valid'], 'errors': result['errors'], 'uniqueFiles': len(names), 'uniqueBindingEdges': len(calls), 'semanticallyLoadedDocuments': len(loads), 'requiredScratchCount': len(scratch), 'requiredScratchBytes': sum((ROOT/name).stat().st_size for name in scratch), 'scratchByKind': {'pile': len([x for x in scratch if x.endswith('.pile')]), 'sqlite': len([x for x in scratch if x.endswith('.sqlite')])}}, indent=2))
