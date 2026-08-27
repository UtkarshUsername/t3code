import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { jsx } from "react/jsx-runtime";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { usePanelControlsRidingExit } from "./usePanelControlsRidingExit";

class TestNode {
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly style = {};

  constructor(
    name: string,
    readonly ownerDocument: TestNode | null = null,
    readonly nodeType = 1,
  ) {
    this.nodeName = name.toUpperCase();
    this.tagName = this.nodeName;
  }

  appendChild(child: TestNode) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child: TestNode) {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }

  createElement(name: string) {
    return new TestNode(name, this);
  }

  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
}

function installTestDom() {
  const document = new TestNode("#document", null, 9);
  const window = {
    document,
    HTMLElement: TestNode,
    HTMLIFrameElement: TestNode,
    HTMLFrameElement: TestNode,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
  return document;
}

function mountHook(initialOpen: boolean, initialAnimationsEnabled: boolean) {
  const document = installTestDom();
  const root = createRoot(document.createElement("div") as unknown as Element);
  let ridingExit = false;
  let completeExit = () => {};

  const Harness = (props: { open: boolean; animationsEnabled: boolean }) => {
    const result = usePanelControlsRidingExit(props.open, props.animationsEnabled);
    ridingExit = result.ridingExit;
    completeExit = result.completeExit;
    return jsx("div", {});
  };
  const render = (open: boolean, animationsEnabled: boolean) => {
    flushSync(() => {
      root.render(jsx(Harness, { open, animationsEnabled }));
    });
  };

  render(initialOpen, initialAnimationsEnabled);
  return {
    get ridingExit() {
      return ridingExit;
    },
    completeExit: () => flushSync(completeExit),
    render,
    unmount: () => flushSync(() => root.unmount()),
  };
}

afterEach(async () => {
  // React's scheduler may finish work on the next immediate after unmount.
  await new Promise<void>((resolve) => setImmediate(resolve));
  vi.unstubAllGlobals();
});

describe("usePanelControlsRidingExit", () => {
  it("marks an animated close before the render commit returns", () => {
    const view = mountHook(true, true);
    try {
      view.render(false, true);
      expect(view.ridingExit).toBe(true);
    } finally {
      view.unmount();
    }
  });

  it("does not retain controls when animations are disabled", () => {
    const view = mountHook(true, false);
    try {
      view.render(false, false);
      expect(view.ridingExit).toBe(false);
    } finally {
      view.unmount();
    }
  });

  it("settles when the exit completes", () => {
    const view = mountHook(true, true);
    try {
      view.render(false, true);
      view.completeExit();
      expect(view.ridingExit).toBe(false);
    } finally {
      view.unmount();
    }
  });
});
