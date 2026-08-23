import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { NodeServices } from "@effect/platform-node";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as PluginHostCapabilityBroker from "./PluginHostCapabilityBroker.ts";

const pluginId = "com.acme.data";

const makeLayer = (baseDir: string) => {
  const configLayer = Layer.fresh(ServerConfig.layerTest(process.cwd(), baseDir));
  return PluginHostCapabilityBroker.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer.pipe(Layer.provideMerge(configLayer))),
    Layer.provideMerge(configLayer),
  );
};

const useBroker = <A, E>(
  baseDir: string,
  effect: Effect.Effect<A, E, PluginHostCapabilityBroker.PluginHostCapabilityBroker>,
) => Effect.scoped(effect.pipe(Effect.provide(makeLayer(baseDir))));

it.layer(NodeServices.layer)("plugin host capability broker", (it) => {
  it.effect("requires an explicit persisted grant before opening host capabilities", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-host-grants-test-",
      });
      const requested = ["settings:read-write", "state:read-write"];

      const denied = yield* Effect.exit(
        useBroker(
          baseDir,
          Effect.gen(function* () {
            const broker = yield* PluginHostCapabilityBroker.PluginHostCapabilityBroker;
            return yield* broker.open(pluginId, requested);
          }),
        ),
      );
      expect(denied._tag).toBe("Failure");

      yield* useBroker(
        baseDir,
        Effect.gen(function* () {
          const broker = yield* PluginHostCapabilityBroker.PluginHostCapabilityBroker;
          expect((yield* Effect.exit(broker.grant(pluginId, ["filesystem:/tmp"])))._tag).toBe(
            "Failure",
          );
          yield* broker.grant(pluginId, requested);
          expect(yield* broker.granted(pluginId)).toEqual(requested);
        }),
      );

      yield* useBroker(
        baseDir,
        Effect.gen(function* () {
          const broker = yield* PluginHostCapabilityBroker.PluginHostCapabilityBroker;
          expect(yield* broker.granted(pluginId)).toEqual(requested);
          yield* broker.open(pluginId, requested);
        }),
      );
    }),
  );

  it.effect("keeps settings, state, and cache detached and isolated by plugin", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-host-data-test-",
      });
      const permissions = ["settings:read-write", "state:read-write", "cache:read-write"];

      yield* useBroker(
        baseDir,
        Effect.gen(function* () {
          const broker = yield* PluginHostCapabilityBroker.PluginHostCapabilityBroker;
          yield* broker.grant(pluginId, permissions);
          yield* broker.grant("com.acme.other", permissions);
          const api = yield* broker.open(pluginId, permissions);
          const mutable = { nested: ["before"] };
          yield* api.settings.set("preferences", mutable);
          mutable.nested[0] = "after";
          yield* api.state.set("cursor", { value: 7 });
          yield* api.cache.set("response", { ok: true });

          expect(yield* api.settings.get("preferences")).toEqual({ nested: ["before"] });
          expect(yield* api.state.get("cursor")).toEqual({ value: 7 });
          expect(yield* api.cache.get("response")).toEqual({ ok: true });

          const other = yield* broker.open("com.acme.other", permissions);
          expect(yield* other.settings.get("preferences")).toBeUndefined();
          yield* api.cache.clear;
          expect(yield* api.cache.get("response")).toBeUndefined();
        }),
      );

      yield* useBroker(
        baseDir,
        Effect.gen(function* () {
          const broker = yield* PluginHostCapabilityBroker.PluginHostCapabilityBroker;
          const api = yield* broker.open(pluginId, permissions);
          expect(yield* api.settings.get("preferences")).toEqual({ nested: ["before"] });
          expect(yield* api.state.get("cursor")).toEqual({ value: 7 });
          expect(yield* api.cache.get("response")).toBeUndefined();
        }),
      );
    }),
  );

  it.effect(
    "brokers namespaced secrets and files while rejecting undeclared access and traversal",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-plugin-host-authority-test-",
        });
        const permissions = ["secrets:api-token", "filesystem:data"];

        yield* useBroker(
          baseDir,
          Effect.gen(function* () {
            const broker = yield* PluginHostCapabilityBroker.PluginHostCapabilityBroker;
            yield* broker.grant(pluginId, permissions);
            const api = yield* broker.open(pluginId, permissions);
            yield* api.secrets.set("api-token", "secret-value");
            expect(yield* api.secrets.get("api-token")).toBe("secret-value");
            expect((yield* Effect.exit(api.secrets.get("other")))._tag).toBe("Failure");

            yield* api.files.writeText("nested/value.txt", "plugin-owned");
            expect(yield* api.files.readText("nested/value.txt")).toBe("plugin-owned");
            expect((yield* Effect.exit(api.files.readText("../outside.txt")))._tag).toBe("Failure");

            const outside = path.join(baseDir, "outside.txt");
            const linked = path.join(
              baseDir,
              "userdata",
              "plugin-data",
              pluginId,
              "files",
              "linked.txt",
            );
            yield* fileSystem.writeFileString(outside, "outside");
            yield* fileSystem.symlink(outside, linked);
            expect((yield* Effect.exit(api.files.readText("linked.txt")))._tag).toBe("Failure");

            const outsideDirectory = path.join(baseDir, "outside-directory");
            const escapedDirectory = path.join(path.dirname(linked), "escape");
            yield* fileSystem.makeDirectory(outsideDirectory);
            yield* fileSystem.symlink(outsideDirectory, escapedDirectory);
            expect(
              (yield* Effect.exit(api.files.writeText("escape/new/sub/leak.txt", "leak")))._tag,
            ).toBe("Failure");
            expect(yield* fileSystem.exists(path.join(outsideDirectory, "new"))).toBe(false);
          }),
        );
      }),
  );

  it.effect("limits network and process calls to declared targets", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-host-external-test-",
      });
      const permissions = ["network:https://example.com", "process:node"];

      yield* useBroker(
        baseDir,
        Effect.gen(function* () {
          const broker = yield* PluginHostCapabilityBroker.PluginHostCapabilityBroker;
          yield* broker.grant(pluginId, permissions);
          const api = yield* broker.open(pluginId, permissions);
          expect((yield* Effect.exit(api.network.fetchText("https://example.org")))._tag).toBe(
            "Failure",
          );
          const result = yield* api.process.run("node", ["-e", "process.stdout.write('ok')"]);
          expect(result).toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
          expect((yield* Effect.exit(api.process.run("sh", ["-c", "exit 0"])))._tag).toBe(
            "Failure",
          );
        }),
      );
    }),
  );
});
