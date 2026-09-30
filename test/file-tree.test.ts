import { join, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { buildFileTreeFromPaths } from "../src/file-tree.ts";

describe("file-tree path normalization", () => {
  it("handles dot-prefixed Git paths and platform-specific backslashes", () => {
    const rootPath = join("project", "root");
    const gitPath = sep === "\\" ? "src/nested/changed.ts" : "src\\nested\\changed.ts";
    const gitStatus = new Map([[gitPath, "M"]]);
    const diffStats = new Map([[gitPath, { additions: 2, deletions: 1 }]]);
    const root = buildFileTreeFromPaths(
      rootPath,
      ["./src\\nested\\changed.ts"],
      gitStatus,
      diffStats,
      new Set(),
      new Set()
    );

    const changed = sep === "\\" ? root.children?.[0]?.children?.[0]?.children?.[0] : root.children?.[0];
    expect(changed).toMatchObject({
      name: sep === "\\" ? "changed.ts" : "src\\nested\\changed.ts",
      path: sep === "\\" ? join(rootPath, "src", "nested", "changed.ts") : join(rootPath, "src\\nested\\changed.ts"),
      gitStatus: "M",
      diffStats: { additions: 2, deletions: 1 },
    });
  });

  it("deduplicates slash styles only when backslash is a separator", () => {
    const root = buildFileTreeFromPaths(
      "project",
      ["src/file.ts", "./src\\file.ts"],
      new Map(),
      new Map(),
      new Set(),
      new Set()
    );

    expect(root.children).toHaveLength(sep === "\\" ? 1 : 2);
    if (sep === "\\") expect(root.children?.[0]?.children).toHaveLength(1);
  });

  it("preserves trailing spaces and literal backslashes in POSIX Git filenames", () => {
    const root = buildFileTreeFromPaths("project", ["name ", "slash\\name"], new Map(), new Map(), new Set(), new Set());
    expect(root.children?.some(node => node.name === "name ")).toBe(true);
    if (sep === "/") expect(root.children?.some(node => node.name === "slash\\name")).toBe(true);
  });

  it("preserves a relative root when realpath resolution fails", () => {
    const rootPath = `missing-file-tree-root-${process.pid}`;
    const root = buildFileTreeFromPaths(rootPath, [], new Map(), new Map(), new Set(), new Set());

    expect(root.realPath).toBe(rootPath);
  });
});
