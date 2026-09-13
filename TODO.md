# pi-files-widget-overlay — Backlog

This is the backlog for the current floating-overlay implementation, not the historical upstream widget plan.

## Completed foundation

- [x] `/readfiles [path]` opens a centered, framed overlay, supports absolute, relative, and `~` paths, and identifies the current root plus scan activity in its header.
- [x] Browse, expand, collapse, search, and re-root directories; directory symlinks are visible and traversable.
- [x] Show Git status, diff statistics, line counts, changed-only filtering, `C` expansion of changed ancestors, and changed-file navigation.
- [x] Use Pi's code highlighter, Markdown renderer, and theme colors without `bat`, `glow`, or `delta` runtime dependencies.
- [x] Provide a line cursor, source-aligned selection, inline comments with an editable insertion cursor, file-level comments, and follow-up delivery while the agent is working.
- [x] Render unified diffs internally and send selected visible diff text as a diff comment.
- [x] Progressively scan large non-Git directories and avoid stale scan results after re-rooting.

## Next improvements

### Usability

- [x] Show non-blocking errors for directory scan/expansion failures and Git metadata failures inside confirmed Git repositories; preserve browsing and distinguish valid empty and non-Git states.
- [x] Add a read-only, responsive browser preview: use a 3:7 tree/preview split on wide terminals; fall back to the existing single-column tree on narrow terminals; support preview jumps, half-page scrolling, and wrapping.
- [x] Keep browser and viewer search input IME-aligned; let repeated `/` clear the query and Backspace cancel an empty search.

### Performance and reliability

- [x] Add reproducible large Git and non-Git tree benchmarks covering time-to-first-usable-render, input latency, scan completion, and LOC batching; record a baseline before tuning.
- [x] Verify re-rooting discards stale directory-scan and LOC results.
- [x] Verify ancestor symlink cycles terminate safely.
- [x] Verify Git status, stats, and diffs use correct paths from repository subdirectories.
- [x] Add coverage for wrapped lines, logical-line navigation, selection, comments, Diff search, and Diff comment ranges.
- [x] Add coverage for rendered-to-raw Markdown selection boundaries and rendered Markdown word-wrap toggling.
- [x] Preserve the visible rendered-Markdown paragraph across resize when deterministic renderer anchors are available; otherwise document and test the fallback reset behavior.
- [x] Add diff-view and selection coverage for staged modifications, staged-added files, and files with both staged and unstaged changes; keep untracked files in normal view.
- [x] Add platform-neutral tests for path normalization.
- [x] Add terminal key-sequence tests for public navigation, editing, and modifier keys; declare macOS/Linux support and run both in CI.
- [x] Harden Git path handling: use argument-based commands and NUL-delimited status/numstat parsing for safe special-character and rename/copy paths.
- [x] Refresh Git metadata asynchronously, preserving responsive input and discarding stale results after re-rooting.
- [x] Make Git-backed re-rooting asynchronous: avoid synchronous repository/status/diff/branch/file-list commands in `loadRoot`, preserve a responsive provisional tree, and discard stale results when roots change again.
- [x] Safely identify unknown binary and terminal-control-character files before rendering; show a metadata placeholder rather than decoding or emitting unsafe bytes.

### Agent-awareness

- [x] Make current-session agent activity tracking complete and explicit: handle `write.path` and `edit.file`, normalize paths, and label it as observed tool activity rather than human-vs-agent provenance.

## Planned work

### Performance

- [x] Confirm browser modules are already lazy-loaded: `src/index.ts` dynamically imports `./browser` only inside the `/readfiles` handler, so tree, viewer, Git, and search modules do not load at extension startup. No equivalent startup optimization remains in this module graph.

### Usability

- [x] Add a temporary `p` browser shortcut to toggle the wide-terminal 3:7 tree/preview split. The tree uses full width when disabled; narrow-terminal auto-disable behavior remains unchanged and state resets on reopen.
- [x] Replace truncated keybinding hints with a curated one-line default and temporary `?` toggle for the complete two-line keybinding help in both browser and viewer. Keep view-specific curated keys, reset on reopen, and preserve existing bindings such as `h`.
- [x] Add opt-in, session-scoped `/readfiles` browse-position memory via the global `piFilesWidgetOverlay.restoreBrowsePosition` setting: on close, retain the current root, directory, and selected file only in extension memory; on reopen, restore the recorded directory or the selected file's parent directory and selection. Do not persist to disk or restore scrolling/cursor state. Fall back to the recorded directory when only its file is unavailable, then to the requested/default root when the recorded root or directory is unavailable; handle a future different multi-root gracefully.
- [ ] Add optional inline image previews for supported terminal protocols using Pi `>=0.84.4`: detect supported image MIME types, cap source files at 10 MiB (`10 * 1024 * 1024` bytes), enforce conservative rendered dimensions, and retain the current safe metadata placeholder for unsupported terminals, oversized files, unknown formats, and errors. Cover capability and fallback behavior.

### Design evaluation (not scheduled)

- [ ] Evaluate multi-root `/readfiles` support before implementation: decide how roots are defined (arguments, config, or runtime), whether `Tab` cycles or opens a picker, header/position presentation, and missing-root/root-switch reset behavior. Preserve single-root compatibility and keep the selected root temporary.
- [x] Add an `@` content filter alongside filename `/` search, using cached SDK `createGrepTool` with bounded, context-free asynchronous results and cancellation. By design it filters files only; use Viewer `/` to locate individual matches.
- [x] Add a `y` shortcut to copy the selected Browser file or directory and current Viewer file absolute path. Show a dim `Path copied` transient hint in the relevant title area, auto-dismiss it after a few seconds, and add no dependencies.
