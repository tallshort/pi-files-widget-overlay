import { copyToClipboard, createGrepTool, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  DEFAULT_BROWSER_HEIGHT,
  getResponsivePanelHeight,
  OVERLAY_MAX_HEIGHT_RATIO,
  MAX_BROWSER_HEIGHT,
  MIN_PANEL_HEIGHT,
  POLL_INTERVAL_MS,
  SCAN_ACTIVITY_LABEL,
} from "./constants";
import { getGitBranchAsync, getGitDiffStatsAsync, getGitFileListAsync, getGitStatusAsync, isGitRepoAsync } from "./git";
import { buildFileTreeFromPaths, flattenTree, getIgnoredNames, sortChildren, updateTreeStats } from "./file-tree";
import { deriveBrowserDisplayList, deriveBrowserLocation, deriveChangedNavigationTarget, expandChangedDirectories, restoreExpandedDirectories, type BrowserLocation } from "./browser-display";
import { createBrowserRootSession, type BrowserRootState } from "./browser-root-session";
import { classifyBrowserInput, type BrowserInputCommand } from "./browser-input";
import { createBrowserQuery, type BrowserQueryEffect } from "./browser-query";
import { renderBrowserTree } from "./browser-render";
import { getPathInfoSync } from "./path-info";
import type { DiffStats, FileNode, FlatNode } from "./types";
import { formatErrorMessage, sanitizeTerminalLabel } from "./utils";
import { createViewer, type CommentPayload, type ViewerAction } from "./viewer";

const MIN_PREVIEW_WIDTH = 80;
const CONTENT_SEARCH_DEBOUNCE_MS = 150;
const COMPACT_BROWSER_CHROME_ROWS = 9;
const FULL_BROWSER_CHROME_ROWS = 11;

export interface BrowserController {
  getRootPath(): string;
  getRootAnchor(): { label: string; pinned?: boolean; index: number; count: number } | null;
  getActivityLabel(): string;
  getRestorePath(): string | null;
  isPathCopied(): boolean;
  isPathCopyError(): boolean;
  render(width: number): string[];
  handleInput(data: string): void;
  getBrowsePosition(): { rootPath: string; directoryPath: string; selectedFilePath: string | null };
  invalidate(): void;
}

export interface RootAnchor {
  id: string;
  path: string;
  label: string;
  pinned?: boolean;
  transient?: boolean;
}

type RootLocation = BrowserLocation;

