import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildFileTreeFromPaths } from "../src/file-tree.ts";

describe("file-tree path normalization", () => {
  it("normalizes dot-prefixed Windows-style paths and preserves Git metadata", () => {
    const rootPath = join("project", "root");
    const gitStatus = new Map([["src/nested/changed.ts", "M"]]);
    const diffStats = new Map([["src/nested/changed.ts", { additions: 2, deletions: 1 }]]);
    const root = buildFileTreeFromPaths(
      rootPath,
      ["./src\\nested\\changed.ts"],
      gitStatus,
      diffStats,
      new Set(),
      new Set()
    );

    const src = root.children?.[0];
    const nested = src?.children?.[0];
    const changed = nested?.children?.[0];
    expect(changed).toMatchObject({
      name: "changed.ts",
      path: join(rootPath, "src", "nested", "changed.ts"),
      gitStatus: "M",
      diffStats: { additions: 2, deletions: 1 },
    });
  });

  it("deduplicates equivalent slash styles into one file node", () => {
    const root = buildFileTreeFromPaths(
      "project",
      ["src/file.ts", "./src\\file.ts"],
      new Map(),
      new Map(),
      new Set(),
      new Set()
    );

    expect(root.children?.[0]?.children).toHaveLength(1);
  });
});
