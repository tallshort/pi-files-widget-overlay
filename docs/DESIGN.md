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
- `/` filters by filename; pressing `/` again clears the query, `Esc` cancels active search, and `Backspace` cancels when the query is empty. `Enter` returns to the normal browser help while the header displays a retained query as `/foo (Esc clears)` or `@foo (Esc clears)`. After `Enter` confirms a retained browser query, `Esc` clears it before the next `Esc` closes the overlay. `@` filters by literal file content using a cached per-root Pi SDK grep tool: it debounces input for 150 ms, limits context and result count, cancels pending work on query/root/overlay changes, and discards stale results. `y` copies the selected file or directory's absolute path. `?` toggles between a curated one-line hint and complete two-line browser keybindings. `c` toggles changed files and `C` toggles the expanded changed view within the current search results when a search is retained; `[`/`]` move between changed files within those results.
- `u` re-roots at the parent directory and `.` returns to the starting directory.
- Browse-position restoration is disabled by default. Users can opt in through the global Pi settings file, which the extension reads but never writes:

  ```json
  {
    "piFilesWidgetOverlay": {
      "restoreBrowsePosition": true
    }
  }
  ```

  With that setting in Pi's global settings file (`$PI_CODING_AGENT_DIR/settings.json`, defaulting to `~/.pi/agent/settings.json`), each single-root command root has an independent extension-memory record of its root, selected file, and that file's directory. A reopen resolves the command root first, then restores only that root's record while preserving it for `.`; the header briefly shows `↳ restored: <path>` until the next input. Equivalent path spellings share the normalized absolute-path record. If the file is gone but its directory remains, it restores that directory. A multi-root command may restore a valid existing record for its first root, but does not save multi-root state on close. This state is temporary for the Pi process, and a missing root or directory falls back to the command root.
- Git metadata refreshes asynchronously while the overlay is open. Re-rooting first shows a provisional tree, then resolves repository/status/diff/branch/file-list metadata in the background; results from an earlier root are discarded after re-rooting.
- A `🤖` marker records a file observed in a current-session `write` or `edit` tool result; it indicates tool activity, not authorship provenance. The marker clears when the session changes.
- On wide terminals, the browser uses a 3:7 tree and read-only preview split. `p` temporarily toggles that split; it resets when the overlay reopens and is a no-op on narrow terminals. The preview follows the selected item using viewer rendering; `g/G`, `PgUp/PgDn`, `Ctrl-U/Ctrl-D`, and `w` control its position or wrapping without allowing edits, searches, selection, comments, or mode changes. Preview page keys scroll its content by half a page without showing a cursor. Narrow terminals retain the single-column tree.

### Viewer and comments

- The viewer keeps a real line cursor. `j`/`k` move the cursor and scroll only as needed to keep it visible; the active line is highlighted. `PgUp`/`PgDn` and `Ctrl-U`/`Ctrl-D` scroll the viewport by half a page of rendered rows, retaining the cursor when it remains visible or moving it to the newly visible first logical line. `g`/`G` jump to the top/bottom, and a numeric prefix with `G` jumps to a logical line in the current view.
- Word wrap is disabled by default; `w` toggles it for code, diffs, and rendered Markdown.
- `/` opens viewer search; pressing `/` again clears the query, `Esc` cancels active search, and `Backspace` cancels when the query is empty. `Enter` returns to normal viewer help while the header displays a retained query as `/foo (Esc clears)` with its match position, including `[0/0]` when no line matches. The next `Esc` clears a retained query; a further `Esc` returns to the browser. `?` toggles between a curated one-line hint and complete two-line viewer keybindings.
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

## Multi-root browsing

Pi exposes one `ctx.cwd`, not a workspace-root list, so `/readfiles` does not infer roots from Git worktrees, parent directories, or sibling repositories.

### Root model

The multi-root overlay has a small root-anchor interface:

```ts
type RootAnchor = {
  id: string;    // normalized absolute path
  path: string;
  label: string;
};
```

Command roots come directly from `/readfiles` arguments: `/readfiles <path...>` accepts whitespace-separated roots and quoted paths, resolving them relative to `ctx.cwd`. Every command appends accessible user-pinned roots from global `piFilesWidgetOverlay.pinnedRoots` after its command roots; without explicit paths, `ctx.cwd` is the first command root. Paths are normalized and de-duplicated, inaccessible pins remain stored but are skipped with a notice, and pins do not resolve symlink targets. The first command root is initially active; duplicate labels include parent segments.

### Interaction and state

In normal browser mode, `Tab` switches to the next root and `Shift-Tab` switches to the previous root. `*` pins or unpins the selected directory (or selected file's parent), immediately updating default roots and showing a transient result. Unpinning the current root leaves it available only for the current overlay session. An unavailable root reports an error without changing the active root. A single-root overlay leaves Tab keys as no-ops. The header adds a compact anchor badge only in multi-root mode, for example `Files — [API 2/3] /workspace/service-api`.

A root anchor differs from the current browsing root. `u` may still temporarily re-root to a parent directory, while `.` returns to the active anchor. Each anchor retains its directory and selected file only for the active overlay; switching back restores those locations but not viewer, scrolling, diff, selection, search, filtering, or expansion state. In multi-root mode, the extension may initialize the first anchor from a valid existing single-root browse record, but it does not retain an active anchor, per-anchor position, or any other multi-root state after the overlay closes. The next invocation without a valid first-root record starts at its command root. Existing explicit single-path behavior remains unchanged.

`browser.ts` is the seam for root switching: it already owns root-local tree, Git, scan, grep, viewer, and generation state. A future `switchRoot()` must validate the target before changing state, capture the departing anchor's location, close viewer and preview, clear root-local UI state, increment generations, then load the new provisional tree. Background filesystem, LOC, Git, and grep work must verify both generation and active root before changing state. Current-session observed tool activity remains shared because it uses absolute paths.

The first implementation must not create a virtual merged tree, cross-root search or changed-file navigation, multi-repository Git aggregation, automatic root discovery, or persistent active-root state.
