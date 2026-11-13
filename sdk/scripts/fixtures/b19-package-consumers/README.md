# Fresh B19 packed SDK consumers

These fixtures preserve the four recovered successor package scenarios and add actual SDK full-access read/edit/command, required unavailable backend, captured explicit route precedence, and explicit credential delegation controls. Both package exports run under Node 20.20.2 against an extracted local SDK tarball. Existing manifest-declared third-party dependencies are linked individually; workspace source/package imports are rejected. npm 11.13.0 under Node 26.1.0 performs only offline local packing with scripts disabled. No install, publication, or model request occurs.

The runner requires SHA-256 references to a fresh build-ready observation and its before-build source manifest. The observation binds the measured Bun 1.4.4 workspace SDK build command receipt, full log, and equal source manifests. Every recorded build input is checked against current bytes before packing. Dist bytes are independently inventoried and compared with the tarball, and source/dist drift invalidates the run. Retained command logs, peer process traces, outputs, and machine-readable receipts go to a unique owned B19 evidence attempt directory.

```
python3 sdk/scripts/fixtures/b19-package-consumers/prepare-build.py docs/execution/body-roadmap/evidence/B19/continuation-20261111/package-consumers/build-ATTEMPT
python3 sdk/scripts/fixtures/b19-package-consumers/run-consumers.py ATTEMPT --build-ready READY_REFERENCE --build-ready-sha256 READY_SHA256 --candidate-manifest SOURCE_BEFORE_REFERENCE --candidate-manifest-sha256 SOURCE_BEFORE_SHA256
```

The build preparer prints the exact references and hashes required by the consumer command. Its generated `sdk/dist` output is ignored build material. Every build and consumer attempt uses a new directory, preserving failed attempts.

The package route scenario exercises the public captured route/credential resolver, including explicit selection over a contradictory agent route and recommendation. Whole SDK model transport route consumption remains a separate source/compiled validation obligation. These checks establish package boundary behavior only; they do not establish B19 acceptance, OS confinement, process-tree cleanup, fresh dependency installation, or all-feature acceptance.
