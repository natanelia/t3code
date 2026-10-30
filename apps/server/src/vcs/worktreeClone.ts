// @effect-diagnostics nodeBuiltinImport:off - Effect's file stats lose the nanoseconds needed to detect source edits during a clone.
import * as NodeFS from "node:fs";
import { GitCommandError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import type * as GitVcsDriver from "./GitVcsDriver.ts";
import { withCloneIndexStats } from "./cloneIndexStats.ts";

type Execute = GitVcsDriver.GitVcsDriver["Service"]["execute"];

export const clearWorktreeCloneFlags = Effect.fn("WorktreeClone.clearFlags")(function* (
  worktreePath: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make("/usr/bin/chflags", ["-R", "-P", "-x", "0", worktreePath]),
      );
      yield* Effect.all(
        [child.exitCode, Stream.runDrain(child.stdout), Stream.runDrain(child.stderr)],
        { concurrency: "unbounded" },
      );
    }),
  ).pipe(Effect.timeoutOption("30 seconds"), Effect.ignore);
});

export const readWorktreeCloneFiles = Effect.fn("WorktreeClone.readTree")(function* (input: {
  readonly cwd: string;
  readonly treeId: string;
  readonly execute: Execute;
}) {
  const path = yield* Path.Path;
  const tree = yield* input.execute({
    operation: "GitVcsDriver.createWorktree.cloneTree",
    cwd: input.cwd,
    args: ["ls-tree", "--full-tree", "-r", "-l", "-z", input.treeId, "--"],
    maxOutputBytes: 16 * 1024 * 1024,
  });
  const files = tree.stdout.split("\0").flatMap((record) => {
    const match = /^(100644|100755|120000) blob ([a-f0-9]+) +([0-9]+)\t([\s\S]+)$/.exec(record);
    if (!match) return [];
    const name = match[4]!;
    if (path.basename(name) === ".gitattributes") return [];
    if (name.split("/").some((part) => part === ".." || part.toLowerCase() === ".git")) return [];
    return [
      {
        name,
        oid: match[2]!,
        size: Number(match[3]),
        executable: match[1] === "100755",
        symlink: match[1] === "120000",
      },
    ];
  });
  return files.length === 0 ? null : files;
});

export const planWorktreeClone = Effect.fn("WorktreeClone.plan")(
  function* (input: {
    readonly cwd: string;
    readonly refName: string;
    readonly execute: Execute;
    readonly filesForTree: (
      treeId: string,
    ) => Effect.Effect<Effect.Success<ReturnType<typeof readWorktreeCloneFiles>>, GitCommandError>;
  }) {
    if ((yield* HostProcess.Platform) !== "darwin") return null;
    const environment = yield* HostProcess.Environment;
    if (
      ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"].some(
        (key) => environment[key] !== undefined,
      )
    )
      return null;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const execute = (args: ReadonlyArray<string>, allowNonZeroExit = false) =>
      input.execute({
        operation: "GitVcsDriver.createWorktree.planClone",
        cwd: input.cwd,
        args,
        allowNonZeroExit,
        maxOutputBytes: 16 * 1024 * 1024,
      });
    const config = yield* execute(
      [
        "config",
        "--null",
        "--get-regexp",
        "^(core\\.(sparsecheckout|autocrlf|eol|fsmonitor)|extensions\\.(worktreeconfig|partialclone|objectformat)|remote\\..*\\.promisor)$",
      ],
      true,
    );
    if (config.exitCode !== 0 && config.exitCode !== 1) return null;
    for (const record of config.stdout.split("\0").filter(Boolean)) {
      const [key, value] = record.split("\n");
      if (key === "core.eol" ? value !== "lf" && value !== "native" : value !== "false")
        return null;
    }
    const treeId = (yield* execute([
      "rev-parse",
      "--verify",
      `${input.refName}^{tree}`,
    ])).stdout.trim();
    const files = yield* input.filesForTree(treeId);
    if (files === null) return null;
    const root = (yield* execute(["rev-parse", "--show-toplevel"])).stdout.slice(0, -1);
    const gitDir = (yield* execute(["rev-parse", "--absolute-git-dir"])).stdout.slice(0, -1);
    const hook = (yield* execute([
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "hooks/post-checkout",
    ])).stdout.slice(0, -1);
    // Worktree add can run a source-side hook even when its relative path is ignored.
    if (yield* fs.exists(path.resolve(root, hook))) return null;
    const hooksConfig = yield* execute(["config", "--path", "--get", "core.hooksPath"], true);
    if (hooksConfig.exitCode !== 0 && hooksConfig.exitCode !== 1) return null;
    const hooksPath = hooksConfig.stdout.slice(0, -1);
    if (hooksConfig.exitCode === 0 && !path.isAbsolute(hooksPath)) {
      const normalized = path.normalize(hooksPath);
      if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) return null;
      // Post-index hooks resolve in the new worktree, where ignored wrappers are absent.
      // Tracked hooks (including symlinked hook directories) still belong to Git.
      const hooks = ["post-checkout", "post-index-change"].map((name) =>
        path.join(normalized, name).replaceAll(path.sep, "/").normalize("NFC").toLowerCase(),
      );
      if (
        files.some((file) =>
          hooks.some((name) => {
            const fileName = file.name.normalize("NFC").toLowerCase();
            return fileName === name || (file.symlink && name.startsWith(`${fileName}/`));
          }),
        )
      )
        return null;
    } else {
      // Let worktree add own hook invocation, including its zero old-HEAD argument.
      if (yield* fs.exists(path.join(path.dirname(hook), "post-index-change"))) return null;
    }
    return { root, gitDir, treeId, files };
  },
  Effect.orElseSucceed(() => null),
);

