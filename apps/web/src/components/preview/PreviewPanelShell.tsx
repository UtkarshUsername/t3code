import {
  Fragment,
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { isElectron } from "~/env";
import { useResizableWidth } from "~/hooks/useResizableWidth";
import { cn } from "~/lib/utils";

import { RightPanelResizeHandle } from "./RightPanelResizeHandle";

export type PreviewPanelMode = "inline" | "sheet" | "sidebar" | "embedded";

const PREVIEW_PANEL_WIDTH_STORAGE_KEY = "t3code:preview-panel-width";
const PREVIEW_PANEL_MIN_WIDTH = 360;
/**
 * Upper bound as a fraction of the viewport; only binds on wide screens.
 * On narrow windows the container clamp below is what preserves the
 * sibling column's space.
 */
const PREVIEW_PANEL_MAX_WIDTH_FRACTION = 0.7;
const PREVIEW_PANEL_DEFAULT_WIDTH = 540;
/**
 * Width reserved for the sibling column (chat, pull-request list) sharing the
 * panel's flex row. The viewport fraction alone is not enough: the app
 * sidebar sits outside the row, so on narrow windows (any MacBook, even
 * fullscreen) the remaining 30% of the viewport minus the sidebar left the
 * sibling below its usable width and the composer overflowed.
 */
const SIBLING_COLUMN_MIN_WIDTH = 360;

export function getPreviewPanelMaxWidth(viewportWidth: number, containerWidth?: number): number {
  const fractionCap = Math.floor(viewportWidth * PREVIEW_PANEL_MAX_WIDTH_FRACTION);
  const containerCap =
    containerWidth === undefined ? Infinity : Math.floor(containerWidth) - SIBLING_COLUMN_MIN_WIDTH;
  // Never below the panel's own minimum: when the row cannot fit both
  // columns' minimums the sibling yields, and useResizableWidth's clamp
  // must not see max < min (it would resolve the inversion to min and,
  // via drag-end persistence, overwrite the user's stored width).
  return Math.max(PREVIEW_PANEL_MIN_WIDTH, Math.min(fractionCap, containerCap));
}

/**
 * Shell for the preview panel. In inline mode the panel is user-resizable
 * via a drag handle on the left edge; width persists per browser. In
 * sheet/sidebar modes the parent owns the size. Open/close transitions run
 * through layout-gap classes so heavy content never reflows mid-animation;
 * `onExitComplete` fires once the exit transition has landed.
 */
export function PreviewPanelShell(props: {
  mode: PreviewPanelMode;
  maximized?: boolean;
  /**
   * Overrides the localStorage key used to persist the panel width. Callers
   * embedding this shell for a different surface (e.g. the pull requests
   * page) should pass their own key so resizing one panel doesn't clobber
   * the other's remembered width.
   */
  widthStorageKey?: string;
  /** Overrides the initial width (px) before the user has resized the panel. */
  defaultWidth?: number;
  open?: boolean;
  onExitComplete?: () => void;
  /**
   * False suppresses the inline open animation for mounts that are not a
   * genuine open (the shell mounted while already visible). Defaults to
   * animating.
   */
  animateEnter?: boolean;
  children: ReactNode;
}) {
  const useDragRegion = isElectron && props.mode !== "sheet" && props.mode !== "embedded";
  const isInline = props.mode === "inline";
  const maximized = props.maximized === true;
  const open = props.open ?? true;
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Only inline non-maximized mode applies `width`/`maxWidth`; skip the
  // container measurement (and its re-renders) everywhere else.
  const { maxWidth, isViewportResizing, isContainerResizing } = useClampedMaxWidth(
    hostRef,
    isInline && !maximized,
  );
  const { width, isResizing, handlers } = useResizableWidth({
    storageKey: props.widthStorageKey ?? PREVIEW_PANEL_WIDTH_STORAGE_KEY,
    defaultWidth: props.defaultWidth ?? PREVIEW_PANEL_DEFAULT_WIDTH,
    minWidth: PREVIEW_PANEL_MIN_WIDTH,
    maxWidth,
    edge: "left",
  });

  const panelContents = (
    <>
      {isInline && !maximized ? (
        <RightPanelResizeHandle key="resize-handle" handlers={handlers} />
      ) : null}
      {useDragRegion ? (
        <div key="drag-region" className="electron-drag-region h-0 w-full" aria-hidden />
      ) : null}
      <Fragment key="panel-contents">{props.children}</Fragment>
    </>
  );

  if (isInline) {
    return (
      <div
        ref={hostRef}
        className={cn(
          "right-panel-inline-frame relative h-full min-h-0 min-w-0 max-w-full self-stretch",
          maximized
            ? open
              ? "flex-1"
              : "right-panel-inline-maximized-exit absolute inset-0 z-40"
            : "right-panel-inline-gap shrink-0",
        )}
        style={maximized ? undefined : ({ "--right-panel-width": `${width}px` } as CSSProperties)}
        data-preview-panel-mode={props.mode}
        data-preview-panel-maximized={maximized ? "true" : "false"}
        data-right-panel-open={open ? "true" : "false"}
        data-right-panel-animate-enter={open && props.animateEnter !== false ? "true" : undefined}
        data-right-panel-resizing={
          !maximized && (isResizing || isViewportResizing || isContainerResizing)
            ? "true"
            : undefined
        }
        aria-hidden={open ? undefined : true}
        inert={open ? undefined : true}
        onTransitionEnd={(event) => {
          if (open || event.target !== event.currentTarget || event.propertyName !== "width") {
            return;
          }
          props.onExitComplete?.();
        }}
      >
        <div
          className={cn(
            "right-panel-inline-body right-panel-inline-surface flex h-full min-h-0 min-w-0 flex-col border-l border-border bg-background",
            maximized ? "relative w-full" : "absolute inset-y-0 right-0 w-(--right-panel-width)",
          )}
          onTransitionEnd={(event) => {
            if (
              open ||
              !maximized ||
              event.target !== event.currentTarget ||
              event.propertyName !== "translate"
            ) {
              return;
            }
            props.onExitComplete?.();
          }}
        >
          {panelContents}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={hostRef}
      className={cn(
        "relative flex h-full min-h-0 min-w-0 max-w-full flex-col self-stretch bg-background",
        "w-full",
      )}
      data-preview-panel-mode={props.mode}
      data-preview-panel-maximized={maximized ? "true" : "false"}
    >
      {panelContents}
    </div>
  );
}

/**
 * Track viewport and flex-row widths to derive an upper bound for the panel.
 * Resize-aware so dragging the OS window narrower (or expanding the app
 * sidebar) re-clamps the stored width on the next render (the hook's clamp
 * picks this up automatically); while either resize is still settling,
 * `isViewportResizing`/`isContainerResizing` let callers suppress width
 * transitions so the gap and its fixed-width surface move together. The row
 * is observed rather than the panel itself because the panel competes with
 * its sibling column for row space. Row measurement only runs when `enabled`;
 * modes without a resize handle never apply the resulting width, so they
 * skip the observer entirely.
 */
function useClampedMaxWidth(
  hostRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
): { maxWidth: number; isViewportResizing: boolean; isContainerResizing: boolean } {
  const [viewport, setViewport] = useState(() => ({
    width: typeof window === "undefined" ? 1280 : window.innerWidth,
    isResizing: false,
  }));
  const [container, setContainer] = useState<{ width: number | undefined; isResizing: boolean }>({
    width: undefined,
    isResizing: false,
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    let resizeFrame = 0;
    let settleFrame = 0;
    const onResize = () => {
      // Coalesce rapid resize events into one rAF tick.
      if (settleFrame !== 0) {
        window.cancelAnimationFrame(settleFrame);
        settleFrame = 0;
      }
      if (resizeFrame !== 0) return;
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = 0;
        setViewport({ width: window.innerWidth, isResizing: true });
        settleFrame = window.requestAnimationFrame(() => {
          settleFrame = 0;
          setViewport((current) =>
            current.isResizing ? { ...current, isResizing: false } : current,
          );
        });
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (resizeFrame !== 0) window.cancelAnimationFrame(resizeFrame);
      if (settleFrame !== 0) window.cancelAnimationFrame(settleFrame);
    };
  }, []);
  useLayoutEffect(() => {
    if (!enabled) return;
    const parent = hostRef.current?.parentElement;
    if (!parent) return;
    // Defer the first row measurement by a frame: forcing layout in the
    // insertion task makes Chrome resolve the panel's initial width without
    // starting the enter transition (@starting-style never fires). Until it
    // lands, the viewport fraction cap governs, as during a window resize;
    // the enter animation starts from 0, so the unclamped first target
    // cannot flash over-wide.
    let measured = false;
    let settleFrame = 0;
    const startFrame = window.requestAnimationFrame(() => {
      measured = true;
      setContainer({ width: parent.clientWidth, isResizing: false });
    });
    if (typeof ResizeObserver === "undefined") {
      return () => {
        window.cancelAnimationFrame(startFrame);
      };
    }
    const observer = new ResizeObserver(() => {
      // The observer's initial callback fires in the insertion frame too;
      // skip it so the first measurement comes from the deferred rAF.
      if (!measured) return;
      settleContainerWidth(parent.clientWidth);
    });
    // A container change re-clamps the stored width; flag it so the shell can
    // snap gap and surface together instead of animating only the gap.
    const settleContainerWidth = (next: number) => {
      setContainer((current) => {
        if (current.width === next) return current;
        return { width: next, isResizing: true };
      });
      if (settleFrame !== 0) window.cancelAnimationFrame(settleFrame);
      settleFrame = window.requestAnimationFrame(() => {
        settleFrame = 0;
        setContainer((current) =>
          current.isResizing ? { ...current, isResizing: false } : current,
        );
      });
    };
    observer.observe(parent);
    return () => {
      window.cancelAnimationFrame(startFrame);
      if (settleFrame !== 0) window.cancelAnimationFrame(settleFrame);
      observer.disconnect();
    };
  }, [hostRef, enabled]);
  return {
    maxWidth: getPreviewPanelMaxWidth(viewport.width, container.width),
    isViewportResizing: viewport.isResizing,
    isContainerResizing: container.isResizing,
  };
}
