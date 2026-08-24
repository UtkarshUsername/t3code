import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const MAX_PROTOCOL_LINE_BYTES = 1_000_000;
const entrypointPath = process.argv[2];
const pluginId = process.argv[3];
const protocolWrite = process.stdout.write.bind(process.stdout);
let sequence = 0;
let disposing = false;

const detailFrom = (error) => {
  const detail = error instanceof Error ? error.message : String(error);
  return (detail.trim() || "unknown error").slice(0, 2_000);
};

const detachJson = (value, ancestors = new Set()) => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("command result contains a non-finite number");
    return value;
  }
  if (typeof value !== "object") throw new Error("command result is not JSON-compatible");
  if (ancestors.has(value)) throw new Error("command result contains a cycle");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => detachJson(item, ancestors));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("command result contains a non-plain object");
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, detachJson(item, ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
};

const write = (message) => {
  const line = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
    throw new Error("plugin worker protocol message exceeds limit");
  }
  protocolWrite(line);
};

const writeInvocationResult = (requestId, value) => {
  try {
    write({ type: "invocationResult", requestId, value: detachJson(value) });
  } catch (error) {
    write({ type: "invocationFailed", requestId, detail: detailFrom(error) });
  }
};

const writeDiagnostic = (...values) => {
  const detail = values
    .map((value) => (typeof value === "string" ? value : NodeUtil.inspect(value)))
    .join(" ");
  process.stderr.write(`${detail.slice(0, 4_000)}\n`);
};
for (const method of ["log", "info", "warn", "error", "debug"]) {
  console[method] = writeDiagnostic;
}

const REMOTE_EFFECT = Symbol("plugin-remote-effect");
const remoteEffect = (run) => ({ [REMOTE_EFFECT]: true, run });
const isRemoteEffect = (value) =>
  typeof value === "object" && value !== null && value[REMOTE_EFFECT] === true;

const pendingHostCalls = new Map();
const invocations = new Map();
const commands = new Map();
const finalizers = [];
const emptyUi = () => ({
  settings: [],
  navigation: [],
  views: [],
  cards: [],
  statusItems: [],
  composerActions: [],
  contextualActions: [],
});
let uiContribution = emptyUi();
let uiRegistered = false;

const runValue = async (value, signal) => {
  if (isRemoteEffect(value)) return await value.run(signal);
  return await value;
};

const hostCall = (operation, fields) =>
  remoteEffect(
    (signal) =>
      new Promise((resolve, reject) => {
        const callId = `call-${++sequence}`;
        const onAbort = () => {
          pendingHostCalls.delete(callId);
          reject(new Error("plugin invocation cancelled"));
        };
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
        pendingHostCalls.set(callId, {
          resolve: (value) => {
            signal.removeEventListener("abort", onAbort);
            resolve(value);
          },
          reject: (error) => {
            signal.removeEventListener("abort", onAbort);
            reject(error);
          },
        });
        write({ type: "hostCall", callId, operation, ...fields });
      }),
  );

const store = (name) => ({
  get: (key) => hostCall(`${name}.get`, { key }),
  set: (key, value) => hostCall(`${name}.set`, { key, value }),
  delete: (key) => hostCall(`${name}.delete`, { key }),
  clear: hostCall(`${name}.clear`, {}),
});

const api = {
  host: {
    settings: store("settings"),
    state: store("state"),
    cache: store("cache"),
    secrets: {
      get: (name) => hostCall("secrets.get", { name }),
      set: (name, value) => hostCall("secrets.set", { name, value }),
      delete: (name) => hostCall("secrets.delete", { name }),
    },
    files: {
      readText: (path) => hostCall("files.readText", { path }),
      writeText: (path, contents) => hostCall("files.writeText", { path, contents }),
      remove: (path) => hostCall("files.remove", { path }),
    },
    network: {
      fetchText: (url) => hostCall("network.fetchText", { url }),
    },
    process: {
      run: (command, args = []) => hostCall("process.run", { command, args }),
    },
    ui: {
      notify: (notification) => hostCall("ui.notify", { notification }),
    },
  },
  effect: {
    succeed: (value) => remoteEffect(async () => value),
    map: (effect, f) => remoteEffect(async (signal) => f(await runValue(effect, signal))),
    flatMap: (effect, f) =>
      remoteEffect(async (signal) => runValue(f(await runValue(effect, signal)), signal)),
  },
  onDispose: (cleanup) => {
    if (typeof cleanup !== "function") throw new Error("dispose callback must be a function");
    finalizers.push(cleanup);
  },
  registerCommand: (command, handler) => {
    if (typeof command?.id !== "string" || typeof handler !== "function") {
      throw new Error("invalid command registration");
    }
    if (commands.has(command.id)) throw new Error(`duplicate command ${command.id}`);
    commands.set(command.id, { command, handler });
  },
  registerUi: (contribution) => {
    if (uiRegistered) throw new Error("plugin ui contribution already registered");
    uiContribution = detachJson(contribution);
    uiRegistered = true;
  },
};

