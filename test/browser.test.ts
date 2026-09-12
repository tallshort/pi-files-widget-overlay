import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { createFileBrowser } from "../src/browser.ts";
import { getGitBranchAsync, getGitDiffStats, getGitDiffStatsAsync, getGitFileList, getGitFileListAsync, getGitStatus, getGitStatusAsync } from "../src/git.ts";
import { resolveRestoredPosition } from "../src/index.ts";

const execFile = promisify(execFileCallback);
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const directories: string[] = [];

async function createChangedRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-files-widget-overlay-"));
  directories.push(directory);
  await mkdir(join(directory, "src", "nested"), { recursive: true });
  await mkdir(join(directory, "deep", "a", "b", "c", "d", "e", "f", "g"), { recursive: true });
  await mkdir(join(directory, ".pi"), { recursive: true });
  await writeFile(join(directory, "src", "nested", "changed.ts"), "export const value = 1;\n");
  await writeFile(join(directory, "src", "nested", "unchanged.ts"), "export const stable = true;\n");
  await writeFile(join(directory, "unchanged.ts"), "export const stable = true;\n");
  await writeFile(join(directory, "deep", "a", "b", "c", "d", "e", "f", "g", "leaf.ts"), "export const deep = true;\n");
  await execFile("git", ["init"], { cwd: directory });
  await execFile("git", ["config", "user.email", "test@example.com"], { cwd: directory });
  await execFile("git", ["config", "user.name", "Test User"], { cwd: directory });
  await execFile("git", ["add", "."], { cwd: directory });
  await execFile("git", ["commit", "-m", "initial"], { cwd: directory });
  await writeFile(join(directory, "src", "nested", "changed.ts"), "export const value = 2;\n");
  await writeFile(join(directory, ".pi", "settings.json"), "{}\n");
  return directory;
}

async function createNestedRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-files-widget-overlay-"));
  directories.push(directory);
  await mkdir(join(directory, "parent", "nested"), { recursive: true });
  await writeFile(join(directory, "parent", "nested", "leaf.ts"), "export const leaf = true;\n");
  await execFile("git", ["init"], { cwd: directory });
  await execFile("git", ["config", "user.email", "test@example.com"], { cwd: directory });
  await execFile("git", ["config", "user.name", "Test User"], { cwd: directory });
  await execFile("git", ["add", "."], { cwd: directory });
  await execFile("git", ["commit", "-m", "initial"], { cwd: directory });
  return directory;
}

