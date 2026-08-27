import { describe, expect, it } from "vite-plus/test";

import {
  PluginCompositionCycleError,
  PluginCompositionSourceConflictError,
  PluginDuplicateCompositionRuleError,
  resolveContributionComposition,
} from "../src/composition.ts";
import type { PluginCompositionInput } from "../src/composition.ts";
import type { ContributionData } from "../src/contract.ts";

const plugin = (
  pluginId: string,
  origin: PluginCompositionInput["origin"],
  contributions: PluginCompositionInput["contributions"],
  composition: PluginCompositionInput["composition"] = [],
): PluginCompositionInput => ({ pluginId, origin, contributions, composition });

const contribution = (
  slot: string,
  id: string,
  label: string,
  data: Readonly<Record<string, ContributionData>> = {},
  allowed: ReadonlyArray<"extend" | "decorate" | "replace" | "disable"> = [
    "extend",
    "decorate",
    "replace",
    "disable",
  ],
) => ({
  slot,
  contribution: { id, label, data, composition: { allowed } },
  value: `${id}:handler`,
});

describe("contribution composition", () => {
  it("resolves replacement conflicts by origin and reports every decision", () => {
    const core = plugin("t3.core", "core", [contribution("commands", "t3.status", "Core status")]);
    const installed = plugin(
      "acme.status",
      "installed",
      [contribution("commands", "acme.status", "Installed status")],
      [
        {
          id: "acme.status.replace",
          operation: "replace",
          slot: "commands",
          sourceId: "acme.status",
          targetId: "t3.status",
        },
      ],
    );
    const fork = plugin(
      "local.status",
      "local-fork",
      [contribution("commands", "local.status", "Fork status")],
      [
        {
          id: "local.status.replace",
          operation: "replace",
          slot: "commands",
          sourceId: "local.status",
          targetId: "t3.status",
        },
      ],
    );

    const result = resolveContributionComposition([fork, core, installed]);

    expect(result.slots.get("commands")?.map((entry) => entry.contribution.id)).toEqual([
      "local.status",
    ]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: "ignored",
          pluginId: "acme.status",
          reason: "higher-precedence-rule",
        }),
        expect.objectContaining({ outcome: "applied", pluginId: "local.status" }),
      ]),
    );
    expect(result.slots.get("commands")?.[0]?.owner).toEqual({
      origin: "local-fork",
      pluginId: "local.status",
    });
  });

  it("extends after the effective replacement target", () => {
    const result = resolveContributionComposition([
      plugin("t3.core", "core", [contribution("cards", "t3.card", "Core")]),
      plugin(
        "acme.replacement",
        "installed",
        [contribution("cards", "acme.card", "Replacement")],
        [
          {
            id: "acme.card.replace",
            operation: "replace",
            slot: "cards",
            sourceId: "acme.card",
            targetId: "t3.card",
          },
        ],
      ),
      plugin(
        "acme.extension",
        "installed",
        [contribution("cards", "acme.extra", "Extension")],
        [
          {
            id: "acme.extra.extend",
            operation: "extend",
            slot: "cards",
            sourceId: "acme.extra",
            targetId: "t3.card",
          },
        ],
      ),
    ]);

    expect(result.slots.get("cards")?.map((entry) => entry.contribution.id)).toEqual([
      "acme.card",
      "acme.extra",
    ]);
  });

  it("decorates detached metadata while retaining the target handler", () => {
    const result = resolveContributionComposition([
      plugin("t3.core", "core", [
        contribution("commands", "t3.status", "Core status", {
          description: "Core description",
          surfaces: ["web"],
        }),
      ]),
      plugin(
        "acme.decorator",
        "installed",
        [],
        [
          {
            id: "acme.status.decorate",
            operation: "decorate",
            slot: "commands",
            targetId: "t3.status",
            patch: {
              label: "Custom status",
              data: { description: "Custom description" },
            },
          },
        ],
      ),
    ]);

    const entry = result.slots.get("commands")?.[0];
    expect(entry?.contribution).toMatchObject({
      id: "t3.status",
      label: "Custom status",
      data: { description: "Custom description", surfaces: ["web"] },
    });
    expect(entry?.value).toBe("t3.status:handler");
    expect(entry?.decoratedBy).toEqual(["acme.decorator"]);
  });

  it("protects core contributions by default", () => {
    const result = resolveContributionComposition([
      plugin("t3.core", "core", [
        {
          slot: "commands",
          contribution: { id: "t3.secure", label: "Secure" },
          value: "secure-handler",
        },
      ]),
      plugin(
        "acme.override",
        "local-fork",
        [contribution("commands", "acme.secure", "Override")],
        [
          {
            id: "acme.secure.replace",
            operation: "replace",
            slot: "commands",
            sourceId: "acme.secure",
            targetId: "t3.secure",
          },
        ],
      ),
    ]);

    expect(result.slots.get("commands")?.map((entry) => entry.contribution.id)).toEqual([
      "t3.secure",
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ outcome: "ignored", reason: "forbidden" }),
    ]);
  });

  it("honors target policy and keeps forbidden or missing rules diagnostic-only", () => {
    const result = resolveContributionComposition([
      plugin("t3.core", "core", [
        contribution("commands", "t3.protected", "Protected", {}, ["extend"]),
      ]),
      plugin(
        "acme.modifier",
        "installed",
        [contribution("commands", "acme.replacement", "Replacement")],
        [
          {
            id: "acme.protected.disable",
            operation: "disable",
            slot: "commands",
            targetId: "t3.protected",
          },
          {
            id: "acme.missing.disable",
            operation: "disable",
            slot: "commands",
            targetId: "t3.missing",
          },
        ],
      ),
    ]);

    expect(result.slots.get("commands")?.map((entry) => entry.contribution.id)).toEqual([
      "t3.protected",
      "acme.replacement",
    ]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: "ignored", reason: "forbidden" }),
        expect.objectContaining({ outcome: "ignored", reason: "missing-target" }),
      ]),
    );
  });

  it("resolves a deep replacement chain without using the call stack", () => {
    const count = 10_000;
    const contributions = Array.from({ length: count }, (_, index) =>
      contribution("cards", `acme.card-${index}`, `Card ${index}`),
    );
    const composition = Array.from({ length: count - 1 }, (_, index) => ({
      id: `acme.replace-${index}`,
      operation: "replace" as const,
      slot: "cards",
      sourceId: `acme.card-${index + 1}`,
      targetId: `acme.card-${index}`,
    }));

    const result = resolveContributionComposition([
      plugin("acme.deep-replacements", "installed", contributions, composition),
    ]);

    expect(result.slots.get("cards")?.map((entry) => entry.contribution.id)).toEqual([
      `acme.card-${count - 1}`,
    ]);
  });

  it("rejects duplicate rule ids from one plugin", () => {
    expect(() =>
      resolveContributionComposition([
        plugin(
          "acme.duplicates",
          "installed",
          [contribution("cards", "acme.card", "Card")],
          [
            {
              id: "acme.same-rule",
              operation: "disable",
              slot: "cards",
              targetId: "acme.card",
            },
            {
              id: "acme.same-rule",
              operation: "decorate",
              slot: "cards",
              targetId: "acme.card",
              patch: { label: "Changed" },
            },
          ],
        ),
      ]),
    ).toThrow(PluginDuplicateCompositionRuleError);
  });

  it("rejects one replacement source assigned to multiple targets", () => {
    expect(() =>
      resolveContributionComposition([
        plugin(
          "acme.source-conflict",
          "installed",
          [
            contribution("cards", "acme.one", "One"),
            contribution("cards", "acme.two", "Two"),
            contribution("cards", "acme.replacement", "Replacement"),
          ],
          [
            {
              id: "acme.replace-one",
              operation: "replace",
              slot: "cards",
              sourceId: "acme.replacement",
              targetId: "acme.one",
            },
            {
              id: "acme.replace-two",
              operation: "replace",
              slot: "cards",
              sourceId: "acme.replacement",
              targetId: "acme.two",
            },
          ],
        ),
      ]),
    ).toThrow(PluginCompositionSourceConflictError);
  });

  it("rejects replacement cycles before publishing a candidate", () => {
    expect(() =>
      resolveContributionComposition([
        plugin(
          "acme.replacement-cycle",
          "installed",
          [contribution("cards", "acme.one", "One"), contribution("cards", "acme.two", "Two")],
          [
            {
              id: "acme.one.replace",
              operation: "replace",
              slot: "cards",
              sourceId: "acme.one",
              targetId: "acme.two",
            },
            {
              id: "acme.two.replace",
              operation: "replace",
              slot: "cards",
              sourceId: "acme.two",
              targetId: "acme.one",
            },
          ],
        ),
      ]),
    ).toThrow(PluginCompositionCycleError);
  });

  it("rejects extension cycles before publishing a candidate", () => {
    expect(() =>
      resolveContributionComposition([
        plugin(
          "acme.cycle",
          "installed",
          [contribution("cards", "acme.one", "One"), contribution("cards", "acme.two", "Two")],
          [
            {
              id: "acme.one.extend",
              operation: "extend",
              slot: "cards",
              sourceId: "acme.one",
              targetId: "acme.two",
            },
            {
              id: "acme.two.extend",
              operation: "extend",
              slot: "cards",
              sourceId: "acme.two",
              targetId: "acme.one",
            },
          ],
        ),
      ]),
    ).toThrow(PluginCompositionCycleError);
  });
});
