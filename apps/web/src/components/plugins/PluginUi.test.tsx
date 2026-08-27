import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { PluginUiPageContent, PluginUiViewContent } from "./PluginUi";

const emptyCatalog = {
  generation: 0,
  packages: [],
  order: {
    settings: [],
    navigation: [],
    views: [],
    cards: [],
    statusItems: [],
    composerActions: [],
    contextualActions: [],
  },
} as const;

describe("PluginUiPageContent", () => {
  it("distinguishes loading from a resolved missing page", () => {
    const loading = renderToStaticMarkup(
      <PluginUiPageContent
        loading
        catalog={emptyCatalog}
        pluginPackage={undefined}
        view={undefined}
        onAction={vi.fn()}
      />,
    );
    expect(loading).toContain("Loading plugin page");
    expect(loading).not.toContain("Plugin page unavailable");

    const missing = renderToStaticMarkup(
      <PluginUiPageContent
        loading={false}
        catalog={emptyCatalog}
        pluginPackage={undefined}
        view={undefined}
        onAction={vi.fn()}
      />,
    );
    expect(missing).toContain("Plugin page unavailable");
    expect(missing).toContain("could not be found");
  });
});

describe("PluginUiViewContent", () => {
  it("renders cards, statuses, text, and actions with host-owned components", () => {
    const onAction = vi.fn();
    const markup = renderToStaticMarkup(
      <PluginUiViewContent
        pluginPackage={{
          pluginId: "com.acme.fun",
          settings: [],
          navigation: [],
          views: [],
          cards: [
            {
              id: "com.acme.fun.card",
              title: "Fun score",
              value: "42",
              tone: "success",
              actionId: "com.acme.fun.composer",
              surfaces: ["web"],
            },
          ],
          statusItems: [
            {
              id: "com.acme.fun.status",
              label: "Arcade",
              value: "Ready",
              tone: "success",
              surfaces: ["web"],
            },
          ],
          composerActions: [
            {
              id: "com.acme.fun.composer",
              label: "Celebrate",
              commandId: "com.acme.fun.celebrate",
              surfaces: ["web"],
            },
          ],
          contextualActions: [],
        }}
        view={{
          id: "com.acme.fun.view",
          label: "Fun",
          description: "A host-rendered page.",
          surfaces: ["web"],
          blocks: [
            { kind: "text", text: "Welcome to the arcade" },
            {
              kind: "action",
              id: "com.acme.fun.play",
              label: "Play",
              commandId: "com.acme.fun.celebrate",
            },
          ],
        }}
        onAction={onAction}
      />,
    );

    expect(markup).toContain("Fun score");
    expect(markup).toContain("42");
    expect(markup).toContain("Arcade");
    expect(markup).toContain("Ready");
    expect(markup).toContain("Welcome to the arcade");
    expect(markup).toContain("Celebrate");
    expect(markup).toContain("Play");
    expect(markup).not.toContain("script");
    expect(markup).not.toContain("iframe");
  });
});
