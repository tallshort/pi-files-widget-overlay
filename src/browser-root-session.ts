import type { Dirent } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import {
  LINE_COUNT_BATCH_DELAY_MS,
  LINE_COUNT_BATCH_SIZE,
  MAX_LINE_COUNT_BYTES,
  MAX_TREE_DEPTH,
  SAFE_MODE_ENTRY_THRESHOLD,
  SCAN_BATCH_DELAY_MS,
  SCAN_BATCH_SIZE,
} from "./constants";
import { sortChildren, updateTreeStats } from "./file-tree";
import { getPathInfoSync, safeRealPathSync } from "./path-info";
import type { DiffStats, FileNode } from "./types";
import { isUntrackedStatus, sanitizeTerminalLabel } from "./utils";

export interface BrowserTreeStats {
  totalLines?: number;
  additions: number;
  deletions: number;
}

export type BrowserScanMode = "full" | "safe" | "none";

export interface BrowserScanState {
  mode: BrowserScanMode;
  isScanning: boolean;
  isPartial: boolean;
  pending: number;
}

export interface BrowserRootState {
  root: FileNode | null;
  stats: BrowserTreeStats;
  nodeByPath: Map<string, FileNode>;
  scanState: BrowserScanState;
}

export type BrowserRootSessionEvent = "tree" | "line-counts";

export interface BrowserRootSession {
  getRootPath(): string;
  getGeneration(): number;
  isCurrent(generation: number): boolean;
  startRoot(path: string): number;
  replaceRoot(root: FileNode): void;
  stop(): void;
  setGitContext(status: Map<string, string>, diffStats: Map<string, DiffStats>, usesGitTree: boolean): void;
  refreshStats(): void;
  applyGitMetadata(status: Map<string, string>, diffStats: Map<string, DiffStats>): void;
  enqueueScan(node: FileNode, depth: number, force?: boolean): void;
  queueLineCount(node: FileNode, force?: boolean): void;
  queueLineCountsForDirectory(directory: FileNode | null): void;
  getNodeDepth(node: FileNode): number;
}

interface BrowserRootSessionOptions {
  state: BrowserRootState;
  agentModifiedFiles: Set<string>;
  ignored: Set<string>;
  readDirectory: (path: string) => Promise<Dirent[]>;
  onEvent: (event: BrowserRootSessionEvent) => void;
  onError: (message: string) => void;
}

function indexNodes(root: FileNode | null, map: Map<string, FileNode>): void {
  map.clear();
  if (!root) return;
  const stack: FileNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    map.set(node.path, node);
    if (node.children) stack.push(...node.children);
  }
}

function getTreeStats(root: FileNode | null): BrowserTreeStats {
  if (!root) return { totalLines: undefined, additions: 0, deletions: 0 };
  return {
    totalLines: root.lineCountComplete ? root.totalLines ?? 0 : undefined,
    additions: root.totalAdditions ?? 0,
    deletions: root.totalDeletions ?? 0,
  };
}

function hasAncestorRealPath(node: FileNode | undefined, realPath: string): boolean {
  for (let current = node; current; current = current.parent) {
    if (current.realPath === realPath) return true;
  }
  return false;
}

