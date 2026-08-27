import * as Schema from "effect/Schema";

import type {
  Contribution,
  ContributionData,
  PluginCompositionDiagnostic,
  PluginCompositionOperation,
  PluginCompositionRule,
  PluginOrigin,
} from "./contract.ts";

export interface PluginCompositionInputContribution {
  readonly slot: string;
  readonly contribution: Contribution;
  readonly value: unknown;
}

export interface PluginCompositionInput {
  readonly pluginId: string;
  readonly origin: PluginOrigin;
  readonly contributions: ReadonlyArray<PluginCompositionInputContribution>;
  readonly composition: ReadonlyArray<PluginCompositionRule>;
}

export interface ResolvedContributionRegistration {
  readonly contribution: Contribution;
  readonly owner: { readonly origin: PluginOrigin; readonly pluginId: string };
  readonly decoratedBy: ReadonlyArray<string>;
  readonly replaces?: string;
  readonly value: unknown;
}

export interface ResolvedContributionComposition {
  readonly diagnostics: ReadonlyArray<PluginCompositionDiagnostic>;
  readonly slots: ReadonlyMap<string, ReadonlyArray<ResolvedContributionRegistration>>;
}

export class PluginCompositionCycleError extends Schema.TaggedErrorClass<PluginCompositionCycleError>()(
  "PluginCompositionCycleError",
  { cycle: Schema.Array(Schema.String), slot: Schema.String },
) {
  override get message(): string {
    return `Plugin contribution cycle in ${this.slot}: ${this.cycle.join(" -> ")}`;
  }
}

export class PluginDuplicateCompositionRuleError extends Schema.TaggedErrorClass<PluginDuplicateCompositionRuleError>()(
  "PluginDuplicateCompositionRuleError",
  { pluginId: Schema.String, ruleId: Schema.String },
) {
  override get message(): string {
    return `Duplicate composition rule ${this.ruleId} in ${this.pluginId}`;
  }
}

export class PluginCompositionSourceConflictError extends Schema.TaggedErrorClass<PluginCompositionSourceConflictError>()(
  "PluginCompositionSourceConflictError",
  {
    firstRuleId: Schema.String,
    pluginId: Schema.String,
    secondRuleId: Schema.String,
    slot: Schema.String,
    sourceId: Schema.String,
  },
) {
  override get message(): string {
    return `Composition source ${this.slot}/${this.sourceId} is assigned by ${this.firstRuleId} and ${this.secondRuleId}`;
  }
}

export const PluginCompositionError = Schema.Union([
  PluginCompositionCycleError,
  PluginDuplicateCompositionRuleError,
  PluginCompositionSourceConflictError,
]);
export type PluginCompositionError = typeof PluginCompositionError.Type;
export const isPluginCompositionError = Schema.is(PluginCompositionError);

const originRank: Readonly<Record<PluginOrigin, number>> = {
  core: 0,
  bundled: 1,
  installed: 2,
  "local-fork": 3,
};

const keyOf = (slot: string, id: string) => `${slot}\u0000${id}`;
const allOperations: ReadonlyArray<PluginCompositionOperation> = [
  "extend",
  "decorate",
  "replace",
  "disable",
];

interface WorkingEntry {
  readonly key: string;
  readonly slot: string;
  readonly owner: { readonly origin: PluginOrigin; readonly pluginId: string };
  readonly originalIndex: number;
  readonly value: unknown;
  contribution: Contribution;
  readonly decoratedBy: Array<string>;
}

interface OwnedRule {
  readonly pluginId: string;
  readonly origin: PluginOrigin;
  readonly rule: PluginCompositionRule;
}

const compareRules = (left: OwnedRule, right: OwnedRule): number =>
  originRank[left.origin] - originRank[right.origin] ||
  left.pluginId.localeCompare(right.pluginId) ||
  left.rule.id.localeCompare(right.rule.id);

const diagnostic = (
  owned: OwnedRule,
  outcome: PluginCompositionDiagnostic["outcome"],
  reason: PluginCompositionDiagnostic["reason"],
): PluginCompositionDiagnostic =>
  Object.freeze({
    operation: owned.rule.operation,
    outcome,
    pluginId: owned.pluginId,
    reason,
    ruleId: owned.rule.id,
    slot: owned.rule.slot,
    ...(owned.rule.operation === "extend" || owned.rule.operation === "replace"
      ? { sourceId: owned.rule.sourceId }
      : {}),
    targetId: owned.rule.targetId,
  });

