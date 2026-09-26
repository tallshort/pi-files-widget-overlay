import { copyToClipboard, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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
import { createViewerCommentEditor, type CommentScope } from "./viewer-comment-editor";
import { classifyViewerInput, type ViewerInputCommand } from "./viewer-input";
import { createViewerSearch } from "./viewer-search";
import { createViewerViewport } from "./viewer-viewport";

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
  diffMode: boolean;
  renderMarkdown: boolean;
  wordWrap: boolean;
  mode: ViewerMode;
  lastRenderWidth: number;
  lastLoadedMtimeMs: number | null;
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
  copyPath(onResult?: (success: boolean) => void): void;
  isPathCopied(): boolean;
}

export interface ViewerConfig {
  getRoot: () => string;
  projectCwd: string;
  readOnly?: boolean;
  requestRender?: () => void;
  wordWrapByPath?: Map<string, boolean>;
}

export function createViewer(
  config: ViewerConfig,
  theme: Theme,
  requestComment: (payload: CommentPayload, comment: string) => void
): ViewerController {
  const { getRoot, projectCwd, readOnly = false, requestRender, wordWrapByPath } = config;
  let pathCopiedUntil = 0;
  let copyErrorUntil = 0;
  let copyGeneration = 0;
  const search = createViewerSearch();
  const commentEditor = createViewerCommentEditor();
  const viewport = createViewerViewport(getResponsivePanelHeight(DEFAULT_VIEWER_HEIGHT, MAX_VIEWER_HEIGHT, 8));

  const state: ViewerState = {
    file: null,
    renderedLines: { lines: [], rowGroups: [], logicalLines: [] },
    rawContent: "",
    diffMode: false,
    renderMarkdown: true,
    wordWrap: false,
    mode: "normal",
    lastRenderWidth: 0,
    lastLoadedMtimeMs: null,
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
    viewport.reset();
    const width = state.lastRenderWidth || process.stdout.columns || 80;
    reloadContent(width);
    return true;
  }

  function toggleMarkdownMode(): void {
    if (!isMarkdownFile() || state.diffMode) return;
    state.renderMarkdown = !state.renderMarkdown;
    state.lastRenderWidth = 0;
    search.reset();
    setMode("normal");
  }

  function clearSelection(): void {
    viewport.clearSelection();
  }

  function openComment(scope: CommentScope): void {
    commentEditor.open(scope);
    state.mode = "comment";
  }

  function setMode(mode: ViewerMode, preserveSearch = false): void {
    if (mode !== state.mode) {
      search.resetInput();
      commentEditor.reset();
    }
    state.mode = mode;
    if (mode !== "search" && !preserveSearch) search.reset();
    if (mode !== "comment") commentEditor.reset();
    if (mode === "normal") {
      clearSelection();
    }
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
    const { cursor, scroll } = viewport.snapshot();
    const paragraph = renderedMarkdownParagraphAt(cursor);
    return paragraph && paragraph.text
      ? { ...paragraph, viewportOffset: cursor - scroll }
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
    const viewportAnchor = viewport.captureAnchor();
    const preserveSelection = state.mode === "select" || state.mode === "comment";
    refreshRawContent();
    const hasChanges = !!state.file.gitStatus;
    const result = loadFileContent(
      state.file.path,
      { cwd: getRoot(), diffMode: state.diffMode, hasChanges, width, renderMarkdown: state.renderMarkdown, wordWrap: state.wordWrap },
      theme
    );
    state.renderedLines = result;
    viewport.setLayout(result.rowGroups, result.logicalLines.length);
    state.selectable = result.selectable !== false;
    if (!state.selectable) {
      state.rawContent = "";
      setMode("normal");
    }
    const anchoredRow = markdownAnchor && result.renderedMarkdown
      ? findRenderedMarkdownAnchor(markdownAnchor.text, markdownAnchor.rowOffset)
      : null;
    if (restoreRenderedMarkdown && result.renderedMarkdown) {
      viewport.setPosition(anchoredRow ?? 0, anchoredRow === null ? 0 : Math.max(0, anchoredRow - (markdownAnchor?.viewportOffset ?? 0)));
    } else {
      viewport.restoreAnchor(viewportAnchor, preserveSelection);
    }
    state.renderMarkdown = result.renderedMarkdown;
    state.lastRenderWidth = width;
    if (search.snapshot().query) revealSearchLine(search.refresh(searchableLines(), true));
  }

  function searchableLines(): string[] {
    return state.diffMode ? state.renderedLines.logicalLines : state.rawContent.split("\n");
  }

  function revealSearchLine(line: number | null): void {
    if (line !== null) viewport.revealGroup(line, SEARCH_SCROLL_OFFSET);
  }

  function jumpToNextMatch(direction: 1 | -1): void {
    revealSearchLine(search.move(direction));
  }

  function buildCommentPayload(): CommentPayload | null {
    if (!state.file) return null;

    const rel = relative(projectCwd, state.file.path);
    const relPath = !rel || rel === ".." || rel.startsWith(`..${sep}`) ? state.file.path : rel;
    const ext = state.diffMode ? "diff" : state.file.name.split(".").pop() || "";
    if (commentEditor.getScope() === "file") {
      return { relPath, lineRange: "file", ext, selectedText: "", isFile: true };
    }

    const rawLines = state.rawContent.split("\n");
    const bounds = viewport.selectionBounds();
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

    const copyHint = Date.now() < pathCopiedUntil
      ? theme.fg("dim", " Path copied")
      : Date.now() < copyErrorUntil
        ? theme.fg("error", " Unable to copy path")
        : "";
    const fileNameWidth = Math.max(0, width - visibleWidth(copyHint));
    let header = theme.bold(theme.fg("text", truncateToWidth(sanitizeTerminalLabel(state.file.name), fileNameWidth, "…"))) + copyHint;
    if (isUntracked) header += theme.fg("dim", " [UNTRACKED]");
    if (state.diffMode) {
      header += theme.fg("warning", " [DIFF]");
    } else if (isMarkdownFile()) {
      header += theme.fg("accent", state.renderMarkdown ? " [RENDERED]" : " [RAW]");
    }
    header += theme.fg("accent", state.wordWrap ? " [WRAP]" : " [NO WRAP]");
    if (state.mode === "select" || state.mode === "comment") {
      const bounds = viewport.selectionBounds();
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

    const searchState = search.snapshot();
    if (state.mode === "search") {
      header += theme.fg("accent", `  /${searchState.query}${CURSOR_MARKER}█`);
    } else if (searchState.query) {
      const searchPosition = searchState.matchCount > 0
        ? `${searchState.matchIndex + 1}/${searchState.matchCount}`
        : "0/0";
      header += theme.fg("dim", `  /${searchState.query}  (Esc clears) [${searchPosition}]`);
    }

    return truncateToWidth(header, width);
  }

  function renderFooter(width: number): string[] {
    const lines: string[] = [];
    if (state.mode === "comment") {
      lines.push(...commentEditor.render(width, theme));
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
    } else {
      const markdownHelp = isMarkdownFile() && !state.diffMode ? "  m/r: raw/render" : "";
      const diffHelp = state.file?.gitStatus && !isUntrackedStatus(state.file.gitStatus) ? "  d: diff" : "";
      helpLines = state.showFullHelp
        ? [
            "j/k/↑/↓: move  PgUp/PgDn/Ctrl-U/Ctrl-D: page  g/G: line  w: wrap  y: copy path",
            `v: select${diffHelp}${markdownHelp}  []: change  +/-: height  ?: hide  q/Esc/←: back`,
          ]
        : [`/: search  n/N: match  v: select${markdownHelp}${diffHelp}  y: copy path  ?: help  q: back`];
    }
    lines.push(...helpLines.map(line => truncateToWidth(theme.fg("dim", line), width)));

    return lines;
  }

  function copyPath(onResult?: (success: boolean) => void): void {
    const copiedPath = state.file?.path;
    const generation = ++copyGeneration;
    if (!copiedPath) return;

    const finishCopy = (success: boolean): void => {
      if (generation !== copyGeneration || state.file?.path !== copiedPath) return;
      pathCopiedUntil = success ? Date.now() + 3000 : 0;
      copyErrorUntil = success ? 0 : Date.now() + 3000;
      onResult?.(success);
      requestRender?.();
      setTimeout(() => requestRender?.(), 3000);
    };

    void copyToClipboard(copiedPath).then(
      () => finishCopy(true),
      () => finishCopy(false),
    );
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
      copyErrorUntil = 0;
      copyGeneration += 1;
      state.file = file;
      viewport.reset();
      state.diffMode = !!file.gitStatus && !isUntrackedStatus(file.gitStatus);
      state.renderMarkdown = isMarkdownPath(file.path);
      state.wordWrap = wordWrapByPath?.get(file.path) ?? false;
      state.showFullHelp = false;
      setMode("normal");
      state.renderedLines = { lines: [], rowGroups: [], logicalLines: [] };
      viewport.setLayout([], 0);
      state.lastRenderWidth = 0;
      state.lastLoadedMtimeMs = null;
      refreshRawContent();
    },

    updateFileRef(file: FileNode | null): void {
      if (state.file?.path !== file?.path) {
        pathCopiedUntil = 0;
        copyErrorUntil = 0;
        copyGeneration += 1;
      }
      state.file = file;
      const storedWordWrap = file ? wordWrapByPath?.get(file.path) : undefined;
      if (storedWordWrap !== undefined && storedWordWrap !== state.wordWrap) {
        state.wordWrap = storedWordWrap;
        state.lastRenderWidth = 0;
      }
      if (state.diffMode && (!file?.gitStatus || isUntrackedStatus(file.gitStatus))) {
        state.diffMode = false;
        setMode("normal");
        viewport.setPosition(0, 0);
        state.renderMarkdown = !!file && isMarkdownPath(file.path);
        state.lastRenderWidth = 0;
        refreshRawContent();
      }
    },
    close(): void {
      pathCopiedUntil = 0;
      copyErrorUntil = 0;
      copyGeneration += 1;
      state.file = null;
      state.renderedLines = { lines: [], rowGroups: [], logicalLines: [] };
      viewport.setLayout([], 0);
      viewport.reset();
      state.rawContent = "";
      state.renderMarkdown = true;
      state.wordWrap = false;
      state.showFullHelp = false;
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

      const { scroll, height } = viewport.snapshot();
      const visible = state.renderedLines.lines.slice(scroll, scroll + height);
      for (let i = 0; i < height; i++) {
        if (i < visible.length) {
          const lineIdx = scroll + i;
          let line = truncateToWidth(visible[i] || "", width);
          const marker = (state.mode === "select" || state.mode === "comment")
            ? viewport.selectionMarker(lineIdx)
            : null;
          if (marker) {
            const marked = line.replace("│", theme.fg("accent", marker));
            line = theme.bg("selectedBg", marked + " ".repeat(Math.max(0, width - visibleWidth(marked))));
          } else if (!readOnly && viewport.isCursorGroup(lineIdx)) {
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
      const searchState = search.snapshot();
      const command: ViewerInputCommand = classifyViewerInput(data, {
        mode: state.mode,
        readOnly,
        selectable: state.selectable,
        hasSearchMatches: searchState.matchCount > 0,
        canDiff: !!state.file.gitStatus && !isUntrackedStatus(state.file.gitStatus),
      });
      if (command.type === "count") {
        viewport.appendCount(command.digit);
        return { type: "none" };
      }
      const requestedLine = command.type === "bottom-or-line" ? viewport.takeCount() : null;
      if (command.type !== "bottom-or-line") viewport.clearCount();

      switch (command.type) {
        case "comment-input": {
          const result = commentEditor.handleInput(data);
          if (result.type === "finish") {
            if (result.comment) sendComment(result.comment);
            else setMode("normal");
          } else if (result.type === "cancel") {
            setMode("normal");
          }
          break;
        }
        case "search-input": {
          const result = search.handleInput(data, searchableLines());
          if (result.type === "confirm") setMode("normal", true);
          else if (result.type === "cancel") setMode("normal");
          else revealSearchLine(result.line);
          break;
        }
        case "toggle-help": {
          state.showFullHelp = !state.showFullHelp;
          const maximumHeight = getResponsivePanelHeight(
            MAX_VIEWER_HEIGHT,
            MAX_VIEWER_HEIGHT,
            state.showFullHelp ? 9 : 8,
            process.stdout.rows,
            OVERLAY_MAX_HEIGHT_RATIO
          );
          viewport.resize(Math.min(viewport.snapshot().height, maximumHeight));
          break;
        }
        case "close":
          return { type: "close" };
        case "back":
          if (state.mode === "select") setMode("normal");
          else if (search.snapshot().query) search.reset();
          else return { type: "close" };
          break;
        case "start-search":
          switchMarkdownToRaw();
          search.reset();
          setMode("search");
          break;
        case "search-match":
          jumpToNextMatch(command.direction);
          break;
        case "move":
        case "page":
        case "top":
          viewport.navigate(command, state.mode === "select");
          break;
        case "bottom-or-line":
          if (requestedLine !== null && state.mode !== "select") {
            viewport.navigate({ type: "line", lineNumber: requestedLine }, false);
          } else {
            viewport.navigate({ type: "bottom" }, state.mode === "select");
          }
          break;
        case "resize": {
          const currentHeight = viewport.snapshot().height;
          if (command.direction < 0) {
            viewport.resize(Math.max(MIN_PANEL_HEIGHT, currentHeight - 5));
          } else {
            const maximumHeight = getResponsivePanelHeight(
              MAX_VIEWER_HEIGHT,
              MAX_VIEWER_HEIGHT,
              state.showFullHelp ? 9 : 8,
              process.stdout.rows,
              OVERLAY_MAX_HEIGHT_RATIO
            );
            viewport.resize(Math.min(maximumHeight, currentHeight + 5));
          }
          break;
        }
        case "copy-path":
          copyPath();
          break;
        case "toggle-wrap":
          state.wordWrap = !state.wordWrap;
          if (state.file && wordWrapByPath) wordWrapByPath.set(state.file.path, state.wordWrap);
          state.lastRenderWidth = 0;
          break;
        case "toggle-diff":
          state.diffMode = !state.diffMode;
          state.lastRenderWidth = 0;
          viewport.setPosition(0, 0);
          break;
        case "toggle-markdown":
          toggleMarkdownMode();
          break;
        case "toggle-selection":
          if (state.mode === "select") {
            setMode("normal");
          } else {
            switchMarkdownToRaw();
            viewport.beginSelection();
            state.mode = "select";
          }
          break;
        case "comment":
          openComment(command.scope);
          break;
        case "navigate-file":
          return { type: "navigate", direction: command.direction };
        case "none":
          break;
      }
      return { type: "none" };
    }
  };
}
