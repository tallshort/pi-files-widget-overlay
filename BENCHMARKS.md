# Readfiles performance baseline

All values are aggregate timings in milliseconds. The private Git worktree's path, names, and contents are intentionally not recorded.

| Scenario | First usable render | Navigation median | Navigation p95 | Metadata idle |
| --- | ---: | ---: | ---: | ---: |
| Private Git worktree | 1,836.99 | 0.08 | 0.13 | 303.67 |
| Synthetic non-Git fixture | 3.61 | 0.01 | 0.02 | 4,502.05 |

Git worktrees count direct files at the root first, then count direct files when a directory is expanded. This keeps initial metadata work bounded while preserving on-demand line counts.

Run `READFILES_BENCH_ROOT=<local-git-worktree> npm run benchmark:readfiles` to produce a fresh anonymous result. The command emits only aggregate timings.
