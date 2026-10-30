import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

class WorktreeCloneBuildError extends Schema.TaggedError<WorktreeCloneBuildError>()(
  "WorktreeCloneBuildError",
  { detail: Schema.String },
) {}

export const buildWorktreeClone = Effect.fn("buildWorktreeClone")(function* (input: {
  readonly repoRoot: string;
  readonly output: string;
  readonly arch: "arm64" | "x64" | "universal";
}) {
  if ((yield* HostProcess.Platform) !== "darwin")
    return yield* new WorktreeCloneBuildError({
      detail: "The APFS helper requires a macOS build host.",
    });
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* fs.makeDirectory(path.dirname(input.output), { recursive: true });
  yield* Effect.scoped(
    Effect.gen(function* () {
      const temporary = yield* fs.makeTempDirectoryScoped({
        directory: path.dirname(input.output),
        prefix: ".build-",
      });
      const executable = path.join(temporary, "t3-worktree-clone");
      const architectures =
        input.arch === "universal"
          ? ["arm64", "x86_64"]
          : [input.arch === "x64" ? "x86_64" : "arm64"];
      const child = yield* spawner.spawn(
        ChildProcess.make(
          "cc",
          [
            "-std=c11",
            "-O3",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-pthread",
            "-mmacosx-version-min=12.0",
            ...architectures.flatMap((arch) => ["-arch", arch]),
            path.join(input.repoRoot, "native/worktree-clone/main.c"),
            "-o",
            executable,
          ],
          { stdout: "inherit", stderr: "inherit" },
        ),
      );
      if ((yield* child.exitCode) !== 0)
        return yield* new WorktreeCloneBuildError({ detail: "Failed to compile the APFS helper." });
      yield* fs.chmod(executable, 0o755);
      yield* fs.rename(executable, input.output);
    }),
  );
});
