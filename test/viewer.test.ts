import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getResponsivePanelHeight, OVERLAY_MAX_HEIGHT_RATIO } from "../src/constants.ts";
import { formatCommentMessage } from "../src/comment.ts";
import { loadFileContent } from "../src/file-viewer.ts";
import { createViewer, type CommentPayload } from "../src/viewer.ts";
const execFile = promisify(execFileCallback);

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => text,
} as unknown as Theme;

const directories: string[] = [];

async function createSourceFile(
  content: string | Uint8Array = "const wrapped = 'this line is intentionally long enough to wrap';\nconst next = 1;\n",
  fileName = "wrapped.ts"
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-files-widget-overlay-"));
  directories.push(directory);
  const filePath = join(directory, fileName);
  await writeFile(filePath, content);
  return filePath;
}

async function createChangedFile(
  fileName = "changed.ts",
  initialContent = "export const value = 1;\n",
  changedContent = "export const value = 2;\n"
): Promise<{ root: string; filePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-files-widget-overlay-"));
  directories.push(root);
  const filePath = join(root, fileName);
  await writeFile(filePath, initialContent);
  await execFile("git", ["init"], { cwd: root });
  await execFile("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFile("git", ["config", "user.name", "Test User"], { cwd: root });
  await execFile("git", ["add", "."], { cwd: root });
  await execFile("git", ["commit", "-m", "initial"], { cwd: root });
  await writeFile(filePath, changedContent);
  return { root, filePath };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("file viewer word wrapping", () => {
  it("derives initial and maximum panel heights from terminal rows", () => {
    expect(getResponsivePanelHeight(28, 40, 9, 24)).toBe(11);
    expect(getResponsivePanelHeight(29, 50, 8, 60)).toBe(43);
    expect(getResponsivePanelHeight(50, 50, 8, 24, OVERLAY_MAX_HEIGHT_RATIO)).toBe(14);
    expect(getResponsivePanelHeight(28, 40, 9, 0)).toBe(28);
  });
  it("keeps confirmed searches available to n and N", async () => {
    const filePath = await createSourceFile("needle one\nother\nneedle two\n");
    const viewer = createViewer({ getRoot: () => tmpdir(), projectCwd: tmpdir() }, theme, () => {});
    viewer.setFile({ name: "search.ts", path: filePath, isDirectory: false });

    viewer.handleInput("/");
    viewer.handleInput("needle");
    expect(viewer.render(80)[0]).toContain(CURSOR_MARKER);
    viewer.handleInput("\r");
    expect(viewer.render(80)[0]).toContain("[1/2]");
    viewer.handleInput("n");
    expect(viewer.render(80)[0]).toContain("[2/2]");

    viewer.handleInput("N");
    expect(viewer.render(80)[0]).toContain("[1/2]");

    viewer.handleInput("?");
    expect(viewer.render(100).slice(-2).join("\n")).toContain("j/k/↑/↓: move");
    expect(viewer.render(100).slice(-2).join("\n")).toContain("PgUp/PgDn/Ctrl-U/Ctrl-D: page");
    expect(viewer.render(100).slice(-2).join("\n")).toContain("?: hide");
    expect(viewer.render(100).slice(-2).join("\n")).toContain("q/Esc/←: back");
    viewer.handleInput("?");
    expect(viewer.render(100).at(-1)).toContain("?: help");
    expect(viewer.render(100).at(-1)).toContain("m: raw/render");

    viewer.handleInput("/");
    expect(viewer.render(80)[0]).toContain(`/${CURSOR_MARKER}█`);
    viewer.handleInput("1");
    expect(viewer.render(80).join("\n")).toContain("/1");

    viewer.handleInput("/");
    expect(viewer.render(80)[0]).toContain(`/${CURSOR_MARKER}█`);

    viewer.handleInput("\u001b");
    viewer.handleInput("/");
    viewer.handleInput("\u007f");
    expect(viewer.render(80)[0]).not.toContain(CURSOR_MARKER);
  });

  it("keeps expanded help within the overlay height after growing the viewer", async () => {
    const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    Object.defineProperty(process.stdout, "rows", { configurable: true, value: 40 });
    try {
      const filePath = await createSourceFile();
      const viewer = createViewer({ getRoot: () => tmpdir(), projectCwd: tmpdir() }, theme, () => {});
      viewer.setFile({ name: "height.ts", path: filePath, isDirectory: false });
      viewer.render(100);
      viewer.handleInput("?");
      for (let i = 0; i < 10; i++) viewer.handleInput("=");

      expect(viewer.render(100).length).toBeLessThanOrEqual(34);
    } finally {
      if (rows) Object.defineProperty(process.stdout, "rows", rows);
      else delete (process.stdout as { rows?: number }).rows;
    }
  });
  it("groups every visual row produced by one wrapped source line", async () => {
    const filePath = await createSourceFile();

    const loaded = loadFileContent(filePath, { cwd: tmpdir(), diffMode: false, hasChanges: false, width: 24, renderMarkdown: false, wordWrap: false }, theme);

    expect(loaded.rowGroups).toEqual([0, 1, 2]);

    const wrapped = loadFileContent(filePath, { cwd: tmpdir(), diffMode: false, hasChanges: false, width: 24, renderMarkdown: false, wordWrap: true }, theme);
    expect(wrapped.rowGroups.filter(group => group === 0)).toHaveLength(5);
    expect(wrapped.rowGroups.at(-1)).toBe(2);
  });

  it("shows an image placeholder instead of rendering binary bytes", async () => {
    const filePath = await createSourceFile(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      "demo.png"
    );

    const loaded = loadFileContent(filePath, { cwd: tmpdir(), diffMode: false, hasChanges: false, width: 80, renderMarkdown: false, wordWrap: false }, theme);

    expect(loaded.lines).toEqual([
      "Image preview is unavailable in the overlay (0.0 KiB).",
      "Open the file with an external image viewer instead.",
    ]);
    expect(loaded.logicalLines).toEqual(loaded.lines);
  });

  it.each([
    ["binary", new Uint8Array([0x66, 0x6f, 0x6f, 0x00, 0xff])],
    ["terminal-control", new Uint8Array([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x72, 0x65, 0x64])],
  ])("shows a safe placeholder for $s files", async (kind, content) => {
    const filePath = await createSourceFile(content, `unsafe-${kind}.txt`);

    const loaded = loadFileContent(filePath, { cwd: tmpdir(), diffMode: false, hasChanges: false, width: 80, renderMarkdown: false, wordWrap: false }, theme);

    expect(loaded.lines[0]).toBe(`Preview unavailable: ${kind} file.`);
    expect(loaded.lines.join("\n")).not.toContain("\u001b");
  });
  it("renders valid Unicode text while rejecting C1 control characters", async () => {
    const unicodePath = await createSourceFile("const emoji = '🤖';\nconst punctuation = '“quoted”';\n", "unicode.ts");
    const unicode = loadFileContent(unicodePath, { cwd: tmpdir(), diffMode: false, hasChanges: false, width: 80, renderMarkdown: false, wordWrap: false }, theme);
    expect(unicode.lines.join("\n")).toContain("🤖");

    const controlPath = await createSourceFile(new Uint8Array([0x63, 0xc2, 0x81]), "c1.txt");
    const control = loadFileContent(controlPath, { cwd: tmpdir(), diffMode: false, hasChanges: false, width: 80, renderMarkdown: false, wordWrap: false }, theme);
    expect(control.lines[0]).toBe("Preview unavailable: terminal-control file.");
  });

  it("does not render terminal-control content removed from a Git diff", async () => {
    const { root, filePath } = await createChangedFile("unsafe-diff.txt", "\u001b[31mold\n", "safe\n");
    const loaded = loadFileContent(filePath, { cwd: root, diffMode: true, hasChanges: true, width: 80, renderMarkdown: false, wordWrap: false }, theme);

    expect(loaded.lines).toEqual(["Diff preview unavailable: terminal-control content."]);
    expect(loaded.lines.join("\n")).not.toContain("\u001b");
  });
  it("normalizes CRLF while rejecting a bare carriage return", async () => {
    const crlfPath = await createSourceFile("const first = 1;\r\nconst second = 2;\r\n", "crlf.ts");
    const crlf = loadFileContent(crlfPath, { cwd: tmpdir(), diffMode: false, hasChanges: false, width: 80, renderMarkdown: false, wordWrap: false }, theme);
    expect(crlf.lines.join("\n")).not.toContain("\r");

    const controlPath = await createSourceFile("safe\runsafe\n", "bare-cr.txt");
    const control = loadFileContent(controlPath, { cwd: tmpdir(), diffMode: false, hasChanges: false, width: 80, renderMarkdown: false, wordWrap: false }, theme);
    expect(control.lines[0]).toBe("Preview unavailable: terminal-control file.");
  });

  it("normalizes CRLF Git diff output before rendering", async () => {
    const { root, filePath } = await createChangedFile("crlf-diff.ts", "const first = 1;\r\n", "const first = 2;\r\n");

    const loaded = loadFileContent(filePath, { cwd: root, diffMode: true, hasChanges: true, width: 80, renderMarkdown: false, wordWrap: false }, theme);

    expect(loaded.lines.join("\n")).not.toContain("\r");
    expect(loaded.logicalLines.join("\n")).toContain("const first = 2;");
  });

  it("sanitizes file and diff load errors before rendering", async () => {
    const unsafePath = join(tmpdir(), "missing\u001b[31m-file.ts");
    const fileError = loadFileContent(unsafePath, { cwd: tmpdir(), diffMode: false, hasChanges: false, width: 80, renderMarkdown: false, wordWrap: false }, theme);
    expect(fileError.lines[0]).toContain("Error loading file:");
    expect(fileError.lines[0]).toContain("missing�[31m-file.ts");
    expect(fileError.lines[0]).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);

    const { root, filePath } = await createChangedFile();
    const error = "git failed\u001b[31m\nretry";
    vi.resetModules();
    vi.doMock("node:child_process", async importOriginal => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      return {
        ...actual,
        execFileSync: (_command: string, args: string[]) => {
          if (args[0] === "rev-parse") return "true";
          throw error;
        },
      };
    });
    try {
      const { loadFileContent: loadWithFailedDiff } = await import("../src/file-viewer.ts");
      const diffError = loadWithFailedDiff(filePath, { cwd: root, diffMode: true, hasChanges: true, width: 80, renderMarkdown: false, wordWrap: false }, theme);
      expect(diffError.lines).toEqual(["Diff error: git failed�[31m�retry"]);
      expect(diffError.lines[0]).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("formats primitive file load failures safely", async () => {
    const filePath = await createSourceFile("export const value = true;", "primitive-error.ts");
    vi.resetModules();
    vi.doMock("node:fs", async importOriginal => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return { ...actual, readFileSync: () => { throw "read failed\u001b[31m\nretry"; } };
    });
    try {
      const { loadFileContent: loadWithFailedRead } = await import("../src/file-viewer.ts");
      const fileError = loadWithFailedRead(filePath, { cwd: tmpdir(), diffMode: false, hasChanges: false, width: 80, renderMarkdown: false, wordWrap: false }, theme);
      expect(fileError.lines).toEqual(["Error loading file: read failed�[31m�retry"]);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
  it("keeps non-selectable previews navigable while blocking search, selection, and comments", async () => {
    const filePath = await createSourceFile(new Uint8Array([0x66, 0x6f, 0x6f, 0x00]), "blocked.txt");
    const comments: string[] = [];
    const viewer = createViewer({ getRoot: () => tmpdir(), projectCwd: tmpdir() }, theme, (_payload, comment) => comments.push(comment));
    viewer.setFile({ name: "blocked.txt", path: filePath, isDirectory: false, gitStatus: "M" });
    const fullHeight = viewer.render(80).length;
    expect(viewer.render(80)[0]).toContain("[DIFF]");

    expect(viewer.handleInput("]")).toEqual({ type: "navigate", direction: 1 });
    expect(viewer.handleInput("[")).toEqual({ type: "navigate", direction: -1 });
    viewer.handleInput("d");
    expect(viewer.render(80)[0]).not.toContain("[DIFF]");
    viewer.handleInput("\u001b[6~");
    viewer.handleInput("-");
    expect(viewer.render(80).length).toBeLessThan(fullHeight);
    viewer.handleInput("/");
    viewer.handleInput("v");
    viewer.handleInput("c");
    expect(viewer.render(80)[0]).not.toContain(CURSOR_MARKER);
    expect(comments).toEqual([]);
  });

  it("keeps the comment cursor visible at the content width boundary", async () => {
    const filePath = await createSourceFile("const value = 1;\n");
    const comments: string[] = [];
    const viewer = createViewer({ getRoot: () => tmpdir(), projectCwd: tmpdir() }, theme, (_payload, comment) => comments.push(comment));
    viewer.setFile({ name: "cursor.ts", path: filePath, isDirectory: false });
    viewer.render(12);
    viewer.handleInput("v");
    viewer.handleInput("c");
    for (const character of "123456789") viewer.handleInput(character);

    expect(viewer.render(12).some(line => line.includes(`${CURSOR_MARKER}█`))).toBe(true);
    viewer.handleInput("\u0004");
    expect(comments).toEqual(["123456789"]);
  });

  it("positions the comment cursor after a block character in comment text", async () => {
    const filePath = await createSourceFile("const value = 1;\n");
    const viewer = createViewer({ getRoot: () => tmpdir(), projectCwd: tmpdir() }, theme, () => {});
    viewer.setFile({ name: "cursor.ts", path: filePath, isDirectory: false });
    viewer.render(80);
    viewer.handleInput("v");
    viewer.handleInput("c");
    viewer.handleInput("x█y");
    viewer.handleInput("\u001b[D");

    expect(viewer.render(80).some(line => line.includes(`x█${CURSOR_MARKER}█y`))).toBe(true);
  });

  it("does not highlight a current line in a read-only preview", async () => {
    const filePath = await createSourceFile("const value = 'this preview line is intentionally long enough to wrap';\n");
    const preview = createViewer({ getRoot: () => tmpdir(), projectCwd: tmpdir(), readOnly: true }, theme, () => {});
    preview.setFile({ name: "preview.ts", path: filePath, isDirectory: false });

    const beforeWrap = preview.render(20);
    expect(beforeWrap.some(line => line.includes("<selectedBg>"))).toBe(false);
    expect(preview.handleInput("w")).toEqual({ type: "none" });
    const afterWrap = preview.render(20);
    expect(afterWrap.filter(line => line.includes("│")).length).toBeGreaterThan(beforeWrap.filter(line => line.includes("│")).length);
    expect(preview.handleInput("j")).toEqual({ type: "none" });
  });

  it("allows read-only previews to page and jump without enabling edits", async () => {
    const filePath = await createSourceFile(`${Array.from({ length: 40 }, (_, index) => `const line${index + 1} = ${index + 1};`).join("\n")}\n`);
    const preview = createViewer({ getRoot: () => tmpdir(), projectCwd: tmpdir(), readOnly: true }, theme, () => {});
    preview.setFile({ name: "preview.ts", path: filePath, isDirectory: false });
    preview.render(40);

    preview.handleInput("1");
    preview.handleInput("2");
    preview.handleInput("G");
    expect(preview.render(40).join("\n")).toContain("12 │ const line12 = 12;");

    preview.handleInput("G");
    expect(preview.render(40).join("\n")).toContain("40 │ const line40 = 40;");
    preview.handleInput("\u0015");
    expect(preview.handleInput("v")).toEqual({ type: "none" });
  });

  it("clears a preview jump count when switching files", async () => {
    const lines = `${Array.from({ length: 40 }, (_, index) => `const line${index + 1} = ${index + 1};`).join("\n")}\n`;
    const firstPath = await createSourceFile(lines, "first-preview.ts");
    const secondPath = await createSourceFile(lines, "second-preview.ts");
    const preview = createViewer({ getRoot: () => tmpdir(), projectCwd: tmpdir(), readOnly: true }, theme, () => {});
    preview.setFile({ name: "first-preview.ts", path: firstPath, isDirectory: false });
    preview.render(40);
    preview.handleInput("1");
    preview.handleInput("2");
    preview.setFile({ name: "second-preview.ts", path: secondPath, isDirectory: false });
    preview.render(40);
    preview.handleInput("G");

    expect(preview.render(40).join("\n")).toContain("40 │ const line40 = 40;");
  });

  it("pages the viewport by half a page and keeps the viewer cursor visible", async () => {
    const filePath = await createSourceFile(`${Array.from({ length: 40 }, (_, index) => `const line${index + 1} = ${index + 1};`).join("\n")}\n`);
    const viewer = createViewer({ getRoot: () => tmpdir(), projectCwd: tmpdir() }, theme, () => {});
    viewer.setFile({ name: "many.ts", path: filePath, isDirectory: false });
    viewer.render(80);

    viewer.handleInput("\u001b[6~");
    const paged = viewer.render(80).join("\n");
    expect(paged).toContain("13 │ const line13 = 13;");
    expect(paged).not.toContain("1 │ const line1 = 1;");
    expect(paged).toContain("<selectedBg>  13 │ const line13 = 13;");
  });

  it("pages a read-only preview by half a page without a hidden cursor", async () => {
    const filePath = await createSourceFile(`${Array.from({ length: 40 }, (_, index) => `const line${index + 1} = ${index + 1};`).join("\n")}\n`);
    const preview = createViewer({ getRoot: () => tmpdir(), projectCwd: tmpdir(), readOnly: true }, theme, () => {});
    preview.setFile({ name: "preview.ts", path: filePath, isDirectory: false });
    preview.render(80);

    preview.handleInput("\u001b[6~");
    const paged = preview.render(80).join("\n");
    expect(paged).toContain("13 │ const line13 = 13;");
    expect(paged).not.toContain("1 │ const line1 = 1;");
  });
  it("highlights, navigates, and comments by logical source line", async () => {
    const filePath = await createSourceFile();
    const comments: Array<{ payload: CommentPayload; comment: string }> = [];
    const viewer = createViewer(
      { getRoot: () => tmpdir(), projectCwd: tmpdir() },
      theme,
      (payload, comment) => comments.push({ payload, comment })
    );
    viewer.setFile({ name: "wrapped.ts", path: filePath, isDirectory: false });

    const initial = viewer.render(24).filter(line => line.includes("<selectedBg>"));
    expect(initial).toHaveLength(1);
    expect(viewer.render(24)[0]).toContain("[NO WRAP]");

    viewer.handleInput("w");
    const wrapped = viewer.render(24).filter(line => line.includes("<selectedBg>"));
    expect(wrapped).toHaveLength(5);
    expect(viewer.render(24)[0]).toContain("[WRAP]");

    viewer.handleInput("w");
    expect(viewer.render(24).filter(line => line.includes("<selectedBg>"))).toHaveLength(1);
    viewer.handleInput("j");
    const afterMove = viewer.render(24).filter(line => line.includes("<selectedBg>"));
    expect(afterMove).toHaveLength(1);
    expect(afterMove[0]).toContain("2 │ const next = 1;");

    viewer.handleInput("k");
    viewer.handleInput("v");
    expect(viewer.render(100).at(-1)).toContain("j/k or ↑/↓: extend");
    viewer.handleInput("j");
    const selectionLines = viewer.render(24).filter(line => line.includes("<selectedBg>"));
    expect(selectionLines.join("\n")).toContain("┃");
    expect(selectionLines.join("\n")).toContain("▸");
    viewer.handleInput("c");
    viewer.handleInput("note");
    viewer.handleInput("\u0004");

    expect(comments).toEqual([
      {
        payload: expect.objectContaining({
          lineRange: "lines 1-2",
          selectedText: "const wrapped = 'this line is intentionally long enough to wrap';\nconst next = 1;",
        }),
        comment: "note",
      },
    ]);
  });

  it("normalizes CRLF selected text and range before sending a comment", async () => {
    const filePath = await createSourceFile("const first = 1;\r\nconst second = 2;\r\nconst third = 3;\r\n", "crlf-comment.ts");
    const comments: Array<{ payload: CommentPayload; comment: string }> = [];
    const viewer = createViewer(
      { getRoot: () => tmpdir(), projectCwd: tmpdir() },
      theme,
      (payload, comment) => comments.push({ payload, comment })
    );
    viewer.setFile({ name: "crlf-comment.ts", path: filePath, isDirectory: false });
    viewer.render(80);
    viewer.handleInput("v");
    viewer.handleInput("j");
    viewer.handleInput("c");
    viewer.handleInput("CRLF note");
    viewer.handleInput("\u0004");

    expect(comments).toEqual([
      {
        payload: expect.objectContaining({ lineRange: "lines 1-2", selectedText: "const first = 1;\nconst second = 2;" }),
        comment: "CRLF note",
      },
    ]);
  });

  it("edits comments at the cursor without activating viewer navigation", async () => {
    const filePath = await createSourceFile();
    const comments: string[] = [];
    const viewer = createViewer({ getRoot: () => tmpdir(), projectCwd: tmpdir() }, theme, (_payload, comment) => comments.push(comment));
    viewer.setFile({ name: "comment.ts", path: filePath, isDirectory: false });
    viewer.render(80);

    viewer.handleInput("v");
    viewer.handleInput("c");
    viewer.handleInput("ac");
    viewer.handleInput("\u001b[D");
    viewer.handleInput("b");
    viewer.handleInput("\u0004");

    expect(comments).toEqual(["abc"]);
  });

  it("keeps Unicode graphemes intact while moving the comment cursor", async () => {
    const filePath = await createSourceFile();
    const comments: string[] = [];
    const viewer = createViewer({ getRoot: () => tmpdir(), projectCwd: tmpdir() }, theme, (_payload, comment) => comments.push(comment));
    viewer.setFile({ name: "comment.ts", path: filePath, isDirectory: false });
    viewer.render(80);

    viewer.handleInput("v");
    viewer.handleInput("c");
    viewer.handleInput("a😀c");
    viewer.handleInput("\u001b[D");
    viewer.handleInput("\u001b[D");
    viewer.handleInput("b");
    viewer.handleInput("\u001b[13;3u");

    expect(comments).toEqual(["ab😀c"]);
  });

  it("sends a file-level comment from selection mode", async () => {
    const filePath = await createSourceFile();
    const comments: Array<{ payload: CommentPayload; comment: string }> = [];
    const viewer = createViewer(
      { getRoot: () => dirname(filePath), projectCwd: dirname(filePath) },
      theme,
      (payload, comment) => comments.push({ payload, comment })
    );
    viewer.setFile({ name: "wrapped.ts", path: filePath, isDirectory: false });
    viewer.render(24);
    viewer.handleInput("v");
    expect(viewer.render(80).at(-1)).toContain("C: file comment");
    viewer.handleInput("j");
    viewer.handleInput("C");
    expect(viewer.render(80).join("\n")).toContain("Comment: whole file");
    viewer.handleInput("whole file");
    viewer.handleInput("\u0004");

    expect(comments).toEqual([
      {
        payload: expect.objectContaining({ relPath: "wrapped.ts", lineRange: "file", selectedText: "", isFile: true }),
        comment: "whole file",
      },
    ]);
    expect(formatCommentMessage(comments[0]!.payload, comments[0]!.comment)).toBe("@wrapped.ts: whole file\n");
  });
  it("keeps the logical cursor and comment range after a width change", async () => {
    const filePath = await createSourceFile();
    const comments: Array<{ payload: CommentPayload; comment: string }> = [];
    const viewer = createViewer({ getRoot: () => tmpdir(), projectCwd: tmpdir() }, theme, (payload, comment) => comments.push({ payload, comment }));
    viewer.setFile({ name: "wrapped.ts", path: filePath, isDirectory: false });

    viewer.render(24);
    viewer.handleInput("j");
    const resized = viewer.render(120).filter(line => line.includes("<selectedBg>"));
    expect(resized).toHaveLength(1);
    expect(resized[0]).toContain("2 │ const next = 1;");

    viewer.handleInput("v");
    viewer.handleInput("c");
    viewer.handleInput("note");
    viewer.handleInput("\u0004");
    expect(comments[0]?.payload).toMatchObject({ lineRange: "line 2", selectedText: "const next = 1;" });
  });

  it("scrolls the viewport by rendered rows and keeps the logical cursor visible", async () => {
    const lines = ["const wrapped = 'this line is intentionally long enough to wrap';", ...Array.from({ length: 35 }, (_, index) => `const line${index + 1} = ${index + 1};`)];
    const filePath = await createSourceFile(`${lines.join("\n")}\n`);
    const viewer = createViewer({ getRoot: () => tmpdir(), projectCwd: tmpdir() }, theme, () => {});
    viewer.setFile({ name: "many.ts", path: filePath, isDirectory: false });

    viewer.render(24);
    viewer.handleInput("\u001b[6~");
    const highlighted = viewer.render(24).filter(line => line.includes("<selectedBg>"));
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0]).toContain("9 │ const line8");

    viewer.handleInput("g");
    viewer.handleInput("\u0004");
    expect(viewer.render(24).filter(line => line.includes("<selectedBg>"))[0]).toContain("9 │ const line8");

    viewer.handleInput("\u0015");
    expect(viewer.render(24).filter(line => line.includes("<selectedBg>"))[0]).toContain("9 │ const line8");

    viewer.handleInput("1");
    viewer.handleInput("2");
    viewer.handleInput("G");
    expect(viewer.render(24).filter(line => line.includes("<selectedBg>"))[0]).toContain("12 │ const line11");

    viewer.handleInput("1");
    viewer.handleInput("2");
    const replacementPath = await createSourceFile("const replacement = 1;\nconst final = 2;", "replacement.ts");
    viewer.setFile({ name: "replacement.ts", path: replacementPath, isDirectory: false });
    viewer.render(24);
    viewer.handleInput("G");
    expect(viewer.render(24).filter(line => line.includes("<selectedBg>"))[0]).toContain("2 │ const final = 2;");
  });

  it("loads a diff for a shell-like filename without executing it", async () => {
    const { root, filePath } = await createChangedFile("special $(touch injected).ts");
    const loaded = loadFileContent(filePath, { cwd: root, diffMode: true, hasChanges: true, width: 80, renderMarkdown: false, wordWrap: false }, theme);

    expect(loaded.logicalLines.join("\n")).toContain("export const value = 2;");
    await expect(stat(join(root, "injected"))).rejects.toThrow();
  });

  it("keeps a wrapped diff comment stable across widths", async () => {
    const { root, filePath } = await createChangedFile();
    const ansiTheme = { ...theme, fg: (_color: string, text: string) => `\x1b[38;5;123m${text}\x1b[0m` } as unknown as Theme;
    const wrappedDiff = loadFileContent(filePath, { cwd: root, diffMode: true, hasChanges: true, width: 24, renderMarkdown: false, wordWrap: true }, ansiTheme);
    expect(wrappedDiff.lines.slice(1).some(line => line.includes("\x1b[38;5;123m"))).toBe(true);

    const comments: Array<{ payload: CommentPayload; comment: string }> = [];
    const viewer = createViewer({ getRoot: () => root, projectCwd: root }, theme, (payload, comment) => comments.push({ payload, comment }));
    viewer.setFile({ name: "changed.ts", path: filePath, isDirectory: false, gitStatus: "M" });

    viewer.render(24);
    viewer.handleInput("/");
    viewer.handleInput("value = 2");
    viewer.handleInput("\r");
    expect(viewer.render(24).filter(line => line.includes("<selectedBg>"))[0]).toContain("+");

    viewer.handleInput("\u001b");
    viewer.handleInput("g");
    viewer.handleInput("w");
    viewer.render(24);
    viewer.handleInput("v");
    viewer.handleInput("c");
    viewer.render(120);
    viewer.handleInput("note");
    viewer.handleInput("\u0004");

    expect(comments[0]?.payload).toMatchObject({
      lineRange: "diff lines 1-1",
      selectedText: "- export const value = 1;",
    });
  });

  it("renders and selects staged modifications", async () => {
    const { root, filePath } = await createChangedFile();
    await execFile("git", ["add", "changed.ts"], { cwd: root });
    const comments: Array<{ payload: CommentPayload; comment: string }> = [];
    const viewer = createViewer({ getRoot: () => root, projectCwd: root }, theme, (payload, comment) => comments.push({ payload, comment }));
    viewer.setFile({ name: "changed.ts", path: filePath, isDirectory: false, gitStatus: "M" });

    expect(viewer.render(80).join("\n")).toMatch(/\+ \d+ │ export const value = 2;/);
    viewer.handleInput("v");
    viewer.handleInput("c");
    viewer.handleInput("staged note");
    viewer.handleInput("\u0004");

    expect(comments[0]?.payload).toMatchObject({
      lineRange: "diff lines 1-1",
      selectedText: "- export const value = 1;",
    });
  });

  it("renders staged-added files and keeps untracked files in normal view", async () => {
    const { root } = await createChangedFile();
    const stagedPath = join(root, "added.ts");
    await writeFile(stagedPath, "export const added = true;\n");
    await execFile("git", ["add", "added.ts"], { cwd: root });

    const staged = loadFileContent(stagedPath, { cwd: root, diffMode: true, hasChanges: true, width: 80, renderMarkdown: false, wordWrap: false }, theme);
    expect(staged.lines.join("\n")).toMatch(/\+ \d+ │ export const added = true;/);

    const untrackedPath = join(root, "untracked.ts");
    await writeFile(untrackedPath, "export const untracked = true;\n");
    const viewer = createViewer({ getRoot: () => root, projectCwd: root }, theme, () => {});
    viewer.setFile({ name: "untracked.ts", path: untrackedPath, isDirectory: false, gitStatus: "??" });
    expect(viewer.render(80).join("\n")).toContain("1 │ export const untracked = true;");
  });

  it("prefers an unstaged diff when a file also has staged changes", async () => {
    const { root, filePath } = await createChangedFile();
    await execFile("git", ["add", "changed.ts"], { cwd: root });
    await writeFile(filePath, "export const value = 3;\n");

    const loaded = loadFileContent(filePath, { cwd: root, diffMode: true, hasChanges: true, width: 80, renderMarkdown: false, wordWrap: false }, theme);
    const rendered = loaded.lines.join("\n");
    expect(rendered).toMatch(/- \d+ │ export const value = 2;/);
    expect(rendered).toMatch(/\+ \d+ │ export const value = 3;/);
    expect(rendered).not.toContain("export const value = 1;");
  });

  it("keeps the current rendered Markdown paragraph anchored across a width change", async () => {
    const filePath = await createSourceFile(
      "# Title\n\nThis paragraph contains a distinctive anchor phrase that should remain visible after the terminal becomes wider.\n\nAnother paragraph.\n",
      "README.md"
    );
    const viewer = createViewer({ getRoot: () => tmpdir(), projectCwd: tmpdir() }, theme, () => {});
    viewer.setFile({ name: "README.md", path: filePath, isDirectory: false });
    initTheme();
    viewer.render(24);
    viewer.handleInput("w");

    let selected = "";
    for (let index = 0; index < 10; index++) {
      selected = viewer.render(24).find(line => line.includes("<selectedBg>")) ?? "";
      if (selected.includes("distinctive")) break;
      viewer.handleInput("j");
    }
    expect(selected).toContain("distinctive");

    const resized = viewer.render(80).find(line => line.includes("<selectedBg>")) ?? "";
    expect(resized).toContain("terminal becomes wider");
  });

  it("keeps the current rendered Markdown paragraph when the terminal narrows", async () => {
    const filePath = await createSourceFile(
      "# Title\n\nThis paragraph contains a distinctive anchor phrase that should remain visible after the terminal becomes narrower.\n\nAnother paragraph.\n",
      "README.md"
    );
    const viewer = createViewer({ getRoot: () => tmpdir(), projectCwd: tmpdir() }, theme, () => {});
    viewer.setFile({ name: "README.md", path: filePath, isDirectory: false });
    initTheme();
    viewer.render(80);
    viewer.handleInput("w");

    let selected = "";
    for (let index = 0; index < 10; index++) {
      selected = viewer.render(80).find(line => line.includes("<selectedBg>")) ?? "";
      if (selected.includes("distinctive")) break;
      viewer.handleInput("j");
    }
    expect(selected).toContain("distinctive");

    const narrowed = viewer.render(24).find(line => line.includes("<selectedBg>")) ?? "";
    expect(narrowed).toContain("This paragraph");
  });
  it("resets rendered Markdown to the top when an anchor is ambiguous", async () => {
    const filePath = await createSourceFile(
      "# Title\n\nRepeated paragraph text.\n\nRepeated paragraph text.\n",
      "README.md"
    );
    const viewer = createViewer({ getRoot: () => tmpdir(), projectCwd: tmpdir() }, theme, () => {});
    viewer.setFile({ name: "README.md", path: filePath, isDirectory: false });
    initTheme();
    viewer.render(24);
    viewer.handleInput("w");

    let repeatedRows = 0;
    for (let index = 0; index < 12; index++) {
      const selected = viewer.render(24).find(line => line.includes("<selectedBg>")) ?? "";
      if (selected.includes("Repeated paragraph text.")) repeatedRows++;
      if (repeatedRows === 2) break;
      viewer.handleInput("j");
    }
    expect(repeatedRows).toBe(2);

    const resized = viewer.render(80);
    const selected = resized.find(line => line.includes("<selectedBg>")) ?? "";
    expect(selected.replace(/\x1b\[[0-?]*[ -/]*[@-~]|<\/?selectedBg>/g, "")).toContain("Title");
  });
  it("resets rendered Markdown to the top when its anchor no longer exists", async () => {
    const filePath = await createSourceFile(
      "# Title\n\nThis paragraph contains a distinctive anchor phrase.\n",
      "README.md"
    );
    const viewer = createViewer({ getRoot: () => tmpdir(), projectCwd: tmpdir() }, theme, () => {});
    viewer.setFile({ name: "README.md", path: filePath, isDirectory: false });
    initTheme();
    viewer.render(24);
    viewer.handleInput("w");
    viewer.handleInput("j");
    await writeFile(filePath, "# Replacement\n\nNew paragraph.\n");

    const resized = viewer.render(80);
    expect(resized.join("\n")).toContain("Replacement");
    const selected = resized.find(line => line.includes("<selectedBg>")) ?? "";
    expect(selected.replace(/<\/?selectedBg>/g, "").trim()).toBe("");
  });

  it("resets rendered Markdown selection to a source-aligned raw line", async () => {
    const filePath = await createSourceFile("# Title\n\nThis paragraph is deliberately long enough to wrap when rendered in a narrow viewer.\n", "README.md");
    const comments: Array<{ payload: CommentPayload; comment: string }> = [];
    const viewer = createViewer({ getRoot: () => tmpdir(), projectCwd: tmpdir() }, theme, (payload, comment) => comments.push({ payload, comment }));
    viewer.setFile({ name: "README.md", path: filePath, isDirectory: false });
    initTheme();
    const noWrap = loadFileContent(filePath, { cwd: tmpdir(), diffMode: false, hasChanges: false, width: 24, renderMarkdown: true, wordWrap: false }, theme);
    const wrapped = loadFileContent(filePath, { cwd: tmpdir(), diffMode: false, hasChanges: false, width: 24, renderMarkdown: true, wordWrap: true }, theme);
    expect(wrapped.lines.length).toBeGreaterThan(noWrap.lines.length);
    expect(noWrap.lines.every(line => !line.endsWith(" "))).toBe(true);

    const noWrapView = viewer.render(80);
    expect(noWrapView[0]).toContain("[NO WRAP]");
    expect(noWrapView.filter(line => line.includes("This paragraph")).length).toBe(1);

    const narrowNoWrapView = viewer.render(24);
    expect(narrowNoWrapView.some(line => line.includes("..."))).toBe(true);
    viewer.handleInput("w");
    const wrappedView = viewer.render(24);
    expect(wrappedView.filter(line => /This paragraph|deliberately long|enough to wrap|rendered in a|narrow viewer/.test(line)).length).toBeGreaterThan(1);
    expect(viewer.render(80)[0]).toContain("[WRAP]");
    expect(viewer.render(48)[0]).toContain("[WRAP]");
    viewer.handleInput("j");
    viewer.handleInput("v");
    expect(viewer.render(24)[0]).toContain("[RAW]");
    viewer.handleInput("c");
    viewer.handleInput("note");
    viewer.handleInput("\u0004");

    expect(comments[0]?.payload).toMatchObject({ lineRange: "line 1", selectedText: "# Title" });
  });
});
