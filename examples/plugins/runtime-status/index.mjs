export default function activate(api) {
  api.registerUi({
    settings: [
      {
        id: "com.t3code.runtime-status-example.celebrations",
        kind: "boolean",
        label: "Celebrate successful checks",
        description: "Show a host-rendered notification when the runtime check succeeds.",
        defaultValue: true,
        surfaces: ["web", "desktop", "mobile"],
      },
    ],
    navigation: [
      {
        id: "com.t3code.runtime-status-example.navigation",
        label: "Plugin status",
        viewId: "com.t3code.runtime-status-example.dashboard",
        surfaces: ["web", "desktop"],
      },
    ],
    views: [
      {
        id: "com.t3code.runtime-status-example.dashboard",
        label: "Plugin status",
        description: "A declarative page rendered entirely by T3 Code.",
        surfaces: ["web", "desktop"],
        blocks: [
          {
            kind: "text",
            text: "The example plugin is active in its supervised worker.",
            tone: "muted",
          },
          {
            kind: "action",
            id: "com.t3code.runtime-status-example.check",
            label: "Check runtime",
            commandId: "example.runtime-status",
          },
        ],
      },
    ],
    cards: [
      {
        id: "com.t3code.runtime-status-example.card",
        title: "Plugin worker",
        description: "The external example package is active.",
        value: "Ready",
        tone: "success",
        actionId: "com.t3code.runtime-status-example.composer",
        surfaces: ["web", "desktop", "mobile"],
      },
    ],
    statusItems: [
      {
        id: "com.t3code.runtime-status-example.status",
        label: "Plugin runtime",
        value: "Ready",
        tone: "success",
        surfaces: ["web", "desktop", "mobile"],
      },
    ],
    composerActions: [
      {
        id: "com.t3code.runtime-status-example.composer",
        label: "Check plugin runtime",
        commandId: "example.runtime-status",
        surfaces: ["web", "desktop", "mobile"],
      },
    ],
    contextualActions: [
      {
        id: "com.t3code.runtime-status-example.context",
        label: "Check runtime for this thread",
        commandId: "example.runtime-status",
        contexts: ["thread"],
        surfaces: ["web", "desktop", "mobile"],
      },
    ],
  });

  api.registerCommand(
    {
      id: "example.runtime-status",
      label: "external runtime status",
      description: "report status from an external local plugin package.",
      surfaces: ["web", "desktop", "mobile"],
    },
    (context) =>
      api.effect.flatMap(
        api.host.settings.get("com.t3code.runtime-status-example.celebrations"),
        (enabled) => {
          const message = context?.threadId
            ? `external plugin runtime is active for thread ${context.threadId}.`
            : "external plugin runtime is active.";
          const result = { message, tone: "success" };
          if (enabled === false) return api.effect.succeed(result);
          return api.effect.flatMap(
            api.host.ui.notify({
              id: "runtime-ready",
              title: "Plugin runtime ready",
              message,
              tone: "success",
            }),
            () => api.effect.succeed(result),
          );
        },
      ),
  );
}
