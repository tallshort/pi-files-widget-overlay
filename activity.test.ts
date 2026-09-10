import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { getObservedToolActivityPath } from "./activity.ts";

describe("observed tool activity paths", () => {
  const cwd = "/project";

  it("reads and normalizes write.path", () => {
    expect(getObservedToolActivityPath("write", { path: "src/index.ts" }, cwd)).toBe(resolve(cwd, "src/index.ts"));
  });

  it("reads and normalizes edit.file", () => {
    expect(getObservedToolActivityPath("edit", { file: "/tmp/example.ts" }, cwd)).toBe(resolve("/tmp/example.ts"));
  });

  it("ignores unsupported tools and malformed inputs", () => {
    expect(getObservedToolActivityPath("bash", { path: "script.ts" }, cwd)).toBeUndefined();
    expect(getObservedToolActivityPath("edit", { path: "missing-file-field.ts" }, cwd)).toBeUndefined();
    expect(getObservedToolActivityPath("write", { path: "   " }, cwd)).toBeUndefined();
  });
});
