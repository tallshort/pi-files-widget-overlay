import { dirname } from "node:path";

import type { FileNode, FlatNode } from "./types";
import type { BrowserQuerySnapshot } from "./browser-query";

export interface BrowserDisplayState {
  flatList: FlatNode[];
  fullList: FlatNode[];
  contentMatches: Set<string>;
  showOnlyChanged: boolean;
}

export interface BrowserLocation {
  rootPath: string;
  directoryPath: string;
  selectedFilePath: string | null;
}

export interface ChangedNavigationTarget {
  file: FileNode;
  ancestors: FileNode[];
}

function collectChangedFiles(node: FileNode, ancestors: FileNode[] = []): ChangedNavigationTarget[] {
  const results: ChangedNavigationTarget[] = [];
  if (!node.isDirectory && (node.gitStatus || node.agentModified)) results.push({ file: node, ancestors: [...ancestors] });
  for (const child of node.children ?? []) results.push(...collectChangedFiles(child, [...ancestors, node]));
  return results;
}

export function deriveChangedNavigationTarget(
  root: FileNode,
  displayList: FlatNode[],
  selectedIndex: number,
  direction: 1 | -1,
  restrictToDisplay: boolean,
): ChangedNavigationTarget | null {
  const visiblePaths = new Set(displayList.map(item => item.node.path));
  const allChangedFiles = collectChangedFiles(root);
  const changedFiles = restrictToDisplay
    ? allChangedFiles.filter(change => visiblePaths.has(change.file.path))
    : allChangedFiles;
  if (changedFiles.length === 0) return null;

  const currentNode = displayList[selectedIndex]?.node;
  const currentIndex = currentNode && !currentNode.isDirectory
    ? changedFiles.findIndex(change => change.file.path === currentNode.path)
    : -1;
  if (currentIndex === -1) return changedFiles[direction === 1 ? 0 : changedFiles.length - 1] ?? null;
  return changedFiles[(currentIndex + direction + changedFiles.length) % changedFiles.length] ?? null;
}
export function deriveBrowserDisplayList(state: BrowserDisplayState, query: BrowserQuerySnapshot): FlatNode[] {
  let list = query.query ? state.fullList : state.flatList;
  if (state.showOnlyChanged) {
    list = list.filter(item => item.node.gitStatus || item.node.agentModified || (item.node.isDirectory && item.node.hasChangedChildren));
  }
  if (!query.query) return list;
  if (query.kind === "content") {
    return list.filter(item => !item.node.isDirectory && state.contentMatches.has(item.node.path));
  }
  const normalizedQuery = query.query.toLowerCase();
  return list.filter(item => item.node.name.toLowerCase().includes(normalizedQuery));
}
export function expandChangedDirectories(node: FileNode, expandedPaths: Set<string>): void {
  if (!node.isDirectory || !node.hasChangedChildren) return;
  if (!node.expanded) {
    node.expanded = true;
    expandedPaths.add(node.path);
  }
  for (const child of node.children ?? []) expandChangedDirectories(child, expandedPaths);
}

export function restoreExpandedDirectories(node: FileNode, expandedPaths: Set<string>): void {
  if (expandedPaths.delete(node.path)) node.expanded = false;
  for (const child of node.children ?? []) restoreExpandedDirectories(child, expandedPaths);
}

export function deriveBrowserLocation(rootPath: string, selected: FileNode | undefined): BrowserLocation {
  const selectedFilePath = selected && !selected.isDirectory ? selected.path : null;
  return {
    rootPath,
    directoryPath: selected?.isDirectory ? selected.path : selectedFilePath ? dirname(selectedFilePath) : rootPath,
    selectedFilePath,
  };
}
