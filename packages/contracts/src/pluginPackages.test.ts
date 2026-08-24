import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  PluginPackageActionInput,
  PluginPackageOperationError,
  PluginPackageStatusSnapshot,
} from "./pluginPackages.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

const decodeStatus = Schema.decodeUnknownSync(PluginPackageStatusSnapshot);
const decodeAction = Schema.decodeUnknownSync(PluginPackageActionInput);

describe("plugin package contracts", () => {
  it("decodes environment package status", () => {
    expect(
      decodeStatus({
        errors: [],
        packages: [
          {
            id: "com.acme.runtime-status",
            version: "1.0.0",
            apiVersion: 1,
            enabled: true,
            state: "active",
            runtimeState: "running",
            restartCount: 0,
            capabilities: ["t3.commands@1"],
            permissions: ["state:read-write", "network:https://api.acme.test"],
            grantedPermissions: ["state:read-write"],
            contributions: {
              commands: ["acme.runtime-status"],
              settings: [],
              navigation: [],
              views: [],
              cards: [],
              statusItems: [],
              composerActions: [],
              contextualActions: [],
            },
          },
        ],
      }),
    ).toEqual({
      errors: [],
      packages: [
        {
          id: "com.acme.runtime-status",
          version: "1.0.0",
          apiVersion: 1,
          enabled: true,
          state: "active",
          runtimeState: "running",
          restartCount: 0,
          capabilities: ["t3.commands@1"],
          permissions: ["state:read-write", "network:https://api.acme.test"],
          grantedPermissions: ["state:read-write"],
          contributions: {
            commands: ["acme.runtime-status"],
            settings: [],
            navigation: [],
            views: [],
            cards: [],
            statusItems: [],
            composerActions: [],
            contextualActions: [],
          },
        },
      ],
    });
  });

  it("reports invalid discovered package directories without inventing an id", () => {
    expect(
      decodeStatus({
        errors: [{ directory: "broken-package", error: "manifest api version is unsupported" }],
        packages: [],
      }),
    ).toEqual({
      errors: [{ directory: "broken-package", error: "manifest api version is unsupported" }],
      packages: [],
    });
  });

  it("decodes an enabled package blocked by dependency resolution", () => {
    expect(
      decodeStatus({
        errors: [],
        packages: [
          {
            id: "com.acme.issues",
            version: "1.0.0",
            apiVersion: 1,
            enabled: true,
            state: "blocked",
            runtimeState: "stopped",
            restartCount: 0,
            capabilities: ["t3.commands@1"],
            permissions: [],
            grantedPermissions: [],
            contributions: {
              commands: ["acme.issues.create"],
              settings: [],
              navigation: [],
              views: [],
              cards: [],
              statusItems: [],
              composerActions: [],
              contextualActions: [],
            },
            error: "Missing dependency: acme.database@1",
          },
        ],
      }),
    ).toMatchObject({
      packages: [{ id: "com.acme.issues", state: "blocked" }],
    });
  });

  it("rejects malformed package ids and action payloads", () => {
    expect(() => decodeAction({ id: "runtime-status" })).toThrow();
    expect(() => decodeAction({ id: `com.${"a".repeat(252)}` })).toThrow();
    expect(() => decodeAction({ id: "com.acme.runtime-status", extra: true })).toThrow();
  });

  it("rejects unsupported host permissions in package status", () => {
    for (const permission of [
      "network:https://example.com:443",
      "network:https://example.com:99999",
    ]) {
      expect(() =>
        decodeStatus({
          errors: [],
          packages: [
            {
              id: "com.acme.runtime-status",
              version: "1.0.0",
              apiVersion: 1,
              enabled: false,
              state: "disabled",
              runtimeState: "stopped",
              restartCount: 0,
              capabilities: [],
              permissions: [permission],
              grantedPermissions: [],
              contributions: {
                commands: [],
                settings: [],
                navigation: [],
                views: [],
                cards: [],
                statusItems: [],
                composerActions: [],
                contextualActions: [],
              },
            },
          ],
        }),
      ).toThrow();
    }
  });

  it("rejects declared command ids that cannot be invoked", () => {
    expect(() =>
      decodeStatus({
        errors: [],
        packages: [
          {
            id: "com.acme.runtime-status",
            version: "1.0.0",
            apiVersion: 1,
            enabled: false,
            state: "disabled",
            runtimeState: "stopped",
            restartCount: 0,
            capabilities: ["t3.commands@1"],
            permissions: [],
            grantedPermissions: [],
            contributions: { commands: [`acme.${"x".repeat(196)}`] },
          },
        ],
      }),
    ).toThrow();
  });

  it("preserves operation causes without putting failure text in the stable message", () => {
    const cause = new Error("disk exploded");
    const error = new PluginPackageOperationError({ cause, operation: "enable" });
    expect(error.cause).toBe(cause);
    expect(error.message).toBe("enable failed for plugin packages");
    expect(
      new PluginPackageOperationError({
        detail: "package is not enabled",
        id: "com.acme.runtime-status",
        operation: "reload",
      }).message,
    ).toBe("reload failed for plugin package com.acme.runtime-status: package is not enabled");
  });

  it("registers fixed status and lifecycle rpc methods", () => {
    expect(WsRpcGroup.requests.has(WS_METHODS.pluginPackagesStatus)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.pluginPackagesEnable)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.pluginPackagesDisable)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.pluginPackagesReload)).toBe(true);
  });
});
