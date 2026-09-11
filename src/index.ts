/**
 * Pi Editor Extension
 *
 * Provides an in-terminal file browser and viewer.
 * Use /readfiles to open the file browser, navigate with j/k, Enter to view.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { OVERLAY_MAX_HEIGHT, POLL_INTERVAL_MS } from "./constants";
import { formatCommentMessage } from "./comment";
import { getObservedToolActivityPath } from "./activity";

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

export default function editorExtension(pi: ExtensionAPI): void {
  const cwd = process.cwd();
  const agentModifiedFiles = new Set<string>();

  pi.registerCommand("readfiles", {
    description: "Open file browser as a floating overlay (optional: /readfiles <path> to start outside the current directory)",
    handler: async (args, ctx) => {

      const resolved = resolveInitialPath(args, cwd);
      if (resolved.error) {
        ctx.ui.notify(resolved.error, "error");
        return;
      }
      const initialPath = resolved.path;
      const { createFileBrowser } = await import("./browser");

      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        let pollInterval: ReturnType<typeof setInterval> | null = null;

        const cleanup = () => {
          if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
          }
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
          initialPath,
          agentModifiedFiles,
          theme,
          cleanup,
          requestComment,
          requestRender,
          cwd
        );

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
          const header = padLine(
            theme.fg("accent", theme.bold(" Files ")) +
              theme.fg("dim", "— ") +
              theme.fg("text", browser.getRootPath()) +
              (activity ? theme.fg("dim", ` ${activity}`) : "") +
              " "
          );

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
  });

  pi.on("session_before_switch", () => {
    agentModifiedFiles.clear();
  });
}
