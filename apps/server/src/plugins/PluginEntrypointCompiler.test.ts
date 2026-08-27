import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  compilePluginEntrypoint,
  PluginEntrypointImportEscapeError,
} from "./PluginEntrypointCompiler.ts";

const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.String));

it.layer(NodeServices.layer)("plugin entrypoint compiler", (it) => {
  it.effect("emits an inline source map for compiled TypeScript", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const packageDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-typescript-compiler-test-",
      });
      const entrypointPath = path.join(packageDirectory, "index.ts");
      yield* fileSystem.writeFileString(
        entrypointPath,
        `
enum Tone { Success = "success" }
export const result: { tone: string } = { tone: Tone.Success };
`,
      );

      const outputPath = yield* compilePluginEntrypoint({
        packageDirectory,
        entrypointPath,
      });
      const output = yield* fileSystem.readFileString(outputPath);
      expect(output).toContain("sourceMappingURL=data:application/json;base64,");
    }),
  );

  it.effect("compiles ESM JavaScript through the same generated entrypoint", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const packageDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-javascript-compiler-test-",
      });
      const entrypointPath = path.join(packageDirectory, "index.js");
      yield* fileSystem.writeFileString(entrypointPath, "export default function activate() {}\n");

      const outputPath = yield* compilePluginEntrypoint({
        packageDirectory,
        entrypointPath,
      });
      expect(outputPath).not.toBe(entrypointPath);
      expect(yield* fileSystem.readFileString(outputPath)).toContain(
        "sourceMappingURL=data:application/json;base64,",
      );
    }),
  );

  it.effect("rejects CommonJS JavaScript entrypoints", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const packageDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-commonjs-compiler-test-",
      });
      const entrypointPath = path.join(packageDirectory, "dist", "index.js");
      yield* fileSystem.makeDirectory(path.dirname(entrypointPath), { recursive: true });
      yield* fileSystem.writeFileString(
        entrypointPath,
        "module.exports = function activate() {};\n",
      );

      const compiled = yield* Effect.exit(
        compilePluginEntrypoint({ packageDirectory, entrypointPath }),
      );
      expect(compiled._tag).toBe("Failure");
      if (compiled._tag === "Failure") {
        expect(Cause.squash(compiled.cause)).toEqual(
          expect.objectContaining({
            _tag: "PluginEntrypointModuleFormatError",
            entrypointPath,
          }),
        );
      }
    }),
  );

  it.effect("rejects TypeScript imports outside the plugin package", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parentDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-plugin-typescript-containment-test-",
      });
      const packageDirectory = path.join(parentDirectory, "plugin");
      const outsidePath = path.join(parentDirectory, "outside.ts");
      const entrypointPath = path.join(packageDirectory, "index.ts");
      yield* fileSystem.makeDirectory(packageDirectory);
      yield* fileSystem.writeFileString(outsidePath, 'export const secret = "outside";\n');
      yield* fileSystem.writeFileString(
        entrypointPath,
        `import { secret } from ${encodeJsonString(outsidePath)};\nexport default secret;\n`,
      );

      const compiled = yield* Effect.exit(
        compilePluginEntrypoint({ packageDirectory, entrypointPath }),
      );
      expect(compiled._tag).toBe("Failure");
      if (compiled._tag === "Failure") {
        expect(Cause.squash(compiled.cause)).toEqual(
          expect.objectContaining<Partial<PluginEntrypointImportEscapeError>>({
            entrypointPath,
            sourcePath: "../outside.ts",
          }),
        );
      }
    }),
  );
});
