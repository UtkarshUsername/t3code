export type ContributionData =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<ContributionData>
  | { readonly [key: string]: ContributionData };

export type PluginOrigin = "core" | "bundled" | "installed" | "local-fork";
export type PluginCompositionOperation = "extend" | "decorate" | "replace" | "disable";

interface PluginCompositionRuleBase {
  readonly id: string;
  readonly operation: PluginCompositionOperation;
  readonly slot: string;
  readonly targetId: string;
}

export interface PluginCompositionPlacementRule extends PluginCompositionRuleBase {
  readonly operation: "extend" | "replace";
  readonly sourceId: string;
}

export interface PluginCompositionDecorationRule extends PluginCompositionRuleBase {
  readonly operation: "decorate";
  readonly patch: {
    readonly label?: string | undefined;
    readonly data?: Readonly<Record<string, ContributionData>> | undefined;
  };
}

export interface PluginCompositionDisableRule extends PluginCompositionRuleBase {
  readonly operation: "disable";
}

export type PluginCompositionRule =
  | PluginCompositionPlacementRule
  | PluginCompositionDecorationRule
  | PluginCompositionDisableRule;

export interface ContributionCompositionPolicy {
  readonly allowed: ReadonlyArray<PluginCompositionOperation>;
}

export interface Contribution<Data extends ContributionData = ContributionData> {
  readonly id: string;
  readonly label: string;
  readonly data?: Data;
  readonly composition?: ContributionCompositionPolicy;
}

export interface PluginRuntimeContribution<
  Data extends ContributionData = ContributionData,
> extends Contribution<Data> {
  readonly owner: { readonly origin: PluginOrigin; readonly pluginId: string };
  readonly decoratedBy: ReadonlyArray<string>;
  readonly replaces?: string;
}

export interface PluginCompositionDiagnostic {
  readonly operation: PluginCompositionOperation;
  readonly outcome: "applied" | "ignored";
  readonly pluginId: string;
  readonly reason:
    | "applied"
    | "forbidden"
    | "higher-precedence-rule"
    | "missing-source"
    | "missing-target"
    | "source-not-owned";
  readonly ruleId: string;
  readonly slot: string;
  readonly sourceId?: string;
  readonly targetId: string;
}

export interface PluginDefinition {
  readonly id: string;
  readonly version: string;
  readonly requires?: ReadonlyArray<string>;
  readonly optional?: ReadonlyArray<string>;
  readonly provides?: Readonly<Record<string, unknown>>;
  readonly origin?: PluginOrigin;
  readonly composition?: ReadonlyArray<PluginCompositionRule>;
  readonly activate: (context: PluginActivationContext) => void | Promise<void>;
}

export interface PluginActivationContext {
  readonly resolve: <Service>(capability: string) => Service;
  readonly resolveOptional: <Service>(capability: string) => Service | undefined;
  readonly register: {
    (slot: string, contribution: Contribution): void;
    <Value>(slot: string, contribution: Contribution, value: Value): void;
  };
  readonly onDispose: (finalizer: () => void | Promise<void>) => void;
}

export interface PluginRuntimeContributionSnapshot {
  readonly generation: number;
  readonly entries: ReadonlyArray<PluginRuntimeContribution>;
}

export interface PluginRuntimeSnapshot {
  readonly active: ReadonlyArray<string>;
  readonly blocked: Readonly<Partial<Record<string, string>>>;
  readonly contributions: Readonly<
    Partial<Record<string, ReadonlyArray<PluginRuntimeContribution>>>
  >;
  readonly composition: ReadonlyArray<PluginCompositionDiagnostic>;
  readonly origins: Readonly<Partial<Record<string, PluginOrigin>>>;
}

export interface PluginRuntimeOptions {
  readonly validateSnapshot?: (snapshot: PluginRuntimeSnapshot) => void;
  readonly onLifecycle?: (event: {
    readonly phase: "activate" | "deactivate";
    readonly pluginId: string;
  }) => void;
  readonly onLifecycleError?: (event: {
    readonly phase: "activate" | "deactivate";
    readonly pluginId: string;
    readonly error: unknown;
  }) => void;
  readonly onCleanupError?: (event: {
    readonly phase: "retire" | "rollback";
    readonly error: unknown;
  }) => void;
}