const cloneDataObject = (value: ContributionData | undefined): Record<string, ContributionData> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Object.create(null) as Record<string, ContributionData>;
  }
  return Object.assign(Object.create(null), value) as Record<string, ContributionData>;
};

const decorateContribution = (
  target: WorkingEntry,
  owned: OwnedRule & {
    readonly rule: Extract<PluginCompositionRule, { readonly operation: "decorate" }>;
  },
) => {
  const patch = owned.rule.patch;
  const data = cloneDataObject(target.contribution.data);
  for (const [key, value] of Object.entries(patch.data ?? {})) {
    if (value === null) delete data[key];
    else data[key] = value;
  }
  target.contribution = Object.freeze({
    ...target.contribution,
    ...(patch.label === undefined ? {} : { label: patch.label }),
    ...(target.contribution.data === undefined && patch.data === undefined
      ? {}
      : { data: Object.freeze(data) }),
  });
  target.decoratedBy.push(owned.pluginId);
};

const effectiveReplacement = (
  key: string,
  replacedBy: ReadonlyMap<string, string>,
  memo: Map<string, string>,
): string => {
  const cached = memo.get(key);
  if (cached !== undefined) return cached;
  let current = key;
  const path: Array<string> = [];
  while (replacedBy.has(current)) {
    const resolved = memo.get(current);
    if (resolved !== undefined) {
      current = resolved;
      break;
    }
    path.push(current);
    current = replacedBy.get(current)!;
  }
  for (const pathKey of path) memo.set(pathKey, current);
  memo.set(key, current);
  return current;
};

const assertNoReplacementCycles = (
  replacedBy: ReadonlyMap<string, string>,
  entriesByKey: ReadonlyMap<string, WorkingEntry>,
) => {
  const complete = new Set<string>();
  for (const start of replacedBy.keys()) {
    if (complete.has(start)) continue;
    const path: Array<string> = [];
    const indexes = new Map<string, number>();
    let current: string | undefined = start;
    while (current !== undefined && replacedBy.has(current)) {
      const cycleStart = indexes.get(current);
      if (cycleStart !== undefined) {
        const keys = [...path.slice(cycleStart), current];
        const cycle = keys.map((key) => entriesByKey.get(key)?.contribution.id ?? key);
        throw new PluginCompositionCycleError({
          cycle,
          slot: entriesByKey.get(current)?.slot ?? "unknown",
        });
      }
      if (complete.has(current)) break;
      indexes.set(current, path.length);
      path.push(current);
      current = replacedBy.get(current);
    }
    for (const key of path) complete.add(key);
  }
};

const orderVisibleEntries = (
  slot: string,
  entries: ReadonlyArray<WorkingEntry>,
  replacedBy: ReadonlyMap<string, string>,
  disabled: ReadonlySet<string>,
  extensionEdges: ReadonlyArray<readonly [string, string]>,
  replacementMemo: Map<string, string>,
): ReadonlyArray<WorkingEntry> => {
  const hidden = new Set([...disabled, ...replacedBy.keys()]);
  const visible = entries.filter((entry) => !hidden.has(entry.key));
  const visibleByKey = new Map(visible.map((entry) => [entry.key, entry]));
  const allByKey = new Map(entries.map((entry) => [entry.key, entry]));
  const sourceTargets = new Map<string, Array<string>>();
  for (const [target, source] of replacedBy) {
    const targets = sourceTargets.get(source) ?? [];
    targets.push(target);
    sourceTargets.set(source, targets);
  }
  const anchorMemo = new Map<string, number>();
  const anchorOf = (key: string): number => {
    const memoized = anchorMemo.get(key);
    if (memoized !== undefined) return memoized;
    const path: Array<string> = [];
    let current: string | undefined = key;
    let anchor = Number.MAX_SAFE_INTEGER;
    while (current !== undefined) {
      const cached = anchorMemo.get(current);
      if (cached !== undefined) {
        anchor = Math.min(anchor, cached);
        break;
      }
      path.push(current);
      anchor = Math.min(anchor, allByKey.get(current)?.originalIndex ?? Number.MAX_SAFE_INTEGER);
      current = sourceTargets.get(current)?.[0];
    }
    for (const pathKey of path) anchorMemo.set(pathKey, anchor);
    return anchor;
  };

  const outgoing = new Map(visible.map((entry) => [entry.key, new Set<string>()]));
  const indegree = new Map(visible.map((entry) => [entry.key, 0]));
  for (const [rawTarget, rawSource] of extensionEdges) {
    const target = effectiveReplacement(rawTarget, replacedBy, replacementMemo);
    const source = effectiveReplacement(rawSource, replacedBy, replacementMemo);
    if (target === source || !visibleByKey.has(target) || !visibleByKey.has(source)) continue;
    const values = outgoing.get(target)!;
    if (!values.has(source)) {
      values.add(source);
      indegree.set(source, (indegree.get(source) ?? 0) + 1);
    }
  }

  const byOrder = (left: string, right: string) =>
    anchorOf(left) - anchorOf(right) || left.localeCompare(right);
  const ready: Array<string> = [];
  const pushReady = (key: string) => {
    ready.push(key);
    for (let index = ready.length - 1; index > 0; ) {
      const parent = Math.floor((index - 1) / 2);
      if (byOrder(ready[parent]!, ready[index]!) <= 0) break;
      [ready[parent], ready[index]] = [ready[index]!, ready[parent]!];
      index = parent;
    }
  };
  const popReady = (): string | undefined => {
    const first = ready[0];
    const last = ready.pop();
    if (first === undefined || last === undefined || ready.length === 0) return first;
    ready[0] = last;
    for (let index = 0; ; ) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= ready.length) break;
      const smallest =
        right < ready.length && byOrder(ready[right]!, ready[left]!) < 0 ? right : left;
      if (byOrder(ready[index]!, ready[smallest]!) <= 0) break;
      [ready[index], ready[smallest]] = [ready[smallest]!, ready[index]!];
      index = smallest;
    }
    return first;
  };
  for (const entry of visible) {
    if (indegree.get(entry.key) === 0) pushReady(entry.key);
  }
  const ordered: Array<WorkingEntry> = [];
  while (ready.length > 0) {
    const key = popReady()!;
    ordered.push(visibleByKey.get(key)!);
    for (const next of outgoing.get(key) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) pushReady(next);
    }
  }
  if (ordered.length !== visible.length) {
    const cycle = visible
      .filter((entry) => (indegree.get(entry.key) ?? 0) > 0)
      .map((entry) => entry.contribution.id)
      .sort();
    throw new PluginCompositionCycleError({ cycle: [...cycle, cycle[0] ?? "unknown"], slot });
  }
  return ordered;
};

