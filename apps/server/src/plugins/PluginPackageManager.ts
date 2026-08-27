import {
  PluginCommandInvocationResult,
  PluginPackageNotFoundError,
  PluginPackageOperationError,
  type PluginPackageDiscoveryError,
  type PluginPackageOperation,
  type PluginPackageStatus,
  type PluginPackageStatusSnapshot,
  type PluginUiSetting,
  PluginUiSettingError,
} from "@t3tools/contracts";
import type { PluginActivationContext, PluginDefinition } from "@t3tools/plugin-runtime";
import {
  PluginManifest,
  type PluginManifest as PluginManifestType,
} from "@t3tools/plugin-runtime/manifest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PluginCommandCatalog from "./PluginCommandCatalog.ts";
import * as PluginHostCapabilityBroker from "./PluginHostCapabilityBroker.ts";
import { compilePluginTypeScriptEntrypoint } from "./PluginTypeScriptCompiler.ts";
import * as PluginWorkerSupervisor from "./PluginWorkerSupervisor.ts";

const MANIFEST_FILE_NAME = "t3-plugin.json";
const COMMAND_CAPABILITY = "t3.commands@1";
const UI_CAPABILITY = "t3.ui@1";
const NOTIFICATION_PERMISSION = "notifications:send";

interface DiscoveredPackage {
  readonly directory: string;
  readonly manifest: PluginManifestType;
}

interface DiscoveryResult {
  readonly errors: ReadonlyArray<PluginPackageDiscoveryError>;
  readonly packages: ReadonlyMap<string, DiscoveredPackage>;
}

class PluginPackageMissingCapabilityError extends Schema.TaggedErrorClass<PluginPackageMissingCapabilityError>()(
  "PluginPackageMissingCapabilityError",
  { capability: Schema.String, id: Schema.String },
) {
  override get message(): string {
    return `Manifest does not declare capability ${this.capability}`;
  }
}

class PluginPackageUndeclaredCommandError extends Schema.TaggedErrorClass<PluginPackageUndeclaredCommandError>()(
  "PluginPackageUndeclaredCommandError",
  { commandId: Schema.String, id: Schema.String },
) {
  override get message(): string {
    return `Command ${this.commandId} is not declared in the manifest`;
  }
}

class PluginPackageUiNamespaceError extends Schema.TaggedErrorClass<PluginPackageUiNamespaceError>()(
  "PluginPackageUiNamespaceError",
  { id: Schema.String, reference: Schema.String },
) {
  override get message(): string {
    return `Plugin UI contribution ${this.reference} is outside namespace ${this.id}`;
  }
}

class PluginPackageUndeclaredUiError extends Schema.TaggedErrorClass<PluginPackageUndeclaredUiError>()(
  "PluginPackageUndeclaredUiError",
  { id: Schema.String, reference: Schema.String, slot: Schema.String },
) {
  override get message(): string {
    return `Plugin UI contribution ${this.slot}/${this.reference} is not declared by ${this.id}`;
  }
}

class PluginPackageUiPermissionError extends Schema.TaggedErrorClass<PluginPackageUiPermissionError>()(
  "PluginPackageUiPermissionError",
  { id: Schema.String, permission: Schema.String },
) {
  override get message(): string {
    return `Plugin ${this.id} UI requires host permission ${this.permission}`;
  }
}

class PluginPackageUiCommandReferenceError extends Schema.TaggedErrorClass<PluginPackageUiCommandReferenceError>()(
  "PluginPackageUiCommandReferenceError",
  { commandId: Schema.String, id: Schema.String, reference: Schema.String },
) {
  override get message(): string {
    return `Plugin UI contribution ${this.reference} references unregistered command ${this.commandId}`;
  }
}

class PluginPackageUiActionReferenceError extends Schema.TaggedErrorClass<PluginPackageUiActionReferenceError>()(
  "PluginPackageUiActionReferenceError",
  { actionId: Schema.String, id: Schema.String, reference: Schema.String },
) {
  override get message(): string {
    return `Plugin UI contribution ${this.reference} references uncontributed action ${this.actionId}`;
  }
}

class PluginPackageCompositionSourceError extends Schema.TaggedErrorClass<PluginPackageCompositionSourceError>()(
  "PluginPackageCompositionSourceError",
  { id: Schema.String, ruleId: Schema.String, slot: Schema.String, sourceId: Schema.String },
) {
  override get message(): string {
    return `Plugin composition rule ${this.ruleId} references undeclared source ${this.slot}/${this.sourceId}`;
  }
}

interface LoadedDefinition {
  readonly cacheDirectory: string;
  readonly definition: PluginDefinition;
  readonly retired: Promise<void>;
  readonly worker: PluginWorkerSupervisor.SupervisedPluginWorker;
  readonly host: PluginHostCapabilityBroker.PluginHostApi;
}

const decodeManifestJson = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginManifest));
const decodeInvocationResult = Schema.decodeUnknownEffect(PluginCommandInvocationResult);
const isPluginPackageOperationError = Schema.is(PluginPackageOperationError);

const detailFromUnknown = (error: unknown): string => {
  if (PluginWorkerSupervisor.isPluginWorkerError(error)) return error.detail;
  if (isPluginPackageOperationError(error)) {
    if (error.detail !== undefined) return error.detail;
    if (error.cause !== undefined) return detailFromUnknown(error.cause);
  }
  if (typeof error === "object" && error !== null && "cause" in error) {
    const cause = error.cause;
    if (cause !== undefined && cause !== error) return detailFromUnknown(cause);
  }
  const detail = error instanceof Error ? error.message : String(error);
  const trimmed = detail.trim();
  return (trimmed.length === 0 ? "unknown error" : trimmed).slice(0, 2_000);
};

