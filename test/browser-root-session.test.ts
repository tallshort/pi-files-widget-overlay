import type { Dirent } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { createBrowserRootSession, type BrowserRootState } from "../src/browser-root-session.ts";

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
});
