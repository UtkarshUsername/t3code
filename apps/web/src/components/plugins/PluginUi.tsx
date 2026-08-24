import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  PluginCommandInvocationContext,
  PluginUiAction,
  PluginUiBlock,
  PluginUiCatalog,
  PluginUiNotification,
  PluginUiPackageContribution,
  PluginUiSetting,
  PluginUiView,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { PuzzleIcon, SparklesIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useLocation } from "@tanstack/react-router";

import { isElectron } from "../../env";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarUtilityItem } from "../sidebar/SidebarUtilityItem";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";

const EMPTY_PLUGIN_UI_CATALOG: PluginUiCatalog = Object.freeze({
  generation: 0,
  packages: Object.freeze([]),
});
const EMPTY_PLUGIN_UI_ATOM = Atom.make(AsyncResult.success(EMPTY_PLUGIN_UI_CATALOG));
const EMPTY_PLUGIN_NOTIFICATION: PluginUiNotification = {
  id: "empty",
  pluginId: "t3.empty",
  title: "Empty",
  message: "Empty",
  tone: "info",
};
const EMPTY_PLUGIN_NOTIFICATION_ATOM = Atom.make(AsyncResult.success(EMPTY_PLUGIN_NOTIFICATION));

const surface = (): "web" | "desktop" => (isElectron ? "desktop" : "web");

const toneClass = {
  neutral: "border-border bg-card text-card-foreground",
  muted: "border-border/60 bg-muted/35 text-muted-foreground",
  info: "border-info/30 bg-info/10 text-info-foreground",
  success: "border-success/30 bg-success/10 text-success-foreground",
  warning: "border-warning/30 bg-warning/10 text-warning-foreground",
  danger: "border-destructive/30 bg-destructive/10 text-destructive-foreground",
} as const;

export function usePluginUiCatalog(environmentId: EnvironmentId | null): PluginUiCatalog {
  const result = useAtomValue(
    environmentId === null
      ? EMPTY_PLUGIN_UI_ATOM
      : serverEnvironment.pluginUi({ environmentId, input: {} }),
  );
  return Option.getOrElse(AsyncResult.value(result), () => EMPTY_PLUGIN_UI_CATALOG);
}

function usePluginAction(environmentId: EnvironmentId | null, catalog: PluginUiCatalog) {
  const invoke = useAtomCommand(serverEnvironment.invokePluginCommand, { reportFailure: false });
  return useCallback(
    async (commandId: string, label: string, context?: PluginCommandInvocationContext) => {
      if (environmentId === null) return;
      const result = await invoke({
        environmentId,
        input: {
          generation: catalog.generation,
          id: commandId,
          ...(context === undefined ? {} : { context }),
        },
      });
      if (result._tag === "Success") {
        toastManager.add(
          stackedThreadToast({
            type: result.value.tone,
            title: label,
            description: result.value.message,
          }),
        );
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Plugin action failed",
          description: failure instanceof Error ? failure.message : String(failure),
        });
      }
    },
    [catalog.generation, environmentId, invoke],
  );
}

export function PluginUiNotificationHost() {
  const environmentId = usePrimaryEnvironmentId();
  const result = useAtomValue(
    environmentId === null
      ? EMPTY_PLUGIN_NOTIFICATION_ATOM
      : serverEnvironment.pluginUiNotifications({ environmentId, input: {} }),
  );
  const notification = environmentId === null ? null : Option.getOrNull(AsyncResult.value(result));
  const shown = useRef<PluginUiNotification | null>(null);

  useEffect(() => {
    if (notification === null) return;
    if (shown.current === notification) return;
    shown.current = notification;
    toastManager.add({
      type: notification.tone,
      title: notification.title,
      description: notification.message,
    });
  }, [notification]);

  return null;
}

