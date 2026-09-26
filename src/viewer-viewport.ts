export type ViewportNavigation =
  | { type: "move"; direction: 1 | -1 }
  | { type: "page"; direction: 1 | -1 }
  | { type: "top" }
  | { type: "bottom" }
  | { type: "line"; lineNumber: number };

export interface ViewportSnapshot {
  scroll: number;
  cursor: number;
  height: number;
}

export interface ViewportAnchor {
  cursorGroup: number;
  selectStartGroup: number;
  selectEndGroup: number;
}

export interface ViewerViewport {
  reset(): void;
  setLayout(rowGroups: readonly number[], logicalLineCount: number): void;
  snapshot(): ViewportSnapshot;
  captureAnchor(): ViewportAnchor;
  restoreAnchor(anchor: ViewportAnchor, preserveSelection: boolean): void;
  setPosition(cursor: number, scroll?: number): void;
  revealGroup(group: number, scrollOffset: number): void;
  navigate(command: ViewportNavigation, selecting: boolean): void;
  beginSelection(): void;
  clearSelection(): void;
  selectionBounds(): { start: number; end: number };
  selectionMarker(row: number): "┃" | "▸" | null;
  isCursorGroup(row: number): boolean;
  resize(height: number): void;
  appendCount(digit: string): void;
  takeCount(): number | null;
  clearCount(): void;
}

export function createViewerViewport(initialHeight: number): ViewerViewport {
  let rowGroups: readonly number[] = [];
  let logicalLineCount = 0;
  let scroll = 0;
  let cursor = 0;
  let height = initialHeight;
  let selectStart = 0;
  let selectEnd = 0;
  let pendingCount = "";

  const rowGroup = (index: number): number => rowGroups[index] ?? index;

  const groupStart = (row: number): number => {
    const group = rowGroup(row);
    while (row > 0 && rowGroup(row - 1) === group) row--;
    return row;
  };

  const groupEnd = (row: number): number => {
    const group = rowGroup(row);
    while (row + 1 < rowGroups.length && rowGroup(row + 1) === group) row++;
    return row;
  };

  const firstRowForGroup = (group: number): number => {
    const row = rowGroups.indexOf(group);
    return row === -1 ? Math.min(Math.max(0, group), Math.max(0, rowGroups.length - 1)) : row;
  };

  const maxScroll = (): number => Math.max(0, rowGroups.length - height);

  const clampScroll = (): void => {
    scroll = Math.min(maxScroll(), Math.max(0, scroll));
  };

  const ensureCursorVisible = (): void => {
    cursor = Math.min(Math.max(0, cursor), Math.max(0, rowGroups.length - 1));
    if (cursor < scroll) scroll = cursor;
    if (cursor >= scroll + height) scroll = cursor - height + 1;
    clampScroll();
  };

  const stepGroup = (row: number, direction: 1 | -1): number | null => {
    const next = direction > 0 ? groupEnd(row) + 1 : groupStart(row) - 1;
    return next >= 0 && next < rowGroups.length ? next : null;
  };

  const moveByGroups = (direction: 1 | -1, count: number, selecting: boolean): void => {
    const selectionFloor = groupStart(selectStart);
    for (let step = 0; step < count; step++) {
      const from = selecting ? selectEnd : cursor;
      const next = stepGroup(from, direction);
      if (next === null || (selecting && next < selectionFloor)) break;
      cursor = next;
      if (selecting) selectEnd = next;
    }
    ensureCursorVisible();
  };

  const moveViewport = (direction: 1 | -1): void => {
    const count = Math.max(1, Math.floor(height / 2));
    const nextScroll = scroll + direction * count;
    scroll = groupStart(Math.min(maxScroll(), Math.max(0, nextScroll)));
    if (cursor < scroll || cursor >= scroll + height) cursor = scroll;
    ensureCursorVisible();
  };

  return {
    reset(): void {
      scroll = 0;
      cursor = 0;
      selectStart = 0;
      selectEnd = 0;
      pendingCount = "";
    },
    setLayout(nextRowGroups, nextLogicalLineCount): void {
      rowGroups = nextRowGroups;
      logicalLineCount = nextLogicalLineCount;
    },
    snapshot(): ViewportSnapshot {
      return { scroll, cursor, height };
    },
    captureAnchor(): ViewportAnchor {
      return {
        cursorGroup: rowGroup(cursor),
        selectStartGroup: rowGroup(selectStart),
        selectEndGroup: rowGroup(selectEnd),
      };
    },
    restoreAnchor(anchor, preserveSelection): void {
      cursor = firstRowForGroup(anchor.cursorGroup);
      if (preserveSelection) {
        selectStart = firstRowForGroup(anchor.selectStartGroup);
        selectEnd = firstRowForGroup(anchor.selectEndGroup);
      }
      ensureCursorVisible();
    },
    setPosition(nextCursor, nextScroll = scroll): void {
      cursor = nextCursor;
      scroll = nextScroll;
      ensureCursorVisible();
    },
    revealGroup(group, scrollOffset): void {
      cursor = firstRowForGroup(group);
      scroll = Math.max(0, cursor - scrollOffset);
      clampScroll();
    },
    navigate(command, selecting): void {
      if (command.type === "move") {
        moveByGroups(command.direction, 1, selecting);
        return;
      }
      if (command.type === "page") {
        if (selecting) moveByGroups(command.direction, Math.max(1, Math.floor(height / 2)), true);
        else moveViewport(command.direction);
        return;
      }
      if (command.type === "top") {
        cursor = selecting ? selectStart : 0;
        if (selecting) selectEnd = selectStart;
      } else if (command.type === "bottom") {
        cursor = groupStart(Math.max(0, rowGroups.length - 1));
        if (selecting) selectEnd = cursor;
      } else {
        const group = Math.max(0, Math.min(command.lineNumber - 1, logicalLineCount - 1));
        cursor = firstRowForGroup(group);
      }
      ensureCursorVisible();
    },
    beginSelection(): void {
      cursor = groupStart(cursor);
      selectStart = cursor;
      selectEnd = cursor;
    },
    clearSelection(): void {
      selectStart = 0;
      selectEnd = 0;
    },
    selectionBounds(): { start: number; end: number } {
      return {
        start: Math.min(rowGroup(selectStart), rowGroup(selectEnd)),
        end: Math.max(rowGroup(selectStart), rowGroup(selectEnd)),
      };
    },
    selectionMarker(row): "┃" | "▸" | null {
      const start = Math.min(rowGroup(selectStart), rowGroup(selectEnd));
      const end = Math.max(rowGroup(selectStart), rowGroup(selectEnd));
      const group = rowGroup(row);
      if (group < start || group > end) return null;
      return row === groupEnd(selectEnd) ? "▸" : "┃";
    },
    isCursorGroup(row): boolean {
      return rowGroup(row) === rowGroup(cursor);
    },
    resize(nextHeight): void {
      height = nextHeight;
      ensureCursorVisible();
    },
    appendCount(digit): void {
      pendingCount += digit;
    },
    takeCount(): number | null {
      const value = pendingCount ? Number(pendingCount) : null;
      pendingCount = "";
      return value && Number.isSafeInteger(value) ? value : null;
    },
    clearCount(): void {
      pendingCount = "";
    },
  };
}
