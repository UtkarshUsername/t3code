export type PluginJson =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<PluginJson>
  | { readonly [key: string]: PluginJson };

export type PluginSurface = "web" | "desktop" | "mobile";
export type PluginUiTone = "neutral" | "muted" | "info" | "success" | "warning" | "danger";
export type PluginCommandTone = "info" | "success";
export type PluginCapability = `${string}@${number}`;
export type PluginEntrypoint = `./${string}.ts` | `./${string}.js`;
export type PluginPermission =
  | "settings:read-write"
  | "state:read-write"
  | "cache:read-write"
  | "filesystem:data"
  | "notifications:send"
  | `secrets:${string}`
  | `network:https://${string}`
  | `process:${string}`;

export interface PluginCommand {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly surfaces: ReadonlyArray<PluginSurface>;
}

export interface PluginCommandContext {
  readonly threadId?: string;
  readonly projectId?: string;
  readonly viewId?: string;
  readonly cardId?: string;
  readonly filePath?: string;
}

export interface PluginCommandResult {
  readonly message: string;
  readonly tone: PluginCommandTone;
}

export interface PluginEffect<out A> {
  readonly [PluginEffectTypeId]: A;
}

declare const PluginEffectTypeId: unique symbol;

export type PluginEffectInput<A> = A | PromiseLike<A> | PluginEffect<A>;

export interface PluginKeyValueStore {
  get(key: string): PluginEffect<PluginJson | undefined>;
  set(key: string, value: PluginJson): PluginEffect<void>;
  delete(key: string): PluginEffect<void>;
  readonly clear: PluginEffect<void>;
}

export interface PluginHostApi {
  readonly settings: PluginKeyValueStore;
  readonly state: PluginKeyValueStore;
  readonly cache: PluginKeyValueStore;
  readonly secrets: {
    get(name: string): PluginEffect<string | undefined>;
    set(name: string, value: string): PluginEffect<void>;
    delete(name: string): PluginEffect<void>;
  };
  readonly files: {
    readText(path: string): PluginEffect<string>;
    writeText(path: string, contents: string): PluginEffect<void>;
    remove(path: string): PluginEffect<void>;
  };
  readonly network: {
    fetchText(url: string): PluginEffect<{
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string;
    }>;
  };
  readonly process: {
    run(
      command: string,
      args?: ReadonlyArray<string>,
    ): PluginEffect<{
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }>;
  };
  readonly ui: {
    notify(notification: PluginUiNotification): PluginEffect<void>;
  };
}

export interface PluginEffectApi {
  succeed<A>(value: A): PluginEffect<A>;
  map<A, B>(effect: PluginEffectInput<A>, map: (value: A) => B): PluginEffect<B>;
  flatMap<A, B>(
    effect: PluginEffectInput<A>,
    map: (value: A) => PluginEffectInput<B>,
  ): PluginEffect<B>;
}

interface PluginUiBase {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly surfaces: ReadonlyArray<PluginSurface>;
}

export type PluginUiSetting =
  | (PluginUiBase & { readonly kind: "boolean"; readonly defaultValue: boolean })
  | (PluginUiBase & {
      readonly kind: "text";
      readonly defaultValue: string;
      readonly placeholder?: string;
    })
  | (PluginUiBase & {
      readonly kind: "select";
      readonly defaultValue: string;
      readonly options: ReadonlyArray<{ readonly label: string; readonly value: string }>;
    });

export interface PluginUiAction extends PluginUiBase {
  readonly commandId: string;
}

export interface PluginUiContextualAction extends PluginUiAction {
  readonly contexts: ReadonlyArray<"thread" | "project" | "file" | "diff">;
}

export interface PluginUiCard {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly value?: string;
  readonly tone?: PluginUiTone;
  readonly actionId?: string;
  readonly surfaces: ReadonlyArray<PluginSurface>;
}

export interface PluginUiStatusItem {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly tone?: PluginUiTone;
  readonly surfaces: ReadonlyArray<PluginSurface>;
}

