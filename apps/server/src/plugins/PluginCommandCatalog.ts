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
  PluginUiSetting as PluginUiSettingSchema,
  PluginUiNavigationItem as PluginUiNavigationItemSchema,
  PluginUiView as PluginUiViewSchema,
  PluginUiCard as PluginUiCardSchema,
  PluginUiStatusItem as PluginUiStatusItemSchema,
  PluginUiAction as PluginUiActionSchema,
  PluginUiContextualAction as PluginUiContextualActionSchema,
} from "@t3tools/contracts";
import type {
  ContributionCompositionPolicy,
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
const UI_SLOTS = [
  "settings",
  "navigation",
  "views",
  "cards",
  "statusItems",
  "composerActions",
  "contextualActions",
] as const;
type UiSlot = (typeof UI_SLOTS)[number];
const decodePluginCommand = Schema.decodeUnknownSync(PluginCommandSchema);
const decodePluginCommandEffect = Schema.decodeUnknownEffect(PluginCommandSchema);
const decodePluginUi = Schema.decodeUnknownSync(PluginUiContribution);
const decodePluginUiPackage = Schema.decodeUnknownSync(PluginUiPackageContribution);
const decodePluginUiNotification = Schema.decodeUnknownEffect(PluginUiNotification);
const decodePluginUiCatalog = Schema.decodeUnknownEffect(PluginUiCatalogSchema);
const decodeContributionData = Schema.decodeUnknownSync(Schema.Json);
const decodeUiSetting = Schema.decodeUnknownSync(PluginUiSettingSchema);
const decodeUiNavigation = Schema.decodeUnknownSync(PluginUiNavigationItemSchema);
const decodeUiView = Schema.decodeUnknownSync(PluginUiViewSchema);
const decodeUiCard = Schema.decodeUnknownSync(PluginUiCardSchema);
const decodeUiStatus = Schema.decodeUnknownSync(PluginUiStatusItemSchema);
const decodeUiAction = Schema.decodeUnknownSync(PluginUiActionSchema);
const decodeUiContextualAction = Schema.decodeUnknownSync(PluginUiContextualActionSchema);

const commandInputFromContribution = (entry: Contribution) => {
  const data = typeof entry.data === "object" && entry.data !== null ? entry.data : {};
  if (Object.hasOwn(data, "id") || Object.hasOwn(data, "label")) {
    throw new TypeError("Plugin command metadata cannot override its registered id or label");
  }
  return { ...data, id: entry.id, label: entry.label };
};

const uiInputFromContribution = (slot: UiSlot, entry: Contribution): Record<string, unknown> => {
  const data = typeof entry.data === "object" && entry.data !== null ? entry.data : {};
  return {
    ...data,
    id: entry.id,
    ...(slot === "cards" ? { title: entry.label } : { label: entry.label }),
  };
};

interface MutableUiPackage {
  readonly pluginId: string;
  readonly settings: Array<PluginUiContributionType["settings"][number]>;
  readonly navigation: Array<PluginUiContributionType["navigation"][number]>;
  readonly views: Array<PluginUiContributionType["views"][number]>;
  readonly cards: Array<PluginUiContributionType["cards"][number]>;
  readonly statusItems: Array<PluginUiContributionType["statusItems"][number]>;
  readonly composerActions: Array<PluginUiContributionType["composerActions"][number]>;
  readonly contextualActions: Array<PluginUiContributionType["contextualActions"][number]>;
}

const uiPackagesFromSnapshot = (snapshot: PluginRuntimeSnapshot) => {
  const packages = new Map<string, MutableUiPackage>();
  const packageFor = (pluginId: string) => {
    const existing = packages.get(pluginId);
    if (existing !== undefined) return existing;
    const created: MutableUiPackage = {
      pluginId,
      settings: [],
      navigation: [],
      views: [],
      cards: [],
      statusItems: [],
      composerActions: [],
      contextualActions: [],
    };
    packages.set(pluginId, created);
    return created;
  };
  for (const slot of UI_SLOTS) {
    for (const entry of snapshot.contributions[slot] ?? []) {
      const pluginPackage = packageFor(entry.owner.pluginId);
      const input = uiInputFromContribution(slot, entry);
      switch (slot) {
        case "settings":
          pluginPackage.settings.push(decodeUiSetting(input));
          break;
        case "navigation":
          pluginPackage.navigation.push(decodeUiNavigation(input));
          break;
        case "views":
          pluginPackage.views.push(decodeUiView(input));
          break;
        case "cards":
          pluginPackage.cards.push(decodeUiCard(input));
          break;
        case "statusItems":
          pluginPackage.statusItems.push(decodeUiStatus(input));
          break;
        case "composerActions":
          pluginPackage.composerActions.push(decodeUiAction(input));
          break;
        case "contextualActions":
          pluginPackage.contextualActions.push(decodeUiContextualAction(input));
          break;
      }
    }
  }
  return [...packages.values()].map((pluginPackage) => decodePluginUiPackage(pluginPackage));
};

const validateSnapshot = (snapshot: PluginRuntimeSnapshot): void => {
  for (const entry of snapshot.contributions[COMMAND_SLOT] ?? []) {
    decodePluginCommand(commandInputFromContribution(entry));
  }
  uiPackagesFromSnapshot(snapshot);
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
  readonly composition?: ContributionCompositionPolicy;
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
      ...(registration.composition === undefined ? {} : { composition: registration.composition }),
    },
    Effect.isEffect(registration.handler) ? () => registration.handler : registration.handler,
  );
};

