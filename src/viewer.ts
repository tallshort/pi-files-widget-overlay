import { copyToClipboard, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { readFileSync, statSync } from "node:fs";
import { relative, sep } from "node:path";

import {
  DEFAULT_VIEWER_HEIGHT,
  getResponsivePanelHeight,
  OVERLAY_MAX_HEIGHT_RATIO,
  MAX_VIEWER_HEIGHT,
  MIN_PANEL_HEIGHT,
  SEARCH_SCROLL_OFFSET,
} from "./constants";
import { loadFileContent, type RenderedLines } from "./file-viewer";
import type { FileNode } from "./types";
import { isImagePath, isMarkdownPath, isUntrackedStatus, sanitizeTerminalLabel } from "./utils";
import { createTextInputBuffer } from "./input-utils";

const COMMENT_EDITOR_MAX_VISIBLE_LINES = 4;
const COMMENT_CURSOR_SENTINEL_START = 0xe000;

export interface CommentPayload {
  relPath: string;
  lineRange: string;
  ext: string;
  selectedText: string;
  isDiff?: boolean;
  isFile?: boolean;
}

export type ViewerAction =
  | { type: "none" }
  | { type: "close" }
  | { type: "navigate"; direction: 1 | -1 };

type ViewerMode = "normal" | "select" | "search" | "comment";

interface ViewerState {
  file: FileNode | null;
  renderedLines: RenderedLines;
  rawContent: string;
  scroll: number;
  cursor: number;
  diffMode: boolean;
  renderMarkdown: boolean;
  wordWrap: boolean;
  mode: ViewerMode;
  selectStart: number;
  selectEnd: number;
  commentText: string;
  commentCursor: number;
  commentScope: "selection" | "file";
  searchQuery: string;
  searchMatches: number[];
  searchIndex: number;
  lastRenderWidth: number;
  lastLoadedMtimeMs: number | null;
  height: number;
  pendingCount: string;
  showFullHelp: boolean;
  selectable: boolean;
}

export interface ViewerController {
  isOpen(): boolean;
  getFile(): FileNode | null;
  setFile(file: FileNode): void;
  updateFileRef(file: FileNode | null): void;
  close(): void;
  render(width: number): string[];
  handleInput(data: string): ViewerAction;
  copyPath(): void;
  isPathCopied(): boolean;
}

export interface ViewerConfig {
  getRoot: () => string;
  projectCwd: string;
  readOnly?: boolean;
  requestRender?: () => void;
}

export function createViewer(
  config: ViewerConfig,
  theme: Theme,
  requestComment: (payload: CommentPayload, comment: string) => void
): ViewerController {
  const { getRoot, projectCwd, readOnly = false, requestRender } = config;
  let pathCopiedUntil = 0;
  let copyGeneration = 0;
  const searchInput = createTextInputBuffer();
  const commentInput = createTextInputBuffer({ preserveNewlines: true });
  const commentSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

  const state: ViewerState = {
    file: null,
    renderedLines: { lines: [], rowGroups: [], logicalLines: [] },
    rawContent: "",
    scroll: 0,
    cursor: 0,
    diffMode: false,
    renderMarkdown: true,
    wordWrap: false,
    mode: "normal",
    selectStart: 0,
    selectEnd: 0,
    commentText: "",
    commentCursor: 0,
    commentScope: "selection",
    searchQuery: "",
    searchMatches: [],
    searchIndex: 0,
    lastRenderWidth: 0,
    lastLoadedMtimeMs: null,
    height: getResponsivePanelHeight(DEFAULT_VIEWER_HEIGHT, MAX_VIEWER_HEIGHT, 8),
    pendingCount: "",
    showFullHelp: false,
    selectable: true,
  };

  function isMarkdownFile(): boolean {
    return !!state.file && isMarkdownPath(state.file.path);
  }

  function isRenderedMarkdownMode(): boolean {
    return isMarkdownFile() && !state.diffMode && state.renderMarkdown;
  }

  function switchMarkdownToRaw(): boolean {
    if (!isRenderedMarkdownMode()) return false;
    state.renderMarkdown = false;
    state.cursor = 0;
    state.selectStart = 0;
    state.selectEnd = 0;
    state.scroll = 0;
    const width = state.lastRenderWidth || process.stdout.columns || 80;
    reloadContent(width);
    return true;
  }

  function toggleMarkdownMode(): void {
    if (!isMarkdownFile() || state.diffMode) return;
    state.renderMarkdown = !state.renderMarkdown;
    state.lastRenderWidth = 0;
    resetSearch();
    setMode("normal");
    clampScroll();
  }

  function resetSearch(): void {
    state.searchQuery = "";
    state.searchMatches = [];
    state.searchIndex = 0;
  }

  function commentGraphemes(text: string): string[] {
    return Array.from(commentSegmenter.segment(text), ({ segment }) => segment);
  }

  function commentCursorSentinel(text: string): string {
    for (let codePoint = COMMENT_CURSOR_SENTINEL_START; codePoint <= 0xf8ff; codePoint++) {
      const sentinel = String.fromCodePoint(codePoint);
      if (!text.includes(sentinel)) return sentinel;
    }
    throw new Error("Comment text exhausts cursor sentinels");
  }

  function resetComment(): void {
    state.commentText = "";
    state.commentCursor = 0;
    state.commentScope = "selection";
  }

  function openComment(scope: "selection" | "file"): void {
    state.commentScope = scope;
    state.mode = "comment";
    state.commentText = "";
    state.commentCursor = 0;
  }

  function insertCommentText(text: string): void {
    const graphemes = commentGraphemes(state.commentText);
    const inserted = commentGraphemes(text);
    graphemes.splice(state.commentCursor, 0, ...inserted);
    state.commentText = graphemes.join("");
    state.commentCursor += inserted.length;
  }

  function deleteCommentBackward(): void {
    if (state.commentCursor === 0) return;
    const graphemes = commentGraphemes(state.commentText);
    graphemes.splice(state.commentCursor - 1, 1);
    state.commentText = graphemes.join("");
    state.commentCursor--;
  }

  function clearSelection(): void {
    state.selectStart = 0;
    state.selectEnd = 0;
  }

  function setMode(mode: ViewerMode, preserveSearch = false): void {
    if (mode !== state.mode) {
      searchInput.reset();
      commentInput.reset();
    }

    state.mode = mode;
    if (mode !== "search" && !preserveSearch) resetSearch();
    if (mode !== "comment") resetComment();
    if (mode === "normal") {
      clearSelection();
    }
  }

  function getMaxScroll(): number {
    return Math.max(0, state.renderedLines.lines.length - state.height);
  }

  function refreshRawContent(): void {
    if (!state.file) return;

    try {
      const fileStat = statSync(state.file.path);
      if (isImagePath(state.file.path)) {
        state.rawContent = "";
        state.file.lineCount = undefined;
        state.lastLoadedMtimeMs = fileStat.mtimeMs;
        return;
      }
      state.rawContent = readFileSync(state.file.path, "utf-8").replace(/\r\n/g, "\n");
      state.file.lineCount = state.rawContent.split("\n").length;
      state.lastLoadedMtimeMs = fileStat.mtimeMs;
    } catch {
      state.rawContent = "";
      state.file.lineCount = undefined;
      state.lastLoadedMtimeMs = null;
    }
  }

  function hasFileChangedOnDisk(): boolean {
    if (!state.file) return false;

    try {
      return state.lastLoadedMtimeMs === null || statSync(state.file.path).mtimeMs !== state.lastLoadedMtimeMs;
    } catch {
      return state.lastLoadedMtimeMs !== null;
    }
  }

  function clampScroll(): void {
    state.scroll = Math.min(getMaxScroll(), Math.max(0, state.scroll));
  }

  function ensureCursorVisible(): void {
    state.cursor = Math.min(Math.max(0, state.cursor), Math.max(0, state.renderedLines.lines.length - 1));
    if (state.cursor < state.scroll) state.scroll = state.cursor;
    if (state.cursor >= state.scroll + state.height) state.scroll = state.cursor - state.height + 1;
    clampScroll();
  }

  function rowGroup(index: number): number {
    return state.renderedLines.rowGroups[index] ?? index;
  }

  function groupStart(index: number): number {
    const group = rowGroup(index);
    while (index > 0 && rowGroup(index - 1) === group) index--;
    return index;
  }

  function firstRowForGroup(group: number): number {
    const row = state.renderedLines.rowGroups.indexOf(group);
    return row === -1 ? Math.min(Math.max(0, group), Math.max(0, state.renderedLines.lines.length - 1)) : row;
  }

  function jumpToLine(lineNumber: number): void {
    state.cursor = firstRowForGroup(Math.max(0, Math.min(lineNumber - 1, state.renderedLines.logicalLines.length - 1)));
    ensureCursorVisible();
  }

  function takePendingLineNumber(): number | null {
    const value = state.pendingCount ? Number(state.pendingCount) : null;
    state.pendingCount = "";
    return value && Number.isSafeInteger(value) ? value : null;
  }

  function groupEnd(index: number): number {
    const group = rowGroup(index);
    while (index + 1 < state.renderedLines.lines.length && rowGroup(index + 1) === group) index++;
    return index;
  }

  function selectionBounds(): { start: number; end: number } {
    return {
      start: Math.min(rowGroup(state.selectStart), rowGroup(state.selectEnd)),
      end: Math.max(rowGroup(state.selectStart), rowGroup(state.selectEnd)),
    };
  }

  function moveCursor(direction: 1 | -1): void {
    const next = stepGroup(state.cursor, direction);
    if (next !== null) state.cursor = next;
    ensureCursorVisible();
  }

  function stepGroup(index: number, direction: 1 | -1): number | null {
    const next = direction > 0 ? groupEnd(index) + 1 : groupStart(index) - 1;
    return next >= 0 && next < state.renderedLines.lines.length ? next : null;
  }

  function moveCursorByGroups(direction: 1 | -1, count: number): void {
    for (let step = 0; step < count; step++) {
      const next = stepGroup(state.cursor, direction);
      if (next === null) break;
      state.cursor = next;
    }
    ensureCursorVisible();
  }

  function moveViewportByRows(direction: 1 | -1, count: number): void {
    const nextScroll = state.scroll + direction * count;
    state.scroll = groupStart(Math.min(getMaxScroll(), Math.max(0, nextScroll)));
    if (state.cursor < state.scroll || state.cursor >= state.scroll + state.height) {
      state.cursor = state.scroll;
    }
  }

  function stripAnsi(text: string): string {
    return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  }

  function normalizeRenderedMarkdownText(text: string): string {
    return stripAnsi(text).trim().replace(/\s+/g, " ");
  }

  function renderedMarkdownParagraphAt(row: number): { text: string; rowOffset: number } | null {
    const lines = state.renderedLines.lines.map(normalizeRenderedMarkdownText);
    if (!lines[row]) return null;

    let start = row;
    while (start > 0 && lines[start - 1]) start--;
    let end = row;
    while (end + 1 < lines.length && lines[end + 1]) end++;
    return { text: lines.slice(start, end + 1).join(" "), rowOffset: row - start };
  }

  function captureRenderedMarkdownAnchor(): { text: string; rowOffset: number; viewportOffset: number } | null {
    const paragraph = renderedMarkdownParagraphAt(state.cursor);
    return paragraph && paragraph.text
      ? { ...paragraph, viewportOffset: state.cursor - state.scroll }
      : null;
  }

  function findRenderedMarkdownAnchor(text: string, rowOffset: number): number | null {
    const lines = state.renderedLines.lines.map(normalizeRenderedMarkdownText);
    const matches: number[] = [];
    for (let start = 0; start < lines.length;) {
      if (!lines[start]) {
        start++;
        continue;
      }
      let end = start;
      while (end + 1 < lines.length && lines[end + 1]) end++;
      if (lines.slice(start, end + 1).join(" ") === text) matches.push(Math.min(start + rowOffset, end));
      start = end + 1;
    }
    return matches.length === 1 ? matches[0] ?? null : null;
  }

  function reloadContent(width: number): void {
    if (!state.file) return;
    const restoreRenderedMarkdown = isRenderedMarkdownMode() && state.lastRenderWidth !== 0 && state.lastRenderWidth !== width;
    const markdownAnchor = restoreRenderedMarkdown ? captureRenderedMarkdownAnchor() : null;
    const cursorGroup = rowGroup(state.cursor);
    const selectStartGroup = rowGroup(state.selectStart);
    const selectEndGroup = rowGroup(state.selectEnd);
    const preserveSelection = state.mode === "select" || state.mode === "comment";
    refreshRawContent();
    const hasChanges = !!state.file.gitStatus;
    const result = loadFileContent(
      state.file.path,
      { cwd: getRoot(), diffMode: state.diffMode, hasChanges, width, renderMarkdown: state.renderMarkdown, wordWrap: state.wordWrap },
      theme
    );
    state.renderedLines = result;
    state.selectable = result.selectable !== false;
    if (!state.selectable) {
      state.rawContent = "";
      setMode("normal");
    }
    const anchoredRow = markdownAnchor && result.renderedMarkdown
      ? findRenderedMarkdownAnchor(markdownAnchor.text, markdownAnchor.rowOffset)
      : null;
    if (restoreRenderedMarkdown && result.renderedMarkdown) {
      if (anchoredRow !== null) {
        state.cursor = anchoredRow;
        state.scroll = Math.max(0, anchoredRow - (markdownAnchor?.viewportOffset ?? 0));
      } else {
        state.cursor = 0;
        state.scroll = 0;
      }
    } else {
      state.cursor = firstRowForGroup(cursorGroup);
    }
    if (preserveSelection) {
      state.selectStart = firstRowForGroup(selectStartGroup);
      state.selectEnd = firstRowForGroup(selectEndGroup);
    }
    ensureCursorVisible();
    state.renderMarkdown = result.renderedMarkdown;
    state.lastRenderWidth = width;
    clampScroll();
    if (state.searchQuery) {
      updateSearchMatches({ preserveActiveMatch: true });
    }
  }

  function updateSearchMatches(options: { preserveActiveMatch?: boolean } = {}): void {
    const activeMatch = options.preserveActiveMatch ? state.searchMatches[state.searchIndex] : undefined;

    state.searchMatches = [];
    if (!state.searchQuery) {
      state.searchIndex = 0;
      return;
    }

    const q = state.searchQuery.toLowerCase();
    const searchableLines = state.diffMode ? state.renderedLines.logicalLines : state.rawContent.split("\n");
    for (let i = 0; i < searchableLines.length; i++) {
      if (searchableLines[i].replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").toLowerCase().includes(q)) {
        state.searchMatches.push(i);
      }
    }

    if (state.searchMatches.length === 0) {
      state.searchIndex = 0;
      return;
    }

    if (activeMatch === undefined) {
      state.searchIndex = 0;
    } else {
      let nearestIndex = 0;
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (let i = 0; i < state.searchMatches.length; i++) {
        const distance = Math.abs(state.searchMatches[i] - activeMatch);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestIndex = i;
        }
      }
      state.searchIndex = nearestIndex;
    }

    state.cursor = firstRowForGroup(state.searchMatches[state.searchIndex]);
    state.scroll = Math.max(0, state.cursor - SEARCH_SCROLL_OFFSET);
    clampScroll();
  }

  function jumpToNextMatch(direction: 1 | -1): void {
    if (state.searchMatches.length === 0) return;
    state.searchIndex += direction;
    if (state.searchIndex < 0) state.searchIndex = state.searchMatches.length - 1;
    if (state.searchIndex >= state.searchMatches.length) state.searchIndex = 0;
    state.cursor = firstRowForGroup(state.searchMatches[state.searchIndex]);
    state.scroll = Math.max(0, state.cursor - SEARCH_SCROLL_OFFSET);
    clampScroll();
  }

  function buildCommentPayload(): CommentPayload | null {
    if (!state.file) return null;

    const rel = relative(projectCwd, state.file.path);
    const relPath = !rel || rel === ".." || rel.startsWith(`..${sep}`) ? state.file.path : rel;
    const ext = state.diffMode ? "diff" : state.file.name.split(".").pop() || "";
    if (state.commentScope === "file") {
      return { relPath, lineRange: "file", ext, selectedText: "", isFile: true };
    }

    const rawLines = state.rawContent.split("\n");
    const bounds = selectionBounds();
    const selectedText = state.diffMode
      ? state.renderedLines.logicalLines
          .slice(bounds.start, bounds.end + 1)
          .map(line => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/^([+-]?)\s*\d+\s│\s?/, "$1 "))
          .join("\n")
      : rawLines.slice(bounds.start, bounds.end + 1).join("\n");
    const lineRange = state.diffMode
      ? `diff lines ${bounds.start + 1}-${bounds.end + 1}`
      : bounds.start === bounds.end
        ? `line ${bounds.start + 1}`
        : `lines ${bounds.start + 1}-${bounds.end + 1}`;

    return { relPath, lineRange, ext, selectedText, isDiff: state.diffMode };
  }

  function sendComment(comment: string): void {
    const payload = buildCommentPayload();
    if (!payload) return;

    requestComment(payload, comment);
    setMode("normal");
  }

  function renderHeader(width: number): string {
    if (!state.file) return "";
    const isUntracked = isUntrackedStatus(state.file.gitStatus);

    const copyHint = Date.now() < pathCopiedUntil ? theme.fg("dim", " Path copied") : "";
    const fileNameWidth = Math.max(0, width - visibleWidth(copyHint));
    let header = theme.bold(theme.fg("text", truncateToWidth(sanitizeTerminalLabel(state.file.name), fileNameWidth, "…"))) + copyHint;
    if (isUntracked) {
      header += theme.fg("dim", " [UNTRACKED]");
    } else if (state.diffMode) {
      header += theme.fg("warning", " [DIFF]");
    } else if (isMarkdownFile()) {
      header += theme.fg("accent", state.renderMarkdown ? " [RENDERED]" : " [RAW]");
    }
    header += theme.fg("accent", state.wordWrap ? " [WRAP]" : " [NO WRAP]");
    if (state.mode === "select" || state.mode === "comment") {
      const bounds = selectionBounds();
      header += theme.fg("accent", ` [SELECT ${bounds.start + 1}-${bounds.end + 1}]`);
    }

    if (state.file.diffStats) {
      if (state.file.diffStats.additions > 0) {
        header += theme.fg("success", ` +${state.file.diffStats.additions}`);
      }
      if (state.file.diffStats.deletions > 0) {
        header += theme.fg("error", ` -${state.file.diffStats.deletions}`);
      }
    } else if (isUntracked && state.file.lineCount !== undefined) {
      header += theme.fg("success", ` +${state.file.lineCount}`);
    }

    if (state.file.lineCount !== undefined) {
      header += theme.fg("dim", ` ${state.file.lineCount}L`);
    }

    if (state.mode === "search") {
      header += theme.fg("accent", `  /${state.searchQuery}${CURSOR_MARKER}█`);
    } else if (state.searchQuery) {
      const searchPosition = state.searchMatches.length > 0
        ? `${state.searchIndex + 1}/${state.searchMatches.length}`
        : "0/0";
      header += theme.fg("dim", `  /${state.searchQuery}  (Esc clears) [${searchPosition}]`);
    }

    return truncateToWidth(header, width);
  }

  function renderCommentEditor(width: number): string[] {
    const contentWidth = Math.max(1, width - 3);
    const wrappedLines: string[] = [];
    const graphemes = commentGraphemes(state.commentText);
    const cursorSentinel = commentCursorSentinel(state.commentText);
    const commentWithCursor = `${graphemes.slice(0, state.commentCursor).join("")}${cursorSentinel}${graphemes.slice(state.commentCursor).join("")}`;
    const logicalLines = commentWithCursor.split("\n");

    for (const line of logicalLines) {
      if (line.length === 0) {
        wrappedLines.push("");
        continue;
      }
      wrappedLines.push(...wrapTextWithAnsi(line, contentWidth));
    }

    if (wrappedLines.length === 0) {
      wrappedLines.push("█");
    }

    const cursorLineIndex = wrappedLines.findIndex(line => line.includes(cursorSentinel));
    if (cursorLineIndex >= 0) {
      const cursorColumn = wrappedLines[cursorLineIndex]!.indexOf(cursorSentinel);
      wrappedLines[cursorLineIndex] = `${wrappedLines[cursorLineIndex]!.slice(0, cursorColumn)}${CURSOR_MARKER}█${wrappedLines[cursorLineIndex]!.slice(cursorColumn + cursorSentinel.length)}`;
    }
    const cursorLine = Math.max(0, cursorLineIndex);
    const visibleStart = Math.min(
      Math.max(0, cursorLine - COMMENT_EDITOR_MAX_VISIBLE_LINES + 1),
      Math.max(0, wrappedLines.length - COMMENT_EDITOR_MAX_VISIBLE_LINES)
    );
    const visibleLines = wrappedLines.slice(visibleStart, visibleStart + COMMENT_EDITOR_MAX_VISIBLE_LINES);
    if (visibleStart > 0 && visibleLines.length > 0) {
      visibleLines[0] = `…${visibleLines[0]}`;
    }

    return [
      truncateToWidth(theme.fg("accent", state.commentScope === "file" ? "Comment: whole file" : "Comment:"), width),
      ...visibleLines.map(line => truncateToWidth(`  ${theme.fg("text", line)}`, width)),
    ];
  }

  function renderFooter(width: number): string[] {
    const lines: string[] = [];
    const pct = state.renderedLines.lines.length > 0
      ? Math.round((state.scroll / Math.max(1, state.renderedLines.lines.length - state.height)) * 100)
      : 0;

    if (state.mode === "comment") {
      lines.push(...renderCommentEditor(width));
      lines.push(theme.fg("border", "─".repeat(width)));
    }

    let helpLines: string[];
    if (state.mode === "comment") {
      helpLines = ["←/→: move cursor  Enter: newline  Ctrl+Enter/Ctrl+D: send  Esc: cancel"];
    } else if (state.mode === "select") {
      helpLines = ["j/k or ↑/↓: extend  c: line comment  C: file comment  v/Esc: cancel"];
    } else if (state.mode === "search") {
      helpLines = ["Type to search  Enter: confirm  Esc: cancel"];
    } else if (readOnly) {
      helpLines = ["Preview — select a file in the browser"];
    } else if (state.showFullHelp) {
      helpLines = [
        "j/k/↑/↓: move  PgUp/PgDn/Ctrl-U/Ctrl-D: page  g/G: line  w: wrap  y: copy path",
        "v: select  d: diff  m: render  []: change  +/-: height  ?: hide  q/Esc/←: back",
      ];
    } else {
      helpLines = ["/: search  n/N: match  v: select  m: raw/render  d: diff  y: copy path  ?: help  q: back"];
    }
    lines.push(...helpLines.map(line => truncateToWidth(theme.fg("dim", line), width)));

    return lines;
  }

  function copyPath(): void {
    const copiedPath = state.file?.path;
    const generation = copyGeneration;
    if (!copiedPath) return;
    void copyToClipboard(copiedPath).then(() => {
      if (generation !== copyGeneration || state.file?.path !== copiedPath) return;
      pathCopiedUntil = Date.now() + 3000;
      requestRender?.();
      setTimeout(() => requestRender?.(), 3000);
    }).catch(() => {});
  }

  return {
    isOpen(): boolean {
      return !!state.file;
    },

    getFile(): FileNode | null {
      return state.file;
    },
    copyPath,
    isPathCopied(): boolean { return Date.now() < pathCopiedUntil; },

    setFile(file: FileNode): void {
      pathCopiedUntil = 0;
      copyGeneration += 1;
      state.file = file;
      state.scroll = 0;
      state.cursor = 0;
      state.diffMode = !!file.gitStatus && !isUntrackedStatus(file.gitStatus);
      state.renderMarkdown = isMarkdownPath(file.path);
      state.wordWrap = false;
      state.showFullHelp = false;
      state.pendingCount = "";
      setMode("normal");
      state.renderedLines = { lines: [], rowGroups: [], logicalLines: [] };
      state.lastRenderWidth = 0;
      state.lastLoadedMtimeMs = null;
      refreshRawContent();
    },

    updateFileRef(file: FileNode | null): void {
      if (state.file?.path !== file?.path) {
        pathCopiedUntil = 0;
        copyGeneration += 1;
      }
      state.file = file;
    },

    close(): void {
      pathCopiedUntil = 0;
      copyGeneration += 1;
      state.file = null;
      state.renderedLines = { lines: [], rowGroups: [], logicalLines: [] };
      state.rawContent = "";
      state.renderMarkdown = true;
      state.wordWrap = false;
      state.showFullHelp = false;
      state.pendingCount = "";
      state.lastLoadedMtimeMs = null;
      setMode("normal");
    },

    render(width: number): string[] {
      if (!state.file) return [];

      const shouldAutoRefresh = state.mode !== "select" && state.mode !== "comment";
      if (state.lastRenderWidth !== width || state.renderedLines.lines.length === 0 || (shouldAutoRefresh && hasFileChangedOnDisk())) {
        reloadContent(width);
      }

      const lines: string[] = [];
      lines.push(renderHeader(width));
      lines.push(theme.fg("borderMuted", "─".repeat(width)));

      const visible = state.renderedLines.lines.slice(state.scroll, state.scroll + state.height);
      for (let i = 0; i < state.height; i++) {
        if (i < visible.length) {
          const lineIdx = state.scroll + i;
          let line = truncateToWidth(visible[i] || "", width);
          const group = rowGroup(lineIdx);
          const bounds = selectionBounds();
          const selected = (state.mode === "select" || state.mode === "comment") && group >= bounds.start && group <= bounds.end;
          if (selected) {
            const marker = lineIdx === groupEnd(state.selectEnd) ? "▸" : "┃";
            const marked = line.replace("│", theme.fg("accent", marker));
            line = theme.bg("selectedBg", marked + " ".repeat(Math.max(0, width - visibleWidth(marked))));
          } else if (!readOnly && group === rowGroup(state.cursor)) {
            line = theme.bg("selectedBg", line + " ".repeat(Math.max(0, width - visibleWidth(line))));
          }
          lines.push(line);
        } else {
          lines.push(theme.fg("dim", "~"));
        }
      }

      lines.push(theme.fg("borderMuted", "─".repeat(width)));
      lines.push(...renderFooter(width));

      return lines;
    },

    handleInput(data: string): ViewerAction {
      if (!state.file) return { type: "none" };
      const lineJump = matchesKey(data, "shift+g");
      if (/^\d$/.test(data) && state.mode === "normal") {
        state.pendingCount += data;
        return { type: "none" };
      }
      const requestedLine = lineJump ? takePendingLineNumber() : null;
      if (!lineJump) state.pendingCount = "";
      if (readOnly) {
        const halfPage = Math.max(1, Math.floor(state.height / 2));
        if (matchesKey(data, "g")) state.cursor = 0;
        else if (lineJump) {
          if (requestedLine !== null) jumpToLine(requestedLine);
          else state.cursor = groupStart(Math.max(0, state.renderedLines.lines.length - 1));
        }
        else if (matchesKey(data, Key.pageDown) || matchesKey(data, "ctrl+d")) moveViewportByRows(1, halfPage);
        else if (matchesKey(data, Key.pageUp) || matchesKey(data, "ctrl+u")) moveViewportByRows(-1, halfPage);
        else if (matchesKey(data, "w")) {
          state.wordWrap = !state.wordWrap;
          state.lastRenderWidth = 0;
        }
        else return { type: "none" };
        ensureCursorVisible();
        return { type: "none" };
      }

      if (state.mode === "comment") {
        if (matchesKey(data, "ctrl+enter") || matchesKey(data, "ctrl+d") || matchesKey(data, "alt+enter")) {
          const comment = state.commentText.trim();
          if (comment) {
            sendComment(comment);
          } else {
            setMode("normal");
          }
        } else if (matchesKey(data, Key.enter) || matchesKey(data, "shift+enter")) {
          insertCommentText("\n");
        } else if (matchesKey(data, Key.escape)) {
          setMode("normal");
        } else if (matchesKey(data, Key.left)) {
          state.commentCursor = Math.max(0, state.commentCursor - 1);
        } else if (matchesKey(data, Key.right)) {
          state.commentCursor = Math.min(commentGraphemes(state.commentText).length, state.commentCursor + 1);
        } else if (matchesKey(data, Key.backspace)) {
          deleteCommentBackward();
        } else {
          const text = commentInput.push(data);
          if (text) {
            insertCommentText(text);
          }
        }
        return { type: "none" };
      }

      if (state.mode === "search") {
        if (matchesKey(data, "/")) {
          resetSearch();
          searchInput.reset();
        } else if (matchesKey(data, Key.enter)) {
          setMode("normal", true);
        } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
          setMode("normal");
        } else if (matchesKey(data, Key.backspace)) {
          if (state.searchQuery) {
            state.searchQuery = state.searchQuery.slice(0, -1);
            updateSearchMatches();
          } else {
            setMode("normal");
          }
        } else {
          const text = searchInput.push(data);
          if (text) {
            state.searchQuery += text;
            updateSearchMatches();
          }
        }
        return { type: "none" };
      }

      if (matchesKey(data, "?") && state.mode === "normal") {
        state.showFullHelp = !state.showFullHelp;
        const maximumHeight = getResponsivePanelHeight(
          MAX_VIEWER_HEIGHT,
          MAX_VIEWER_HEIGHT,
          state.showFullHelp ? 9 : 8,
          process.stdout.rows,
          OVERLAY_MAX_HEIGHT_RATIO
        );
        state.height = Math.min(state.height, maximumHeight);
        return { type: "none" };
      }
      if (matchesKey(data, "q") && state.mode !== "select") {
        return { type: "close" };
      }
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
        if (state.mode === "select") {
          setMode("normal");
        } else if (state.searchQuery) {
          resetSearch();
        } else {
          return { type: "close" };
        }
        return { type: "none" };
      }
      if (!state.selectable && (matchesKey(data, "/") || matchesKey(data, "v") || matchesKey(data, "c") || matchesKey(data, "shift+c"))) {
        return { type: "none" };
      }
      if (matchesKey(data, "/") && state.mode !== "select") {
        switchMarkdownToRaw();
        resetSearch();
        setMode("search");
        return { type: "none" };
      }
      if (matchesKey(data, "n") && state.mode !== "select" && state.searchMatches.length > 0) {
        jumpToNextMatch(1);
        return { type: "none" };
      }
      if (matchesKey(data, "shift+n") && state.mode !== "select" && state.searchMatches.length > 0) {
        jumpToNextMatch(-1);
        return { type: "none" };
      }
      if (matchesKey(data, "j") || matchesKey(data, Key.down)) {
        if (state.mode === "select") {
          const next = groupEnd(state.selectEnd) + 1;
          if (next < state.renderedLines.lines.length) state.selectEnd = state.cursor = next;
          ensureCursorVisible();
        } else {
          moveCursor(1);
        }
        return { type: "none" };
      }
      if (matchesKey(data, "k") || matchesKey(data, Key.up)) {
        if (state.mode === "select") {
          const previous = groupStart(state.selectEnd) - 1;
          if (previous >= groupStart(state.selectStart)) state.selectEnd = state.cursor = previous;
          ensureCursorVisible();
        } else {
          moveCursor(-1);
        }
        return { type: "none" };
      }
      const halfPage = Math.max(1, Math.floor(state.height / 2));
      if (matchesKey(data, Key.pageDown) || matchesKey(data, "ctrl+d")) {
        if (state.mode === "select") {
          for (let step = 0; step < halfPage; step++) {
            const next = stepGroup(state.selectEnd, 1);
            if (next === null) break;
            state.selectEnd = state.cursor = next;
          }
          ensureCursorVisible();
        } else {
          moveViewportByRows(1, halfPage);
        }
        ensureCursorVisible();
        return { type: "none" };
      }
      if (matchesKey(data, Key.pageUp) || matchesKey(data, "ctrl+u")) {
        if (state.mode === "select") {
          const start = groupStart(state.selectStart);
          for (let step = 0; step < halfPage; step++) {
            const previous = stepGroup(state.selectEnd, -1);
            if (previous === null || previous < start) break;
            state.selectEnd = state.cursor = previous;
          }
          ensureCursorVisible();
        } else {
          moveViewportByRows(-1, halfPage);
        }
        ensureCursorVisible();
        return { type: "none" };
      }
      if (matchesKey(data, "g")) {
        if (state.mode === "select") {
          state.selectEnd = state.selectStart;
          state.cursor = state.selectStart;
        } else {
          state.cursor = 0;
        }
        ensureCursorVisible();
        return { type: "none" };
      }
      if (lineJump) {
        if (requestedLine !== null && state.mode !== "select") {
          jumpToLine(requestedLine);
        } else {
          state.cursor = groupStart(Math.max(0, state.renderedLines.lines.length - 1));
          if (state.mode === "select") state.selectEnd = state.cursor;
          ensureCursorVisible();
        }
        return { type: "none" };
      }
      if (matchesKey(data, "+") || matchesKey(data, "=")) {
        const maximumHeight = getResponsivePanelHeight(
          MAX_VIEWER_HEIGHT,
          MAX_VIEWER_HEIGHT,
          state.showFullHelp ? 9 : 8,
          process.stdout.rows,
          OVERLAY_MAX_HEIGHT_RATIO
        );
        state.height = Math.min(maximumHeight, state.height + 5);
        clampScroll();
        return { type: "none" };
      }
      if (matchesKey(data, "-") || matchesKey(data, "_")) {
        state.height = Math.max(MIN_PANEL_HEIGHT, state.height - 5);
        clampScroll();
        return { type: "none" };
      }
      if (matchesKey(data, "y") && state.mode === "normal") {
        copyPath();
        return { type: "none" };
      }
      if (matchesKey(data, "w") && state.mode !== "select") {
        state.wordWrap = !state.wordWrap;
        state.lastRenderWidth = 0;
        return { type: "none" };
      }
      if (matchesKey(data, "d") && state.mode !== "select" && state.file.gitStatus && !isUntrackedStatus(state.file.gitStatus)) {
        state.diffMode = !state.diffMode;
        state.lastRenderWidth = 0;
        state.scroll = 0;
        state.cursor = 0;
        return { type: "none" };
      }
      if (matchesKey(data, "m") && state.mode !== "select") {
        toggleMarkdownMode();
        return { type: "none" };
      }
      if (matchesKey(data, "v")) {
        if (state.mode === "select") {
          setMode("normal");
          return { type: "none" };
        }
        switchMarkdownToRaw();
        state.cursor = groupStart(state.cursor);
        state.mode = "select";
        state.selectStart = state.cursor;
        state.selectEnd = state.cursor;
        return { type: "none" };
      }
      if (matchesKey(data, "shift+c") && state.mode === "select") {
        openComment("file");
        return { type: "none" };
      }
      if (matchesKey(data, "c") && state.mode === "select") {
        openComment("selection");
        return { type: "none" };
      }
      if (matchesKey(data, "]") && state.mode !== "select") {
        return { type: "navigate", direction: 1 };
      }
      if (matchesKey(data, "[") && state.mode !== "select") {
        return { type: "navigate", direction: -1 };
      }

      return { type: "none" };
    },
  };
}
