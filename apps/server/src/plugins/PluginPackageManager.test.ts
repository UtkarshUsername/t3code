import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerSettingsError } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { PluginManifest } from "@t3tools/plugin-runtime/manifest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PluginCommandCatalog from "./PluginCommandCatalog.ts";
import * as PluginHostCapabilityBroker from "./PluginHostCapabilityBroker.ts";
import * as PluginPackageManager from "./PluginPackageManager.ts";

const packageId = "com.acme.runtime-status";
const commandId = "acme.runtime-status";
let testSymbolSequence = 0;
const nextTestSymbol = (prefix: string) => `${prefix}-${testSymbolSequence++}`;

const manifest = {
  manifestVersion: 1,
  id: packageId,
  version: "1.0.0",
  apiVersion: 1,
  entrypoints: { server: "./index.mjs" },
  capabilities: ["t3.commands@1"],
  contributes: { commands: [commandId] },
} as const;

const encodeManifest = Schema.encodeSync(Schema.fromJsonString(PluginManifest));
const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const decodePersistedEnabledPlugins = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ enabledPluginIds: Schema.optional(Schema.Array(Schema.String)) }),
  ),
);

const pluginSource = (disposalFile: string, message = "External plugin runtime is active.") => `
import { appendFile } from "node:fs/promises";

export default function activate(api) {
  api.registerCommand(
    {
      id: "${commandId}",
      label: "External runtime status",
      description: "Report status from an external local plugin package.",
      surfaces: ["web", "desktop", "mobile"]
    },
    () => ({ message: ${encodeJsonString(message)}, tone: "success" })
  );
  api.onDispose(() => appendFile(${encodeJsonString(disposalFile)}, "disposed\\n"));
}
`;

const commandPluginSource = (id: string, label: string) => `
export default function activate(api) {
  api.registerCommand(
    {
      id: ${encodeJsonString(id)},
      label: ${encodeJsonString(label)},
      surfaces: ["web", "desktop"]
    },
    () => ({ message: ${encodeJsonString(label)}, tone: "success" })
  );
}
`;

const statefulCommandPluginSource = (id: string) => `
export default function activate(api) {
  api.registerCommand(
    { id: ${encodeJsonString(id)}, label: "Increment plugin state", surfaces: ["web"] },
    () => api.effect.flatMap(api.host.state.get("count"), (stored) => {
      const next = typeof stored === "number" ? stored + 1 : 1;
      return api.effect.flatMap(
        api.host.state.set("count", next),
        () => api.effect.succeed({ message: String(next), tone: "success" })
      );
    })
  );
}
`;

const retryingCommandPluginSource = (
  id: string,
  label: string,
  attemptsSymbol: string,
  failThroughAttempt = 1,
) => `
export default function activate(api) {
  const key = Symbol.for(${encodeJsonString(attemptsSymbol)});
  const attempts = (Reflect.get(globalThis, key) ?? 0) + 1;
  Reflect.set(globalThis, key, attempts);
  if (attempts <= ${String(failThroughAttempt)}) throw new Error("startup activation failed");
  api.registerCommand(
    {
      id: ${encodeJsonString(id)},
      label: ${encodeJsonString(label)},
      surfaces: ["web", "desktop"]
    },
    () => ({ message: ${encodeJsonString(label)}, tone: "success" })
  );
}
`;

const gatedCommandPluginSource = (
  id: string,
  gateEnabledSymbol: string,
  startedSymbol: string,
  releaseSymbol: string,
) => `
export default async function activate(api) {
  if (Reflect.get(globalThis, Symbol.for(${encodeJsonString(gateEnabledSymbol)})) === true) {
    const markStarted = Reflect.get(globalThis, Symbol.for(${encodeJsonString(startedSymbol)}));
    if (typeof markStarted === "function") markStarted();
    await new Promise((resolve) => {
      Reflect.set(globalThis, Symbol.for(${encodeJsonString(releaseSymbol)}), resolve);
    });
  }
  api.registerCommand(
    { id: ${encodeJsonString(id)}, label: "gated", surfaces: ["web"] },
    () => ({ message: "gated", tone: "success" })
  );
}
`;

