import * as Schema from "effect/Schema";

const NamespacedId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/),
  Schema.isMaxLength(255),
);

const CommandId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/),
  Schema.isMaxLength(200),
);

const SemanticVersion = Schema.String.check(
  Schema.isPattern(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  ),
);

const CapabilityId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9.-]*@[1-9]\d*$/));

const RelativeEntrypoint = Schema.String.check(
  Schema.isPattern(/^\.\/(?!(?:\.\.(?:\/|$)|.*\/\.\.(?:\/|$)))[A-Za-z0-9_./-]+$/),
);
const Permission = Schema.Union([
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
      /^network:https:\/\/[a-z0-9.-]+(?::(?!443$)(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5]))?$/,
    ),
    Schema.isMaxLength(255),
  ),
  Schema.String.check(
    Schema.isPattern(/^process:[A-Za-z0-9._+-]{1,128}$/),
    Schema.isMaxLength(136),
  ),
]);

const ContributionCatalog = Schema.Struct({
  commands: Schema.optional(Schema.Array(CommandId)),
  settings: Schema.optional(Schema.Array(NamespacedId)),
  navigation: Schema.optional(Schema.Array(NamespacedId)),
  views: Schema.optional(Schema.Array(NamespacedId)),
  cards: Schema.optional(Schema.Array(NamespacedId)),
  statusItems: Schema.optional(Schema.Array(NamespacedId)),
  composerActions: Schema.optional(Schema.Array(NamespacedId)),
  contextualActions: Schema.optional(Schema.Array(NamespacedId)),
  mobileCards: Schema.optional(Schema.Array(NamespacedId)),
});

const CompositionSlot = Schema.Literals([
  "commands",
  "settings",
  "navigation",
  "views",
  "cards",
  "statusItems",
  "composerActions",
  "contextualActions",
]);
const CompositionRuleBase = {
  id: NamespacedId,
  slot: CompositionSlot,
  targetId: NamespacedId,
} as const;
const CompositionPlacementRule = Schema.Struct({
  ...CompositionRuleBase,
  operation: Schema.Literals(["extend", "replace"]),
  sourceId: NamespacedId,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const CompositionDecorationRule = Schema.Struct({
  ...CompositionRuleBase,
  operation: Schema.Literal("decorate"),
  patch: Schema.Struct({
    label: Schema.optional(Schema.String.check(Schema.isMaxLength(120))),
    data: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const CompositionDisableRule = Schema.Struct({
  ...CompositionRuleBase,
  operation: Schema.Literal("disable"),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
const CompositionRule = Schema.Union([
  CompositionPlacementRule,
  CompositionDecorationRule,
  CompositionDisableRule,
]);

export const PluginManifest = Schema.Struct({
  manifestVersion: Schema.Literal(1),
  id: NamespacedId,
  version: SemanticVersion,
  forkOf: Schema.optional(NamespacedId),
  apiVersion: Schema.Literal(1),
  surfaces: Schema.optional(Schema.Array(Schema.Literals(["web", "desktop", "mobile"]))),
  entrypoints: Schema.Struct({
    server: Schema.optional(RelativeEntrypoint),
    web: Schema.optional(RelativeEntrypoint),
    desktop: Schema.optional(RelativeEntrypoint),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  capabilities: Schema.Array(CapabilityId),
  requires: Schema.optional(Schema.Array(CapabilityId)),
  optional: Schema.optional(Schema.Array(CapabilityId)),
  provides: Schema.optional(Schema.Array(CapabilityId)),
  permissions: Schema.optional(Schema.Array(Permission)),
  contributes: ContributionCatalog,
  composition: Schema.optional(Schema.Array(CompositionRule).check(Schema.isMaxLength(100))),
})
  .annotate({ parseOptions: { onExcessProperty: "error" } })
  .check(
    Schema.makeFilter(
      (manifest) =>
        manifest.forkOf === undefined ||
        manifest.forkOf !== manifest.id ||
        "plugin forkOf must name another package",
    ),
    Schema.makeFilter(
      (manifest) =>
        new Set((manifest.composition ?? []).map((rule) => rule.id)).size ===
          (manifest.composition ?? []).length || "plugin composition rule ids must be unique",
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });

export type PluginManifest = typeof PluginManifest.Type;
