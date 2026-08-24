import { beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { reactHookHarness } from "~/test/reactHookHarness";

import { usePanelCollapse } from "./PanelCollapse";

vi.mock("react", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("react");
  const { reactHookHarness } = await import("~/test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
    // Effects never run under the plain-function harness; register nothing.
    useEffect: () => undefined,
    useLayoutEffect: () => undefined,
  };
});

function makeNode(size: number): HTMLElement {
  return {
    getBoundingClientRect: () => ({ width: size, height: size }) as unknown as DOMRect,
    style: {},
    offsetWidth: size,
  } as unknown as HTMLElement;
}

function renderCollapse(input: {
  open: boolean;
  enabled?: boolean;
  supersedeKey?: string;
  onClose: () => void;
}) {
  reactHookHarness.beginRender();
  return usePanelCollapse({
    enabled: input.enabled ?? true,
    dimension: "width",
    ...input,
  });
}

describe("usePanelCollapse", () => {
  beforeEach(() => {
    reactHookHarness.reset();
  });

  it("defers onClose until the collapse settles", () => {
    const onClose = vi.fn();
    let panel = renderCollapse({ open: true, onClose });
    panel.ref(makeNode(420));

    panel.requestClose();
    expect(onClose).not.toHaveBeenCalled();

    // Re-render mirrors React reading the armed flight state.
    panel = renderCollapse({ open: true, onClose });
    expect(panel.flight?.direction).toBe("out");

    panel.settle();
    expect(onClose).toHaveBeenCalledTimes(1);
    panel = renderCollapse({ open: false, onClose });
    expect(panel.flight).toBeNull();
  });

  it("settles exactly once when called repeatedly", () => {
    const onClose = vi.fn();
    const panel = renderCollapse({ open: true, onClose });
    panel.ref(makeNode(420));
    panel.requestClose();
    panel.settle();
    panel.settle();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("snaps closed without a flight when animations are disabled", () => {
    const onClose = vi.fn();
    let panel = renderCollapse({ open: true, enabled: false, onClose });
    panel.ref(makeNode(420));
    panel.requestClose();
    expect(onClose).toHaveBeenCalledTimes(1);
    panel = renderCollapse({ open: false, enabled: false, onClose });
    expect(panel.flight).toBeNull();
  });

  it("ignores requestClose while already closed", () => {
    const onClose = vi.fn();
    const panel = renderCollapse({ open: false, onClose });
    panel.ref(makeNode(420));
    panel.requestClose();
    expect(onClose).not.toHaveBeenCalled();
    expect(panel.flight).toBeNull();
  });

  it("explicit settle commits even when the supersede key changed", () => {
    const onClose = vi.fn();
    let panel = renderCollapse({ open: true, onClose, supersedeKey: "a" });
    panel.ref(makeNode(420));
    panel.requestClose();
    panel = renderCollapse({ open: true, onClose, supersedeKey: "b" });
    panel.settle();
    expect(onClose).toHaveBeenCalledTimes(1);
    panel = renderCollapse({ open: true, onClose, supersedeKey: "b" });
    expect(panel.flight).toBeNull();
  });

  it("commits when the supersede key is unchanged", () => {
    const onClose = vi.fn();
    let panel = renderCollapse({ open: true, onClose, supersedeKey: "a" });
    panel.ref(makeNode(420));
    panel.requestClose();
    panel = renderCollapse({ open: true, onClose, supersedeKey: "a" });
    panel.settle();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the captured onClose across re-renders mid-flight", () => {
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    let panel = renderCollapse({ open: true, onClose: firstClose });
    panel.ref(makeNode(420));
    panel.requestClose();
    // The owning component re-renders with a new callback before landing.
    panel = renderCollapse({ open: true, onClose: secondClose });
    panel.settle();
    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(secondClose).not.toHaveBeenCalled();
  });
});