interface BrowserState extends BrowserRootState {
  flatList: FlatNode[];
  fullList: FlatNode[];
  selectedIndex: number;
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

function formatRootPath(path: string): string {
  const home = homedir();
  if (!home) return path;
  if (path === home) return "~";
  if (path.startsWith(home + sep)) return "~" + path.slice(home.length);
  return path;
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
  let pathCopiedUntil = 0;
  let pathCopyErrorUntil = 0;
  let copyGeneration = 0;
  let copyFeedbackOwner: "browser" | "preview" | null = null;

  function finishCopyFeedback(generation: number, success: boolean): void {
    if (generation !== copyGeneration) return;
    pathCopiedUntil = success ? Date.now() + 3000 : 0;
    pathCopyErrorUntil = success ? 0 : Date.now() + 3000;
    requestRender();
    setTimeout(requestRender, 3000);
  }

  function clearCopyFeedback(): void {
    copyGeneration += 1;
    copyFeedbackOwner = null;
    pathCopiedUntil = 0;
    pathCopyErrorUntil = 0;
  }

  function clearPreviewCopyFeedback(): void {
    if (copyFeedbackOwner === "preview") clearCopyFeedback();
  }

  function previewOwnsCopyFeedback(): boolean {
    return copyFeedbackOwner === "preview" && previewEnabled && lastRenderWidth >= MIN_PREVIEW_WIDTH && previewViewer.isOpen();
  }
  let pendingRestorePath = initialSelectedPath ? resolve(initialSelectedPath) : initialDirectoryPath ? resolve(initialDirectoryPath) : null;
  let restoredDirectoryPath = initialDirectoryPath ? resolve(initialDirectoryPath) : null;
  let restoreNotice = initialDirectoryPath ? relative(rootPath, resolve(initialDirectoryPath)) || "." : null;
  const query = createBrowserQuery();
  const scanState: BrowserRootState["scanState"] = {
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
    contentMatches: new Set(),
    showOnlyChanged: false,
    expandedChangedView: false,
    expandedForChangedView: new Set<string>(),
    focusFirstChildOf: null,
    errorMessage: null,
    contentSearchError: null,
    browserHeight: getResponsivePanelHeight(DEFAULT_BROWSER_HEIGHT, MAX_BROWSER_HEIGHT, COMPACT_BROWSER_CHROME_ROWS),
    lastPollTime: Date.now(),
  };

  const rootSession = createBrowserRootSession({
    state: browser,
    agentModifiedFiles,
    ignored,
    readDirectory,
    onError: reportError,
    onEvent(event) {
      refreshLists();
      if (event === "tree") {
        restoreInitialPosition();
        scanPendingRestorePath();
        if (browser.focusFirstChildOf) {
          const directory = browser.nodeByPath.get(browser.focusFirstChildOf);
          if (directory && focusFirstChild(directory)) browser.focusFirstChildOf = null;
        }
      }
      requestRender();
    },
  });
  let pinRequestGeneration = 0;
  let gitRefreshGeneration: number | null = null;
  let gitAbort = new AbortController();
  let contentSearchGeneration = 0;
  let contentSearchAbort: AbortController | null = null;
  let contentSearchTimer: ReturnType<typeof setTimeout> | null = null;
  let noticeMessage: string | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
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
    if (!query.snapshot().query) return;
    contentSearchTimer = setTimeout(() => {
      contentSearchTimer = null;
      runContentSearch();
    }, CONTENT_SEARCH_DEBOUNCE_MS);
  }

  function runContentSearch(): void {
    clearContentSearch();
    const searchQuery = query.snapshot().query;
    if (!searchQuery) return;
    const generation = contentSearchGeneration;
    const root = rootPath;
    const controller = new AbortController();
    contentSearchAbort = controller;
    let grep = grepTools.get(root);
    if (!grep) {
      grep = createGrepTool(root);
      grepTools.set(root, grep);
    }
    void grep.execute("readfiles-content-search", { pattern: searchQuery, path: ".", literal: true, context: 0, limit: 200 }, controller.signal, () => {})
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
    if (browser.scanState.isScanning) labels.push(SCAN_ACTIVITY_LABEL);
    if (browser.errorMessage) labels.push(`⚠ ${browser.errorMessage}`);
    if (noticeMessage) labels.push(noticeMessage);
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

  function fallBackToRestoredDirectory(): void {
    if (restoredDirectoryPath && pendingRestorePath !== restoredDirectoryPath) {
      pendingRestorePath = restoredDirectoryPath;
      scanPendingRestorePath();
    } else {
      pendingRestorePath = null;
    }
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
        rootSession.enqueueScan(current, index, true);
        return;
      }
      const next = current.children.find(child => child.name === parts[index]);
      if (!next) {
        fallBackToRestoredDirectory();
        return;
      }
      if (index === parts.length - 1) {
        restoreInitialPosition();
        return;
      }
      if (!next.isDirectory) {
        fallBackToRestoredDirectory();
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


    // Git does not list empty directories. Keep a restored directory in the
    // replacement tree so reopening an empty folder remains a valid location.
    retainRestoredDirectory(root);
    rootSession.setGitContext(gitStatus, diffStats, usesGitTree);
    rootSession.replaceRoot(root, viewingFile ?? undefined);
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
        viewer.updateFileRef(node);
      }
    }
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