const planCloneCopies = Effect.fn("WorktreeClone.planCopies")(function* (
  root: string,
  names: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const children = new Map<string, Set<string>>([[".", new Set()]]);
  const files = new Map<string, Array<string>>();
  for (const name of names) {
    const directory = path.dirname(name);
    const entries = files.get(directory) ?? [];
    entries.push(name);
    files.set(directory, entries);
    let current = name;
    while (current !== ".") {
      const parent = path.dirname(current);
      const entries = children.get(parent) ?? new Set<string>();
      entries.add(path.basename(current));
      children.set(parent, entries);
      current = parent;
    }
  }
  const directories = new Map<string, Array<string>>();
  for (const directory of children.keys()) {
    if (directory === ".") continue;
    const parent = path.dirname(directory);
    const entries = directories.get(parent) ?? [];
    entries.push(directory);
    directories.set(parent, entries);
  }
  const snapshots = new Map(
    yield* Effect.forEach(
      children,
      ([directory, expected]) =>
        Effect.gen(function* () {
          const source = path.join(root, directory);
          const stat = yield* Effect.tryPromise(() =>
            NodeFS.promises.lstat(source, { bigint: true }),
          );
          if (!stat.isDirectory())
            return yield* new GitCommandError({
              operation: "GitVcsDriver.createWorktree.planCopies",
              command: "cp",
              cwd: root,
              detail: "The source directory changed while planning the copy.",
            });
          const actual = yield* fs.readDirectory(source);
          return [
            directory,
            {
              stat,
              complete:
                actual.length === expected.size && actual.every((name) => expected.has(name)),
            },
          ] as const;
        }),
      { concurrency: 16 },
    ),
  );
  const counts = new Map<string, number>();
  for (const directory of [...children.keys()].sort((a, b) => b.length - a.length)) {
    const nested = directories.get(directory) ?? [];
    const snapshot = snapshots.get(directory)!;
    snapshots.set(directory, {
      ...snapshot,
      complete: snapshot.complete && nested.every((name) => snapshots.get(name)!.complete),
    });
    counts.set(
      directory,
      (files.get(directory)?.length ?? 0) +
        nested.reduce((total, name) => total + counts.get(name)!, 0),
    );
  }
  const copies: Array<{ readonly name: string; readonly count: number }> = [];
  const visit = (directory: string): void => {
    const count = counts.get(directory)!;
    if (directory !== "." && snapshots.get(directory)!.complete && count <= 512) {
      copies.push({ name: directory, count });
      return;
    }
    for (const name of files.get(directory) ?? []) copies.push({ name, count: 1 });
    for (const name of directories.get(directory) ?? []) visit(name);
  };
  visit(".");
  return { copies, snapshots, children };
});

