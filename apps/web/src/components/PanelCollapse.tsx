import * as React from "react";

import { cn } from "~/lib/utils";

/** Matches the left sidebar's collapse timing (`duration-200 ease-linear`). */
export const PANEL_COLLAPSE_DURATION_MS = 200;
/** Slack over the transition duration before the timeout fallback commits. */
const PANEL_COLLAPSE_TIMER_SLACK_MS = 60;

export type CollapseDimension = "width" | "height";

export interface PanelCollapseFlight {
  direction: "in" | "out";
  /** Wrapper size in px when the flight started; the wrapper is pinned to it. */
  size: number;
}

/**
 * Animates a panel collapsing to zero and growing back with a CSS transition
 * while keeping a single source of truth: the store stays "open" for the
 * whole exit, so nothing downstream needs a mounted-vs-open workaround.
 *
 * - `requestClose()` starts the collapse and defers `onClose` until the
 *   flight lands (transitionend, with a timer as the primary fallback).
 *   The callback is captured at call time, so identity changes mid-flight
 *   still commit against the panel that started closing.
 * - Opening animates the entrance of a freshly mounted wrapper.
 * - With `enabled` false every path snaps and the wrapper renders exactly
 *   like the unwrapped panel.
 */
export function usePanelCollapse(input: {
  open: boolean;
  enabled: boolean;
  dimension: CollapseDimension;
  /**
   * Switching identity mid-flight settles it immediately so an exit cannot
   * leak into another thread's panel layout.
   */
  identity?: string | number;
  onClose: () => void;
}): {
  ref: (node: HTMLElement | null) => void;
  requestClose: () => void;
  /** Ends the current flight now: an exit commits, an entrance cancels. */
  settle: () => void;
  flight: PanelCollapseFlight | null;
} {
  const { open, enabled, dimension } = input;

  const nodeRef = React.useRef<HTMLElement | null>(null);
  const [flight, setFlight] = React.useState<PanelCollapseFlight | null>(null);
  const flightRef = React.useRef<PanelCollapseFlight | null>(null);
  const endTimerRef = React.useRef<number | null>(null);
  // Captured at requestClose so a late commit targets the panel that began
  // closing, even if the surrounding component re-rendered meanwhile.
  const pendingOnCloseRef = React.useRef<(() => void) | null>(null);

  const latest = { open, enabled, dimension, onClose: input.onClose };
  const latestRef = React.useRef(latest);
  latestRef.current = latest;

  const clearWrapperStyles = React.useCallback(() => {
    const node = nodeRef.current;
    if (!node) return;
    node.style.transition = "";
    node.style.width = "";
    node.style.height = "";
    node.style.flex = "";
  }, []);

  const settle = React.useCallback(() => {
    const current = flightRef.current;
    if (!current) return;
    if (endTimerRef.current != null) {
      window.clearTimeout(endTimerRef.current);
      endTimerRef.current = null;
    }
    flightRef.current = null;
    clearWrapperStyles();
    setFlight(null);
    if (current.direction === "out") {
      pendingOnCloseRef.current?.();
    }
    pendingOnCloseRef.current = null;
  }, [clearWrapperStyles]);

  // Runs one animation frame after a flight's styles are applied so the
  // transition actually interpolates between the pinned start and end values.
  React.useEffect(() => {
    if (!flight) return;
    const node = nodeRef.current;
    if (!node) {
      // The wrapper never mounted or already detached (caller bailed on
      // missing data); settle synchronously instead of sticking in flight.
      settle();
      return;
    }
    const raf = window.requestAnimationFrame(() => {
      node.style.transition = `${dimension} ${PANEL_COLLAPSE_DURATION_MS}ms linear`;
      node.style[dimension] = flight.direction === "in" ? `${flight.size}px` : "0px";
      endTimerRef.current = window.setTimeout(
        () => settle(),
        PANEL_COLLAPSE_DURATION_MS + PANEL_COLLAPSE_TIMER_SLACK_MS,
      );
    });
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target !== node || event.propertyName !== dimension) return;
      settle();
    };
    node.addEventListener("transitionend", onTransitionEnd);
    return () => {
      window.cancelAnimationFrame(raf);
      node.removeEventListener("transitionend", onTransitionEnd);
      // Retargeting a flight must retire its fallback timer too, or the old
      // timer settles the replacement flight early.
      if (endTimerRef.current != null) {
        window.clearTimeout(endTimerRef.current);
        endTimerRef.current = null;
      }
    };
  }, [flight]);

  // Apply the pinned start value in the same pre-paint pass that mounts the
  // flight, then let the effect above flip to the end value next frame.
  React.useLayoutEffect(() => {
    if (!flight) return;
    const node = nodeRef.current;
    if (!node) return;
    node.style.flex = "0 0 auto";
    node.style.transition = "none";
    node.style[dimension] = flight.direction === "in" ? "0px" : `${flight.size}px`;
    void node.offsetWidth;
  }, [flight, dimension]);

  // Entrance: `open` flipping true outside the initial mount arms a grow
  // flight measured off the freshly mounted wrapper. Identity switches snap.
  const firstRenderRef = React.useRef(true);
  const prevIdentityRef = React.useRef(input.identity);
  React.useLayoutEffect(() => {
    const wasFirstRender = firstRenderRef.current;
    firstRenderRef.current = false;
    const switchedIdentity = prevIdentityRef.current !== input.identity;
    prevIdentityRef.current = input.identity;
    // An identity switch retires any flight: an exit commits against its own
    // identity, an entrance snaps so it cannot grow the new identity's panel.
    if (switchedIdentity) {
      settle();
    }
    if (wasFirstRender || switchedIdentity) return;
    if (!open || flightRef.current || !latestRef.current.enabled) return;
    const node = nodeRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const natural = Math.ceil(dimension === "width" ? rect.width : rect.height);
    if (natural <= 0) return;
    const nextFlight: PanelCollapseFlight = { direction: "in", size: natural };
    flightRef.current = nextFlight;
    setFlight(nextFlight);
  }, [open, input.identity]);

  // Disabling animations mid-flight (setting toggle, OS reduced motion)
  // snaps the panel to its current endpoint instead of finishing animated.
  React.useLayoutEffect(() => {
    if (enabled) return;
    settle();
  }, [enabled, settle]);

  const requestClose = React.useCallback(() => {
    const current = latestRef.current;
    if (!current.open || flightRef.current?.direction === "out") return;
    // An entrance still running retargets into an exit from wherever it is.
    const node = nodeRef.current;
    const rect = node?.getBoundingClientRect();
    const size = Math.ceil(rect ? (current.dimension === "width" ? rect.width : rect.height) : 0);
    if (!node || !current.enabled || size <= 1) {
      current.onClose();
      return;
    }
    pendingOnCloseRef.current = current.onClose;
    const nextFlight: PanelCollapseFlight = { direction: "out", size };
    flightRef.current = nextFlight;
    setFlight(nextFlight);
  }, []);

  const ref = React.useCallback(
    (node: HTMLElement | null) => {
      nodeRef.current = node;
      if (node == null && flightRef.current) {
        // Detached mid-flight (caller bailed); commit or drop without styles.
        settle();
      }
    },
    [settle],
  );

  // Memoized so consumers can list the state object in dependency arrays
  // without resubscribing effects on every render.
  return React.useMemo(
    () => ({ ref, requestClose, settle, flight }),
    [ref, requestClose, settle, flight],
  );
}

