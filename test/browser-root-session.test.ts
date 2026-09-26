import type { Dirent } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { createBrowserRootSession, type BrowserRootState } from "../src/browser-root-session.ts";
import type { FileNode } from "../src/types.ts";

function directoryEntry(name: string): Dirent {
  return {
    name,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isDirectory: () => true,
    isFIFO: () => false,
    isFile: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
    parentPath: "",
    path: "",
  };
}

function createState(): BrowserRootState {
  return {
    root: null,
    stats: { totalLines: undefined, additions: 0, deletions: 0 },
    nodeByPath: new Map(),
    scanState: { mode: "none", isScanning: false, isPartial: false, pending: 0 },
  };
}

describe("browser root session", () => {
  it("discards an awaited scan after starting a new root", async () => {
    vi.useFakeTimers();
    let finishOldScan!: (entries: Dirent[]) => void;
    const oldScan = new Promise<Dirent[]>(resolve => { finishOldScan = resolve; });
    const state = createState();
    const session = createBrowserRootSession({
      state,
      agentModifiedFiles: new Set(),
      ignored: new Set(),
      readDirectory: path => path.endsWith("old") ? oldScan : Promise.resolve([]),
      onEvent: () => {},
      onError: () => {},
    });

    session.startRoot("/old");
    vi.advanceTimersByTime(100);
    session.startRoot("/fresh");
    finishOldScan([directoryEntry("stale")]);
    await Promise.resolve();
    await Promise.resolve();
    await vi.runAllTimersAsync();

    expect(session.getRootPath()).toBe("/fresh");
    expect(state.root?.path).toBe("/fresh");
    expect([...state.nodeByPath.keys()]).not.toContain("/old/stale");
    vi.useRealTimers();
  });

  it("does not publish an awaited scan after the session stops", async () => {
    vi.useFakeTimers();
    let finishScan!: (entries: Dirent[]) => void;
    const pendingScan = new Promise<Dirent[]>(resolve => { finishScan = resolve; });
    const state = createState();
    const onEvent = vi.fn();
    const session = createBrowserRootSession({
      state,
      agentModifiedFiles: new Set(),
      ignored: new Set(),
      readDirectory: () => pendingScan,
      onEvent,
      onError: () => {},
    });

    session.startRoot("/old");
    vi.advanceTimersByTime(100);
    session.stop();
    finishScan([directoryEntry("stale")]);
    await Promise.resolve();
    await Promise.resolve();
    await vi.runAllTimersAsync();

    expect([...state.nodeByPath.keys()]).not.toContain("/old/stale");
    expect(onEvent).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("keeps aggregate line counts unknown until the initial scan publishes", () => {
    vi.useFakeTimers();
    const state = createState();
    const session = createBrowserRootSession({
      state,
      agentModifiedFiles: new Set(),
      ignored: new Set(),
      readDirectory: () => Promise.resolve([]),
      onEvent: () => {},
      onError: () => {},
    });

    session.startRoot("/root");

    expect(state.stats.totalLines).toBeUndefined();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("defers replacement line-count work until known counts are reconciled", async () => {
    vi.useFakeTimers();
    const state = createState();
    const onEvent = vi.fn();
    const statFile = vi.fn().mockResolvedValue({ size: 10, mtimeMs: 1 });
    const readTextFile = vi.fn().mockResolvedValue("contents");
    const file: FileNode = {
      name: "open.ts",
      path: "/root/open.ts",
      isDirectory: false,
      parent: undefined,
    };
    const root: FileNode = {
      name: ".",
      path: "/root",
      isDirectory: true,
      children: [file],
      expanded: true,
      hasChangedChildren: false,
    };
    file.parent = root;
    const session = createBrowserRootSession({
      state,
      agentModifiedFiles: new Set(),
      ignored: new Set(),
      readDirectory: () => Promise.resolve([]),
      statFile,
      readTextFile,
      onEvent,
      onError: () => {},
    });

    session.replaceRoot(root, { path: file.path, lineCount: 7 });
    await vi.runAllTimersAsync();

    expect(state.stats.totalLines).toBe(7);
    expect(statFile).not.toHaveBeenCalled();
    expect(readTextFile).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