export const seedWorktreeClone = Effect.fn("WorktreeClone.seed")(function* (input: {
  readonly plan: NonNullable<Effect.Success<ReturnType<typeof planWorktreeClone>>>;
  readonly worktreePath: string;
  readonly execute: Execute;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const { plan, worktreePath } = input;
  const execute = (
    args: ReadonlyArray<string>,
    options: { stdin?: string; allowNonZeroExit?: boolean; maxOutputBytes?: number } = {},
  ) =>
    input.execute({
      operation: "GitVcsDriver.createWorktree.seedClone",
      cwd: worktreePath,
      args,
      env: {
        GIT_DIR: path.join(worktreePath, ".git"),
        GIT_WORK_TREE: worktreePath,
        GIT_INDEX_FILE: undefined,
        GIT_COMMON_DIR: undefined,
      },
      ...options,
    });
  const sourceDevice = (yield* fs.stat(plan.root)).dev;
  if (sourceDevice !== (yield* fs.stat(worktreePath)).dev) return false;
  const apfs = yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(ChildProcess.make("/bin/df", ["-T", "apfs", plan.root]));
      const [code] = yield* Effect.all(
        [child.exitCode, Stream.runDrain(child.stdout), Stream.runDrain(child.stderr)],
        { concurrency: "unbounded" },
      );
      return code === 0;
    }),
  ).pipe(
    Effect.timeoutOption("5 seconds"),
    Effect.orElseSucceed(() => null),
  );
  if (apfs === null || apfs._tag === "None" || !apfs.value) return false;
  if ((yield* execute(["rev-parse", "HEAD^{tree}"])).stdout.trim() !== plan.treeId) return false;
  const indexPath = (yield* execute([
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "index",
  ])).stdout.slice(0, -1);
  const sourceExecute = (args: ReadonlyArray<string>, allowNonZeroExit = false) =>
    input.execute({
      operation: "GitVcsDriver.createWorktree.verifyCloneSource",
      cwd: plan.root,
      args: [
        "-c",
        "core.trustctime=true",
        "-c",
        "core.checkStat=default",
        "-c",
        "core.ignorestat=false",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      env: {
        GIT_DIR: plan.gitDir,
        GIT_WORK_TREE: plan.root,
        GIT_INDEX_FILE: indexPath,
        GIT_COMMON_DIR: undefined,
      },
      allowNonZeroExit,
      maxOutputBytes: 16 * 1024 * 1024,
    });
  const stat = (file: string) =>
    Effect.tryPromise(() => NodeFS.promises.lstat(file, { bigint: true }));
  const unusable = new GitCommandError({
    operation: "GitVcsDriver.createWorktree.seedClone",
    command: "cp",
    cwd: worktreePath,
    detail: "The source checkout cannot be reused safely.",
  });
  const run = Effect.fn("WorktreeClone.run")(
    function* (command: ChildProcess.StandardCommand) {
      const child = yield* spawner.spawn(command);
      const [code, output] = yield* Effect.all(
        [
          child.exitCode,
          Stream.runCollect(Stream.decodeText(child.stdout)),
          Stream.runDrain(child.stderr),
        ],
        { concurrency: "unbounded" },
      );
      if (code !== 0) return yield* unusable;
      return output.join("");
    },
    Effect.scoped,
    Effect.timeout("30 seconds"),
  );
  const checkFlags = Effect.fn("WorktreeClone.checkFlags")(function* (
    paths: ReadonlyArray<string>,
  ) {
    const batches: Array<ReadonlyArray<string>> = [];
    const encoder = new TextEncoder();
    let batch: Array<string> = [];
    let bytes = 0;
    for (const path of paths) {
      const size = encoder.encode(path).length + 1;
      // Leave room for the environment below macOS's 256 KiB argument limit.
      if (batch.length > 0 && bytes + size > 128 * 1024) {
        batches.push(batch);
        batch = [];
        bytes = 0;
      }
      batch.push(path);
      bytes += size;
    }
    if (batch.length > 0) batches.push(batch);
    yield* Effect.forEach(
      batches,
      (batch) =>
        Effect.gen(function* () {
          const output = yield* run(ChildProcess.make("/usr/bin/stat", ["-f", "%f", ...batch]));
          const flags = output.trim().split("\n").map(Number);
          // Removing compression metadata corrupts data; system flags require elevated rights.
          if (
            flags.length !== batch.length ||
            flags.some(
              (flag) =>
                !Number.isSafeInteger(flag) ||
                flag < 0 ||
                flag > 0xffffffff ||
                (flag & 0xffff0020) !== 0,
            )
          )
            return yield* unusable;
        }),
      { concurrency: 4, discard: true },
    );
  });
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const sourceIndex = (yield* input.execute({
        operation: "GitVcsDriver.createWorktree.cloneIndexPath",
        cwd: plan.root,
        args: ["rev-parse", "--path-format=absolute", "--git-path", "index"],
        env: {
          GIT_DIR: plan.gitDir,
          GIT_WORK_TREE: plan.root,
          GIT_INDEX_FILE: undefined,
          GIT_COMMON_DIR: undefined,
        },
      })).stdout.slice(0, -1);
      yield* fs.copyFile(sourceIndex, indexPath);
      const sourceIndexBytes = yield* fs.readFile(indexPath);
      if (
        plan.files.some((file) => file.oid.length !== 40) ||
        withCloneIndexStats(sourceIndexBytes, new Map()) === null
      )
        return yield* unusable;
      const flags = (yield* sourceExecute(["ls-files", "-v", "-z"])).stdout;
      if (flags.split("\0").some((entry) => entry !== "" && !entry.startsWith("H ")))
        return yield* unusable;
      const commit = (yield* execute(["rev-parse", "HEAD"])).stdout.trim();
      if (
        (yield* sourceExecute(
          ["diff-index", "--cached", "--quiet", "--no-ext-diff", "--no-textconv", commit, "--"],
          true,
        )).exitCode !== 0
      )
        return yield* unusable;
      const attributes = (yield* execute(
        [
          "check-attr",
          "--cached",
          "-z",
          "--stdin",
          "filter",
          "ident",
          "working-tree-encoding",
          "eol",
          "text",
          "crlf",
        ],
        {
          stdin: plan.files.map((file) => `${file.name}\0`).join(""),
          maxOutputBytes: 64 * 1024 * 1024,
        },
      )).stdout.split("\0");
      const excluded = new Set<string>();
      const autoText = new Set<string>();
      const explicitEol = new Set<string>();
      for (let i = 0; i + 2 < attributes.length; i += 3) {
        const value = attributes[i + 2];
        const name = attributes[i]!;
        const attribute = attributes[i + 1];
        if (attribute === "text" && value === "auto") {
          autoText.add(name);
          continue;
        }
        if (attribute === "eol" && value === "lf") {
          explicitEol.add(name);
          continue;
        }
        if (attribute === "eol" ? value === "crlf" : value !== "unspecified" && value !== "unset") {
          excluded.add(attributes[i]!);
        }
      }
      for (const name of explicitEol) if (!autoText.has(name)) excluded.add(name);
      const filesByName = new Map(plan.files.map((file) => [file.name, file]));
      const sourceStats = new Map<string, NodeFS.BigIntStats>();
      yield* Effect.forEach(
        plan.files,
        (file) =>
          Effect.gen(function* () {
            if (excluded.has(file.name)) return;
            const info = yield* stat(path.join(plan.root, file.name)).pipe(Effect.option);
            if (
              info._tag === "None" ||
              (file.symlink ? !info.value.isSymbolicLink() : !info.value.isFile()) ||
              info.value.dev !== BigInt(sourceDevice) ||
              Number(info.value.size) !== file.size
            )
              return;
            sourceStats.set(file.name, info.value);
          }),
        { concurrency: 16, discard: true },
      );
      if (sourceStats.size === 0) return false;
      // The private index proves the source is clean without trusting assume-unchanged or fsmonitor flags.
      if ((yield* sourceExecute(["update-index", "--refresh"], true)).exitCode !== 0)
        return yield* unusable;
      const clones = new Map<
        string,
        {
          readonly oid: string;
          readonly source: NodeFS.BigIntStats;
          readonly stat: NodeFS.BigIntStats;
        }
      >();
      for (const file of plan.files) {
        const source = sourceStats.get(file.name);
        if (source) clones.set(file.name, { oid: file.oid, source, stat: source });
      }
      if (withCloneIndexStats(yield* fs.readFile(indexPath), clones) === null)
        return yield* unusable;
      clones.clear();
      // A clean source with the blob's size cannot contain extra CRs from auto-text conversion.
      // Keep LF text as clones too, rather than making Git rewrite every source file.
      const staging = yield* Effect.acquireRelease(
        fs.makeTempDirectory({
          directory: path.dirname(worktreePath),
          prefix: ".t3-worktree-clone-",
        }),
        (directory) =>
          clearWorktreeCloneFlags(directory).pipe(
            Effect.andThen(fs.remove(directory, { recursive: true, force: true })),
            Effect.orDie,
          ),
      );
      if ((yield* fs.stat(staging)).dev !== sourceDevice) return yield* unusable;
      const { copies, snapshots, children } = yield* planCloneCopies(plan.root, [
        ...sourceStats.keys(),
      ]);
      const paths = [...sourceStats.keys(), ...snapshots.keys()];
      yield* checkFlags(paths.map((name) => path.join(plan.root, name)));
      const groups = new Map<string, typeof copies>();
      for (const copy of copies) {
        const directory = path.dirname(copy.name);
        const group = groups.get(directory) ?? [];
        group.push(copy);
        groups.set(directory, group);
      }
      const batches: Array<{ directory: string; names: Array<string> }> = [];
      for (const [directory, entries] of groups) {
        let names: Array<string> = [];
        let count = 0;
        for (const entry of entries) {
          if (names.length >= 64 || count + entry.count > 512) {
            batches.push({ directory, names });
            names = [];
            count = 0;
          }
          names.push(entry.name);
          count += entry.count;
        }
        if (names.length > 0) batches.push({ directory, names });
      }
      yield* Effect.forEach(
        batches,
        ({ directory, names }) =>
          Effect.gen(function* () {
            const destination = path.join(staging, directory);
            yield* fs.makeDirectory(destination, { recursive: true });
            // Node's forced reflink API returns ENOSYS on macOS; cp calls clonefile(2).
            yield* run(
              ChildProcess.make("/bin/cp", [
                "-cRP",
                ...names.map((name) => path.join(plan.root, name)),
                destination,
              ]),
            );
          }),
        { concurrency: 8, discard: true },
      );
      // Validate before publishing or following any staged path for permission changes.
      // Source directory races may otherwise bring ignored files or replacement symlinks along.
      yield* Effect.forEach(
        snapshots,
        ([name, before]) =>
          Effect.gen(function* () {
            const after = yield* stat(path.join(plan.root, name));
            const directory = path.join(staging, name);
            if (
              before.stat.ino !== after.ino ||
              before.stat.dev !== after.dev ||
              before.stat.ctimeNs !== after.ctimeNs ||
              before.stat.mtimeNs !== after.mtimeNs ||
              !(yield* stat(directory)).isDirectory()
            ) {
              return yield* unusable;
            }
            const expected = children.get(name)!;
            const actual = yield* fs.readDirectory(directory);
            if (actual.length !== expected.size || actual.some((entry) => !expected.has(entry))) {
              return yield* unusable;
            }
          }),
        { concurrency: 16, discard: true },
      );
      yield* Effect.forEach(
        sourceStats,
        ([name, before]) =>
          Effect.gen(function* () {
            const after = yield* stat(path.join(plan.root, name));
            const cloned = yield* stat(path.join(staging, name));
            const file = filesByName.get(name)!;
            if (
              before.ino !== after.ino ||
              before.dev !== after.dev ||
              before.size !== after.size ||
              before.mode !== after.mode ||
              before.mtimeNs !== after.mtimeNs ||
              before.ctimeNs !== after.ctimeNs ||
              (file.symlink ? !cloned.isSymbolicLink() : !cloned.isFile()) ||
              (!file.symlink && cloned.mtimeNs !== before.mtimeNs) ||
              cloned.size !== before.size
            ) {
              return yield* unusable;
            }
          }),
        { concurrency: 16, discard: true },
      );
      yield* checkFlags(paths.map((name) => path.join(staging, name)));
      yield* run(ChildProcess.make("/usr/bin/chflags", ["-R", "-P", "-x", "0", staging]));
      // Do not carry quarantine, resource forks or source directory permissions into the checkout.
      yield* run(ChildProcess.make("/usr/bin/xattr", ["-crs", staging]));
      const umask = process.umask();
      yield* Effect.forEach(
        [...snapshots.keys()].filter((name) => name !== "."),
        (name) => fs.chmod(path.join(staging, name), 0o777 & ~umask),
        { concurrency: 16, discard: true },
      );
      yield* Effect.forEach(
        sourceStats.keys(),
        (name) => {
          const file = filesByName.get(name)!;
          return file.symlink
            ? Effect.void
            : fs.chmod(path.join(staging, name), (file.executable ? 0o777 : 0o666) & ~umask);
        },
        { concurrency: 16, discard: true },
      );
      yield* Effect.forEach(
        yield* fs.readDirectory(staging),
        (name) => fs.rename(path.join(staging, name), path.join(worktreePath, name)),
        { concurrency: 16, discard: true },
      );
      yield* Effect.forEach(
        sourceStats,
        ([name, before]) =>
          Effect.gen(function* () {
            const after = yield* stat(path.join(plan.root, name));
            const cloned = yield* stat(path.join(worktreePath, name)).pipe(Effect.option);
            if (
              before.ino !== after.ino ||
              before.dev !== after.dev ||
              before.size !== after.size ||
              before.mode !== after.mode ||
              before.mtimeNs !== after.mtimeNs ||
              before.ctimeNs !== after.ctimeNs
            )
              return yield* unusable;
            const file = filesByName.get(name)!;
            // cp recreates symlinks, so their timestamps need not match the source.
            if (
              cloned._tag === "Some" &&
              ((!file.symlink && cloned.value.mtimeNs !== before.mtimeNs) ||
                cloned.value.size !== before.size)
            )
              return yield* unusable;
            if (cloned._tag === "Some" && file)
              clones.set(name, { oid: file.oid, source: before, stat: cloned.value });
          }),
        { concurrency: 16, discard: true },
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const lock = `${indexPath}.lock`;
          yield* Effect.acquireRelease(fs.writeFileString(lock, "", { flag: "wx" }), () =>
            fs.remove(lock, { force: true }).pipe(Effect.ignore),
          );
          const index = yield* fs.readFile(indexPath);
          const checksum = yield* crypto.digest("SHA-1", index.subarray(0, -20));
          if (!checksum.every((byte, position) => byte === index[index.length - 20 + position]))
            return yield* unusable;
          const updated = withCloneIndexStats(index, clones);
          if (updated === null) return yield* unusable;
          updated.set(yield* crypto.digest("SHA-1", updated.subarray(0, -20)), updated.length - 20);
          yield* fs.writeFile(lock, updated);
          yield* fs.rename(lock, indexPath);
        }),
      );
      return true;
    }),
  ).pipe(
    Effect.catch(() =>
      Effect.gen(function* () {
        yield* clearWorktreeCloneFlags(worktreePath);
        yield* Effect.forEach(
          (yield* fs.readDirectory(worktreePath)).filter((name) => name !== ".git"),
          (name) => fs.remove(path.join(worktreePath, name), { recursive: true, force: true }),
          { concurrency: 4, discard: true },
        );
        yield* fs.remove(indexPath, { force: true });
        return false;
      }),
    ),
  );
});
