import { act } from "react";
import { jsx } from "react/jsx-runtime";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  animationsEnabled: vi.fn(() => false),
}));

vi.mock("../hooks/useInterfaceAnimations", () => ({
  useInterfaceAnimationsEnabled: mocks.animationsEnabled,
}));

// ReactDOM needs a host, but this unit suite intentionally has no DOM dependency.
class TestNode {
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];
  activeElement: TestNode | null = null;
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
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return document;
}

import { InlineRightPanelPresence } from "./InlineRightPanelPresence";

/**
 * Mount the presence with a recording render prop. Exit settling is
 * synchronous because the mocked hook reports animations disabled.
 */
async function mountPresence(initialOpen: boolean) {
  const document = installTestDom();
  const root = createRoot(document.createElement("div") as unknown as Element);
  const enterLog: boolean[] = [];
  const exits: string[] = [];
  const renderWith = (open: boolean) => {
    root.render(
      jsx(InlineRightPanelPresence<string>, {
        open,
        snapshot: `snapshot-${open ? "open" : "closed"}`,
        onExitComplete: (snapshot: string) => {
          exits.push(snapshot);
        },
        children: (_snapshot: string, _completeExit: () => void, animateEnter: boolean) => {
          enterLog.push(animateEnter);
          return jsx("div", { children: _snapshot });
        },
      }),
    );
  };
  await act(async () => {
    renderWith(initialOpen);
  });
  return {
    enterLog,
    exits,
    rerender: async (open: boolean) => {
      await act(async () => {
        renderWith(open);
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      vi.unstubAllGlobals();
    },
  };
}

describe("InlineRightPanelPresence enter gate", () => {
  it("animates the first open of a presence mounted closed", async () => {
    const view = await mountPresence(false);
    try {
      expect(view.enterLog).toEqual([]);
      await view.rerender(true);
      // A second pass follows once the settled flag flips; the first paint
      // decides whether @starting-style applies.
      expect(view.enterLog[0]).toBe(true);
    } finally {
      await view.unmount();
    }
  });

  it("does not replay the reveal when mounted already open", async () => {
    const view = await mountPresence(true);
    try {
      // First paint must carry the suppression; later passes may see the
      // settled flag, they paint no starting style.
      expect(view.enterLog[0]).toBe(false);
    } finally {
      await view.unmount();
    }
  });

  it("animates genuine closes and reopens of a presence mounted already open", async () => {
    const view = await mountPresence(true);
    try {
      expect(view.enterLog[0]).toBe(false);
      // Exiting children rerender once with the flag settled; harmless since
      // the attribute is gated on open.
      await view.rerender(false);
      expect(view.exits).toEqual(["snapshot-open"]);
      await view.rerender(true);
      expect(view.enterLog.at(-1)).toBe(true);
    } finally {
      await view.unmount();
    }
  });
});
