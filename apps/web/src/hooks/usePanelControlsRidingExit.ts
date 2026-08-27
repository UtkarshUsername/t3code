import { useCallback, useLayoutEffect, useRef, useState } from "react";

/**
 * Keep panel-adjacent controls anchored to the panel through its exit.
 * Layout timing matters: the close flag must land before paint or the controls
 * render in their closed position for one frame before jumping back.
 */
export function usePanelControlsRidingExit(
  open: boolean,
  animationsEnabled: boolean,
  exitFallbackMs = 250,
  scopeKey?: unknown,
): { ridingExit: boolean; completeExit: () => void } {
  const [ridingExit, setRidingExit] = useState(false);
  const wasOpenRef = useRef(open);
  const scopeKeyRef = useRef(scopeKey);

  useLayoutEffect(() => {
    if (!Object.is(scopeKeyRef.current, scopeKey)) {
      scopeKeyRef.current = scopeKey;
      wasOpenRef.current = open;
      setRidingExit(false);
      return;
    }
    if (open) {
      wasOpenRef.current = true;
      setRidingExit(false);
      return;
    }
    if (!wasOpenRef.current) {
      setRidingExit(false);
      return;
    }
    wasOpenRef.current = false;
    if (!animationsEnabled) {
      setRidingExit(false);
      return;
    }
    setRidingExit(true);
    const timeoutId = window.setTimeout(() => setRidingExit(false), exitFallbackMs);
    return () => window.clearTimeout(timeoutId);
  }, [animationsEnabled, exitFallbackMs, open, scopeKey]);

  const completeExit = useCallback(() => setRidingExit(false), []);
  return { ridingExit, completeExit };
}