export type PluginUiBlock =
  | { readonly kind: "text"; readonly text: string; readonly tone?: PluginUiTone }
  | {
      readonly kind: "action";
      readonly id: string;
      readonly label: string;
      readonly description?: string;
      readonly commandId: string;
    }
  | {
      readonly kind: "card";
      readonly id: string;
      readonly title: string;
      readonly description?: string;
      readonly value?: string;
      readonly tone?: PluginUiTone;
      readonly commandId?: string;
    }
  | {
      readonly kind: "status";
      readonly id: string;
      readonly label: string;
      readonly value: string;
      readonly tone?: PluginUiTone;
    };

export interface PluginUiView extends PluginUiBase {
  readonly blocks: ReadonlyArray<PluginUiBlock>;
}

export interface PluginUiNavigationItem {
  readonly id: string;
  readonly label: string;
  readonly viewId: string;
  readonly surfaces: ReadonlyArray<PluginSurface>;
}

export interface PluginUiContribution {
  readonly settings: ReadonlyArray<PluginUiSetting>;
  readonly navigation: ReadonlyArray<PluginUiNavigationItem>;
  readonly views: ReadonlyArray<PluginUiView>;
  readonly cards: ReadonlyArray<PluginUiCard>;
  readonly statusItems: ReadonlyArray<PluginUiStatusItem>;
  readonly composerActions: ReadonlyArray<PluginUiAction>;
  readonly contextualActions: ReadonlyArray<PluginUiContextualAction>;
}

export interface PluginUiNotification {
  readonly id: string;
  readonly title: string;
  readonly message: string;
  readonly tone: "info" | "success" | "warning" | "danger";
}

export interface PluginApi {
  readonly host: PluginHostApi;
  readonly effect: PluginEffectApi;
  onDispose(cleanup: () => PluginEffectInput<void>): void;
  registerCommand(
    command: PluginCommand,
    handler: (context?: PluginCommandContext) => PluginEffectInput<PluginCommandResult>,
  ): void;
  registerUi(contribution: PluginUiContribution): void;
}

export type PluginActivate = (api: PluginApi) => PluginEffectInput<void>;

export type PluginCompositionSlot =
  | "commands"
  | "settings"
  | "navigation"
  | "views"
  | "cards"
  | "statusItems"
  | "composerActions"
  | "contextualActions";

export type PluginCompositionRule =
  | {
      readonly id: string;
      readonly operation: "extend" | "replace";
      readonly slot: PluginCompositionSlot;
      readonly sourceId: string;
      readonly targetId: string;
    }
  | {
      readonly id: string;
      readonly operation: "decorate";
      readonly slot: PluginCompositionSlot;
      readonly targetId: string;
      readonly patch: {
        readonly label?: string;
        readonly data?: Readonly<Record<string, PluginJson>>;
      };
    }
  | {
      readonly id: string;
      readonly operation: "disable";
      readonly slot: PluginCompositionSlot;
      readonly targetId: string;
    };

export interface PluginManifest {
  readonly manifestVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly forkOf?: string;
  readonly apiVersion: 1;
  readonly surfaces?: ReadonlyArray<PluginSurface>;
  readonly entrypoints: {
    readonly server?: PluginEntrypoint;
    readonly web?: PluginEntrypoint;
    readonly desktop?: PluginEntrypoint;
  };
  readonly capabilities: ReadonlyArray<PluginCapability>;
  readonly requires?: ReadonlyArray<PluginCapability>;
  readonly optional?: ReadonlyArray<PluginCapability>;
  readonly provides?: ReadonlyArray<PluginCapability>;
  readonly permissions?: ReadonlyArray<PluginPermission>;
  readonly contributes: Readonly<
    Partial<
      Record<
        | "commands"
        | "settings"
        | "navigation"
        | "views"
        | "cards"
        | "statusItems"
        | "composerActions"
        | "contextualActions"
        | "mobileCards",
        ReadonlyArray<string>
      >
    >
  >;
  readonly composition?: ReadonlyArray<PluginCompositionRule>;
}
