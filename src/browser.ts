import { createGrepTool, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { lstatSync, realpathSync, statSync, type Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  DEFAULT_BROWSER_HEIGHT,
  getResponsivePanelHeight,
  OVERLAY_MAX_HEIGHT_RATIO,
  LINE_COUNT_BATCH_DELAY_MS,
  LINE_COUNT_BATCH_SIZE,
  MAX_BROWSER_HEIGHT,
  MAX_LINE_COUNT_BYTES,
  MAX_TREE_DEPTH,
  MIN_PANEL_HEIGHT,
  POLL_INTERVAL_MS,
  SCAN_BATCH_DELAY_MS,
  SCAN_BATCH_SIZE,
  SAFE_MODE_ENTRY_THRESHOLD,
} from "./constants";
import { getGitBranchAsync, getGitDiffStatsAsync, getGitFileListAsync, getGitStatusAsync, isGitRepoAsync } from "./git";
import { buildFileTreeFromPaths, flattenTree, getIgnoredNames, sortChildren, updateTreeStats } from "./file-tree";
import type { DiffStats, FileNode, FlatNode } from "./types";
import { formatErrorMessage, isIgnoredStatus, isUntrackedStatus, sanitizeTerminalLabel } from "./utils";
import { createViewer, type CommentPayload, type ViewerAction } from "./viewer";
import { createTextInputBuffer } from "./input-utils";

const MIN_PREVIEW_WIDTH = 80;
const CONTENT_SEARCH_DEBOUNCE_MS = 150;

export interface BrowserController {
  getRootPath(): string;
  getRootAnchor(): { label: string; index: number; count: number } | null;
  getActivityLabel(): string;
  getRestorePath(): string | null;
  isPathCopied(): boolean;
  render(width: number): string[];
  handleInput(data: string): void;
  getBrowsePosition(): { rootPath: string; directoryPath: string; selectedFilePath: string | null };
  invalidate(): void;
}

interface BrowserStats {
  totalLines?: number;
  additions: number;
  deletions: number;
}

export interface RootAnchor {
  id: string;
  path: string;
  label: string;
}

interface RootLocation {
  rootPath: string;
  directoryPath: string;
  selectedFilePath: string | null;
}


type ScanMode = "full" | "safe" | "none";

interface ScanState {
  mode: ScanMode;
  isScanning: boolean;
  isPartial: boolean;
  pending: number;
}

interface BrowserState {
  root: FileNode | null;
  flatList: FlatNode[];
  fullList: FlatNode[];
  stats: BrowserStats;
  nodeByPath: Map<string, FileNode>;
  scanState: ScanState;
  selectedIndex: number;
  searchQuery: string;
  searchMode: boolean;
  searchKind: "filename" | "content";
  contentMatches: Set<string>;
  showOnlyChanged: boolean;
  expandedChangedView: boolean;
  expandedForChangedView: Set<string>;
  focusFirstChildOf: string | null;
  errorMessage: string | null;
  contentSearchError: string | null;
  browserHeight: number;
  lastPollTime: number;
}

interface ChangedFile {
  file: FileNode;
  ancestors: FileNode[];
}


function findNodeByPath(root: FileNode | null, path: string): FileNode | null {
  if (!root) return null;
  if (root.path === path) return root;
  if (!root.children) return null;

  for (const child of root.children) {
    const found = findNodeByPath(child, path);
    if (found) return found;
  }

  return null;
}

function indexNodes(root: FileNode | null, map: Map<string, FileNode>): void {
  map.clear();
  if (!root) return;
  const stack: FileNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    map.set(node.path, node);
    if (node.children) {
      for (const child of node.children) {
        stack.push(child);
      }
    }
  }
}

function getNodeDepth(node: FileNode, root: string): number {
  if (node.path === root) return 0;
  const rel = relative(root, node.path);
  if (!rel) return 0;
  return rel.split(sep).length;
}

function formatRootPath(path: string): string {
  const home = homedir();
  if (!home) return path;
  if (path === home) return "~";
  if (path.startsWith(home + sep)) return "~" + path.slice(home.length);
  return path;
}

