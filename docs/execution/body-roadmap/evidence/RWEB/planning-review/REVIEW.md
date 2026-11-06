# Researcher-web / agent-browser plan — independent approval

Reviewer `/root/first_wave_architect`; plan author `/root`. Decision: **approve the current plan architecture and registry consistency**. This is planning approval only, with no browser implementation, installation, prototype or B33 acceptance.

The four reviewed planning files are `README.md`, `execution-plan.json`, `researcher-web-agent-browser.md` and `researcher-web-agent-browser.sources.json` under `docs/execution/body-roadmap/`. Their exact hashes are sealed in `inspection.json` and `review.json`. The frozen PLAN/SPEC and exact eight-card candidate remain unchanged.

The plan addresses the actual gap: researcher-web currently exposes only web_search and set_output, with a model-driven search/read loop and no rendered-page actions. The URL path fetches bounded static content. The initial claim that search used Open Websearch was traced past its stale handler comment to the actual bounded DuckDuckGo HTML helper, reported to the author, and corrected before approval. `initial-observation.json` and `initial-addendum.md` retain the original finding. The user's rate-limit symptom still has no independently established live cause, and the plan does not claim that adopting a browser removes site throttling, authentication or CAPTCHA.

The task decomposition is coherent:

- RWEB-0 independently establishes feasibility, an exact distribution/native/browser manifest and a version-matched catalog before implementation commitments.
- RWEB-1 consumes B19 execution authority, B20 resource settlement and B28 result/catalog fidelity before a managed adapter ships.
- RWEB-2 adds the researcher strategy; RWEB-3 adds source/artifact/client delivery while consuming B03/B05.
- RWEB-4 requires the prior tasks and all base B33 prerequisites, plus real installed SDK/CLI browser/citation/cleanup evidence.

All five tasks remain planned. An independent graph walk verifies known acyclic dependencies, RWEB-0 as the sole independently ready preparation task, the existing 39 completion nodes and B33 still pending. RWEB tasks are requirements within B33, not new accepted completion nodes. The registry's acceptance rule requires every RWEB task and base oracle before future B33 acceptance. That future evidence-gate integration remains implementation work; the unchanged eight-card validator is not being credited with enforcing an addendum it does not yet consume.

The proposed adapter boundary preserves the important distinctions: direct text reading versus rendered DOM versus interactive snapshots; host-owned session authority versus page or agent claims; error/coverage states versus permission to continue; immutable artifacts versus transport metadata; and upstream command timeout versus observed run-owned browser/daemon cleanup. Explicit backend selection, honest fallback, scoped cache/freshness and per-host cooldown make the workflow usable without silently selecting cloud providers, installing tools or reusing personal profiles. Redirect/subresource egress, stale references, concurrent runs and cancellation are included in the acceptance controls.

`verify-plan.py` independently verifies all four current plan files, seven bound local sources, five task dependencies and 11 local links. The author's separate mechanical-check result also matches the current hashes. No agent-browser executable was found on this reviewer's PATH, and no browser workflow or upstream command was executed by this reviewer. The earlier upstream-main `0.41.2` / Node >=22 observation remains historical candidate context, not a registry-verified distribution or installation proof. The leader reports a later published-distribution metadata observation requiring Node >=24; that separate RWEB-0 feasibility evidence must determine the actual selected artifact/runtime. This planning approval does not merge those two observations or certify the distribution.

No blocking planning issue remains after the factual correction. RWEB-0 can proceed independently under its stated scope. Subsequent integration needs real pinned tool acquisition, compatible wrapper/native selection, actual local browser probes and the required independent consumer/cleanup oracle. Improved live research quality remains a separate B30/B31 measurement claim.