function waitForBackgroundWork(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 75));
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for browser state");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("file browser expanded changed view", () => {
  it("toggles the expanded changed view with C", async () => {
    const root = await createChangedRepository();
    const browser = createFileBrowser(root, new Set(), theme, () => {}, () => {}, () => {});
    await waitForBackgroundWork();
    browser.handleInput("C");
    const rendered = browser.render(100).join("\n");

    expect(rendered).toContain("changed.ts");
    expect(rendered).not.toContain("unchanged.ts");

    browser.handleInput("C");
    expect(browser.render(100).join("\n")).toContain("unchanged.ts");
  });

  it("keeps top-level directories with only deep tracked paths", async () => {
    const root = await createChangedRepository();
    const browser = createFileBrowser(root, new Set(), theme, () => {}, () => {}, () => {});
    await waitForBackgroundWork();
    expect(browser.render(100).join("\n")).toContain("deep");
  });

  it("fills the selected row and uses the text theme token", async () => {
    const root = await createChangedRepository();
    const colors: string[] = [];
    const visualTheme = {
      fg: (color: string, text: string) => {
        colors.push(color);
        return text;
      },
      bg: (_color: string, text: string) => `<selectedBg>${text}</selectedBg>`,
      bold: (text: string) => text,
    } as unknown as Theme;
    const browser = createFileBrowser(root, new Set(), visualTheme, () => {}, () => {}, () => {});
    await waitForBackgroundWork();
    const selected = browser.render(60).find(line => line.includes("<selectedBg>")) ?? "";
    expect(selected.replace(/<\/?selectedBg>/g, "")).toHaveLength(60);
    expect(colors).toContain("text");
  });

  it("keeps Git status visible when a narrow browser truncates names", async () => {
    const root = await createChangedRepository();
    const browser = createFileBrowser(root, new Set(), theme, () => {}, () => {}, () => {});
    await waitForBackgroundWork();
    browser.handleInput("C");
    expect(browser.render(12).join("\n")).toContain(" M");
  });
  it("uses stable labels for background activity", async () => {
    const root = await createChangedRepository();
    const browser = createFileBrowser(root, new Set(), theme, () => {}, () => {}, () => {});
    await waitForBackgroundWork();
    const rendered = browser.render(100).join("\n");
    expect(browser.getActivityLabel()).toBe("");
    expect(rendered).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });

  it("marks files modified by the current agent session with a robot", async () => {
    const root = await createChangedRepository();
    const browser = createFileBrowser(root, new Set([join(root, "unchanged.ts")]), theme, () => {}, () => {}, () => {});
    await waitForBackgroundWork();
    expect(browser.render(100).join("\n")).toContain("🤖");
  });

  it("exposes the root path for the overlay title", async () => {
    const root = await createChangedRepository();
    const browser = createFileBrowser(root, new Set(), theme, () => {}, () => {}, () => {});

    expect(browser.getRootPath()).toBe(root);
  });

  it("cancels an empty browser search with backspace", async () => {
    const root = await createChangedRepository();
    const browser = createFileBrowser(root, new Set(), theme, () => {}, () => {}, () => {});

    browser.handleInput("/");
    browser.handleInput("\u007f");

    expect(browser.render(100).join("\n")).not.toContain(CURSOR_MARKER);
  });

  it("closes the browser on q or Escape", async () => {
    const root = await createChangedRepository();
    let closes = 0;
    const createBrowser = () => createFileBrowser(root, new Set(), theme, () => { closes += 1; }, () => {}, () => {});

    createBrowser().handleInput("q");
    createBrowser().handleInput("\u001b");

    expect(closes).toBe(2);
  });
  it("restores a recorded file selection in its directory", async () => {
    const root = await createChangedRepository();
    const selectedFile = join(root, "unchanged.ts");
    const browser = createFileBrowser(root, new Set(), theme, () => {}, () => {}, () => {}, root, selectedFile);

    await waitForBackgroundWork();

    expect(browser.getBrowsePosition()).toEqual({
      rootPath: root,
      directoryPath: root,
      selectedFilePath: selectedFile,
    });
  });

  it("falls back safely when a recorded browse position becomes invalid", async () => {
    const root = await createChangedRepository();
    const fallback = await mkdtemp(join(tmpdir(), "pi-files-widget-overlay-fallback-"));
    directories.push(fallback);
    const directory = join(root, "restored");
    const selectedFile = join(directory, "selected.ts");
    await mkdir(directory);
    await writeFile(selectedFile, "export const selected = true;\n");
    const position = { rootPath: root, directoryPath: directory, selectedFilePath: selectedFile };

    expect(resolveRestoredPosition(fallback, position)).toEqual({ path: directory, selectedFilePath: selectedFile });
    await rm(selectedFile);
    expect(resolveRestoredPosition(fallback, position)).toEqual({ path: directory });
    await rm(directory, { recursive: true });
    expect(resolveRestoredPosition(fallback, position)).toEqual({ path: fallback });
  });

  it("shows the active browser search query", async () => {
    const root = await createChangedRepository();
    const browser = createFileBrowser(root, new Set(), theme, () => {}, () => {}, () => {});

    browser.handleInput("/");
    browser.handleInput("changed");

    const rendered = browser.render(100).join("\n");
    expect(rendered).toContain("/changed");
    expect(rendered).toContain(CURSOR_MARKER);

    browser.handleInput("/");
    const cleared = browser.render(100).join("\n");
    expect(cleared).not.toContain("/changed");
    expect(cleared).toContain(`/${CURSOR_MARKER}█`);
  });

  it("shows a read-only preview on wide terminals and falls back on narrow terminals", async () => {
    const root = await createChangedRepository();
    const browser = createFileBrowser(root, new Set(), theme, () => {}, () => {}, () => {});
    await waitForBackgroundWork();
    const wide = browser.render(100);
    expect(wide.join("\n")).toContain("Directory selected - expand it in the file tree instead of opening it.");
    expect(wide.some(line => line.includes("│"))).toBe(true);
    expect(wide.at(-1)).toContain("c/C: changes");
    expect(wide.at(-1)).toContain("[]: prev/next change");
    expect(wide.at(-1)).toContain("?: help");
    expect(wide.at(-1)).not.toContain("│");
    browser.handleInput("?");
    const fullHelp = browser.render(100).slice(-2).join("\n");
    expect(fullHelp).toContain("h/l←→: folder");
    expect(fullHelp).toContain("c: changed only");
    expect(fullHelp).toContain("?: hide");
    expect(fullHelp).toContain("q/Esc: close");
    const narrowHelp = browser.render(24).filter(line => line.includes("h/l") || line.includes("[]:"));
    expect(narrowHelp).toHaveLength(2);
    expect(narrowHelp.every(line => visibleWidth(line) <= 24)).toBe(true);
    browser.handleInput("?");
    expect(browser.render(100).at(-1)).toContain("?: help");

    browser.handleInput("p");
    expect(browser.render(100).some(line => line.includes("│"))).toBe(false);
    const beforePaging = browser.render(100).find(line => /\d+\/\d+ \(\d+%\)/.test(line));
    browser.handleInput("\u001b[6~");
    expect(browser.render(100).find(line => /\d+\/\d+ \(\d+%\)/.test(line))).not.toBe(beforePaging);
    browser.handleInput("p");
    expect(browser.render(100).some(line => line.includes("│"))).toBe(true);

    expect(browser.render(79).some(line => line.includes("│"))).toBe(false);
    browser.handleInput("p");
    expect(browser.render(79).some(line => line.includes("│"))).toBe(false);
  });

  it("keeps expanded help within the overlay height after growing the browser", async () => {
    const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    Object.defineProperty(process.stdout, "rows", { configurable: true, value: 40 });
    try {
      const root = await createChangedRepository();
      const browser = createFileBrowser(root, new Set(), theme, () => {}, () => {}, () => {});
      await waitForBackgroundWork();
      browser.render(100);
      browser.handleInput("?");
      for (let i = 0; i < 10; i++) browser.handleInput("=");

      expect(browser.render(100).length).toBeLessThanOrEqual(34);
    } finally {
      if (rows) Object.defineProperty(process.stdout, "rows", rows);
      else delete (process.stdout as { rows?: number }).rows;
    }
  });
  it("shows hidden project files while keeping .git internal", async () => {
    const root = await createChangedRepository();
    const browser = createFileBrowser(root, new Set(), theme, () => {}, () => {}, () => {});
    await waitForBackgroundWork();
    const rendered = browser.render(100).join("\n");

    expect(rendered).toContain(".pi");
    expect(rendered).not.toContain(".git");
    const status = getGitStatus(root);
    expect(status.get(".pi")).toBe("??");
    expect(status.has(".pi/")).toBe(false);
  });

  it("preserves special paths and rename destinations in Git metadata", async () => {
    const root = await createChangedRepository();
    const oldPath = join(root, "src", "old $(unsafe).ts");
    await writeFile(oldPath, "export const renamed = true;\n");
    await execFile("git", ["add", "--", "src/old $(unsafe).ts"], { cwd: root });
    await execFile("git", ["commit", "-m", "add special path"], { cwd: root });
    await execFile("git", ["mv", "--", "src/old $(unsafe).ts", "src/new name [renamed].ts"], { cwd: root });

    expect(getGitStatus(root).get("src/new name [renamed].ts")).toBe("R");
    expect(getGitFileList(root)).toContain("src/new name [renamed].ts");
    expect(getGitDiffStats(root).get("src/new name [renamed].ts")).toEqual({ additions: 0, deletions: 0 });

    const [statusResult, diffStatsResult] = await Promise.all([getGitStatusAsync(root), getGitDiffStatsAsync(root)]);
    expect(statusResult.status.get("src/new name [renamed].ts")).toBe("R");
    expect(diffStatsResult.stats.get("src/new name [renamed].ts")).toEqual({ additions: 0, deletions: 0 });
  });

  it("does not double-count staged diff statistics", async () => {
    const root = await createChangedRepository();
    await execFile("git", ["add", "--", "src/nested/changed.ts"], { cwd: root });
    await writeFile(join(root, "src", "nested", "changed.ts"), "export const value = 3;\n");
    expect(getGitDiffStats(root).get("src/nested/changed.ts")).toEqual({ additions: 1, deletions: 1 });
    const result = await getGitDiffStatsAsync(root);
    expect(result.stats.get("src/nested/changed.ts")).toEqual({ additions: 1, deletions: 1 });
  });

  it("loads Git metadata asynchronously", async () => {
    const root = await createChangedRepository();
    await mkdir(join(root, "untracked", "deep"), { recursive: true });
    await writeFile(join(root, "untracked", "deep", "file.ts"), "export const untracked = true;\n");
    const [statusResult, diffStatsResult, branch, fileListResult] = await Promise.all([
      getGitStatusAsync(root, { includeUntracked: true }),
      getGitDiffStatsAsync(root),
      getGitBranchAsync(root),
      getGitFileListAsync(root),
    ]);

    expect(statusResult).toMatchObject({ failed: false });
    expect(statusResult.status.get("src/nested/changed.ts")).toBe("M");
    expect(statusResult.status.get("untracked/deep/file.ts")).toBe("??");
    expect(diffStatsResult).toMatchObject({ failed: false });
    expect(diffStatsResult.stats.get("src/nested/changed.ts")).toEqual({ additions: 1, deletions: 1 });
    expect(branch).not.toBe("");
    expect(fileListResult).toMatchObject({ failed: false });
    expect(fileListResult.files).toContain("untracked/deep/file.ts");
  });

  it("keeps Git metadata paths relative to a repository subdirectory", async () => {
    const root = await createChangedRepository();
    const subdirectory = join(root, "src");

    expect(getGitFileList(subdirectory)).toContain("nested/changed.ts");
    expect(getGitStatus(subdirectory).get("nested/changed.ts")).toBe("M");
    expect(getGitDiffStats(subdirectory).get("nested/changed.ts")).toEqual({ additions: 1, deletions: 1 });
  });

  it("discards scans queued for a previous root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-files-widget-overlay-"));
    directories.push(parent);
    const oldRoot = join(parent, "old");
    await mkdir(oldRoot);
    await writeFile(join(oldRoot, "stale.ts"), "export const stale = true;\n");
    await writeFile(join(parent, "fresh.ts"), "export const fresh = true;\n");
    const browser = createFileBrowser(oldRoot, new Set(), theme, () => {}, () => {}, () => {});

    browser.handleInput("u");
    await rm(oldRoot, { recursive: true, force: true });
    await waitForBackgroundWork();

    const rendered = browser.render(100).join("\n");
    expect(rendered).toContain("fresh.ts");
    expect(rendered).not.toContain("stale.ts");
  });

  it("terminates ancestor symlink cycles", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-files-widget-overlay-"));
    directories.push(root);
    await symlink(".", join(root, "loop"), "dir");
    const browser = createFileBrowser(root, new Set(), theme, () => {}, () => {}, () => {});

    await waitForBackgroundWork();
    expect(browser.render(100).join("\n")).toContain("loop");
    browser.handleInput("l");
    await waitForBackgroundWork();
    expect(browser.render(100).join("\n")).toContain("loop");
  });

  it("enters first children with right input and collapses parents with left input", async () => {
    const root = await createNestedRepository();
    const browser = createFileBrowser(root, new Set(), theme, () => {}, () => {}, () => {});
    await waitForBackgroundWork();
    browser.handleInput("l");
    browser.handleInput("l");
    browser.handleInput("h");
    expect(browser.render(100).join("\n")).not.toContain("leaf.ts");

    browser.handleInput("h");
    expect(browser.render(100).join("\n")).not.toContain("nested");
  });

  it("keeps only the latest asynchronous Git re-root result", async () => {
    const root = await createChangedRepository();
    const browser = createFileBrowser(join(root, "src", "nested"), new Set(), theme, () => {}, () => {}, () => {});
    await waitForBackgroundWork();

    browser.handleInput("u");
    browser.handleInput("u");
    expect(browser.render(100).join("\n")).toContain("(loading...)");
    await waitForBackgroundWork();

    const rendered = browser.render(100).join("\n");
    expect(browser.getRootPath()).toBe(root);
    expect(rendered).toContain("deep");
    expect(rendered).toContain("changed.ts");
  });
  it("filters files by content with @", async () => {
    const root = await createChangedRepository();
    const browser = createFileBrowser(root, new Set(), theme, () => {}, () => {}, () => {});
    await waitForBackgroundWork();

    browser.handleInput("@");
    for (const character of "value = 2") browser.handleInput(character);
    browser.handleInput("\r");
    await waitFor(() => {
      const rendered = browser.render(100).join("\n");
      return rendered.includes("changed.ts") && !rendered.includes("unchanged.ts");
    });

    const rendered = browser.render(100).join("\n");
    expect(rendered).toContain("changed.ts");
    expect(rendered).not.toContain("unchanged.ts");
  });

  it("shares changed-only state between c and C", async () => {
    const root = await createChangedRepository();
    const browser = createFileBrowser(root, new Set(), theme, () => {}, () => {}, () => {});
    await waitForBackgroundWork();
    browser.handleInput("c");
    expect(browser.render(100).join("\n")).not.toContain("unchanged.ts");

    browser.handleInput("C");
    expect(browser.render(100).join("\n")).toContain("changed.ts");

    browser.handleInput("c");
    expect(browser.render(100).join("\n")).not.toContain("unchanged.ts");

    browser.handleInput("c");
    expect(browser.render(100).join("\n")).toContain("unchanged.ts");

    browser.handleInput("c");
    browser.handleInput("C");
    browser.handleInput("C");
    expect(browser.render(100).join("\n")).toContain("unchanged.ts");
  });
});
