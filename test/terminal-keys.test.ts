import { Key, matchesKey } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

describe("terminal key sequences", () => {
  it.each([
    ["ArrowUp", "\u001b[A", Key.up],
    ["ArrowDown", "\u001b[B", Key.down],
    ["ArrowRight", "\u001b[C", Key.right],
    ["ArrowLeft", "\u001b[D", Key.left],
    ["PageUp", "\u001b[5~", Key.pageUp],
    ["PageDown", "\u001b[6~", Key.pageDown],
    ["Escape", "\u001b", Key.escape],
    ["Enter", "\r", Key.enter],
    ["Backspace", "\u007f", Key.backspace],
    ["Ctrl-U", "\u0015", "ctrl+u"],
    ["Ctrl-D", "\u0004", "ctrl+d"],
    ["Ctrl-Enter", "\u001b[13;5u", "ctrl+enter"],
    ["Alt-Enter", "\u001b[13;3u", "alt+enter"],
  ])("recognizes $s", (_name, sequence, key) => {
    expect(matchesKey(sequence, key as Parameters<typeof matchesKey>[1])).toBe(true);
  });
});
