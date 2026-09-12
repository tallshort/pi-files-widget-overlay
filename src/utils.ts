import { accessSync, constants, statSync } from "node:fs";
import { extname, join } from "node:path";

const TERMINAL_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

/** Replace bytes that could alter terminal output while retaining a recognizable label. */
export function sanitizeTerminalLabel(label: string): string {
  return label.replace(TERMINAL_CONTROL_CHARACTERS, "�");
}

/** Format unknown thrown values safely before displaying them in the terminal. */
export function formatErrorMessage(error: unknown): string {
  try {
    return sanitizeTerminalLabel(error instanceof Error ? error.message : String(error));
  } catch {
    return "Unknown error";
  }
}

export interface CommandLookupOptions {
  platform?: NodeJS.Platform;
  path?: string;
  pathExt?: string;
  cwd?: string;
}

export function hasCommand(cmd: string, options: CommandLookupOptions = {}): boolean {
  const platform = options.platform ?? process.platform;
  const pathValue = options.path ?? process.env.PATH ?? "";
  const pathEntries = pathValue.split(platform === "win32" ? ";" : ":");
  const searchDirectories = platform === "win32"
    ? [options.cwd ?? process.cwd(), ...pathEntries]
    : pathEntries;
  const extensions = platform === "win32" && !extname(cmd)
    ? (options.pathExt ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const accessMode = platform === "win32" ? constants.F_OK : constants.X_OK;

  for (const rawDirectory of searchDirectories) {
    const directory = platform === "win32" && rawDirectory.startsWith('"') && rawDirectory.endsWith('"')
      ? rawDirectory.slice(1, -1)
      : rawDirectory;
    for (const extension of extensions) {
      try {
        const candidate = join(directory || ".", `${cmd}${extension}`);
        accessSync(candidate, accessMode);
        if (statSync(candidate).isFile()) return true;
      } catch {
        // Continue searching PATH.
      }
    }
  }

  return false;
}

export function isUntrackedStatus(status?: string): boolean {
  return status === "?" || status === "??";
}

export function isIgnoredStatus(status?: string): boolean {
  return status === "!" || status === "!!";
}

export function isMarkdownPath(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

const IMAGE_EXTENSIONS = new Set([".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

export function stripLeadingEmptyLines(lines: string[]): string[] {
  let startIdx = 0;
  while (startIdx < lines.length && !lines[startIdx].trim()) {
    startIdx++;
  }
  return lines.slice(startIdx);
}
