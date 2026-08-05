# LESSONS — Terminal policy repair

## Lessons captured during planning
- Segment-parsed safety detectors must fail closed: `segments?.some(unsafe) ?? false` is a fail-open hole whenever the segment splitter returns undefined (background `&`, empty segments from trailing/leading `;`, `;;`). Read-only profile already denies on `!segments`; tmux-test detectors skipped that posture.
- Blanket-bans vs. composition-aware checks: removing the raw-newline ban was correct UX, but every downstream guard that parsed "commands" needed re-auditing for the new separator class. Policy changes that widen the input alphabet must be paired with a fail-open review of all segment consumers.
- Reviewer findings are snapshot-bound and RF-ID-keyed: they cannot be cleared conversationally; each repair edit must cite the finding IDs, and only a fresh matching reviewer pass clears them.
- repair-editor requires the structured `handoff` object, not a bare prompt — a prompt-only spawn failed handler validation.
- Consistency between allow guards and message helpers matters: the allow regex accepted only `-m` while placeholder/strip helpers already handled `--message`/`--message=`, producing a confusing generic deny for a documented form.

## Gotchas for execution
- `splitReadOnlyShellSegments` treats `\r\n` as one separator; any new test with CRLF should account for that.
- Existing positive tmux-test tests (`normalizes tmux executable quoting…`, `applies outside-absolute-path containment…`) are the regression canary for fail-closed changes.
- `\r|\n` multi-line composition under validation-diagnosis is intentionally still fail-closed unless it matches the bounded `cat > file <<'EOF'…EOF` heredoc — do not loosen this while fixing tmux-test.
