import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PluginUiCatalog, PluginUiNotification } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import { useEffect, useRef } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceState } from "../../state/workspace";

const orderByIds = <Item extends { readonly id: string }>(
  ids: ReadonlyArray<string>,
  items: ReadonlyArray<Item>,
): Array<Item> => {
  const order = new Map(ids.map((id, index) => [id, index]));
  return [...items].sort(
    (left, right) =>
      (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right.id) ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id),
  );
};

export function PluginUiMobileNotificationHost() {
  const { environments } = useWorkspaceState();
  return environments.map((environment) => (
    <EnvironmentPluginUiMobileNotificationHost
      key={environment.environmentId}
      environmentId={environment.environmentId}
    />
  ));
}

function EnvironmentPluginUiMobileNotificationHost({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const result = useAtomValue(
    serverEnvironment.pluginUiNotifications({ environmentId, input: {} }),
  );
  const notification = Option.getOrNull(AsyncResult.value(result));
  const shown = useRef<PluginUiNotification | null>(null);

  useEffect(() => {
    if (notification === null) return;
    if (shown.current === notification) return;
    shown.current = notification;
    Alert.alert(notification.title, notification.message);
  }, [notification]);

  return null;
}

export function PluginUiMobileCards({
  environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}) {
  if (environmentId === null) return null;
  return <EnvironmentPluginUiMobileCards environmentId={environmentId} />;
}

function EnvironmentPluginUiMobileCards({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const result = useAtomValue(serverEnvironment.pluginUi({ environmentId, input: {} }));
  const catalog = Option.getOrNull(AsyncResult.value(result)) as PluginUiCatalog | null;
  const invoke = useAtomCommand(serverEnvironment.invokePluginCommand, { reportFailure: false });
  if (catalog === null) return null;

  const cards = orderByIds(
    catalog.order.cards,
    catalog.packages.flatMap((pluginPackage) =>
      pluginPackage.cards
        .filter((card) => card.surfaces.includes("mobile"))
        .map((card) => ({ ...card, pluginPackage })),
    ),
  );
  const statuses = orderByIds(
    catalog.order.statusItems,
    catalog.packages.flatMap((pluginPackage) =>
      pluginPackage.statusItems
        .filter((status) => status.surfaces.includes("mobile"))
        .map((status) => ({ ...status, pluginPackage })),
    ),
  );
  if (cards.length === 0 && statuses.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="gap-3 px-4 py-2"
      accessibilityLabel="Plugin cards"
    >
      {[
        ...cards.map(({ pluginPackage, ...card }) => {
          const action = card.actionId
            ? [...pluginPackage.composerActions, ...pluginPackage.contextualActions].find(
                (candidate) => candidate.id === card.actionId,
              )
            : undefined;
          return (
            <Pressable
              key={`${pluginPackage.pluginId}:${card.id}`}
              disabled={action === undefined}
              className="min-w-44 rounded-2xl border border-border bg-card p-4 active:opacity-70"
              accessibilityRole={action === undefined ? "summary" : "button"}
              accessibilityLabel={card.title}
              onPress={
                action === undefined
                  ? undefined
                  : () => {
                      void invoke({
                        environmentId,
                        input: {
                          generation: catalog.generation,
                          id: action.commandId,
                          context: { cardId: card.id },
                        },
                      }).then((outcome) => {
                        if (outcome._tag === "Success") {
                          Alert.alert(card.title, outcome.value.message);
                        } else {
                          Alert.alert("Plugin action failed");
                        }
                      });
                    }
              }
            >
              <Text className="text-sm font-t3-semibold text-foreground">{card.title}</Text>
              {card.value ? (
                <Text className="mt-1 text-2xl font-t3-bold text-foreground">{card.value}</Text>
              ) : null}
              {card.description ? (
                <Text className="mt-1 text-sm text-muted-foreground">{card.description}</Text>
              ) : null}
            </Pressable>
          );
        }),
        ...statuses.map(({ pluginPackage, ...status }) => (
          <View
            key={`${pluginPackage.pluginId}:${status.id}`}
            className="min-w-36 rounded-2xl border border-border bg-card p-4"
            accessibilityLabel={`${status.label}: ${status.value}`}
          >
            <Text className="text-xs text-muted-foreground">{status.label}</Text>
            <Text className="mt-1 text-base font-t3-semibold text-foreground">{status.value}</Text>
          </View>
        )),
      ]}
    </ScrollView>
  );
}