  function reportNotice(message: string): void {
    noticeMessage = message;
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      noticeMessage = null;
      noticeTimer = null;
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

  function stopBackgroundTasks(): void {
    rootSession.stop();
    gitAbort.abort();
    browser.errorMessage = null;
    if (errorTimer) {
      clearTimeout(errorTimer);
      errorTimer = null;
    }
    noticeMessage = null;
    if (noticeTimer) {
      clearTimeout(noticeTimer);
      noticeTimer = null;
    }
    clearContentSearch();
  }

  function refreshMetadata(): void {
    if (!browser.root || !repo || gitRefreshGeneration === rootSession.getGeneration()) return;

    const generation = rootSession.getGeneration();
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
        if (!rootSession.isCurrent(generation)) return;

        if (statusResult.failed || fileListResult?.statusFailed) reportGitError("Git status");
        else clearGitError("Git status");
        if (diffStatsResult.failed) reportGitError("Git diff statistics");
        else clearGitError("Git diff statistics");
        if (fileListResult?.trackedFailed) reportGitError("tracked file list");
        else if (fileListResult) clearGitError("tracked file list");

        if (!statusResult.failed) gitStatus = statusResult.status;
        if (!diffStatsResult.failed) diffStats = diffStatsResult.stats;
        gitBranch = branch;
        rootSession.setGitContext(gitStatus, diffStats, usesGitTree);

        // Keep the filesystem scan as the usable tree until every list needed
        // to build a Git tree succeeds. This includes the status half of the
        // listing, which supplies untracked paths.
        if (fileListResult && !statusResult.failed && !fileListResult.failed) {
          usesGitTree = true;
          replaceTree(buildFileTreeFromPaths(rootPath, fileListResult.files, gitStatus, diffStats, ignored, agentModifiedFiles));
        }
        rootSession.applyGitMetadata(gitStatus, diffStats);
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
    gitAbort.abort();
    gitAbort = new AbortController();
    rootPath = resolve(newRoot);
    browser.errorMessage = null;
    gitErrors.clear();

    repo = false;
    usesGitTree = false;
    gitStatus = new Map();
    diffStats = new Map();
    gitBranch = "";
    rootSession.setGitContext(gitStatus, diffStats, usesGitTree);
    const generation = rootSession.startRoot(rootPath);
    refreshLists();
    browser.selectedIndex = 0;
    query.clear();
    browser.focusFirstChildOf = null;
    browser.lastPollTime = Date.now();

    void (async () => {
      const gitRepo = await isGitRepoAsync(rootPath, gitAbort.signal);
      if (!rootSession.isCurrent(generation)) return;

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
      if (!rootSession.isCurrent(generation)) return;

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
      rootSession.setGitContext(gitStatus, diffStats, usesGitTree);
      // Preserve the provisional scan if either Git listing operation failed.
      // A later metadata refresh retries the listing before publishing a Git tree.
      if (!statusResult.failed && !fileListResult.failed) {
        usesGitTree = true;
        replaceTree(buildFileTreeFromPaths(rootPath, fileListResult.files, gitStatus, diffStats, ignored, agentModifiedFiles));
      } else if (browser.root) {
        rootSession.applyGitMetadata(gitStatus, diffStats);
        refreshLists();
        restoreInitialPosition();
        scanPendingRestorePath();
      }
      rootSession.refreshStats();
      requestRender();
    })();
  }

  function currentLocation(): RootLocation {
    return deriveBrowserLocation(rootPath, getDisplayList()[browser.selectedIndex]?.node);
  }

  function switchAnchor(index: number): void {
    const anchor = rootAnchors[index];
    if (!anchor || !getPathInfoSync(anchor.path).isDirectory) {
      reportError(`Root unavailable: ${anchor ? sanitizeTerminalLabel(anchor.label) : "unknown"}`);
      return;
    }
    anchorLocations.set(rootAnchors[activeAnchorIndex].id, currentLocation());
    rootAnchors = rootAnchors.filter(candidate => !candidate.transient || candidate.id === anchor.id);
    activeAnchorIndex = rootAnchors.findIndex(candidate => candidate.id === anchor.id);
    initialRoot = anchor.path;
    const savedLocation = anchorLocations.get(anchor.id);
    setRoot(savedLocation?.rootPath ?? anchor.path, savedLocation);
  }

  function setRoot(newRoot: string, restoreLocation?: RootLocation): void {
    if (viewer.isOpen()) viewer.close();
    if (previewViewer.isOpen()) previewViewer.close();
    clearCopyFeedback();
    previewPath = null;
    pendingRestorePath = restoreLocation?.selectedFilePath ?? restoreLocation?.directoryPath ?? null;
    restoredDirectoryPath = restoreLocation?.directoryPath ?? null;
    restoreNotice = null;
    clearContentSearch();
    query.clear();
    browser.showOnlyChanged = false;
    browser.expandedChangedView = false;
    browser.expandedForChangedView.clear();
    browser.selectedIndex = 0;
    browser.errorMessage = null;
    stopBackgroundTasks();
    loadRoot(newRoot);
    requestRender();
  }

  loadRoot(rootPath);

  function getDisplayList(): FlatNode[] {
    return deriveBrowserDisplayList(browser, query.snapshot());
  }

  function navigateToChange(direction: 1 | -1): void {
    if (!browser.root) return;
    const displayList = getDisplayList();
    const target = deriveChangedNavigationTarget(browser.root, displayList, browser.selectedIndex, direction, Boolean(query.snapshot().query));
    if (!target) return;

    const ancestorSet = new Set(target.ancestors);
    collapseAllExcept(browser.root, ancestorSet);
    for (const ancestor of target.ancestors) ancestor.expanded = true;
    browser.flatList = flattenTree(browser.root);

    const targetIndex = getDisplayList().findIndex(entry => entry.node.path === target.file.path);
    if (targetIndex !== -1) browser.selectedIndex = targetIndex;
  }

  function toggleDir(node: FileNode): void {
    if (node.isDirectory) {
      node.expanded = !node.expanded;
      if (node.expanded && repo) rootSession.queueLineCountsForDirectory(node);
      if (node.expanded && node.children === undefined) {
        rootSession.enqueueScan(node, rootSession.getNodeDepth(node), true);
      }
      refreshLists();
    }
  }


  function disableExpandedChangedView(): void {
    if (!browser.expandedChangedView) return;
    if (browser.root) restoreExpandedDirectories(browser.root, browser.expandedForChangedView);
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
    expandChangedDirectories(browser.root, browser.expandedForChangedView);
    browser.expandedChangedView = true;
    browser.showOnlyChanged = true;
    browser.selectedIndex = 0;
    refreshLists();
  }

  function openFile(node: FileNode): void {
    viewer.setFile(node);
  }

  function renderBrowser(width: number): string[] {
    return renderBrowserTree({
      stats: browser.stats,
      scanState: browser.scanState,
      errors: [browser.errorMessage, browser.contentSearchError, ...gitErrors].filter((message): message is string => Boolean(message)),
      query: query.snapshot(),
      displayList: getDisplayList(),
      selectedIndex: browser.selectedIndex,
      browserHeight: browser.browserHeight,
      showOnlyChanged: browser.showOnlyChanged,
      rootCount: rootAnchors.length,
      showFullHelp,
      gitBranch,
    }, width, theme);
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

  function applyQueryEffect(effect: BrowserQueryEffect, maxIndex: number): void {
    if (effect.type === "move") {
      browser.selectedIndex = Math.max(0, Math.min(maxIndex, browser.selectedIndex + effect.direction));
      return;
    }
    if (effect.type === "cancel") {
      clearContentSearch();
      return;
    }
    if (effect.type !== "changed") return;
    if (effect.resetSelection) browser.selectedIndex = 0;
    if (effect.contentSearch === "schedule") scheduleContentSearch();
    else if (effect.contentSearch === "clear") clearContentSearch();
  }

  function handleNormalBrowserCommand(command: BrowserInputCommand, displayList: FlatNode[], maxIndex: number): void {
    const selected = displayList[browser.selectedIndex]?.node;
    switch (command.type) {
      case "toggle-help": {
        showFullHelp = !showFullHelp;
        const maximumHeight = getResponsivePanelHeight(
          MAX_BROWSER_HEIGHT,
          MAX_BROWSER_HEIGHT,
          showFullHelp ? FULL_BROWSER_CHROME_ROWS : COMPACT_BROWSER_CHROME_ROWS,
          process.stdout.rows,
          OVERLAY_MAX_HEIGHT_RATIO
        );
        browser.browserHeight = Math.min(browser.browserHeight, maximumHeight);
        return;
      }
      case "toggle-preview":
        if (lastRenderWidth >= MIN_PREVIEW_WIDTH) previewEnabled = !previewEnabled;
        return;
      case "toggle-pin":
        if (selected && options.togglePinnedRoot) {
          const path = selected.isDirectory ? selected.path : dirname(selected.path);
          const activeAnchor = rootAnchors[activeAnchorIndex];
          const generation = rootSession.getGeneration();
          const requestGeneration = ++pinRequestGeneration;
          void options.togglePinnedRoot(path).then(result => {
            if (!rootSession.isCurrent(generation) || requestGeneration !== pinRequestGeneration) return;
            rootAnchors = !activeAnchor || result.anchors.some(anchor => anchor.path === activeAnchor.path)
              ? result.anchors
              : [...result.anchors, { id: activeAnchor.id, path: activeAnchor.path, label: activeAnchor.label, transient: true }];
            activeAnchorIndex = Math.max(0, rootAnchors.findIndex(anchor => anchor.path === activeAnchor?.path));
            reportNotice(result.message);
          }).catch(error => {
            if (rootSession.isCurrent(generation) && requestGeneration === pinRequestGeneration) reportError(`Unable to update pinned roots: ${formatErrorMessage(error)}`);
          });
        }
        return;
      case "copy-path":
        if (!selected) return;
        if (previewEnabled && lastRenderWidth >= MIN_PREVIEW_WIDTH && previewPath === selected.path && previewViewer.isOpen()) {
          const generation = ++copyGeneration;
          copyFeedbackOwner = "preview";
          previewViewer.copyPath(success => finishCopyFeedback(generation, success));
          return;
        }
        {
          const generation = ++copyGeneration;
          copyFeedbackOwner = "browser";
          void copyToClipboard(selected.path).then(
            () => finishCopyFeedback(generation, true),
            () => finishCopyFeedback(generation, false),
          );
        }
        return;
      case "parent-root": {
        const parent = resolve(rootPath, "..");
        if (parent !== rootPath) setRoot(parent);
        return;
      }
      case "initial-root":
        if (rootPath !== initialRoot) setRoot(initialRoot);
        return;
      case "move":
        browser.selectedIndex = Math.max(0, Math.min(maxIndex, browser.selectedIndex + command.direction));
        return;
      case "open":
        if (selected?.isDirectory) toggleDir(selected);
        else if (selected) openFile(selected);
        return;
      case "expand-or-open":
        if (selected?.isDirectory && !selected.expanded) {
          toggleDir(selected);
          if (!focusFirstChild(selected)) browser.focusFirstChildOf = selected.path;
        } else if (selected && !selected.isDirectory) {
          openFile(selected);
        }
        return;
      case "collapse":
        if (selected?.isDirectory && selected.expanded) {
          toggleDir(selected);
        } else {
          const parent = selected?.parent;
          if (parent && parent !== browser.root && parent.expanded) {
            parent.expanded = false;
            refreshLists();
            const parentIndex = getDisplayList().findIndex(entry => entry.node.path === parent.path);
            if (parentIndex !== -1) browser.selectedIndex = parentIndex;
          }
        }
        return;
      case "page":
        browser.selectedIndex = Math.max(0, Math.min(maxIndex, browser.selectedIndex + command.direction * browser.browserHeight));
        return;
      case "resize":
        if (command.direction === -1) {
          browser.browserHeight = Math.max(MIN_PANEL_HEIGHT, browser.browserHeight - 5);
        } else {
          const maximumHeight = getResponsivePanelHeight(
            MAX_BROWSER_HEIGHT,
            MAX_BROWSER_HEIGHT,
            showFullHelp ? FULL_BROWSER_CHROME_ROWS : COMPACT_BROWSER_CHROME_ROWS,
            process.stdout.rows,
            OVERLAY_MAX_HEIGHT_RATIO
          );
          browser.browserHeight = Math.min(maximumHeight, browser.browserHeight + 5);
        }
        return;
      case "toggle-expanded-changes":
        toggleExpandedChangedView();
        return;
      case "toggle-changes":
        if (browser.showOnlyChanged) {
          const wasExpanded = browser.expandedChangedView;
          disableExpandedChangedView();
          browser.showOnlyChanged = wasExpanded;
        } else {
          browser.showOnlyChanged = true;
        }
        browser.selectedIndex = 0;
        return;
      case "navigate-change":
        navigateToChange(command.direction);
        return;
      default:
        return;
    }
  }

  function handleBrowserInput(data: string): void {
    const queryState = query.snapshot();
    const command = classifyBrowserInput(data, {
      queryActive: queryState.active,
      multipleRoots: rootAnchors.length > 1,
      previewActive: previewEnabled && lastRenderWidth >= MIN_PREVIEW_WIDTH && previewViewer.isOpen(),
    });
    const displayList = getDisplayList();
    const maxIndex = Math.max(0, displayList.length - 1);

    switch (command.type) {
      case "switch-root":
        switchAnchor((activeAnchorIndex + command.direction + rootAnchors.length) % rootAnchors.length);
        return;
      case "preview-input":
        previewViewer.handleInput(data);
        return;
      case "close":
        stopBackgroundTasks();
        onClose();
        return;
      case "escape":
        if (queryState.active) {
          query.clear();
          clearContentSearch();
        } else if (queryState.query) {
          query.clearRetained();
          browser.selectedIndex = 0;
          clearContentSearch();
        } else {
          stopBackgroundTasks();
          onClose();
        }
        return;
      case "start-search":
        query.start(command.kind);
        clearContentSearch();
        return;
      case "query-input":
        applyQueryEffect(query.handleInput(data), maxIndex);
        return;
      default:
        handleNormalBrowserCommand(command, displayList, maxIndex);
    }
  }

  function renderBrowserWithPreview(width: number): string[] {
    if (!previewEnabled || width < MIN_PREVIEW_WIDTH) return renderBrowser(width);

    const treeWidth = Math.floor((width - 1) * 0.3);
    const previewWidth = width - treeWidth - 1;
    const selected = getDisplayList()[browser.selectedIndex]?.node;
    if (selected) {
      if (previewPath !== selected.path) {
        clearPreviewCopyFeedback();
        previewViewer.setFile(selected);
        previewPath = selected.path;
      } else {
        previewViewer.updateFileRef(selected);
      }
    } else {
      clearPreviewCopyFeedback();
      previewViewer.close();
      previewPath = null;
    }

    const footerLineCount = !query.snapshot().active && showFullHelp ? 4 : 2;
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
    getRootAnchor(): { label: string; pinned?: boolean; index: number; count: number } | null {
      if (rootAnchors.length < 2) return null;
      const anchor = rootAnchors[activeAnchorIndex];
      return { label: anchor.label, ...(anchor.pinned ? { pinned: true } : {}), index: activeAnchorIndex + 1, count: rootAnchors.length };
    },
    getBrowsePosition(): { rootPath: string; directoryPath: string; selectedFilePath: string | null } {
      return deriveBrowserLocation(rootPath, getDisplayList()[browser.selectedIndex]?.node);
    },

    isPathCopied(): boolean {
      return !viewer.isOpen() && !previewOwnsCopyFeedback() && Date.now() < pathCopiedUntil;
    },
    isPathCopyError(): boolean {
      return !viewer.isOpen() && !previewOwnsCopyFeedback() && Date.now() < pathCopyErrorUntil;
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
