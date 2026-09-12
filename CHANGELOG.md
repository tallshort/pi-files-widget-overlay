# Changelog

All notable changes to this extension will be documented in this file.

## [Unreleased]

## [0.6.1] - 2026-09-12

### Changed
- Add a compact Gallery preview image for the Pi Packages listing.

## [0.6.0] - 2026-09-12

### Added
- Let `p` temporarily toggle the wide-terminal browser tree/preview split.
- Let `?` toggle complete Browser and Viewer keybinding help.
- Let `@` filter browser files by literal content asynchronously.
- Restore the last `/readfiles` browse position within a Pi session.
- Copy selected Browser file or directory paths and current Viewer file paths with `y`.

### Fixed
- Keep expanded keybinding help within the overlay height when resizing Browser or Viewer panels.
- Replace unknown binary and terminal-control-character file content with safe metadata placeholders.
- Safely discard stale path-copy hints and sanitize unknown overlay errors.

### Changed
- Resolve Git-backed re-root metadata in the background and discard stale root results.
## [0.5.0] - 2026-09-11

### Fixed
- Position browser and viewer search cursors for IME composition; repeated `/` clears the query and Backspace cancels an empty search.
- Keep comment-editor left/right keys within the editor and use them to move its insertion cursor.
- Position the comment-editor cursor for IME composition, including after wrapped text or `█` in comment content.
- Use stable background-activity labels instead of animated spinner frames to avoid terminal refresh artifacts.
- Avoid double-counting staged Git diff statistics.

### Added
- Add `C` in viewer selection mode for whole-file comments without line context.

### Changed
- Make preview and viewer page keys scroll content by half a page; the viewer retains its cursor when possible and otherwise moves it to the first visible line.
- Show the current browser root and stable scan activity in the overlay title.
- Refresh Git metadata asynchronously so periodic updates do not block overlay rendering.
- Use argument-based Git commands and NUL-delimited metadata to preserve special-character and rename/copy paths.
- Add terminal key-sequence coverage and macOS/Linux CI for declared supported platforms.
## [0.4.0] - 2026-09-11

### Fixed
- Prevent image files from being decoded as text in the overlay; show a safe placeholder instead.
- Retain the current rendered-Markdown paragraph across terminal-width changes when a matching anchor is available.
- Keep browser selection, Git status, and comment cursors legible across terminal widths and themes.

### Changed
- Make viewer paging keys (`PgUp`/`PgDn`, `Ctrl-U`/`Ctrl-D`) move by half a page.
### Added
- Show a read-only 3:7 file preview beside the browser tree on wide terminals.
- Let preview navigation use `g/G`, `PgUp/PgDn`, `Ctrl-U/Ctrl-D`, and `w` without enabling edits.
- Support Vim-style `<count>G` jumps to logical lines in the viewer and preview.

## [0.3.0] - 2026-09-10

### Fixed
- Highlight and select every wrapped visual row of a logical line; comments retain logical source-line ranges.
- Make `c` and `C` share changed-only state while preserving collapsed and expanded changed-path views.
- Preserve logical cursor and selection groups across width changes and page navigation.
- Clear agent-modified file markers before a session switch.
- Keep Diff searches and comments anchored to logical Diff lines across word-wrap and width changes.
- Reset rendered Markdown selection to the first raw source line before creating a source-aligned comment.
- Schedule Git line counts by expanded directory instead of queueing every tracked file at startup.
- Keep confirmed file-viewer searches available to `n` and `N`.
- Track observed `edit.file` activity alongside `write.path` using normalized paths.
- Show non-blocking directory-scan and Git-metadata errors in the browser; verify Git metadata paths from repository subdirectories.

### Added
- Add Vitest coverage for wrapped-row grouping, logical-line navigation, selection, and comments.
- Add `C` to toggle the expanded changed view.
- Add `w` to toggle word wrap in the file viewer; wrapping is disabled by default.
- Show hidden project files such as `.pi/` and `.github/` while keeping `.git/` and common generated directories hidden.
- Add anonymous Git and non-Git browser performance benchmarks with a recorded baseline.

### Changed
- Forked `files-widget` as `pi-files-widget-overlay`; retain upstream MIT attribution and add tallshort copyright.
- Replace Delta's split line-number diff renderer with a compact unified view: explicit `+`/`-` markers and one relevant line number.
- Highlight the full width of the current line and selection; align the viewer and file-browser default overlay heights.
- Remove the Delta runtime dependency.
- Replace the README demo video with a static screenshot and add Pi Packages Gallery image metadata.

### Added
- `/readfiles` now supports browsing outside the current working directory. Press `u` to re-root to the parent, `.` to jump back to where you started, or pass an explicit starting path (`/readfiles <path>` or `/readfiles ~/somewhere`). The browser header shows the current root so you always know where you are, and comments on files outside the project use absolute paths so the agent can still find them.

### Fixed
- Git status, diff stats, and untracked-file discovery now work when the browser root is a subdirectory of the git repository (e.g. after `u`, `.`, or `/readfiles <subdir>`, or when pi runs from a repo subdirectory). Previously repo-root-relative git paths were mixed with root-relative node keys, producing phantom tree entries, missing statuses, and unopenable nested paths.
- Re-rooting the browser while a background directory scan or line-count batch is in flight no longer lets the stale batch mutate the new root's tree, node index, or scan state.
- Use `where` instead of `which` on Windows to detect `bat`, `delta`, and `glow`, so the dependency check works when running from PowerShell or cmd.exe.

## [0.1.21] - 2026-05-07

