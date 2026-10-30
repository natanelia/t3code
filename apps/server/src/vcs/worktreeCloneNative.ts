import { GitCommandError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as ServerConfig from "../config.ts";

export interface CloneStat {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: number;
  readonly uid: bigint;
  readonly gid: bigint;
  readonly size: bigint;
  readonly ctimeNs: bigint;
  readonly mtimeNs: bigint;
  readonly flags: number;
  readonly xattrs: number;
  readonly kind: "file" | "directory" | "symlink" | "other";
}

export interface CloneMetadataChange {
  readonly name: string;
  readonly kind: "f" | "d" | "l";
  readonly mode: number;
}

export class WorktreeCloneNative extends Context.Service<
  WorktreeCloneNative,
  {
    readonly available: Effect.Effect<boolean>;
    readonly inspect: (
      root: string,
      names: ReadonlyArray<string>,
      otherRoot?: string,
    ) => Effect.Effect<
      ReadonlyArray<readonly [CloneStat | null, CloneStat | null]>,
      GitCommandError
    >;
    readonly clone: (
      root: string,
      destination: string,
      names: ReadonlyArray<string>,
    ) => Effect.Effect<void, GitCommandError>;
    readonly normalize: (
      root: string,
      changes: ReadonlyArray<CloneMetadataChange>,
      metadataTemplateRoot?: string,
    ) => Effect.Effect<ReadonlyArray<CloneStat>, GitCommandError>;
  }
>()("t3/vcs/worktreeCloneNative") {}

const Integer = Schema.String.check(Schema.isPattern(/^-?\d+$/));
const StatRecord = Schema.Tuple([
  Integer,
  Integer,
  Integer,
  Integer,
  Integer,
  Integer,
  Integer,
  Integer,
  Integer,
  Integer,
  Integer,
  Integer,
]);
const Inspection = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    stats: Schema.Array(Schema.Tuple([Schema.NullOr(StatRecord), Schema.NullOr(StatRecord)])),
  }),
);
const isGitCommandError = Schema.is(GitCommandError);
const decodeInspection = Schema.decodeEffect(Inspection);