export const resolveContributionComposition = (
  plugins: ReadonlyArray<PluginCompositionInput>,
): ResolvedContributionComposition => {
  for (const plugin of plugins) {
    const ruleIds = new Set<string>();
    for (const rule of plugin.composition) {
      if (ruleIds.has(rule.id)) {
        throw new PluginDuplicateCompositionRuleError({
          pluginId: plugin.pluginId,
          ruleId: rule.id,
        });
      }
      ruleIds.add(rule.id);
    }
  }
  const entriesBySlot = new Map<string, Array<WorkingEntry>>();
  const entriesByKey = new Map<string, WorkingEntry>();
  let originalIndex = 0;
  for (const plugin of plugins) {
    for (const registered of plugin.contributions) {
      const key = keyOf(registered.slot, registered.contribution.id);
      const entry: WorkingEntry = {
        key,
        slot: registered.slot,
        owner: Object.freeze({ origin: plugin.origin, pluginId: plugin.pluginId }),
        originalIndex,
        value: registered.value,
        contribution: registered.contribution,
        decoratedBy: [],
      };
      originalIndex += 1;
      entriesByKey.set(key, entry);
      const slotEntries = entriesBySlot.get(registered.slot) ?? [];
      slotEntries.push(entry);
      entriesBySlot.set(registered.slot, slotEntries);
    }
  }

  const rules = plugins
    .flatMap((plugin) =>
      plugin.composition.map((rule) => ({
        pluginId: plugin.pluginId,
        origin: plugin.origin,
        rule,
      })),
    )
    .sort(compareRules);
  const diagnostics: Array<PluginCompositionDiagnostic> = [];
  const validRules: Array<OwnedRule> = [];
  for (const owned of rules) {
    const target = entriesByKey.get(keyOf(owned.rule.slot, owned.rule.targetId));
    if (target === undefined) {
      diagnostics.push(diagnostic(owned, "ignored", "missing-target"));
      continue;
    }
    const allowed =
      target.contribution.composition?.allowed ??
      (target.owner.origin === "core" ? [] : allOperations);
    if (!allowed.includes(owned.rule.operation)) {
      diagnostics.push(diagnostic(owned, "ignored", "forbidden"));
      continue;
    }
    if (owned.rule.operation === "extend" || owned.rule.operation === "replace") {
      const source = entriesByKey.get(keyOf(owned.rule.slot, owned.rule.sourceId));
      if (source === undefined) {
        diagnostics.push(diagnostic(owned, "ignored", "missing-source"));
        continue;
      }
      if (source.owner.pluginId !== owned.pluginId) {
        diagnostics.push(diagnostic(owned, "ignored", "source-not-owned"));
        continue;
      }
    }
    validRules.push(owned);
  }

  const replacementSources = new Map<string, OwnedRule>();
  for (const owned of validRules) {
    if (owned.rule.operation !== "replace") continue;
    const sourceKey = keyOf(owned.rule.slot, owned.rule.sourceId);
    const previous = replacementSources.get(sourceKey);
    if (previous !== undefined && previous.rule.id !== owned.rule.id) {
      throw new PluginCompositionSourceConflictError({
        firstRuleId: previous.rule.id,
        pluginId: owned.pluginId,
        secondRuleId: owned.rule.id,
        slot: owned.rule.slot,
        sourceId: owned.rule.sourceId,
      });
    }
    replacementSources.set(sourceKey, owned);
  }

  for (const owned of validRules) {
    if (owned.rule.operation === "decorate") {
      decorateContribution(
        entriesByKey.get(keyOf(owned.rule.slot, owned.rule.targetId))!,
        owned as OwnedRule & {
          readonly rule: Extract<PluginCompositionRule, { readonly operation: "decorate" }>;
        },
      );
      diagnostics.push(diagnostic(owned, "applied", "applied"));
    }
  }

  const winners = new Map<string, OwnedRule>();
  for (const owned of validRules) {
    if (owned.rule.operation !== "replace" && owned.rule.operation !== "disable") continue;
    const key = keyOf(owned.rule.slot, owned.rule.targetId);
    const previous = winners.get(key);
    if (previous !== undefined) {
      diagnostics.push(diagnostic(previous, "ignored", "higher-precedence-rule"));
    }
    winners.set(key, owned);
  }
  const replacedBy = new Map<string, string>();
  const disabled = new Set<string>();
  for (const owned of rules) {
    if (owned.rule.operation !== "replace") continue;
    const sourceKey = keyOf(owned.rule.slot, owned.rule.sourceId);
    if (entriesByKey.get(sourceKey)?.owner.pluginId === owned.pluginId) disabled.add(sourceKey);
  }
  for (const [targetKey, owned] of winners) {
    diagnostics.push(diagnostic(owned, "applied", "applied"));
    if (owned.rule.operation === "disable") disabled.add(targetKey);
    else if (owned.rule.operation === "replace") {
      const sourceKey = keyOf(owned.rule.slot, owned.rule.sourceId);
      disabled.delete(sourceKey);
      replacedBy.set(targetKey, sourceKey);
    }
  }
  assertNoReplacementCycles(replacedBy, entriesByKey);
  const replacementMemo = new Map<string, string>();

  const extensionEdges: Array<readonly [string, string]> = [];
  for (const owned of validRules) {
    if (owned.rule.operation !== "extend") continue;
    extensionEdges.push([
      keyOf(owned.rule.slot, owned.rule.targetId),
      keyOf(owned.rule.slot, owned.rule.sourceId),
    ]);
    diagnostics.push(diagnostic(owned, "applied", "applied"));
  }

  const resolvedSlots = new Map<string, ReadonlyArray<ResolvedContributionRegistration>>();
  const replacedTargetsByEffectiveSource = new Map<string, Array<string>>();
  for (const [target, source] of replacedBy) {
    const effectiveSource = effectiveReplacement(source, replacedBy, replacementMemo);
    const targetId = entriesByKey.get(target)?.contribution.id;
    if (targetId === undefined) continue;
    const targets = replacedTargetsByEffectiveSource.get(effectiveSource) ?? [];
    targets.push(targetId);
    replacedTargetsByEffectiveSource.set(effectiveSource, targets);
  }
  for (const [slot, entries] of entriesBySlot) {
    const ordered = orderVisibleEntries(
      slot,
      entries,
      replacedBy,
      disabled,
      extensionEdges,
      replacementMemo,
    );
    resolvedSlots.set(
      slot,
      Object.freeze(
        ordered.map((entry) => {
          const replacedTargets = (replacedTargetsByEffectiveSource.get(entry.key) ?? []).sort();
          return Object.freeze({
            contribution: entry.contribution,
            owner: entry.owner,
            decoratedBy: Object.freeze([...entry.decoratedBy]),
            ...(replacedTargets.length === 0 ? {} : { replaces: replacedTargets[0] }),
            value: entry.value,
          });
        }),
      ),
    );
  }

  return Object.freeze({ diagnostics: Object.freeze(diagnostics), slots: resolvedSlots });
};
