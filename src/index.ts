/**
 * Pi Editor Extension
 *
 * Provides an in-terminal file browser and viewer.
 * Use /readfiles to open the file browser, navigate with j/k, Enter to view.
 */

import { getAgentDir, isEditToolResult, isWriteToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { OVERLAY_MAX_HEIGHT, POLL_INTERVAL_MS } from "./constants";
import { formatCommentMessage } from "./comment";
import { getObservedToolActivityPath } from "./activity";
import { sanitizeTerminalLabel } from "./utils";

export function getRestoreBrowsePositionSettingsPath(agentDirectory = getAgentDir()): string {
  return join(agentDirectory, "settings.json");
}

/** Read-only opt-in: malformed, absent, or non-boolean settings stay disabled. */
export function readRestoreBrowsePositionSetting(settingsPath = getRestoreBrowsePositionSettingsPath()): boolean {
  try {
    const settings: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (!settings || typeof settings !== "object") return false;
    const namespace = (settings as Record<string, unknown>).piFilesWidgetOverlay;
    return !!namespace && typeof namespace === "object" && (namespace as Record<string, unknown>).restoreBrowsePosition === true;
  } catch {
    return false;
  }
}

export function sanitizeRestorePathLabel(path: string): string {
  return sanitizeTerminalLabel(path);
}
export interface RootAnchorConfig {
  id: string;
  path: string;
  label: string;
}

/** Parse whitespace-separated paths, preserving single- and double-quoted paths. */
export function parseReadfilesPaths(args: string | undefined): string[] {
  if (!args?.trim()) return [];
  const paths: string[] = [];
  const expression = /(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  for (const match of args.matchAll(expression)) paths.push(match[1] ?? match[2] ?? match[3]);
  return paths;
}

export function createRootAnchors(paths: string[], pinnedPaths: string[] = []): RootAnchorConfig[] {
  const uniquePaths = [...new Set(paths.map(path => resolve(path)))];
  const pinned = new Set(pinnedPaths.map(path => resolve(path)));
  const labels = uniquePaths.map(path => basename(path) || path);
  for (let index = 0; index < uniquePaths.length; index++) {
    if (labels.filter(label => label === labels[index]).length > 1) labels[index] = `${basename(dirname(uniquePaths[index]))}/${labels[index]}`;
  }
  return uniquePaths.map((path, index) => ({ id: path, path, label: labels[index], ...(pinned.has(path) ? { pinned: true } : {}) }));
}

export function readPinnedRoots(cwd: string, settingsPath = getRestoreBrowsePositionSettingsPath()): string[] {
  try {
    const settings: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const roots = settings && typeof settings === "object" && (settings as Record<string, unknown>).piFilesWidgetOverlay && typeof (settings as Record<string, unknown>).piFilesWidgetOverlay === "object"
      ? ((settings as { piFilesWidgetOverlay: Record<string, unknown> }).piFilesWidgetOverlay.pinnedRoots)
      : null;
    return Array.isArray(roots) ? [...new Set(roots.filter((root): root is string => typeof root === "string").map(root => resolve(cwd, root)))] : [];
  } catch { return []; }
}

export function writePinnedRoots(roots: string[], settingsPath = getRestoreBrowsePositionSettingsPath()): void {
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    if (!settings || Array.isArray(settings)) throw new Error("Invalid settings");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const namespace = settings.piFilesWidgetOverlay && typeof settings.piFilesWidgetOverlay === "object" && !Array.isArray(settings.piFilesWidgetOverlay)
    ? settings.piFilesWidgetOverlay as Record<string, unknown>
    : {};
  settings.piFilesWidgetOverlay = { ...namespace, pinnedRoots: [...new Set(roots.map(root => resolve(root)))] };
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}
export function shouldRestoreBrowsePosition(restoreEnabled: boolean, hasExplicitPath: boolean, multiRoot: boolean): boolean {
  return restoreEnabled && (!hasExplicitPath || multiRoot);
}

export function shouldCaptureBrowsePosition(restoreEnabled: boolean, multiRoot: boolean): boolean {
  return restoreEnabled && !multiRoot;
}

export function getCommandRootKey(path: string): string {
  return resolve(path);
}


export function getOverlayPathWidths(innerWidth: number, prefixWidth: number, activity: string, hasRestorePath: boolean): { availableWidth: number; rootWidth: number } {
  const activityWidth = activity ? visibleWidth(` ${activity}`) : 0;
  const availableWidth = Math.max(0, innerWidth - prefixWidth - 1 - activityWidth);
  return { availableWidth, rootWidth: hasRestorePath ? Math.floor(availableWidth / 2) : availableWidth };
}

function resolveCommandPath(arg: string, cwd: string): string {
  let candidate = arg;
  if (candidate === "~") candidate = homedir();
  else if (candidate.startsWith("~/")) candidate = join(homedir(), candidate.slice(2));
  return isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
}

function resolveInitialPath(arg: string | undefined, cwd: string): { path: string; error?: string } {
  if (!arg) return { path: cwd };
  let candidate = arg;
  if (!candidate) return { path: cwd };
  const absolute = resolveCommandPath(candidate, cwd);
  try {
    if (!statSync(absolute).isDirectory()) {
      return { path: cwd, error: `${absolute} is not a directory` };
    }
  } catch {
    return { path: cwd, error: `${absolute} is not accessible` };
  }
  return { path: absolute };
}
export interface BrowsePosition {
  rootPath: string;
  directoryPath: string;
  selectedFilePath: string | null;
}

function isAccessibleDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export type ResolvedBrowsePosition = {
  rootPath: string;
  directoryPath: string;
  selectedFilePath?: string;
  restored: boolean;
};

export function resolveRestoredPosition(defaultPath: string, position: BrowsePosition | null): ResolvedBrowsePosition {
  if (!position || !isAccessibleDirectory(position.rootPath)) return { rootPath: defaultPath, directoryPath: defaultPath, restored: false };
  const relativeDirectory = relative(position.rootPath, position.directoryPath);
  if (relativeDirectory === ".." || relativeDirectory.startsWith(`..${sep}`) || !isAccessibleDirectory(position.directoryPath)) {
    return { rootPath: defaultPath, directoryPath: defaultPath, restored: false };
  }
  if (position.selectedFilePath) {
    try {
      if (statSync(position.selectedFilePath).isFile() && dirname(position.selectedFilePath) === position.directoryPath) {
        return { rootPath: position.rootPath, directoryPath: position.directoryPath, selectedFilePath: position.selectedFilePath, restored: true };
      }
    } catch {
      // The file was removed between close and reopen; restore its directory.
    }
  }
  return { rootPath: position.rootPath, directoryPath: position.directoryPath, restored: true };
}
function truncatePathTail(path: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(path) <= width) return path;
  if (width === 1) return "…";
  let suffix = "";
  for (const character of [...path].reverse()) {
    if (visibleWidth(`…${character}${suffix}`) > width) break;
    suffix = character + suffix;
  }
  return `…${suffix}`;
}



export default function editorExtension(pi: ExtensionAPI): void {
  const agentModifiedFiles = new Set<string>();
  const restoreBrowsePosition = readRestoreBrowsePositionSetting();
  const browsePositions = new Map<string, BrowsePosition>();
  pi.registerCommand("readfiles", {
    description: "Open file browser as a floating overlay (optional: /readfiles <path...> for one or more roots)",
    handler: async (args, ctx) => {
      const cwd = ctx.cwd;
      const requestedPaths = parseReadfilesPaths(args);
      const commandRoots = requestedPaths.map(path => resolveCommandPath(path, cwd));
      const pinnedRoots = readPinnedRoots(cwd);
      const accessiblePinnedRoots = pinnedRoots.filter(isAccessibleDirectory);
      if (pinnedRoots.length > accessiblePinnedRoots.length) ctx.ui.notify("Some pinned roots are unavailable", "warning");
      const commandPaths = commandRoots.length > 0 ? [...commandRoots, ...accessiblePinnedRoots] : [cwd, ...accessiblePinnedRoots];
      const hasExplicitPath = requestedPaths.length > 0;
      const primary = resolveInitialPath(commandPaths[0], cwd);
      if (primary.error) {
        ctx.ui.notify(sanitizeTerminalLabel(primary.error), "error");
        return;
      }
      const resolved = primary;
      const rootAnchors = createRootAnchors([primary.path, ...commandPaths.slice(1).map(path => resolveCommandPath(path, cwd))], accessiblePinnedRoots);
      const multiRoot = rootAnchors.length > 1;
      const commandRoot = getCommandRootKey(resolved.path);
      const restoredPosition = browsePositions.get(commandRoot) ?? null;
      const restored = shouldRestoreBrowsePosition(restoreBrowsePosition, hasExplicitPath, commandRoots.length > 1) && restoredPosition
        ? resolveRestoredPosition(resolved.path, restoredPosition)
        : undefined;
      const initialRootPath = restored?.rootPath ?? resolved.path;
      const initialDirectoryPath = restored?.restored ? restored.directoryPath : undefined;
      const initialSelectedPath = restored?.restored ? restored.selectedFilePath : undefined;
      const { createFileBrowser } = await import("./browser");

      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        let pollInterval: ReturnType<typeof setInterval> | null = null;
        let captureBrowsePosition: (() => void) | null = null;

        const cleanup = () => {
          if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
          }
          if (restoreBrowsePosition) captureBrowsePosition?.();
          done();
        };

        const requestComment = (payload: { relPath: string; lineRange: string; ext: string; selectedText: string }, comment: string) => {
          const message = formatCommentMessage(payload, comment);
          if (ctx.isIdle()) {
            pi.sendUserMessage(message);
            ctx.ui.notify(`Comment sent to agent for ${sanitizeTerminalLabel(payload.relPath)} (${payload.lineRange})`, "info");
          } else {
            pi.sendUserMessage(message, { deliverAs: "followUp" });
            ctx.ui.notify(`Comment queued for agent for ${sanitizeTerminalLabel(payload.relPath)} (${payload.lineRange})`, "info");
          }
        };

        const requestRender = () => tui.requestRender();
        const browser = createFileBrowser(
          initialRootPath,
          agentModifiedFiles,
          theme,
          cleanup,
          requestComment,
          requestRender,
          cwd,
          initialSelectedPath,
          initialDirectoryPath,
          rootAnchors,
          {
            togglePinnedRoot: async path => {
              const pins = readPinnedRoots(cwd);
              const pinned = pins.includes(path);
              const nextPins = pinned ? pins.filter(root => root !== path) : [...pins, path];
              writePinnedRoots(nextPins);
              const roots = createRootAnchors([...(commandRoots.length > 0 ? commandRoots : [cwd]), ...nextPins.filter(isAccessibleDirectory)], nextPins);
              return { anchors: roots, message: `${pinned ? "Unpinned" : "Pinned"}: ${sanitizeTerminalLabel(path)}` };
            },
          }
        );
        if (shouldCaptureBrowsePosition(restoreBrowsePosition, multiRoot)) {
          captureBrowsePosition = () => {
            browsePositions.set(commandRoot, browser.getBrowsePosition());
          };
        }

        pollInterval = setInterval(() => {
          requestRender();
        }, POLL_INTERVAL_MS);

        const renderOverlay = (width: number): string[] => {
          // Keep the browser usable on narrow terminals: a percentage width is
          // clamped by Pi to the viewport, while the component truncates safely.
          if (width < 3) return browser.render(width);

          const innerWidth = width - 2;
          const padLine = (line: string) => {
            const truncated = truncateToWidth(line, innerWidth, "", true);
            return truncated + " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
          };
          const border = (character: string) => theme.fg("border", character);
          const activity = browser.getActivityLabel();
          const copyHint = browser.isPathCopied() ? " Path copied" : "";
          const restoredPath = browser.getRestorePath();
          const rootAnchor = browser.getRootAnchor();
          const anchorBadge = rootAnchor
            ? ` [${sanitizeTerminalLabel(rootAnchor.label)}${rootAnchor.pinned ? theme.fg("accent", "*") : ""} ${rootAnchor.index}/${rootAnchor.count}]`
            : "";
          const prefix = theme.fg("accent", theme.bold(" Files ")) + theme.fg("dim", `—${anchorBadge} `);
          const safeRootPath = sanitizeRestorePathLabel(browser.getRootPath());
          const safeRestoredPath = restoredPath ? sanitizeRestorePathLabel(restoredPath) : null;
          const { availableWidth, rootWidth } = getOverlayPathWidths(innerWidth, visibleWidth(prefix), `${activity}${copyHint}`, !!safeRestoredPath);
          const root = truncatePathTail(safeRootPath, rootWidth);
          const restoredPrefix = " ↳ restored: ";
          const restored = safeRestoredPath
            ? theme.fg("dim", `${restoredPrefix}${truncatePathTail(safeRestoredPath, Math.max(0, availableWidth - visibleWidth(root) - visibleWidth(restoredPrefix)))}`)
            : "";
          const header = padLine(prefix + theme.fg("text", root) + restored + (activity ? theme.fg("dim", ` ${activity}`) : "") + (copyHint ? theme.fg("dim", copyHint) : "") + " ");

          return [
            border(`┌${"─".repeat(innerWidth)}┐`),
            border("│") + header + border("│"),
            border(`├${"─".repeat(innerWidth)}┤`),
            ...browser.render(innerWidth).map(line => border("│") + padLine(line) + border("│")),
            border(`└${"─".repeat(innerWidth)}┘`),
          ];
        };

        return {
          render: renderOverlay,
          handleInput: (data) => {
            browser.handleInput(data);
            requestRender();
          },
          invalidate: () => browser.invalidate(),
        };
      }, {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "95%",
          maxHeight: OVERLAY_MAX_HEIGHT,
          margin: 1,
        },
      });
    },
  });

  pi.on("tool_result", async (event, ctx) => {
    const filePath = isWriteToolResult(event)
      ? getObservedToolActivityPath("write", event.input, ctx.cwd)
      : isEditToolResult(event)
        ? getObservedToolActivityPath("edit", event.input, ctx.cwd)
        : undefined;
    if (filePath) agentModifiedFiles.add(filePath);
  });

  pi.on("session_start", async () => {
    agentModifiedFiles.clear();
    browsePositions.clear();
  });

  pi.on("session_before_switch", () => {
    agentModifiedFiles.clear();
    browsePositions.clear();
  });
}
