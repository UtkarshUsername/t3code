import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PluginCommandId } from "./pluginCommands.ts";

export const PluginPackageId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/),
  Schema.isMaxLength(255),
);
export type PluginPackageId = typeof PluginPackageId.Type;

export const PluginUiId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/),
  Schema.isMaxLength(255),
);
export type PluginUiId = typeof PluginUiId.Type;

export const PluginPackageCapability = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9.-]*@[1-9]\d*$/),
);
export type PluginPackageCapability = typeof PluginPackageCapability.Type;

export const PluginHostPermission = Schema.Union([
  Schema.Literals([
    "settings:read-write",
    "state:read-write",
    "cache:read-write",
    "filesystem:data",
    "notifications:send",
  ]),
  Schema.String.check(
    Schema.isPattern(/^secrets:[a-z0-9][a-z0-9._-]{0,127}$/),
    Schema.isMaxLength(136),
  ),
  Schema.String.check(
    Schema.isPattern(
      /^network:https:\/\/[A-Za-z0-9.-]+(?::(?!443$)(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5]))?$/,
    ),
    Schema.isMaxLength(255),
  ),
  Schema.String.check(
    Schema.isPattern(/^process:[A-Za-z0-9._+-]{1,128}$/),
    Schema.isMaxLength(136),
  ),
]);
export type PluginHostPermission = typeof PluginHostPermission.Type;

export const PluginPackageState = Schema.Literals([
  "disabled",
  "active",
  "blocked",
  "restarting",
  "crashed",
  "error",
]);
export type PluginPackageState = typeof PluginPackageState.Type;

export const PluginPackageRuntimeState = Schema.Literals([
  "stopped",
  "starting",
  "running",
  "restarting",
  "crashed",
]);
export type PluginPackageRuntimeState = typeof PluginPackageRuntimeState.Type;

export const PluginPackageContributions = Schema.Struct({
  commands: Schema.Array(PluginCommandId),
  settings: Schema.Array(PluginUiId),
  navigation: Schema.Array(PluginUiId),
  views: Schema.Array(PluginUiId),
  cards: Schema.Array(PluginUiId),
  statusItems: Schema.Array(PluginUiId),
  composerActions: Schema.Array(PluginUiId),
  contextualActions: Schema.Array(PluginUiId),
});
export type PluginPackageContributions = typeof PluginPackageContributions.Type;

export const PluginPackageStatus = Schema.Struct({
  id: PluginPackageId,
  version: TrimmedNonEmptyString,
  apiVersion: Schema.Literal(1),
  enabled: Schema.Boolean,
  state: PluginPackageState,
  runtimeState: PluginPackageRuntimeState,
  restartCount: NonNegativeInt,
  capabilities: Schema.Array(PluginPackageCapability),
  permissions: Schema.Array(PluginHostPermission),
  grantedPermissions: Schema.Array(PluginHostPermission),
  contributions: PluginPackageContributions,
  error: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))),
});
export type PluginPackageStatus = typeof PluginPackageStatus.Type;

export const PluginPackageDiscoveryError = Schema.Struct({
  directory: TrimmedNonEmptyString.check(Schema.isMaxLength(255), Schema.isPattern(/^[^/\\]+$/)),
  error: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
});
export type PluginPackageDiscoveryError = typeof PluginPackageDiscoveryError.Type;

export const PluginPackageStatusSnapshot = Schema.Struct({
  errors: Schema.Array(PluginPackageDiscoveryError),
  packages: Schema.Array(PluginPackageStatus),
});
export type PluginPackageStatusSnapshot = typeof PluginPackageStatusSnapshot.Type;

export const PluginPackageActionInput = Schema.Struct({
  id: PluginPackageId,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type PluginPackageActionInput = typeof PluginPackageActionInput.Type;

export const PluginPackageOperation = Schema.Literals(["status", "enable", "disable", "reload"]);
export type PluginPackageOperation = typeof PluginPackageOperation.Type;

export class PluginPackageNotFoundError extends Schema.TaggedErrorClass<PluginPackageNotFoundError>()(
  "PluginPackageNotFoundError",
  { id: PluginPackageId },
) {
  override get message(): string {
    return `Plugin package not found: ${this.id}`;
  }
}

export class PluginPackageOperationError extends Schema.TaggedErrorClass<PluginPackageOperationError>()(
  "PluginPackageOperationError",
  {
    id: Schema.optional(PluginPackageId),
    operation: PluginPackageOperation,
    detail: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const packageName = this.id === undefined ? "plugin packages" : `plugin package ${this.id}`;
    const detail = this.detail === undefined ? "" : `: ${this.detail}`;
    return `${this.operation} failed for ${packageName}${detail}`;
  }
}
