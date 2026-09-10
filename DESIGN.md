# pi-files-widget-overlay — Design

## Purpose

`pi-files-widget-overlay` is a Pi extension for browsing files, inspecting unified diffs, selecting source-aligned text, and sending comments to the active agent. It opens as a modal-like floating overlay so the agent transcript remains visible and uninterrupted.

The extension is forked from `tmustier/pi-extensions`' `files-widget`, but its UI and rendering model are intentionally different.

## User experience

Run `/readfiles` to open the browser at the current working directory, or `/readfiles <path>` to start at an absolute, relative, or `~`-prefixed directory. The overlay is centered at 95% terminal width with a one-cell margin, title, and border.

The browser uses a 28-line content area by default. The viewer uses 29 lines by default; either can be resized with `+` and `-` within shared minimum and maximum bounds.

### Browser

- `j`/`k` and arrow keys move through the tree; `Enter`, `h`/`l`, and arrow keys open or collapse entries.
- Directory icons use `▸` and `▾`; symlink directories include a `↗` marker and can be traversed safely.
- `/` filters the displayed list, `c` toggles changed files, `C` toggles the expanded changed view (expanding all changed ancestors when enabled), and `[`/`]` move between changes.
- `u` re-roots at the parent directory and `.` returns to the starting directory.
- Git metadata refreshes while the overlay is open. Large non-Git trees scan progressively and display their partial state.

### Viewer and comments

- The viewer keeps a real line cursor. Navigation moves the cursor and scrolls only as needed to keep it visible; the active line is highlighted.
- Word wrap is disabled by default; `w` toggles it for code, diffs, and rendered Markdown.
- `v` starts or ends selection. The selection uses the existing gutter: `▸` marks the endpoint and `┃` marks the intervening lines.
- For Markdown, `m` toggles rendered and raw source. Searching or selecting rendered Markdown first switches to raw mode, keeping match positions and comments source-aligned.
- `d` toggles the unified diff of a changed tracked file. The extension removes Git's file headers and hunk metadata before displaying selectable diff lines. Comments use the visible diff excerpt and identify it as a diff comment rather than treating display positions as source line numbers.
- `c` opens a multiline comment editor. `Ctrl+Enter`, `Ctrl+D`, or supported `Alt+Enter` sends the comment. When Pi is streaming, the comment is queued as a follow-up; otherwise it is sent immediately.
- `q`, `Esc`, or `←` return from the viewer to the browser. `q` or `Esc` from the browser closes the overlay.

## Architecture

```text
index.ts
  └─ registers /readfiles and hosts ctx.ui.custom(..., { overlay: true })
       └─ browser.ts
            ├─ file-tree.ts: tree nodes, scans, symlink handling, line counts
            ├─ git.ts: Git status, lists, stats, and repository-root translation
            └─ viewer.ts
                 ├─ file-viewer.ts: Pi-highlighted code, Pi Markdown, unified diff
                 └─ comment.ts: source and diff comment message formatting
```

`index.ts` owns the overlay lifecycle and a periodic render request. `browser.ts` owns browser state, asynchronous scan generations, and routes input to `viewer.ts` while a file is open. `viewer.ts` owns cursor, viewport, selection, search, Markdown mode, comment-editor state, and viewer navigation.

## Rendering and dependencies

The extension has no external runtime dependency beyond Pi and Node's built-in modules:

- Code uses Pi's `highlightCode()` and the active Pi theme.
- Markdown uses Pi TUI's `Markdown` renderer and Pi's Markdown theme.
- Diffs are generated with `git diff --no-color`, parsed into unified-diff lines, and colored with Pi theme tokens.
- Git is optional: browsing and normal file viewing still work outside a repository.

This replaces the upstream use of `bat`, `glow`, and `delta`, avoiding tool-specific palettes and making code, Markdown, and diffs follow the active Pi theme.

## Design constraints

- Preserve source alignment for every selectable normal-file and Markdown line.
- Keep diff selection independent from source-file line mapping.
- Keep terminal rendering width-safe by truncating borders and wrapping content with ANSI-aware helpers.
- Never let a background scan from an old root modify a newly re-rooted browser.
- Degrade gracefully when Git metadata or a filesystem operation is unavailable.
