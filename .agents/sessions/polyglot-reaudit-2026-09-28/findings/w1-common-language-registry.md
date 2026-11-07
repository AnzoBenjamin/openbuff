# Audit findings: w1-common-language-registry

- Subsystems: common, agents
- Features: language-registry, language-capability-manifest, idioms, language-profiles, engine-profiles, game-dev-presets, project-file-tree, sensitive-paths
- Files covered: 22
- Snapshot: 49801b44e84d3d8fa583c3ebd9b2855228bf122572b7cdf5f78c77b3389d824d

## [HIGH] correctness — common/src/util/language-capabilities.ts:1 — [POLY] Registry is a closed 12-language set; most real-world repo languages get zero profile, tools, or LSP
- **Risk:** Scala, Lua, Zig, Elixir, Haskell, Dart, Bash/shell, SQL, Terraform/HCL, Vue/Svelte/Astro SFCs, Julia, R, OCaml, F#, Objective-C, Nix, Dockerfile, YAML/TOML/JSON config are entirely absent. For such repos detectLanguageIdForPath returns undefined, formatLanguageProfilePrompt returns '' (language-profiles.ts ~340), and there are no toolSpecs for the future P3-T1 LSP multiplexer or validation routing. That breaks the 'works on ANY language' goal. It fails silently: nothing tells the model or the user that the language is unsupported.
- **Fix:** Add first-class entries at least for Bash, SQL, Terraform/HCL, Dockerfile, YAML/TOML, Scala, Dart, Elixir, Lua, Haskell, Zig, F#, ObjC, Vue/Svelte, R/Julia, OCaml, Nix. Also add a data-only 'generic' tier that derives from an external catalogue (see the [LANG] finding), so unregistered languages still get a displayName, extension detection, and an 'unsupported tooling' notice in the prompt and in X-4 advertisement.
- **Evidence:** SUPPORTED_LANGUAGE_IDS lines 1-14 lists only typescript, python, rust, go, java, csharp, cpp, ruby, php, swift, kotlin, gdscript. LANGUAGE_CAPABILITY_REGISTRY uses `satisfies Record<SupportedLanguageId, LanguageCapability>`, so no open/fallback entry exists.

## [HIGH] api-contract — common/src/util/language-capability-manifest.ts:83 — [LANG] D16 manifest is closed-enum with only a shape version; no Rust consumer exists and adding a language breaks V1 consumers
- **Risk:** languageCapabilityManifestV1Schema keys `languages` by z.enum(SUPPORTED_LANGUAGE_IDS) and every entry's `id` is the same enum. A Rust-tier consumer frozen against V1 must therefore reject any manifest that adds a language, which is exactly the growth the previous finding requires. schemaVersion versions only the shape. There is no registry content revision or hash, so consumers cannot tell registry data drift apart from a shape change. code_search across Rust sources found zero consumers, and the X-4 initialize/doctor/status-bar advertisement is still [~] in PLAN.md line 28.
- **Fix:** Split the shape version from a data revision: add `registryRevision` plus a sha256 `contentHash` of the canonical JSON. Make the language id an open string (a known-id set is advisory only) and require consumers to ignore unknown languages and unknown tool roles (tolerant reader). Emit a JSON Schema artifact via z.toJSONSchema and generate Rust types from it with typify/schemars in X-3b instead of hand-mirroring them. Treat only removals/renames as schemaVersion bumps.
- **Evidence:** manifest.ts lines 60-63 (`id: z.enum(SUPPORTED_LANGUAGE_IDS)`) and 83-86 (`languages: z.record(z.enum(SUPPORTED_LANGUAGE_IDS), ...)`). LANGUAGE_CAPABILITY_MANIFEST_VERSION = 1 (line 16). A Rust code_search for language.capabilit|schemaVersion returned 0 matches.

