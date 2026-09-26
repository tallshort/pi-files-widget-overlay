import { describe, expect, it } from "vitest";

import { classifyBrowserInput } from "../src/browser-input.ts";
import { createBrowserQuery } from "../src/browser-query.ts";

const activeBrowser = { queryActive: false, multipleRoots: true, previewActive: true };

describe("browser input precedence", () => {
  it("classifies root switching before all lower browser layers", () => {
    expect(classifyBrowserInput("\t", activeBrowser)).toEqual({ type: "switch-root", direction: 1 });
    expect(classifyBrowserInput("\u001b[Z", activeBrowser)).toEqual({ type: "switch-root", direction: -1 });
  });

  it("routes preview navigation before normal tree commands", () => {
    expect(classifyBrowserInput("\u001b[6~", activeBrowser)).toEqual({ type: "preview-input" });
    expect(classifyBrowserInput("g", activeBrowser)).toEqual({ type: "preview-input" });
    expect(classifyBrowserInput("w", activeBrowser)).toEqual({ type: "preview-input" });
  });

  it("keeps close, search entry, and active-query input in their established order", () => {
    expect(classifyBrowserInput("q", activeBrowser)).toEqual({ type: "close" });
    expect(classifyBrowserInput("/", activeBrowser)).toEqual({ type: "start-search", kind: "filename" });
    expect(classifyBrowserInput("@", activeBrowser)).toEqual({ type: "start-search", kind: "content" });

    const searching = { ...activeBrowser, queryActive: true };
    expect(classifyBrowserInput("\t", searching)).toEqual({ type: "query-input" });
    expect(classifyBrowserInput("q", searching)).toEqual({ type: "query-input" });
    expect(classifyBrowserInput("/", searching)).toEqual({ type: "query-input" });
    expect(classifyBrowserInput("\u001b", searching)).toEqual({ type: "escape" });
  });
});

describe("browser query effects", () => {
  it("owns query editing while describing content-search work declaratively", () => {
    const query = createBrowserQuery();
    query.start("content");

    expect(query.handleInput("n")).toEqual({ type: "changed", resetSelection: true, contentSearch: "schedule" });
    expect(query.snapshot()).toEqual({ query: "n", active: true, kind: "content" });
    expect(query.handleInput("\u007f")).toEqual({ type: "changed", resetSelection: true, contentSearch: "clear" });
    expect(query.handleInput("\u007f")).toEqual({ type: "cancel" });
    expect(query.snapshot()).toEqual({ query: "", active: false, kind: "content" });
  });
});
