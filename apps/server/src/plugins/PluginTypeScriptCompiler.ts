import { context, type BuildOptions, type Message } from "esbuild";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".mts", ".cts"]);
const GENERATED_DIRECTORY = ".t3-generated";
const GENERATED_ENTRYPOINT = "entrypoint.mjs";

export class PluginTypeScriptCompileError extends Schema.TaggedErrorClass<PluginTypeScriptCompileError>()(
  "PluginTypeScriptCompileError",
  {
    entrypointPath: Schema.String,
    stage: Schema.Literals(["prepare", "compile", "containment"]),
    diagnostics: Schema.optional(Schema.String.check(Schema.isMaxLength(4_000))),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.stage) {
      case "prepare":
        return `Could not prepare TypeScript plugin entrypoint ${this.entrypointPath}.`;
      case "compile":
        return `TypeScript compilation failed for ${this.entrypointPath}${this.diagnostics === undefined ? "." : `:\n${this.diagnostics}`}`;
      case "containment":
        return `TypeScript entrypoint ${this.entrypointPath} imports outside its plugin package${this.diagnostics === undefined ? "." : `: ${this.diagnostics}`}`;
    }
  }
}

const formatMessage = (message: Message): string => {
  const location = message.location;
  if (location === null) return message.text;
  return `${location.file}:${String(location.line)}:${String(location.column + 1)}: ${message.text}`;
};

const compileError =
  (entrypointPath: string) =>
  (cause: unknown): PluginTypeScriptCompileError => {
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
        return new PluginTypeScriptCompileError({
          entrypointPath,
          stage: "compile",
          diagnostics: details.slice(0, 4_000),
          cause,
        });
      }
    }
    const detail = cause instanceof Error ? cause.message : String(cause);
    return new PluginTypeScriptCompileError({
      entrypointPath,
      stage: "compile",
      diagnostics: detail.slice(0, 4_000),
      cause,
    });
  };

const isContained = (path: Path.Path, root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export interface PluginTypeScriptCompileInput {
  readonly packageDirectory: string;
  readonly entrypointPath: string;
}

export const compilePluginTypeScriptEntrypoint = Effect.fn(
  "PluginTypeScriptCompiler.compileEntrypoint",
)(function* (
  input: PluginTypeScriptCompileInput,
): Effect.fn.Return<string, PluginTypeScriptCompileError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!TYPESCRIPT_EXTENSIONS.has(path.extname(input.entrypointPath).toLowerCase())) {
    return input.entrypointPath;
  }

  const outputDirectory = path.join(input.packageDirectory, GENERATED_DIRECTORY);
  const outputPath = path.join(outputDirectory, GENERATED_ENTRYPOINT);
  yield* fileSystem.makeDirectory(outputDirectory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new PluginTypeScriptCompileError({
          entrypointPath: input.entrypointPath,
          stage: "prepare",
          cause,
        }),
    ),
  );

  const buildOptions: BuildOptions = {
    absWorkingDir: input.packageDirectory,
    entryPoints: [path.relative(input.packageDirectory, input.entrypointPath)],
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

  for (const sourcePath of Object.keys(result.metafile?.inputs ?? {})) {
    const absoluteSourcePath = path.resolve(input.packageDirectory, sourcePath);
    if (!isContained(path, input.packageDirectory, absoluteSourcePath)) {
      return yield* new PluginTypeScriptCompileError({
        entrypointPath: input.entrypointPath,
        stage: "containment",
        diagnostics: sourcePath,
      });
    }
  }

  return outputPath;
});
