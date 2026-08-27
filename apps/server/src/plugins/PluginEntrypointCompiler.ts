import { context, type BuildOptions, type Message } from "esbuild";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const GENERATED_DIRECTORY = ".t3-generated";
const GENERATED_ENTRYPOINT = "entrypoint.mjs";

export class PluginEntrypointPrepareError extends Schema.TaggedErrorClass<PluginEntrypointPrepareError>()(
  "PluginEntrypointPrepareError",
  { entrypointPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not prepare plugin entrypoint ${this.entrypointPath}.`;
  }
}

export class PluginEntrypointCompileError extends Schema.TaggedErrorClass<PluginEntrypointCompileError>()(
  "PluginEntrypointCompileError",
  {
    entrypointPath: Schema.String,
    diagnostics: Schema.optional(Schema.String.check(Schema.isMaxLength(4_000))),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Plugin compilation failed for ${this.entrypointPath}${this.diagnostics === undefined ? "." : `:\n${this.diagnostics}`}`;
  }
}

export class PluginEntrypointImportEscapeError extends Schema.TaggedErrorClass<PluginEntrypointImportEscapeError>()(
  "PluginEntrypointImportEscapeError",
  { entrypointPath: Schema.String, sourcePath: Schema.String },
) {
  override get message(): string {
    return `Plugin entrypoint ${this.entrypointPath} imports outside its package: ${this.sourcePath}`;
  }
}

export class PluginEntrypointModuleFormatError extends Schema.TaggedErrorClass<PluginEntrypointModuleFormatError>()(
  "PluginEntrypointModuleFormatError",
  { entrypointPath: Schema.String },
) {
  override get message(): string {
    return `JavaScript plugin entrypoint ${this.entrypointPath} must use ESM.`;
  }
}

export const PluginEntrypointError = Schema.Union([
  PluginEntrypointPrepareError,
  PluginEntrypointCompileError,
  PluginEntrypointImportEscapeError,
  PluginEntrypointModuleFormatError,
]);
export type PluginEntrypointError = typeof PluginEntrypointError.Type;

const formatMessage = (message: Message): string => {
  const location = message.location;
  if (location === null) return message.text;
  return `${location.file}:${String(location.line)}:${String(location.column + 1)}: ${message.text}`;
};

const compileError =
  (entrypointPath: string) =>
  (cause: unknown): PluginEntrypointCompileError => {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "errors" in cause &&
      Array.isArray(cause.errors)
    ) {
      const details = cause.errors
        .filter(
          (message): message is Message =>
            typeof message === "object" && message !== null && "text" in message,
        )
        .slice(0, 10)
        .map(formatMessage)
        .join("\n");
      if (details.length > 0) {
        return new PluginEntrypointCompileError({
          entrypointPath,
          diagnostics: details.slice(0, 4_000),
          cause,
        });
      }
    }
    return new PluginEntrypointCompileError({ entrypointPath, cause });
  };

const isContained = (path: Path.Path, root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export interface PluginEntrypointCompileInput {
  readonly packageDirectory: string;
  readonly entrypointPath: string;
}

export const compilePluginEntrypoint = Effect.fn("PluginEntrypointCompiler.compile")(function* (
  input: PluginEntrypointCompileInput,
): Effect.fn.Return<string, PluginEntrypointError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const extension = path.extname(input.entrypointPath).toLowerCase();

  const outputDirectory = path.join(input.packageDirectory, GENERATED_DIRECTORY);
  const outputPath = path.join(outputDirectory, GENERATED_ENTRYPOINT);
  yield* fileSystem.makeDirectory(outputDirectory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new PluginEntrypointPrepareError({
          entrypointPath: input.entrypointPath,
          cause,
        }),
    ),
  );

  const relativeEntrypoint = path.relative(input.packageDirectory, input.entrypointPath);
  const buildOptions: BuildOptions = {
    absWorkingDir: input.packageDirectory,
    entryPoints: [relativeEntrypoint],
    outfile: outputPath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    conditions: ["node", "import", "default"],
    mainFields: ["module", "main"],
    sourcemap: "inline",
    sourcesContent: true,
    metafile: true,
    charset: "utf8",
    legalComments: "none",
    logLevel: "silent",
  };
  const result = yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => context(buildOptions),
      catch: compileError(input.entrypointPath),
    }),
    (buildContext) =>
      Effect.tryPromise({
        try: (signal) => {
          const cancel = () => void buildContext.cancel();
          signal.addEventListener("abort", cancel, { once: true });
          return buildContext.rebuild().finally(() => signal.removeEventListener("abort", cancel));
        },
        catch: compileError(input.entrypointPath),
      }),
    (buildContext) => Effect.promise(() => buildContext.dispose()),
  );

  const entrypointInput = Object.entries(result.metafile?.inputs ?? {}).find(
    ([sourcePath]) =>
      path.normalize(path.resolve(input.packageDirectory, sourcePath)) ===
      path.normalize(input.entrypointPath),
  )?.[1];
  if (extension === ".js" && entrypointInput?.format === "cjs") {
    return yield* new PluginEntrypointModuleFormatError({
      entrypointPath: input.entrypointPath,
    });
  }

  for (const sourcePath of Object.keys(result.metafile?.inputs ?? {})) {
    const absoluteSourcePath = path.resolve(input.packageDirectory, sourcePath);
    if (!isContained(path, input.packageDirectory, absoluteSourcePath)) {
      return yield* new PluginEntrypointImportEscapeError({
        entrypointPath: input.entrypointPath,
        sourcePath,
      });
    }
  }

  return outputPath;
});
