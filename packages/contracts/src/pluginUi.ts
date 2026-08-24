import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PluginCommandId, PluginCommandSurface } from "./pluginCommands.ts";
import { PluginPackageId, PluginUiId } from "./pluginPackages.ts";

const strict = <S extends Schema.Top>(schema: S) =>
  schema.annotate({ parseOptions: { onExcessProperty: "error" } });

const ShortLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(120));
const Description = TrimmedNonEmptyString.check(Schema.isMaxLength(500));
const DisplayText = TrimmedNonEmptyString.check(Schema.isMaxLength(2_000));
const SettingText = Schema.String.check(Schema.isMaxLength(2_000));

export const PluginUiTone = Schema.Literals([
  "neutral",
  "muted",
  "info",
  "success",
  "warning",
  "danger",
]);
export type PluginUiTone = typeof PluginUiTone.Type;

const Surfaces = Schema.Array(PluginCommandSurface).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(3),
);

const SettingBase = {
  id: PluginUiId,
  label: ShortLabel,
  description: Schema.optional(Description),
  surfaces: Surfaces,
} as const;

export const PluginUiBooleanSetting = strict(
  Schema.Struct({
    ...SettingBase,
    kind: Schema.Literal("boolean"),
    defaultValue: Schema.Boolean,
  }),
);

export const PluginUiTextSetting = strict(
  Schema.Struct({
    ...SettingBase,
    kind: Schema.Literal("text"),
    defaultValue: SettingText,
    placeholder: Schema.optional(ShortLabel),
  }),
);

const SelectOption = strict(
  Schema.Struct({
    label: ShortLabel,
    value: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  }),
);

export const PluginUiSelectSetting = strict(
  strict(
    Schema.Struct({
      ...SettingBase,
      kind: Schema.Literal("select"),
      defaultValue: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
      options: Schema.Array(SelectOption).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
    }),
  ).check(
    Schema.makeFilter(
      (setting) =>
        setting.options.some((option) => option.value === setting.defaultValue) ||
        "select defaultValue must name an option",
    ),
  ),
);

export const PluginUiSetting = Schema.Union([
  PluginUiBooleanSetting,
  PluginUiTextSetting,
  PluginUiSelectSetting,
]);
export type PluginUiSetting = typeof PluginUiSetting.Type;

export const PluginUiAction = strict(
  Schema.Struct({
    id: PluginUiId,
    label: ShortLabel,
    description: Schema.optional(Description),
    commandId: PluginCommandId,
    surfaces: Surfaces,
  }),
);
export type PluginUiAction = typeof PluginUiAction.Type;

export const PluginUiContextualAction = strict(
  Schema.Struct({
    id: PluginUiId,
    label: ShortLabel,
    description: Schema.optional(Description),
    commandId: PluginCommandId,
    contexts: Schema.Array(Schema.Literals(["thread", "project", "file", "diff"])).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(4),
    ),
    surfaces: Surfaces,
  }),
);
export type PluginUiContextualAction = typeof PluginUiContextualAction.Type;

export const PluginUiCard = strict(
  Schema.Struct({
    id: PluginUiId,
    title: ShortLabel,
    description: Schema.optional(Description),
    value: Schema.optional(DisplayText),
    tone: Schema.optional(PluginUiTone),
    actionId: Schema.optional(PluginUiId),
    surfaces: Surfaces,
  }),
);
export type PluginUiCard = typeof PluginUiCard.Type;

export const PluginUiStatusItem = strict(
  Schema.Struct({
    id: PluginUiId,
    label: ShortLabel,
    value: DisplayText,
    tone: Schema.optional(PluginUiTone),
    surfaces: Surfaces,
  }),
);
export type PluginUiStatusItem = typeof PluginUiStatusItem.Type;

const TextBlock = strict(
  Schema.Struct({
    kind: Schema.Literal("text"),
    text: DisplayText,
    tone: Schema.optional(PluginUiTone),
  }),
);
const ActionBlock = strict(
  Schema.Struct({
    kind: Schema.Literal("action"),
    id: PluginUiId,
    label: ShortLabel,
    description: Schema.optional(Description),
    commandId: PluginCommandId,
  }),
);
const CardBlock = strict(
  Schema.Struct({
    kind: Schema.Literal("card"),
    id: PluginUiId,
    title: ShortLabel,
    description: Schema.optional(Description),
    value: Schema.optional(DisplayText),
    tone: Schema.optional(PluginUiTone),
    commandId: Schema.optional(PluginCommandId),
  }),
);
const StatusBlock = strict(
  Schema.Struct({
    kind: Schema.Literal("status"),
    id: PluginUiId,
    label: ShortLabel,
    value: DisplayText,
    tone: Schema.optional(PluginUiTone),
  }),
);

