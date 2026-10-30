// @effect-diagnostics nodeBuiltinImport:off - Linux/Windows emulate the native metadata protocol with real nanosecond file stats.
import * as NodeFS from "node:fs";
import { GitCommandError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  makeWorktreeCloneNative,
  type CloneStat,
  type WorktreeCloneNative,
} from "./worktreeCloneNative.ts";

export const makeNativeCloneForTests = Effect.fn("test.makeNativeCloneForTests")(function* () {
  if ((yield* HostProcess.Platform) === "darwin") return yield* makeWorktreeCloneNative();
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const failure = () =>
    new GitCommandError({
      operation: "test.nativeClone",
      command: "native-clone",
      cwd: "",
      detail: "Native clone emulation failed.",
    });
  const stat = (root: string, name: string) =>
    Effect.tryPromise({
      try: async (): Promise<CloneStat | null> => {
        const info = await NodeFS.promises
          .lstat(path.join(root, name), { bigint: true })
          .catch(() => null);
        if (info === null) return null;
        return {
          dev: info.dev,
          ino: info.ino,
          mode: Number(info.mode),
          uid: info.uid,
          gid: info.gid,
          size: info.size,
          mtimeNs: info.mtimeNs,
          ctimeNs: info.ctimeNs,
          flags: 0,
          xattrs: 0,
          kind: info.isFile()
            ? "file"
            : info.isDirectory()
              ? "directory"
              : info.isSymbolicLink()
                ? "symlink"
                : "other",
        };
      },
      catch: failure,
    });
  const native: WorktreeCloneNative["Service"] = {
    available: Effect.succeed(true),
    inspect: (root, names, otherRoot) =>
      Effect.forEach(names, (name) =>
        Effect.gen(function* () {
          return [
            yield* stat(root, name),
            otherRoot === undefined ? null : yield* stat(otherRoot, name),
          ] as const;
        }),
      ),
    clone: (root, destination, names) =>
      Effect.forEach(names, (name) =>
        Effect.gen(function* () {
          const target = path.join(destination, name);
          yield* fs.makeDirectory(path.dirname(target), { recursive: true });
          yield* fs.copy(path.join(root, name), target, { preserveTimestamps: true });
        }),
      ).pipe(Effect.asVoid, Effect.mapError(failure)),
    normalize: (root, changes) =>
      Effect.forEach(changes, (entry) =>
        Effect.gen(function* () {
          if (entry.kind !== "l")
            yield* fs.chmod(path.join(root, entry.name), entry.mode).pipe(Effect.mapError(failure));
          const result = yield* stat(root, entry.name);
          if (result === null) return yield* failure();
          return result;
        }),
      ),
  };
  return native;
});
