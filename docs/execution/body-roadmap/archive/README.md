# Roadmap evidence archive

## R11 publication: current accepted ledger

The [publication manifest](r11-publication/manifest.json) preserves the exact
ignored inputs for the 24 accepted base nodes and four accepted product tasks.
It includes the fresh B19, B20, and B23 evidence bound to the CLI, common, and
SDK package notes. The capsule contains 618 paths and 554 distinct objects in
1.6 MB of compressed data. Accepted scopes are unchanged from R11.

```sh
python3 -B docs/execution/body-roadmap/archive/restore.py --snapshot r11-publication --check
python3 -B docs/execution/body-roadmap/archive/restore.py --snapshot r11-publication --destination "$PWD"
python3 -B docs/execution/body-roadmap/validate-ledger.py
```

Use a disposable checkout of the matching publication source. Restore verifies
preserved bytes; it does not run the original tests or install any software.

<a id="r11-current-accepted-ledger"></a>

## R11: previous accepted ledger

The [R11 manifest](r11/manifest.json) preserves the ignored inputs needed to
validate **24 of 39 accepted base nodes through B16** and four separately
accepted product tasks (**N01, N02, N10, N12**). The file inventory includes
621 paths and 557 distinct objects in 1.7 MB of compressed data. This is an
evidence archive, not an installer: it does not contain dependencies or the
original compiled executables and SDK tarballs.

From a disposable checkout of the matching source snapshot:

```sh
python3 -B docs/execution/body-roadmap/archive/restore.py --snapshot r11 --check
python3 -B docs/execution/body-roadmap/archive/restore.py --snapshot r11 --destination "$PWD"
python3 -B docs/execution/body-roadmap/validate-ledger.py
```

Restoration verifies the preserved bytes without overwriting different files.
The validator checks the current source, receipt, prerequisite and independent
review bindings; it does not rerun the original tests.

<a id="r10-current-accepted-ledger"></a>

## R10: previous accepted ledger

[The R10 manifest](r10/manifest.json) preserves all 325 ignored inputs needed to
validate the 23 accepted nodes through B23 and selected original text records needed to
inspect the results. The archive contains 1,868 paths and 1,787 content objects
in an 11.8 MB compressed part. It does not contain installed dependencies,
local SQLite databases, the original built ELF executables, or the SDK package
tarball. Omitted build artifacts retain their original hashes in the manifest.

After checking out this snapshot in a disposable worktree, run:

```sh
python3 -B docs/execution/body-roadmap/archive/restore.py --snapshot r10 --check
python3 -B docs/execution/body-roadmap/archive/restore.py --snapshot r10 --destination "$PWD"
python3 -B docs/execution/body-roadmap/validate-ledger.py
```

Restoration verifies the original bytes and never overwrites different bytes.
This lets the unchanged validator check the current ledger; it does not rerun
the historical commands or reconstruct their local dependencies.

## Historical archive

The default `historical` snapshot preserves the earlier ledger's physical proof and ignored dependency/build context, together with active B19 and researcher-web records. [manifest.json](manifest.json) maps 26,776 original paths to 18,472 content objects. It compresses 6.65 GB of original files into 529 MB across thirteen parts, each limited to 40 MiB. Original receipts and failures retain their bytes. No milestone is promoted by archiving or restoring them. [verification.json](verification.json) records restoration, cleanup and publication checks.

Verify the complete archive without writing restored files:

```sh
python3 docs/execution/body-roadmap/archive/restore.py --check
```

Restore evidence into an existing disposable source checkout. Include archived dependency/build context when checking historical ledger dependencies:

```sh
python3 docs/execution/body-roadmap/archive/restore.py --destination /path/to/disposable-checkout --include-context
```

Without `--include-context`, only evidence paths are restored. The helper verifies its pinned manifest, compressed parts, combined archive and all objects before writing. It rejects unsafe paths and refuses to overwrite different bytes. Avoid restoring over a development checkout; use a clean directory when existing generated output conflicts.

Run the unchanged ledger validator from the destination checkout after restoration. Current B19 source changes and SDK build outputs differ from some historical accepted bindings; those differences still require renewal. This archive supports inspection of original evidence, not a clean current acceptance verdict or a product installation.

Unreferenced historical runtime/preparation bytes and saved symlink metadata are retained locally under `.openbuff/archives/body-roadmap-20261109/`, outside Git. The published manifest pins that local inventory's hash. Required paths reached through historical symlinks are archived as regular bytes; restoration does not recreate links into a live workspace. Eight legacy publication files remain directly in the tree, including their original archive helpers and the pinned Git-fixture classification.
