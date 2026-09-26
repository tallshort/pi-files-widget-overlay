import { Key, matchesKey } from "@earendil-works/pi-tui";

import { createTextInputBuffer } from "./input-utils";

export type SearchInputResult =
  | { type: "editing"; line: number | null }
  | { type: "confirm" }
  | { type: "cancel" };

export interface ViewerSearchSnapshot {
  query: string;
  matchCount: number;
  matchIndex: number;
}

export interface ViewerSearch {
  reset(): void;
  resetInput(): void;
  snapshot(): ViewerSearchSnapshot;
  refresh(searchableLines: string[], preserveActiveMatch?: boolean): number | null;
  move(direction: 1 | -1): number | null;
  handleInput(data: string, searchableLines: string[]): SearchInputResult;
}

const stripAnsi = (text: string): string =>
  text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

export function createViewerSearch(): ViewerSearch {
  const input = createTextInputBuffer();
  let query = "";
  let matches: number[] = [];
  let matchIndex = 0;

  const activeLine = (): number | null => matches[matchIndex] ?? null;

  const reset = (): void => {
    query = "";
    matches = [];
    matchIndex = 0;
    input.reset();
  };

  const refresh = (searchableLines: string[], preserveActiveMatch = false): number | null => {
    const previousMatch = preserveActiveMatch ? activeLine() : null;
    matches = [];
    if (!query) {
      matchIndex = 0;
      return null;
    }

    const normalizedQuery = query.toLowerCase();
    for (let index = 0; index < searchableLines.length; index++) {
      if (stripAnsi(searchableLines[index]!).toLowerCase().includes(normalizedQuery)) matches.push(index);
    }
    if (matches.length === 0) {
      matchIndex = 0;
      return null;
    }
    if (previousMatch === null) {
      matchIndex = 0;
    } else {
      let nearestIndex = 0;
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < matches.length; index++) {
        const distance = Math.abs(matches[index]! - previousMatch);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestIndex = index;
        }
      }
      matchIndex = nearestIndex;
    }
    return activeLine();
  };

  return {
    reset,
    resetInput(): void {
      input.reset();
    },
    snapshot(): ViewerSearchSnapshot {
      return { query, matchCount: matches.length, matchIndex };
    },
    refresh,
    move(direction): number | null {
      if (matches.length === 0) return null;
      matchIndex = (matchIndex + direction + matches.length) % matches.length;
      return activeLine();
    },
    handleInput(data, searchableLines): SearchInputResult {
      if (matchesKey(data, "/")) {
        reset();
      } else if (matchesKey(data, Key.enter)) {
        return { type: "confirm" };
      } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
        return { type: "cancel" };
      } else if (matchesKey(data, Key.backspace)) {
        if (!query) return { type: "cancel" };
        query = query.slice(0, -1);
      } else {
        const inserted = input.push(data);
        if (!inserted) return { type: "editing", line: null };
        query += inserted;
      }
      return { type: "editing", line: refresh(searchableLines) };
    },
  };
}
