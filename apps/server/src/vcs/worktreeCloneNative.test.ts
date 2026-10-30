import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { makeWorktreeCloneNative } from "./worktreeCloneNative.ts";

const xattr = Effect.fn("test.xattr")(function* (args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make("/usr/bin/xattr", [...args]));
  const [code, output] = yield* Effect.all(
    [
      child.exitCode,
      Stream.runCollect(Stream.decodeText(child.stdout)),
      Stream.runDrain(child.stderr),
    ],
    { concurrency: "unbounded" },
  );
  return { code, output: output.join("").trim() };
}, Effect.scoped);

it.layer(NodeServices.layer)("macOS native worktree copies", (it) => {
  it.effect.each(["../outside", ".git/config", "nested/.Git/index", "/absolute", "."])(
    "rejects the entire copy request before writing a forbidden path: %s",
    (forbidden) =>
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) !== "darwin") return;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "native-clone-" });
        const source = path.join(root, "source");
        const target = path.join(root, "target");
        yield* fs.makeDirectory(source);
        yield* fs.makeDirectory(target);
        yield* fs.writeFileString(path.join(source, "safe"), "tracked");
        const native = yield* makeWorktreeCloneNative();
        assert.isTrue(yield* native.available);
        assert.isTrue(
          Result.isFailure(
            yield* native.clone(source, target, ["safe", forbidden]).pipe(Effect.result),
          ),
        );
        assert.deepEqual(yield* fs.readDirectory(target), []);
        assert.equal(yield* fs.readFileString(path.join(source, "safe")), "tracked");
      }),
  );

  it.effect("rejects extra private paths before changing any metadata", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) !== "darwin") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "native-inventory-" });
      yield* fs.writeFileString(path.join(root, "safe"), "tracked", { mode: 0o600 });
      yield* fs.writeFileString(path.join(root, "ignored"), "private");
      const native = yield* makeWorktreeCloneNative();
      const result = yield* native
        .normalize(root, [
          { name: ".", kind: "d", mode: 0o700 },
          { name: "safe", kind: "f", mode: 0o644 },
        ])
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));
      assert.equal((yield* fs.stat(path.join(root, "safe"))).mode & 0o777, 0o600);
      assert.equal(yield* fs.readFileString(path.join(root, "ignored")), "private");
    }),
  );

  it.effect("breaks source hardlinks when cloning a directory", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) !== "darwin") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "native-hardlinks-" });
      const source = path.join(root, "source");
      const target = path.join(root, "target");
      yield* fs.makeDirectory(path.join(source, "assets"), { recursive: true });
      yield* fs.makeDirectory(target);
      yield* fs.writeFileString(path.join(source, "assets/a"), "tracked");
      yield* fs.link(path.join(source, "assets/a"), path.join(source, "assets/b"));
      const native = yield* makeWorktreeCloneNative();
      yield* native.clone(source, target, ["assets"]);
      const copied = yield* native.inspect(target, ["assets/a", "assets/b"]);
      assert.notEqual(copied[0]![0]!.ino, copied[1]![0]!.ino);
      yield* fs.writeFileString(path.join(target, "assets/a"), "branch edit");
      assert.equal(yield* fs.readFileString(path.join(target, "assets/b")), "tracked");
      assert.equal(yield* fs.readFileString(path.join(source, "assets/a")), "tracked");
    }),
  );

  it.effect("keeps only the origin tag matching Git's fresh metadata template", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) !== "darwin") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "native-origin-" });
      const stage = path.join(root, "stage");
      const target = path.join(root, "target");
      yield* fs.makeDirectory(stage);
      yield* fs.makeDirectory(target);
      const file = path.join(stage, "file");
      const template = path.join(target, ".git");
      yield* fs.writeFileString(file, "tracked");
      yield* fs.writeFileString(template, "gitdir: template\n");
      const before = yield* xattr(["-px", "com.apple.provenance", template]);
      assert.equal((yield* xattr(["-w", "com.t3code.private", "private", file])).code, 0);
      const native = yield* makeWorktreeCloneNative();
      const changes = [
        { name: ".", kind: "d", mode: 0o700 },
        { name: "file", kind: "f", mode: 0o644 },
      ] as const;
      const first = yield* native.normalize(stage, changes, target);
      assert.notEqual((yield* xattr(["-p", "com.t3code.private", file])).code, 0);
      assert.deepEqual(yield* xattr(["-px", "com.apple.provenance", file]), before);
      assert.deepEqual(yield* xattr(["-px", "com.apple.provenance", template]), before);
      yield* fs.remove(template);
      const second = yield* native.normalize(stage, changes, target);
      // macOS may regenerate an origin tag. Without a template the inherited
      // attribute must still be removed, which changes the file's ctime.
      if (before.code === 0) assert.notEqual(second[1]!.ctimeNs, first[1]!.ctimeNs);
      assert.equal(yield* fs.readFileString(file), "tracked");
      assert.isFalse(yield* fs.exists(template));
    }),
  );

  it.effect("returns final stat fingerprints that survive moving their ancestor", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) !== "darwin") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "native-stats-" });
      const stage = path.join(root, "stage");
      const outside = path.join(root, "private");
      yield* fs.makeDirectory(path.join(stage, "nested"), { recursive: true });
      yield* fs.writeFileString(path.join(stage, "nested/file"), "tracked", { mode: 0o600 });
      yield* fs.writeFileString(path.join(stage, "empty"), "");
      yield* fs.writeFileString(outside, "untouched", { mode: 0o600 });
      yield* fs.symlink(outside, path.join(stage, "link"));
      const native = yield* makeWorktreeCloneNative();
      const before = yield* native.inspect(root, ["private"]);
      const changes = [
        { name: ".", kind: "d", mode: 0o700 },
        { name: "nested", kind: "d", mode: 0o755 },
        { name: "nested/file", kind: "f", mode: 0o644 },
        { name: "empty", kind: "f", mode: 0o644 },
        { name: "link", kind: "l", mode: 0 },
      ] as const;
      const stats = yield* native.normalize(stage, changes);
      assert.equal(stats[2]!.mode & 0o777, 0o644);
      assert.equal(stats[3]!.size, 0n);
      assert.equal(stats[4]!.kind, "symlink");
      assert.deepEqual(yield* native.inspect(root, ["private"]), before);
      const moved = path.join(root, "moved");
      yield* fs.rename(stage, moved);
      const inspected = yield* native.inspect(
        moved,
        changes.map((entry) => entry.name),
      );
      assert.deepEqual(inspected.map(([stat]) => stat).slice(1), stats.slice(1));
      assert.equal(yield* fs.readFileString(outside), "untouched");
    }),
  );
});
