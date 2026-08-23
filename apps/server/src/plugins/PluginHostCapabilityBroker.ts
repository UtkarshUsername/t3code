import { NodeHttpClient } from "@effect/platform-node";
import { PluginHostPermission } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";

const MAX_DATA_FILE_BYTES = 1_000_000;
const MAX_EXTERNAL_OUTPUT_BYTES = 1_000_000;
const EXTERNAL_OPERATION_TIMEOUT = "30 seconds";
const pluginIdPattern = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/;
const dataKeyPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const processNamePattern = /^[A-Za-z0-9._+-]{1,128}$/;

type JsonValue = Schema.Json;

const StoreEntry = Schema.Struct({ key: Schema.String, value: Schema.Json });
const StoreFile = Schema.Struct({ entries: Schema.Array(StoreEntry) });
const GrantEntry = Schema.Struct({
  id: Schema.String,
  permissions: Schema.Array(PluginHostPermission),
});
const GrantFile = Schema.Struct({ grants: Schema.Array(GrantEntry) });
const decodeStoreFile = Schema.decodeUnknownEffect(Schema.fromJsonString(StoreFile));
const encodeStoreFile = Schema.encodeEffect(Schema.fromJsonString(StoreFile));
const decodeGrantFile = Schema.decodeUnknownEffect(Schema.fromJsonString(GrantFile));
const encodeGrantFile = Schema.encodeEffect(Schema.fromJsonString(GrantFile));
const decodeJson = Schema.decodeUnknownEffect(Schema.Json);
const decodePermissions = Schema.decodeUnknownEffect(Schema.Array(PluginHostPermission));

