# Current historical decision excerpts

Source .agents/sessions/polyglot-roadmap-v2/SPEC.md. Amendments later in the same file supersede earlier wording.

218: | D31 | One secret-rule authority | gitleaks TOML codegen to TS and Rust plus configured `apiKeyEnv` values; consumers: env strip, redaction, outbound filter, staged gate, log sanitizer. No Go runtime sidecar. | P0-S1, P5-T5 |

219: | D32 | Parsed command policy now | TS tree-sitter-bash AST pre-check where ERROR = deny; read-only profile is an allowlist; per-agent permission profiles derived from templates/handoff. Shim parser choice is D40. | P0-S1, P4-T8 |

223: | D36 | Process-based subagent supervision | Supervision boundary is an OS process, not a Worker. | P2-T8 |

224: | D37 | Polyglot verification gate | Committed fixture repos + mise-pinned CI job; eval language strata; promotion requires no per-language regression; per-language mutation tools. | P8-T0, P8-T3, CI |

233: | D39 | CONFIRMED; additionally evaluate Inspect AI as a consumable harness. | Nothing in the fleet needs a Go-only library; Rust shim already provides isolation. | P8-T3 |

236: | D42 | CONFIRMED as written. | Warm servers only pay off if they outlive one CLI process and are shared across lanes. | P3-T1, P6-T5 |

237: | D43 | CONFIRMED, amended — Expo/React Native + react-native-libsodium (Noise over libsodium) + expo-secure-store; relay is Rust (snow), not Go. | One codebase reusing the generated Zod/ACP types beats two native apps for an approval UI. | P7-T4 |

238: | D44 | CONFIRMED, amended — also get listed in the existing third-party VS Code 'ACP Client' extension before authoring our own. | Kotlin/Lua/Elisp authorship buys little over existing clients. | P7-T1/T2/T3 |

239: | D45 | REPLACED by D47. | Avoids a second native layer under the TUI; OpenTUI already owns text buffers natively. Verify OpenTUI core scope before adopting. | D12, P7-T7 |

240: | D46 | AMENDED — oxc-parser/oxc-resolver confirmed (note the oxc-parser parseSync arena leak in long-lived processes); ruff is CLI/LSP-only (no library); biome only where the project already uses it; add @ast-grep/lang-* packs for non-JS languages. | Best-in-class analyzers already exist in Rust; tree-sitter stays the generic tier. | P3-T5, P3-T4 |

248: | D47 | Upgrade OpenTUI from 0.2.2 to 0.5.x and adopt its native Code/Markdown/Diff/TextTable renderables, TreeSitterClient highlighting and native grapheme width; no authored Zig. Amends P1-T6, P1-T10, P7-T7 and D45. | P1-T6, P1-T10, P7-T7 |

264: | D56 | Supervision process-boundary gaps are recorded as P2-T8 followup blockers (audit shard r4, 2026-10-09): (a) workspace-path leases live in a process-local Map with no fencing across the supervision boundary — the supervised child re-claims paths the parent holds; (b) `runSupervisedSubagent` returns the PRE-spawn agentState — the child's final messageHistory/workspaceState/taskMemory never flow back to the parent; (c) the parent's AbortSignal is not propagated to supervised children, so aborting a parent turn orphans running children; (d) restart-after-mutation can duplicate committed work without a replay fence. Each closes at P6-T5/D51 (daemon leases with fencing tokens) or a P2-T8 slice, whichever lands first. | P2-T8, P6-T5, D51 |
