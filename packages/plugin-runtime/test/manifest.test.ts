import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { PluginManifest } from "../src/manifest.ts";

const decodeManifest = Schema.decodeUnknownSync(PluginManifest);

const validManifest = {
  manifestVersion: 1,
  id: "com.acme.linear",
  version: "1.2.0",
  forkOf: "com.t3code.pull-requests",
  apiVersion: 1,
  entrypoints: {
    server: "./dist/server.js",
    web: "./dist/web.js",
  },
  capabilities: ["t3.commands@1"],
  requires: ["t3.commands@1", "t3.secrets@1"],
  provides: ["com.acme.linear@1"],
  permissions: ["network:https://api.linear.app", "secrets:linear-token", "notifications:send"],
  contributes: {
    commands: ["linear.create-issue"],
    settings: ["linear.settings"],
    navigation: ["linear.navigation"],
    views: ["linear.right-panel"],
    cards: ["linear.summary"],
    statusItems: ["linear.status"],
    composerActions: ["linear.create-from-composer"],
    contextualActions: ["linear.create-from-thread"],
  },
  composition: [
    {
      id: "com.acme.linear.replace-status",
      operation: "replace",
      slot: "commands",
      sourceId: "linear.create-issue",
      targetId: "t3.plugin-runtime.status",
    },
    {
      id: "com.acme.linear.decorate-view",
      operation: "decorate",
      slot: "views",
      targetId: "com.t3code.pull-requests.view",
      patch: { label: "Company pull requests", data: { description: "Acme workflow" } },
    },
  ],
};

describe("PluginManifest", () => {
  it("decodes a versioned namespaced multi-surface plugin manifest", () => {
    expect(decodeManifest(validManifest)).toEqual(validManifest);
  });

  it("rejects unsupported manifest and api versions", () => {
    expect(() => decodeManifest({ ...validManifest, manifestVersion: 2 })).toThrow();
    expect(() => decodeManifest({ ...validManifest, apiVersion: 2 })).toThrow();
    expect(() => decodeManifest({ ...validManifest, engines: { t3: "^0.1.0" } })).toThrow();
  });

  it("rejects unnamespaced plugin and contribution ids", () => {
    expect(() => decodeManifest({ ...validManifest, id: "linear" })).toThrow();
    expect(() => decodeManifest({ ...validManifest, id: `com.${"a".repeat(252)}` })).toThrow();
    expect(() =>
      decodeManifest({
        ...validManifest,
        contributes: { ...validManifest.contributes, commands: ["create-issue"] },
      }),
    ).toThrow();
  });

  it("rejects command ids longer than the invocation contract", () => {
    expect(() =>
      decodeManifest({
        ...validManifest,
        contributes: {
          ...validManifest.contributes,
          commands: [`acme.${"x".repeat(196)}`],
        },
      }),
    ).toThrow();
  });

  it("rejects composition rules whose operation shape is incomplete", () => {
    expect(() =>
      decodeManifest({
        ...validManifest,
        composition: [
          {
            id: "com.acme.linear.invalid",
            operation: "replace",
            slot: "commands",
            targetId: "t3.plugin-runtime.status",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeManifest({
        ...validManifest,
        composition: [
          {
            id: "com.acme.linear.invalid",
            operation: "decorate",
            slot: "commands",
            targetId: "t3.plugin-runtime.status",
          },
        ],
      }),
    ).toThrow();
    expect(() => decodeManifest({ ...validManifest, forkOf: validManifest.id })).toThrow();
    expect(() =>
      decodeManifest({
        ...validManifest,
        composition: [validManifest.composition[0], validManifest.composition[0]],
      }),
    ).toThrow();
  });

  it("rejects malformed versions, capability ids, and host permissions", () => {
    expect(() => decodeManifest({ ...validManifest, version: "next" })).toThrow();
    expect(() => decodeManifest({ ...validManifest, version: "01.2.3" })).toThrow();
    expect(() => decodeManifest({ ...validManifest, version: "1.2.3-.." })).toThrow();
    expect(decodeManifest({ ...validManifest, version: "1.2.3+build.7" }).version).toBe(
      "1.2.3+build.7",
    );
    expect(() => decodeManifest({ ...validManifest, requires: ["t3.commands"] })).toThrow();
    for (const permission of [
      "settings:read",
      "filesystem:/tmp",
      "network:file:///tmp/secret",
      "network:https://example.com:443",
      "network:https://API.example.com",
      "network:https://example.com:99999",
      "process:../sh",
      "secrets:UPPERCASE",
      "unknown:anything",
    ]) {
      expect(() => decodeManifest({ ...validManifest, permissions: [permission] })).toThrow();
    }
  });

  it("rejects unsupported executable entrypoint extensions", () => {
    for (const server of [
      "./dist/server.mjs",
      "./dist/server.cjs",
      "./dist/server.mts",
      "./dist/server.cts",
      "./dist/server.tsx",
    ]) {
      expect(() =>
        decodeManifest({
          ...validManifest,
          entrypoints: { ...validManifest.entrypoints, server },
        }),
      ).toThrow();
    }
  });

  it("rejects entrypoints that escape the plugin directory", () => {
    for (const server of ["./../outside.js", "./dist/../../outside.js"]) {
      expect(() =>
        decodeManifest({
          ...validManifest,
          entrypoints: { ...validManifest.entrypoints, server },
        }),
      ).toThrow();
    }
  });

  it("keeps mobile declarative by excluding a mobile executable entrypoint", () => {
    const decoded = decodeManifest({
      ...validManifest,
      surfaces: ["web", "desktop", "mobile"],
      contributes: { ...validManifest.contributes, mobileCards: ["linear.summary"] },
    });

    expect(decoded.surfaces).toEqual(["web", "desktop", "mobile"]);
    expect(decoded.contributes.mobileCards).toEqual(["linear.summary"]);
    expect(decoded.entrypoints).not.toHaveProperty("mobile");
    expect(() =>
      decodeManifest({
        ...validManifest,
        entrypoints: { ...validManifest.entrypoints, mobile: "./dist/mobile.js" },
      }),
    ).toThrow();
  });
});
