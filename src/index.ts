/**
 * Pi Editor Extension
 *
 * Provides an in-terminal file browser and viewer.
 * Use /readfiles to open the file browser, navigate with j/k, Enter to view.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { OVERLAY_MAX_HEIGHT, POLL_INTERVAL_MS } from "./constants";
import { formatCommentMessage } from "./comment";
import { getObservedToolActivityPath } from "./activity";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

/** Read-only opt-in: malformed, absent, or non-boolean settings stay disabled. */
export function readRestoreBrowsePositionSetting(settingsPath = join(homedir(), ".pi", "agent", "settings.json")): boolean {
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
  return path.replace(CONTROL_CHARACTERS, "�");
}

export function getOverlayPathWidths(innerWidth: number, prefixWidth: number, activity: string, hasRestorePath: boolean): { availableWidth: number; rootWidth: number } {
  const activityWidth = activity ? visibleWidth(` ${activity}`) : 0;
  const availableWidth = Math.max(0, innerWidth - prefixWidth - 1 - activityWidth);
  return { availableWidth, rootWidth: hasRestorePath ? Math.floor(availableWidth / 2) : availableWidth };
}

function resolveInitialPath(arg: string | undefined, cwd: string): { path: string; error?: string } {
  if (!arg) return { path: cwd };
  let candidate = arg.trim();
  if (!candidate) return { path: cwd };
  const home = homedir();
  if (candidate === "~") {
    candidate = home;
  } else if (candidate.startsWith("~/")) {
    candidate = join(home, candidate.slice(2));
  }
  const absolute = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
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

export function resolveRestoredPosition(defaultPath: string, position: BrowsePosition | null): { rootPath: string; directoryPath: string; selectedFilePath?: string } {
  if (!position || !isAccessibleDirectory(position.rootPath)) return { rootPath: defaultPath, directoryPath: defaultPath };
  const relativeDirectory = relative(position.rootPath, position.directoryPath);
  if (relativeDirectory === ".." || relativeDirectory.startsWith(`..${sep}`) || !isAccessibleDirectory(position.directoryPath)) {
    return { rootPath: defaultPath, directoryPath: defaultPath };
  }
  if (position.selectedFilePath) {
    try {
      if (statSync(position.selectedFilePath).isFile() && dirname(position.selectedFilePath) === position.directoryPath) {
        return { rootPath: position.rootPath, directoryPath: position.directoryPath, selectedFilePath: position.selectedFilePath };
      }
    } catch {
      // The file was removed between close and reopen; restore its directory.
    }
  }
  return { rootPath: position.rootPath, directoryPath: position.directoryPath };
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
  const cwd = process.cwd();
  const agentModifiedFiles = new Set<string>();
  const restoreBrowsePosition = readRestoreBrowsePositionSetting();
  let lastBrowsePosition: BrowsePosition | null = null;
  pi.registerCommand("readfiles", {
    description: "Open file browser as a floating overlay (optional: /readfiles <path> to start outside the current directory)",
    handler: async (args, ctx) => {

      const resolved = resolveInitialPath(args, cwd);
      if (resolved.error) {
        ctx.ui.notify(resolved.error, "error");
        return;
      }
      const hasExplicitPath = Boolean(args?.trim());
      const restored = restoreBrowsePosition && !hasExplicitPath && lastBrowsePosition
        ? resolveRestoredPosition(resolved.path, lastBrowsePosition)
        : undefined;
      const initialRootPath = restored?.rootPath ?? resolved.path;
      const initialDirectoryPath = restored?.directoryPath;
      const initialSelectedPath = restored?.selectedFilePath;
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
            ctx.ui.notify(`Comment sent to agent for ${payload.relPath} (${payload.lineRange})`, "info");
          } else {
            pi.sendUserMessage(message, { deliverAs: "followUp" });
            ctx.ui.notify(`Comment queued for agent for ${payload.relPath} (${payload.lineRange})`, "info");
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
          initialDirectoryPath
        );
        if (restoreBrowsePosition) {
          captureBrowsePosition = () => {
            lastBrowsePosition = browser.getBrowsePosition();
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
          const restoredPath = browser.getRestorePath();
          const prefix = theme.fg("accent", theme.bold(" Files ")) + theme.fg("dim", "— ");
          const safeRootPath = sanitizeRestorePathLabel(browser.getRootPath());
          const safeRestoredPath = restoredPath ? sanitizeRestorePathLabel(restoredPath) : null;
          const { availableWidth, rootWidth } = getOverlayPathWidths(innerWidth, visibleWidth(prefix), activity, !!safeRestoredPath);
          const root = truncatePathTail(safeRootPath, rootWidth);
          const restoredPrefix = " ↳ restored: ";
          const restored = safeRestoredPath
            ? theme.fg("dim", `${restoredPrefix}${truncatePathTail(safeRestoredPath, Math.max(0, availableWidth - visibleWidth(root) - visibleWidth(restoredPrefix)))}`)
            : "";
          const header = padLine(prefix + theme.fg("text", root) + restored + (activity ? theme.fg("dim", ` ${activity}`) : "") + " ");

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

  pi.on("tool_result", async (event) => {
    const filePath = getObservedToolActivityPath(event.toolName, event.input, cwd);
    if (filePath) agentModifiedFiles.add(filePath);
  });

  pi.on("session_start", async () => {
    agentModifiedFiles.clear();
    lastBrowsePosition = null;
  });

  pi.on("session_before_switch", () => {
    agentModifiedFiles.clear();
    lastBrowsePosition = null;
  });
}
