import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";

import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { NodeServices } from "@effect/platform-node";

import type { PluginHostApi, PluginHostKeyValueStore } from "./PluginHostCapabilityBroker.ts";
import * as PluginWorkerSupervisor from "./PluginWorkerSupervisor.ts";

const makeStore = (): PluginHostKeyValueStore => {
  const values = new Map<string, unknown>();
  return {
    get: (key) => Effect.succeed(values.get(key)),
    set: (key, value) => Effect.sync(() => void values.set(key, structuredClone(value))),
    delete: (key) => Effect.sync(() => void values.delete(key)),
    clear: Effect.sync(() => values.clear()),
  };
};

const makeHost = (): PluginHostApi => ({
  settings: makeStore(),
  state: makeStore(),
  cache: makeStore(),
  secrets: {
    get: () => Effect.succeed(undefined),
    set: () => Effect.succeed(undefined),
    delete: () => Effect.succeed(undefined),
  },
  files: {
    readText: () => Effect.fail(new Error("unused") as never),
    writeText: () => Effect.succeed(undefined),
    remove: () => Effect.succeed(undefined),
  },
  network: {
    fetchText: () => Effect.fail(new Error("unused") as never),
  },
  process: {
    run: () => Effect.fail(new Error("unused") as never),
  },
});

const waitForHealth = (
  worker: PluginWorkerSupervisor.SupervisedPluginWorker,
  expected: PluginWorkerSupervisor.PluginWorkerHealth,
) =>
  Effect.promise(() =>
    vi.waitFor(() => expect(worker.health().state).toBe(expected), {
      interval: 5,
      timeout: 1_000,
    }),
  );