export class PluginHostCapabilityError extends Schema.TaggedErrorClass<PluginHostCapabilityError>()(
  "PluginHostCapabilityError",
  {
    pluginId: Schema.String,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.operation} failed for plugin ${this.pluginId}: ${this.detail}`;
  }
}

const isPluginHostCapabilityError = Schema.is(PluginHostCapabilityError);

export interface PluginHostKeyValueStore {
  readonly get: (key: string) => Effect.Effect<unknown | undefined, PluginHostCapabilityError>;
  readonly set: (key: string, value: unknown) => Effect.Effect<void, PluginHostCapabilityError>;
  readonly delete: (key: string) => Effect.Effect<void, PluginHostCapabilityError>;
  readonly clear: Effect.Effect<void, PluginHostCapabilityError>;
}

export interface PluginHostApi {
  readonly settings: PluginHostKeyValueStore;
  readonly state: PluginHostKeyValueStore;
  readonly cache: PluginHostKeyValueStore;
  readonly secrets: {
    readonly get: (name: string) => Effect.Effect<string | undefined, PluginHostCapabilityError>;
    readonly set: (name: string, value: string) => Effect.Effect<void, PluginHostCapabilityError>;
    readonly delete: (name: string) => Effect.Effect<void, PluginHostCapabilityError>;
  };
  readonly files: {
    readonly readText: (relativePath: string) => Effect.Effect<string, PluginHostCapabilityError>;
    readonly writeText: (
      relativePath: string,
      contents: string,
    ) => Effect.Effect<void, PluginHostCapabilityError>;
    readonly remove: (relativePath: string) => Effect.Effect<void, PluginHostCapabilityError>;
  };
  readonly network: {
    readonly fetchText: (url: string) => Effect.Effect<
      {
        readonly status: number;
        readonly headers: Readonly<Record<string, string>>;
        readonly body: string;
      },
      PluginHostCapabilityError
    >;
  };
  readonly process: {
    readonly run: (
      command: string,
      args?: ReadonlyArray<string>,
    ) => Effect.Effect<
      { readonly exitCode: number; readonly stdout: string; readonly stderr: string },
      PluginHostCapabilityError
    >;
  };
}

export class PluginHostCapabilityBroker extends Context.Service<
  PluginHostCapabilityBroker,
  {
    readonly granted: (
      pluginId: string,
    ) => Effect.Effect<ReadonlyArray<string>, PluginHostCapabilityError>;
    readonly snapshot: Effect.Effect<
      ReadonlyMap<string, ReadonlyArray<string>>,
      PluginHostCapabilityError
    >;
    readonly grant: (
      pluginId: string,
      permissions: ReadonlyArray<string>,
    ) => Effect.Effect<void, PluginHostCapabilityError>;
    readonly open: (
      pluginId: string,
      requestedPermissions: ReadonlyArray<string>,
    ) => Effect.Effect<PluginHostApi, PluginHostCapabilityError>;
  }
>()("t3/plugins/PluginHostCapabilityBroker") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const semaphore = yield* Semaphore.make(1);
  const pluginDataRoot = path.join(serverConfig.stateDir, "plugin-data");
  const grantFilePath = path.join(pluginDataRoot, "grants.json");
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  const atomicWrite = (filePath: string, contents: string) =>
    writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const fail = (
    pluginId: string,
    operation: string,
    detail: string,
    cause?: unknown,
  ): PluginHostCapabilityError =>
    new PluginHostCapabilityError({
      pluginId,
      operation,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const validatePluginId = (
    pluginId: string,
    operation: string,
  ): Effect.Effect<void, PluginHostCapabilityError> =>
    pluginIdPattern.test(pluginId)
      ? Effect.void
      : Effect.fail(fail(pluginId, operation, "invalid plugin id"));

  const validateKey = (
    pluginId: string,
    operation: string,
    key: string,
  ): Effect.Effect<void, PluginHostCapabilityError> =>
    dataKeyPattern.test(key)
      ? Effect.void
      : Effect.fail(fail(pluginId, operation, `invalid key ${key}`));

  const requirePermission = (
    pluginId: string,
    requested: ReadonlySet<string>,
    permission: string,
    operation: string,
  ): Effect.Effect<void, PluginHostCapabilityError> =>
    requested.has(permission)
      ? Effect.void
      : Effect.fail(fail(pluginId, operation, `permission not declared: ${permission}`));

  const readTextIfPresent = Effect.fn("PluginHostCapabilityBroker.readTextIfPresent")(function* (
    filePath: string,
    pluginId: string,
    operation: string,
  ): Effect.fn.Return<Option.Option<string>, PluginHostCapabilityError> {
    const info = yield* fileSystem.stat(filePath).pipe(
      Effect.map(Option.some),
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<FileSystem.File.Info>())
          : Effect.fail(
              fail(pluginId, operation, `could not stat ${path.basename(filePath)}`, cause),
            ),
      ),
    );
    if (Option.isNone(info)) return Option.none();
    if (info.value.size > BigInt(MAX_DATA_FILE_BYTES)) {
      return yield* fail(pluginId, operation, `${path.basename(filePath)} exceeds data limit`);
    }
    const contents = yield* fileSystem
      .readFileString(filePath)
      .pipe(
        Effect.mapError((cause) =>
          fail(pluginId, operation, `could not read ${path.basename(filePath)}`, cause),
        ),
      );
    if (Buffer.byteLength(contents, "utf8") > MAX_DATA_FILE_BYTES) {
      return yield* fail(pluginId, operation, `${path.basename(filePath)} exceeds data limit`);
    }
    return Option.some(contents);
  });

  const readGrants = Effect.fn("PluginHostCapabilityBroker.readGrants")(function* (
    pluginId: string,
    operation: string,
  ): Effect.fn.Return<Map<string, ReadonlyArray<string>>, PluginHostCapabilityError> {
    const contents = yield* readTextIfPresent(grantFilePath, pluginId, operation);
    if (Option.isNone(contents)) return new Map();
    const decoded = yield* decodeGrantFile(contents.value).pipe(
      Effect.mapError((cause) => fail(pluginId, operation, "plugin grant file is invalid", cause)),
    );
    return new Map(
      decoded.grants.map(({ id, permissions }) => [id, [...new Set(permissions)].sort()] as const),
    );
  });

  const writeGrants = Effect.fn("PluginHostCapabilityBroker.writeGrants")(function* (
    pluginId: string,
    operation: string,
    grants: ReadonlyMap<string, ReadonlyArray<string>>,
  ): Effect.fn.Return<void, PluginHostCapabilityError> {
    const contents = yield* encodeGrantFile({
      grants: [...grants.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, permissions]) => ({ id, permissions: [...permissions].sort() })),
    }).pipe(
      Effect.mapError((cause) =>
        fail(pluginId, operation, "could not encode plugin grants", cause),
      ),
    );
    yield* atomicWrite(grantFilePath, contents).pipe(
      Effect.mapError((cause) =>
        fail(pluginId, operation, "could not persist plugin grants", cause),
      ),
    );
  });

  const snapshot: PluginHostCapabilityBroker["Service"]["snapshot"] = semaphore.withPermits(1)(
    readGrants("<all>", "granted"),
  );

  const granted: PluginHostCapabilityBroker["Service"]["granted"] = (pluginId) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        yield* validatePluginId(pluginId, "granted");
        const grants = yield* readGrants(pluginId, "granted");
        return grants.get(pluginId) ?? [];
      }),
    );

  const grant: PluginHostCapabilityBroker["Service"]["grant"] = (pluginId, permissions) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        yield* validatePluginId(pluginId, "grant");
        const validatedPermissions = yield* decodePermissions(permissions).pipe(
          Effect.mapError((cause) =>
            fail(pluginId, "grant", "plugin permissions are invalid", cause),
          ),
        );
        const grants = yield* readGrants(pluginId, "grant");
        grants.set(pluginId, [...new Set(validatedPermissions)].sort());
        yield* writeGrants(pluginId, "grant", grants);
      }),
    );

  const makeStore = (
    pluginId: string,
    requested: ReadonlySet<string>,
    name: "settings" | "state" | "cache",
  ): PluginHostKeyValueStore => {
    const permission = `${name}:read-write`;
    const filePath = path.join(pluginDataRoot, pluginId, `${name}.json`);
    const operation = `${name} data`;

    const read = Effect.gen(function* () {
      const contents = yield* readTextIfPresent(filePath, pluginId, operation);
      if (Option.isNone(contents)) return new Map<string, JsonValue>();
      const decoded = yield* decodeStoreFile(contents.value).pipe(
        Effect.mapError((cause) => fail(pluginId, operation, `${name} data is invalid`, cause)),
      );
      return new Map(decoded.entries.map(({ key, value }) => [key, value]));
    });

    const write = Effect.fn(`PluginHostCapabilityBroker.${name}.write`)(function* (
      entries: ReadonlyMap<string, JsonValue>,
    ): Effect.fn.Return<void, PluginHostCapabilityError> {
      const contents = yield* encodeStoreFile({
        entries: [...entries.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => ({ key, value })),
      }).pipe(
        Effect.mapError((cause) =>
          fail(pluginId, operation, `could not encode ${name} data`, cause),
        ),
      );
      if (Buffer.byteLength(contents, "utf8") > MAX_DATA_FILE_BYTES) {
        return yield* fail(
          pluginId,
          operation,
          `${name} data exceeds ${MAX_DATA_FILE_BYTES} bytes`,
        );
      }
      yield* atomicWrite(filePath, contents).pipe(
        Effect.mapError((cause) =>
          fail(pluginId, operation, `could not persist ${name} data`, cause),
        ),
      );
    });

    const use = <A>(
      effect: Effect.Effect<A, PluginHostCapabilityError>,
    ): Effect.Effect<A, PluginHostCapabilityError> =>
      Effect.gen(function* () {
        yield* requirePermission(pluginId, requested, permission, operation);
        return yield* semaphore.withPermits(1)(effect);
      });

    return {
      get: (key) =>
        use(
          Effect.gen(function* () {
            yield* validateKey(pluginId, operation, key);
            const entries = yield* read;
            return entries.get(key);
          }),
        ),
      set: (key, value) =>
        use(
          Effect.gen(function* () {
            yield* validateKey(pluginId, operation, key);
            const detached = yield* decodeJson(value).pipe(
              Effect.mapError((cause) =>
                fail(pluginId, operation, "value must be JSON-compatible", cause),
              ),
            );
            const entries = yield* read;
            entries.set(key, detached);
            yield* write(entries);
          }),
        ),
      delete: (key) =>
        use(
          Effect.gen(function* () {
            yield* validateKey(pluginId, operation, key);
            const entries = yield* read;
            entries.delete(key);
            yield* write(entries);
          }),
        ),
      clear: use(write(new Map())),
    };
  };

  const secretResourceName = (pluginId: string, name: string) =>
    `plugin-${Buffer.from(pluginId, "utf8").toString("base64url")}-${Buffer.from(name, "utf8").toString("base64url")}`;

  const resolveFilePath = (
    pluginId: string,
    relativePath: string,
  ): Effect.Effect<string, PluginHostCapabilityError> => {
    const root = path.join(pluginDataRoot, pluginId, "files");
    const resolved = path.resolve(root, relativePath);
    const relative = path.relative(root, resolved);
    return relativePath.length > 0 &&
      !path.isAbsolute(relativePath) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`)
      ? Effect.succeed(resolved)
      : Effect.fail(fail(pluginId, "filesystem", "path escapes plugin data directory"));
  };

  const isContained = (root: string, target: string): boolean => {
    const relative = path.relative(root, target);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };

  const resolveExistingFilePath = Effect.fn("PluginHostCapabilityBroker.resolveExistingFilePath")(
    function* (
      pluginId: string,
      relativePath: string,
      operation: string,
    ): Effect.fn.Return<string, PluginHostCapabilityError> {
      const root = path.join(pluginDataRoot, pluginId, "files");
      const lexical = yield* resolveFilePath(pluginId, relativePath);
      const [canonicalRoot, canonicalTarget] = yield* Effect.all(
        [fileSystem.realPath(root), fileSystem.realPath(lexical)],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError((cause) =>
          fail(pluginId, operation, `could not resolve ${relativePath}`, cause),
        ),
      );
      if (!isContained(canonicalRoot, canonicalTarget)) {
        return yield* fail(pluginId, operation, "path escapes plugin data directory");
      }
      if (path.normalize(lexical) !== path.normalize(canonicalTarget)) {
        return yield* fail(pluginId, operation, "symbolic links are not allowed in plugin data");
      }
      return canonicalTarget;
    },
  );

  const resolveWritableFilePath = Effect.fn("PluginHostCapabilityBroker.resolveWritableFilePath")(
    function* (
      pluginId: string,
      relativePath: string,
    ): Effect.fn.Return<string, PluginHostCapabilityError> {
      const pluginRoot = path.join(pluginDataRoot, pluginId);
      const root = path.join(pluginDataRoot, pluginId, "files");
      const lexical = yield* resolveFilePath(pluginId, relativePath);
      const parent = path.dirname(lexical);
      let existingAncestor = parent;
      while (existingAncestor !== pluginRoot) {
        const exists = yield* fileSystem
          .exists(existingAncestor)
          .pipe(
            Effect.mapError((cause) =>
              fail(pluginId, "filesystem write", `could not inspect ${relativePath}`, cause),
            ),
          );
        if (exists) break;
        existingAncestor = path.dirname(existingAncestor);
      }
      const [canonicalPluginRoot, canonicalAncestor] = yield* Effect.all(
        [fileSystem.realPath(pluginRoot), fileSystem.realPath(existingAncestor)],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError((cause) =>
          fail(pluginId, "filesystem write", `could not resolve ${relativePath}`, cause),
        ),
      );
      if (
        !isContained(canonicalPluginRoot, canonicalAncestor) ||
        path.normalize(existingAncestor) !== path.normalize(canonicalAncestor)
      ) {
        return yield* fail(
          pluginId,
          "filesystem write",
          "symbolic links are not allowed in plugin data",
        );
      }
      yield* fileSystem
        .makeDirectory(parent, { recursive: true })
        .pipe(
          Effect.mapError((cause) =>
            fail(pluginId, "filesystem write", `could not create ${relativePath}`, cause),
          ),
        );
      const [canonicalRoot, canonicalParent] = yield* Effect.all(
        [fileSystem.realPath(root), fileSystem.realPath(parent)],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError((cause) =>
          fail(pluginId, "filesystem write", `could not resolve ${relativePath}`, cause),
        ),
      );
      if (!isContained(canonicalRoot, canonicalParent)) {
        return yield* fail(pluginId, "filesystem write", "path escapes plugin data directory");
      }
      if (path.normalize(parent) !== path.normalize(canonicalParent)) {
        return yield* fail(
          pluginId,
          "filesystem write",
          "symbolic links are not allowed in plugin data",
        );
      }
      return path.join(canonicalParent, path.basename(lexical));
    },
  );

  const concatChunks = (chunks: Iterable<Uint8Array>): Uint8Array => {
    const arrays = [...chunks];
    const length = arrays.reduce((total, chunk) => total + chunk.byteLength, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of arrays) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  };

  const collectBounded = <E>(
    pluginId: string,
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<Uint8Array, PluginHostCapabilityError> =>
    Stream.runFoldEffect(
      stream,
      () => ({ bytes: 0, chunks: [] as Array<Uint8Array> }),
      (collected, chunk) => {
        const bytes = collected.bytes + chunk.byteLength;
        if (bytes > MAX_EXTERNAL_OUTPUT_BYTES) {
          return Effect.fail(fail(pluginId, operation, `${operation} output exceeds limit`));
        }
        collected.chunks.push(chunk);
        return Effect.succeed({ bytes, chunks: collected.chunks });
      },
    ).pipe(
      Effect.map((collected) => concatChunks(collected.chunks)),
      Effect.mapError((cause) =>
        isPluginHostCapabilityError(cause)
          ? cause
          : fail(pluginId, operation, `${operation} output failed`, cause),
      ),
    );

  const open: PluginHostCapabilityBroker["Service"]["open"] = (pluginId, requestedPermissions) =>
    Effect.gen(function* () {
      yield* validatePluginId(pluginId, "open");
      const persistedPermissions = yield* granted(pluginId);
      const grantedSet = new Set(persistedPermissions);
      const requested = new Set(requestedPermissions);
      const missing = [...requested].filter((permission) => !grantedSet.has(permission)).sort();
      if (missing.length > 0) {
        return yield* fail(pluginId, "open", `permission approval required: ${missing.join(", ")}`);
      }

      yield* fileSystem
        .makeDirectory(path.join(pluginDataRoot, pluginId), { recursive: true })
        .pipe(
          Effect.mapError((cause) =>
            fail(pluginId, "open", "could not create plugin data directory", cause),
          ),
        );

      const requireSecret = (name: string, operation: string) =>
        Effect.gen(function* () {
          yield* validateKey(pluginId, operation, name);
          yield* requirePermission(pluginId, requested, `secrets:${name}`, operation);
        });
      const requireFiles = (operation: string) =>
        requirePermission(pluginId, requested, "filesystem:data", operation);

      return {
        settings: makeStore(pluginId, requested, "settings"),
        state: makeStore(pluginId, requested, "state"),
        cache: makeStore(pluginId, requested, "cache"),
        secrets: {
          get: (name) =>
            Effect.gen(function* () {
              yield* requireSecret(name, "secret read");
              const value = yield* secretStore
                .get(secretResourceName(pluginId, name))
                .pipe(
                  Effect.mapError((cause) =>
                    fail(pluginId, "secret read", `could not read ${name}`, cause),
                  ),
                );
              return Option.isSome(value) ? textDecoder.decode(value.value) : undefined;
            }),
          set: (name, value) =>
            Effect.gen(function* () {
              yield* requireSecret(name, "secret write");
              yield* secretStore
                .set(secretResourceName(pluginId, name), textEncoder.encode(value))
                .pipe(
                  Effect.mapError((cause) =>
                    fail(pluginId, "secret write", `could not write ${name}`, cause),
                  ),
                );
            }),
          delete: (name) =>
            Effect.gen(function* () {
              yield* requireSecret(name, "secret delete");
              yield* secretStore
                .remove(secretResourceName(pluginId, name))
                .pipe(
                  Effect.mapError((cause) =>
                    fail(pluginId, "secret delete", `could not remove ${name}`, cause),
                  ),
                );
            }),
        },
        files: {
          readText: (relativePath) =>
            Effect.gen(function* () {
              yield* requireFiles("filesystem read");
              const filePath = yield* resolveExistingFilePath(
                pluginId,
                relativePath,
                "filesystem read",
              );
              const info = yield* fileSystem
                .stat(filePath)
                .pipe(
                  Effect.mapError((cause) =>
                    fail(pluginId, "filesystem read", `could not inspect ${relativePath}`, cause),
                  ),
                );
              if (info.size > BigInt(MAX_DATA_FILE_BYTES)) {
                return yield* fail(pluginId, "filesystem read", "file exceeds plugin data limit");
              }
              const contents = yield* fileSystem
                .readFileString(filePath)
                .pipe(
                  Effect.mapError((cause) =>
                    fail(pluginId, "filesystem read", `could not read ${relativePath}`, cause),
                  ),
                );
              if (Buffer.byteLength(contents, "utf8") > MAX_DATA_FILE_BYTES) {
                return yield* fail(pluginId, "filesystem read", "file exceeds plugin data limit");
              }
              return contents;
            }),
          writeText: (relativePath, contents) =>
            Effect.gen(function* () {
              yield* requireFiles("filesystem write");
              if (Buffer.byteLength(contents, "utf8") > MAX_DATA_FILE_BYTES) {
                return yield* fail(pluginId, "filesystem write", "file exceeds plugin data limit");
              }
              const filePath = yield* resolveWritableFilePath(pluginId, relativePath);
              yield* atomicWrite(filePath, contents).pipe(
                Effect.mapError((cause) =>
                  fail(pluginId, "filesystem write", `could not write ${relativePath}`, cause),
                ),
              );
            }),
          remove: (relativePath) =>
            Effect.gen(function* () {
              yield* requireFiles("filesystem remove");
              const filePath = yield* resolveExistingFilePath(
                pluginId,
                relativePath,
                "filesystem remove",
              );
              yield* fileSystem
                .remove(filePath, { force: true })
                .pipe(
                  Effect.mapError((cause) =>
                    fail(pluginId, "filesystem remove", `could not remove ${relativePath}`, cause),
                  ),
                );
            }),
        },
        network: {
          fetchText: (url) =>
            Effect.gen(function* () {
              const parsed = yield* Effect.try({
                try: () => new URL(url),
                catch: (cause) => fail(pluginId, "network fetch", "invalid URL", cause),
              });
              yield* requirePermission(
                pluginId,
                requested,
                `network:${parsed.origin}`,
                "network fetch",
              );
              // The Undici dispatcher client does not follow redirects. Reject every redirect response
              // so a future client change cannot widen this origin grant.
              const response = yield* httpClient.get(parsed).pipe(
                Effect.timeout(EXTERNAL_OPERATION_TIMEOUT),
                Effect.mapError((cause) =>
                  fail(pluginId, "network fetch", `request failed for ${parsed.origin}`, cause),
                ),
              );
              if (response.status >= 300 && response.status < 400) {
                return yield* fail(pluginId, "network fetch", "redirect responses are not allowed");
              }
              const body = textDecoder.decode(
                yield* collectBounded(pluginId, "network fetch", response.stream).pipe(
                  Effect.timeout(EXTERNAL_OPERATION_TIMEOUT),
                  Effect.mapError((cause) =>
                    isPluginHostCapabilityError(cause)
                      ? cause
                      : fail(
                          pluginId,
                          "network fetch",
                          `response timed out for ${parsed.origin}`,
                          cause,
                        ),
                  ),
                ),
              );
              return { status: response.status, headers: response.headers, body };
            }),
        },
        process: {
          run: (command, args = []) =>
            Effect.gen(function* () {
              yield* requirePermission(pluginId, requested, `process:${command}`, "process run");
              if (!processNamePattern.test(command)) {
                return yield* fail(pluginId, "process run", "invalid process name");
              }
              const executable = command === "node" ? process.execPath : command;
              const childCommand = ChildProcess.make(executable, [...args], {
                cwd: path.join(pluginDataRoot, pluginId),
                env: { PATH: process.env.PATH },
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
                shell: false,
                killSignal: "SIGTERM",
                forceKillAfter: "1 second",
              });
              const result = yield* Effect.scoped(
                Effect.gen(function* () {
                  const handle = yield* childProcessSpawner.spawn(childCommand);
                  const [stdoutChunks, stderrChunks, exitCode] = yield* Effect.all(
                    [
                      collectBounded(pluginId, "process stdout", handle.stdout),
                      collectBounded(pluginId, "process stderr", handle.stderr),
                      handle.exitCode,
                    ],
                    { concurrency: "unbounded" },
                  );
                  return {
                    exitCode: exitCode as unknown as number,
                    stdout: textDecoder.decode(stdoutChunks),
                    stderr: textDecoder.decode(stderrChunks),
                  };
                }),
              ).pipe(
                Effect.timeout(EXTERNAL_OPERATION_TIMEOUT),
                Effect.mapError((cause) =>
                  isPluginHostCapabilityError(cause)
                    ? cause
                    : fail(pluginId, "process run", "process execution failed", cause),
                ),
              );
              return result;
            }),
        },
      } satisfies PluginHostApi;
    });

  yield* fileSystem.makeDirectory(pluginDataRoot, { recursive: true });

  return PluginHostCapabilityBroker.of({ grant, granted, open, snapshot });
});

export const layer = Layer.effect(PluginHostCapabilityBroker, make).pipe(
  Layer.provide(NodeHttpClient.layerUndici),
);
