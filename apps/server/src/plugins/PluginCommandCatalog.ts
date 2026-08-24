import {
  PluginCommand as PluginCommandSchema,
  type PluginCommand,
  type PluginCommandInvocationContext,
  type PluginCommandCatalog as PluginCommandCatalogSnapshot,
  PluginCommandCatalogChangedError,
  PluginCommandId,
  type PluginCommandInvocationResult,
  PluginCommandInvocationError,
  type PluginCommandInvokeInput,
  PluginCommandNotFoundError,
  PluginUiCatalog as PluginUiCatalogSchema,
  type PluginUiCatalog as PluginUiCatalogSnapshot,
  PluginUiContribution,
  type PluginUiContribution as PluginUiContributionType,
  PluginUiNotification,
  type PluginUiNotification as PluginUiNotificationType,
  type PluginUiNotificationInput,
  PluginUiPackageContribution,
} from "@t3tools/contracts";
import type {
  Contribution,
  PluginActivationContext,
  PluginDefinition,
  PluginRuntimeSnapshot,
} from "@t3tools/plugin-runtime";
import { PluginRuntime } from "@t3tools/plugin-runtime";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

const COMMAND_SLOT = "commands";
const UI_SLOT = "ui";
const decodePluginCommand = Schema.decodeUnknownSync(PluginCommandSchema);
const decodePluginCommandEffect = Schema.decodeUnknownEffect(PluginCommandSchema);
const decodePluginUi = Schema.decodeUnknownSync(PluginUiContribution);
const decodePluginUiPackageEffect = Schema.decodeUnknownEffect(PluginUiPackageContribution);
const decodePluginUiPackage = Schema.decodeUnknownSync(PluginUiPackageContribution);
const decodePluginUiNotification = Schema.decodeUnknownEffect(PluginUiNotification);
const decodePluginUiCatalog = Schema.decodeUnknownEffect(PluginUiCatalogSchema);
const decodeContributionData = Schema.decodeUnknownSync(Schema.Json);

const commandInputFromContribution = (entry: Contribution) => {
  const data = typeof entry.data === "object" && entry.data !== null ? entry.data : {};
  if (Object.hasOwn(data, "id") || Object.hasOwn(data, "label")) {
    throw new TypeError("Plugin command metadata cannot override its registered id or label");
  }
  return { ...data, id: entry.id, label: entry.label };
};

const uiInputFromContribution = (entry: Contribution) => {
  const data = typeof entry.data === "object" && entry.data !== null ? entry.data : {};
  return { ...data, pluginId: entry.id };
};

const validateSnapshot = (snapshot: PluginRuntimeSnapshot): void => {
  for (const entry of snapshot.contributions[COMMAND_SLOT] ?? []) {
    decodePluginCommand(commandInputFromContribution(entry));
  }
  for (const entry of snapshot.contributions[UI_SLOT] ?? []) {
    decodePluginUiPackage(uiInputFromContribution(entry));
  }
};

export class PluginCommandExecutionError extends Schema.TaggedErrorClass<PluginCommandExecutionError>()(
  "PluginCommandExecutionError",
  { cause: Schema.Defect(), id: PluginCommandId },
) {
  override get message(): string {
    return `Plugin command ${this.id} failed during execution.`;
  }
}

type PluginCommandHandler = (
  context?: PluginCommandInvocationContext,
) => Effect.Effect<PluginCommandInvocationResult, PluginCommandExecutionError>;

export class PluginCommandDefinitionError extends Schema.TaggedErrorClass<PluginCommandDefinitionError>()(
  "PluginCommandDefinitionError",
  { cause: Schema.Defect(), id: Schema.String },
) {
  override get message(): string {
    return `Plugin command ${this.id} has invalid declarative metadata.`;
  }
}

export interface PluginCommandRegistration {
  readonly command: PluginCommand;
  readonly handler:
    | PluginCommandHandler
    | Effect.Effect<PluginCommandInvocationResult, PluginCommandExecutionError>;
}

export const registerPluginCommand = (
  context: PluginActivationContext,
  registration: PluginCommandRegistration,
): void => {
  const command = decodePluginCommand(registration.command);
  const { description, surfaces } = command;
  context.register(
    COMMAND_SLOT,
    {
      id: command.id,
      label: command.label,
      data: {
        ...(description === undefined ? {} : { description }),
        surfaces,
      },
    },
    Effect.isEffect(registration.handler) ? () => registration.handler : registration.handler,
  );
};