const registerUiEntry = (
  context: PluginActivationContext,
  slot: UiSlot,
  item: Readonly<Record<string, unknown>>,
  labelKey: "label" | "title",
) => {
  const id = item.id;
  const label = item[labelKey];
  if (typeof id !== "string" || typeof label !== "string") {
    throw new TypeError(`Plugin UI ${slot} contribution is missing its identity`);
  }
  const data = Object.fromEntries(
    Object.entries(item).filter(([key]) => key !== "id" && key !== labelKey),
  );
  context.register(slot, { id, label, data: decodeContributionData(data) });
};

export const registerPluginUi = (
  context: PluginActivationContext,
  pluginId: string,
  contribution: PluginUiContributionType,
): void => {
  const ui = decodePluginUi(contribution);
  void pluginId;
  for (const item of ui.settings) registerUiEntry(context, "settings", item, "label");
  for (const item of ui.navigation) registerUiEntry(context, "navigation", item, "label");
  for (const item of ui.views) registerUiEntry(context, "views", item, "label");
  for (const item of ui.cards) registerUiEntry(context, "cards", item, "title");
  for (const item of ui.statusItems) registerUiEntry(context, "statusItems", item, "label");
  for (const item of ui.composerActions) {
    registerUiEntry(context, "composerActions", item, "label");
  }
  for (const item of ui.contextualActions) {
    registerUiEntry(context, "contextualActions", item, "label");
  }
};

export class PluginUiDefinitionError extends Schema.TaggedErrorClass<PluginUiDefinitionError>()(
  "PluginUiDefinitionError",
  { cause: Schema.Defect(), id: Schema.String },
) {
  override get message(): string {
    return `Plugin ${this.id} has invalid declarative UI metadata.`;
  }
}

export class PluginUiNotificationInactiveError extends Schema.TaggedErrorClass<PluginUiNotificationInactiveError>()(
  "PluginUiNotificationInactiveError",
  { pluginId: Schema.String },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} is not active.`;
  }
}

export class PluginUiNotificationRateLimitError extends Schema.TaggedErrorClass<PluginUiNotificationRateLimitError>()(
  "PluginUiNotificationRateLimitError",
  { pluginId: Schema.String, windowMillis: Schema.Int },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} exceeded the ${this.windowMillis}ms notification window.`;
  }
}

export class PluginUiNotificationDecodeError extends Schema.TaggedErrorClass<PluginUiNotificationDecodeError>()(
  "PluginUiNotificationDecodeError",
  { cause: Schema.Defect(), pluginId: Schema.String, notificationId: Schema.String },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} sent invalid notification ${this.notificationId}.`;
  }
}

type PluginUiNotificationError =
  | PluginUiNotificationInactiveError
  | PluginUiNotificationRateLimitError
  | PluginUiNotificationDecodeError;

const builtInPlugin: PluginDefinition = {
  id: "t3.plugin-runtime.commands",
  origin: "core",
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
      composition: { allowed: ["extend", "decorate", "replace", "disable"] },
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
  const [snapshot, generationSnapshot] = yield* Effect.all([
    runtime.snapshot,
    runtime.contributions(UI_SLOTS[0]),
  ]);
  const packages = yield* Effect.try({
    try: () => uiPackagesFromSnapshot(snapshot),
    catch: (cause) => new PluginUiDefinitionError({ cause, id: "catalog" }),
  });
  const catalog = yield* decodePluginUiCatalog({
    generation: generationSnapshot.generation,
    packages,
    order: Object.fromEntries(
      UI_SLOTS.map((slot) => [slot, (snapshot.contributions[slot] ?? []).map((entry) => entry.id)]),
    ),
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
    order: {
      settings: [],
      navigation: [],
      views: [],
      cards: [],
      statusItems: [],
      composerActions: [],
      contextualActions: [],
    },
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
      return yield* new PluginUiNotificationInactiveError({ pluginId });
    }
    const now = yield* Clock.currentTimeMillis;
    const previous = lastNotificationAt.get(pluginId);
    if (previous !== undefined && now - previous < 250) {
      return yield* new PluginUiNotificationRateLimitError({
        pluginId,
        windowMillis: 250,
      });
    }
    const decoded = yield* decodePluginUiNotification({ ...notification, pluginId }).pipe(
      Effect.mapError(
        (cause) =>
          new PluginUiNotificationDecodeError({
            pluginId,
            notificationId: notification.id,
            cause,
          }),
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