function decodeStat(raw: typeof StatRecord.Type | null): CloneStat | null {
  if (raw === null) return null;
  const mode = Number(raw[2]);
  const flags = Number(raw[10]);
  const xattrs = Number(raw[11]);
  if (
    ![mode, flags, xattrs].every(
      (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff,
    )
  )
    throw new RangeError("Invalid native file metadata");
  const type = mode & 0o170000;
  return {
    dev: BigInt(raw[0]),
    ino: BigInt(raw[1]),
    mode,
    uid: BigInt(raw[3]),
    gid: BigInt(raw[4]),
    size: BigInt(raw[5]),
    ctimeNs: BigInt(raw[6]) * 1_000_000_000n + BigInt(raw[7]),
    mtimeNs: BigInt(raw[8]) * 1_000_000_000n + BigInt(raw[9]),
    flags,
    xattrs,
    kind:
      type === 0o100000
        ? "file"
        : type === 0o040000
          ? "directory"
          : type === 0o120000
            ? "symlink"
            : "other",
  };
}

export const makeWorktreeCloneNative = Effect.fn("WorktreeCloneNative.make")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  const executable = yield* HostProcess.ExecutablePath;
  const singleExecutable = yield* HostProcess.IsExecutable;
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const error = (cwd: string, detail: string) =>
    new GitCommandError({
      operation: "GitVcsDriver.createWorktree.nativeClone",
      command: "t3-worktree-clone",
      cwd,
      detail,
    });
  const command = Effect.fn("WorktreeCloneNative.command")(
    function* (executable: string, args: ReadonlyArray<string>, input = "") {
      const child = yield* spawner.spawn(
        ChildProcess.make(executable, [...args], {
          stdin: Stream.encodeText(Stream.make(input)),
        }),
      );
      let length = 0;
      const [code, output] = yield* Effect.all(
        [
          child.exitCode,
          Stream.runCollect(
            Stream.decodeText(child.stdout).pipe(
              Stream.mapEffect((chunk) => {
                length += chunk.length;
                return length <= 64 * 1024 * 1024
                  ? Effect.succeed(chunk)
                  : Effect.fail(error(args[1] ?? "", "Native clone output exceeded its limit."));
              }),
            ),
          ),
          Stream.runDrain(child.stderr),
        ],
        { concurrency: "unbounded" },
      );
      if (code !== 0) return yield* error(args[1] ?? "", "Native worktree copy failed.");
      return output.join("");
    },
    Effect.scoped,
    Effect.timeout("30 seconds"),
  );
  const resolve = yield* Effect.cached(
    Effect.gen(function* () {
      if (platform !== "darwin") return null;
      const name = "t3-worktree-clone";
      const moduleDirectory = singleExecutable ? path.dirname(executable) : import.meta.dirname;
      const monitor = Option.isSome(config) ? config.value.resourceMonitorPath : undefined;
      const candidates = [
        path.resolve(moduleDirectory, "worktree-clone", name),
        path.resolve(moduleDirectory, "../worktree-clone", name),
        ...(monitor ? [path.resolve(path.dirname(monitor), "../worktree-clone", name)] : []),
      ];
      for (const candidate of candidates) {
        const info = yield* fs.stat(candidate).pipe(Effect.option);
        if (Option.isSome(info) && info.value.type === "File" && (info.value.mode & 0o111) !== 0)
          return candidate;
      }
      // Only source-tree development builds may invoke a compiler. Packaged apps use shipped binaries.
      if (
        singleExecutable ||
        path.basename(moduleDirectory) !== "vcs" ||
        path.basename(path.dirname(moduleDirectory)) !== "src"
      )
        return null;
      const directory = path.resolve(import.meta.dirname, "../../../../native/worktree-clone");
      const source = path.join(directory, "main.c");
      if (!(yield* fs.exists(source))) return null;
      const output = path.join(directory, "build", name);
      const sourceInfo = yield* fs.stat(source);
      const binaryInfo = yield* fs.stat(output).pipe(Effect.option);
      if (
        binaryInfo._tag === "Some" &&
        sourceInfo.mtime._tag === "Some" &&
        binaryInfo.value.mtime._tag === "Some" &&
        binaryInfo.value.mtime.value >= sourceInfo.mtime.value
      )
        return output;
      yield* fs.makeDirectory(path.dirname(output), { recursive: true });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const temporary = yield* fs.makeTempDirectoryScoped({
            directory: path.dirname(output),
            prefix: ".build-",
          });
          const built = path.join(temporary, name);
          yield* command("cc", [
            "-std=c11",
            "-O3",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-pthread",
            source,
            "-o",
            built,
          ]);
          yield* fs.rename(built, output);
        }),
      );
      return output;
    }).pipe(Effect.orElseSucceed(() => null)),
  );
  const run = Effect.fn("WorktreeCloneNative.run")(
    function* (args: ReadonlyArray<string>, values: ReadonlyArray<string>) {
      const binary = yield* resolve;
      if (binary === null)
        return yield* error(args[1] ?? "", "Native worktree copying is unavailable.");
      return yield* command(binary, args, values.length ? values.join("\0") + "\0" : "");
    },
    Effect.mapError((cause) =>
      isGitCommandError(cause) ? cause : error("", "Native worktree copying failed."),
    ),
  );
  const decode = Effect.fn("WorktreeCloneNative.decode")(function* (
    root: string,
    output: string,
    count: number,
  ) {
    const decoded = yield* decodeInspection(output).pipe(
      Effect.mapError(() => error(root, "Invalid native inspection response.")),
    );
    if (decoded.stats.length !== count)
      return yield* error(root, "Incomplete native inspection response.");
    return yield* Effect.try({
      try: () =>
        decoded.stats.map(([source, target]) => [decodeStat(source), decodeStat(target)] as const),
      catch: () => error(root, "Invalid native inspection metadata."),
    });
  });
  return WorktreeCloneNative.of({
    available: resolve.pipe(Effect.map((binary) => binary !== null)),
    inspect: Effect.fn("WorktreeCloneNative.inspect")(function* (root, names, otherRoot) {
      const output = yield* run(
        otherRoot === undefined ? ["stat", root] : ["pair", root, otherRoot],
        names,
      );
      return yield* decode(root, output, names.length);
    }),
    clone: Effect.fn("WorktreeCloneNative.clone")((root, destination, names) =>
      run(["clone", root, destination], names).pipe(Effect.asVoid),
    ),
    normalize: Effect.fn("WorktreeCloneNative.normalize")(
      function* (root, changes, metadataTemplateRoot) {
        if (changes.length === 0) return [];
        const output = yield* run(
          metadataTemplateRoot === undefined
            ? ["normalize", root]
            : ["normalize", root, metadataTemplateRoot],
          changes.flatMap(({ name, kind, mode }) => [name, kind, String(mode)]),
        );
        const decoded = yield* decode(root, output, changes.length);
        const stats: Array<CloneStat> = [];
        for (const [stat] of decoded) {
          if (stat === null) return yield* error(root, "Missing normalized file metadata.");
          stats.push(stat);
        }
        return stats;
      },
    ),
  });
});
