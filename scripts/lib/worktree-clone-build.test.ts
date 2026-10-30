import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { buildWorktreeClone } from "./worktree-clone-build.ts";

const macOS = HostProcess.Platform.defaultValue() === "darwin";

it.effect.skipIf(!macOS)("builds APFS helpers with arm64, x64 and universal architectures", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "native-build-" });
    const repoRoot = yield* path.fromFileUrl(new URL("../..", import.meta.url));
    for (const arch of ["arm64", "x64", "universal"] as const) {
      const output = path.join(root, arch, "t3-worktree-clone");
      yield* buildWorktreeClone({ repoRoot, output, arch });
      assert.notEqual((yield* fs.stat(output)).mode & 0o111, 0);
      const expected =
        arch === "universal" ? ["arm64", "x86_64"] : [arch === "x64" ? "x86_64" : "arm64"];
      const child = yield* spawner.spawn(
        ChildProcess.make("lipo", [output, "-verify_arch", ...expected], {
          stdout: "ignore",
          stderr: "inherit",
        }),
      );
      assert.equal(yield* child.exitCode, 0);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects a non-macOS compiler host without publishing an output", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "native-build-host-" });
    const output = path.join(root, "not-published");
    const result = yield* buildWorktreeClone({ repoRoot: root, output, arch: "arm64" }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.result,
    );
    assert.isTrue(Result.isFailure(result));
    assert.isFalse(yield* fs.exists(output));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