it.layer(NodeServices.layer)("plugin worker supervisor", (it) => {
  it.effect("activates and invokes a plugin through typed worker transport", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-plugin-worker-invoke-test-",
        });
        const entrypointPath = path.join(directory, "index.mjs");
        yield* fileSystem.writeFileString(
          entrypointPath,
          `export default function activate(api) {
            if (!process.execArgv.includes("--max-old-space-size=128") || !process.execArgv.includes("--no-addons")) {
              throw new Error("worker resource flags missing");
            }
            api.registerCommand(
              { id: "acme.counter", label: "Counter", surfaces: ["web"] },
              () => api.effect.flatMap(api.host.state.get("count"), (stored) => {
                const next = typeof stored === "number" ? stored + 1 : 1;
                return api.effect.flatMap(
                  api.host.state.set("count", next),
                  () => api.effect.succeed({ message: String(next), tone: "success" })
                );
              })
            );
          }`,
        );
        const supervisor = yield* PluginWorkerSupervisor.PluginWorkerSupervisor;
        const worker = yield* supervisor.start({
          pluginId: "com.acme.counter",
          entrypointPath,
          host: makeHost(),
        });

        expect(worker.commands.map(({ id }) => id)).toEqual(["acme.counter"]);
        expect(yield* worker.invoke("acme.counter")).toEqual({ message: "1", tone: "success" });
        expect(yield* worker.invoke("acme.counter")).toEqual({ message: "2", tone: "success" });
        expect(worker.health().state).toBe("running");
        yield* Effect.promise(worker.dispose);
      }).pipe(Effect.provide(PluginWorkerSupervisor.layer)),
    ),
  );

  it.effect("kills a worker that exceeds the protocol line limit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-plugin-worker-protocol-limit-test-",
        });
        const entrypointPath = path.join(directory, "index.mjs");
        yield* fileSystem.writeFileString(
          entrypointPath,
          `export default async function activate() {
            process.stdout.write("x".repeat(1_000_001));
            await new Promise(() => {});
          }`,
        );
        const supervisor = yield* PluginWorkerSupervisor.PluginWorkerSupervisor;
        const started = yield* Effect.exit(
          supervisor.start({
            pluginId: "com.acme.protocol-limit",
            entrypointPath,
            host: makeHost(),
          }),
        );
        expect(started._tag).toBe("Failure");
        if (started._tag === "Failure") {
          const cause = Cause.squash(started.cause);
          expect(cause instanceof Error ? cause.message : String(cause)).toContain(
            "protocol line exceeds limit",
          );
        }
      }).pipe(Effect.provide(PluginWorkerSupervisor.layer)),
    ),
  );

  it.effect("restarts after a plugin crash without crashing the server", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-plugin-worker-crash-test-",
        });
        const entrypointPath = path.join(directory, "index.mjs");
        yield* fileSystem.writeFileString(
          entrypointPath,
          `export default function activate(api) {
            api.registerCommand(
              { id: "acme.crash-once", label: "Crash once", surfaces: ["web"] },
              () => api.effect.flatMap(api.host.state.get("crashed"), (crashed) => {
                if (crashed === true) {
                  return api.effect.succeed({ message: "recovered", tone: "success" });
                }
                return api.effect.flatMap(api.host.state.set("crashed", true), () => {
                  process.exit(23);
                });
              })
            );
          }`,
        );
        const supervisor = yield* PluginWorkerSupervisor.PluginWorkerSupervisor;
        const worker = yield* supervisor.start({
          pluginId: "com.acme.crash-once",
          entrypointPath,
          host: makeHost(),
        });

        expect((yield* Effect.exit(worker.invoke("acme.crash-once")))._tag).toBe("Failure");
        yield* waitForHealth(worker, "restarting");
        yield* TestClock.adjust("1 second");
        yield* waitForHealth(worker, "running");
        expect(yield* worker.invoke("acme.crash-once")).toEqual({
          message: "recovered",
          tone: "success",
        });
        yield* Effect.promise(worker.dispose);
      }).pipe(Effect.provide(PluginWorkerSupervisor.layer)),
    ),
  );

  it.effect("stops restarting after the crash budget is exhausted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-plugin-worker-quarantine-test-",
        });
        const entrypointPath = path.join(directory, "index.mjs");
        yield* fileSystem.writeFileString(
          entrypointPath,
          `export default function activate(api) {
            api.registerCommand(
              { id: "acme.always-crash", label: "Always crash", surfaces: ["web"] },
              () => process.exit(24)
            );
          }`,
        );
        const supervisor = yield* PluginWorkerSupervisor.PluginWorkerSupervisor;
        const worker = yield* supervisor.start(
          {
            pluginId: "com.acme.always-crash",
            entrypointPath,
            host: makeHost(),
          },
          { maxRestarts: 1 },
        );

        expect((yield* Effect.exit(worker.invoke("acme.always-crash")))._tag).toBe("Failure");
        yield* waitForHealth(worker, "restarting");
        yield* TestClock.adjust("1 second");
        yield* waitForHealth(worker, "running");
        expect((yield* Effect.exit(worker.invoke("acme.always-crash")))._tag).toBe("Failure");
        yield* waitForHealth(worker, "crashed");
        expect(worker.health().restartCount).toBe(1);
        yield* Effect.promise(worker.dispose);
      }).pipe(Effect.provide(PluginWorkerSupervisor.layer)),
    ),
  );

  it.effect("kills and restarts a worker after an invocation timeout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-plugin-worker-timeout-test-",
        });
        const entrypointPath = path.join(directory, "index.mjs");
        yield* fileSystem.writeFileString(
          entrypointPath,
          `export default function activate(api) {
            api.registerCommand(
              { id: "acme.hang", label: "Hang", surfaces: ["web"] },
              () => new Promise(() => {})
            );
          }`,
        );
        const supervisor = yield* PluginWorkerSupervisor.PluginWorkerSupervisor;
        const worker = yield* supervisor.start(
          {
            pluginId: "com.acme.hang",
            entrypointPath,
            host: makeHost(),
          },
          { invocationTimeout: "100 millis" },
        );

        const invocationFiber = yield* Effect.forkChild(Effect.exit(worker.invoke("acme.hang")));
        yield* Effect.yieldNow;
        yield* TestClock.adjust("101 millis");
        const invocation = yield* Fiber.join(invocationFiber);
        expect(invocation._tag).toBe("Failure");
        if (invocation._tag === "Failure") {
          const cause = Cause.squash(invocation.cause);
          expect(cause instanceof Error ? cause.message : String(cause)).toContain("timed out");
        }
        yield* waitForHealth(worker, "restarting");
        yield* TestClock.adjust("1 second");
        yield* waitForHealth(worker, "running");
        yield* Effect.promise(worker.dispose);
      }).pipe(Effect.provide(PluginWorkerSupervisor.layer)),
    ),
  );

  it.effect("restarts a worker when a non-cooperative invocation is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-plugin-worker-cancel-test-",
        });
        const entrypointPath = path.join(directory, "index.mjs");
        yield* fileSystem.writeFileString(
          entrypointPath,
          `export default function activate(api) {
            api.registerCommand(
              { id: "acme.cancel", label: "Cancel", surfaces: ["web"] },
              () => new Promise(() => {})
            );
          }`,
        );
        const supervisor = yield* PluginWorkerSupervisor.PluginWorkerSupervisor;
        const worker = yield* supervisor.start({
          pluginId: "com.acme.cancel",
          entrypointPath,
          host: makeHost(),
        });

        const invocation = yield* Effect.forkChild(worker.invoke("acme.cancel"));
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(invocation);
        yield* waitForHealth(worker, "restarting");
        yield* TestClock.adjust("1 second");
        yield* waitForHealth(worker, "running");
        yield* Effect.promise(worker.dispose);
      }).pipe(Effect.provide(PluginWorkerSupervisor.layer)),
    ),
  );

  it.effect("runs worker cleanup during disposal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-plugin-worker-dispose-test-",
        });
        const entrypointPath = path.join(directory, "index.mjs");
        const markerPath = path.join(directory, "disposed.txt");
        // @effect-diagnostics-next-line preferSchemaOverJson:off - embeds a path in a test plugin source.
        const markerPathJson = JSON.stringify(markerPath);
        yield* fileSystem.writeFileString(
          entrypointPath,
          `import { writeFile } from "node:fs/promises";
          export default function activate(api) {
            api.onDispose(() => writeFile(${markerPathJson}, "disposed"));
            api.registerCommand(
              { id: "acme.dispose", label: "Dispose", surfaces: ["web"] },
              () => ({ message: "ok", tone: "success" })
            );
          }`,
        );
        const supervisor = yield* PluginWorkerSupervisor.PluginWorkerSupervisor;
        const worker = yield* supervisor.start({
          pluginId: "com.acme.dispose",
          entrypointPath,
          host: makeHost(),
        });

        yield* Effect.promise(worker.dispose);
        expect(yield* fileSystem.readFileString(markerPath)).toBe("disposed");
      }).pipe(Effect.provide(PluginWorkerSupervisor.layer)),
    ),
  );
});
