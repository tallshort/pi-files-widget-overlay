# pi-files-widget-overlay

## Orient

- Read `README.md` for commands, user-facing behavior, and keybindings.
- Read `docs/DESIGN.md` before changing overlay lifecycle, browser/viewer state, Git integration, rendering, or comments.
- Read `TODO.md` when selecting follow-up work; mark an item complete only with implementation or coverage that proves it.
- Read `docs/BENCHMARKS.md` and run the benchmark only for performance work. Pass the private worktree through `READFILES_BENCH_ROOT`; never record its path, names, or contents.

## Layout

- `src/`: runtime extension. `src/index.ts` is the Pi package entry point.
- `test/`: Vitest regression coverage.
- `docs/`: design and benchmark records.
- `benchmarks/`: local harnesses; excluded from the published package.

## Change flow

1. Trace the affected user path before editing. Preserve source-aligned comments, diff selection independence, terminal-width safety, and stale-work isolation across re-roots.
2. Add or update focused regression coverage for behavior changes.
3. Run `npm test`, `npm run typecheck`, and `git diff --check`.
4. Update `README.md`, `docs/DESIGN.md`, `TODO.md`, or `CHANGELOG.md` only when the changed behavior makes that document stale.

## Release checks

- Keep `package.json` → `pi.extensions` pointing at the runtime entry point.
- Before publishing, run `npm pack --dry-run`; the package must exclude `test/`, `docs/`, and `benchmarks/`.
- Keep commits single-purpose; fold small follow-ups into their owning change when that preserves a clearer release history.
- Before committing, inspect `git status` and stage only files that belong to the change; leave unrelated untracked files untouched.
