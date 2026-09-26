import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { createTextInputBuffer } from "./input-utils";

const MAX_VISIBLE_LINES = 4;
const CURSOR_SENTINEL_START = 0xe000;

export type CommentScope = "selection" | "file";

export type CommentEditorInput =
  | { type: "editing" }
  | { type: "cancel" }
  | { type: "finish"; comment: string | null };

export interface ViewerCommentEditor {
  open(scope: CommentScope): void;
  reset(): void;
  getScope(): CommentScope;
  handleInput(data: string): CommentEditorInput;
  render(width: number, theme: Theme): string[];
}

export function createViewerCommentEditor(): ViewerCommentEditor {
  const input = createTextInputBuffer({ preserveNewlines: true });
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let text = "";
  let cursor = 0;
  let scope: CommentScope = "selection";

  const graphemes = (value: string): string[] =>
    Array.from(segmenter.segment(value), ({ segment }) => segment);

  const reset = (): void => {
    text = "";
    cursor = 0;
    scope = "selection";
    input.reset();
  };

  const insert = (insertedText: string): void => {
    const current = graphemes(text);
    const inserted = graphemes(insertedText);
    current.splice(cursor, 0, ...inserted);
    text = current.join("");
    cursor += inserted.length;
  };

  const deleteBackward = (): void => {
    if (cursor === 0) return;
    const current = graphemes(text);
    current.splice(cursor - 1, 1);
    text = current.join("");
    cursor--;
  };

  const cursorSentinel = (): string => {
    for (let codePoint = CURSOR_SENTINEL_START; codePoint <= 0xf8ff; codePoint++) {
      const sentinel = String.fromCodePoint(codePoint);
      if (!text.includes(sentinel)) return sentinel;
    }
    throw new Error("Comment text exhausts cursor sentinels");
  };

  return {
    open(nextScope): void {
      reset();
      scope = nextScope;
    },
    reset,
    getScope(): CommentScope {
      return scope;
    },
    handleInput(data): CommentEditorInput {
      if (matchesKey(data, "ctrl+enter") || matchesKey(data, "ctrl+d") || matchesKey(data, "alt+enter")) {
        return { type: "finish", comment: text.trim() || null };
      }
      if (matchesKey(data, Key.enter) || matchesKey(data, "shift+enter")) {
        insert("\n");
      } else if (matchesKey(data, Key.escape)) {
        return { type: "cancel" };
      } else if (matchesKey(data, Key.left)) {
        cursor = Math.max(0, cursor - 1);
      } else if (matchesKey(data, Key.right)) {
        cursor = Math.min(graphemes(text).length, cursor + 1);
      } else if (matchesKey(data, Key.backspace)) {
        deleteBackward();
      } else {
        const inserted = input.push(data);
        if (inserted) insert(inserted);
      }
      return { type: "editing" };
    },
    render(width, theme): string[] {
      const contentWidth = Math.max(1, width - 3);
      const sentinel = cursorSentinel();
      const current = graphemes(text);
      const withCursor = `${current.slice(0, cursor).join("")}${sentinel}${current.slice(cursor).join("")}`;
      const wrappedLines: string[] = [];

      for (const line of withCursor.split("\n")) {
        if (line.length === 0) wrappedLines.push("");
        else wrappedLines.push(...wrapTextWithAnsi(line, contentWidth));
      }
      if (wrappedLines.length === 0) wrappedLines.push("█");

      const cursorLineIndex = wrappedLines.findIndex(line => line.includes(sentinel));
      if (cursorLineIndex >= 0) {
        const cursorColumn = wrappedLines[cursorLineIndex]!.indexOf(sentinel);
        wrappedLines[cursorLineIndex] = `${wrappedLines[cursorLineIndex]!.slice(0, cursorColumn)}${CURSOR_MARKER}█${wrappedLines[cursorLineIndex]!.slice(cursorColumn + sentinel.length)}`;
      }
      const cursorLine = Math.max(0, cursorLineIndex);
      const visibleStart = Math.min(
        Math.max(0, cursorLine - MAX_VISIBLE_LINES + 1),
        Math.max(0, wrappedLines.length - MAX_VISIBLE_LINES)
      );
      const visibleLines = wrappedLines.slice(visibleStart, visibleStart + MAX_VISIBLE_LINES);
      if (visibleStart > 0 && visibleLines.length > 0) visibleLines[0] = `…${visibleLines[0]}`;

      return [
        truncateToWidth(theme.fg("accent", scope === "file" ? "Comment: whole file" : "Comment:"), width),
        ...visibleLines.map(line => truncateToWidth(`  ${theme.fg("text", line)}`, width)),
      ];
    },
  };
}
