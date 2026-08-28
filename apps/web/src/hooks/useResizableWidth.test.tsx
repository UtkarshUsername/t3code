import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { jsx } from "react/jsx-runtime";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { useResizableWidth } from "./useResizableWidth";

class TestNode {
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly style: Record<string, unknown> & { removeProperty: (name: string) => void };

  constructor(
    name: string,
    readonly ownerDocument: TestNode | null = null,
    readonly nodeType = 1,
  ) {
    this.nodeName = name.toUpperCase();
    this.tagName = this.nodeName;
    this.style = {
      removeProperty: (property) => {
        delete this.style[property];
      },
    };
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
  const document = new TestNode("#document", null, 9) as TestNode & { body: TestNode };
  document.body = new TestNode("body", document);
  const window = {
    document,
    HTMLElement: TestNode,
    HTMLIFrameElement: TestNode,
    HTMLFrameElement: TestNode,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
    cancelAnimationFrame() {},
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("requestAnimationFrame", window.requestAnimationFrame);
  vi.stubGlobal("cancelAnimationFrame", window.cancelAnimationFrame);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
  return document;
}

function mountHook(initialEnabled: boolean) {
  const document = installTestDom();
  const root = createRoot(document.createElement("div") as unknown as Element);
  let result: ReturnType<typeof useResizableWidth> | null = null;

  const Harness = ({ enabled }: { enabled: boolean }) => {
    result = useResizableWidth({
      storageKey: "test:width",
      defaultWidth: 540,
      minWidth: 360,
      maxWidth: 900,
      edge: "left",
      enabled,
    });
    return jsx("div", {});
  };
  const render = (enabled: boolean) => {
    flushSync(() => root.render(jsx(Harness, { enabled })));
  };

  render(initialEnabled);
  return {
    get current() {
      if (result === null) throw new Error("hook did not render");
      return result;
    },
    render,
    unmount: () => flushSync(() => root.unmount()),
  };
}

afterEach(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  vi.unstubAllGlobals();
});

describe("useResizableWidth", () => {
  it("clears an active drag before a disabled panel commit returns", () => {
    const view = mountHook(true);
    let released = false;
    const target = {
      setPointerCapture() {},
      hasPointerCapture: () => true,
      releasePointerCapture: () => {
        released = true;
      },
    };
    try {
      flushSync(() => {
        view.current.handlers.onPointerDown({
          button: 0,
          pointerId: 1,
          clientX: 800,
          currentTarget: target,
          preventDefault() {},
          stopPropagation() {},
        } as never);
      });
      expect(view.current.isResizing).toBe(true);

      view.render(false);

      expect(view.current.isResizing).toBe(false);
      expect(released).toBe(true);
    } finally {
      view.unmount();
    }
  });
});