export const registerPluginUi = (
  context: PluginActivationContext,
  pluginId: string,
  contribution: PluginUiContributionType,
): void => {
  const ui = decodePluginUi(contribution);
  context.register(UI_SLOT, { id: pluginId, label: pluginId, data: decodeContributionData(ui) });
};

export class PluginUiDefinitionError extends Schema.TaggedErrorClass<PluginUiDefinitionError>()(
  "PluginUiDefinitionError",
  { cause: Schema.Defect(), id: Schema.String },
) {
  override get message(): string {
    return `Plugin ${this.id} has invalid declarative UI metadata.`;
  }
}

export class PluginUiNotificationError extends Schema.TaggedErrorClass<PluginUiNotificationError>()(
  "PluginUiNotificationError",
  { cause: Schema.optional(Schema.Defect()), pluginId: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Plugin notification failed for ${this.pluginId}: ${this.detail}`;
  }
}

const builtInPlugin: PluginDefinition = {
  id: "t3.plugin-runtime.commands",
  version: "1.0.0",
  activate(context) {
    registerPluginCommand(context, {
      command: {
        id: "t3.plugin-runtime.status",
        label: "Check plugin runtime",
        description: "Verify that the environment plugin runtime is responding.",
        surfaces: ["web", "desktop", "mobile"],
      },
      handler: Effect.succeed({
        message: "Plugin runtime is active.",
        tone: "success",
      }),
    });
  },
};

const catalogFromRuntime = Effect.fn("PluginCommandCatalog.catalogFromRuntime")(function* (
  runtime: PluginRuntime.PluginRuntime["Service"],
) {
  const snapshot = yield* runtime.contributions(COMMAND_SLOT);
  const commands = yield* Effect.forEach(snapshot.entries, (entry) =>
    decodePluginCommandEffect(commandInputFromContribution(entry)).pipe(
      Effect.mapError((cause) => new PluginCommandDefinitionError({ cause, id: entry.id })),
    ),
  );
  const frozenCommands = commands.map((command) =>
    Object.freeze({ ...command, surfaces: Object.freeze([...command.surfaces]) }),
  );
  return Object.freeze({
    commands: Object.freeze(frozenCommands),
    generation: snapshot.generation,
  }) satisfies PluginCommandCatalogSnapshot;
});

const deepFreeze = <A>(value: A): A => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
};

const uiFromRuntime = Effect.fn("PluginCommandCatalog.uiFromRuntime")(function* (
  runtime: PluginRuntime.PluginRuntime["Service"],
) {
  const snapshot = yield* runtime.contributions(UI_SLOT);
  const packages = yield* Effect.forEach(snapshot.entries, (entry) =>
    decodePluginUiPackageEffect(uiInputFromContribution(entry)).pipe(
      Effect.mapError((cause) => new PluginUiDefinitionError({ cause, id: entry.id })),
    ),
  );
  const catalog = yield* decodePluginUiCatalog({
    generation: snapshot.generation,
    packages,
  }).pipe(Effect.mapError((cause) => new PluginUiDefinitionError({ cause, id: "catalog" })));
  return deepFreeze(catalog);
});

export class PluginCommandCatalog extends Context.Service<
  PluginCommandCatalog,
  {
    readonly list: Effect.Effect<PluginCommandCatalogSnapshot>;
    readonly ui: Effect.Effect<PluginUiCatalogSnapshot>;
    readonly composition: Effect.Effect<PluginRuntimeSnapshot>;
    readonly changes: Stream.Stream<PluginCommandCatalogSnapshot>;
    readonly uiChanges: Stream.Stream<PluginUiCatalogSnapshot>;
    readonly notifications: Stream.Stream<PluginUiNotificationType>;
    readonly notify: (
      pluginId: string,
      notification: PluginUiNotificationInput,
    ) => Effect.Effect<void, PluginUiNotificationError>;
    readonly invoke: (
      input: PluginCommandInvokeInput,
    ) => Effect.Effect<
      PluginCommandInvocationResult,
      PluginCommandCatalogChangedError | PluginCommandInvocationError | PluginCommandNotFoundError
    >;
    readonly reconcile: (
      definitions: ReadonlyArray<PluginDefinition>,
    ) => Effect.Effect<
      PluginCommandCatalogSnapshot,
      | PluginCommandDefinitionError
      | PluginUiDefinitionError
      | PluginRuntime.PluginRuntimeReconcileError
    >;
  }
>()("t3/plugins/PluginCommandCatalog") {}

export const make = Effect.gen(function* () {
  const runtime = yield* PluginRuntime.PluginRuntime;
  const state = yield* SubscriptionRef.make<PluginCommandCatalogSnapshot>({
    commands: [],
    generation: 0,
  });
  const uiState = yield* SubscriptionRef.make<PluginUiCatalogSnapshot>({
    generation: 0,
    packages: [],
  });
  const notificationPubSub = yield* PubSub.sliding<PluginUiNotificationType>(64);
  const lastNotificationAt = new Map<string, number>();
  const reconcileSemaphore = yield* Semaphore.make(1);

  const reconcile = Effect.fn("PluginCommandCatalog.reconcile")(
    (definitions: ReadonlyArray<PluginDefinition>) =>
      reconcileSemaphore.withPermits(1)(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const transitionExit = yield* Effect.exit(
              restore(runtime.reconcile([builtInPlugin, ...definitions])),
            );
            const catalog = yield* catalogFromRuntime(runtime);
            const ui = yield* uiFromRuntime(runtime);
            const previous = yield* SubscriptionRef.get(state);
            const previousUi = yield* SubscriptionRef.get(uiState);
            const published =
              previous.generation === catalog.generation
                ? previous
                : yield* SubscriptionRef.set(state, catalog).pipe(Effect.as(catalog));
            if (previousUi.generation !== ui.generation) {
              yield* SubscriptionRef.set(uiState, ui);
            }
            if (Exit.isFailure(transitionExit)) {
              return yield* Effect.failCause(transitionExit.cause);
            }
            return published;
          }),
        ),
      ),
  );

  yield* reconcile([]);

  const notify = Effect.fn("PluginCommandCatalog.notify")(function* (
    pluginId: string,
    notification: PluginUiNotificationInput,
  ) {
    const snapshot = yield* runtime.snapshot;
    if (!snapshot.active.includes(pluginId)) {
      return yield* new PluginUiNotificationError({
        pluginId,
        detail: "plugin is not active",
      });
    }
    const now = yield* Clock.currentTimeMillis;
    const previous = lastNotificationAt.get(pluginId);
    if (previous !== undefined && now - previous < 250) {
      return yield* new PluginUiNotificationError({
        pluginId,
        detail: "notification rate limit exceeded",
      });
    }
    const decoded = yield* decodePluginUiNotification({ ...notification, pluginId }).pipe(
      Effect.mapError(
        (cause) =>
          new PluginUiNotificationError({ pluginId, detail: "invalid notification", cause }),
      ),
    );
    lastNotificationAt.set(pluginId, now);
    yield* PubSub.publish(notificationPubSub, deepFreeze(decoded));
  });

  const invoke = Effect.fn("PluginCommandCatalog.invoke")(function* (
    input: PluginCommandInvokeInput,
  ) {
    return yield* reconcileSemaphore.withPermits(1)(
      runtime
        .useContribution<
          PluginCommandHandler,
          PluginCommandInvocationResult,
          PluginCommandExecutionError,
          never
        >(COMMAND_SLOT, input.id, input.generation, (handler) => handler(input.context))
        .pipe(
          Effect.catchTags({
            PluginContributionGenerationError: (error) =>
              Effect.fail(
                new PluginCommandCatalogChangedError({
                  actualGeneration: error.actual,
                  expectedGeneration: error.expected,
                }),
              ),
            PluginContributionNotFoundError: () =>
              Effect.fail(new PluginCommandNotFoundError({ id: input.id })),
            PluginCommandExecutionError: (error) =>
              Effect.fail(
                new PluginCommandInvocationError({
                  cause: error,
                  id: input.id,
                }),
              ),
            PluginRuntimeDisposedError: (error) =>
              Effect.fail(
                new PluginCommandInvocationError({
                  cause: error,
                  id: input.id,
                }),
              ),
            PluginRuntimeReentrancyError: (error) =>
              Effect.fail(
                new PluginCommandInvocationError({
                  cause: error,
                  id: input.id,
                }),
              ),
          }),
        ),
    );
  });

  return PluginCommandCatalog.of({
    changes: SubscriptionRef.changes(state),
    composition: runtime.snapshot,
    invoke,
    list: SubscriptionRef.get(state),
    notifications: Stream.fromPubSub(notificationPubSub),
    notify,
    reconcile,
    ui: SubscriptionRef.get(uiState),
    uiChanges: SubscriptionRef.changes(uiState),
  });
});

export const layer = Layer.effect(PluginCommandCatalog, make).pipe(
  Layer.provide(PluginRuntime.layer({ validateSnapshot })),
);
