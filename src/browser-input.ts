import { Key, matchesKey } from "@earendil-works/pi-tui";

export interface BrowserInputContext {
  queryActive: boolean;
  multipleRoots: boolean;
  previewActive: boolean;
}

export type BrowserInputCommand =
  | { type: "none" }
  | { type: "switch-root"; direction: 1 | -1 }
  | { type: "preview-input" }
  | { type: "close" }
  | { type: "escape" }
  | { type: "start-search"; kind: "filename" | "content" }
  | { type: "query-input" }
  | { type: "toggle-help" }
  | { type: "toggle-preview" }
  | { type: "toggle-pin" }
  | { type: "copy-path" }
  | { type: "parent-root" }
  | { type: "initial-root" }
  | { type: "move"; direction: 1 | -1 }
  | { type: "open" }
  | { type: "expand-or-open" }
  | { type: "collapse" }
  | { type: "page"; direction: 1 | -1 }
  | { type: "resize"; direction: 1 | -1 }
  | { type: "toggle-expanded-changes" }
  | { type: "toggle-changes" }
  | { type: "navigate-change"; direction: 1 | -1 };

function isPreviewNavigation(data: string): boolean {
  return /^\d$/.test(data)
    || matchesKey(data, "g")
    || matchesKey(data, "shift+g")
    || matchesKey(data, Key.pageDown)
    || matchesKey(data, Key.pageUp)
    || matchesKey(data, "ctrl+d")
    || matchesKey(data, "ctrl+u")
    || matchesKey(data, "w");
}

function classifyNormalBrowserInput(data: string): BrowserInputCommand {
  if (matchesKey(data, "?")) return { type: "toggle-help" };
  if (matchesKey(data, "p")) return { type: "toggle-preview" };
  if (matchesKey(data, "*")) return { type: "toggle-pin" };
  if (matchesKey(data, "y")) return { type: "copy-path" };
  if (matchesKey(data, "u")) return { type: "parent-root" };
  if (matchesKey(data, ".")) return { type: "initial-root" };
  if (matchesKey(data, "j") || matchesKey(data, Key.down)) return { type: "move", direction: 1 };
  if (matchesKey(data, "k") || matchesKey(data, Key.up)) return { type: "move", direction: -1 };
  if (matchesKey(data, Key.enter)) return { type: "open" };
  if (matchesKey(data, "l") || matchesKey(data, Key.right)) return { type: "expand-or-open" };
  if (matchesKey(data, "h") || matchesKey(data, Key.left)) return { type: "collapse" };
  if (matchesKey(data, Key.pageDown)) return { type: "page", direction: 1 };
  if (matchesKey(data, Key.pageUp)) return { type: "page", direction: -1 };
  if (matchesKey(data, "+") || matchesKey(data, "=")) return { type: "resize", direction: 1 };
  if (matchesKey(data, "-") || matchesKey(data, "_")) return { type: "resize", direction: -1 };
  if (matchesKey(data, "shift+c")) return { type: "toggle-expanded-changes" };
  if (matchesKey(data, "c")) return { type: "toggle-changes" };
  if (matchesKey(data, "]")) return { type: "navigate-change", direction: 1 };
  if (matchesKey(data, "[")) return { type: "navigate-change", direction: -1 };
  return { type: "none" };
}

export function classifyBrowserInput(data: string, context: BrowserInputContext): BrowserInputCommand {
  if (!context.queryActive && context.multipleRoots && (matchesKey(data, Key.tab) || matchesKey(data, "shift+tab"))) {
    return { type: "switch-root", direction: matchesKey(data, "shift+tab") ? -1 : 1 };
  }
  if (!context.queryActive && context.previewActive && isPreviewNavigation(data)) return { type: "preview-input" };
  if (!context.queryActive && matchesKey(data, "q")) return { type: "close" };
  if (matchesKey(data, Key.escape)) return { type: "escape" };
  if (!context.queryActive && (matchesKey(data, "/") || matchesKey(data, "@"))) {
    return { type: "start-search", kind: matchesKey(data, "@") ? "content" : "filename" };
  }
  if (context.queryActive) return { type: "query-input" };
  return classifyNormalBrowserInput(data);
}
