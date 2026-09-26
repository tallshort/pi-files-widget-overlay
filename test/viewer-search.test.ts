import { describe, expect, it } from "vitest";

import { createViewerSearch } from "../src/viewer-search.ts";

describe("viewer search", () => {
  it("keeps ignored navigation input inert while editing", () => {
    const search = createViewerSearch();
    const lines = ["needle one", "other", "needle two"];

    expect(search.handleInput("needle", lines)).toEqual({ type: "editing", line: 0 });
    expect(search.move(1)).toBe(2);

    expect(search.handleInput("\u001b[A", lines)).toEqual({ type: "editing", line: null });
    expect(search.snapshot()).toEqual({ query: "needle", matchCount: 2, matchIndex: 1 });
  });
});
