import { Key, matchesKey } from "@earendil-works/pi-tui";

import { createTextInputBuffer } from "./input-utils";

export type BrowserSearchKind = "filename" | "content";

export interface BrowserQuerySnapshot {
  query: string;
  active: boolean;
  kind: BrowserSearchKind;
}

export type BrowserQueryEffect =
  | { type: "none" }
  | { type: "confirm" }
  | { type: "cancel" }
  | { type: "changed"; resetSelection: boolean; contentSearch: "none" | "clear" | "schedule" }
  | { type: "move"; direction: 1 | -1 };

export interface BrowserQuery {
  snapshot(): BrowserQuerySnapshot;
  start(kind: BrowserSearchKind): void;
  clear(): void;
  clearRetained(): void;
  handleInput(data: string): BrowserQueryEffect;
}

export function createBrowserQuery(): BrowserQuery {
  const input = createTextInputBuffer();
  let query = "";
  let active = false;
  let kind: BrowserSearchKind = "filename";

  const contentEffect = (): "none" | "clear" | "schedule" => kind === "filename" ? "none" : query ? "schedule" : "clear";

  return {
    snapshot(): BrowserQuerySnapshot {
      return { query, active, kind };
    },
    start(nextKind): void {
      query = "";
      active = true;
      kind = nextKind;
      input.reset();
    },
    clear(): void {
      query = "";
      active = false;
      input.reset();
    },
    clearRetained(): void {
      query = "";
    },
    handleInput(data): BrowserQueryEffect {
      if (matchesKey(data, kind === "content" ? "@" : "/")) {
        query = "";
        input.reset();
        return { type: "changed", resetSelection: true, contentSearch: kind === "content" ? "clear" : "none" };
      }
      if (matchesKey(data, Key.enter)) {
        active = false;
        input.reset();
        return { type: "confirm" };
      }
      if (matchesKey(data, Key.backspace)) {
        if (!query) {
          active = false;
          input.reset();
          return { type: "cancel" };
        }
        query = query.slice(0, -1);
        return { type: "changed", resetSelection: true, contentSearch: contentEffect() };
      }
      if (matchesKey(data, Key.down)) return { type: "move", direction: 1 };
      if (matchesKey(data, Key.up)) return { type: "move", direction: -1 };

      const inserted = input.push(data);
      if (!inserted) return { type: "none" };
      query += inserted;
      return { type: "changed", resetSelection: true, contentSearch: contentEffect() };
    },
  };
}
