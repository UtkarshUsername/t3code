import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { PluginRuntime, type PluginDefinition } from "@t3tools/plugin-runtime";

import * as PluginCommandCatalog from "./PluginCommandCatalog.ts";

const testPlugin = (input: {
  readonly fail?: boolean;
  readonly message: string;
  readonly onDispose?: () => void | Promise<void>;
  readonly version: string;
}): PluginDefinition => ({
  id: "acme.command-plugin",
  version: input.version,
  activate(context) {
    if (input.fail === true) throw new Error("activation failed");
    if (input.onDispose !== undefined) context.onDispose(input.onDispose);
    PluginCommandCatalog.registerPluginCommand(context, {
      command: {
        id: "acme.hello",
        label: "Say hello",
        description: "Return a greeting from the trusted test plugin.",
        surfaces: ["web", "desktop", "mobile"],
      },
      handler: Effect.succeed({ message: input.message, tone: "success" }),
    });
  },
});

describe("plugin command catalog", () => {
  it("keeps command identity on execution errors", () => {
    const error = new PluginCommandCatalog.PluginCommandExecutionError({
      cause: new Error("handler failed"),
      id: "acme.hello",
    });

    expect(error.message).toBe("Plugin command acme.hello failed during execution.");
  });

  it.effect("lists and invokes the trusted built-in command", () =>
    Effect.gen(function* () {
      const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
      const listed = yield* catalog.list;
      const streamed = yield* Stream.runHead(catalog.changes);

      expect(listed.commands.map((command) => command.id)).toContain("t3.plugin-runtime.status");
      expect(Object.isFrozen(listed)).toBe(true);
      expect(Object.isFrozen(listed.commands)).toBe(true);
      expect(Object.isFrozen(listed.commands[0])).toBe(true);
      expect(Object.isFrozen(listed.commands[0]?.surfaces)).toBe(true);
      expect(Option.getOrNull(streamed)).toEqual(listed);
      expect(
        yield* catalog.invoke({
          generation: listed.generation,
          id: "t3.plugin-runtime.status",
        }),
      ).toEqual({ message: "Plugin runtime is active.", tone: "success" });
    }).pipe(Effect.provide(PluginCommandCatalog.layer)),
  );

  it.effect(
    "publishes declarative ui and host-rendered notifications with the runtime generation",
    () =>
      Effect.gen(function* () {
        const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
        const definition: PluginDefinition = {
          id: "com.acme.ui-plugin",
          version: "1.0.0",
          activate(context) {
            PluginCommandCatalog.registerPluginUi(context, "com.acme.ui-plugin", {
              settings: [],
              navigation: [
                {
                  id: "com.acme.ui.navigation",
                  label: "Acme",
                  viewId: "com.acme.ui.view",
                  surfaces: ["web"],
                },
              ],
              views: [
                {
                  id: "com.acme.ui.view",
                  label: "Acme",
                  surfaces: ["web"],
                  blocks: [{ kind: "text", text: "Hello from Acme" }],
                },
              ],
              cards: [],
              statusItems: [],
              composerActions: [],
              contextualActions: [],
            });
          },
        };

        const published = yield* catalog.reconcile([definition]);
        const ui = yield* catalog.ui;
        expect(ui.generation).toBe(published.generation);
        expect(ui.packages[0]?.navigation[0]?.id).toBe("com.acme.ui.navigation");
        expect(Object.isFrozen(ui)).toBe(true);

        const failed = yield* Effect.exit(
          catalog.reconcile([
            {
              id: "com.acme.ui-plugin",
              version: "2.0.0",
              activate() {
                throw new Error("replacement failed");
              },
            },
          ]),
        );
        expect(Exit.isFailure(failed)).toBe(true);
        expect(yield* catalog.ui).toBe(ui);

        const notificationFiber = yield* Effect.forkChild(Stream.runHead(catalog.notifications));
        yield* Effect.yieldNow;
        yield* catalog.notify("com.acme.ui-plugin", {
          id: "notification-1",
          title: "Done",
          message: "The plugin finished.",
          tone: "success",
        });
        expect(Option.getOrNull(yield* Fiber.join(notificationFiber))).toMatchObject({
          pluginId: "com.acme.ui-plugin",
          title: "Done",
        });
        const rateLimited = yield* Effect.flip(
          catalog.notify("com.acme.ui-plugin", {
            id: "notification-2",
            title: "Again",
            message: "Too soon.",
            tone: "info",
          }),
        );
        expect(rateLimited.detail).toBe("notification rate limit exceeded");
      }).pipe(Effect.provide(PluginCommandCatalog.layer)),
  );

  it.effect("keeps the committed command and handler when replacement activation fails", () =>
    Effect.gen(function* () {
      const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
      const first = yield* catalog.reconcile([
        testPlugin({ message: "hello one", version: "1.0.0" }),
      ]);
      const failed = yield* Effect.exit(
        catalog.reconcile([testPlugin({ fail: true, message: "hello two", version: "2.0.0" })]),
      );

      expect(Exit.isFailure(failed)).toBe(true);
      expect(yield* catalog.list).toEqual(first);
      expect(yield* catalog.invoke({ generation: first.generation, id: "acme.hello" })).toEqual({
        message: "hello one",
        tone: "success",
      });
    }).pipe(Effect.provide(PluginCommandCatalog.layer)),
  );

  it.effect("does not republish an unchanged command catalog", () =>
    Effect.gen(function* () {
      const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
      const definition = testPlugin({ message: "hello one", version: "1.0.0" });

      const first = yield* catalog.reconcile([definition]);
      const second = yield* catalog.reconcile([definition]);

      expect(second).toBe(first);
    }).pipe(Effect.provide(PluginCommandCatalog.layer)),
  );

  it.effect("rolls back invalid command metadata before publishing a generation", () =>
    Effect.gen(function* () {
      const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
      const first = yield* catalog.list;
      const invalid: PluginDefinition = {
        id: "acme.invalid-command-plugin",
        version: "1.0.0",
        activate(context) {
          context.register(
            "commands",
            {
              id: "acme.invalid",
              label: "Invalid command",
              data: { surfaces: ["server"] },
            },
            Effect.succeed({ message: "invalid", tone: "success" as const }),
          );
        },
      };

      const failed = yield* Effect.exit(catalog.reconcile([invalid]));

      const shadowedIdentity: PluginDefinition = {
        id: "acme.shadowed-command-plugin",
        version: "1.0.0",
        activate(context) {
          context.register(
            "commands",
            {
              id: "acme.registered",
              label: "Registered command",
              data: {
                id: "acme.advertised",
                label: "Advertised command",
                surfaces: ["web"],
              },
            },
            Effect.succeed({ message: "shadowed", tone: "success" as const }),
          );
        },
      };
      const shadowed = yield* Effect.exit(catalog.reconcile([shadowedIdentity]));

      expect(Exit.isFailure(failed)).toBe(true);
      expect(Exit.isFailure(shadowed)).toBe(true);
      expect(yield* catalog.list).toBe(first);
      expect(
        yield* catalog.invoke({
          generation: first.generation,
          id: "t3.plugin-runtime.status",
        }),
      ).toEqual({ message: "Plugin runtime is active.", tone: "success" });
    }).pipe(Effect.provide(PluginCommandCatalog.layer)),
  );

  it.effect("serializes runtime reconciliation through catalog publication", () =>
    Effect.gen(function* () {
      const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
      let markActivationStarted!: () => void;
      let releaseActivation!: () => void;
      let markSecondActivationStarted!: () => void;
      const activationStarted = new Promise<void>((resolve) => {
        markActivationStarted = resolve;
      });
      const activationGate = new Promise<void>((resolve) => {
        releaseActivation = resolve;
      });
      const secondActivationStarted = new Promise<void>((resolve) => {
        markSecondActivationStarted = resolve;
      });
      const firstPlugin: PluginDefinition = {
        id: "acme.first-command-plugin",
        version: "1.0.0",
        activate(context) {
          markActivationStarted();
          return activationGate.then(() => {
            PluginCommandCatalog.registerPluginCommand(context, {
              command: { id: "acme.first", label: "First", surfaces: ["web"] },
              handler: Effect.succeed({ message: "first", tone: "success" }),
            });
          });
        },
      };
      const secondPlugin: PluginDefinition = {
        id: "acme.second-command-plugin",
        version: "1.0.0",
        activate(context) {
          markSecondActivationStarted();
          PluginCommandCatalog.registerPluginCommand(context, {
            command: { id: "acme.second", label: "Second", surfaces: ["web"] },
            handler: Effect.succeed({ message: "second", tone: "success" }),
          });
        },
      };

      const firstFiber = yield* Effect.forkChild(catalog.reconcile([firstPlugin]));
      yield* Effect.promise(() => activationStarted);
      const secondFiber = yield* Effect.forkChild(catalog.reconcile([secondPlugin]));
      yield* Effect.yieldNow;
      releaseActivation();

      const first = yield* Fiber.join(firstFiber);
      yield* Effect.promise(() => secondActivationStarted);
      const generationSeenBySecondActivation = (yield* catalog.list).generation;
      const second = yield* Fiber.join(secondFiber);
      expect(generationSeenBySecondActivation).toBe(first.generation);
      expect(yield* catalog.list).toBe(second);
    }).pipe(Effect.provide(PluginCommandCatalog.layer)),
  );

  it.effect("publishes a committed runtime generation before reporting interruption", () =>
    Effect.gen(function* () {
      const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
      let markRetirementStarted!: () => void;
      let releaseRetirement!: () => void;
      const retirementStarted = new Promise<void>((resolve) => {
        markRetirementStarted = resolve;
      });
      const retirementGate = new Promise<void>((resolve) => {
        releaseRetirement = resolve;
      });
      const first = yield* catalog.reconcile([
        testPlugin({
          message: "hello one",
          onDispose: async () => {
            markRetirementStarted();
            await retirementGate;
          },
          version: "1.0.0",
        }),
      ]);
      const replacement = yield* Effect.forkChild(
        catalog.reconcile([testPlugin({ message: "hello two", version: "2.0.0" })]),
      );
      yield* Effect.promise(() => retirementStarted);
      const interruption = yield* Effect.forkChild(Fiber.interrupt(replacement));
      yield* Effect.yieldNow;
      releaseRetirement();
      yield* Fiber.join(interruption);

      const second = yield* catalog.list;
      expect(second.generation).toBe(first.generation + 1);
      expect(yield* catalog.invoke({ generation: second.generation, id: "acme.hello" })).toEqual({
        message: "hello two",
        tone: "success",
      });
    }).pipe(Effect.provide(PluginCommandCatalog.layer)),
  );

  it.effect("does not invoke against a runtime generation before publishing its catalog", () =>
    Effect.gen(function* () {
      let generation = 0;
      let blockPublication = false;
      let markPublicationStarted!: () => void;
      let releasePublication!: () => void;
      const publicationStarted = new Promise<void>((resolve) => {
        markPublicationStarted = resolve;
      });
      const publicationGate = new Promise<void>((resolve) => {
        releasePublication = resolve;
      });
      const runtime = PluginRuntime.PluginRuntime.of({
        reconcile: () =>
          Effect.sync(() => {
            generation += 1;
            return { active: [], blocked: {}, contributions: {} };
          }),
        snapshot: Effect.succeed({ active: [], blocked: {}, contributions: {} }),
        contributions: () =>
          Effect.suspend(() => {
            if (!blockPublication) {
              return Effect.succeed({ generation, entries: [] });
            }
            return Effect.promise(() => {
              markPublicationStarted();
              return publicationGate;
            }).pipe(Effect.as({ generation, entries: [] }));
          }),
        useContribution: (_slot, id, expectedGeneration) =>
          Effect.fail(
            expectedGeneration === generation
              ? new PluginRuntime.PluginContributionNotFoundError({ id, slot: "commands" })
              : new PluginRuntime.PluginContributionGenerationError({
                  actual: generation,
                  expected: expectedGeneration,
                }),
          ),
        dispose: Effect.void,
      });
      const catalog = yield* PluginCommandCatalog.make.pipe(
        Effect.provideService(PluginRuntime.PluginRuntime, runtime),
      );
      const first = yield* catalog.list;
      blockPublication = true;
      const replacement = yield* Effect.forkChild(catalog.reconcile([]));
      yield* Effect.promise(() => publicationStarted);
      const invocation = yield* Effect.forkChild(
        Effect.exit(catalog.invoke({ generation: first.generation, id: "acme.hello" })),
      );
      yield* Effect.yieldNow;
      const waitedForPublication = invocation.pollUnsafe() === undefined;
      releasePublication();

      const second = yield* Fiber.join(replacement);
      const invocationExit = yield* Fiber.join(invocation);
      expect(waitedForPublication).toBe(true);
      expect(yield* catalog.list).toBe(second);
      expect(Exit.isFailure(invocationExit)).toBe(true);
    }),
  );
});