export function PluginUiNavigationItems({ closeMobile }: { readonly closeMobile: () => void }) {
  const environmentId = usePrimaryEnvironmentId();
  const catalog = usePluginUiCatalog(environmentId);
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const currentSurface = surface();
  const items = catalog.packages.flatMap((pluginPackage) =>
    pluginPackage.navigation
      .filter((item) => item.surfaces.includes(currentSurface))
      .map((item) => ({ item, pluginId: pluginPackage.pluginId })),
  );

  return items.map(({ item, pluginId }) => (
    <SidebarUtilityItem
      key={`${pluginId}:${item.id}`}
      icon={<PuzzleIcon />}
      label={item.label}
      isActive={pathname === `/plugins/${pluginId}/${item.viewId}`}
      onClick={() => {
        closeMobile();
        void navigate({
          to: "/plugins/$pluginId/$viewId",
          params: { pluginId, viewId: item.viewId },
        });
      }}
    />
  ));
}

function ActionButton({
  action,
  onAction,
}: {
  readonly action: Pick<PluginUiAction, "commandId" | "label">;
  readonly onAction: (commandId: string, label: string) => void;
}) {
  return (
    <Button size="sm" variant="outline" onClick={() => onAction(action.commandId, action.label)}>
      <SparklesIcon className="size-3.5" />
      {action.label}
    </Button>
  );
}

function PluginCard({
  title,
  value,
  description,
  tone,
  action,
  onAction,
}: {
  readonly title: string;
  readonly value?: string;
  readonly description?: string;
  readonly tone?: "neutral" | "muted" | "info" | "success" | "warning" | "danger";
  readonly action?: Pick<PluginUiAction, "commandId" | "label">;
  readonly onAction: (commandId: string, label: string) => void;
}) {
  return (
    <div className={`rounded-lg border p-4 ${toneClass[tone ?? "neutral"]}`}>
      <div className="text-sm font-medium">{title}</div>
      {value ? <div className="mt-1 text-2xl font-semibold">{value}</div> : null}
      {description ? <p className="mt-1 text-sm opacity-80">{description}</p> : null}
      {action ? (
        <div className="mt-3">
          <ActionButton action={action} onAction={onAction} />
        </div>
      ) : null}
    </div>
  );
}

function StatusBadge({
  label,
  value,
  tone,
  valueOnly = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: "neutral" | "muted" | "info" | "success" | "warning" | "danger";
  readonly valueOnly?: boolean;
}) {
  const text = `${label}: ${value}`;
  const visibleText = valueOnly ? value : text;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            variant={tone === "success" ? "success" : tone === "warning" ? "warning" : "outline"}
            className="min-w-0 max-w-full"
          >
            <span className="truncate">{visibleText}</span>
          </Badge>
        }
      />
      <TooltipPopup side="top" className="max-w-80">
        {text}
      </TooltipPopup>
    </Tooltip>
  );
}

function RenderBlock({
  block,
  onAction,
}: {
  readonly block: PluginUiBlock;
  readonly onAction: (commandId: string, label: string) => void;
}) {
  switch (block.kind) {
    case "text":
      return (
        <p className={block.tone === "muted" ? "text-sm text-muted-foreground" : "text-sm"}>
          {block.text}
        </p>
      );
    case "action":
      return <ActionButton action={block} onAction={onAction} />;
    case "card":
      return (
        <PluginCard
          title={block.title}
          onAction={onAction}
          {...(block.value === undefined ? {} : { value: block.value })}
          {...(block.description === undefined ? {} : { description: block.description })}
          {...(block.tone === undefined ? {} : { tone: block.tone })}
          {...(block.commandId === undefined
            ? {}
            : { action: { commandId: block.commandId, label: block.title } })}
        />
      );
    case "status":
      return (
        <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2">
          <span className="min-w-0 truncate text-sm text-muted-foreground">{block.label}</span>
          <StatusBadge
            label={block.label}
            value={block.value}
            valueOnly
            {...(block.tone === undefined ? {} : { tone: block.tone })}
          />
        </div>
      );
  }
}