export type PanelCollapseState = ReturnType<typeof usePanelCollapse>;

/**
 * Wrapper around a collapsible panel. Renders identically to the bare panel
 * while idle; while a flight runs it pins the animated dimension, clips
 * overflow, and holds the content box at its measured size so flexible
 * children (a maximized `flex-1` shell) get clipped instead of reflowing on
 * every frame.
 *
 * The content box stays mounted in every state (`display: contents` while
 * idle): swapping element types at this slot would remount the whole panel
 * subtree on each animated open and close, tearing down terminals, previews,
 * and other local state mid-transition. Both boxes carry
 * `data-panel-collapse` so PreviewPanelShell's clamp walk reaches past them.
 */
export function PanelCollapseFrame(props: {
  state: Pick<PanelCollapseState, "ref" | "flight">;
  dimension: CollapseDimension;
  className?: string | undefined;
  children: React.ReactNode;
}) {
  const flight = props.state.flight;
  return (
    <div
      ref={props.state.ref}
      data-panel-collapse=""
      className={cn(props.className, flight && "overflow-hidden")}
      style={flight ? { flex: "0 0 auto" } : undefined}
    >
      <React.Suspense fallback={null}>
        <div
          data-panel-collapse=""
          style={
            flight
              ? {
                  [props.dimension]: `${flight.size}px`,
                  flex: "0 0 auto",
                  minWidth: 0,
                  minHeight: 0,
                }
              : { display: "contents" }
          }
        >
          {props.children}
        </div>
      </React.Suspense>
    </div>
  );
}
