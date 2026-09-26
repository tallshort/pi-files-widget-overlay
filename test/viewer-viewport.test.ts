import { describe, expect, it } from "vitest";

import { createViewerViewport } from "../src/viewer-viewport.ts";

describe("viewer viewport", () => {
  it("moves and selects by logical row groups instead of wrapped rows", () => {
    const viewport = createViewerViewport(4);
    viewport.setLayout([0, 0, 0, 1, 2, 2], 3);

    viewport.navigate({ type: "move", direction: 1 }, false);
    expect(viewport.snapshot().cursor).toBe(3);

    viewport.navigate({ type: "top" }, false);
    viewport.beginSelection();
    viewport.navigate({ type: "move", direction: 1 }, true);

    expect(viewport.selectionBounds()).toEqual({ start: 0, end: 1 });
    expect([0, 1, 2, 3].map(row => viewport.selectionMarker(row))).toEqual(["┃", "┃", "┃", "▸"]);
  });

  it("restores cursor and selection anchors against a replacement layout", () => {
    const viewport = createViewerViewport(4);
    viewport.setLayout([0, 0, 1, 2], 3);
    viewport.navigate({ type: "move", direction: 1 }, false);
    viewport.beginSelection();
    viewport.navigate({ type: "move", direction: 1 }, true);
    const anchor = viewport.captureAnchor();

    viewport.setLayout([0, 1, 1, 1, 2, 2], 3);
    viewport.restoreAnchor(anchor, true);

    expect(viewport.snapshot().cursor).toBe(4);
    expect(viewport.selectionBounds()).toEqual({ start: 1, end: 2 });
  });

  it("keeps the cursor visible when the viewport shrinks", () => {
    const viewport = createViewerViewport(6);
    viewport.setLayout([0, 1, 2, 3, 4, 5, 6, 7], 8);
    viewport.setPosition(5, 0);

    viewport.resize(3);

    expect(viewport.snapshot()).toEqual({ cursor: 5, scroll: 3, height: 3 });
  });
});
