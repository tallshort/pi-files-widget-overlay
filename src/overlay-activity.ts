import { SCAN_ACTIVITY_LABEL } from "./constants";
const DEFAULT_SCAN_ACTIVITY_DELAY_MS = 150;

export interface OverlayActivityPresenter {
  present(activity: string, scope?: string): string;
  dispose(): void;
}

export function createOverlayActivityPresenter(
  requestRender: () => void,
  delayMs = DEFAULT_SCAN_ACTIVITY_DELAY_MS
): OverlayActivityPresenter {
  let revealTimer: ReturnType<typeof setTimeout> | null = null;
  let scanningVisible = false;
  let activeScope: string | undefined;

  function reset(): void {
    if (revealTimer) clearTimeout(revealTimer);
    revealTimer = null;
    scanningVisible = false;
  }

  return {
    present(activity, scope): string {
      if (scope !== activeScope) {
        reset();
        activeScope = scope;
      }
      if (!activity.startsWith(SCAN_ACTIVITY_LABEL)) {
        reset();
        return activity;
      }
      if (scanningVisible) return activity;
      if (!revealTimer) {
        revealTimer = setTimeout(() => {
          revealTimer = null;
          scanningVisible = true;
          requestRender();
        }, delayMs);
      }
      return activity.slice(SCAN_ACTIVITY_LABEL.length).trimStart();
    },
    dispose(): void {
      reset();
      activeScope = undefined;
    },
  };
}