export function PluginUiViewContent({
  pluginPackage,
  view,
  onAction,
}: {
  readonly pluginPackage: PluginUiPackageContribution;
  readonly view: PluginUiView;
  readonly onAction: (commandId: string, label: string) => void;
}) {
  const currentSurface = surface();
  const cards = pluginPackage.cards.filter((card) => card.surfaces.includes(currentSurface));
  const statuses = pluginPackage.statusItems.filter((item) =>
    item.surfaces.includes(currentSurface),
  );
  const actions = new Map(
    [...pluginPackage.composerActions, ...pluginPackage.contextualActions].map((action) => [
      action.id,
      action,
    ]),
  );

  return (
    <div className="space-y-6" data-plugin-ui-view={view.id}>
      {view.description ? (
        <p className="text-sm text-muted-foreground">{view.description}</p>
      ) : null}
      {statuses.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {statuses.map((item) => (
            <StatusBadge
              key={item.id}
              label={item.label}
              value={item.value}
              {...(item.tone === undefined ? {} : { tone: item.tone })}
            />
          ))}
        </div>
      ) : null}
      {cards.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {cards.map((card) => (
            <PluginCard
              key={card.id}
              title={card.title}
              onAction={onAction}
              {...(card.value === undefined ? {} : { value: card.value })}
              {...(card.description === undefined ? {} : { description: card.description })}
              {...(card.tone === undefined ? {} : { tone: card.tone })}
              {...(card.actionId === undefined || actions.get(card.actionId) === undefined
                ? {}
                : { action: actions.get(card.actionId)! })}
            />
          ))}
        </div>
      ) : null}
      <div className="space-y-3">
        {view.blocks.map((block, index) => (
          <RenderBlock
            key={`${block.kind}:${"id" in block ? block.id : index}`}
            block={block}
            onAction={onAction}
          />
        ))}
      </div>
    </div>
  );
}

