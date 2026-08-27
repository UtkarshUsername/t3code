import {
  type PluginCommand,
  type PluginCommandInvocationContext,
  PluginUiContribution,
  type PluginUiContribution as PluginUiContributionType,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { PluginHostApi, PluginHostCapabilityError } from "./PluginHostCapabilityBroker.ts";
import {
  type PluginWorkerHostCall,
  type PluginWorkerParentMessage,
  PluginWorkerMessage,
} from "./PluginWorkerProtocol.ts";

const MAX_PROTOCOL_LINE_BYTES = 1_000_000;
const MAX_STDERR_BYTES = 64_000;
const MAX_PENDING_HOST_CALLS = 64;
const HOST_CALL_CONCURRENCY = 8;
const DEFAULT_MEMORY_LIMIT_MB = 128;
const DEFAULT_RESTARTS = 2;

const sameCommands = (
  left: ReadonlyArray<PluginCommand>,
  right: ReadonlyArray<PluginCommand>,
): boolean =>
  left.length === right.length &&
  left.every((command, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      command.id === other.id &&
      command.label === other.label &&
      command.description === other.description &&
      command.surfaces.length === other.surfaces.length &&
      command.surfaces.every((surface, surfaceIndex) => surface === other.surfaces[surfaceIndex])
    );
  });

const decodeWorkerMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginWorkerMessage));
const encodeUi = Schema.encodeSync(Schema.fromJsonString(PluginUiContribution));

export type PluginWorkerHealth = "starting" | "running" | "restarting" | "crashed" | "stopped";

export interface PluginWorkerHealthSnapshot {
  readonly state: PluginWorkerHealth;
  readonly detail?: string;
  readonly restartCount: number;
}

