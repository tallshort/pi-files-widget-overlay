# pi-files-widget-overlay — Backlog

This is the backlog for the current floating-overlay implementation, not the historical upstream widget plan.

## Completed foundation

- [x] `/readfiles [path]` opens a centered, framed overlay and supports absolute, relative, and `~` paths.
- [x] Browse, expand, collapse, search, and re-root directories; directory symlinks are visible and traversable.
- [x] Show Git status, diff statistics, line counts, changed-only filtering, `C` expansion of changed ancestors, and changed-file navigation.
- [x] Use Pi's code highlighter, Markdown renderer, and theme colors without `bat`, `glow`, or `delta` runtime dependencies.
- [x] Provide a line cursor, source-aligned selection, inline comments, and follow-up delivery while the agent is working.
- [x] Render unified diffs internally and send selected visible diff text as a diff comment.
- [x] Progressively scan large non-Git directories and avoid stale scan results after re-rooting.

## Next improvements

### Usability

- [ ] Show non-blocking errors for directory scan/expansion failures and Git metadata failures inside confirmed Git repositories; preserve browsing and distinguish valid empty and non-Git states.

### Performance and reliability

- [ ] Add reproducible large Git and non-Git tree benchmarks covering time-to-first-usable-render, input latency, scan completion, and LOC batching; record a baseline before tuning.
- [ ] Verify re-rooting discards stale directory-scan and LOC results.
- [ ] Verify ancestor symlink cycles terminate safely.
- [ ] Verify Git status, stats, and diffs use correct paths from repository subdirectories.
- [x] Add coverage for wrapped lines, logical-line navigation, selection, comments, Diff search, and Diff comment ranges.
- [x] Add coverage for rendered-to-raw Markdown selection boundaries and rendered Markdown word-wrap toggling.
- [ ] Preserve the visible rendered-Markdown paragraph across resize when deterministic renderer anchors are available; otherwise document and test the fallback reset behavior.
- [ ] Add diff-view and selection coverage for staged modifications, staged-added files, and files with both staged and unstaged changes; keep untracked files in normal view.
- [ ] Add platform-neutral tests for path normalization and terminal key sequences; add OS-specific CI only for platforms declared supported in the README.

### Agent-awareness

- [x] Make current-session agent activity tracking complete and explicit: handle `write.path` and `edit.file`, normalize paths, and label it as observed tool activity rather than human-vs-agent provenance.
