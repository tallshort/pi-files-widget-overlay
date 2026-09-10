import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { getResponsivePanelHeight, OVERLAY_MAX_HEIGHT_RATIO } from "../src/constants.ts";
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

async function createChangedFile(): Promise<{ root: string; filePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-files-widget-overlay-"));
  directories.push(root);
  const filePath = join(root, "changed.ts");
  await writeFile(filePath, "export const value = 1;\n");
  await execFile("git", ["init"], { cwd: root });
  await execFile("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFile("git", ["config", "user.name", "Test User"], { cwd: root });
  await execFile("git", ["add", "."], { cwd: root });
  await execFile("git", ["commit", "-m", "initial"], { cwd: root });
  await writeFile(filePath, "export const value = 2;\n");
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
    viewer.handleInput("\r");
    expect(viewer.render(80)[0]).toContain("[1/2]");

    viewer.handleInput("n");
    expect(viewer.render(80)[0]).toContain("[2/2]");

    viewer.handleInput("N");
    expect(viewer.render(80)[0]).toContain("[1/2]");
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

  it("moves by logical lines for page navigation", async () => {
    const lines = ["const wrapped = 'this line is intentionally long enough to wrap';", ...Array.from({ length: 35 }, (_, index) => `const line${index + 1} = ${index + 1};`)];
    const filePath = await createSourceFile(`${lines.join("\n")}\n`);
    const viewer = createViewer({ getRoot: () => tmpdir(), projectCwd: tmpdir() }, theme, () => {});
    viewer.setFile({ name: "many.ts", path: filePath, isDirectory: false });

    viewer.render(24);
    viewer.handleInput("\u001b[6~");
    const highlighted = viewer.render(24).filter(line => line.includes("<selectedBg>"));
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0]).toContain("30 │ const line29");
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
