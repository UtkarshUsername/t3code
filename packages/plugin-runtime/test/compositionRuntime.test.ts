import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import type { PluginDefinition } from "../src/contract.ts";
import * as PluginRuntime from "../src/runtime.ts";

const corePlugin = (): PluginDefinition => ({
  id: "t3.core.status",
  origin: "core",
  version: "1.0.0",
  activate(context) {
    context.register(
      "commands",
      {
        id: "t3.status",
        label: "Core status",
        data: { surfaces: ["web"] },
        composition: { allowed: ["extend", "decorate", "replace", "disable"] },
      },
      "core-handler",
    );
  },
});

const replacementPlugin = (fail = false): PluginDefinition => ({
  id: "acme.status",
  origin: "local-fork",
  version: fail ? "2.0.0" : "1.0.0",
  composition: [
    {
      id: "acme.status.replace",
      operation: "replace",
      slot: "commands",
      sourceId: "acme.status",
      targetId: "t3.status",
    },
  ],
  activate(context) {
    if (fail) throw new Error("replacement failed");
    context.register(
      "commands",
      { id: "acme.status", label: "Fork status", data: { surfaces: ["web"] } },
      "fork-handler",
    );
  },
});

describe("plugin runtime contribution composition", () => {
  it.effect("replaces and restores a core contribution with generation-bound handlers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* PluginRuntime.make();
        const replaced = yield* runtime.reconcile([corePlugin(), replacementPlugin()]);

        expect(replaced.contributions.commands?.map((entry) => entry.id)).toEqual(["acme.status"]);
        expect(replaced.contributions.commands?.[0]).toMatchObject({
          owner: { origin: "local-fork", pluginId: "acme.status" },
          replaces: "t3.status",
        });
        expect(replaced.composition).toEqual([
          expect.objectContaining({ outcome: "applied", ruleId: "acme.status.replace" }),
        ]);
        expect(
          yield* runtime.useContribution<string, string, never, never>(
            "commands",
            "acme.status",
            1,
            Effect.succeed,
          ),
        ).toBe("fork-handler");
        expect(
          (yield* Effect.flip(
            runtime.useContribution<string, string, never, never>(
              "commands",
              "t3.status",
              1,
              Effect.succeed,
            ),
          ))._tag,
        ).toBe("PluginContributionNotFoundError");

        const failed = yield* Effect.exit(
          runtime.reconcile([corePlugin(), replacementPlugin(true)]),
        );
        expect(Exit.isFailure(failed)).toBe(true);
        expect(yield* runtime.snapshot).toBe(replaced);

        const restored = yield* runtime.reconcile([corePlugin()]);
        expect(restored.contributions.commands?.map((entry) => entry.id)).toEqual(["t3.status"]);
        expect(
          yield* runtime.useContribution<string, string, never, never>(
            "commands",
            "t3.status",
            2,
            Effect.succeed,
          ),
        ).toBe("core-handler");
      }),
    ),
  );
});
