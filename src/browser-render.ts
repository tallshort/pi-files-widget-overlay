import { CURSOR_MARKER, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import type { BrowserQuerySnapshot } from "./browser-query";
import type { FileNode, FlatNode } from "./types";
import { isIgnoredStatus, isUntrackedStatus, sanitizeTerminalLabel } from "./utils";

export interface BrowserRenderModel {
  stats: { totalLines?: number; additions: number; deletions: number };
  scanState: { isScanning: boolean; isPartial: boolean };
  errors: string[];
  query: BrowserQuerySnapshot;
  displayList: FlatNode[];
  selectedIndex: number;
  browserHeight: number;
  showOnlyChanged: boolean;
  rootCount: number;
  showFullHelp: boolean;
  gitBranch: string;
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
    if (node.totalAdditions && node.totalAdditions > 0) parts.push(theme.fg("success", `+${node.totalAdditions}`));
    if (node.totalDeletions && node.totalDeletions > 0) parts.push(theme.fg("error", `-${node.totalDeletions}`));
    if (node.totalLines && node.lineCountComplete !== false) parts.push(theme.fg("dim", `${node.totalLines}L`));
  } else if (!node.isDirectory) {
    if (node.diffStats) {
      if (node.diffStats.additions > 0) parts.push(theme.fg("success", `+${node.diffStats.additions}`));
      if (node.diffStats.deletions > 0) parts.push(theme.fg("error", `-${node.diffStats.deletions}`));
    } else if (isUntrackedStatus(node.gitStatus) && node.lineCount !== undefined) {
      parts.push(theme.fg("success", `+${node.lineCount}`));
    }
    if (node.lineCount !== undefined) parts.push(theme.fg("dim", `${node.lineCount}L`));
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function formatNodeName(node: FileNode, theme: Theme): string {
  const name = sanitizeTerminalLabel(node.name);
  const withSymlinkMarker = (label: string): string => node.isSymlink ? `${label}${theme.fg("dim", " ↗")}` : label;
  if (isIgnoredStatus(node.gitStatus)) return withSymlinkMarker(theme.fg("dim", name));
  if (node.isDirectory) {
    const label = node.hasChangedChildren ? theme.fg("warning", name) : theme.fg("accent", name);
    const rendered = withSymlinkMarker(label);
    return node.loading ? `${rendered}${theme.fg("dim", " ~")}` : rendered;
  }
  if (node.gitStatus) return withSymlinkMarker(theme.fg("warning", name));
  return withSymlinkMarker(theme.fg("text", name));
}

export function renderBrowserTree(model: BrowserRenderModel, width: number, theme: Theme): string[] {
  const lines: string[] = [];
  const branchDisplay = model.gitBranch ? theme.fg("accent", ` (${sanitizeTerminalLabel(model.gitBranch)})`) : "";
  let statsDisplay = "";
  if (model.stats.totalLines !== undefined) statsDisplay += theme.fg("dim", ` ${model.stats.totalLines}L`);
  if (model.stats.additions > 0) statsDisplay += theme.fg("success", ` +${model.stats.additions}`);
  if (model.stats.deletions > 0) statsDisplay += theme.fg("error", ` -${model.stats.deletions}`);

  const partialIndicator = model.scanState.isPartial ? theme.fg("warning", " [partial]") : "";
  const errorIndicator = model.errors.length > 0 ? theme.fg("error", ` [${model.errors.join("; ")}]`) : "";
  const searchPrefix = model.query.kind === "content" ? "@" : "/";
  const searchIndicator = model.query.active
    ? theme.fg("accent", `  ${searchPrefix}${sanitizeTerminalLabel(model.query.query)}${CURSOR_MARKER}█`)
    : model.query.query
      ? theme.fg("dim", `  ${searchPrefix}${sanitizeTerminalLabel(model.query.query)}  (Esc clears)`)
      : "";
  const header = model.query.active || model.query.query
    ? errorIndicator + theme.bold(theme.fg("text", searchIndicator))
    : branchDisplay + statsDisplay + partialIndicator + errorIndicator;
  lines.push(truncateToWidth(header, width));
  lines.push(theme.fg("borderMuted", "─".repeat(width)));

  if (model.displayList.length === 0) {
    const emptyLabel = model.scanState.isScanning
      ? "  (loading...)"
      : "  (no files" + (model.query.query ? ` matching '${sanitizeTerminalLabel(model.query.query)}'` : "") + ")";
    lines.push(theme.fg("dim", emptyLabel));
    for (let index = 1; index < model.browserHeight; index++) lines.push("");
    lines.push("");
  } else {
    const start = Math.max(0, Math.min(model.selectedIndex - Math.floor(model.browserHeight / 2), model.displayList.length - model.browserHeight));
    const end = Math.min(model.displayList.length, start + model.browserHeight);
    for (let index = start; index < end; index++) {
      const { node, depth } = model.displayList[index]!;
      const indent = "  ".repeat(depth);
      const icon = node.isDirectory ? (node.expanded ? "▾ " : "▸ ") : "  ";
      const status = formatNodeStatus(node, theme);
      const meta = formatNodeMeta(node, theme);
      const name = formatNodeName(node, theme);
      const prefix = `${indent}${icon}`;
      const availableForName = Math.max(0, width - visibleWidth(prefix) - visibleWidth(status) - visibleWidth(meta));
      const visibleMeta = availableForName >= 3 ? meta : "";
      const nameWidth = Math.max(0, width - visibleWidth(prefix) - visibleWidth(status) - visibleWidth(visibleMeta));
      let line = truncateToWidth(`${prefix}${truncateToWidth(name, nameWidth, "…")}${status}${visibleMeta}`, width);
      if (index === model.selectedIndex) line = theme.bg("selectedBg", line + " ".repeat(Math.max(0, width - visibleWidth(line))));
      lines.push(line);
    }
    for (let index = end - start; index < model.browserHeight; index++) lines.push("");
    const percentage = model.displayList.length > 1 ? Math.round((model.selectedIndex / (model.displayList.length - 1)) * 100) : 100;
    lines.push(theme.fg("dim", `  ${model.selectedIndex + 1}/${model.displayList.length} (${percentage}%)`));
  }

  lines.push(theme.fg("borderMuted", "─".repeat(width)));
  const changedIndicator = model.showOnlyChanged ? theme.fg("warning", " [changed]") : "";
  const rootsHelp = model.rootCount > 1 ? "  Tab/⇧Tab: roots" : "";
  const help = model.query.active
    ? theme.fg("dim", "Type to search  ↑↓: nav  Enter: confirm  Esc: cancel")
    : theme.fg("dim", "j/k/↑/↓: move  Enter/l: open  h: back  /: filter  c/C: changes  ?: help") + changedIndicator;
  const fullHelp = [
    theme.fg("dim", "j/k/↑/↓: move  Enter: open  h/l←→: folder  PgUp/PgDn: page  c: changed only"),
    theme.fg("dim", "C: expand changes  []: change  /:@ search  y: copy path  p: preview  u: parent"),
    theme.fg("dim", ".: root  *: pin  q/Esc: close  ?: hide  +/-: height" + rootsHelp) + changedIndicator,
  ];
  if (!model.query.active && model.showFullHelp) lines.push(...fullHelp.map(line => truncateToWidth(line, width)));
  else lines.push(truncateToWidth(help, width));
  return lines;
}
