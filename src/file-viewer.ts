import { getLanguageFromPath, getMarkdownTheme, highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

import { isGitRepo } from "./git";
import { isImagePath, isMarkdownPath, stripLeadingEmptyLines } from "./utils";

type UnifiedDiffLine = {
  kind: "add" | "remove" | "context";
  lineNumber: number;
  text: string;
};

export type RenderedLines = {
  lines: string[];
  rowGroups: number[];
  logicalLines: string[];
};

function parseUnifiedDiff(diffOutput: string): UnifiedDiffLine[] {
  const lines: UnifiedDiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const rawLine of diffOutput.split("\n")) {
    const hunk = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || rawLine.startsWith("\\ No newline at end of file")) continue;

    const text = rawLine.slice(1);
    switch (rawLine[0]) {
      case " ":
        lines.push({ kind: "context", lineNumber: newLine, text });
        oldLine++;
        newLine++;
        break;
      case "-":
        lines.push({ kind: "remove", lineNumber: oldLine++, text });
        break;
      case "+":
        lines.push({ kind: "add", lineNumber: newLine++, text });
        break;
    }
  }

  return lines;
}

function wrapUnifiedDiffLine(line: string, width: number, wordWrap: boolean): string[] {
  if (!wordWrap) return [line];
  const separatorIndex = line.indexOf("│");
  if (separatorIndex === -1 || width <= 0) return wrapTextWithAnsi(line, width);

  const prefix = line.slice(0, separatorIndex + 2);
  const contentWidth = Math.max(width - visibleWidth(prefix), 1);
  const content = line.slice(separatorIndex + 2);
  const continuationPrefix = prefix.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\d/g, token => token.startsWith("\x1b") ? token : " ");
  return wrapTextWithAnsi(content, contentWidth).map((chunk, index) =>
    (index === 0 ? prefix : continuationPrefix) + chunk
  );
}

function renderUnifiedDiff(diffOutput: string, width: number, theme: Theme, wordWrap: boolean): RenderedLines {
  const parsed = parseUnifiedDiff(diffOutput);
  if (parsed.length === 0) {
    const lines = stripLeadingEmptyLines(diffOutput.split("\n"));
    return { lines, rowGroups: lines.map((_, index) => index), logicalLines: lines };
  }

  const lineNumberWidth = String(Math.max(...parsed.map(line => line.lineNumber))).length;
  const lines: string[] = [];
  const rowGroups: number[] = [];
  const logicalLines: string[] = [];
  for (const [group, { kind, lineNumber, text }] of parsed.entries()) {
    const marker = kind === "add" ? "+" : kind === "remove" ? "-" : " ";
    const color =
      kind === "add" ? "toolDiffAdded" : kind === "remove" ? "toolDiffRemoved" : "toolDiffContext";
    const rendered = theme.fg(color, `${marker} ${String(lineNumber).padStart(lineNumberWidth)} │ ${text}`);
    logicalLines.push(rendered);
    const wrapped = wrapUnifiedDiffLine(rendered, width, wordWrap);
    lines.push(...wrapped);
    rowGroups.push(...wrapped.map(() => group));
  }
  return { lines, rowGroups, logicalLines };
}
export interface LoadedFileContent extends RenderedLines {
  renderedMarkdown: boolean;
  selectable?: boolean;
}
type UnsafeFileKind = "binary" | "terminal-control";

function getUnsafeFileKind(content: Buffer): UnsafeFileKind | null {
  const text = content.toString("utf-8");
  if (content.includes(0) || !Buffer.from(text, "utf-8").equals(content)) return "binary";
  for (let index = 0; index < text.length; index++) {
    const codePoint = text.codePointAt(index) ?? 0;
    if (codePoint === 0x0d && text[index + 1] === "\n") continue;
    if ((codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a) || codePoint === 0x7f || (codePoint >= 0x80 && codePoint <= 0x9f)) {
      return "terminal-control";
    }
  }
  return null;
}

function unsafeFilePlaceholder(kind: UnsafeFileKind, size: number): LoadedFileContent {
  const lines = [
    `Preview unavailable: ${kind} file.`,
    `Size: ${(size / 1024).toFixed(1)} KiB. Open the file externally to inspect it.`,
  ];
  return { lines, rowGroups: lines.map((_, index) => index), logicalLines: lines, renderedMarkdown: false, selectable: false };
}

function unsafeDiffPlaceholder(kind: UnsafeFileKind): LoadedFileContent {
  const lines = [`Diff preview unavailable: ${kind} content.`];
  return { lines, rowGroups: [0], logicalLines: lines, renderedMarkdown: false, selectable: false };
}

export interface LoadFileContentOptions {
  cwd: string;
  diffMode: boolean;
  hasChanges: boolean;
  width?: number;
  renderMarkdown: boolean;
  wordWrap: boolean;
}

