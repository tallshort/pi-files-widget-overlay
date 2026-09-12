import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { copyToClipboard, type Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", async importOriginal => ({
  ...await importOriginal<typeof import("@earendil-works/pi-coding-agent")>(),
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
}));
import { createFileBrowser } from "../src/browser.ts";
import { getGitBranchAsync, getGitDiffStats, getGitDiffStatsAsync, getGitFileList, getGitFileListAsync, getGitStatus, getGitStatusAsync } from "../src/git.ts";
import { getOverlayPathWidths, readRestoreBrowsePositionSetting, resolveRestoredPosition, sanitizeRestorePathLabel } from "../src/index.ts";

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
async function removeDirectoryWithRetry(directory: string): Promise<void> {
  // `git status` refreshes its index via a short-lived lock. Browser instances
  // intentionally load Git metadata in the background, so CI can reach cleanup
  // while that lock is still being removed on Linux.
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 0 });
      return;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" || attempt === 9) throw error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeDirectoryWithRetry));
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
  it("copies the selected directory path", async () => {
    const root = await createChangedRepository();
    const browser = createFileBrowser(root, new Set(), theme, () => {}, () => {}, () => {});
    await waitForBackgroundWork();

    browser.handleInput("y");
    await Promise.resolve();
    expect(copyToClipboard).toHaveBeenCalledWith(browser.getBrowsePosition().directoryPath);
    expect(browser.isPathCopied()).toBe(true);
  });

  it("shows the path-copy shortcut in the default browser help", async () => {
    const root = await createChangedRepository();
    const browser = createFileBrowser(root, new Set(), theme, () => {}, () => {}, () => {});
    await waitForBackgroundWork();

    const help = browser.render(160).at(-1) ?? "";
    expect(help).toContain("y: copy path");
    expect(help).not.toContain("q: close");
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
    await waitFor(() => browser.render(80).join("\n").includes("changed.ts"));
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
  it("preserves a provisional selection, expansions, and open viewer when Git publishes its tree", async () => {
    vi.resetModules();
    vi.doMock("../src/git.ts", async importOriginal => {
      const actual = await importOriginal<typeof import("../src/git.ts")>();
      return {
        ...actual,
        getGitFileListAsync: async (cwd: string) => {
          const result = await actual.getGitFileListAsync(cwd);
          await new Promise(resolve => setTimeout(resolve, 100));
          return result;
        },
      };
    });
    try {
      const { createFileBrowser: createDelayedGitBrowser } = await import("../src/browser.ts");
      const root = await createChangedRepository();
      const selectedFile = join(root, "src", "nested", "changed.ts");
      const browser = createDelayedGitBrowser(root, new Set(), theme, () => {}, () => {}, () => {}, root, selectedFile);

      await waitFor(() => browser.getBrowsePosition().selectedFilePath === selectedFile);
      browser.handleInput("\r");
      await waitFor(() => browser.render(100).join("\n").includes("export const value = 2"));
      await waitForBackgroundWork();

      expect(browser.getBrowsePosition().selectedFilePath).toBe(selectedFile);
      expect(browser.render(100).join("\n")).toContain("export const value = 2");
    } finally {
      vi.doUnmock("../src/git.ts");
      vi.resetModules();
    }
  });
  it("keeps the provisional tree when the status half of the Git listing fails", async () => {
    vi.resetModules();
    vi.doMock("../src/git.ts", async importOriginal => {
      const actual = await importOriginal<typeof import("../src/git.ts")>();
      return {
        ...actual,
        getGitFileListAsync: async () => ({ files: [], failed: true, trackedFailed: false, statusFailed: true }),
      };
    });
    try {
      const { createFileBrowser: createFailedStatusBrowser } = await import("../src/browser.ts");
      const root = await createChangedRepository();
      const browser = createFailedStatusBrowser(root, new Set(), theme, () => {}, () => {}, () => {});

      await waitFor(() => browser.render(100).join("\n").includes("unchanged.ts"));
      expect(browser.render(100).join("\n")).toContain("changed.ts");
    } finally {
      vi.doUnmock("../src/git.ts");
      vi.resetModules();
    }
  });

  it("keeps a restored empty directory after Git replaces the provisional tree", async () => {
    const root = await createChangedRepository();
    const emptyDirectory = join(root, "empty");
    await mkdir(emptyDirectory);
    const browser = createFileBrowser(root, new Set(), theme, () => {}, () => {}, () => {}, root, undefined, emptyDirectory);

    await waitFor(() => browser.getBrowsePosition().directoryPath === emptyDirectory);
    expect(browser.getRestorePath()).toBe("empty");
  });

  it("reads browse-position restoration only from the explicit global opt-in", async () => {
    const settingsDirectory = await mkdtemp(join(tmpdir(), "pi-files-widget-overlay-settings-"));
    directories.push(settingsDirectory);
    const settings = join(settingsDirectory, "settings.json");
    await writeFile(settings, JSON.stringify({ piFilesWidgetOverlay: { restoreBrowsePosition: true } }));
    expect(readRestoreBrowsePositionSetting(settings)).toBe(true);
    await writeFile(settings, JSON.stringify({ piFilesWidgetOverlay: { restoreBrowsePosition: "true" } }));
    expect(readRestoreBrowsePositionSetting(settings)).toBe(false);
    await writeFile(settings, "not JSON");
    expect(readRestoreBrowsePositionSetting(settings)).toBe(false);
  });

  it("sanitizes restore labels and reserves header room for scanning", () => {
    expect(sanitizeRestorePathLabel("safe\u001b[31mname")).toBe("safe�[31mname");
    expect(getOverlayPathWidths(40, 10, "… scanning", true)).toEqual({ availableWidth: 18, rootWidth: 9 });
    expect(getOverlayPathWidths(40, 10, " Path copied", false).availableWidth).toBeLessThan(getOverlayPathWidths(40, 10, "", false).availableWidth);
  });
  it("sanitizes control characters in filesystem labels without changing the opened path", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-files-widget-overlay-"));
    directories.push(root);
    const unsafeName = "unsafe\u001b[31m\nname.ts";
    await writeFile(join(root, unsafeName), "export const safe = true;\n");
    const browser = createFileBrowser(root, new Set(), theme, () => {}, () => {}, () => {});

    await waitFor(() => browser.render(60).join("\n").includes("unsafe�[31m�name.ts"));
    const rendered = browser.render(60);
    const label = rendered.find(line => line.includes("unsafe")) ?? "";
    expect(label).not.toContain("\u001b");
    expect(label).not.toContain("\n");

    browser.handleInput("\r");
    expect(browser.render(60).join("\n")).toContain("export const safe = true;");
  });
  it("sanitizes scan errors that include a directory name", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-files-widget-overlay-"));
    directories.push(root);
    const unsafeName = "blocked\u001b[31m-directory";
    const blocked = join(root, unsafeName);
    await mkdir(blocked);
    vi.resetModules();
    vi.doMock("node:fs/promises", async importOriginal => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        readdir: async (path: string, options: { withFileTypes: true }) => {
          if (String(path).includes("blocked")) throw new Error("unavailable");
          return actual.readdir(path, options);
        },
      };
    });
    try {
      const { createFileBrowser: createBrowserWithFailedScan } = await import("../src/browser.ts");
      const browser = createBrowserWithFailedScan(root, new Set(), theme, () => {}, () => {}, () => {});
      await waitFor(() => browser.render(100).join("\n").includes("blocked�[31m-directory"));
      browser.handleInput("\r");
      await waitFor(() => browser.render(100).join("\n").includes("Unable to scan"));
      expect(browser.render(100).join("\n")).not.toContain("\u001b[31m");
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("keeps the provisional tree and applies status when tracked Git listing fails", async () => {
    vi.resetModules();
    vi.doMock("../src/git.ts", async importOriginal => {
      const actual = await importOriginal<typeof import("../src/git.ts")>();
      return {
        ...actual,
        getGitFileListAsync: async () => ({ files: [], failed: true, trackedFailed: true, statusFailed: false }),
      };
    });
    try {
      const { createFileBrowser: createFailedListBrowser } = await import("../src/browser.ts");
      const root = await createChangedRepository();
      const browser = createFailedListBrowser(root, new Set(), theme, () => {}, () => {}, () => {});

      await waitFor(() => {
        const rendered = browser.render(100).join("\n");
        return rendered.includes("unchanged.ts") && rendered.includes("changed.ts");
      });
      await waitForBackgroundWork();
      browser.handleInput("C");
      await waitFor(() => {
        const rendered = browser.render(100).join("\n");
        return rendered.includes("changed.ts") && rendered.includes(" M");
      });
      const rendered = browser.render(100).join("\n");
      expect(rendered).toContain("changed.ts");
      expect(rendered).toContain(" M");
      browser.handleInput("p");
      expect(browser.render(200).join("\n")).toContain("tracked file list unavailable");
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now + 3_001);
      browser.render(100);
      await waitFor(() => browser.render(200).join("\n").includes("tracked file list unavailable"));
      clock.mockRestore();
    } finally {
      vi.doUnmock("../src/git.ts");
      vi.resetModules();
    }
  });

  it("restores a nested position without changing the dot root", async () => {
    const root = await createChangedRepository();
    const directory = join(root, "src", "nested");
    const selectedFile = join(directory, "changed.ts");
    const browser = createFileBrowser(root, new Set(), theme, () => {}, () => {}, () => {}, root, selectedFile, directory);

    await waitForBackgroundWork();

    expect(browser.getBrowsePosition()).toEqual({ rootPath: root, directoryPath: directory, selectedFilePath: selectedFile });
    expect(browser.getRestorePath()).toBe("src/nested");
    browser.handleInput(".");
    expect(browser.getBrowsePosition().rootPath).toBe(root);
    expect(browser.getRestorePath()).toBeNull();
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

    expect(resolveRestoredPosition(fallback, position)).toEqual({ rootPath: root, directoryPath: directory, selectedFilePath: selectedFile, restored: true });
    await rm(selectedFile);
    expect(resolveRestoredPosition(fallback, position)).toEqual({ rootPath: root, directoryPath: directory, restored: true });
    await rm(directory, { recursive: true });
    const invalidRestore = resolveRestoredPosition(fallback, position);
    expect(invalidRestore).toEqual({ rootPath: fallback, directoryPath: fallback, restored: false });
    const browser = createFileBrowser(
      invalidRestore.rootPath,
      new Set(),
      theme,
      () => {},
      () => {},
      () => {},
      fallback,
      invalidRestore.restored ? invalidRestore.selectedFilePath : undefined,
      invalidRestore.restored ? invalidRestore.directoryPath : undefined
    );
    expect(browser.getRestorePath()).toBeNull();
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
    expect(wide.at(-1)).toContain(".: root");
    expect(wide.at(-1)).not.toContain("│");
    browser.handleInput("?");
    const fullHelp = browser.render(100).slice(-2).join("\n");
    expect(fullHelp).toContain("j/k/↑/↓: move");
    expect(fullHelp).toContain("Enter: open");
    expect(fullHelp).toContain("h/l←→: folder");
    expect(fullHelp).toContain("c: changed only");
    expect(fullHelp).toContain("?: hide");
    expect(fullHelp).toContain("q/Esc: close");
    const narrowHelp = browser.render(24).slice(-2);
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

  it("scans only the restored nested path after entering safe mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-files-widget-overlay-safe-"));
    directories.push(root);
    const directory = join(root, "..restored", "nested");
    const selectedFile = join(directory, "selected.ts");
    await mkdir(directory, { recursive: true });
    await writeFile(selectedFile, "export const selected = true;\n");
    await Promise.all(Array.from({ length: 200 }, (_, index) => writeFile(join(root, `entry-${index}.ts`), "\n")));
    const browser = createFileBrowser(root, new Set(), theme, () => {}, () => {}, () => {}, root, selectedFile, directory);

    await waitFor(() => browser.getBrowsePosition().selectedFilePath === selectedFile);

    expect(browser.render(100).join("\n")).toContain("selected.ts");
    expect(browser.getRestorePath()).toContain("restored");
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
  it("isolates @ search failures and clears them after success or cancellation", async () => {
    vi.resetModules();
    const searches: Array<{ resolve: (output: string) => void; reject: (error: unknown) => void }> = [];
    vi.doMock("@earendil-works/pi-coding-agent", async importOriginal => {
      const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
      return {
        ...actual,
        createGrepTool: () => ({
          execute: () => new Promise((resolve, reject) => {
            searches.push({
              resolve: output => resolve({ content: [{ type: "text", text: output }] }),
              reject: error => reject(error),
            });
          }),
        }),
      };
    });
    try {
      const { createFileBrowser: createSearchBrowser } = await import("../src/browser.ts");
      const root = await createChangedRepository();
      const browser = createSearchBrowser(root, new Set(), theme, () => {}, () => {}, () => {});
      await waitFor(() => browser.render(80).join("\n").includes("changed.ts"));

      vi.useFakeTimers();
      browser.handleInput("@");
      browser.handleInput("f");
      await vi.advanceTimersByTimeAsync(150);
      searches[0]!.reject("failed\u001b[31m");
      await Promise.resolve();
      await Promise.resolve();
      browser.handleInput("\r");
      expect(browser.render(70).join("\n")).toContain("Content search: failed�[31m");

      browser.handleInput("@");
      browser.handleInput("s");
      await vi.advanceTimersByTimeAsync(150);
      searches[1]!.resolve("changed.ts:1: value");
      await Promise.resolve();
      await Promise.resolve();
      browser.handleInput("\r");
      expect(browser.render(70).join("\n")).not.toContain("Content search:");

      browser.handleInput("@");
      browser.handleInput("c");
      await vi.advanceTimersByTimeAsync(150);
      searches[2]!.reject(new Error("cancelled"));
      await Promise.resolve();
      await Promise.resolve();
      browser.handleInput("\u001b");
      expect(browser.render(70).join("\n")).not.toContain("Content search:");
    } finally {
      vi.useRealTimers();
      vi.doUnmock("@earendil-works/pi-coding-agent");
      vi.resetModules();
    }
  });

  it("preserves scan errors beside @ failures and clears only the search error on re-root", async () => {
    vi.resetModules();
    let rejectSearch: ((error: Error) => void) | undefined;
    vi.doMock("node:fs/promises", async importOriginal => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        readdir: async (path: string, options: { withFileTypes: true }) => {
          if (String(path).endsWith("/blocked")) throw new Error("unavailable");
          return actual.readdir(path, options);
        },
      };
    });
    vi.doMock("@earendil-works/pi-coding-agent", async importOriginal => {
      const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
      return {
        ...actual,
        createGrepTool: () => ({
          execute: () => new Promise((_resolve, reject) => { rejectSearch = reject; }),
        }),
      };
    });
    try {
      const { createFileBrowser: createErrorBrowser } = await import("../src/browser.ts");
      const parent = await mkdtemp(join(tmpdir(), "pi-files-widget-overlay-errors-"));
      directories.push(parent);
      const root = join(parent, "root");
      await mkdir(join(root, "blocked"), { recursive: true });
      const browser = createErrorBrowser(root, new Set(), theme, () => {}, () => {}, () => {});
      await waitFor(() => browser.render(100).join("\n").includes("blocked"));
      browser.handleInput("j");
      browser.handleInput("\r");
      await waitFor(() => browser.render(100).join("\n").includes("Unable to scan blocked"));

      vi.useFakeTimers();
      browser.handleInput("@");
      browser.handleInput("x");
      await vi.advanceTimersByTimeAsync(150);
      rejectSearch!(new Error("grep failed"));
      await Promise.resolve();
      await Promise.resolve();
      browser.handleInput("\r");
      const withBothErrors = browser.render(70).join("\n");
      expect(withBothErrors).toContain("Unable to scan blocked");
      expect(withBothErrors).toContain("Content search: grep failed");

      browser.handleInput("u");
      expect(browser.getRootPath()).toBe(parent);
      expect(browser.render(70).join("\n")).not.toContain("Content search:");
    } finally {
      vi.useRealTimers();
      vi.doUnmock("node:fs/promises");
      vi.doUnmock("@earendil-works/pi-coding-agent");
      vi.resetModules();
    }
  });

  it("discards stale @ content searches after query, root, and overlay changes", async () => {
    vi.resetModules();
    const searches: Array<{ root: string; pattern: string; resolve: (output: string) => void; reject: (error: Error) => void }> = [];
    vi.doMock("@earendil-works/pi-coding-agent", async importOriginal => {
      const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
      return {
        ...actual,
        createGrepTool: (root: string) => ({
          execute: (_id: string, input: { pattern: string }) => new Promise((resolve, reject) => {
            searches.push({
              root,
              pattern: input.pattern,
              resolve: output => resolve({ content: [{ type: "text", text: output }] }),
              reject: error => reject(error),
            });
          }),
        }),
      };
    });
    try {
      const { createFileBrowser: createSearchBrowser } = await import("../src/browser.ts");
      const parent = await mkdtemp(join(tmpdir(), "pi-files-widget-overlay-search-"));
      directories.push(parent);
      const oldRoot = join(parent, "old");
      await mkdir(oldRoot);
      await Promise.all([
        writeFile(join(oldRoot, "old.ts"), "old\n"),
        writeFile(join(oldRoot, "fresh.ts"), "fresh\n"),
        writeFile(join(parent, "parent.ts"), "parent\n"),
      ]);
      const browser = createSearchBrowser(oldRoot, new Set(), theme, () => {}, () => {}, () => {});
      await waitFor(() => browser.render(60).join("\n").includes("fresh.ts"));

      vi.useFakeTimers();
      browser.handleInput("@");
      browser.handleInput("o");
      await vi.advanceTimersByTimeAsync(150);
      expect(searches).toHaveLength(1);
      browser.handleInput("l");
      await vi.advanceTimersByTimeAsync(150);
      expect(searches).toHaveLength(2);
      searches[0]!.resolve("old.ts:1: old");
      await Promise.resolve();
      expect(browser.render(60).join("\n")).not.toContain("old.ts");
      searches[1]!.resolve("fresh.ts:1: fresh");
      await Promise.resolve();
      expect(browser.render(60).join("\n")).toContain("fresh.ts");

      browser.handleInput("d");
      await vi.advanceTimersByTimeAsync(150);
      expect(searches).toHaveLength(3);
      browser.handleInput("\r");
      browser.handleInput("u");
      searches[2]!.reject(new Error("stale\u001b[31m failure"));
      await Promise.resolve();
      expect(browser.getRootPath()).toBe(parent);
      expect(browser.render(60).join("\n")).not.toContain("old.ts");

      const closed = createSearchBrowser(oldRoot, new Set(), theme, () => {}, () => {}, () => {});
      closed.handleInput("@");
      closed.handleInput("o");
      await vi.advanceTimersByTimeAsync(150);
      const pending = searches.at(-1)!;
      closed.handleInput("\r");
      closed.handleInput("q");
      pending.resolve("old.ts:1: old");
      await Promise.resolve();
      expect(closed.render(60).join("\n")).not.toContain("old.ts");
    } finally {
      vi.useRealTimers();
      vi.doUnmock("@earendil-works/pi-coding-agent");
      vi.resetModules();
    }
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

  it("keeps the selected content result when confirming search", async () => {
    const root = await createChangedRepository();
    const selectedTheme = { ...theme, bg: (_color: string, text: string) => `[selected]${text}` } as unknown as Theme;
    const browser = createFileBrowser(root, new Set(), selectedTheme, () => {}, () => {}, () => {});
    await waitForBackgroundWork();

    browser.handleInput("@");
    for (const character of "true") browser.handleInput(character);
    await waitFor(() => browser.render(100).filter(line => line.includes(".ts")).length >= 2);
    browser.handleInput("\u001b[B");
    const selectedBefore = browser.render(100).find(line => line.includes("[selected]"));
    browser.handleInput("\r");

    expect(browser.render(100).find(line => line.includes("[selected]"))).toBe(selectedBefore);
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