const detailFromCause = (cause: Cause.Cause<unknown>): string =>
  detailFromUnknown(Cause.squash(cause));

const operationError = (
  operation: PluginPackageOperation,
  error: unknown,
  id?: string,
): PluginPackageOperationError => {
  if (isPluginPackageOperationError(error)) return error;
  return new PluginPackageOperationError({
    ...(id === undefined ? {} : { id }),
    operation,
    ...(typeof error === "string" ? { detail: error } : { cause: error }),
  });
};

const makeDefinition = (
  discovered: DiscoveredPackage,
  worker: PluginWorkerSupervisor.SupervisedPluginWorker,
  onRetired: () => void,
): PluginDefinition => {
  const declaredCommands = new Set(discovered.manifest.contributes?.commands ?? []);
  const ui = worker.ui;
  const uiEntries = [
    ...ui.settings,
    ...ui.navigation,
    ...ui.views,
    ...ui.cards,
    ...ui.statusItems,
    ...ui.composerActions,
    ...ui.contextualActions,
  ];
  if (uiEntries.length > 0 && !discovered.manifest.capabilities.includes(UI_CAPABILITY)) {
    throw new PluginPackageMissingCapabilityError({
      id: discovered.manifest.id,
      capability: UI_CAPABILITY,
    });
  }
  const declaredUi = {
    settings: new Set(discovered.manifest.contributes?.settings ?? []),
    navigation: new Set(discovered.manifest.contributes?.navigation ?? []),
    views: new Set(discovered.manifest.contributes?.views ?? []),
    cards: new Set([
      ...(discovered.manifest.contributes?.cards ?? []),
      ...(discovered.manifest.contributes?.mobileCards ?? []),
    ]),
    statusItems: new Set(discovered.manifest.contributes?.statusItems ?? []),
    composerActions: new Set(discovered.manifest.contributes?.composerActions ?? []),
    contextualActions: new Set(discovered.manifest.contributes?.contextualActions ?? []),
  };
  const declaredCompositionSources = {
    commands: declaredCommands,
    ...declaredUi,
  };
  for (const rule of discovered.manifest.composition ?? []) {
    if (
      (rule.operation === "extend" || rule.operation === "replace") &&
      !declaredCompositionSources[rule.slot].has(rule.sourceId)
    ) {
      throw new PluginPackageCompositionSourceError({
        id: discovered.manifest.id,
        ruleId: rule.id,
        slot: rule.slot,
        sourceId: rule.sourceId,
      });
    }
  }
  for (const [slot, entries] of [
    ["settings", ui.settings],
    ["navigation", ui.navigation],
    ["views", ui.views],
    ["cards", ui.cards],
    ["statusItems", ui.statusItems],
    ["composerActions", ui.composerActions],
    ["contextualActions", ui.contextualActions],
  ] as const) {
    for (const entry of entries) {
      if (!entry.id.startsWith(`${discovered.manifest.id}.`)) {
        throw new PluginPackageUiNamespaceError({
          id: discovered.manifest.id,
          reference: entry.id,
        });
      }
      if (!declaredUi[slot].has(entry.id)) {
        throw new PluginPackageUndeclaredUiError({
          id: discovered.manifest.id,
          reference: entry.id,
          slot,
        });
      }
    }
  }
  if (
    ui.settings.length > 0 &&
    !(discovered.manifest.permissions ?? []).includes("settings:read-write")
  ) {
    throw new PluginPackageUiPermissionError({
      id: discovered.manifest.id,
      permission: "settings:read-write",
    });
  }
  const registeredCommandIds = new Set(worker.commands.map((command) => command.id));
  const actionIds = new Set(
    [...ui.composerActions, ...ui.contextualActions].map((action) => action.id),
  );
  const commandReferences = [
    ...ui.composerActions.map((action) => [action.id, action.commandId] as const),
    ...ui.contextualActions.map((action) => [action.id, action.commandId] as const),
    ...ui.views.flatMap((view) =>
      view.blocks.flatMap((block) =>
        "commandId" in block && block.commandId !== undefined
          ? ([[block.id, block.commandId]] as const)
          : [],
      ),
    ),
  ];
  for (const [reference, commandId] of commandReferences) {
    if (!registeredCommandIds.has(commandId)) {
      throw new PluginPackageUiCommandReferenceError({
        commandId,
        id: discovered.manifest.id,
        reference,
      });
    }
  }
  for (const card of ui.cards) {
    if (card.actionId !== undefined && !actionIds.has(card.actionId)) {
      throw new PluginPackageUiActionReferenceError({
        actionId: card.actionId,
        id: discovered.manifest.id,
        reference: card.id,
      });
    }
  }
  if (
    worker.commands.length > 0 &&
    !discovered.manifest.capabilities.includes(COMMAND_CAPABILITY)
  ) {
    throw new PluginPackageMissingCapabilityError({
      id: discovered.manifest.id,
      capability: COMMAND_CAPABILITY,
    });
  }
  for (const command of worker.commands) {
    if (!declaredCommands.has(command.id)) {
      throw new PluginPackageUndeclaredCommandError({
        id: discovered.manifest.id,
        commandId: command.id,
      });
    }
  }
  const providedCapabilities = Object.fromEntries(
    (discovered.manifest.provides ?? []).map((capability) => [
      capability,
      Object.freeze({ capability, packageId: discovered.manifest.id }),
    ]),
  );

  return {
    id: discovered.manifest.id,
    origin: discovered.manifest.forkOf === undefined ? "installed" : "local-fork",
    composition: [...(discovered.manifest.composition ?? [])],
    version: discovered.manifest.version,
    requires: [...(discovered.manifest.requires ?? [])],
    optional: [...(discovered.manifest.optional ?? [])],
    provides: providedCapabilities,
    activate(context: PluginActivationContext) {
      context.onDispose(onRetired);
      if (uiEntries.length > 0) {
        PluginCommandCatalog.registerPluginUi(context, discovered.manifest.id, ui);
      }
      for (const command of worker.commands) {
        PluginCommandCatalog.registerPluginCommand(context, {
          command,
          handler: (invocationContext) =>
            worker.invoke(command.id, invocationContext).pipe(
              Effect.flatMap(decodeInvocationResult),
              Effect.mapError(
                (cause) =>
                  new PluginCommandCatalog.PluginCommandExecutionError({
                    cause,
                    id: command.id,
                  }),
              ),
            ),
        });
      }
    },
  };
};

