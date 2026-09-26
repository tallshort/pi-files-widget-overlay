import { Key, matchesKey } from "@earendil-works/pi-tui";

export type ViewerInputMode = "normal" | "select" | "search" | "comment";

export interface ViewerInputContext {
  mode: ViewerInputMode;
  readOnly: boolean;
  selectable: boolean;
  hasSearchMatches: boolean;
  canDiff: boolean;
}

export type ViewerInputCommand =
  | { type: "none" }
  | { type: "count"; digit: string }
  | { type: "comment-input" }
  | { type: "search-input" }
  | { type: "toggle-help" }
  | { type: "close" }
  | { type: "back" }
  | { type: "start-search" }
  | { type: "search-match"; direction: 1 | -1 }
  | { type: "move"; direction: 1 | -1 }
  | { type: "page"; direction: 1 | -1 }
  | { type: "top" }
  | { type: "bottom-or-line" }
  | { type: "resize"; direction: 1 | -1 }
  | { type: "copy-path" }
  | { type: "toggle-wrap" }
  | { type: "toggle-diff" }
  | { type: "toggle-markdown" }
  | { type: "toggle-selection" }
  | { type: "comment"; scope: "selection" | "file" }
  | { type: "navigate-file"; direction: 1 | -1 };

function classifyReadOnlyInput(data: string, lineJump: boolean): ViewerInputCommand {
  if (matchesKey(data, "g")) return { type: "top" };
  if (lineJump) return { type: "bottom-or-line" };
  if (matchesKey(data, Key.pageDown) || matchesKey(data, "ctrl+d")) return { type: "page", direction: 1 };
  if (matchesKey(data, Key.pageUp) || matchesKey(data, "ctrl+u")) return { type: "page", direction: -1 };
  if (matchesKey(data, "w")) return { type: "toggle-wrap" };
  return { type: "none" };
}

function classifyModeInput(data: string, context: ViewerInputContext): ViewerInputCommand | null {
  const { mode } = context;
  if (mode === "comment") return { type: "comment-input" };
  if (mode === "search") return { type: "search-input" };
  if (matchesKey(data, "?") && mode === "normal") return { type: "toggle-help" };
  if (matchesKey(data, "q") && mode !== "select") return { type: "close" };
  if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) return { type: "back" };

  const blockedEditingCommand = matchesKey(data, "/")
    || matchesKey(data, "v")
    || matchesKey(data, "c")
    || matchesKey(data, "shift+c");
  if (!context.selectable && blockedEditingCommand) return { type: "none" };

  if (matchesKey(data, "/") && mode !== "select") return { type: "start-search" };
  if (matchesKey(data, "n") && mode !== "select" && context.hasSearchMatches) return { type: "search-match", direction: 1 };
  if (matchesKey(data, "shift+n") && mode !== "select" && context.hasSearchMatches) return { type: "search-match", direction: -1 };
  return null;
}

function classifyNavigationInput(data: string, lineJump: boolean): ViewerInputCommand | null {
  if (matchesKey(data, "j") || matchesKey(data, Key.down)) return { type: "move", direction: 1 };
  if (matchesKey(data, "k") || matchesKey(data, Key.up)) return { type: "move", direction: -1 };
  if (matchesKey(data, Key.pageDown) || matchesKey(data, "ctrl+d")) return { type: "page", direction: 1 };
  if (matchesKey(data, Key.pageUp) || matchesKey(data, "ctrl+u")) return { type: "page", direction: -1 };
  if (matchesKey(data, "g")) return { type: "top" };
  if (lineJump) return { type: "bottom-or-line" };
  if (matchesKey(data, "+") || matchesKey(data, "=")) return { type: "resize", direction: 1 };
  if (matchesKey(data, "-") || matchesKey(data, "_")) return { type: "resize", direction: -1 };
  return null;
}

function classifyNormalInput(data: string, context: ViewerInputContext): ViewerInputCommand {
  const { mode } = context;
  if (matchesKey(data, "y") && mode === "normal") return { type: "copy-path" };
  if (matchesKey(data, "w") && mode !== "select") return { type: "toggle-wrap" };
  if (matchesKey(data, "d") && mode !== "select" && context.canDiff) return { type: "toggle-diff" };
  if ((matchesKey(data, "m") || matchesKey(data, "r")) && mode !== "select") return { type: "toggle-markdown" };
  if (matchesKey(data, "v")) return { type: "toggle-selection" };
  if (matchesKey(data, "shift+c") && mode === "select") return { type: "comment", scope: "file" };
  if (matchesKey(data, "c") && mode === "select") return { type: "comment", scope: "selection" };
  if (matchesKey(data, "]") && mode !== "select") return { type: "navigate-file", direction: 1 };
  if (matchesKey(data, "[") && mode !== "select") return { type: "navigate-file", direction: -1 };
  return { type: "none" };
}

export function classifyViewerInput(data: string, context: ViewerInputContext): ViewerInputCommand {
  if (/^\d$/.test(data) && context.mode === "normal") return { type: "count", digit: data };

  const lineJump = matchesKey(data, "shift+g");
  if (context.readOnly) return classifyReadOnlyInput(data, lineJump);
  return classifyModeInput(data, context)
    ?? classifyNavigationInput(data, lineJump)
    ?? classifyNormalInput(data, context);
}
