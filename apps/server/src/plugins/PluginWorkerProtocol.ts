import {
  PluginCommand,
  type PluginCommandInvocationContext,
  PluginUiContribution,
  PluginUiNotificationInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const strict = <S extends Schema.Top>(schema: S) =>
  schema.annotate({ parseOptions: { onExcessProperty: "error" } });

export const PluginWorkerRequestId = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/),
);
export type PluginWorkerRequestId = typeof PluginWorkerRequestId.Type;

const DataKey = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,127}$/));
const RelativeDataPath = Schema.String.check(
  Schema.isMaxLength(500),
  Schema.isPattern(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/),
);
const Detail = Schema.String.check(Schema.isMaxLength(2_000));

const Activated = strict(
  Schema.Struct({
    type: Schema.Literal("activated"),
    commands: Schema.Array(PluginCommand),
    ui: PluginUiContribution,
  }),
);
const ActivationFailed = strict(
  Schema.Struct({ type: Schema.Literal("activationFailed"), detail: Detail }),
);
const InvocationResult = strict(
  Schema.Struct({
    type: Schema.Literal("invocationResult"),
    requestId: PluginWorkerRequestId,
    value: Schema.Json,
  }),
);
const InvocationFailed = strict(
  Schema.Struct({
    type: Schema.Literal("invocationFailed"),
    requestId: PluginWorkerRequestId,
    detail: Detail,
  }),
);
const Disposed = strict(
  Schema.Struct({ type: Schema.Literal("disposed"), requestId: PluginWorkerRequestId }),
);
const DisposeFailed = strict(
  Schema.Struct({
    type: Schema.Literal("disposeFailed"),
    requestId: PluginWorkerRequestId,
    detail: Detail,
  }),
);

const keyedHostCall = <O extends string>(operation: O) =>
  strict(
    Schema.Struct({
      type: Schema.Literal("hostCall"),
      callId: PluginWorkerRequestId,
      operation: Schema.Literal(operation),
      key: DataKey,
    }),
  );
const valuedHostCall = <O extends string>(operation: O) =>
  strict(
    Schema.Struct({
      type: Schema.Literal("hostCall"),
      callId: PluginWorkerRequestId,
      operation: Schema.Literal(operation),
      key: DataKey,
      value: Schema.Json,
    }),
  );
const clearHostCall = <O extends string>(operation: O) =>
  strict(
    Schema.Struct({
      type: Schema.Literal("hostCall"),
      callId: PluginWorkerRequestId,
      operation: Schema.Literal(operation),
    }),
  );

const SecretSet = strict(
  Schema.Struct({
    type: Schema.Literal("hostCall"),
    callId: PluginWorkerRequestId,
    operation: Schema.Literal("secrets.set"),
    name: DataKey,
    value: Schema.String.check(Schema.isMaxLength(1_000_000)),
  }),
);
const SecretAccess = (operation: "secrets.get" | "secrets.delete") =>
  strict(
    Schema.Struct({
      type: Schema.Literal("hostCall"),
      callId: PluginWorkerRequestId,
      operation: Schema.Literal(operation),
      name: DataKey,
    }),
  );
const FileWrite = strict(
  Schema.Struct({
    type: Schema.Literal("hostCall"),
    callId: PluginWorkerRequestId,
    operation: Schema.Literal("files.writeText"),
    path: RelativeDataPath,
    contents: Schema.String.check(Schema.isMaxLength(1_000_000)),
  }),
);
const FileAccess = (operation: "files.readText" | "files.remove") =>
  strict(
    Schema.Struct({
      type: Schema.Literal("hostCall"),
      callId: PluginWorkerRequestId,
      operation: Schema.Literal(operation),
      path: RelativeDataPath,
    }),
  );
const NetworkFetch = strict(
  Schema.Struct({
    type: Schema.Literal("hostCall"),
    callId: PluginWorkerRequestId,
    operation: Schema.Literal("network.fetchText"),
    url: Schema.String.check(Schema.isMaxLength(2_000)),
  }),
);
const ProcessRun = strict(
  Schema.Struct({
    type: Schema.Literal("hostCall"),
    callId: PluginWorkerRequestId,
    operation: Schema.Literal("process.run"),
    command: Schema.String.check(Schema.isMaxLength(128)),
    args: Schema.Array(Schema.String.check(Schema.isMaxLength(10_000))).check(
      Schema.isMaxLength(256),
    ),
  }),
);
const UiNotify = strict(
  Schema.Struct({
    type: Schema.Literal("hostCall"),
    callId: PluginWorkerRequestId,
    operation: Schema.Literal("ui.notify"),
    notification: PluginUiNotificationInput,
  }),
);

export const PluginWorkerHostCall = Schema.Union([
  keyedHostCall("settings.get"),
  valuedHostCall("settings.set"),
  keyedHostCall("settings.delete"),
  clearHostCall("settings.clear"),
  keyedHostCall("state.get"),
  valuedHostCall("state.set"),
  keyedHostCall("state.delete"),
  clearHostCall("state.clear"),
  keyedHostCall("cache.get"),
  valuedHostCall("cache.set"),
  keyedHostCall("cache.delete"),
  clearHostCall("cache.clear"),
  SecretSet,
  SecretAccess("secrets.get"),
  SecretAccess("secrets.delete"),
  FileWrite,
  FileAccess("files.readText"),
  FileAccess("files.remove"),
  NetworkFetch,
  ProcessRun,
  UiNotify,
]);
export type PluginWorkerHostCall = typeof PluginWorkerHostCall.Type;

export const PluginWorkerMessage = Schema.Union([
  Activated,
  ActivationFailed,
  InvocationResult,
  InvocationFailed,
  Disposed,
  DisposeFailed,
  PluginWorkerHostCall,
]);
export type PluginWorkerMessage = typeof PluginWorkerMessage.Type;

export type PluginWorkerParentMessage =
  | {
      readonly type: "invoke";
      readonly requestId: string;
      readonly commandId: string;
      readonly context?: PluginCommandInvocationContext;
    }
  | { readonly type: "cancel"; readonly requestId: string }
  | { readonly type: "dispose"; readonly requestId: string }
  | { readonly type: "hostResult"; readonly callId: string; readonly value?: Schema.Json }
  | { readonly type: "hostFailed"; readonly callId: string; readonly detail: string };
