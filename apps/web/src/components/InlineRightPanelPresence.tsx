import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const RIGHT_PANEL_EXIT_FALLBACK_MS = 250;

/**
 * Keep the heavy panel mounted only until its CSS exit finishes. Children
 * render with the last snapshot taken while `open`, so the exiting view stays
 * frozen instead of re-rendering against cleared state.
 */
export function InlineRightPanelPresence<Snapshot>(props: {
  open: boolean;
  snapshot: Snapshot;
  onExitComplete?: (snapshot: Snapshot) => void;
  children: (snapshot: Snapshot, onExitComplete: () => void) => ReactNode;
}) {
  const [present, setPresent] = useState(props.open);
  const lastOpenSnapshotRef = useRef(props.snapshot);
  const exitCompletedRef = useRef(!props.open);

  useLayoutEffect(() => {
    if (!props.open) return;
    lastOpenSnapshotRef.current = props.snapshot;
    exitCompletedRef.current = false;
  }, [props.open, props.snapshot]);

  const notifyExitComplete = useCallback(() => {
    if (props.open || exitCompletedRef.current) return false;
    exitCompletedRef.current = true;
    props.onExitComplete?.(lastOpenSnapshotRef.current);
    return true;
  }, [props.onExitComplete, props.open]);

  const completeExit = useCallback(() => {
    if (notifyExitComplete()) setPresent(false);
  }, [notifyExitComplete]);

  const notifyExitCompleteRef = useRef(notifyExitComplete);
  useLayoutEffect(() => {
    notifyExitCompleteRef.current = notifyExitComplete;
  }, [notifyExitComplete]);

  useEffect(
    () => () => {
      notifyExitCompleteRef.current();
    },
    [],
  );

  useEffect(() => {
    if (props.open) {
      setPresent(true);
      return;
    }
    if (!present) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      completeExit();
      return;
    }
    const timeoutId = window.setTimeout(completeExit, RIGHT_PANEL_EXIT_FALLBACK_MS);
    return () => window.clearTimeout(timeoutId);
  }, [completeExit, present, props.open]);

  const snapshot = props.open ? props.snapshot : lastOpenSnapshotRef.current;
  return present ? props.children(snapshot, completeExit) : null;
}
