import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { createFileBrowser } from "../src/browser.ts";
import { getGitStatus } from "../src/git.ts";

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

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("file browser expanded changed view", () => {
  it("toggles the expanded changed view with C", async () => {
    const root = await createChangedRepository();
    const browser = createFileBrowser(root, new Set(), theme, () => {}, () => {}, () => {});

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

    expect(browser.render(100).join("\n")).toContain("deep");
  });
  it("shows hidden project files while keeping .git internal", async () => {
    const root = await createChangedRepository();
    const browser = createFileBrowser(root, new Set(), theme, () => {}, () => {}, () => {});
    const rendered = browser.render(100).join("\n");

    expect(rendered).toContain(".pi");
    expect(rendered).not.toContain(".git");
    const status = getGitStatus(root);
    expect(status.get(".pi")).toBe("??");
    expect(status.has(".pi/")).toBe(false);
  });

  it("enters first children with right input and collapses parents with left input", async () => {
    const root = await createNestedRepository();
    const browser = createFileBrowser(root, new Set(), theme, () => {}, () => {}, () => {});

    browser.handleInput("l");
    browser.handleInput("l");
    browser.handleInput("h");
    expect(browser.render(100).join("\n")).not.toContain("leaf.ts");

    browser.handleInput("h");
    expect(browser.render(100).join("\n")).not.toContain("nested");
  });

  it("shares changed-only state between c and C", async () => {
    const root = await createChangedRepository();
    const browser = createFileBrowser(root, new Set(), theme, () => {}, () => {}, () => {});

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