### Changed
- Declare `@earendil-works` Pi development dependencies used by runtime imports.
- Update Pi extension imports and peer dependencies to the new `@earendil-works` namespace.


## [0.1.20] - 2026-04-24

### Removed
- Remove the external `/readfiles-review` and `/readfiles-diff` commands so files-widget stays focused on the `/readfiles` browser/viewer.


## [0.1.18] - 2026-04-19

### Changed
- Show symlinks with a `↗` marker in the `/readfiles` tree.

### Fixed
- Let `/readfiles` navigate into directory symlinks in both non-git folders and git repos instead of rendering them as inert files or empty directories.
- Guard symlink directory scanning against ancestor cycles so links like `foo -> .` or `foo -> ..` don't recurse forever.
- Treat git-tracked and untracked directory symlinks as lazily scannable directories rather than plain files.

### Thanks
- Thanks to @xapids for reporting the original macOS symlink navigation issue ([#9](https://github.com/tmustier/pi-extensions/issues/9)).

## [0.1.17] - 2026-04-19

### Changed
- Make the inline comment editor multiline with wrapped footer rendering, `Enter` for a new line, and `Ctrl+Enter`/`Ctrl+D` to send.
- Add an `m` toggle for rendered vs raw Markdown in the viewer, and fall back to raw mode before line-based search or selection.
- Show a sent/queued confirmation toast after returning an inline comment to the agent.

### Thanks
- Thanks to avg8888 in the Pi Discord for surfacing the comment editor and Markdown review issues fixed in this release.

## [0.1.16] - 2026-04-19

### Fixed
- Let `/readfiles` browser search accept `j` and `k` as search text instead of hijacking them for navigation.
- Fix viewer scrolling so the last lines of a file remain reachable.
- Restore `G` / `Shift+G` navigation to jump to the bottom of the viewer.
- Refresh an open viewer when the file changes on disk while `/readfiles` is open.
- Accept pasted, multi-character, and chunked bracketed-paste input in browser search and the inline comment prompt.
- Keep viewer search results in sync after live refreshes.
- Pause live refresh while a line selection or inline comment is active so comments stay anchored to what the user selected.

## [0.1.14] - 2026-02-03

### Added
- Add preview video metadata for the extension listing.

## [0.1.13] - 2026-02-02

### Changed
- **BREAKING:** Renamed `/files` command to `/readfiles` to avoid conflict with Pi's new built-in `/files` command (Pi v0.50.2+)

## [0.1.11] - 2026-01-26

### Changed
- Require `bat`, `delta`, and `glow` before opening `/files`
- Add a postinstall reminder for required system tools
- Document install commands next to the Pi install steps

## [0.1.10] - 2026-01-26

### Fixed
- Treat git-reported directory entries as directories to avoid viewer errors
- Guard the viewer against opening directories directly
- Wrap delta diff output without breaking gutters and avoid truncation
- Add a safe fallback when `bat` fails to render with wrapping

## [0.1.9] - 2026-01-26

### Changed
- Bind render requests to avoid undefined context with the latest pi-tui

## [0.1.8] - 2026-01-26

### Changed
- Compute line counts asynchronously with loading indicators
- Build git repo trees from git file lists to avoid filesystem scans
- Add progressive filesystem scanning with safe mode for large folders
- Reduce refresh work to git metadata updates

## [0.1.7] - 2026-01-26

### Changed
- Cache line counts and skip large files to avoid freezes in big folders
- Avoid recomputing tree stats on every render
- Preserve line counts for open files across refreshes

## [0.1.6] - 2026-01-24

### Added
- Clearer install instructions and dependency notes in README

## [0.1.5] - 2026-01-24

### Added
- Demo recording embedded in README

### Changed
- Comment sending now queues with follow-up delivery in streaming sessions
- Split viewer logic into `viewer.ts` and shared helpers
- Reduced browser render duplication with node format helpers

## [0.1.4] - 2026-01-24

### Changed
- Split viewer logic into `viewer.ts` and shared helpers
- Reduced browser render duplication with node format helpers

## [0.1.3] - 2026-01-24

### Changed
- `c` in viewer now opens an inline comment prompt and sends a follow-up message

## [0.1.2] - 2026-01-24

### Changed
- `c` in viewer now appends selection to editor input instead of sending immediately

## [0.1.1] - 2026-01-24

### Added
- README with install steps, dependencies, and keybindings

### Changed
- Refactored into modular files (browser, git, tree, viewer, utils)

## [0.1.0] - 2026-01-24

### Added
- `/files` command opens full-screen file browser
- File tree with j/k navigation, Enter to open, h/l to collapse/expand
- File viewer with syntax highlighting via `bat`
- Markdown rendering via `glow`
- Git diff view via `delta` with line numbers
- Git status indicators (M, A, D, ?) on files
- Agent-modified file tracking (🤖 indicator)
- Changed files filter (`c` to toggle)
- Jump to next/prev changed file (`]`/`[`)
- Search in file tree (`/` then type)
- Search in file viewer (`/` then type, `n`/`N` for next/prev match)
- Select mode (`v`) to select lines and comment (`c`) to send to agent
- Line counts and diff stats (+/-) on files and collapsed folders
- Auto-refresh git status every 3 seconds (preserves expansion state)
- PageUp/PageDown support in browser and viewer
- Height adjustment (`+`/`-`)
- Works in non-git directories (git features gracefully disabled)

### Dependencies
- `bat` - syntax highlighting (recommended)
- `glow` - markdown rendering (recommended)
- `delta` - diff formatting (recommended)

Install with: `brew install bat git-delta glow`
