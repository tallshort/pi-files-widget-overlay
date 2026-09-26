import { describe, expect, it, vi } from "vitest";

import { createOverlayActivityPresenter } from "../src/overlay-activity.ts";

describe("overlay activity presentation", () => {
  it("suppresses short scan activity but reveals a scan that outlasts the delay", async () => {
    vi.useFakeTimers();
    try {
      const requestRender = vi.fn();
      const presenter = createOverlayActivityPresenter(requestRender, 150);

      expect(presenter.present("scanning...", "/root-a")).toBe("");
      expect(presenter.present("scanning... ⚠ retrying", "/root-a")).toBe("⚠ retrying");
      await vi.advanceTimersByTimeAsync(149);
      expect(requestRender).not.toHaveBeenCalled();
      expect(presenter.present("scanning...", "/root-a")).toBe("");

      await vi.advanceTimersByTimeAsync(1);
      expect(requestRender).toHaveBeenCalledOnce();
      expect(presenter.present("scanning...", "/root-a")).toBe("scanning...");

      expect(presenter.present("scanning...", "/root-b")).toBe("");
      expect(presenter.present("", "/root-b")).toBe("");
      expect(presenter.present("scanning...", "/root-b")).toBe("");
      presenter.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