const pluginSourceWithHelper = `
import { message } from "./message.mjs";

export default function activate(api) {
  api.registerCommand(
    {
      id: "${commandId}",
      label: "External runtime status",
      surfaces: ["web", "desktop", "mobile"]
    },
    () => ({ message, tone: "success" })
  );
}
`;

const pluginSourceWithRetirementGate = (startedSymbol: string, releaseSymbol: string) => `
export default function activate(api) {
  api.registerCommand(
    {
      id: "${commandId}",
      label: "External runtime status",
      surfaces: ["web", "desktop", "mobile"]
    },
    () => ({ message: "retirement gate", tone: "success" })
  );
  api.onDispose(() => new Promise((resolve) => {
    const markStarted = Reflect.get(globalThis, Symbol.for(${encodeJsonString(startedSymbol)}));
    if (typeof markStarted === "function") markStarted();
    Reflect.set(globalThis, Symbol.for(${encodeJsonString(releaseSymbol)}), resolve);
  }));
}
`;

const pluginSourceWithCleanupFailure = `
export default function activate(api) {
  api.registerCommand(
    {
      id: "${commandId}",
      label: "External runtime status",
      surfaces: ["web", "desktop", "mobile"]
    },
    () => ({ message: "cleanup failure", tone: "success" })
  );
  api.onDispose(() => { throw new Error("cleanup exploded"); });
}
`;

interface EnvironmentLayerOptions {
  readonly persistenceFailures?: { remaining: number };
  readonly startupFailure?: boolean;
}

const makeEnvironmentLayer = (baseDir: string, options?: EnvironmentLayerOptions) => {
  const configLayer = Layer.fresh(ServerConfig.layerTest(process.cwd(), baseDir));
  const capabilityBrokerLayer = PluginHostCapabilityBroker.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(configLayer),
  );
  const liveSettingsLayer = ServerSettings.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(configLayer),
  );
  const persistenceFailures = options?.persistenceFailures;
  const startupFailure = options?.startupFailure === true;
  const settingsLayer =
    persistenceFailures === undefined && !startupFailure
      ? liveSettingsLayer
      : Layer.effect(
          ServerSettings.ServerSettingsService,
          Effect.gen(function* () {
            const live = yield* ServerSettings.ServerSettingsService;
            return ServerSettings.ServerSettingsService.of({
              ...live,
              start: startupFailure
                ? Effect.fail(
                    new ServerSettingsError({
                      cause: new Error("injected startup failure"),
                      operation: "read-file",
                      settingsPath: `${baseDir}/userdata/settings.json`,
                    }),
                  )
                : live.start,
              setEnabledPluginIds: (ids) =>
                Effect.suspend(() => {
                  if (persistenceFailures !== undefined && persistenceFailures.remaining > 0) {
                    persistenceFailures.remaining -= 1;
                    return Effect.fail(
                      new ServerSettingsError({
                        cause: new Error("injected persistence failure"),
                        operation: "write-file",
                        settingsPath: `${baseDir}/userdata/settings.json`,
                      }),
                    );
                  }
                  return live.setEnabledPluginIds(ids);
                }),
            });
          }),
        ).pipe(Layer.provide(liveSettingsLayer));

  return PluginPackageManager.layer.pipe(
    Layer.provideMerge(PluginCommandCatalog.layer),
    Layer.provideMerge(capabilityBrokerLayer),
    Layer.provideMerge(settingsLayer),
    Layer.provideMerge(configLayer),
  );
};

const useEnvironment = <A, E>(
  baseDir: string,
  effect: Effect.Effect<
    A,
    E,
    PluginPackageManager.PluginPackageManager | PluginCommandCatalog.PluginCommandCatalog
  >,
  options?: EnvironmentLayerOptions,
) => Effect.scoped(effect.pipe(Effect.provide(makeEnvironmentLayer(baseDir, options))));