function safeRealPathSync(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function getPathInfoSync(path: string): { isDirectory: boolean; isSymlink: boolean; realPath?: string } {
  try {
    const linkStat = lstatSync(path);
    const isSymlink = linkStat.isSymbolicLink();
    const targetStat = isSymlink ? statSync(path) : linkStat;
    return {
      isDirectory: targetStat.isDirectory(),
      isSymlink,
      realPath: targetStat.isDirectory() ? safeRealPathSync(path) : undefined,
    };
  } catch {
    return { isDirectory: false, isSymlink: false };
  }
}

async function getPathInfo(path: string, isSymlink: boolean): Promise<{ isDirectory: boolean; isSymlink: boolean; realPath?: string }> {
  try {
    const targetStat = await stat(path);
    return {
      isDirectory: targetStat.isDirectory(),
      isSymlink,
      realPath: targetStat.isDirectory() ? await realpath(path).catch(() => resolve(path)) : undefined,
    };
  } catch {
    return { isDirectory: false, isSymlink };
  }
}

function hasAncestorRealPath(node: FileNode | undefined, realPath: string): boolean {
  let current = node;
  while (current) {
    if (current.realPath === realPath) return true;
    current = current.parent;
  }
  return false;
}

function shouldSafeMode(path: string): boolean {
  const resolved = resolve(path);
  const home = resolve(homedir());
  const root = resolve(sep);
  return resolved === home || resolved === root;
}

function collectChangedFiles(node: FileNode, ancestors: FileNode[] = []): ChangedFile[] {
  const results: ChangedFile[] = [];

  if (!node.isDirectory && (node.gitStatus || node.agentModified)) {
    results.push({ file: node, ancestors: [...ancestors] });
  }

  if (node.children) {
    for (const child of node.children) {
      results.push(...collectChangedFiles(child, [...ancestors, node]));
    }
  }

  return results;
}

function getTreeStats(root: FileNode | null): BrowserStats {
  if (!root) {
    return { totalLines: undefined, additions: 0, deletions: 0 };
  }

  return {
    totalLines: root.lineCountComplete ? root.totalLines ?? 0 : undefined,
    additions: root.totalAdditions ?? 0,
    deletions: root.totalDeletions ?? 0,
  };
}

function formatNodeStatus(node: FileNode, theme: Theme): string {
  if (isIgnoredStatus(node.gitStatus)) return "";
  if (node.agentModified) return theme.fg("accent", " 🤖");
  if (node.gitStatus === "M" || node.gitStatus === "MM") return theme.fg("warning", " M");
  if (isUntrackedStatus(node.gitStatus)) return theme.fg("dim", " ?");
  if (node.gitStatus === "A") return theme.fg("success", " A");
  if (node.gitStatus === "D") return theme.fg("error", " D");
  return "";
}

function formatNodeMeta(node: FileNode, theme: Theme): string {
  if (isIgnoredStatus(node.gitStatus)) return "";

  const parts: string[] = [];

  if (node.isDirectory && !node.expanded) {
    if (node.totalAdditions && node.totalAdditions > 0) {
      parts.push(theme.fg("success", `+${node.totalAdditions}`));
    }
    if (node.totalDeletions && node.totalDeletions > 0) {
      parts.push(theme.fg("error", `-${node.totalDeletions}`));
    }
    if (node.totalLines && node.lineCountComplete !== false) {
      parts.push(theme.fg("dim", `${node.totalLines}L`));
    }
  } else if (!node.isDirectory) {
    if (node.diffStats) {
      if (node.diffStats.additions > 0) {
        parts.push(theme.fg("success", `+${node.diffStats.additions}`));
      }
      if (node.diffStats.deletions > 0) {
        parts.push(theme.fg("error", `-${node.diffStats.deletions}`));
      }
    } else if (isUntrackedStatus(node.gitStatus) && node.lineCount !== undefined) {
      parts.push(theme.fg("success", `+${node.lineCount}`));
    }
    if (node.lineCount !== undefined) {
      parts.push(theme.fg("dim", `${node.lineCount}L`));
    }
  }

  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function withSymlinkMarker(label: string, node: FileNode, theme: Theme): string {
  return node.isSymlink ? `${label}${theme.fg("dim", " ↗")}` : label;
}

function formatNodeName(node: FileNode, theme: Theme): string {
  const name = sanitizeTerminalLabel(node.name);
  if (isIgnoredStatus(node.gitStatus)) return withSymlinkMarker(theme.fg("dim", name), node, theme);
  if (node.isDirectory) {
    const label = node.hasChangedChildren ? theme.fg("warning", name) : theme.fg("accent", name);
    const rendered = withSymlinkMarker(label, node, theme);
    return node.loading ? `${rendered}${theme.fg("dim", " ~")}` : rendered;
  }
  if (node.gitStatus) return withSymlinkMarker(theme.fg("warning", name), node, theme);
  return withSymlinkMarker(theme.fg("text", name), node, theme);
}

function collapseAllExcept(node: FileNode, keep: Set<FileNode>): void {
  if (node.isDirectory) {
    node.expanded = keep.has(node);
    if (node.children) {
      for (const child of node.children) {
        collapseAllExcept(child, keep);
      }
    }
  }
}

export function createFileBrowser(
  initialPath: string,
  agentModifiedFiles: Set<string>,
  theme: Theme,
  onClose: () => void,
  requestComment: (payload: CommentPayload, comment: string) => void,
  requestRender: () => void,
  projectCwd: string = initialPath,
  initialSelectedPath?: string,
  initialDirectoryPath?: string,
  rootAnchors: RootAnchor[] = [{ id: resolve(initialPath), path: resolve(initialPath), label: "." }],
  options: { readDirectory?: (path: string) => Promise<Dirent[]>; togglePinnedRoot?: (path: string) => Promise<{ anchors: RootAnchor[]; message: string }> } = {}
): BrowserController {
  const ignored = getIgnoredNames();
  const readDirectory = options.readDirectory ?? (path => readdir(path, { withFileTypes: true }));

  let rootPath = resolve(initialPath);
  let repo = false;
  let activeAnchorIndex = rootAnchors.length > 1 ? 0 : Math.max(0, rootAnchors.findIndex(anchor => anchor.path === rootPath));
  const anchorLocations = new Map<string, RootLocation>();
  let initialRoot = rootAnchors.length > 1 ? rootAnchors[activeAnchorIndex]?.path ?? rootPath : rootPath;
  let usesGitTree = false;
  let gitStatus = new Map<string, string>();
  let diffStats = new Map<string, DiffStats>();
  let gitBranch = "";
  const gitErrors = new Set<string>();

  const viewer = createViewer({ getRoot: () => rootPath, projectCwd, requestRender }, theme, requestComment);
  const previewViewer = createViewer({ getRoot: () => rootPath, projectCwd, readOnly: true, requestRender }, theme, requestComment);
  let previewPath: string | null = null;
  let lastRenderWidth = 0;
  let previewEnabled = true;
  let showFullHelp = false;
  let pendingRestorePath = initialSelectedPath ? resolve(initialSelectedPath) : initialDirectoryPath ? resolve(initialDirectoryPath) : null;
  let restoredDirectoryPath = initialDirectoryPath ? resolve(initialDirectoryPath) : null;
  let restoreNotice = initialDirectoryPath ? relative(rootPath, resolve(initialDirectoryPath)) || "." : null;
  const textInput = createTextInputBuffer();

  const scanState: ScanState = {
    mode: "none",
    isScanning: false,
    isPartial: false,
    pending: 0,
  };

  const browser: BrowserState = {
    root: null,
    flatList: [],
    fullList: [],
    stats: { totalLines: undefined, additions: 0, deletions: 0 },
    nodeByPath: new Map<string, FileNode>(),
    scanState,
    selectedIndex: 0,
    searchQuery: "",
    searchMode: false,
    searchKind: "filename",
    contentMatches: new Set(),
    showOnlyChanged: false,
    expandedChangedView: false,
    expandedForChangedView: new Set<string>(),
    focusFirstChildOf: null,
    errorMessage: null,
    contentSearchError: null,
    browserHeight: getResponsivePanelHeight(DEFAULT_BROWSER_HEIGHT, MAX_BROWSER_HEIGHT, 9),
    lastPollTime: Date.now(),
  };

  const lineCountCache = new Map<string, { size: number; mtimeMs: number; count: number }>();
  const lineCountQueue: FileNode[] = [];
  const lineCountPending = new Set<string>();
  let lineCountTimer: ReturnType<typeof setTimeout> | null = null;

  const scanQueue: Array<{ node: FileNode; depth: number }> = [];
  const scanQueued = new Set<string>();
  let scanTimer: ReturnType<typeof setTimeout> | null = null;
  // Incremented on every (re-)root. In-flight async scan/line-count batches
  // capture the value when they start and bail after each await if it changed,
  // so work belonging to an old root can never mutate state for the new one.
  let rootGeneration = 0;
  // Also invalidate work when Git replaces the provisional filesystem tree at
  // the same root. Root generation alone cannot distinguish that transition.
  let treeGeneration = 0;
  let gitRefreshGeneration: number | null = null;
  let gitAbort = new AbortController();
  let contentSearchGeneration = 0;
  let contentSearchAbort: AbortController | null = null;
  let contentSearchTimer: ReturnType<typeof setTimeout> | null = null;
  let errorTimer: ReturnType<typeof setTimeout> | null = null;
  const grepTools = new Map<string, ReturnType<typeof createGrepTool>>();
  const normalizeGitPath = (path: string): string => path.split(sep).join("/");

  function clearContentSearch(): void {
    contentSearchAbort?.abort();
    if (contentSearchTimer) {
      clearTimeout(contentSearchTimer);
      contentSearchTimer = null;
    }
    contentSearchAbort = null;
    contentSearchGeneration += 1;
    browser.contentMatches.clear();
    browser.contentSearchError = null;
  }
  function scheduleContentSearch(): void {
    clearContentSearch();
    if (!browser.searchQuery) return;
    contentSearchTimer = setTimeout(() => {
      contentSearchTimer = null;
      runContentSearch();
    }, CONTENT_SEARCH_DEBOUNCE_MS);
  }

  function runContentSearch(): void {
    clearContentSearch();
    if (!browser.searchQuery) return;
    const generation = contentSearchGeneration;
    const root = rootPath;
    const controller = new AbortController();
    contentSearchAbort = controller;
    let grep = grepTools.get(root);
    if (!grep) {
      grep = createGrepTool(root);
      grepTools.set(root, grep);
    }
    void grep.execute("readfiles-content-search", { pattern: browser.searchQuery, path: ".", literal: true, context: 0, limit: 200 }, controller.signal, () => {})
      .then(result => {
        if (generation !== contentSearchGeneration || root !== rootPath) return;
        const matches = new Set<string>();
        const output = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
        for (const line of output.split("\n")) {
          const match = line.match(/^(.*):(\d+): /);
          if (match) matches.add(resolve(root, match[1]));
        }
        browser.contentMatches = matches;
        browser.contentSearchError = null;
        browser.selectedIndex = Math.min(browser.selectedIndex, Math.max(0, getDisplayList().length - 1));
      })
      .catch(error => {
        if (generation === contentSearchGeneration && root === rootPath && !controller.signal.aborted) {
          browser.contentSearchError = `Content search: ${formatErrorMessage(error)}`;
        }
      })
      .finally(() => {
        if (generation === contentSearchGeneration) {
          requestRender();
        }
      });
  }

  function activityLabels(): string[] {
    const labels: string[] = [];
    if (browser.scanState.isScanning) labels.push("… scanning");
    if (browser.errorMessage) labels.push(`⚠ ${browser.errorMessage}`);
    return labels;
  }

  function refreshLists(): void {
    browser.flatList = browser.root ? flattenTree(browser.root) : [];
    browser.fullList = browser.root ? flattenTree(browser.root, 0, true, true) : [];
  }

  function restoreInitialPosition(): boolean {
    if (!pendingRestorePath) return false;
    const node = browser.nodeByPath.get(pendingRestorePath);
    if (!node) {
      if (restoredDirectoryPath && pendingRestorePath !== restoredDirectoryPath && !browser.scanState.isScanning && browser.scanState.mode !== "safe") {
        pendingRestorePath = restoredDirectoryPath;
        return restoreInitialPosition();
      }
      return false;
    }
    const restoringDirectory = pendingRestorePath === restoredDirectoryPath;
    if ((restoringDirectory && !node.isDirectory) || (!restoringDirectory && node.isDirectory)) {
      if (!restoringDirectory && restoredDirectoryPath) {
        pendingRestorePath = restoredDirectoryPath;
        return restoreInitialPosition();
      }
      pendingRestorePath = null;
      return false;
    }
    for (let ancestor: FileNode | undefined = node; ancestor; ancestor = ancestor.parent) ancestor.expanded = true;
    refreshLists();
    const index = getDisplayList().findIndex(item => item.node.path === pendingRestorePath);
    if (index === -1) return false;
    browser.selectedIndex = index;
    pendingRestorePath = null;
    return true;
  }

  function scanPendingRestorePath(): void {
    if (!pendingRestorePath || browser.scanState.mode !== "safe" || !browser.root) return;
    const target = relative(rootPath, pendingRestorePath);
    if (!target || target === ".." || target.startsWith(`..${sep}`) || resolve(rootPath, target) !== pendingRestorePath) {
      if (pendingRestorePath === restoredDirectoryPath) pendingRestorePath = null;
      return;
    }

    const parts = target.split(sep).filter(Boolean);
    let current = browser.root;
    for (let index = 0; index < parts.length; index++) {
      if (current.children === undefined) {
        enqueueScan(current, index, true);
        return;
      }
      const next = current.children.find(child => child.name === parts[index]);
      if (!next) {
        if (restoredDirectoryPath && pendingRestorePath !== restoredDirectoryPath) {
          pendingRestorePath = restoredDirectoryPath;
          scanPendingRestorePath();
        } else {
          pendingRestorePath = null;
        }
        return;
      }
      if (index === parts.length - 1) {
        restoreInitialPosition();
        return;
      }
      if (!next.isDirectory) {
        if (restoredDirectoryPath && pendingRestorePath !== restoredDirectoryPath) {
          pendingRestorePath = restoredDirectoryPath;
          scanPendingRestorePath();
        } else {
          pendingRestorePath = null;
        }
        return;
      }
      current = next;
    }
  }

  function retainRestoredDirectory(root: FileNode): void {
    if (!restoredDirectoryPath || !getPathInfoSync(restoredDirectoryPath).isDirectory) return;
    const target = relative(rootPath, restoredDirectoryPath);
    if (target === ".." || target.startsWith(`..${sep}`) || !target) return;

    let current = root;
    let currentPath = rootPath;
    for (const name of target.split(sep).filter(Boolean)) {
      currentPath = join(currentPath, name);
      let child = current.children?.find(node => node.path === currentPath);
      if (!child) {
        const pathInfo = getPathInfoSync(currentPath);
        if (!pathInfo.isDirectory) return;
        child = {
          name,
          path: currentPath,
          isDirectory: true,
          isSymlink: pathInfo.isSymlink,
          realPath: pathInfo.realPath,
          parent: current,
          children: [],
          expanded: false,
          hasChangedChildren: false,
          gitStatus: gitStatus.get(normalizeGitPath(relative(rootPath, currentPath))),
          diffStats: diffStats.get(normalizeGitPath(relative(rootPath, currentPath))),
        };
        current.children ??= [];
        current.children.push(child);
        sortChildren(current);
      }
      if (!child.isDirectory) return;
      current = child;
    }
  }

  function replaceTree(root: FileNode): void {
    const selectedPath = getDisplayList()[browser.selectedIndex]?.node.path;
    const expandedPaths = new Set(
      [...browser.nodeByPath.values()].filter(node => node.isDirectory && node.expanded).map(node => node.path)
    );
    const changedExpansionPaths = new Set(browser.expandedForChangedView);
    const viewingFile = viewer.getFile();

    // Cancel provisional work before publishing the Git-backed tree. In-flight
    // batches also compare treeGeneration after each await.
    treeGeneration += 1;
    scanQueue.length = 0;
    scanQueued.clear();
    lineCountQueue.length = 0;
    lineCountPending.clear();

    // Git does not list empty directories. Keep a restored directory in the
    // replacement tree so reopening an empty folder remains a valid location.
    retainRestoredDirectory(root);
    browser.root = root;
    browser.scanState.mode = "none";
    browser.scanState.isScanning = false;
    browser.scanState.isPartial = false;
    browser.scanState.pending = 0;
    indexNodes(root, browser.nodeByPath);
    for (const path of expandedPaths) {
      const node = browser.nodeByPath.get(path);
      if (node?.isDirectory) node.expanded = true;
    }
    browser.expandedForChangedView = new Set([...changedExpansionPaths].filter(path => browser.nodeByPath.has(path)));
    refreshLists();

    if (selectedPath) {
      const index = getDisplayList().findIndex(item => item.node.path === selectedPath);
      if (index !== -1) browser.selectedIndex = index;
    }
    browser.selectedIndex = Math.min(browser.selectedIndex, Math.max(0, getDisplayList().length - 1));
    restoreInitialPosition();

    if (viewingFile) {
      const node = browser.nodeByPath.get(viewingFile.path) ?? null;
      if (node) {
        if (node.lineCount === undefined && viewingFile.lineCount !== undefined) node.lineCount = viewingFile.lineCount;
        viewer.updateFileRef(node);
      }
    }
    queueLineCountsForDirectory(root);
  }
  function reportError(message: string): void {
    browser.errorMessage = message;
    if (errorTimer) clearTimeout(errorTimer);
    errorTimer = setTimeout(() => {
      browser.errorMessage = null;
      errorTimer = null;
      requestRender();
    }, 3000);
    requestRender();
  }

  function reportGitError(operation: string): void {
    gitErrors.add(`${operation} unavailable`);
    requestRender();
  }

  function clearGitError(operation: string): void {
    gitErrors.delete(`${operation} unavailable`);
  }

  function focusFirstChild(directory: FileNode): boolean {
    const child = directory.children?.[0];
    if (!child) return false;
    const index = getDisplayList().findIndex(entry => entry.node.path === child.path);
    if (index === -1) return false;
    browser.selectedIndex = index;
    return true;
  }

  function queueLineCount(node: FileNode, force = false): void {
    if (node.isDirectory) return;
    if (!force && node.lineCount !== undefined) return;
    if (lineCountPending.has(node.path)) return;
    lineCountPending.add(node.path);
    lineCountQueue.push(node);
    if (!lineCountTimer) {
      lineCountTimer = setTimeout(processLineCountBatch, LINE_COUNT_BATCH_DELAY_MS);
    }
  }

  function queueLineCountsForDirectory(directory: FileNode | null): void {
    if (!directory?.children) return;
    for (const child of directory.children) {
      if (!child.isDirectory) queueLineCount(child);
    }
  }

  async function updateLineCount(node: FileNode): Promise<void> {
    try {
      const fileStat = await stat(node.path);
      if (fileStat.size > MAX_LINE_COUNT_BYTES) {
        node.lineCount = undefined;
        return;
      }
      const cached = lineCountCache.get(node.path);
      if (cached && cached.size === fileStat.size && cached.mtimeMs === fileStat.mtimeMs) {
        node.lineCount = cached.count;
        return;
      }
      const content = await readFile(node.path, "utf-8");
      const count = content.split("\n").length;
      node.lineCount = count;
      lineCountCache.set(node.path, { size: fileStat.size, mtimeMs: fileStat.mtimeMs, count });
    } catch {
      node.lineCount = undefined;
    }
  }

  async function processLineCountBatch(): Promise<void> {
    lineCountTimer = null;
    if (!browser.root) return;
    const generation = rootGeneration;
    const tree = treeGeneration;
    const batch = lineCountQueue.splice(0, LINE_COUNT_BATCH_SIZE);
    if (batch.length === 0) return;

    await Promise.all(
      batch.map(async node => {
        await updateLineCount(node);
        if (generation === rootGeneration && tree === treeGeneration) {
          lineCountPending.delete(node.path);
        }
      })
    );
    if (generation !== rootGeneration || tree !== treeGeneration) return;

    updateTreeStats(browser.root);
    browser.stats = getTreeStats(browser.root);
    refreshLists();
    requestRender();

    if (lineCountQueue.length > 0) {
      lineCountTimer = setTimeout(processLineCountBatch, LINE_COUNT_BATCH_DELAY_MS);
    }
  }

  function shouldAutoScan(depth: number): boolean {
    // In git repos the main tree comes from git file lists, not from filesystem
    // crawling. If the user expands a symlinked directory inside that tree, only
    // scan one level on demand; nested directories stay lazy until explicitly
    // expanded so links into large trees (iCloud/Drive/$HOME) don't trigger a
    // broad recursive crawl.
    if (usesGitTree) {
      return false;
    }
    if (browser.scanState.mode === "safe") {
      return depth <= 0;
    }
    return depth <= MAX_TREE_DEPTH;
  }

  function getScanBatchSize(): number {
    return browser.scanState.mode === "safe" ? 1 : SCAN_BATCH_SIZE;
  }

  function getScanDelay(): number {
    return browser.scanState.mode === "safe" ? SCAN_BATCH_DELAY_MS * 4 : SCAN_BATCH_DELAY_MS;
  }

  function enqueueScan(node: FileNode, depth: number, force = false): void {
    if (depth > MAX_TREE_DEPTH) return;
    if (!force && browser.scanState.mode === "safe" && depth > 0) return;
    if (node.children !== undefined || node.loading) return;
    if (scanQueued.has(node.path)) return;

    node.loading = true;
    scanQueued.add(node.path);
    scanQueue.push({ node, depth });
    browser.scanState.pending = scanQueue.length;
    browser.scanState.isScanning = true;

    if (!scanTimer) {
      scanTimer = setTimeout(processScanBatch, getScanDelay());
    }
  }

  async function scanDirectory(node: FileNode, depth: number, generation: number, tree: number): Promise<void> {
    try {
      const entries = await readDirectory(node.path);
      if (generation !== rootGeneration || tree !== treeGeneration) return;
      const sorted = [...entries].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

      if (node.path === rootPath && browser.scanState.mode === "full" && sorted.length >= SAFE_MODE_ENTRY_THRESHOLD) {
        browser.scanState.mode = "safe";
        browser.scanState.isPartial = true;
        scanQueue.length = 0;
        scanQueued.clear();
      }

      const dirs: FileNode[] = [];
      const files: FileNode[] = [];

      for (const entry of sorted) {
        if (ignored.has(entry.name)) continue;
        const fullPath = join(node.path, entry.name);
        const childDepth = depth + 1;

        if (entry.isDirectory()) {
          const dirRealPath = await realpath(fullPath).catch(() => resolve(fullPath));
          if (generation !== rootGeneration || tree !== treeGeneration) return;
          const dirNode: FileNode = {
            name: entry.name, path: fullPath, isDirectory: true, realPath: dirRealPath, parent: node,
            children: undefined, expanded: childDepth < 1, hasChangedChildren: false,
            gitStatus: gitStatus.get(normalizeGitPath(relative(rootPath, fullPath))),
            diffStats: diffStats.get(normalizeGitPath(relative(rootPath, fullPath))),
          };
          dirs.push(dirNode);
          browser.nodeByPath.set(fullPath, dirNode);
          if (shouldAutoScan(childDepth)) enqueueScan(dirNode, childDepth);
          continue;
        }

        if (entry.isSymbolicLink()) {
          const pathInfo = await getPathInfo(fullPath, true);
          if (generation !== rootGeneration || tree !== treeGeneration) return;
          if (pathInfo.isDirectory) {
            const isCycle = pathInfo.realPath ? hasAncestorRealPath(node, pathInfo.realPath) : false;
            const dirNode: FileNode = {
              name: entry.name, path: fullPath, isDirectory: true, isSymlink: true, realPath: pathInfo.realPath,
              parent: node, children: isCycle ? [] : undefined, expanded: childDepth < 1, hasChangedChildren: false,
              gitStatus: gitStatus.get(normalizeGitPath(relative(rootPath, fullPath))),
              diffStats: diffStats.get(normalizeGitPath(relative(rootPath, fullPath))),
            };
            dirs.push(dirNode);
            browser.nodeByPath.set(fullPath, dirNode);
            if (!isCycle && shouldAutoScan(childDepth)) enqueueScan(dirNode, childDepth);
            continue;
          }
          const symlinkFileNode: FileNode = {
            name: entry.name, path: fullPath, isDirectory: false, isSymlink: true, parent: node,
            agentModified: agentModifiedFiles.has(fullPath),
            gitStatus: gitStatus.get(normalizeGitPath(relative(rootPath, fullPath))),
            diffStats: diffStats.get(normalizeGitPath(relative(rootPath, fullPath))),
          };
          files.push(symlinkFileNode);
          browser.nodeByPath.set(fullPath, symlinkFileNode);
          queueLineCount(symlinkFileNode);
          continue;
        }

        const fileNode: FileNode = {
          name: entry.name, path: fullPath, isDirectory: false, parent: node, agentModified: agentModifiedFiles.has(fullPath),
          gitStatus: gitStatus.get(normalizeGitPath(relative(rootPath, fullPath))),
          diffStats: diffStats.get(normalizeGitPath(relative(rootPath, fullPath))),
        };
        files.push(fileNode);
        browser.nodeByPath.set(fullPath, fileNode);
        queueLineCount(fileNode);
      }

      node.children = [...dirs, ...files];
    } catch {
      if (generation === rootGeneration && tree === treeGeneration) {
        node.children = [];
        reportError(`Unable to scan ${node === browser.root ? "directory" : sanitizeTerminalLabel(node.name)}`);
      }
    } finally {
      if (generation === rootGeneration && tree === treeGeneration) {
        node.loading = false;
        scanQueued.delete(node.path);
      }
    }
  }

  async function processScanBatch(): Promise<void> {
    scanTimer = null;
    if (!browser.root) return;
    const generation = rootGeneration;
    const tree = treeGeneration;
    const batch = scanQueue.splice(0, getScanBatchSize());
    if (batch.length === 0) {
      browser.scanState.isScanning = false;
      browser.scanState.pending = 0;
      return;
    }

    for (const item of batch) {
      await scanDirectory(item.node, item.depth, generation, tree);
      if (generation !== rootGeneration || tree !== treeGeneration) return;
    }

    browser.scanState.pending = scanQueue.length;
    browser.scanState.isScanning = scanQueue.length > 0;

    updateTreeStats(browser.root);
    browser.stats = getTreeStats(browser.root);
    refreshLists();
    restoreInitialPosition();
    scanPendingRestorePath();
    if (browser.focusFirstChildOf) {
      const directory = browser.nodeByPath.get(browser.focusFirstChildOf);
      if (directory && focusFirstChild(directory)) browser.focusFirstChildOf = null;
    }
    requestRender();

    if (scanQueue.length > 0) {
      scanTimer = setTimeout(processScanBatch, getScanDelay());
    }
  }

  function stopBackgroundTasks(): void {
    // Closing or re-rooting must invalidate already-running batches too: clearing
    // only their timers lets an awaited scan reschedule itself after the overlay closes.
    rootGeneration += 1;
    gitAbort.abort();
    treeGeneration += 1;
    browser.scanState.isScanning = false;
    browser.scanState.pending = 0;
    browser.errorMessage = null;
    if (errorTimer) {
      clearTimeout(errorTimer);
      errorTimer = null;
    }
    if (lineCountTimer) {
      clearTimeout(lineCountTimer);
      lineCountTimer = null;
    }
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
    clearContentSearch();
  }

  function applyAgentModified(): void {
    for (const node of browser.nodeByPath.values()) {
      if (!node.isDirectory) {
        node.agentModified = agentModifiedFiles.has(node.path);
      }
    }
  }

  function applyGitUpdates(): void {
    for (const node of browser.nodeByPath.values()) {
      const relPath = normalizeGitPath(relative(rootPath, node.path));
      node.gitStatus = gitStatus.get(relPath);
      node.diffStats = diffStats.get(relPath);
    }
  }

  function ensureNode(relPath: string): FileNode | null {
    if (!browser.root) return null;
    let normalized = relPath.trim();
    if (!normalized) return null;
    if (normalized.startsWith("./")) {
      normalized = normalized.slice(2);
    }
    normalized = normalizeGitPath(normalized);
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length - 1 > MAX_TREE_DEPTH) return null;

    let current = browser.root;
    let currentRel = "";

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (ignored.has(part)) return null;
      currentRel = currentRel ? `${currentRel}/${part}` : part;
      const dirPath = join(rootPath, currentRel);
      let dirNode = browser.nodeByPath.get(dirPath);
      if (!dirNode) {
        const depth = i + 1;
        dirNode = {
          name: part,
          path: dirPath,
          isDirectory: true,
          realPath: safeRealPathSync(dirPath),
          parent: current,
          children: [],
          expanded: depth < 1,
          hasChangedChildren: false,
        };
        current.children ??= [];
        current.children.push(dirNode);
        sortChildren(current);
        browser.nodeByPath.set(dirPath, dirNode);
      }
      current = dirNode;
    }

    const fileName = parts[parts.length - 1];
    if (ignored.has(fileName)) return null;

    const filePath = join(rootPath, normalized);
    const existing = browser.nodeByPath.get(filePath);
    if (existing) return existing;

    const pathInfo = getPathInfoSync(filePath);
    if (pathInfo.isDirectory) {
      const isCycle = pathInfo.realPath ? hasAncestorRealPath(current, pathInfo.realPath) : false;
      const dirNode: FileNode = {
        name: fileName,
        path: filePath,
        isDirectory: true,
        isSymlink: pathInfo.isSymlink,
        realPath: pathInfo.realPath ?? safeRealPathSync(filePath),
        parent: current,
        children: pathInfo.isSymlink && !isCycle ? undefined : [],
        expanded: false,
        hasChangedChildren: false,
        gitStatus: gitStatus.get(normalized),
        diffStats: diffStats.get(normalized),
      };

      current.children ??= [];
      current.children.push(dirNode);
      sortChildren(current);
      browser.nodeByPath.set(filePath, dirNode);
      return dirNode;
    }

    const fileNode: FileNode = {
      name: fileName,
      path: filePath,
      isDirectory: false,
      isSymlink: pathInfo.isSymlink,
      parent: current,
      gitStatus: gitStatus.get(normalized),
      agentModified: agentModifiedFiles.has(filePath),
      diffStats: diffStats.get(normalized),
    };

    current.children ??= [];
    current.children.push(fileNode);
    sortChildren(current);
    browser.nodeByPath.set(filePath, fileNode);
    return fileNode;
  }

  function addUntrackedNodes(): void {
    for (const [relPath, status] of gitStatus.entries()) {
      if (!isUntrackedStatus(status)) continue;
      const node = ensureNode(relPath);
      if (node) {
        node.gitStatus = status;
        node.diffStats = diffStats.get(relPath);
        if (!node.isDirectory) {
          queueLineCount(node, true);
        }
      }
    }
  }

  function refreshMetadata(): void {
    if (!browser.root || !repo || gitRefreshGeneration === rootGeneration) return;

    const generation = rootGeneration;
    const refreshRoot = rootPath;
    const previousDisplayList = getDisplayList();
    const currentPath = previousDisplayList[browser.selectedIndex]?.node.path;
    const viewingFile = viewer.getFile();
    const viewingFilePath = viewingFile?.path;
    const retryFileList = !usesGitTree;
    gitRefreshGeneration = generation;

    void Promise.all([
      getGitStatusAsync(refreshRoot, { includeUntracked: true }, gitAbort.signal),
      getGitDiffStatsAsync(refreshRoot, gitAbort.signal),
      getGitBranchAsync(refreshRoot, gitAbort.signal),
      retryFileList ? getGitFileListAsync(refreshRoot, gitAbort.signal) : Promise.resolve(null),
    ])
      .then(([statusResult, diffStatsResult, branch, fileListResult]) => {
        if (generation !== rootGeneration) return;

        if (statusResult.failed || fileListResult?.statusFailed) reportGitError("Git status");
        else clearGitError("Git status");
        if (diffStatsResult.failed) reportGitError("Git diff statistics");
        else clearGitError("Git diff statistics");
        if (fileListResult?.trackedFailed) reportGitError("tracked file list");
        else if (fileListResult) clearGitError("tracked file list");

        if (!statusResult.failed) gitStatus = statusResult.status;
        if (!diffStatsResult.failed) diffStats = diffStatsResult.stats;
        gitBranch = branch;

        // Keep the filesystem scan as the usable tree until every list needed
        // to build a Git tree succeeds. This includes the status half of the
        // listing, which supplies untracked paths.
        if (fileListResult && !statusResult.failed && !fileListResult.failed) {
          usesGitTree = true;
          replaceTree(buildFileTreeFromPaths(rootPath, fileListResult.files, gitStatus, diffStats, ignored, agentModifiedFiles));
        }
        applyGitUpdates();
        addUntrackedNodes();
        applyAgentModified();
        updateTreeStats(browser.root!);
        browser.stats = getTreeStats(browser.root);
        refreshLists();

        const updatedDisplayList = getDisplayList();
        if (currentPath) {
          const newIdx = updatedDisplayList.findIndex(f => f.node.path === currentPath);
          if (newIdx !== -1) browser.selectedIndex = newIdx;
        }
        browser.selectedIndex = Math.min(browser.selectedIndex, Math.max(0, updatedDisplayList.length - 1));

        if (viewingFilePath && browser.root) {
          const newNode = browser.nodeByPath.get(viewingFilePath) ?? findNodeByPath(browser.root, viewingFilePath);
          if (newNode) {
            if (newNode.lineCount === undefined && viewingFile?.lineCount !== undefined) newNode.lineCount = viewingFile.lineCount;
            viewer.updateFileRef(newNode);
          }
        }
        requestRender();
      })
      .finally(() => {
        if (gitRefreshGeneration === generation) gitRefreshGeneration = null;
      });
  }

  function loadRoot(newRoot: string): void {
    previewViewer.close();
    clearContentSearch();
    rootGeneration += 1;
    gitAbort = new AbortController();
    treeGeneration += 1;
    rootPath = resolve(newRoot);
    browser.errorMessage = null;
    gitErrors.clear();

    const generation = rootGeneration;
    repo = false;
    usesGitTree = false;
    gitStatus = new Map();
    diffStats = new Map();
    gitBranch = "";

    browser.root = {
      name: ".",
      path: rootPath,
      isDirectory: true,
      realPath: safeRealPathSync(rootPath),
      children: undefined,
      expanded: true,
      hasChangedChildren: false,
    };
    browser.scanState.mode = "none";
    browser.scanState.isScanning = true;
    browser.scanState.isPartial = false;
    browser.scanState.pending = 0;
    indexNodes(browser.root, browser.nodeByPath);
    refreshLists();
    browser.stats = getTreeStats(browser.root);
    browser.selectedIndex = 0;
    browser.searchQuery = "";
    browser.searchMode = false;
    browser.focusFirstChildOf = null;
    textInput.reset();
    browser.lastPollTime = Date.now();
    const safeMode = shouldSafeMode(rootPath);
    browser.scanState.mode = safeMode ? "safe" : "full";
    browser.scanState.isScanning = false;
    browser.scanState.isPartial = safeMode;
    if (browser.root) enqueueScan(browser.root, 0, true);

    void (async () => {
      const gitRepo = await isGitRepoAsync(rootPath, gitAbort.signal);
      if (generation !== rootGeneration) return;

      if (!gitRepo) {
        requestRender();
        return;
      }

      const [statusResult, diffStatsResult, branch, fileListResult] = await Promise.all([
        getGitStatusAsync(rootPath, { includeUntracked: true }, gitAbort.signal),
        getGitDiffStatsAsync(rootPath, gitAbort.signal),
        getGitBranchAsync(rootPath, gitAbort.signal),
        getGitFileListAsync(rootPath, gitAbort.signal),
      ]);
      if (generation !== rootGeneration) return;

      if (statusResult.failed || fileListResult.statusFailed) reportGitError("Git status");
      else clearGitError("Git status");
      if (diffStatsResult.failed) reportGitError("Git diff statistics");
      else clearGitError("Git diff statistics");
      if (fileListResult.trackedFailed) reportGitError("tracked file list");
      else clearGitError("tracked file list");
      repo = true;
      if (!statusResult.failed) gitStatus = statusResult.status;
      if (!diffStatsResult.failed) diffStats = diffStatsResult.stats;
      gitBranch = branch;
      // Preserve the provisional scan if either Git listing operation failed.
      // A later metadata refresh retries the listing before publishing a Git tree.
      if (!statusResult.failed && !fileListResult.failed) {
        usesGitTree = true;
        replaceTree(buildFileTreeFromPaths(rootPath, fileListResult.files, gitStatus, diffStats, ignored, agentModifiedFiles));
      } else if (browser.root) {
        applyGitUpdates();
        addUntrackedNodes();
        applyAgentModified();
        updateTreeStats(browser.root);
        browser.stats = getTreeStats(browser.root);
        refreshLists();
        restoreInitialPosition();
        scanPendingRestorePath();
      }
      browser.stats = getTreeStats(browser.root);
      requestRender();
    })();
  }

  function currentLocation(): RootLocation {
    const selected = getDisplayList()[browser.selectedIndex]?.node;
    const selectedFilePath = selected && !selected.isDirectory ? selected.path : null;
    return {
      rootPath,
      directoryPath: selected?.isDirectory ? selected.path : selectedFilePath ? dirname(selectedFilePath) : rootPath,
      selectedFilePath,
    };
  }

  function switchAnchor(index: number): void {
    const anchor = rootAnchors[index];
    if (!anchor || !getPathInfoSync(anchor.path).isDirectory) {
      reportError(`Root unavailable: ${anchor ? sanitizeTerminalLabel(anchor.label) : "unknown"}`);
      return;
    }
    anchorLocations.set(rootAnchors[activeAnchorIndex].id, currentLocation());
    activeAnchorIndex = index;
    initialRoot = anchor.path;
    const savedLocation = anchorLocations.get(anchor.id);
    setRoot(savedLocation?.rootPath ?? anchor.path, savedLocation);
  }

  function setRoot(newRoot: string, restoreLocation?: RootLocation): void {
    if (viewer.isOpen()) viewer.close();
    if (previewViewer.isOpen()) previewViewer.close();
    previewPath = null;
    pendingRestorePath = restoreLocation?.selectedFilePath ?? restoreLocation?.directoryPath ?? null;
    restoredDirectoryPath = restoreLocation?.directoryPath ?? null;
    restoreNotice = null;
    clearContentSearch();
    browser.searchQuery = "";
    browser.searchMode = false;
    browser.showOnlyChanged = false;
    browser.expandedChangedView = false;
    browser.expandedForChangedView.clear();
    browser.selectedIndex = 0;
    browser.errorMessage = null;
    stopBackgroundTasks();
    scanQueue.length = 0;
    scanQueued.clear();
    lineCountQueue.length = 0;
    lineCountPending.clear();
    loadRoot(newRoot);
    requestRender();
  }

  loadRoot(rootPath);

  function getDisplayList(): FlatNode[] {
    let list = browser.searchQuery ? browser.fullList : browser.flatList;

    if (browser.showOnlyChanged) {
      list = list.filter(f => f.node.gitStatus || f.node.agentModified || (f.node.isDirectory && f.node.hasChangedChildren));
    }

    if (browser.searchQuery) {
      if (browser.searchKind === "content") list = list.filter(item => !item.node.isDirectory && browser.contentMatches.has(item.node.path));
      else {
        const q = browser.searchQuery.toLowerCase();
        list = list.filter(item => item.node.name.toLowerCase().includes(q));
      }
    }

    return list;
  }

  function navigateToChange(direction: 1 | -1): void {
    if (!browser.root) return;

    const displayList = getDisplayList();
    const allChangedFiles = collectChangedFiles(browser.root);
    const visiblePaths = new Set(displayList.map(item => item.node.path));
    const changedFiles = browser.searchQuery
      ? allChangedFiles.filter(change => visiblePaths.has(change.file.path))
      : allChangedFiles;
    if (changedFiles.length === 0) return;

    const currentNode = displayList[browser.selectedIndex]?.node;

    let currentIdx = -1;
    if (currentNode && !currentNode.isDirectory) {
      currentIdx = changedFiles.findIndex(c => c.file.path === currentNode.path);
    }

    let nextIdx: number;
    if (currentIdx === -1) {
      nextIdx = direction === 1 ? 0 : changedFiles.length - 1;
    } else {
      nextIdx = currentIdx + direction;
      if (nextIdx < 0) nextIdx = changedFiles.length - 1;
      if (nextIdx >= changedFiles.length) nextIdx = 0;
    }

    const target = changedFiles[nextIdx];

    const ancestorSet = new Set(target.ancestors);
    collapseAllExcept(browser.root, ancestorSet);

    for (const ancestor of target.ancestors) {
      ancestor.expanded = true;
    }

    browser.flatList = flattenTree(browser.root);

    const newDisplayList = getDisplayList();
    const targetIdx = newDisplayList.findIndex(f => f.node.path === target.file.path);
    if (targetIdx !== -1) {
      browser.selectedIndex = targetIdx;
    }
  }

  function toggleDir(node: FileNode): void {
    if (node.isDirectory) {
      node.expanded = !node.expanded;
      if (node.expanded && repo) queueLineCountsForDirectory(node);
      if (node.expanded && node.children === undefined) {
        enqueueScan(node, getNodeDepth(node, rootPath), true);
      }
      refreshLists();
    }
  }

  function expandChangedDirectories(node: FileNode): void {
    if (!node.isDirectory || !node.hasChangedChildren) return;
    if (!node.expanded) {
      node.expanded = true;
      browser.expandedForChangedView.add(node.path);
    }
    for (const child of node.children ?? []) {
      expandChangedDirectories(child);
    }
  }

  function restoreExpandedDirectories(node: FileNode): void {
    if (browser.expandedForChangedView.delete(node.path)) node.expanded = false;
    for (const child of node.children ?? []) {
      restoreExpandedDirectories(child);
    }
  }

  function disableExpandedChangedView(): void {
    if (!browser.expandedChangedView) return;
    if (browser.root) restoreExpandedDirectories(browser.root);
    browser.expandedChangedView = false;
    refreshLists();
  }

  function toggleExpandedChangedView(): void {
    if (browser.expandedChangedView) {
      disableExpandedChangedView();
      browser.showOnlyChanged = false;
      browser.selectedIndex = 0;
      return;
    }
    if (!browser.root) return;
    updateTreeStats(browser.root);
    expandChangedDirectories(browser.root);
    browser.expandedChangedView = true;
    browser.showOnlyChanged = true;
    browser.selectedIndex = 0;
    refreshLists();
  }

  function openFile(node: FileNode): void {
    viewer.setFile(node);
  }

  function renderBrowser(width: number): string[] {
    const lines: string[] = [];
    const branchDisplay = gitBranch ? theme.fg("accent", ` (${sanitizeTerminalLabel(gitBranch)})`) : "";
    const stats = browser.stats;

    let statsDisplay = "";
    if (stats.totalLines !== undefined) {
      statsDisplay += theme.fg("dim", ` ${stats.totalLines}L`);
    }
    if (stats.additions > 0) statsDisplay += theme.fg("success", ` +${stats.additions}`);
    if (stats.deletions > 0) statsDisplay += theme.fg("error", ` -${stats.deletions}`);

    const partialIndicator = browser.scanState.isPartial ? theme.fg("warning", " [partial]") : "";
    const errors = [browser.errorMessage, browser.contentSearchError, ...gitErrors].filter((message): message is string => Boolean(message));
    const errorIndicator = errors.length > 0 ? theme.fg("error", ` [${errors.join("; ")}]`) : "";
    const searchPrefix = browser.searchKind === "content" ? "@" : "/";
    const searchIndicator = browser.searchMode
      ? theme.fg("accent", `  ${searchPrefix}${sanitizeTerminalLabel(browser.searchQuery)}${CURSOR_MARKER}█`)
      : browser.searchQuery
        ? theme.fg("dim", `  ${searchPrefix}${sanitizeTerminalLabel(browser.searchQuery)}  (Esc clears)`)
        : "";

    const header = browser.searchMode || browser.searchQuery
      ? errorIndicator + theme.bold(theme.fg("text", searchIndicator))
      : branchDisplay + statsDisplay + partialIndicator + errorIndicator;
    lines.push(truncateToWidth(header, width));
    lines.push(theme.fg("borderMuted", "─".repeat(width)));

    const displayList = getDisplayList();
    if (displayList.length === 0) {
      const emptyLabel = browser.scanState.isScanning
        ? "  (loading...)"
        : "  (no files" + (browser.searchQuery ? ` matching '${sanitizeTerminalLabel(browser.searchQuery)}'` : "") + ")";
      lines.push(theme.fg("dim", emptyLabel));
      for (let i = 1; i < browser.browserHeight; i++) {
        lines.push("");
      }
    } else {
      const start = Math.max(
        0,
        Math.min(browser.selectedIndex - Math.floor(browser.browserHeight / 2), displayList.length - browser.browserHeight)
      );
      const end = Math.min(displayList.length, start + browser.browserHeight);

      for (let i = start; i < end; i++) {
        const { node, depth } = displayList[i];
        const isSelected = i === browser.selectedIndex;
        const indent = "  ".repeat(depth);
        const icon = node.isDirectory
          ? (node.expanded ? "▾ " : "▸ ")
          : "  ";

        const status = formatNodeStatus(node, theme);
        const meta = formatNodeMeta(node, theme);
        const name = formatNodeName(node, theme);

        const prefix = `${indent}${icon}`;
        const statusWidth = visibleWidth(status);
        const metaWidth = visibleWidth(meta);
        const availableForName = Math.max(0, width - visibleWidth(prefix) - statusWidth - metaWidth);
        const visibleMeta = availableForName >= 3 ? meta : "";
        const nameWidth = Math.max(0, width - visibleWidth(prefix) - statusWidth - visibleWidth(visibleMeta));
        let line = `${prefix}${truncateToWidth(name, nameWidth, "…")}${status}${visibleMeta}`;
        line = truncateToWidth(line, width);

        if (isSelected) {
          line = theme.bg("selectedBg", line + " ".repeat(Math.max(0, width - visibleWidth(line))));
        }

        lines.push(line);
      }

      const renderedCount = end - start;
      for (let i = renderedCount; i < browser.browserHeight; i++) {
        lines.push("");
      }

      const pct = displayList.length > 1
        ? Math.round((browser.selectedIndex / (displayList.length - 1)) * 100)
        : 100;
      lines.push(theme.fg("dim", `  ${browser.selectedIndex + 1}/${displayList.length} (${pct}%)`));
    }

    lines.push(theme.fg("borderMuted", "─".repeat(width)));
    const changedIndicator = browser.showOnlyChanged ? theme.fg("warning", " [changed only]") : "";
    const rootsHelp = rootAnchors.length > 1 ? "  Tab/Shift-Tab: roots" : "";
    const help = browser.searchMode
      ? theme.fg("dim", "Type to search  ↑↓: nav  Enter: confirm  Esc: cancel")
      : theme.fg("dim", "c/C: changes  []: prev/next change  ?: help  /: name  @: content  *: pin  .: root  p: preview  y: copy path" + rootsHelp) + changedIndicator;
    const fullHelp = [
      theme.fg("dim", "j/k/↑/↓: move  Enter: open  h/l←→: folder  PgUp/PgDn: page  c: changed only"),
      theme.fg("dim", "C: expand  []: change  /:@ search  *: pin  y: copy path  q/Esc: close  ?: hide  u: parent  .: root  p: preview  +/-: height" + rootsHelp) + changedIndicator,
    ];
    if (!browser.searchMode && showFullHelp) lines.push(...fullHelp.map(line => truncateToWidth(line, width)));
    else lines.push(truncateToWidth(help, width));

    return lines;
  }

  function handleViewerInput(data: string): void {
    const action: ViewerAction = viewer.handleInput(data);
    if (action.type === "close") {
      viewer.close();
      return;
    }
    if (action.type === "navigate") {
      viewer.close();
      navigateToChange(action.direction);
      const displayList = getDisplayList();
      const item = displayList[browser.selectedIndex];
      if (item && !item.node.isDirectory) {
        openFile(item.node);
      }
    }
  }

  function handleBrowserInput(data: string): void {
    if (!browser.searchMode && rootAnchors.length > 1 && (matchesKey(data, Key.tab) || matchesKey(data, "shift+tab"))) {
      const direction = matchesKey(data, "shift+tab") ? -1 : 1;
      switchAnchor((activeAnchorIndex + direction + rootAnchors.length) % rootAnchors.length);
      return;
    }
    const previewNavigation = /^\d$/.test(data) || matchesKey(data, "g") || matchesKey(data, "shift+g") || matchesKey(data, Key.pageDown) || matchesKey(data, Key.pageUp) || matchesKey(data, "ctrl+d") || matchesKey(data, "ctrl+u") || matchesKey(data, "w");
    if (!browser.searchMode && previewEnabled && lastRenderWidth >= MIN_PREVIEW_WIDTH && previewViewer.isOpen() && previewNavigation) {
      previewViewer.handleInput(data);
      return;
    }
    const displayList = getDisplayList();
    const maxIndex = Math.max(0, displayList.length - 1);

    if (matchesKey(data, "q") && !browser.searchMode) {
      textInput.reset();
      stopBackgroundTasks();
      onClose();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      if (browser.searchMode) {
        browser.searchMode = false;
        browser.searchQuery = "";
        clearContentSearch();
        textInput.reset();
      } else if (browser.searchQuery) {
        browser.searchQuery = "";
        browser.selectedIndex = 0;
        clearContentSearch();
      } else {
        textInput.reset();
        stopBackgroundTasks();
        onClose();
      }
      return;
    }
    if ((matchesKey(data, "/") || matchesKey(data, "@")) && !browser.searchMode) {
      browser.searchMode = true;
      browser.searchKind = matchesKey(data, "@") ? "content" : "filename";
      browser.searchQuery = "";
      clearContentSearch();
      textInput.reset();
      return;
    }
    if (browser.searchMode) {
      if (matchesKey(data, browser.searchKind === "content" ? "@" : "/")) {
        browser.searchQuery = "";
        browser.selectedIndex = 0;
        if (browser.searchKind === "content") scheduleContentSearch();
        textInput.reset();
      } else if (matchesKey(data, Key.enter)) {
        browser.searchMode = false;
        textInput.reset();
      } else if (matchesKey(data, Key.backspace)) {
        if (browser.searchQuery) {
          browser.searchQuery = browser.searchQuery.slice(0, -1);
          browser.selectedIndex = 0;
          if (browser.searchKind === "content") scheduleContentSearch();
        } else {
          browser.searchMode = false;
          clearContentSearch();
          textInput.reset();
        }
      } else if (matchesKey(data, Key.down)) {
        browser.selectedIndex = Math.min(maxIndex, browser.selectedIndex + 1);
      } else if (matchesKey(data, Key.up)) {
        browser.selectedIndex = Math.max(0, browser.selectedIndex - 1);
      } else {
        const text = textInput.push(data);
        if (text) {
          browser.searchQuery += text;
          browser.selectedIndex = 0;
          if (browser.searchKind === "content") scheduleContentSearch();
        }
      }
      return;
    }
    if (matchesKey(data, "?")) {
      showFullHelp = !showFullHelp;
      const maximumHeight = getResponsivePanelHeight(
        MAX_BROWSER_HEIGHT,
        MAX_BROWSER_HEIGHT,
        showFullHelp ? 10 : 9,
        process.stdout.rows,
        OVERLAY_MAX_HEIGHT_RATIO
      );
      browser.browserHeight = Math.min(browser.browserHeight, maximumHeight);
      return;
    }
    if (matchesKey(data, "p")) {
      if (lastRenderWidth >= MIN_PREVIEW_WIDTH) previewEnabled = !previewEnabled;
      return;
    }
    if (matchesKey(data, "*")) {
      const selected = displayList[browser.selectedIndex]?.node;
      if (selected && options.togglePinnedRoot) {
        const path = selected.isDirectory ? selected.path : dirname(selected.path);
        const activeAnchor = rootAnchors[activeAnchorIndex];
        void options.togglePinnedRoot(path).then(result => {
          rootAnchors = !activeAnchor || result.anchors.some(anchor => anchor.path === activeAnchor.path)
            ? result.anchors
            : [...result.anchors, activeAnchor];
          activeAnchorIndex = Math.max(0, rootAnchors.findIndex(anchor => anchor.path === activeAnchor?.path));
          reportError(result.message);
        }).catch(error => reportError(`Unable to update pinned roots: ${formatErrorMessage(error)}`));
      }
      return;
    }
    if (matchesKey(data, "y")) {
      const selected = displayList[browser.selectedIndex]?.node;
      if (selected) {
        previewViewer.setFile(selected);
        previewViewer.copyPath();
      }
      return;
    }
    if (matchesKey(data, "u")) {
      const parent = resolve(rootPath, "..");
      if (parent !== rootPath) {
        setRoot(parent);
      }
      return;
    }
    if (matchesKey(data, ".")) {
      if (rootPath !== initialRoot) {
        setRoot(initialRoot);
      }
      return;
    }
    if (matchesKey(data, "j") || matchesKey(data, Key.down)) {
      browser.selectedIndex = Math.min(maxIndex, browser.selectedIndex + 1);
      return;
    }
    if (matchesKey(data, "k") || matchesKey(data, Key.up)) {
      browser.selectedIndex = Math.max(0, browser.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const item = displayList[browser.selectedIndex];
      if (item) {
        if (item.node.isDirectory) {
          toggleDir(item.node);
        } else {
          openFile(item.node);
        }
      }
      return;
    }
    if (matchesKey(data, "l") || matchesKey(data, Key.right)) {
      const item = displayList[browser.selectedIndex];
      if (item?.node.isDirectory && !item.node.expanded) {
        toggleDir(item.node);
        if (!focusFirstChild(item.node)) browser.focusFirstChildOf = item.node.path;
      } else if (item && !item.node.isDirectory) {
        openFile(item.node);
      }
      return;
    }
    if (matchesKey(data, "h") || matchesKey(data, Key.left)) {
      const item = displayList[browser.selectedIndex];
      if (item?.node.isDirectory && item.node.expanded) {
        toggleDir(item.node);
      } else {
        const parent = item?.node.parent;
        if (parent && parent !== browser.root && parent.expanded) {
          parent.expanded = false;
          refreshLists();
          const parentIndex = getDisplayList().findIndex(entry => entry.node.path === parent.path);
          if (parentIndex !== -1) browser.selectedIndex = parentIndex;
        }
      }
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      browser.selectedIndex = Math.min(maxIndex, browser.selectedIndex + browser.browserHeight);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      browser.selectedIndex = Math.max(0, browser.selectedIndex - browser.browserHeight);
      return;
    }
    if (matchesKey(data, "+") || matchesKey(data, "=")) {
      const maximumHeight = getResponsivePanelHeight(
        MAX_BROWSER_HEIGHT,
        MAX_BROWSER_HEIGHT,
        showFullHelp ? 10 : 9,
        process.stdout.rows,
        OVERLAY_MAX_HEIGHT_RATIO
      );
      browser.browserHeight = Math.min(maximumHeight, browser.browserHeight + 5);
      return;
    }
    if (matchesKey(data, "-") || matchesKey(data, "_")) {
      browser.browserHeight = Math.max(MIN_PANEL_HEIGHT, browser.browserHeight - 5);
      return;
    }
    if (matchesKey(data, "shift+c")) {
      toggleExpandedChangedView();
      return;
    }
    if (matchesKey(data, "c")) {
      if (browser.showOnlyChanged) {
        const wasExpanded = browser.expandedChangedView;
        disableExpandedChangedView();
        browser.showOnlyChanged = wasExpanded;
      } else {
        browser.showOnlyChanged = true;
      }
      browser.selectedIndex = 0;
      return;
    }
    if (matchesKey(data, "]")) {
      navigateToChange(1);
      return;
    }
    if (matchesKey(data, "[")) {
      navigateToChange(-1);
      return;
    }
  }

  function renderBrowserWithPreview(width: number): string[] {
    if (!previewEnabled || width < MIN_PREVIEW_WIDTH) return renderBrowser(width);

    const treeWidth = Math.floor((width - 1) * 0.3);
    const previewWidth = width - treeWidth - 1;
    const selected = getDisplayList()[browser.selectedIndex]?.node;
    if (selected) {
      if (previewPath !== selected.path) {
        previewViewer.setFile(selected);
        previewPath = selected.path;
      } else {
        previewViewer.updateFileRef(selected);
      }
    } else {
      previewViewer.close();
      previewPath = null;
    }

    const footerLineCount = !browser.searchMode && showFullHelp ? 3 : 2;
    const treeLines = renderBrowser(treeWidth);
    const treeContent = treeLines.slice(0, -footerLineCount);
    const fullWidthFooter = renderBrowser(width).slice(-footerLineCount);
    const previewLines = selected ? previewViewer.render(previewWidth).slice(0, -2) : [theme.fg("dim", "Preview unavailable")];
    const lineCount = treeContent.length;
    const separator = theme.fg("borderMuted", "│");
    const splitLines = Array.from({ length: lineCount }, (_, index) => {
      const tree = truncateToWidth(treeContent[index] ?? "", treeWidth, "", true);
      const preview = truncateToWidth(previewLines[index] ?? "", previewWidth, "", true);
      return `${tree}${separator}${preview}`;
    });
    return [...splitLines, ...fullWidthFooter];
  }

  return {
    getRootPath(): string {
      return formatRootPath(rootPath);
    },
    getRootAnchor(): { label: string; index: number; count: number } | null {
      if (rootAnchors.length < 2) return null;
      const anchor = rootAnchors[activeAnchorIndex];
      return { label: anchor.label, index: activeAnchorIndex + 1, count: rootAnchors.length };
    },
    getBrowsePosition(): { rootPath: string; directoryPath: string; selectedFilePath: string | null } {
      const selected = getDisplayList()[browser.selectedIndex]?.node;
      const selectedFilePath = selected && !selected.isDirectory ? selected.path : null;
      return {
        rootPath,
        directoryPath: selected?.isDirectory ? selected.path : selectedFilePath ? dirname(selectedFilePath) : rootPath,
        selectedFilePath,
      };
    },

    isPathCopied(): boolean {
      return !viewer.isOpen() && (!previewEnabled || lastRenderWidth < MIN_PREVIEW_WIDTH) && previewViewer.isPathCopied();
    },
    getRestorePath(): string | null {
      return restoreNotice;
    },

    getActivityLabel(): string {
      return activityLabels().join(" ");
    },


    render(width: number): string[] {
      lastRenderWidth = width;
      const now = Date.now();
      if (repo && now - browser.lastPollTime > POLL_INTERVAL_MS) {
        browser.lastPollTime = now;
        refreshMetadata();
      }

      if (viewer.isOpen()) {
        return viewer.render(width);
      }
      return renderBrowserWithPreview(width);
    },

    handleInput(data: string): void {
      restoreNotice = null;
      if (viewer.isOpen()) {
        handleViewerInput(data);
      } else {
        handleBrowserInput(data);
      }
    },

    invalidate(): void {},
  };
}