const dispose = async (requestId = "dispose-signal") => {
  if (disposing) return;
  disposing = true;
  for (const controller of invocations.values()) controller.abort();
  invocations.clear();
  const failures = [];
  for (const cleanup of finalizers.toReversed()) {
    try {
      await runValue(cleanup(), new AbortController().signal);
    } catch (error) {
      failures.push(detailFrom(error));
    }
  }
  if (failures.length > 0) {
    writeDiagnostic(`plugin cleanup failed: ${failures.join("; ")}`);
    write({ type: "disposeFailed", requestId, detail: failures.join("; ").slice(0, 2_000) });
  } else {
    write({ type: "disposed", requestId });
  }
  setImmediate(() => process.exit(0));
};

const handleMessage = async (message) => {
  if (message === null || typeof message !== "object" || typeof message.type !== "string") {
    throw new Error("invalid parent message");
  }
  switch (message.type) {
    case "hostResult": {
      const pending = pendingHostCalls.get(message.callId);
      if (pending === undefined) return;
      pendingHostCalls.delete(message.callId);
      pending.resolve(message.value);
      return;
    }
    case "hostFailed": {
      const pending = pendingHostCalls.get(message.callId);
      if (pending === undefined) return;
      pendingHostCalls.delete(message.callId);
      pending.reject(new Error(String(message.detail ?? "host capability failed")));
      return;
    }
    case "invoke": {
      if (
        disposing ||
        typeof message.requestId !== "string" ||
        typeof message.commandId !== "string"
      ) {
        return;
      }
      const registration = commands.get(message.commandId);
      if (registration === undefined) {
        write({
          type: "invocationFailed",
          requestId: message.requestId,
          detail: `command not found: ${message.commandId}`,
        });
        return;
      }
      const controller = new AbortController();
      invocations.set(message.requestId, controller);
      void Promise.resolve()
        .then(() => registration.handler(message.context))
        .then((result) => runValue(result, controller.signal))
        .then(
          (value) => writeInvocationResult(message.requestId, value),
          (error) =>
            write({
              type: "invocationFailed",
              requestId: message.requestId,
              detail: detailFrom(error),
            }),
        )
        .finally(() => invocations.delete(message.requestId));
      return;
    }
    case "cancel": {
      invocations.get(message.requestId)?.abort();
      return;
    }
    case "dispose": {
      await dispose(message.requestId);
      return;
    }
    default:
      throw new Error(`unsupported parent message: ${message.type}`);
  }
};

const input = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
    writeDiagnostic("parent protocol line exceeds limit");
    process.exitCode = 1;
    input.close();
    return;
  }
  try {
    const message = JSON.parse(line);
    void handleMessage(message).catch((error) => {
      writeDiagnostic(detailFrom(error));
      process.exitCode = 1;
      input.close();
    });
  } catch (error) {
    writeDiagnostic(detailFrom(error));
    process.exitCode = 1;
    input.close();
  }
});

process.once("SIGTERM", () => void dispose());
process.once("SIGINT", () => void dispose());

try {
  if (typeof entrypointPath !== "string" || typeof pluginId !== "string") {
    throw new Error("plugin worker requires an entrypoint and plugin id");
  }
  const module = await import(NodeURL.pathToFileURL(entrypointPath).href);
  if (typeof module.default !== "function") {
    throw new Error("server entrypoint must export a default activation function");
  }
  await runValue(module.default(api), new AbortController().signal);
  write({
    type: "activated",
    commands: [...commands.values()].map(({ command }) => command),
    ui: uiContribution,
  });
} catch (error) {
  write({ type: "activationFailed", detail: detailFrom(error) });
  process.exitCode = 1;
  input.close();
}