export function loadFileContent(
  filePath: string,
  { cwd, diffMode, hasChanges, width, renderMarkdown, wordWrap }: LoadFileContentOptions,
  theme: Theme
): LoadedFileContent {
  const isMarkdown = isMarkdownPath(filePath);
  const termWidth = width || process.stdout.columns || 80;

  try {
    try {
      if (statSync(filePath).isDirectory()) {
        return { lines: ["Directory selected - expand it in the file tree instead of opening it."], rowGroups: [0], logicalLines: ["Directory selected - expand it in the file tree instead of opening it."], renderedMarkdown: false };
      }
    } catch {
      // Ignore stat errors and fall through to normal handling
    }

    if (isImagePath(filePath)) {
      const size = statSync(filePath).size;
      const lines = [
        `Image preview is unavailable in the overlay (${(size / 1024).toFixed(1)} KiB).`,
        "Open the file with an external image viewer instead.",
      ];
      return { lines, rowGroups: lines.map((_, index) => index), logicalLines: lines, renderedMarkdown: false, selectable: false };
    }
    const bytes = readFileSync(filePath);
    const unsafeKind = getUnsafeFileKind(bytes);
    if (unsafeKind) return unsafeFilePlaceholder(unsafeKind, bytes.length);
    const raw = bytes.toString("utf-8").replace(/\r\n/g, "\n");

    if (diffMode && hasChanges && isGitRepo(cwd)) {
      try {
        // Try different diff strategies
        let diffOutput = "";

        // First try: unstaged changes
          const unstaged = execFileSync("git", ["diff", "--no-color", "--", filePath], { cwd, encoding: "utf-8", timeout: 10000, stdio: "pipe" });
        if (unstaged.trim()) {
          diffOutput = unstaged;
        } else {
          // Second try: staged changes
          const staged = execFileSync("git", ["diff", "--no-color", "--cached", "--", filePath], { cwd, encoding: "utf-8", timeout: 10000, stdio: "pipe" });
          if (staged.trim()) {
            diffOutput = staged;
          } else {
            // Third try: diff against HEAD (for new files that are staged)
            const headDiff = execFileSync("git", ["diff", "--no-color", "HEAD", "--", filePath], { cwd, encoding: "utf-8", timeout: 10000, stdio: "pipe" });
            if (headDiff.trim()) {
              diffOutput = headDiff;
            }
          }
        }

        if (!diffOutput.trim()) {
          return { lines: ["No diff available - file may be untracked or unchanged"], rowGroups: [0], logicalLines: ["No diff available - file may be untracked or unchanged"], renderedMarkdown: false };
        }
        const unsafeDiffKind = getUnsafeFileKind(Buffer.from(diffOutput, "utf-8"));
        if (unsafeDiffKind) return unsafeDiffPlaceholder(unsafeDiffKind);
        diffOutput = diffOutput.replace(/\r\n/g, "\n");
        return { ...renderUnifiedDiff(diffOutput, termWidth, theme, wordWrap), renderedMarkdown: false };
      } catch (e: any) {
        return { lines: [`Diff error: ${e.message}`], rowGroups: [0], logicalLines: [`Diff error: ${e.message}`], renderedMarkdown: false };
      }
    }

    if (isMarkdown && renderMarkdown) {
      const markdown = new Markdown(raw, 0, 0, getMarkdownTheme());
      const lines = markdown.render(wordWrap ? termWidth : 10_000).map(line => line.trimEnd());
      return { lines, rowGroups: lines.map((_, index) => index), logicalLines: lines, renderedMarkdown: true };
    }

    const lineNumberWidth = Math.max(4, String(raw.split("\n").length).length);
    const contentWidth = Math.max(1, termWidth - lineNumberWidth - 3);
    const highlighted = highlightCode(raw, getLanguageFromPath(filePath));
    const lines: string[] = [];
    const rowGroups: number[] = [];
    for (const [group, line] of highlighted.entries()) {
      const lineNumber = theme.fg("dim", String(group + 1).padStart(lineNumberWidth));
      const continuation = " ".repeat(lineNumberWidth);
      const wrapped = wordWrap ? wrapTextWithAnsi(line, contentWidth) : [line];
      lines.push(...wrapped.map((segment, segmentIndex) =>
        `${segmentIndex === 0 ? lineNumber : continuation}${theme.fg("borderMuted", " │ ")}${segment}`
      ));
      rowGroups.push(...wrapped.map(() => group));
    }
    return { lines, rowGroups, logicalLines: raw.split("\n"), renderedMarkdown: false };
  } catch (e: any) {
    return { lines: [`Error loading file: ${e.message}`], rowGroups: [0], logicalLines: [`Error loading file: ${e.message}`], renderedMarkdown: false };
  }
}