export const PluginUiBlock = Schema.Union([TextBlock, ActionBlock, CardBlock, StatusBlock]);
export type PluginUiBlock = typeof PluginUiBlock.Type;

export const PluginUiView = strict(
  Schema.Struct({
    id: PluginUiId,
    label: ShortLabel,
    description: Schema.optional(Description),
    surfaces: Surfaces,
    blocks: Schema.Array(PluginUiBlock).check(Schema.isMaxLength(100)),
  }),
);
export type PluginUiView = typeof PluginUiView.Type;

export const PluginUiNavigationItem = strict(
  Schema.Struct({
    id: PluginUiId,
    label: ShortLabel,
    viewId: PluginUiId,
    surfaces: Surfaces,
  }),
);
export type PluginUiNavigationItem = typeof PluginUiNavigationItem.Type;

const bounded = <S extends Schema.Top>(schema: S) =>
  Schema.Array(schema).check(Schema.isMaxLength(100));
const uniqueIds = (items: ReadonlyArray<{ readonly id: string }>) =>
  new Set(items.map((item) => item.id)).size === items.length;

export const PluginUiContribution = strict(
  strict(
    Schema.Struct({
      settings: bounded(PluginUiSetting),
      navigation: bounded(PluginUiNavigationItem),
      views: bounded(PluginUiView),
      cards: bounded(PluginUiCard),
      statusItems: bounded(PluginUiStatusItem),
      composerActions: bounded(PluginUiAction),
      contextualActions: bounded(PluginUiContextualAction),
    }),
  ).check(
    Schema.makeFilter(
      (input) =>
        [
          input.settings,
          input.navigation,
          input.views,
          input.cards,
          input.statusItems,
          input.composerActions,
          input.contextualActions,
        ].every(uniqueIds) || "plugin ui contribution ids must be unique within each slot",
    ),
    Schema.makeFilter((input) => {
      const viewIds = new Set(input.views.map((view) => view.id));
      return (
        input.navigation.every((item) => viewIds.has(item.viewId)) ||
        "plugin navigation must reference a contributed view"
      );
    }),
  ),
);
export type PluginUiContribution = typeof PluginUiContribution.Type;

export const PluginUiPackageContribution = strict(
  Schema.Struct({
    pluginId: PluginPackageId,
    settings: bounded(PluginUiSetting),
    navigation: bounded(PluginUiNavigationItem),
    views: bounded(PluginUiView),
    cards: bounded(PluginUiCard),
    statusItems: bounded(PluginUiStatusItem),
    composerActions: bounded(PluginUiAction),
    contextualActions: bounded(PluginUiContextualAction),
  }),
);
export type PluginUiPackageContribution = typeof PluginUiPackageContribution.Type;

export const PluginUiCatalog = strict(
  Schema.Struct({
    generation: NonNegativeInt,
    packages: Schema.Array(PluginUiPackageContribution).check(Schema.isMaxLength(1_000)),
  }),
);
export type PluginUiCatalog = typeof PluginUiCatalog.Type;

export const PluginUiNotification = strict(
  Schema.Struct({
    id: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
    pluginId: PluginPackageId,
    title: ShortLabel,
    message: DisplayText,
    tone: Schema.Literals(["info", "success", "warning", "error"]),
    commandId: Schema.optional(PluginCommandId),
  }),
);
export type PluginUiNotification = typeof PluginUiNotification.Type;

export const PluginUiNotificationInput = strict(
  Schema.Struct({
    id: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
    title: ShortLabel,
    message: DisplayText,
    tone: Schema.Literals(["info", "success", "warning", "error"]),
    commandId: Schema.optional(PluginCommandId),
  }),
);
export type PluginUiNotificationInput = typeof PluginUiNotificationInput.Type;

export const PluginUiSettingReadInput = strict(
  Schema.Struct({ pluginId: PluginPackageId, settingId: PluginUiId }),
);
export type PluginUiSettingReadInput = typeof PluginUiSettingReadInput.Type;

export const PluginUiSettingReadResult = strict(
  Schema.Struct({ value: Schema.optional(Schema.Json) }),
);
export type PluginUiSettingReadResult = typeof PluginUiSettingReadResult.Type;

export const PluginUiSettingWriteInput = strict(
  Schema.Struct({ pluginId: PluginPackageId, settingId: PluginUiId, value: Schema.Json }),
);
export type PluginUiSettingWriteInput = typeof PluginUiSettingWriteInput.Type;

export class PluginUiSettingError extends Schema.TaggedErrorClass<PluginUiSettingError>()(
  "PluginUiSettingError",
  {
    pluginId: PluginPackageId,
    settingId: PluginUiId,
    detail: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Plugin setting ${this.settingId} failed for ${this.pluginId}: ${this.detail}`;
  }
}