it.layer(NodeServices.layer)("plugin package lifecycle", (it) => {
  it.effect("grants declared host capabilities and preserves plugin-owned state", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-host-capability-test-",
      });
      const packageDirectory = `${baseDir}/userdata/plugins/${packageId}`;
      yield* fileSystem.makeDirectory(packageDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        `${packageDirectory}/t3-plugin.json`,
        encodeManifest({ ...manifest, permissions: ["state:read-write"] }),
      );
      yield* fileSystem.writeFileString(
        `${packageDirectory}/index.mjs`,
        statefulCommandPluginSource(commandId),
      );

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
          const enabled = yield* manager.enable(packageId);
          expect(enabled.packages[0]).toMatchObject({
            permissions: ["state:read-write"],
            grantedPermissions: ["state:read-write"],
          });
          const first = yield* catalog.list;
          expect(yield* catalog.invoke({ generation: first.generation, id: commandId })).toEqual({
            message: "1",
            tone: "success",
          });
        }),
      );

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
          const restored = yield* catalog.list;
          expect(yield* catalog.invoke({ generation: restored.generation, id: commandId })).toEqual(
            {
              message: "2",
              tone: "success",
            },
          );
        }),
      );
    }),
  );

  it.effect("requires disable and re-enable before granting added host permissions", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-permission-escalation-test-",
      });
      const packageDirectory = `${baseDir}/userdata/plugins/${packageId}`;
      yield* fileSystem.makeDirectory(packageDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        `${packageDirectory}/t3-plugin.json`,
        encodeManifest(manifest),
      );
      yield* fileSystem.writeFileString(
        `${packageDirectory}/index.mjs`,
        commandPluginSource(commandId, "old generation"),
      );

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
          yield* manager.enable(packageId);
          const oldCatalog = yield* catalog.list;

          yield* fileSystem.writeFileString(
            `${packageDirectory}/t3-plugin.json`,
            encodeManifest({ ...manifest, permissions: ["state:read-write"] }),
          );
          yield* fileSystem.writeFileString(
            `${packageDirectory}/index.mjs`,
            statefulCommandPluginSource(commandId),
          );

          const reload = yield* Effect.exit(manager.reload(packageId));
          expect(reload._tag).toBe("Failure");
          expect(yield* catalog.list).toBe(oldCatalog);
          expect(yield* manager.status).toMatchObject({
            packages: [
              {
                state: "error",
                permissions: ["state:read-write"],
                grantedPermissions: [],
                error: expect.stringContaining("permission approval required"),
              },
            ],
          });

          yield* manager.disable(packageId);
          yield* manager.enable(packageId);
          const approved = yield* catalog.list;
          expect(yield* catalog.invoke({ generation: approved.generation, id: commandId })).toEqual(
            {
              message: "1",
              tone: "success",
            },
          );
        }),
      );
    }),
  );

  it.effect("keeps the environment available when package manager startup fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-startup-failure-test-",
      });

      const exit = yield* Effect.exit(
        useEnvironment(
          baseDir,
          Effect.gen(function* () {
            const manager = yield* PluginPackageManager.PluginPackageManager;
            return yield* Effect.exit(manager.status);
          }),
          { startupFailure: true },
        ),
      );

      expect(exit._tag).toBe("Success");
      if (exit._tag === "Success") {
        expect(exit.value._tag).toBe("Failure");
      }
    }),
  );

  it.effect("retries a transient package activation failure during startup", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-startup-retry-test-",
      });
      const packageDirectory = `${baseDir}/userdata/plugins/${packageId}`;
      const attemptsSymbol = nextTestSymbol("t3code-plugin-startup-retry");
      yield* fileSystem.makeDirectory(packageDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        `${packageDirectory}/t3-plugin.json`,
        encodeManifest(manifest),
      );
      yield* fileSystem.writeFileString(
        `${packageDirectory}/index.mjs`,
        retryingCommandPluginSource(commandId, "startup retry", attemptsSymbol),
      );
      Reflect.set(globalThis, Symbol.for(attemptsSymbol), 1);

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          yield* manager.enable(packageId);
        }),
      );
      Reflect.set(globalThis, Symbol.for(attemptsSymbol), 0);

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
          expect(yield* manager.status).toMatchObject({
            packages: [{ id: packageId, state: "active" }],
          });
          expect((yield* catalog.list).commands.map(({ id }) => id)).toContain(commandId);
        }),
      );
      expect(Reflect.get(globalThis, Symbol.for(attemptsSymbol))).toBe(2);
      Reflect.deleteProperty(globalThis, Symbol.for(attemptsSymbol));
    }),
  );

  it.effect("continues startup after a persistent package failure", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-startup-isolation-test-",
      });
      const failingId = "com.acme.a-failing";
      const workingId = "com.acme.z-working";
      const failingCommandId = "acme.failing.status";
      const workingCommandId = "acme.working.status";
      const attemptsSymbol = nextTestSymbol("t3code-plugin-startup-failing");
      for (const [id, declaredCommand] of [
        [failingId, failingCommandId],
        [workingId, workingCommandId],
      ] as const) {
        const directory = `${baseDir}/userdata/plugins/${id}`;
        yield* fileSystem.makeDirectory(directory, { recursive: true });
        yield* fileSystem.writeFileString(
          `${directory}/t3-plugin.json`,
          encodeManifest({ ...manifest, id, contributes: { commands: [declaredCommand] } }),
        );
        yield* fileSystem.writeFileString(
          `${directory}/index.mjs`,
          id === failingId
            ? retryingCommandPluginSource(declaredCommand, id, attemptsSymbol, 2)
            : commandPluginSource(declaredCommand, id),
        );
      }
      Reflect.set(globalThis, Symbol.for(attemptsSymbol), 2);

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          yield* manager.enable(failingId);
          yield* manager.enable(workingId);
        }),
      );
      Reflect.set(globalThis, Symbol.for(attemptsSymbol), 0);

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
          const status = yield* manager.status;
          expect(status.packages.find(({ id }) => id === failingId)).toMatchObject({
            enabled: true,
            state: "error",
            error: "startup activation failed",
          });
          expect(status.packages.find(({ id }) => id === workingId)).toMatchObject({
            enabled: true,
            state: "active",
          });
          const commandIds = (yield* catalog.list).commands.map(({ id }) => id);
          expect(commandIds).not.toContain(failingCommandId);
          expect(commandIds).toContain(workingCommandId);
        }),
      );
      expect(Reflect.get(globalThis, Symbol.for(attemptsSymbol))).toBe(2);
      Reflect.deleteProperty(globalThis, Symbol.for(attemptsSymbol));
    }),
  );

  it.effect("preserves interruption during startup activation", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-startup-interruption-test-",
      });
      const packageDirectory = `${baseDir}/userdata/plugins/${packageId}`;
      const gateEnabledSymbol = nextTestSymbol("t3code-plugin-startup-gate");
      const startedSymbol = `${gateEnabledSymbol}-started`;
      const releaseSymbol = `${gateEnabledSymbol}-release`;
      yield* fileSystem.makeDirectory(packageDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        `${packageDirectory}/t3-plugin.json`,
        encodeManifest(manifest),
      );
      yield* fileSystem.writeFileString(
        `${packageDirectory}/index.mjs`,
        gatedCommandPluginSource(commandId, gateEnabledSymbol, startedSymbol, releaseSymbol),
      );
      Reflect.set(globalThis, Symbol.for(gateEnabledSymbol), false);

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          yield* manager.enable(packageId);
        }),
      );

      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      Reflect.set(globalThis, Symbol.for(gateEnabledSymbol), true);
      Reflect.set(globalThis, Symbol.for(startedSymbol), markStarted);
      const startup = yield* Effect.forkChild(
        useEnvironment(baseDir, Effect.asVoid(PluginPackageManager.PluginPackageManager)),
      );
      yield* Effect.promise(() => started);
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(startup));
      yield* Effect.yieldNow;
      const release = Reflect.get(globalThis, Symbol.for(releaseSymbol));
      expect(release).toBeTypeOf("function");
      if (typeof release === "function") release();
      yield* Fiber.join(interrupting);
      const exit = yield* Fiber.await(startup);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true);

      for (const symbol of [gateEnabledSymbol, startedSymbol, releaseSymbol]) {
        Reflect.deleteProperty(globalThis, Symbol.for(symbol));
      }
    }),
  );

  it.effect("loads the committed external runtime-status example without rebuilding", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-example-test-",
      });
      const exampleId = "com.t3code.runtime-status-example";
      const exampleCommandId = "example.runtime-status";
      yield* fileSystem.makeDirectory(`${baseDir}/userdata/plugins`, { recursive: true });
      yield* fileSystem.copy(
        path.resolve(import.meta.dirname, "../../../../examples/plugins/runtime-status"),
        `${baseDir}/userdata/plugins/${exampleId}`,
      );

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
          yield* manager.enable(exampleId);
          const listed = yield* catalog.list;
          expect(
            yield* catalog.invoke({ generation: listed.generation, id: exampleCommandId }),
          ).toEqual({ message: "external plugin runtime is active.", tone: "success" });
        }),
      );
    }),
  );

  it.effect("discovers, enables, restarts, and cleanly disables an external package", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-test-",
      });
      const packageDirectory = `${baseDir}/userdata/plugins/${packageId}`;
      yield* fileSystem.makeDirectory(packageDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        `${packageDirectory}/t3-plugin.json`,
        encodeManifest(manifest),
      );
      yield* fileSystem.writeFileString(
        `${packageDirectory}/index.mjs`,
        pluginSource(`${packageDirectory}/disposed.log`),
      );

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;

          expect((yield* Effect.exit(manager.reload(packageId)))._tag).toBe("Failure");
          expect(yield* manager.status).toMatchObject({
            packages: [{ id: packageId, enabled: false, state: "disabled" }],
          });

          expect(yield* manager.enable(packageId)).toMatchObject({
            packages: [{ id: packageId, enabled: true, state: "active" }],
          });
          const listed = yield* catalog.list;
          expect(listed.commands.map((command) => command.id)).toContain(commandId);
          expect(yield* catalog.invoke({ generation: listed.generation, id: commandId })).toEqual({
            message: "External plugin runtime is active.",
            tone: "success",
          });
        }),
      );

      expect(
        decodePersistedEnabledPlugins(
          yield* fileSystem.readFileString(`${baseDir}/userdata/settings.json`),
        ).enabledPluginIds,
      ).toEqual([packageId]);

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;

          expect(yield* manager.status).toMatchObject({
            packages: [{ id: packageId, enabled: true, state: "active" }],
          });
          expect((yield* catalog.list).commands.map((command) => command.id)).toContain(commandId);

          expect(yield* manager.disable(packageId)).toMatchObject({
            packages: [{ id: packageId, enabled: false, state: "disabled" }],
          });
          expect((yield* catalog.list).commands.map((command) => command.id)).not.toContain(
            commandId,
          );
        }),
      );

      const persisted = yield* fileSystem.readFileString(`${baseDir}/userdata/settings.json`);
      expect(decodePersistedEnabledPlugins(persisted).enabledPluginIds ?? []).toEqual([]);
      expect(yield* fileSystem.readFileString(`${packageDirectory}/disposed.log`)).toBe(
        "disposed\ndisposed\n",
      );
    }),
  );

  it.effect("maps package dependencies into deterministic activation and blocked status", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-dependency-test-",
      });
      const providerId = "com.acme.database";
      const consumerId = "com.acme.issues";
      const providerCommandId = "acme.database.status";
      const consumerCommandId = "acme.issues.create";
      const databaseCapability = "acme.database@1";
      const providerManifest = {
        ...manifest,
        id: providerId,
        provides: [databaseCapability],
        contributes: { commands: [providerCommandId] },
      } as const;
      const consumerManifest = {
        ...manifest,
        id: consumerId,
        requires: [databaseCapability],
        contributes: { commands: [consumerCommandId] },
      } as const;
      for (const [id, packageManifest, source] of [
        [providerId, providerManifest, commandPluginSource(providerCommandId, "database provider")],
        [consumerId, consumerManifest, commandPluginSource(consumerCommandId, "issues consumer")],
      ] as const) {
        const directory = `${baseDir}/userdata/plugins/${id}`;
        yield* fileSystem.makeDirectory(directory, { recursive: true });
        yield* fileSystem.writeFileString(
          `${directory}/t3-plugin.json`,
          encodeManifest(packageManifest),
        );
        yield* fileSystem.writeFileString(`${directory}/index.mjs`, source);
      }

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;

          const blocked = yield* manager.enable(consumerId);
          expect(blocked.packages.find(({ id }) => id === consumerId)).toMatchObject({
            enabled: true,
            state: "blocked",
            error: `Missing dependency: ${databaseCapability}`,
          });
          expect((yield* catalog.list).commands.map(({ id }) => id)).not.toContain(
            consumerCommandId,
          );

          const active = yield* manager.enable(providerId);
          expect(active.packages.find(({ id }) => id === providerId)).toMatchObject({
            enabled: true,
            state: "active",
          });
          expect(active.packages.find(({ id }) => id === consumerId)).toMatchObject({
            enabled: true,
            state: "active",
          });
          const commandIds = (yield* catalog.list).commands.map(({ id }) => id);
          expect(commandIds.indexOf(providerCommandId)).toBeLessThan(
            commandIds.indexOf(consumerCommandId),
          );

          const providerDisabled = yield* manager.disable(providerId);
          expect(providerDisabled.packages.find(({ id }) => id === providerId)).toMatchObject({
            enabled: false,
            state: "disabled",
          });
          expect(providerDisabled.packages.find(({ id }) => id === consumerId)).toMatchObject({
            enabled: true,
            state: "blocked",
            error: `Missing dependency: ${databaseCapability}`,
          });
          const remainingCommandIds = (yield* catalog.list).commands.map(({ id }) => id);
          expect(remainingCommandIds).not.toContain(providerCommandId);
          expect(remainingCommandIds).not.toContain(consumerCommandId);
        }),
      );
    }),
  );

  it.effect("keeps the previous generation when import or activation fails during reload", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-rollback-test-",
      });
      const packageDirectory = `${baseDir}/userdata/plugins/${packageId}`;
      yield* fileSystem.makeDirectory(packageDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        `${packageDirectory}/t3-plugin.json`,
        encodeManifest(manifest),
      );
      yield* fileSystem.writeFileString(`${packageDirectory}/index.mjs`, pluginSourceWithHelper);
      yield* fileSystem.writeFileString(
        `${packageDirectory}/message.mjs`,
        'export const message = "generation one";\n',
      );

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
          yield* manager.enable(packageId);
          const committed = yield* catalog.list;
          const manifestV2 = { ...manifest, version: "2.0.0" as const };
          yield* fileSystem.writeFileString(
            `${packageDirectory}/t3-plugin.json`,
            encodeManifest(manifestV2),
          );

          yield* fileSystem.writeFileString(`${packageDirectory}/index.mjs`, "export default (");
          expect((yield* Effect.exit(manager.reload(packageId)))._tag).toBe("Failure");
          expect(yield* catalog.list).toBe(committed);
          expect(
            yield* catalog.invoke({ generation: committed.generation, id: commandId }),
          ).toEqual({ message: "generation one", tone: "success" });

          yield* fileSystem.writeFileString(
            `${packageDirectory}/index.mjs`,
            "export default function activate() { throw new Error('activation failed') }",
          );
          expect((yield* Effect.exit(manager.reload(packageId)))._tag).toBe("Failure");
          expect(yield* catalog.list).toBe(committed);
          expect(yield* manager.status).toMatchObject({
            packages: [
              {
                id: packageId,
                version: "1.0.0",
                enabled: true,
                state: "error",
                error: "activation failed",
              },
            ],
          });
          yield* manager.enable(packageId);
          expect(yield* manager.status).toMatchObject({
            packages: [{ id: packageId, state: "error", error: "activation failed" }],
          });

          yield* fileSystem.writeFileString(
            `${packageDirectory}/index.mjs`,
            pluginSourceWithHelper,
          );
          yield* fileSystem.writeFileString(
            `${packageDirectory}/message.mjs`,
            'export const message = "generation two";\n',
          );
          yield* manager.reload(packageId);
          expect(yield* manager.status).toMatchObject({
            packages: [{ id: packageId, version: "2.0.0", enabled: true, state: "active" }],
          });
          const reloaded = yield* catalog.list;
          expect(reloaded.generation).toBeGreaterThan(committed.generation);
          expect(yield* catalog.invoke({ generation: reloaded.generation, id: commandId })).toEqual(
            {
              message: "generation two",
              tone: "success",
            },
          );
        }),
      );
    }),
  );

  it.effect("rejects symbolic links before importing a trusted local package", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-symlink-test-",
      });
      const sourceDirectory = `${baseDir}/linked-package-source`;
      const packageDirectory = `${baseDir}/userdata/plugins/${packageId}`;
      yield* fileSystem.makeDirectory(sourceDirectory, { recursive: true });
      yield* fileSystem.makeDirectory(`${baseDir}/userdata/plugins`, { recursive: true });
      yield* fileSystem.writeFileString(
        `${sourceDirectory}/t3-plugin.json`,
        encodeManifest(manifest),
      );
      yield* fileSystem.writeFileString(
        `${sourceDirectory}/index.mjs`,
        pluginSource(`${sourceDirectory}/disposed.log`),
      );
      yield* fileSystem.symlink(sourceDirectory, packageDirectory);

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
          expect((yield* Effect.exit(manager.enable(packageId)))._tag).toBe("Failure");
          expect((yield* catalog.list).commands.map((command) => command.id)).not.toContain(
            commandId,
          );
          expect(yield* manager.status).toMatchObject({
            packages: [{ id: packageId, enabled: false, state: "error" }],
          });
        }),
      );
    }),
  );

  it.effect("keeps runtime and persisted enablement aligned when settings writes fail", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-persistence-test-",
      });
      const packageDirectory = `${baseDir}/userdata/plugins/${packageId}`;
      yield* fileSystem.makeDirectory(packageDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        `${packageDirectory}/t3-plugin.json`,
        encodeManifest({ ...manifest, permissions: ["state:read-write"] }),
      );
      yield* fileSystem.writeFileString(
        `${packageDirectory}/index.mjs`,
        pluginSource(`${packageDirectory}/disposed.log`),
      );

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
          expect((yield* Effect.exit(manager.enable(packageId)))._tag).toBe("Failure");
          expect((yield* catalog.list).commands.map((command) => command.id)).not.toContain(
            commandId,
          );
          expect(yield* manager.status).toMatchObject({
            packages: [{ id: packageId, enabled: false, grantedPermissions: [] }],
          });
        }),
        { persistenceFailures: { remaining: 1 } },
      );

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          yield* manager.enable(packageId);
        }),
      );

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
          expect((yield* Effect.exit(manager.disable(packageId)))._tag).toBe("Failure");
          expect((yield* catalog.list).commands.map((command) => command.id)).toContain(commandId);
          expect(yield* manager.status).toMatchObject({
            packages: [{ id: packageId, enabled: true, state: "active" }],
          });
        }),
        { persistenceFailures: { remaining: 1 } },
      );
    }),
  );

  it.effect("reports an invalid local manifest without blocking the package service", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-invalid-test-",
      });
      const invalidDirectory = `${baseDir}/userdata/plugins/broken-package`;
      yield* fileSystem.makeDirectory(invalidDirectory, { recursive: true });
      yield* fileSystem.writeFileString(`${invalidDirectory}/t3-plugin.json`, "{}");

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const status = yield* manager.status;
          expect(status).toMatchObject({
            errors: [{ directory: "broken-package" }],
            packages: [],
          });
          expect(status.errors[0]?.error).toContain("manifestVersion");
          expect(status.errors[0]?.error).not.toContain("Cause([");
        }),
      );
    }),
  );

  it.effect("reports cleanup failures after disabling the committed package", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-cleanup-test-",
      });
      const packageDirectory = `${baseDir}/userdata/plugins/${packageId}`;
      yield* fileSystem.makeDirectory(packageDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        `${packageDirectory}/t3-plugin.json`,
        encodeManifest(manifest),
      );
      yield* fileSystem.writeFileString(
        `${packageDirectory}/index.mjs`,
        pluginSourceWithCleanupFailure,
      );

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
          yield* manager.enable(packageId);
          expect(yield* manager.disable(packageId)).toMatchObject({
            packages: [
              {
                id: packageId,
                enabled: false,
                state: "error",
                error: "cleanup exploded",
              },
            ],
          });
          expect((yield* catalog.list).commands.map((command) => command.id)).not.toContain(
            commandId,
          );
        }),
      );
    }),
  );

  it.effect("finishes disable bookkeeping when interrupted after the runtime commits", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-package-interruption-test-",
      });
      const packageDirectory = `${baseDir}/userdata/plugins/${packageId}`;
      const startedSymbol = `t3.test.plugin.retirement.started.${baseDir}`;
      const releaseSymbol = `t3.test.plugin.retirement.${baseDir}`;
      let markRetirementStarted!: () => void;
      const retirementStarted = new Promise<void>((resolve) => {
        markRetirementStarted = resolve;
      });
      Reflect.set(globalThis, Symbol.for(startedSymbol), markRetirementStarted);
      yield* fileSystem.makeDirectory(packageDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        `${packageDirectory}/t3-plugin.json`,
        encodeManifest(manifest),
      );
      yield* fileSystem.writeFileString(
        `${packageDirectory}/index.mjs`,
        pluginSourceWithRetirementGate(startedSymbol, releaseSymbol),
      );

      yield* useEnvironment(
        baseDir,
        Effect.gen(function* () {
          const manager = yield* PluginPackageManager.PluginPackageManager;
          const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
          yield* manager.enable(packageId);
          const disabling = yield* Effect.forkChild(manager.disable(packageId));
          yield* Effect.promise(() => retirementStarted);

          const interrupting = yield* Effect.forkChild(Fiber.interrupt(disabling));
          yield* Effect.yieldNow;
          const release = Reflect.get(globalThis, Symbol.for(releaseSymbol));
          expect(release).toBeTypeOf("function");
          if (typeof release === "function") release();
          yield* Fiber.join(interrupting);
          expect(
            yield* fileSystem.exists(`${baseDir}/userdata/plugin-cache/${packageId}/0`).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("1 millis"),
                until: (exists) => !exists,
              }),
              Effect.timeout("2 seconds"),
            ),
          ).toBe(false);
          Reflect.deleteProperty(globalThis, Symbol.for(startedSymbol));
          Reflect.deleteProperty(globalThis, Symbol.for(releaseSymbol));

          expect(yield* manager.status).toMatchObject({
            packages: [{ id: packageId, enabled: false, state: "disabled" }],
          });
          expect((yield* catalog.list).commands.map((command) => command.id)).not.toContain(
            commandId,
          );
        }),
      );
      const persisted = yield* fileSystem.readFileString(`${baseDir}/userdata/settings.json`);
      expect(decodePersistedEnabledPlugins(persisted).enabledPluginIds ?? []).toEqual([]);
    }),
  );
});
