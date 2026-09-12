# pi-files-widget-overlay — Design

## Purpose

`pi-files-widget-overlay` is a Pi extension for browsing files, inspecting unified diffs, selecting source-aligned text, and sending comments to the active agent. It opens as a modal-like floating overlay so the agent transcript remains visible and uninterrupted.

The extension is forked from `tmustier/pi-extensions`' `files-widget`, but its UI and rendering model are intentionally different.

## User experience

Run `/readfiles` to open the browser at the current working directory, or `/readfiles <path>` to start at an absolute, relative, or `~`-prefixed directory. The overlay is centered at 95% terminal width with a one-cell margin, title, and border.

The browser uses a 28-line content area by default. The viewer uses 29 lines by default; either can be resized with `+` and `-` within shared minimum and maximum bounds. The overlay header identifies the current browser root and shows scan activity without blocking input.

### Browser

- `j`/`k` and arrow keys move through the tree; `Enter`, `h`/`l`, and arrow keys open or collapse entries.
- Directory icons use `▸` and `▾`; symlink directories include a `↗` marker and can be traversed safely.
- `/` filters by filename; pressing `/` again clears the query, while `Esc` or `Backspace` on an empty query cancels search. `@` filters by literal file content using a cached per-root Pi SDK grep tool: it debounces input for 150 ms, limits context and result count, cancels pending work on query/root/overlay changes, and discards stale results. `?` toggles between a curated one-line hint and complete two-line browser keybindings. `c` toggles changed files, `C` toggles the expanded changed view (expanding all changed ancestors when enabled), and `[`/`]` move between changes.
- `u` re-roots at the parent directory and `.` returns to the starting directory.
- Closing the browser records its root, selected file, and that file's directory in extension memory. A no-argument reopen preserves the recorded root for `.` while locating the file selection or directory within it; the header briefly shows `↳ restored: <path>` until the next input. If the file is gone but its directory remains, it restores that directory. Explicit paths override it. This state is temporary for the Pi process, and a missing root or directory falls back to the default root.
- Git metadata refreshes asynchronously while the overlay is open. Re-rooting first shows a provisional tree, then resolves repository/status/diff/branch/file-list metadata in the background; results from an earlier root are discarded after re-rooting.
- A `🤖` marker records a file observed in a current-session `write` or `edit` tool result; it indicates tool activity, not authorship provenance. The marker clears when the session changes.
- On wide terminals, the browser uses a 3:7 tree and read-only preview split. `p` temporarily toggles that split; it resets when the overlay reopens and is a no-op on narrow terminals. The preview follows the selected item using viewer rendering; `g/G`, `PgUp/PgDn`, `Ctrl-U/Ctrl-D`, and `w` control its position or wrapping without allowing edits, searches, selection, comments, or mode changes. Preview page keys scroll its content by half a page without showing a cursor. Narrow terminals retain the single-column tree.

### Viewer and comments

- The viewer keeps a real line cursor. `j`/`k` move the cursor and scroll only as needed to keep it visible; the active line is highlighted. `PgUp`/`PgDn` and `Ctrl-U`/`Ctrl-D` scroll the viewport by half a page of rendered rows, retaining the cursor when it remains visible or moving it to the newly visible first logical line. `g`/`G` jump to the top/bottom, and a numeric prefix with `G` jumps to a logical line in the current view.
- Word wrap is disabled by default; `w` toggles it for code, diffs, and rendered Markdown.
- `/` opens viewer search; pressing `/` again clears the query, while `Esc` or `Backspace` on an empty query cancels it. `?` toggles between a curated one-line hint and complete two-line viewer keybindings.
- `v` starts or ends selection. The selection uses the existing gutter: `▸` marks the endpoint and `┃` marks the intervening lines.
- For Markdown, `m` toggles rendered and raw source. Searching or selecting rendered Markdown first switches to raw mode, keeping match positions and comments source-aligned. On a terminal-width change, the viewer restores the current paragraph by matching rendered text; if no match is available, it resets to the top.
- `d` toggles the unified diff of a changed tracked file. The extension removes Git's file headers and hunk metadata before displaying selectable diff lines. Comments use the visible diff excerpt and identify it as a diff comment rather than treating display positions as source line numbers.
- `c` opens a multiline comment editor for the selected lines. In selection mode, `C` opens the same editor for the whole file and sends `@file: comment` without line or selected-text context. `←`/`→` move the editing cursor; `Ctrl+Enter`, `Ctrl+D`, or supported `Alt+Enter` sends the comment. When Pi is streaming, the comment is queued as a follow-up; otherwise it is sent immediately.
- In normal viewer mode, `q`, `Esc`, or `←` return to the browser. `Esc` leaves selection or cancels the comment editor; `q` or `Esc` from the browser closes the overlay.

## Architecture

```text
src/index.ts
  └─ registers /readfiles and hosts ctx.ui.custom(..., { overlay: true })
       └─ src/browser.ts
            ├─ src/file-tree.ts: tree nodes, scans, symlink handling, line counts
            ├─ src/git.ts: Git status, lists, stats, and repository-root translation
            └─ src/viewer.ts
                 ├─ src/file-viewer.ts: Pi-highlighted code, Pi Markdown, unified diff
                 └─ src/comment.ts: source and diff comment message formatting
```

`src/index.ts` owns the overlay lifecycle and a periodic render request. `src/browser.ts` owns browser state, asynchronous scan generations, and routes input to `src/viewer.ts` while a file is open. `src/viewer.ts` owns cursor, viewport, selection, search, Markdown mode, comment-editor state, and viewer navigation.

## Rendering and dependencies

The extension has no external runtime dependency beyond Pi and Node's built-in modules:

- Code uses Pi's `highlightCode()` and the active Pi theme.
- Markdown uses Pi TUI's `Markdown` renderer and Pi's Markdown theme.
- Diffs are generated with argument-based Git commands and parsed from NUL-delimited metadata, preserving special-character and rename/copy paths; unified-diff lines are then colored with Pi theme tokens.
- Git is optional: browsing and normal file viewing still work outside a repository.
- Images, unknown binary data, and terminal-control characters never reach the renderer; the viewer shows a size-bearing metadata placeholder instead.
This replaces the upstream use of `bat`, `glow`, and `delta`, avoiding tool-specific palettes and making code, Markdown, and diffs follow the active Pi theme.

## Design constraints

- Preserve source alignment for every selectable normal-file and Markdown line.
- Keep diff selection independent from source-file line mapping.
- Keep terminal rendering width-safe by truncating borders and wrapping content with ANSI-aware helpers.
- Never let a background scan from an old root modify a newly re-rooted browser.
- Degrade gracefully when Git metadata or a filesystem operation is unavailable.