function PluginUiSettingControl({
  environmentId,
  pluginId,
  setting,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly pluginId: string;
  readonly setting: PluginUiSetting;
  readonly readOnly: boolean;
}) {
  const read = useAtomCommand(serverEnvironment.readPluginUiSetting, { reportFailure: false });
  const write = useAtomCommand(serverEnvironment.writePluginUiSetting, { reportFailure: false });
  const [value, setValue] = useState<boolean | string>(setting.defaultValue);
  const [committedValue, setCommittedValue] = useState<boolean | string>(setting.defaultValue);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const readVersion = useRef(0);

  useEffect(() => {
    const version = ++readVersion.current;
    let cancelled = false;
    setValue(setting.defaultValue);
    setCommittedValue(setting.defaultValue);
    setLoading(true);
    void read({ environmentId, input: { pluginId, settingId: setting.id } }).then((result) => {
      if (cancelled || version !== readVersion.current) return;
      setLoading(false);
      if (result._tag !== "Success" || result.value.value === undefined) return;
      if (typeof result.value.value === "boolean" || typeof result.value.value === "string") {
        setValue(result.value.value);
        setCommittedValue(result.value.value);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, pluginId, read, setting.defaultValue, setting.id]);

  const update = async (next: boolean | string) => {
    if (readOnly || loading || busy) return;
    const previous = committedValue;
    setValue(next);
    setBusy(true);
    const result = await write({
      environmentId,
      input: { pluginId, settingId: setting.id, value: next },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setCommittedValue(next);
      return;
    }
    setValue(previous);
    if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Plugin setting failed",
        description: failure instanceof Error ? failure.message : String(failure),
      });
    }
  };

  const control =
    setting.kind === "boolean" ? (
      <Switch
        checked={value === true}
        disabled={readOnly || busy || loading}
        onCheckedChange={(checked) => void update(checked)}
      />
    ) : setting.kind === "select" ? (
      <Select
        value={String(value)}
        disabled={readOnly || busy || loading}
        onValueChange={(next) => {
          if (next !== null) void update(next);
        }}
      >
        <SelectTrigger size="compact" className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {setting.options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : (
      <Input
        size="sm"
        className="w-56"
        value={String(value)}
        placeholder={setting.placeholder}
        disabled={readOnly || busy || loading}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => {
          if (!readOnly && !loading && !busy) void update(String(value));
        }}
      />
    );

  return <SettingsRow title={setting.label} description={setting.description} control={control} />;
}

export function PluginUiSettingsSections({ readOnly }: { readonly readOnly: boolean }) {
  const environmentId = usePrimaryEnvironmentId();
  const catalog = usePluginUiCatalog(environmentId);
  const currentSurface = surface();
  if (environmentId === null) return null;

  return catalog.packages.map((pluginPackage) => {
    const settings = pluginPackage.settings.filter((setting) =>
      setting.surfaces.includes(currentSurface),
    );
    if (settings.length === 0) return null;
    return (
      <SettingsSection key={pluginPackage.pluginId} title={`${pluginPackage.pluginId} settings`}>
        {settings.map((setting) => (
          <PluginUiSettingControl
            key={`${environmentId}:${pluginPackage.pluginId}:${setting.id}:${String(setting.defaultValue)}`}
            environmentId={environmentId}
            pluginId={pluginPackage.pluginId}
            setting={setting}
            readOnly={readOnly}
          />
        ))}
      </SettingsSection>
    );
  });
}

export function PluginComposerContributions({
  environmentId,
  context,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly context: PluginCommandInvocationContext;
}) {
  const catalog = usePluginUiCatalog(environmentId);
  const invoke = usePluginAction(environmentId, catalog);
  const currentSurface = surface();
  const composer = catalog.packages.flatMap((pluginPackage) =>
    pluginPackage.composerActions.filter((action) => action.surfaces.includes(currentSurface)),
  );
  const contextual = catalog.packages.flatMap((pluginPackage) =>
    pluginPackage.contextualActions.filter(
      (action) =>
        action.surfaces.includes(currentSurface) &&
        action.contexts.some(
          (kind) =>
            (kind === "thread" && context.threadId !== undefined) ||
            (kind === "project" && context.projectId !== undefined) ||
            ((kind === "file" || kind === "diff") && context.filePath !== undefined),
        ),
    ),
  );
  const statuses = catalog.packages.flatMap((pluginPackage) =>
    pluginPackage.statusItems.filter((item) => item.surfaces.includes(currentSurface)),
  );
  if (composer.length === 0 && contextual.length === 0 && statuses.length === 0) return null;

  return (
    <div
      className="chat-composer-drawer-surface chat-composer-drawer-attached chat-composer-drawer-slot flex flex-wrap gap-1.5 px-3 pt-2 pb-[calc(var(--chat-composer-attachment-overlap)_+_0.375rem)]"
      data-plugin-composer-actions="true"
    >
      {statuses.map((item) => (
        <StatusBadge
          key={item.id}
          label={item.label}
          value={item.value}
          {...(item.tone === undefined ? {} : { tone: item.tone })}
        />
      ))}
      {[...composer, ...contextual].map((action) => (
        <Button
          key={action.id}
          size="xs"
          variant="ghost-muted"
          onClick={() => void invoke(action.commandId, action.label, context)}
        >
          <SparklesIcon className="size-3" />
          {action.label}
        </Button>
      ))}
    </div>
  );
}

export function PluginUiPage({
  pluginId,
  viewId,
}: {
  readonly pluginId: string;
  readonly viewId: string;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const catalog = usePluginUiCatalog(environmentId);
  const invoke = usePluginAction(environmentId, catalog);
  const pluginPackage = useMemo(
    () => catalog.packages.find((candidate) => candidate.pluginId === pluginId),
    [catalog.packages, pluginId],
  );
  const currentSurface = surface();
  const view = pluginPackage?.views.find(
    (candidate) => candidate.id === viewId && candidate.surfaces.includes(currentSurface),
  );

  if (pluginPackage === undefined || view === undefined) {
    return <div className="p-6 text-sm text-muted-foreground">Plugin page is unavailable.</div>;
  }
  return (
    <PluginUiViewContent
      pluginPackage={pluginPackage}
      view={view}
      onAction={(commandId, label) => void invoke(commandId, label, { viewId })}
    />
  );
}