function shouldSafeMode(path: string): boolean {
  const resolved = resolve(path);
  return resolved === resolve(homedir()) || resolved === resolve(sep);
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

export function createBrowserRootSession(options: BrowserRootSessionOptions): BrowserRootSession {
  const { state, agentModifiedFiles, ignored, readDirectory, onEvent, onError } = options;
  const lineCountCache = new Map<string, { size: number; mtimeMs: number; count: number }>();
  const lineCountQueue: FileNode[] = [];
  const lineCountPending = new Set<string>();
  const scanQueue: Array<{ node: FileNode; depth: number }> = [];
  const scanQueued = new Set<string>();
  let lineCountTimer: ReturnType<typeof setTimeout> | null = null;
  let scanTimer: ReturnType<typeof setTimeout> | null = null;
  let rootGeneration = 0;
  let treeGeneration = 0;
  let rootPath = "";
  let usesGitTree = false;
  let gitStatus = new Map<string, string>();
  let diffStats = new Map<string, DiffStats>();

  const normalizeGitPath = (path: string): string => path.split(sep).join("/");

  function clearWork(): void {
    treeGeneration += 1;
    scanQueue.length = 0;
    scanQueued.clear();
    lineCountQueue.length = 0;
    lineCountPending.clear();
    if (scanTimer) clearTimeout(scanTimer);
    if (lineCountTimer) clearTimeout(lineCountTimer);
    scanTimer = null;
    lineCountTimer = null;
    state.scanState.isScanning = false;
    state.scanState.pending = 0;
  }

  function refreshStats(): void {
    if (state.root) updateTreeStats(state.root);
    state.stats = getTreeStats(state.root);
  }

  function queueLineCount(node: FileNode, force = false): void {
    if (node.isDirectory || (!force && node.lineCount !== undefined) || lineCountPending.has(node.path)) return;
    lineCountPending.add(node.path);
    lineCountQueue.push(node);
    if (!lineCountTimer) lineCountTimer = setTimeout(processLineCountBatch, LINE_COUNT_BATCH_DELAY_MS);
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
    if (!state.root) return;
    const generation = rootGeneration;
    const tree = treeGeneration;
    const batch = lineCountQueue.splice(0, LINE_COUNT_BATCH_SIZE);
    if (batch.length === 0) return;

    await Promise.all(batch.map(async node => {
      await updateLineCount(node);
      if (generation === rootGeneration && tree === treeGeneration) lineCountPending.delete(node.path);
    }));
    if (generation !== rootGeneration || tree !== treeGeneration) return;

    refreshStats();
    onEvent("line-counts");
    if (lineCountQueue.length > 0) lineCountTimer = setTimeout(processLineCountBatch, LINE_COUNT_BATCH_DELAY_MS);
  }

  function shouldAutoScan(depth: number): boolean {
    if (usesGitTree) return false;
    if (state.scanState.mode === "safe") return depth <= 0;
    return depth <= MAX_TREE_DEPTH;
  }

  function getScanDelay(): number {
    return state.scanState.mode === "safe" ? SCAN_BATCH_DELAY_MS * 4 : SCAN_BATCH_DELAY_MS;
  }

  function enqueueScan(node: FileNode, depth: number, force = false): void {
    if (depth > MAX_TREE_DEPTH) return;
    if (!force && state.scanState.mode === "safe" && depth > 0) return;
    if (node.children !== undefined || node.loading || scanQueued.has(node.path)) return;

    node.loading = true;
    scanQueued.add(node.path);
    scanQueue.push({ node, depth });
    state.scanState.pending = scanQueue.length;
    state.scanState.isScanning = true;
    if (!scanTimer) scanTimer = setTimeout(processScanBatch, getScanDelay());
  }

  async function scanDirectory(node: FileNode, depth: number, generation: number, tree: number): Promise<void> {
    try {
      const entries = await readDirectory(node.path);
      if (generation !== rootGeneration || tree !== treeGeneration) return;
      const sorted = [...entries].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

      if (node.path === rootPath && state.scanState.mode === "full" && sorted.length >= SAFE_MODE_ENTRY_THRESHOLD) {
        state.scanState.mode = "safe";
        state.scanState.isPartial = true;
        scanQueue.length = 0;
        scanQueued.clear();
      }

      const dirs: FileNode[] = [];
      const files: FileNode[] = [];
      for (const entry of sorted) {
        if (ignored.has(entry.name)) continue;
        const fullPath = join(node.path, entry.name);
        const childDepth = depth + 1;
        const gitPath = normalizeGitPath(relative(rootPath, fullPath));

        if (entry.isDirectory()) {
          const dirRealPath = await realpath(fullPath).catch(() => resolve(fullPath));
          if (generation !== rootGeneration || tree !== treeGeneration) return;
          const dirNode: FileNode = {
            name: entry.name, path: fullPath, isDirectory: true, realPath: dirRealPath, parent: node,
            children: undefined, expanded: childDepth < 1, hasChangedChildren: false,
            gitStatus: gitStatus.get(gitPath), diffStats: diffStats.get(gitPath),
          };
          dirs.push(dirNode);
          state.nodeByPath.set(fullPath, dirNode);
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
              gitStatus: gitStatus.get(gitPath), diffStats: diffStats.get(gitPath),
            };
            dirs.push(dirNode);
            state.nodeByPath.set(fullPath, dirNode);
            if (!isCycle && shouldAutoScan(childDepth)) enqueueScan(dirNode, childDepth);
            continue;
          }
        }

        const fileNode: FileNode = {
          name: entry.name, path: fullPath, isDirectory: false, isSymlink: entry.isSymbolicLink() || undefined,
          parent: node, agentModified: agentModifiedFiles.has(fullPath),
          gitStatus: gitStatus.get(gitPath), diffStats: diffStats.get(gitPath),
        };
        files.push(fileNode);
        state.nodeByPath.set(fullPath, fileNode);
        queueLineCount(fileNode);
      }
      node.children = [...dirs, ...files];
    } catch {
      if (generation === rootGeneration && tree === treeGeneration) {
        node.children = [];
        onError(`Unable to scan ${node === state.root ? "directory" : sanitizeTerminalLabel(node.name)}`);
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
    if (!state.root) return;
    const generation = rootGeneration;
    const tree = treeGeneration;
    const batch = scanQueue.splice(0, state.scanState.mode === "safe" ? 1 : SCAN_BATCH_SIZE);
    if (batch.length === 0) {
      state.scanState.isScanning = false;
      state.scanState.pending = 0;
      return;
    }

    for (const item of batch) {
      await scanDirectory(item.node, item.depth, generation, tree);
      if (generation !== rootGeneration || tree !== treeGeneration) return;
    }

    state.scanState.pending = scanQueue.length;
    state.scanState.isScanning = scanQueue.length > 0;
    refreshStats();
    onEvent("tree");
    if (scanQueue.length > 0) scanTimer = setTimeout(processScanBatch, getScanDelay());
  }

  function ensureNode(relPath: string): FileNode | null {
    if (!state.root) return null;
    let normalized = normalizeGitPath(relPath.trim());
    if (normalized.startsWith("./")) normalized = normalized.slice(2);
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length === 0 || parts.length - 1 > MAX_TREE_DEPTH) return null;

    let current = state.root;
    let currentRel = "";
    for (let index = 0; index < parts.length - 1; index++) {
      const part = parts[index];
      if (ignored.has(part)) return null;
      currentRel = currentRel ? `${currentRel}/${part}` : part;
      const dirPath = join(rootPath, currentRel);
      let directory = state.nodeByPath.get(dirPath);
      if (!directory) {
        directory = {
          name: part,
          path: dirPath,
          isDirectory: true,
          realPath: safeRealPathSync(dirPath),
          parent: current,
          children: [],
          expanded: index + 1 < 1,
          hasChangedChildren: false,
        };
        current.children ??= [];
        current.children.push(directory);
        sortChildren(current);
        state.nodeByPath.set(dirPath, directory);
      }
      current = directory;
    }

    const name = parts[parts.length - 1];
    if (ignored.has(name)) return null;
    const filePath = join(rootPath, normalized);
    const existing = state.nodeByPath.get(filePath);
    if (existing) return existing;

    const pathInfo = getPathInfoSync(filePath);
    if (pathInfo.isDirectory) {
      const isCycle = pathInfo.realPath ? hasAncestorRealPath(current, pathInfo.realPath) : false;
      const directory: FileNode = {
        name,
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
      current.children.push(directory);
      sortChildren(current);
      state.nodeByPath.set(filePath, directory);
      return directory;
    }

    const file: FileNode = {
      name,
      path: filePath,
      isDirectory: false,
      isSymlink: pathInfo.isSymlink,
      parent: current,
      gitStatus: gitStatus.get(normalized),
      agentModified: agentModifiedFiles.has(filePath),
      diffStats: diffStats.get(normalized),
    };
    current.children ??= [];
    current.children.push(file);
    sortChildren(current);
    state.nodeByPath.set(filePath, file);
    return file;
  }

  function applyGitMetadata(status: Map<string, string>, stats: Map<string, DiffStats>): void {
    gitStatus = status;
    diffStats = stats;
    for (const node of state.nodeByPath.values()) {
      if (!node.isDirectory) node.agentModified = agentModifiedFiles.has(node.path);
      const relPath = normalizeGitPath(relative(rootPath, node.path));
      node.gitStatus = gitStatus.get(relPath);
      node.diffStats = diffStats.get(relPath);
    }
    for (const [relPath, fileStatus] of gitStatus.entries()) {
      if (!isUntrackedStatus(fileStatus)) continue;
      const node = ensureNode(relPath);
      if (!node) continue;
      node.gitStatus = fileStatus;
      node.diffStats = diffStats.get(relPath);
      if (!node.isDirectory) queueLineCount(node, true);
    }
    refreshStats();
  }

  return {
    getRootPath: () => rootPath,
    getGeneration: () => rootGeneration,
    isCurrent: generation => generation === rootGeneration,
    startRoot(path): number {
      rootGeneration += 1;
      clearWork();
      rootPath = resolve(path);
      usesGitTree = false;
      gitStatus = new Map();
      diffStats = new Map();
      state.root = {
        name: ".", path: rootPath, isDirectory: true, realPath: safeRealPathSync(rootPath),
        children: undefined, expanded: true, hasChangedChildren: false,
      };
      state.scanState.mode = shouldSafeMode(rootPath) ? "safe" : "full";
      state.scanState.isScanning = false;
      state.scanState.isPartial = state.scanState.mode === "safe";
      state.scanState.pending = 0;
      indexNodes(state.root, state.nodeByPath);
      refreshStats();
      enqueueScan(state.root, 0, true);
      return rootGeneration;
    },
    replaceRoot(root): void {
      clearWork();
      state.root = root;
      state.scanState.mode = "none";
      state.scanState.isScanning = false;
      state.scanState.isPartial = false;
      state.scanState.pending = 0;
      indexNodes(root, state.nodeByPath);
      refreshStats();
      queueLineCountsForDirectory(root);
    },
    stop(): void {
      rootGeneration += 1;
      clearWork();
    },
    setGitContext(status, stats, gitTree): void {
      gitStatus = status;
      diffStats = stats;
      usesGitTree = gitTree;
    },
    refreshStats,
    applyGitMetadata,
    enqueueScan,
    queueLineCount,
    queueLineCountsForDirectory,
    getNodeDepth(node): number {
      if (node.path === rootPath) return 0;
      const rel = relative(rootPath, node.path);
      return rel ? rel.split(sep).length : 0;
    },
  };
}