export class PluginPackageManager extends Context.Service<
  PluginPackageManager,
  {
    readonly status: Effect.Effect<PluginPackageStatusSnapshot, PluginPackageOperationError>;
    readonly enable: (
      id: string,
    ) => Effect.Effect<
      PluginPackageStatusSnapshot,
      PluginPackageNotFoundError | PluginPackageOperationError
    >;
    readonly disable: (
      id: string,
    ) => Effect.Effect<
      PluginPackageStatusSnapshot,
      PluginPackageNotFoundError | PluginPackageOperationError
    >;
    readonly reload: (
      id: string,
    ) => Effect.Effect<
      PluginPackageStatusSnapshot,
      PluginPackageNotFoundError | PluginPackageOperationError
    >;
    readonly settingRead: (
      pluginId: string,
      settingId: string,
    ) => Effect.Effect<Schema.Json | undefined, PluginUiSettingError>;
    readonly settingWrite: (
      pluginId: string,
      settingId: string,
      value: Schema.Json,
    ) => Effect.Effect<void, PluginUiSettingError>;
  }
>()("t3/plugins/PluginPackageManager") {}

export const make = Effect.fn("PluginPackageManager.make")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
  const hostCapabilities = yield* PluginHostCapabilityBroker.PluginHostCapabilityBroker;
  const workerSupervisor = yield* PluginWorkerSupervisor.PluginWorkerSupervisor;
  const semaphore = yield* Semaphore.make(1);
  const pluginsDirectory = path.join(config.stateDir, "plugins");
  const pluginCacheDirectory = path.join(config.stateDir, "plugin-cache");
  const activeDefinitions = new Map<string, PluginDefinition>();
  const activeCacheDirectories = new Map<string, string>();
  const activeManifests = new Map<string, PluginManifestType>();
  const activeWorkers = new Map<string, PluginWorkerSupervisor.SupervisedPluginWorker>();
  const activeHosts = new Map<string, PluginHostCapabilityBroker.PluginHostApi>();
  const activeRetirements = new Map<string, Promise<void>>();
  const packageErrors = new Map<string, string>();
  const dependencyBlocked = new Map<string, string>();
  let loadSequence = 0;

  const removeCacheDirectory = (directory: string) =>
    fileSystem
      .remove(directory, { recursive: true, force: true })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Failed to remove local plugin package cache", { directory, error }),
        ),
      );

  const stopWorker = (id: string, worker: PluginWorkerSupervisor.SupervisedPluginWorker) =>
    worker.dispose.pipe(
      Effect.catchCause((cause) => {
        const detail = detailFromCause(cause);
        packageErrors.set(id, detail);
        return Effect.logWarning("Failed to stop local plugin worker", { id, detail });
      }),
    );

  const validatePackageTree = Effect.fn("PluginPackageManager.validatePackageTree")(function* (
    discovered: DiscoveredPackage,
    operation: PluginPackageOperation,
  ) {
    const canonicalPluginsDirectory = yield* fileSystem
      .realPath(pluginsDirectory)
      .pipe(Effect.mapError((error) => operationError(operation, error, discovered.manifest.id)));
    const relativeRoot = path.relative(pluginsDirectory, discovered.directory);
    const pending: Array<readonly [lexical: string, expectedCanonical: string]> = [
      [discovered.directory, path.resolve(canonicalPluginsDirectory, relativeRoot)],
    ];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) continue;
      const [lexical, expectedCanonical] = current;
      const canonical = yield* fileSystem
        .realPath(lexical)
        .pipe(Effect.mapError((error) => operationError(operation, error, discovered.manifest.id)));
      if (path.normalize(canonical) !== path.normalize(expectedCanonical)) {
        return yield* operationError(
          operation,
          "symbolic links are not supported in trusted local plugin packages",
          discovered.manifest.id,
        );
      }
      const info = yield* fileSystem
        .stat(lexical)
        .pipe(Effect.mapError((error) => operationError(operation, error, discovered.manifest.id)));
      if (info.type !== "Directory") continue;
      const entries = yield* fileSystem
        .readDirectory(lexical)
        .pipe(Effect.mapError((error) => operationError(operation, error, discovered.manifest.id)));
      for (const entry of entries) {
        pending.push([path.join(lexical, entry), path.join(expectedCanonical, entry)]);
      }
    }
  });

  const discover = Effect.fn("PluginPackageManager.discover")(function* (
    operation: PluginPackageOperation,
  ) {
    yield* fileSystem
      .makeDirectory(pluginsDirectory, { recursive: true })
      .pipe(Effect.mapError((error) => operationError(operation, error)));
    const entries = yield* fileSystem
      .readDirectory(pluginsDirectory)
      .pipe(Effect.mapError((error) => operationError(operation, error)));
    const discovered = new Map<string, DiscoveredPackage>();
    const errors: Array<PluginPackageDiscoveryError> = [];

    for (const entry of [...entries].sort()) {
      const directory = path.join(pluginsDirectory, entry);
      const manifestPath = path.join(directory, MANIFEST_FILE_NAME);
      if (
        !(yield* fileSystem
          .exists(manifestPath)
          .pipe(Effect.mapError((error) => operationError(operation, error))))
      )
        continue;

      const decoded = yield* Effect.exit(
        fileSystem.readFileString(manifestPath).pipe(Effect.flatMap(decodeManifestJson)),
      );
      if (decoded._tag === "Failure") {
        errors.push({ directory: entry, error: detailFromCause(decoded.cause) });
        continue;
      }
      const packageManifest = decoded.value;
      if (packageManifest.entrypoints.server === undefined) {
        errors.push({ directory: entry, error: "manifest must define entrypoints.server" });
        continue;
      }
      if (discovered.has(packageManifest.id)) {
        errors.push({ directory: entry, error: `duplicate package id ${packageManifest.id}` });
        continue;
      }
      discovered.set(packageManifest.id, { directory, manifest: packageManifest });
    }

    return { errors, packages: discovered } satisfies DiscoveryResult;
  });

  const loadDefinition = Effect.fn("PluginPackageManager.loadDefinition")(function* (
    discovered: DiscoveredPackage,
    operation: PluginPackageOperation,
  ) {
    const baseHost = yield* hostCapabilities
      .open(discovered.manifest.id, discovered.manifest.permissions ?? [])
      .pipe(Effect.mapError((error) => operationError(operation, error, discovered.manifest.id)));
    const host: PluginHostCapabilityBroker.PluginHostApi = {
      ...baseHost,
      ui: {
        notify: (notification) => {
          if (!(discovered.manifest.permissions ?? []).includes(NOTIFICATION_PERMISSION)) {
            return Effect.fail(
              new PluginHostCapabilityBroker.PluginHostCapabilityError({
                pluginId: discovered.manifest.id,
                operation: "notification send",
                detail: `permission not declared: ${NOTIFICATION_PERMISSION}`,
              }),
            );
          }
          return catalog.notify(discovered.manifest.id, notification).pipe(
            Effect.mapError(
              (cause) =>
                new PluginHostCapabilityBroker.PluginHostCapabilityError({
                  pluginId: discovered.manifest.id,
                  operation: "notification send",
                  detail: "notification was rejected by the host",
                  cause,
                }),
            ),
          );
        },
      },
    };
    const serverEntrypoint = discovered.manifest.entrypoints.server;
    if (serverEntrypoint === undefined) {
      return yield* operationError(
        operation,
        "manifest must define entrypoints.server",
        discovered.manifest.id,
      );
    }
    yield* validatePackageTree(discovered, operation);
    const sourceEntrypointPath = path.resolve(discovered.directory, serverEntrypoint);
    const relativeEntrypoint = path.relative(discovered.directory, sourceEntrypointPath);
    if (
      relativeEntrypoint === ".." ||
      relativeEntrypoint.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeEntrypoint)
    ) {
      return yield* operationError(
        operation,
        "entrypoint escapes the package directory",
        discovered.manifest.id,
      );
    }

    const cacheDirectory = path.join(
      pluginCacheDirectory,
      discovered.manifest.id,
      String(loadSequence++),
    );
    yield* fileSystem
      .makeDirectory(path.dirname(cacheDirectory), { recursive: true })
      .pipe(Effect.mapError((error) => operationError(operation, error, discovered.manifest.id)));
    const copied = yield* Effect.exit(
      fileSystem
        .copy(discovered.directory, cacheDirectory)
        .pipe(Effect.mapError((error) => operationError(operation, error, discovered.manifest.id))),
    );
    if (copied._tag === "Failure") {
      yield* removeCacheDirectory(cacheDirectory);
      return yield* Effect.failCause(copied.cause);
    }
    const copiedEntrypointPath = path.resolve(cacheDirectory, serverEntrypoint);
    const compilation = yield* Effect.exit(
      compilePluginTypeScriptEntrypoint({
        packageDirectory: cacheDirectory,
        entrypointPath: copiedEntrypointPath,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError((error) => operationError(operation, error, discovered.manifest.id)),
      ),
    );
    if (compilation._tag === "Failure") {
      yield* removeCacheDirectory(cacheDirectory);
      return yield* Effect.failCause(compilation.cause);
    }
    const entrypointPath = compilation.value;

    const workerExit = yield* Effect.exit(
      workerSupervisor
        .start({
          pluginId: discovered.manifest.id,
          entrypointPath,
          workingDirectory: cacheDirectory,
          host,
        })
        .pipe(Effect.mapError((error) => operationError(operation, error, discovered.manifest.id))),
    );
    if (workerExit._tag === "Failure") {
      yield* removeCacheDirectory(cacheDirectory);
      return yield* Effect.failCause(workerExit.cause);
    }
    const worker = workerExit.value;

    let markRetired: () => void = () => {};
    const retired = new Promise<void>((resolve) => {
      markRetired = resolve;
    });
    const definitionExit = yield* Effect.exit(
      Effect.try({
        try: () => makeDefinition(discovered, worker, markRetired),
        catch: (error) => operationError(operation, error, discovered.manifest.id),
      }),
    );
    if (definitionExit._tag === "Failure") {
      yield* stopWorker(discovered.manifest.id, worker);
      yield* removeCacheDirectory(cacheDirectory);
      return yield* Effect.failCause(definitionExit.cause);
    }
    return {
      cacheDirectory,
      definition: definitionExit.value,
      retired,
      worker,
      host,
    } satisfies LoadedDefinition;
  });

  const definitionList = (replacement?: readonly [string, PluginDefinition | undefined]) => {
    const definitions = new Map(activeDefinitions);
    if (replacement !== undefined) {
      const [id, definition] = replacement;
      if (definition === undefined) definitions.delete(id);
      else definitions.set(id, definition);
    }
    return [...definitions.values()].sort((left, right) => left.id.localeCompare(right.id));
  };

  const readEnabledIds = settings.getSettings.pipe(
    Effect.map((current) => new Set(current.enabledPluginIds)),
  );

  const persistEnabledIds = (
    ids: ReadonlySet<string>,
    operation: PluginPackageOperation,
    id?: string,
  ) =>
    settings.setEnabledPluginIds([...ids].sort()).pipe(
      Effect.mapError((error) => operationError(operation, error, id)),
      Effect.asVoid,
    );

  const statusUnlocked = Effect.fn("PluginPackageManager.status")(function* (
    operation: PluginPackageOperation,
  ): Effect.fn.Return<PluginPackageStatusSnapshot, PluginPackageOperationError> {
    const [discovery, enabledIds, composition, grantSnapshot] = yield* Effect.all(
      [
        discover(operation),
        readEnabledIds.pipe(Effect.mapError((error) => operationError(operation, error))),
        catalog.composition,
        hostCapabilities.snapshot.pipe(
          Effect.mapError((error) => operationError(operation, error)),
        ),
      ],
      { concurrency: "unbounded" },
    );
    const discovered = discovery.packages;
    const errors = [...discovery.errors];
    const packages: Array<PluginPackageStatus> = [];
    const packageIds = new Set([...discovered.keys(), ...activeManifests.keys()]);

    for (const id of [...packageIds].sort()) {
      const activeManifest = activeManifests.get(id);
      const discoveredManifest = discovered.get(id)?.manifest;
      const packageManifest = activeManifest ?? discoveredManifest;
      if (packageManifest === undefined) continue;
      const requestedPermissions = [
        ...new Set((discoveredManifest ?? packageManifest).permissions ?? []),
      ].sort();
      const grantedPermissionSet = new Set(grantSnapshot.get(id) ?? []);
      const enabled = enabledIds.has(id);
      const active = composition.active.includes(id);
      const blocked = composition.blocked[id] ?? dependencyBlocked.get(id);
      const workerHealth = activeWorkers.get(id)?.health() ?? {
        state: "stopped" as const,
        restartCount: 0,
      };
      const runtimeError =
        workerHealth.state === "restarting" || workerHealth.state === "crashed"
          ? workerHealth.detail
          : undefined;
      const packageError = packageErrors.get(id);
      const error =
        packageError ??
        runtimeError ??
        blocked ??
        (enabled && !active ? "enabled package is not active" : undefined);
      const state =
        packageError !== undefined
          ? "error"
          : workerHealth.state === "crashed"
            ? "crashed"
            : workerHealth.state === "restarting"
              ? "restarting"
              : blocked !== undefined
                ? "blocked"
                : error !== undefined
                  ? "error"
                  : active
                    ? "active"
                    : "disabled";
      packages.push({
        id: packageManifest.id,
        version: packageManifest.version,
        origin:
          composition.origins[id] ??
          (packageManifest.forkOf === undefined ? "installed" : "local-fork"),
        ...(packageManifest.forkOf === undefined ? {} : { forkOf: packageManifest.forkOf }),
        apiVersion: packageManifest.apiVersion,
        enabled,
        state,
        runtimeState: workerHealth.state,
        restartCount: workerHealth.restartCount,
        capabilities: [...packageManifest.capabilities],
        permissions: requestedPermissions,
        grantedPermissions: requestedPermissions.filter((permission) =>
          grantedPermissionSet.has(permission),
        ),
        contributions: {
          commands: [...(packageManifest.contributes?.commands ?? [])],
          settings: [...(packageManifest.contributes?.settings ?? [])],
          navigation: [...(packageManifest.contributes?.navigation ?? [])],
          views: [...(packageManifest.contributes?.views ?? [])],
          cards: [
            ...(packageManifest.contributes?.cards ?? []),
            ...(packageManifest.contributes?.mobileCards ?? []),
          ],
          statusItems: [...(packageManifest.contributes?.statusItems ?? [])],
          composerActions: [...(packageManifest.contributes?.composerActions ?? [])],
          contextualActions: [...(packageManifest.contributes?.contextualActions ?? [])],
        },
        composition: composition.composition.filter((diagnostic) => diagnostic.pluginId === id),
        ...(error === undefined ? {} : { error }),
      });
    }

    for (const id of [...enabledIds].sort()) {
      if (!discovered.has(id)) {
        errors.push({
          directory: id,
          error: "enabled package was not discovered",
          pluginId: id,
        });
      }
    }

    return { errors, packages };
  });

  const transition = Effect.fn("PluginPackageManager.transition")(
    (operation: "enable" | "reload", id: string) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const discovery = yield* restore(discover(operation));
          const pluginPackage = discovery.packages.get(id);
          if (pluginPackage === undefined) return yield* new PluginPackageNotFoundError({ id });
          const enabledIds = yield* restore(
            readEnabledIds.pipe(Effect.mapError((error) => operationError(operation, error, id))),
          );
          if (operation === "reload" && !enabledIds.has(id)) {
            return yield* operationError(operation, "package is not enabled", id);
          }
          if (operation === "enable" && activeDefinitions.has(id) && enabledIds.has(id)) {
            return yield* statusUnlocked(operation);
          }
          packageErrors.delete(id);

          const previousEnabledIds = new Set(enabledIds);
          const previousGrants = yield* restore(
            hostCapabilities
              .granted(id)
              .pipe(Effect.mapError((error) => operationError(operation, error, id))),
          );
          if (operation === "enable") {
            const granted = yield* Effect.exit(
              restore(
                hostCapabilities
                  .grant(id, pluginPackage.manifest.permissions ?? [])
                  .pipe(Effect.mapError((error) => operationError(operation, error, id))),
              ),
            );
            if (granted._tag === "Failure") {
              packageErrors.set(id, detailFromCause(granted.cause));
              return yield* Effect.failCause(granted.cause);
            }
          }
          const restorePreviousGrants = hostCapabilities.grant(id, previousGrants).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to restore plugin capability grants", {
                id,
                error: detailFromCause(cause),
              }),
            ),
          );
          const previousCacheDirectory = activeCacheDirectories.get(id);
          const previousRetirement = activeRetirements.get(id);
          const previousWorker = activeWorkers.get(id);
          const loadedExit = yield* Effect.exit(restore(loadDefinition(pluginPackage, operation)));
          if (loadedExit._tag === "Failure") {
            packageErrors.set(id, detailFromCause(loadedExit.cause));
            if (operation === "enable") yield* restorePreviousGrants;
            return yield* Effect.failCause(loadedExit.cause);
          }
          const loaded = loadedExit.value;
          if (operation === "enable") {
            enabledIds.add(id);
            const persisted = yield* Effect.exit(persistEnabledIds(enabledIds, operation, id));
            if (persisted._tag === "Failure") {
              packageErrors.set(id, detailFromCause(persisted.cause));
              yield* restorePreviousGrants;
              yield* stopWorker(id, loaded.worker);
              yield* removeCacheDirectory(loaded.cacheDirectory);
              return yield* Effect.failCause(persisted.cause);
            }
          }
          const previousCatalog = yield* catalog.list;
          const reconciled = yield* Effect.exit(
            restore(
              catalog
                .reconcile(definitionList([id, loaded.definition]))
                .pipe(Effect.mapError((error) => operationError(operation, error, id))),
            ),
          );
          if (reconciled._tag === "Failure") {
            const currentCatalog = yield* catalog.list;
            if (currentCatalog.generation === previousCatalog.generation) {
              if (operation === "enable") {
                const rolledBack = yield* Effect.exit(
                  persistEnabledIds(previousEnabledIds, operation, id),
                );
                yield* restorePreviousGrants;
                if (rolledBack._tag === "Failure") {
                  packageErrors.set(id, detailFromCause(reconciled.cause));
                  yield* stopWorker(id, loaded.worker);
                  yield* removeCacheDirectory(loaded.cacheDirectory);
                  yield* Effect.logWarning("Failed to restore enabled package settings", {
                    id,
                    error: rolledBack.cause,
                  });
                  return yield* Effect.failCause(reconciled.cause);
                }
              }
              packageErrors.set(id, detailFromCause(reconciled.cause));
              yield* stopWorker(id, loaded.worker);
              yield* removeCacheDirectory(loaded.cacheDirectory);
              return yield* Effect.failCause(reconciled.cause);
            }
          }

          const runtimeComposition = yield* catalog.composition;
          const blockedReason = runtimeComposition.blocked[id];
          if (blockedReason !== undefined) {
            dependencyBlocked.set(id, blockedReason);
            activeDefinitions.delete(id);
            activeCacheDirectories.delete(id);
            activeManifests.delete(id);
            activeWorkers.delete(id);
            activeHosts.delete(id);
            activeRetirements.delete(id);
            yield* stopWorker(id, loaded.worker);
            yield* removeCacheDirectory(loaded.cacheDirectory);
            if (previousRetirement !== undefined) yield* Effect.promise(() => previousRetirement);
            if (previousWorker !== undefined) yield* stopWorker(id, previousWorker);
            if (previousCacheDirectory !== undefined) {
              yield* removeCacheDirectory(previousCacheDirectory);
            }
            return yield* statusUnlocked(operation);
          }

          activeDefinitions.set(id, loaded.definition);
          activeCacheDirectories.set(id, loaded.cacheDirectory);
          activeManifests.set(id, pluginPackage.manifest);
          activeWorkers.set(id, loaded.worker);
          activeHosts.set(id, loaded.host);
          activeRetirements.set(id, loaded.retired);
          dependencyBlocked.delete(id);
          if (previousCacheDirectory !== undefined) {
            if (reconciled._tag === "Failure" && previousRetirement !== undefined) {
              yield* Effect.promise(() => previousRetirement);
            }
            if (previousWorker !== undefined) yield* stopWorker(id, previousWorker);
            yield* removeCacheDirectory(previousCacheDirectory);
          }
          if (reconciled._tag === "Failure") return yield* Effect.failCause(reconciled.cause);
          return yield* statusUnlocked(operation);
        }),
      ),
  );

  const disableUnlocked = Effect.fn("PluginPackageManager.disable")((id: string) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const discovery = yield* restore(discover("disable"));
        const enabledIds = yield* restore(
          readEnabledIds.pipe(Effect.mapError((error) => operationError("disable", error, id))),
        );
        if (!discovery.packages.has(id) && !enabledIds.has(id) && !activeDefinitions.has(id)) {
          return yield* new PluginPackageNotFoundError({ id });
        }
        packageErrors.delete(id);

        const previousEnabledIds = new Set(enabledIds);
        enabledIds.delete(id);
        const persisted = yield* Effect.exit(persistEnabledIds(enabledIds, "disable", id));
        if (persisted._tag === "Failure") return yield* Effect.failCause(persisted.cause);
        const previousCatalog = yield* catalog.list;
        const reconciled = yield* Effect.exit(
          restore(
            catalog
              .reconcile(definitionList([id, undefined]))
              .pipe(Effect.mapError((error) => operationError("disable", error, id))),
          ),
        );
        if (reconciled._tag === "Failure") {
          const currentCatalog = yield* catalog.list;
          if (currentCatalog.generation === previousCatalog.generation) {
            const rolledBack = yield* Effect.exit(
              persistEnabledIds(previousEnabledIds, "disable", id),
            );
            if (rolledBack._tag === "Failure") {
              yield* Effect.logWarning("Failed to restore enabled package settings", {
                id,
                error: rolledBack.cause,
              });
              return yield* Effect.failCause(reconciled.cause);
            }
            return yield* Effect.failCause(reconciled.cause);
          }
        }

        const runtimeComposition = yield* catalog.composition;
        for (const [blockedId, reason] of Object.entries(runtimeComposition.blocked)) {
          if (blockedId === id || reason === undefined || !activeDefinitions.has(blockedId))
            continue;
          dependencyBlocked.set(blockedId, reason);
          const blockedWorker = activeWorkers.get(blockedId);
          const blockedCache = activeCacheDirectories.get(blockedId);
          const blockedRetirement = activeRetirements.get(blockedId);
          activeDefinitions.delete(blockedId);
          activeCacheDirectories.delete(blockedId);
          activeManifests.delete(blockedId);
          activeWorkers.delete(blockedId);
          activeHosts.delete(blockedId);
          activeRetirements.delete(blockedId);
          if (blockedRetirement !== undefined) yield* Effect.promise(() => blockedRetirement);
          if (blockedWorker !== undefined) yield* stopWorker(blockedId, blockedWorker);
          if (blockedCache !== undefined) yield* removeCacheDirectory(blockedCache);
        }

        const worker = activeWorkers.get(id);
        activeDefinitions.delete(id);
        activeManifests.delete(id);
        activeWorkers.delete(id);
        activeHosts.delete(id);
        const cacheDirectory = activeCacheDirectories.get(id);
        const retirement = activeRetirements.get(id);
        activeCacheDirectories.delete(id);
        activeRetirements.delete(id);
        if (worker !== undefined) yield* stopWorker(id, worker);
        if (cacheDirectory !== undefined) {
          if (reconciled._tag === "Failure" && retirement !== undefined) {
            yield* Effect.promise(() => retirement);
          }
          yield* removeCacheDirectory(cacheDirectory);
        }
        if (reconciled._tag === "Failure") return yield* Effect.failCause(reconciled.cause);
        return yield* statusUnlocked("disable");
      }),
    ),
  );

  const retryDependencyBlocked = Effect.fn("PluginPackageManager.retryDependencyBlocked")(
    function* (enabledIds: ReadonlySet<string>, warning: string) {
      while (true) {
        const blockedIds = [...dependencyBlocked.keys()].filter((id) => enabledIds.has(id)).sort();
        if (blockedIds.length === 0) return;
        let activated = 0;
        for (const id of blockedIds) {
          const retried = yield* Effect.exit(transition("enable", id));
          if (retried._tag === "Failure") {
            if (Cause.hasInterrupts(retried.cause)) return yield* Effect.interrupt;
            yield* Effect.logWarning(warning, { id, error: detailFromCause(retried.cause) });
            continue;
          }
          if (!dependencyBlocked.has(id)) activated += 1;
        }
        if (activated === 0) return;
      }
    },
  );

  yield* settings.start.pipe(Effect.mapError((error) => operationError("status", error)));
  yield* fileSystem
    .remove(pluginCacheDirectory, { recursive: true, force: true })
    .pipe(Effect.mapError((error) => operationError("status", error)));
  yield* fileSystem
    .makeDirectory(pluginCacheDirectory, { recursive: true })
    .pipe(Effect.mapError((error) => operationError("status", error)));
  yield* fileSystem
    .makeDirectory(pluginsDirectory, { recursive: true })
    .pipe(Effect.mapError((error) => operationError("status", error)));

  const startupDiscovery = yield* discover("status");
  for (const error of startupDiscovery.errors) {
    yield* Effect.logWarning("Invalid local plugin package", error);
  }
  const startupEnabledIds = yield* readEnabledIds.pipe(
    Effect.mapError((error) => operationError("status", error)),
  );
  for (const id of [...startupEnabledIds].sort()) {
    const pluginPackage = startupDiscovery.packages.get(id);
    if (pluginPackage === undefined) {
      yield* Effect.logWarning("Enabled local plugin package was not discovered", { id });
      continue;
    }
    yield* Effect.gen(function* () {
      const loaded = yield* loadDefinition(pluginPackage, "status");
      const reconciled = yield* Effect.exit(
        catalog
          .reconcile(definitionList([id, loaded.definition]))
          .pipe(Effect.mapError((error) => operationError("status", error, id))),
      );
      if (reconciled._tag === "Failure") {
        yield* stopWorker(id, loaded.worker);
        yield* removeCacheDirectory(loaded.cacheDirectory);
        return yield* Effect.failCause(reconciled.cause);
      }
      const runtimeComposition = yield* catalog.composition;
      const blockedReason = runtimeComposition.blocked[id];
      if (blockedReason !== undefined) {
        dependencyBlocked.set(id, blockedReason);
        yield* stopWorker(id, loaded.worker);
        yield* removeCacheDirectory(loaded.cacheDirectory);
        return;
      }
      activeDefinitions.set(id, loaded.definition);
      activeCacheDirectories.set(id, loaded.cacheDirectory);
      activeManifests.set(id, pluginPackage.manifest);
      activeWorkers.set(id, loaded.worker);
      activeHosts.set(id, loaded.host);
      activeRetirements.set(id, loaded.retired);
      dependencyBlocked.delete(id);
    }).pipe(
      Effect.retry({ times: 1 }),
      Effect.catchCause((cause) => {
        if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
        const detail = detailFromCause(cause);
        packageErrors.set(id, detail);
        return Effect.logWarning("Failed to activate enabled local plugin package", { id, detail });
      }),
    );
  }
  yield* retryDependencyBlocked(
    startupEnabledIds,
    "Failed to activate startup dependency-blocked package",
  );

  const resolveSetting = Effect.fn("PluginPackageManager.resolveSetting")(function* (
    pluginId: string,
    settingId: string,
  ) {
    const host = activeHosts.get(pluginId);
    if (host === undefined) {
      return yield* new PluginUiSettingError({
        pluginId,
        settingId,
        detail: "plugin is not active",
      });
    }
    const ui = yield* catalog.ui;
    const setting = ui.packages
      .find((pluginPackage) => pluginPackage.pluginId === pluginId)
      ?.settings.find((candidate) => candidate.id === settingId);
    if (setting === undefined) {
      return yield* new PluginUiSettingError({
        pluginId,
        settingId,
        detail: "setting is not declared",
      });
    }
    return { host, setting };
  });

  const valueMatchesSetting = (setting: PluginUiSetting, value: Schema.Json): boolean => {
    switch (setting.kind) {
      case "boolean":
        return typeof value === "boolean";
      case "text":
        return typeof value === "string" && value.length <= 2_000;
      case "select":
        return (
          typeof value === "string" && setting.options.some((option) => option.value === value)
        );
    }
  };

  const settingRead = (pluginId: string, settingId: string) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const { host } = yield* resolveSetting(pluginId, settingId);
        const value = yield* host.settings.get(settingId).pipe(
          Effect.mapError(
            (cause) =>
              new PluginUiSettingError({
                pluginId,
                settingId,
                detail: "settings store read failed",
                cause,
              }),
          ),
        );
        return value as Schema.Json | undefined;
      }),
    );

  const settingWrite = (pluginId: string, settingId: string, value: Schema.Json) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const { host, setting } = yield* resolveSetting(pluginId, settingId);
        if (!valueMatchesSetting(setting, value)) {
          return yield* new PluginUiSettingError({
            pluginId,
            settingId,
            detail: "value does not match setting schema",
          });
        }
        yield* host.settings.set(settingId, value).pipe(
          Effect.mapError(
            (cause) =>
              new PluginUiSettingError({
                pluginId,
                settingId,
                detail: "settings store write failed",
                cause,
              }),
          ),
        );
      }),
    );

  yield* Effect.addFinalizer(() =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const shutdown = yield* Effect.exit(catalog.reconcile([]));
        if (shutdown._tag === "Failure") {
          yield* Effect.logWarning("Failed to retire local plugin packages during shutdown", {
            error: detailFromCause(shutdown.cause),
          });
        }
        yield* Effect.forEach(activeWorkers, ([id, worker]) => stopWorker(id, worker), {
          concurrency: "unbounded",
          discard: true,
        });
        activeWorkers.clear();
        activeHosts.clear();
        for (const [id, error] of packageErrors) {
          yield* Effect.logWarning("Local plugin package reported a shutdown error", { id, error });
        }
        yield* removeCacheDirectory(pluginCacheDirectory);
      }),
    ),
  );

  const enableUnlocked = Effect.fn("PluginPackageManager.enable")(function* (id: string) {
    yield* transition("enable", id);
    const enabledIds = yield* readEnabledIds.pipe(
      Effect.mapError((error) => operationError("enable", error, id)),
    );
    yield* retryDependencyBlocked(enabledIds, "Failed to activate unblocked plugin package");
    return yield* statusUnlocked("enable");
  });

  return {
    status: semaphore.withPermits(1)(statusUnlocked("status")),
    enable: (id: string) => semaphore.withPermits(1)(enableUnlocked(id)),
    disable: (id: string) => semaphore.withPermits(1)(disableUnlocked(id)),
    reload: (id: string) => semaphore.withPermits(1)(transition("reload", id)),
    settingRead,
    settingWrite,
  } as const;
});

const unavailableService = (error: PluginPackageOperationError) =>
  PluginPackageManager.of({
    status: Effect.fail(error),
    enable: () => Effect.fail(error),
    disable: () => Effect.fail(error),
    reload: () => Effect.fail(error),
    settingRead: (pluginId, settingId) =>
      Effect.fail(
        new PluginUiSettingError({
          pluginId,
          settingId,
          detail: "plugin package manager is unavailable",
          cause: error,
        }),
      ),
    settingWrite: (pluginId, settingId) =>
      Effect.fail(
        new PluginUiSettingError({
          pluginId,
          settingId,
          detail: "plugin package manager is unavailable",
          cause: error,
        }),
      ),
  });

export const layer = Layer.effect(
  PluginPackageManager,
  make().pipe(
    Effect.catch((error) =>
      Effect.logWarning("Local plugin package manager failed to start", {
        error: detailFromUnknown(error),
      }).pipe(Effect.as(unavailableService(error))),
    ),
  ),
);