## [MEDIUM] dependency-hygiene — common/src/util/language-capabilities.ts:100 — [LANG] Hand-maintained extension/LSP tables should overlay proven external catalogues (linguist languages.yml, Helix languages.toml, tree-sitter-language-pack)
- **Risk:** Maintaining extensions, filenames, interpreters, LSP argv, and root markers by hand for every language does not scale. It already shows gaps: no shebang or filename (Makefile, Dockerfile, Rakefile) detection, no .h disambiguation between C, C++, and ObjC. The data also goes stale (for example, the fwcd kotlin-language-server has been superseded by JetBrains' official Kotlin LSP).
- **Fix:** Vendor pinned snapshots of github-linguist languages.yml (extensions, filenames, interpreters for shebangs, aliases, ~700 languages) and Helix runtime languages.toml (LSP command/args, roots, formatter per language, actively maintained). Map grammars to tree-sitter-language-pack. Generate the base registry at build time and keep only Openbuff-specific overlays (idiomGuidance, validation stages, taskAliases) hand-written in TS. Record the snapshot revisions in the manifest registryRevision.
- **Evidence:** LanguageCapability (lines 64-86) has no `filenames`, `interpreters`/shebang, or `heuristics` fields. Every extension and toolSpec in lines 100-589 is literal hand-written data.

## [MEDIUM] correctness — common/src/util/language-profiles.ts:171 — [POLY] Gradle/Kotlin/Java detection gaps: build.gradle(.kts) explicitly suppressed, Kotlin has no manifests, Java only pom.xml
- **Risk:** Gradle-only JVM projects are detected only through source extensions. A task like 'fix the gradle build' matches no language because 'gradle' is not a task alias. Kotlin manifestNames is [], so a settings.gradle.kts-only change never selects Kotlin guidance. The same files are listed as Kotlin/Java LSP rootMarkers, so detection and LSP root selection disagree.
- **Fix:** Model shared build manifests explicitly: a `sharedManifestNames` field, or have a manifest map to several candidate ids and resolve them by sibling sources. Add 'gradle' to the Java/Kotlin aliases. Add a test for Gradle-only trees.
- **Evidence:** detectLanguageIdForPath lines ~171-181 returns undefined for build.gradle, build.gradle.kts, settings.gradle(.kts), and gradle.properties. language-capabilities.ts: kotlin `manifestNames: []`, java `manifestNames: ['pom.xml']`, yet java/kotlin toolSpecs rootMarkers include build.gradle(.kts).

## [MEDIUM] correctness — common/src/util/language-capabilities.ts:300 — [POLY] Missing extensions/manifests inside registered languages (C++20 modules, CUDA, .ipynb, uv, go.work, .sln, .erb, .m/.mm)
- **Risk:** Common files are misdetected or not detected: cpp lacks .ipp/.tpp/.inl/.ixx/.cppm/.cu/.cuh and meson.build/Makefile/BUILD.bazel/conanfile/vcpkg.json. Python lacks .pyw/.ipynb, uv.lock, poetry.lock, and requirements-*.txt. Go lacks go.work. Rust lacks rust-toolchain.toml. C# lacks .sln/.slnx/Directory.Build.props/global.json and .razor/.cshtml, and csharp-ls rootMarkers is [], so the LSP root is undefined. Ruby lacks Rakefile/.rake/.erb. PHP lacks .phtml/.blade.php (the manifest regex /^\.[a-z0-9]+$/ also forbids multi-dot extensions). ObjC .m/.mm are absent while .h maps to cpp.
- **Fix:** Extend the per-language lists, and allow multi-dot suffixes in both the schema regex and getFileExtension (longest-suffix match). Set C# rootMarkers to ['*.sln','*.slnx','*.csproj','global.json'] with glob support. Add a table-driven test that pins one representative file per ecosystem.
- **Evidence:** cpp extensions ['.c','.cc','.cpp','.cxx','.h','.hh','.hpp','.hxx'], manifestNames ['CMakeLists.txt']. csharp manifestExtensions ['.csproj'], toolSpec rootMarkers []. python extensions ['.py','.pyi']. manifest.ts line 63 extension regex. getFileExtension uses lastIndexOf('.').

## [MEDIUM] correctness — agents/idioms/python.md:1 — [POLY] Idiom guidance is version-agnostic and dated across all languages
- **Risk:** The bundled idioms (both the .md files and registry idiomGuidance) never mention current practice. Missing items per language: Python (uv, ruff as formatter+linter, PEP 604/695 typing, dataclasses/Protocol), Go (generics, range-over-func iterators, slog, errors.Is/As/Join, go.work), Rust (edition 2024, let-else, thiserror/anyhow conventions), C++20/23 (concepts, ranges, std::expected, std::span, modules), Swift 6 (strict concurrency, Sendable), Kotlin 2/K2 (context parameters, KMP), Java 21 (records, sealed, pattern-matching switch, virtual threads), C# 12 (primary constructors, collection expressions, required members), PHP 8.3 (readonly classes, enums, typed class constants, #[\Override]). The model gets no nudge toward version-appropriate constructs and no reminder to check the project's declared version (edition, go directive, LangVersion, jvmTarget, requires-python).
- **Fix:** Add a per-language 'detect the declared version first' rule that names the version file and key (Cargo.toml edition, go.mod go directive, pyproject requires-python, .csproj LangVersion, composer.json php, Package.swift swift-tools-version). Then add modern-construct bullets gated on that version. Keep each entry to 3-5 bullets for prompt budget.
- **Evidence:** python.md lines 3-7 are generic (no uv/ruff/typing syntax). go.md has no generics/iterators. rust.md has no edition. cpp.md says 'project-selected language standard' with no C++20/23 facilities. swift.md mentions actors but not Swift 6 Sendable/strict concurrency. The registry idiomGuidance arrays mirror the same content.

## [MEDIUM] test-coverage — common/src/util/language-capabilities.ts:78 — [BEST] Two unsynchronized sources of idiom truth: agents/idioms/*.md vs registry idiomGuidance
- **Risk:** Prompts inject only registry idiomGuidance (language-profiles.ts formatLanguageProfilePrompt, called from packages/agent-runtime/src/templates/strings.ts:184). The .md files are consumed only by evals/indexer tests (evals/buffbench eval-idioms-v1.json, packages/indexer/src/query-quality.test.ts). The two already diverge: gdscript.md has 9 bullets while the registry has 3, and go.md 'do not store contexts in structs' has no registry equivalent. Evals measure content the runtime never ships.
- **Fix:** Make one source canonical. Either generate the .md files from the registry (a script plus a CI drift test), or load the .md at build time into idiomGuidance. Add a parity test.
- **Evidence:** code_search shows formatLanguageProfilePromptForFileTree used in strings.ts:3,184 and measure-context-baseline.ts. The 'agents/idioms/' references appear only in evals/ and indexer tests. strings.test.ts:277 asserts the prompt does NOT contain 'agents/idioms/'.

## [MEDIUM] correctness — common/src/util/language-profiles.ts:196 — [BEST] Repository-wide profile selection has no prevalence weighting; maxProfiles truncates by registry order
- **Risk:** One vendored .php or a stray setup.py adds that language, as much as the repo's dominant language. When maxProfiles caps output, profilesForIds keeps SUPPORTED_LANGUAGE_IDS order, so TypeScript/Python always win and the dominant language (for example Kotlin or GDScript) may be dropped.
- **Fix:** Count files (or bytes) per language during collectDetectedLanguages, drop languages below a threshold or under vendor/third_party/generated paths (linguist vendor.yml/generated heuristics), and sort by prevalence before slicing. Add tests.
- **Evidence:** profilesForIds lines ~196-204 filters SUPPORTED_LANGUAGE_IDS then slices. collectDetectedLanguages only adds to a Set. selectLanguageProfiles ~319-337 falls back to all repository ids.

## [MEDIUM] api-contract — common/src/util/language-profiles.ts:129 — [BEST] getLanguageFamily is a parallel table, contradicting the registry's single-source contract and PLAN LI-11 [x]
- **Risk:** The registry doc says consumers must derive lookup maps from it, and PLAN line 41 marks 'derive the language-family maps from the registry' done. getLanguageFamily nonetheless hard-codes five families and returns a raw extension for everything else, so code-map/indexer family grouping silently diverges for every newly added language (for example .kt vs .java, or .m ObjC).
- **Fix:** Add a `dialects` field to LanguageCapability (e.g. typescript: {typescript:[.ts...], javascript:[.js...]}, cpp: {c:[.c,.h], cpp:[...]}) and derive getLanguageFamily from it. Throw at module load if an extension has no family.
- **Evidence:** language-profiles.ts ~129-140 docstring: 'Deliberately NOT derived from LANGUAGE_CAPABILITY_REGISTRY'. TYPESCRIPT/JAVASCRIPT/C/CPP/KOTLIN_FAMILY_EXTENSIONS sets are literal. language-capabilities.ts lines ~95-98 comment requires derivation.

## [MEDIUM] correctness — common/src/util/language-capabilities.ts:480 — [POLY] Several LSP toolSpecs are not launchable as written or use superseded servers
- **Risk:** jdtls argv ['jdtls'] has no `-data <workspace>` (the jdtls wrapper needs a per-project data dir, or concurrent roots corrupt each other) and no detect. kotlin-language-server (fwcd) is effectively unmaintained next to JetBrains' Kotlin LSP. pyright-langserver --version is not a documented probe. The Python LSP list omits basedpyright and `ruff server`. C# omits the Roslyn LanguageServer (Microsoft.CodeAnalysis.LanguageServer). The gdscript spec has argv [] with a fixed TCP port 6005 and nothing indicates it needs a running editor. P3-T1 plans to drive the multiplexer from these specs.
- **Fix:** Add argv templating (e.g. ${workspaceCacheDir}) for jdtls. List ordered alternatives per role (kotlin-lsp → kotlin-language-server; basedpyright/pyright; roslyn-ls → csharp-ls). Use `detect` probes that exit without starting a server (e.g. `pyright --version`). Add `requiresExternalProcess: 'godot-editor'` for gdscript. Seed these from Helix languages.toml.
- **Evidence:** java toolSpecs: {argv:['jdtls'], rootMarkers:[...]} with no detect. kotlin argv ['kotlin-language-server']. python detect ['pyright-langserver','--version']. gdscript {argv:[], transport:'tcp', port:6005}.

## [MEDIUM] correctness — common/src/util/engine-profiles.ts:250 — [POLY] Engine detection fires on generic directory names alone (Config/, Content/, Assets/, addons/, Cargo.toml+assets/)
- **Risk:** A single top-level Config/ or Content/ directory (common in .NET, CMS, and docs repos) marks the repo as Unreal. Assets/ marks it Unity, addons/ (Odoo, Blender add-ons) marks it Godot, and any Rust crate with assets/ is labelled Bevy. The misdetection injects wrong engine guidance into the system prompt, e.g. 'Blueprint assets are binary — do not read as text'.
- **Fix:** Require a manifest or strong-extension signal for each engine, and use directories only as corroboration. For Bevy, read Cargo.toml for a bevy dependency (content is available via fs). Add negative tests (ASP.NET repo with Config/, Odoo repo with addons/).
- **Evidence:** detectEngineProfiles ~lines 245-262: `if (engineId === 'unreal' && matchCount >= 1)` / unity / godot >=1. detectBevyHeuristic uses Cargo.toml + assets/ only. The docstring claims 'weaker signal — needs at least 2 matches' but the code checks >=1.

## [MEDIUM] correctness — common/src/project-file-tree.ts:70 — [POLY] BINARY_EXTENSIONS hides text source/asset formats (.svg, .mat, .anim, .controller, .physicmaterial, .obj, .gltf, .usda)
- **Risk:** Unity .mat/.anim/.controller/.physicmaterial are YAML text in force-text mode (the file's own comment says Unity text assets are kept for the indexer). .svg is XML source that web/React repos edit routinely, and .usda/.gltf/.obj are text. When get3dAssetFormat does not claim them, they vanish from the file tree, so the agent cannot discover them for editing.
- **Fix:** Remove text formats (.svg, .mat, .anim, .controller, .physicmaterial, .usda) from the exclusion list, or classify by content sniffing (a NUL-byte probe) instead of by extension. Keep them size-capped.
- **Evidence:** project-file-tree.ts lines 48-72 include '.anim','.controller','.mat','.physicmaterial','.usda'. Line ~84 includes '.svg'. The comment at lines 49-51 says Unity text YAML assets are intentionally kept.

## [MEDIUM] security — common/src/util/sensitive-paths.ts:27 — Sensitive-path policy misses common IaC and toolchain secret carriers (*.tfvars, cargo credentials.toml, .vault-token, .p8)
- **Risk:** Only the exact basename terraform.tfvars is blocked, so prod.tfvars and *.auto.tfvars (which often hold secrets) are readable. isCredentialBasename allows only .json/.yaml/.yml, so ~/.cargo/credentials.toml (crates.io token) is readable. .vault-token, Apple .p8 keys, .ovpn, and .dockercfg are also unblocked. This matters directly for polyglot repos such as Terraform, Rust, and iOS projects.
- **Fix:** Block extension .tfvars (with a *.tfvars.example template exemption, like the .env templates), add .toml to CREDENTIAL_BASENAME_SUFFIXES, and add .vault-token, .dockercfg, .p8, and .ovpn. Extend the sensitive-paths tests.
- **Evidence:** SENSITIVE_BASENAMES includes 'terraform.tfvars' (line ~27) but no .tfvars extension rule. CREDENTIAL_BASENAME_SUFFIXES = ['.json','.yaml','.yml'] (line ~71). SENSITIVE_EXTENSIONS lacks .p8/.ovpn.

## [LOW] correctness — common/src/util/language-profiles.ts:270 — [POLY] Ambiguous task aliases cause false-positive focused profiles ('.net' in URLs, 'swift', 'rust' as English words)
- **Risk:** '.net' matches any 'example.net' URL in task text and forces the C# profile. 'swift' and 'rust' as plain English words ('swift fix', 'rust on the bolts') select Swift/Rust. Because focused signals override repository detection entirely, one false hit can replace the correct profile.
- **Fix:** Treat bare-word aliases like 'go' (require capitalization or a code context), require '.net' to be preceded by whitespace/start or 'asp', and let focused signals augment repository detection only when they intersect it.
- **Evidence:** csharp taskAliases ['c#','csharp','.net','dotnet']; swift ['swift',...]; rust ['rust',...]. taskAliasRegexp is case-insensitive (flag 'i'). selectLanguageProfiles returns focused ids exclusively when focusedIds.size > 0.

## [LOW] correctness — common/src/util/coding-harness.ts:1 — [BEST] Confirmation: coding-harness and game-dev-presets are language-neutral and prompt-driven
- **Risk:** None beyond scope. evaluateCodingStrategy/validateContextPacket carry no language assumptions. game-dev presets deliberately emit prompts rather than hard-coded commands, which is the right polyglot choice. The one gap: presets exist only for the 5 engines (no MonoGame/Love2D/Defold/raylib).
- **Fix:** No change required. Optionally derive engine presets from a data table alongside engine profiles when new engines are added.
- **Evidence:** coding-harness.ts lines 1-124 are pure data/logic helpers. game-dev-presets.ts ENGINE_PRESETS comment (lines ~150-160): 'Presets are prompts, NOT direct commands'.

## Coverage receipt

### Subsystems
- common
- agents

### Features
- language-registry
- language-capability-manifest
- idioms
- language-profiles
- engine-profiles
- game-dev-presets
- project-file-tree
- sensitive-paths

### Files
- common/src/util/language-capabilities.ts
- common/src/util/language-capability-manifest.ts
- common/src/util/language-profiles.ts
- common/src/util/engine-profiles.ts
- common/src/util/game-dev-presets.ts
- common/src/util/coding-harness.ts
- common/src/project-file-tree.ts
- common/src/util/sensitive-paths.ts
- agents/idioms/python.md
- agents/idioms/go.md
- agents/idioms/rust.md
- agents/idioms/cpp.md
- agents/idioms/swift.md
- agents/idioms/kotlin.md
- agents/idioms/java.md
- agents/idioms/csharp.md
- agents/idioms/php.md
- agents/idioms/typescript.md
- agents/idioms/ruby.md
- agents/idioms/gdscript.md
- .agents/sessions/polyglot-roadmap-v2/PLAN.md
- packages/agent-runtime/src/templates/strings.ts

### Domains
- security
- correctness
- state-mutation
- error-handling
- performance
- dependency-hygiene
- test-coverage
- api-contract
