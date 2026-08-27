import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  PluginUiCatalog,
  PluginUiContribution,
  PluginUiNotification,
  PluginUiSettingWriteInput,
} from "./pluginUi.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";
import { PluginUiId } from "./pluginPackages.ts";

const decodeContribution = Schema.decodeUnknownSync(PluginUiContribution);
const decodeCatalog = Schema.decodeUnknownSync(PluginUiCatalog);

const completeContribution = {
  settings: [
    {
      id: "com.acme.fun.enabled",
      kind: "boolean",
      label: "Enable fun mode",
      defaultValue: true,
      surfaces: ["web", "desktop", "mobile"],
    },
    {
      id: "com.acme.fun.theme",
      kind: "select",
      label: "Theme",
      defaultValue: "arcade",
      options: [
        { label: "Arcade", value: "arcade" },
        { label: "Calm", value: "calm" },
      ],
      surfaces: ["web", "desktop"],
    },
  ],
  navigation: [
    {
      id: "com.acme.fun.navigation",
      label: "Fun room",
      viewId: "com.acme.fun.dashboard",
      surfaces: ["web", "desktop"],
    },
  ],
  views: [
    {
      id: "com.acme.fun.dashboard",
      label: "Fun room",
      description: "A host-rendered plugin page.",
      surfaces: ["web", "desktop"],
      blocks: [
        { kind: "text", text: "Welcome", tone: "muted" },
        {
          kind: "action",
          id: "com.acme.fun.play",
          label: "Play",
          commandId: "com.acme.fun.play",
        },
      ],
    },
  ],
  cards: [
    {
      id: "com.acme.fun.score",
      title: "Score",
      value: "42",
      tone: "success",
      surfaces: ["web", "desktop", "mobile"],
    },
  ],
  statusItems: [
    {
      id: "com.acme.fun.status",
      label: "Arcade",
      value: "Ready",
      tone: "success",
      surfaces: ["web", "desktop", "mobile"],
    },
  ],
  composerActions: [
    {
      id: "com.acme.fun.composer",
      label: "Add challenge",
      commandId: "com.acme.fun.challenge",
      surfaces: ["web", "desktop", "mobile"],
    },
  ],
  contextualActions: [
    {
      id: "com.acme.fun.context",
      label: "Celebrate thread",
      commandId: "com.acme.fun.celebrate",
      contexts: ["thread"],
      surfaces: ["web", "desktop", "mobile"],
    },
  ],
} as const;

describe("PluginUi", () => {
  it("decodes detached bounded host-rendered contribution metadata", () => {
    expect(decodeContribution(completeContribution)).toEqual(completeContribution);
    expect(
      decodeCatalog({
        generation: 7,
        packages: [{ pluginId: "com.acme.fun", ...completeContribution }],
        order: {
          settings: completeContribution.settings.map((item) => item.id),
          navigation: completeContribution.navigation.map((item) => item.id),
          views: completeContribution.views.map((item) => item.id),
          cards: completeContribution.cards.map((item) => item.id),
          statusItems: completeContribution.statusItems.map((item) => item.id),
          composerActions: completeContribution.composerActions.map((item) => item.id),
          contextualActions: completeContribution.contextualActions.map((item) => item.id),
        },
      }),
    ).toMatchObject({ generation: 7, packages: [{ pluginId: "com.acme.fun" }] });
  });

  it("rejects executable, oversized, malformed, and excess contribution metadata", () => {
    for (const input of [
      { ...completeContribution, execute: () => {} },
      { ...completeContribution, cards: [{ id: "bad", title: "Bad", surfaces: ["web"] }] },
      {
        ...completeContribution,
        views: [
          {
            id: "com.acme.fun.bad",
            label: "Bad",
            surfaces: ["web"],
            blocks: [{ kind: "text", text: "x".repeat(2_001) }],
          },
        ],
      },
      {
        ...completeContribution,
        settings: [
          {
            id: "com.acme.fun.bad",
            kind: "select",
            label: "Bad",
            defaultValue: "missing",
            options: [{ label: "Only", value: "only" }],
            surfaces: ["web"],
          },
        ],
      },
    ]) {
      expect(() => decodeContribution(input)).toThrow();
    }
  });

  it("bounds notification and setting write payloads", () => {
    const decodeNotification = Schema.decodeUnknownSync(PluginUiNotification);
    const decodeSettingWrite = Schema.decodeUnknownSync(PluginUiSettingWriteInput);

    expect(
      decodeNotification({
        id: "notification-1",
        pluginId: "com.acme.fun",
        title: "Challenge complete",
        message: "Nice work.",
        tone: "success",
      }),
    ).toMatchObject({ pluginId: "com.acme.fun", tone: "success" });
    expect(
      decodeSettingWrite({
        pluginId: "com.acme.fun",
        settingId: "com.acme.fun.enabled",
        value: true,
      }),
    ).toMatchObject({ value: true });
    expect(() =>
      decodeNotification({
        id: "notification-1",
        pluginId: "com.acme.fun",
        title: "x".repeat(121),
        message: "nope",
        tone: "info",
      }),
    ).toThrow();
  });

  it("matches the manifest contribution id boundary", () => {
    const decode = Schema.decodeUnknownSync(PluginUiId);
    expect(decode(`com.${"a".repeat(251)}`)).toHaveLength(255);
    expect(() => decode(`com.${"a".repeat(252)}`)).toThrow();
  });

  it("registers fixed ui, setting, notification, and subscription rpc methods", () => {
    for (const method of [
      WS_METHODS.pluginUiList,
      WS_METHODS.pluginUiSettingGet,
      WS_METHODS.pluginUiSettingSet,
      WS_METHODS.subscribePluginUi,
      WS_METHODS.subscribePluginUiNotifications,
    ]) {
      expect(WsRpcGroup.requests.has(method)).toBe(true);
    }
  });
});
