import type { PluginActivate, PluginManifest } from "t3/plugin";

export const manifest = {
  manifestVersion: 1,
  id: "com.acme.typed",
  version: "1.0.0",
  apiVersion: 1,
  entrypoints: { server: "./index.ts" },
  capabilities: ["t3.commands@1"],
  permissions: ["state:read-write", "network:https://api.example.com"],
  contributes: { commands: ["com.acme.typed.status"] },
} satisfies PluginManifest;

export const invalidManifest = {
  ...manifest,
  permissions: [
    // @ts-expect-error arbitrary filesystem grants are not part of the manifest contract
    "filesystem:/tmp",
  ],
} satisfies PluginManifest;

export const activate = ((api) => {
  api.registerCommand(
    {
      id: "com.acme.typed.status",
      label: "Typed status",
      surfaces: ["web", "desktop"],
    },
    (context) =>
      api.effect.succeed({
        message: context?.projectId ?? "ready",
        tone: "success",
      }),
  );
  api.registerUi({
    settings: [],
    navigation: [],
    views: [],
    cards: [],
    statusItems: [],
    composerActions: [],
    contextualActions: [],
  });
  api.effect.map(
    api.host.network.fetchText("https://example.com/status"),
    (response) => response.body,
  );
  api.onDispose(() => api.host.cache.clear);
}) satisfies PluginActivate;
