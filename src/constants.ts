export const MAX_TREE_DEPTH = 6;
export const POLL_INTERVAL_MS = 3000;
export const MAX_LINE_COUNT_BYTES = 256 * 1024;
export const LINE_COUNT_BATCH_SIZE = 8;
export const LINE_COUNT_BATCH_DELAY_MS = 30;
export const SCAN_BATCH_SIZE = 4;
export const SCAN_BATCH_DELAY_MS = 25;
export const SAFE_MODE_ENTRY_THRESHOLD = 200;

export const DEFAULT_VIEWER_HEIGHT = 29;
export const DEFAULT_BROWSER_HEIGHT = 28;

export const MIN_PANEL_HEIGHT = 5;
export const MAX_VIEWER_HEIGHT = 50;
export const MAX_BROWSER_HEIGHT = 40;
export const INITIAL_PANEL_HEIGHT_RATIO = 0.85;
export const OVERLAY_MAX_HEIGHT_RATIO = 0.95;
export const OVERLAY_MAX_HEIGHT = "95%";

export function getResponsivePanelHeight(
  fallback: number,
  maximum: number,
  chromeRows: number,
  terminalRows = process.stdout.rows,
  ratio = INITIAL_PANEL_HEIGHT_RATIO
): number {
  if (!terminalRows || terminalRows <= 0) return fallback;
  return Math.min(maximum, Math.max(MIN_PANEL_HEIGHT, Math.floor(terminalRows * ratio) - chromeRows));
}

export const SEARCH_SCROLL_OFFSET = 3;
