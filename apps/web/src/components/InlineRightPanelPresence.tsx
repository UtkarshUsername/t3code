import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useInterfaceAnimationsEnabled } from "../hooks/useInterfaceAnimations";

/** Longest an inline panel exit can take before presence settles it anyway. */
export const INLINE_RIGHT_PANEL_EXIT_FALLBACK_MS = 250;

/**
 * Keep the heavy panel mounted only until its CSS exit finishes. Children
 * render with the last snapshot taken while `open`, so the exiting view stays
 * frozen instead of re-rendering against cleared state.
 */
export function InlineRightPanelPresence<Snapshot>(props: {
  open: boolean;
  snapshot: Snapshot;
  onExitComplete?: (snapshot: Snapshot) => void;
  children: (snapshot: Snapshot, onExitComplete: () => void, animateEnter: boolean) => ReactNode;
}) {
  const [present, setPresent] = useState(props.open);
  // A presence instance born already visible (thread switch or sheet-to-inline
  // flip while open) must not replay the enter animation on its first
  // presentation; every later presentation in the same instance is a genuine
  // open and animates. `hasPresented` flips true right after that first
  // commit, so quick close/reopen still animates.
  const bornOpenRef = useRef(props.open);
  const [hasPresented, setHasPresented] = useState(false);
  useEffect(() => {
    if (!present) return;
    setHasPresented(true);
  }, [present]);
  const lastOpenSnapshotRef = useRef(props.snapshot);
  const exitCompletedRef = useRef(!props.open);
  const animationsEnabled = useInterfaceAnimationsEnabled();

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
    // Without animations (setting off or reduced motion) there is no exit
    // transition to wait for, so settle immediately.
    if (!animationsEnabled) {
      completeExit();
      return;
    }
    const timeoutId = window.setTimeout(completeExit, INLINE_RIGHT_PANEL_EXIT_FALLBACK_MS);
    return () => window.clearTimeout(timeoutId);
  }, [animationsEnabled, completeExit, present, props.open]);

  const snapshot = props.open ? props.snapshot : lastOpenSnapshotRef.current;
  const animateEnter = !(bornOpenRef.current && !hasPresented);
  return present ? props.children(snapshot, completeExit, animateEnter) : null;
}