export class PluginWorkerError extends Schema.TaggedErrorClass<PluginWorkerError>()(
  "PluginWorkerError",
  {
    pluginId: Schema.String,
    phase: Schema.Literals(["activation", "invocation", "host", "protocol", "restart", "dispose"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.phase} failed for plugin ${this.pluginId}: ${this.detail}`;
  }
}

export const isPluginWorkerError = Schema.is(PluginWorkerError);

export interface SupervisedPluginWorker {
  readonly commands: ReadonlyArray<PluginCommand>;
  readonly ui: PluginUiContributionType;
  readonly invoke: (
    commandId: string,
    context?: PluginCommandInvocationContext,
  ) => Effect.Effect<unknown, PluginWorkerError>;
  readonly dispose: Effect.Effect<void, PluginWorkerError>;
  readonly health: () => PluginWorkerHealthSnapshot;
}

export interface PluginWorkerStartInput {
  readonly pluginId: string;
  readonly entrypointPath: string;
  readonly workingDirectory?: string;
  readonly host: PluginHostApi;
}

export interface PluginWorkerOptions {
  readonly activationTimeout?: Duration.Input;
  readonly invocationTimeout?: Duration.Input;
  readonly disposeTimeout?: Duration.Input;
  readonly restartDelay?: Duration.Input;
  readonly maxRestarts?: number;
  readonly memoryLimitMb?: number;
}

export class PluginWorkerSupervisor extends Context.Service<
  PluginWorkerSupervisor,
  {
    readonly start: (
      input: PluginWorkerStartInput,
      options?: PluginWorkerOptions,
    ) => Effect.Effect<SupervisedPluginWorker, PluginWorkerError>;
  }
>()("t3/plugins/PluginWorkerSupervisor") {}

interface Session {
  readonly id: number;
  readonly commands: ReadonlyArray<PluginCommand>;
  readonly ui: PluginUiContributionType;
  readonly invoke: (
    commandId: string,
    context?: PluginCommandInvocationContext,
  ) => Effect.Effect<unknown, PluginWorkerError>;
  readonly requestDispose: Effect.Effect<void, PluginWorkerError>;
  readonly terminate: (detail: string) => Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
}

interface CrashEvent {
  readonly sessionId: number;
  readonly detail: string;
}

export const make = Effect.gen(function* () {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const parentScope = yield* Scope.Scope;
  const path = yield* Path.Path;
  const runtimePath = yield* path.fromFileUrl(
    new URL("./PluginWorkerRuntime.mjs", import.meta.url),
  );
  let workerSequence = 0;

  const start: PluginWorkerSupervisor["Service"]["start"] = (input, suppliedOptions = {}) => {
    let allocatedScope: Scope.Closeable | undefined;
    return Effect.gen(function* () {
      const options = {
        activationTimeout: suppliedOptions.activationTimeout ?? "5 seconds",
        invocationTimeout: suppliedOptions.invocationTimeout ?? "30 seconds",
        disposeTimeout: suppliedOptions.disposeTimeout ?? "2 seconds",
        restartDelay: suppliedOptions.restartDelay ?? "100 millis",
        maxRestarts: suppliedOptions.maxRestarts ?? DEFAULT_RESTARTS,
        memoryLimitMb: suppliedOptions.memoryLimitMb ?? DEFAULT_MEMORY_LIMIT_MB,
      } as const;
      const workerScope = yield* Scope.fork(parentScope, "sequential");
      allocatedScope = workerScope;
      const transition = yield* Semaphore.make(1);
      const crashes = yield* Queue.unbounded<CrashEvent>();
      const disposeRequest = yield* Deferred.make<void>();
      const disposeResult = yield* Deferred.make<void, PluginWorkerError>();

      let disposed = false;
      let restartCount = 0;
      let health: PluginWorkerHealthSnapshot = { state: "starting", restartCount: 0 };
      let current: Session | undefined;
      let expectedCommands: ReadonlyArray<PluginCommand> | undefined;
      let expectedUi: PluginUiContributionType | undefined;

      const detailFrom = (error: unknown): string => {
        const detail = error instanceof Error ? error.message : String(error);
        return (detail.trim() || "unknown error").slice(0, 2_000);
      };

      const detailFromCause = (cause: Cause.Cause<unknown>): string => {
        const failure = Cause.squash(cause);
        return isPluginWorkerError(failure) ? failure.detail : detailFrom(failure);
      };

      const workerError = (
        phase: PluginWorkerError["phase"],
        detail: string,
        cause?: unknown,
      ): PluginWorkerError =>
        new PluginWorkerError({
          pluginId: input.pluginId,
          phase,
          detail: detail.slice(0, 2_000),
          ...(cause === undefined ? {} : { cause }),
        });

      const dispatchHostCall = (
        call: PluginWorkerHostCall,
      ): Effect.Effect<unknown, PluginHostCapabilityError | PluginWorkerError> => {
        switch (call.operation) {
          case "settings.get":
            return input.host.settings.get(call.key);
          case "settings.set":
            return input.host.settings.set(call.key, call.value);
          case "settings.delete":
            return input.host.settings.delete(call.key);
          case "settings.clear":
            return input.host.settings.clear;
          case "state.get":
            return input.host.state.get(call.key);
          case "state.set":
            return input.host.state.set(call.key, call.value);
          case "state.delete":
            return input.host.state.delete(call.key);
          case "state.clear":
            return input.host.state.clear;
          case "cache.get":
            return input.host.cache.get(call.key);
          case "cache.set":
            return input.host.cache.set(call.key, call.value);
          case "cache.delete":
            return input.host.cache.delete(call.key);
          case "cache.clear":
            return input.host.cache.clear;
          case "secrets.get":
            return input.host.secrets.get(call.name);
          case "secrets.set":
            return input.host.secrets.set(call.name, call.value);
          case "secrets.delete":
            return input.host.secrets.delete(call.name);
          case "files.readText":
            return input.host.files.readText(call.path);
          case "files.writeText":
            return input.host.files.writeText(call.path, call.contents);
          case "files.remove":
            return input.host.files.remove(call.path);
          case "network.fetchText":
            return input.host.network.fetchText(call.url);
          case "process.run":
            return input.host.process.run(call.command, call.args);
          case "ui.notify":
            return input.host.ui.notify(call.notification);
        }
        return Effect.fail(workerError("host", "unsupported host operation"));
      };

      const spawnSession = Effect.fn("PluginWorkerSupervisor.spawnSession")(function* () {
        const sessionId = ++workerSequence;
        const sessionScope = yield* Scope.fork(workerScope, "sequential");
        const inputQueue = yield* Queue.unbounded<Uint8Array, Cause.Done>();
        const activation = yield* Deferred.make<
          {
            readonly commands: ReadonlyArray<PluginCommand>;
            readonly ui: PluginUiContributionType;
          },
          PluginWorkerError
        >();
        const hostCallSemaphore = yield* Semaphore.make(HOST_CALL_CONCURRENCY);
        const encoder = new TextEncoder();
        const protocolDecoder = new TextDecoder();
        let protocolBuffer = "";
        let pendingHostCalls = 0;
        const pending = new Map<
          string,
          (effect: Effect.Effect<unknown, PluginWorkerError>) => void
        >();
        let requestSequence = 0;
        let closing = false;
        let crashReported = false;
        let stderrBytes = 0;

        const send = (message: PluginWorkerParentMessage): boolean => {
          let line: string;
          try {
            line = `${JSON.stringify(message)}\n`;
          } catch {
            return false;
          }
          if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) return false;
          return Queue.offerUnsafe(inputQueue, encoder.encode(line));
        };

        const failPending = (error: PluginWorkerError) => {
          for (const resume of pending.values()) resume(Effect.fail(error));
          pending.clear();
        };

        const reportCrash = (detail: string, cause?: unknown) => {
          if (closing || crashReported || disposed) return;
          crashReported = true;
          health = { state: "restarting", detail, restartCount };
          failPending(workerError("invocation", detail, cause));
          Deferred.doneUnsafe(activation, Effect.fail(workerError("activation", detail, cause)));
          Queue.offerUnsafe(crashes, { sessionId, detail });
        };

        const command = ChildProcess.make(
          process.execPath,
          [
            `--max-old-space-size=${String(options.memoryLimitMb)}`,
            "--no-addons",
            "--enable-source-maps",
            "--unhandled-rejections=strict",
            runtimePath,
            input.entrypointPath,
            input.pluginId,
          ],
          {
            cwd: input.workingDirectory ?? path.dirname(input.entrypointPath),
            env: { PATH: process.env.PATH, NODE_NO_WARNINGS: "1" },
            stdin: Stream.fromQueue(inputQueue),
            stdout: "pipe",
            stderr: "pipe",
            shell: false,
            killSignal: "SIGTERM",
            forceKillAfter: "1 second",
          },
        );
        const handle = yield* childProcessSpawner.spawn(command).pipe(
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.mapError((cause) => workerError("activation", "worker failed to start", cause)),
        );

        const handleMessage = Effect.fn("PluginWorkerSupervisor.handleMessage")(function* (
          line: string,
        ) {
          if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
            return yield* workerError("protocol", "worker protocol line exceeds limit");
          }
          const message = yield* decodeWorkerMessage(line).pipe(
            Effect.mapError((cause) =>
              workerError("protocol", "worker sent an invalid message", cause),
            ),
          );
          switch (message.type) {
            case "activated":
              Deferred.doneUnsafe(
                activation,
                Effect.succeed({ commands: message.commands, ui: message.ui }),
              );
              return;
            case "activationFailed":
              Deferred.doneUnsafe(
                activation,
                Effect.fail(workerError("activation", message.detail)),
              );
              return;
            case "invocationResult": {
              const resume = pending.get(message.requestId);
              if (resume !== undefined) {
                pending.delete(message.requestId);
                resume(Effect.succeed(message.value));
              }
              return;
            }
            case "invocationFailed": {
              const resume = pending.get(message.requestId);
              if (resume !== undefined) {
                pending.delete(message.requestId);
                resume(Effect.fail(workerError("invocation", message.detail)));
              }
              return;
            }
            case "disposed": {
              const resume = pending.get(message.requestId);
              if (resume !== undefined) {
                pending.delete(message.requestId);
                resume(Effect.succeed(undefined));
              }
              return;
            }
            case "disposeFailed": {
              const resume = pending.get(message.requestId);
              if (resume !== undefined) {
                pending.delete(message.requestId);
                resume(Effect.fail(workerError("dispose", message.detail)));
              }
              return;
            }
            case "hostCall": {
              if (pendingHostCalls >= MAX_PENDING_HOST_CALLS) {
                send({
                  type: "hostFailed",
                  callId: message.callId,
                  detail: "too many pending host capability calls",
                });
                return;
              }
              pendingHostCalls += 1;
              const hostCall = hostCallSemaphore
                .withPermits(1)(dispatchHostCall(message))
                .pipe(
                  Effect.match({
                    onFailure: (cause) => {
                      send({
                        type: "hostFailed",
                        callId: message.callId,
                        detail: detailFrom(cause),
                      });
                    },
                    onSuccess: (value) => {
                      const sent = send({
                        type: "hostResult",
                        callId: message.callId,
                        ...(value === undefined ? {} : { value: value as Schema.Json }),
                      });
                      if (!sent) {
                        send({
                          type: "hostFailed",
                          callId: message.callId,
                          detail: "host capability result exceeds protocol limit",
                        });
                      }
                    },
                  }),
                  Effect.ensuring(
                    Effect.sync(() => {
                      pendingHostCalls -= 1;
                    }),
                  ),
                );
              yield* Effect.forkIn(hostCall, sessionScope);
              return;
            }
          }
        });

        const readProtocolChunk = Effect.fn("PluginWorkerSupervisor.readProtocolChunk")(function* (
          chunk: Uint8Array,
        ) {
          protocolBuffer += protocolDecoder.decode(chunk, { stream: true });
          let newline = protocolBuffer.indexOf("\n");
          while (newline >= 0) {
            const line = protocolBuffer.slice(0, newline);
            protocolBuffer = protocolBuffer.slice(newline + 1);
            if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
              return yield* workerError("protocol", "worker protocol line exceeds limit");
            }
            if (line.length > 0) yield* handleMessage(line);
            newline = protocolBuffer.indexOf("\n");
          }
          if (Buffer.byteLength(protocolBuffer, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
            return yield* workerError("protocol", "worker protocol line exceeds limit");
          }
        });

        const reader = handle.stdout.pipe(
          Stream.runForEach(readProtocolChunk),
          Effect.catchCause((cause) =>
            Effect.sync(() =>
              reportCrash(`worker protocol failed: ${detailFromCause(cause)}`, Cause.squash(cause)),
            ).pipe(Effect.tap(() => handle.kill().pipe(Effect.ignore))),
          ),
        );
        yield* Effect.forkIn(reader, sessionScope);

        const stderrReader = handle.stderr.pipe(
          Stream.runForEach((chunk) =>
            Effect.sync(() => {
              stderrBytes = Math.min(MAX_STDERR_BYTES, stderrBytes + chunk.byteLength);
            }),
          ),
          Effect.ignore,
        );
        yield* Effect.forkIn(stderrReader, sessionScope);

        const exitWatcher = handle.exitCode.pipe(
          Effect.tap((exitCode) =>
            Effect.sync(() => {
              if (!closing) {
                reportCrash(
                  `worker exited with code ${String(exitCode)}${stderrBytes === 0 ? "" : ` after ${String(stderrBytes)} stderr bytes`}`,
                );
              }
            }),
          ),
          Effect.ignore,
        );
        yield* Effect.forkIn(exitWatcher, sessionScope);

        const activated = yield* Deferred.await(activation).pipe(
          Effect.timeout(options.activationTimeout),
          Effect.mapError((cause) =>
            isPluginWorkerError(cause)
              ? cause
              : workerError("activation", "worker activation timed out", cause),
          ),
          Effect.onError(() => Scope.close(sessionScope, Exit.void)),
        );

        const request = (
          message:
            | {
                readonly type: "invoke";
                readonly commandId: string;
                readonly context?: PluginCommandInvocationContext;
              }
            | { readonly type: "dispose" },
        ): Effect.Effect<unknown, PluginWorkerError> =>
          Effect.callback((resume, signal) => {
            const requestId = `request-${++requestSequence}`;
            const onAbort = () => {
              pending.delete(requestId);
              send({ type: "cancel", requestId });
            };
            if (signal.aborted) {
              onAbort();
              return;
            }
            signal.addEventListener("abort", onAbort, { once: true });
            pending.set(requestId, (effect) => {
              signal.removeEventListener("abort", onAbort);
              resume(effect);
            });
            if (!send({ ...message, requestId } as PluginWorkerParentMessage)) {
              pending.delete(requestId);
              resume(Effect.fail(workerError("protocol", "worker input is unavailable")));
            }
          });

        const close = Effect.uninterruptible(
          Effect.sync(() => {
            closing = true;
            failPending(workerError("dispose", "worker stopped"));
            Queue.endUnsafe(inputQueue);
          }).pipe(Effect.flatMap(() => Scope.close(sessionScope, Exit.void))),
        );

        return {
          id: sessionId,
          commands: activated.commands,
          ui: activated.ui,
          invoke: (commandId, context) =>
            request({
              type: "invoke",
              commandId,
              ...(context === undefined ? {} : { context }),
            }).pipe(
              Effect.mapError((error) =>
                isPluginWorkerError(error)
                  ? error
                  : workerError("invocation", "worker invocation failed", error),
              ),
            ),
          requestDispose: request({ type: "dispose" }).pipe(Effect.asVoid),
          terminate: (detail) =>
            Effect.sync(() => reportCrash(detail)).pipe(Effect.flatMap(() => close)),
          close,
        } satisfies Session;
      });

      const firstSessionExit = yield* Effect.exit(spawnSession());
      if (firstSessionExit._tag === "Failure") {
        yield* Scope.close(workerScope, Exit.void);
        return yield* Effect.failCause(firstSessionExit.cause);
      }
      current = firstSessionExit.value;
      expectedCommands = current.commands;
      expectedUi = current.ui;
      health = { state: "running", restartCount: 0 };

      const restartLoop = Effect.forever(
        Queue.take(crashes).pipe(
          Effect.flatMap((event) =>
            transition.withPermits(1)(
              Effect.gen(function* () {
                if (disposed || current?.id !== event.sessionId) return;
                yield* current.close;
                while (restartCount < options.maxRestarts) {
                  if (disposed) return;
                  restartCount += 1;
                  health = { state: "restarting", detail: event.detail, restartCount };
                  yield* Effect.sleep(options.restartDelay);
                  const restarted = yield* Effect.exit(spawnSession());
                  if (restarted._tag === "Failure") {
                    health = {
                      state: "restarting",
                      detail: detailFromCause(restarted.cause),
                      restartCount,
                    };
                    continue;
                  }
                  if (
                    !sameCommands(restarted.value.commands, expectedCommands) ||
                    encodeUi(restarted.value.ui) !== encodeUi(expectedUi)
                  ) {
                    yield* restarted.value.close;
                    health = {
                      state: "crashed",
                      detail: "restarted worker changed its contribution catalog",
                      restartCount,
                    };
                    return;
                  }
                  current = restarted.value;
                  health = { state: "running", restartCount };
                  return;
                }
                health = { state: "crashed", detail: event.detail, restartCount };
              }),
            ),
          ),
        ),
      );
      yield* Effect.forkIn(restartLoop, workerScope);

      const disposeFiber = Deferred.await(disposeRequest).pipe(
        Effect.flatMap(() =>
          Effect.exit(
            transition.withPermits(1)(
              Effect.gen(function* () {
                if (disposed) return;
                disposed = true;
                const wasCrashed = health.state === "crashed";
                health = { state: "stopped", restartCount };
                const disposeExit =
                  current === undefined || wasCrashed
                    ? undefined
                    : yield* Effect.exit(
                        current.requestDispose.pipe(
                          Effect.timeout(options.disposeTimeout),
                          Effect.catchTags({
                            TimeoutError: (cause) =>
                              Effect.fail(
                                workerError("dispose", "worker disposal timed out", cause),
                              ),
                          }),
                        ),
                      );
                yield* Scope.close(workerScope, Exit.void);
                if (disposeExit?._tag === "Failure") {
                  const failure = Cause.squash(disposeExit.cause);
                  return yield* isPluginWorkerError(failure)
                    ? failure
                    : workerError("dispose", "worker dispose failed", failure);
                }
              }),
            ),
          ),
        ),
        Effect.tap((exit) =>
          Effect.sync(() => {
            Deferred.doneUnsafe(disposeResult, exit);
          }),
        ),
      );
      yield* Effect.forkIn(disposeFiber, parentScope);

      const invoke = (commandId: string, context?: PluginCommandInvocationContext) =>
        Effect.gen(function* () {
          const session = yield* transition.withPermits(1)(
            Effect.gen(function* () {
              if (disposed) return yield* workerError("invocation", "worker is stopped");
              if (health.state !== "running" || current === undefined) {
                return yield* workerError("invocation", health.detail ?? "worker is unavailable");
              }
              return current;
            }),
          );
          const result = yield* session.invoke(commandId, context).pipe(
            Effect.timeout(options.invocationTimeout),
            Effect.catchTags({
              TimeoutError: (cause) =>
                session
                  .terminate("worker invocation timed out")
                  .pipe(
                    Effect.flatMap(() =>
                      Effect.fail(workerError("invocation", "worker invocation timed out", cause)),
                    ),
                  ),
            }),
            Effect.onInterrupt(() => session.terminate("worker invocation interrupted")),
          );
          yield* transition.withPermits(1)(
            Effect.sync(() => {
              if (!disposed && current?.id === session.id && health.state === "running") {
                restartCount = 0;
                health = { state: "running", restartCount: 0 };
              }
            }),
          );
          return result;
        });

      return {
        commands: expectedCommands,
        ui: expectedUi,
        invoke,
        dispose: Effect.sync(() => Deferred.doneUnsafe(disposeRequest, Effect.void)).pipe(
          Effect.flatMap(() => Deferred.await(disposeResult)),
        ),
        health: () => health,
      } satisfies SupervisedPluginWorker;
    }).pipe(
      Effect.onInterrupt(() =>
        allocatedScope === undefined
          ? Effect.succeed(undefined)
          : Scope.close(allocatedScope, Exit.void),
      ),
      Effect.mapError((cause) =>
        isPluginWorkerError(cause)
          ? cause
          : new PluginWorkerError({
              pluginId: input.pluginId,
              phase: "activation",
              detail: "worker supervisor failed",
              cause,
            }),
      ),
    );
  };

  return PluginWorkerSupervisor.of({ start });
});

export const layer = Layer.effect(PluginWorkerSupervisor, make);
