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
import type { CloneMetadataChange, CloneStat, WorktreeCloneNative } from "./worktreeCloneNative.ts";

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
    readonly native: WorktreeCloneNative["Service"];
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
        "--path",
        "--get-regexp",
        "^(core\\.(sparsecheckout|autocrlf|eol|fsmonitor|hookspath)|extensions\\.(worktreeconfig|partialclone|objectformat)|remote\\..*\\.promisor)$",
      ],
      true,
    );
    if (config.exitCode !== 0 && config.exitCode !== 1) return null;
    let hooksPath: string | undefined;
    for (const record of config.stdout.split("\0").filter(Boolean)) {
      const separator = record.indexOf("\n");
      if (separator < 0) return null;
      const key = record.slice(0, separator);
      const value = record.slice(separator + 1);
      if (key === "core.hookspath") {
        hooksPath = value;
        continue;
      }
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
    const [rootResult, gitDirResult, hookResult] = yield* Effect.all(
      [
        execute(["rev-parse", "--show-toplevel"]),
        execute(["rev-parse", "--absolute-git-dir"]),
        execute(["rev-parse", "--path-format=absolute", "--git-path", "hooks/post-checkout"]),
      ],
      { concurrency: 3 },
    );
    const root = rootResult.stdout.slice(0, -1);
    const gitDir = gitDirResult.stdout.slice(0, -1);
    const hook = hookResult.stdout.slice(0, -1);
    // Worktree add can run a source-side hook even when its relative path is ignored.
    if (yield* fs.exists(path.resolve(root, hook))) return null;
    if (hooksPath !== undefined && !path.isAbsolute(hooksPath)) {
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
    if (!(yield* input.native.available)) return null;
    return { root, gitDir, treeId, files };
  },
  Effect.orElseSucceed(() => null),
);

const planCloneCopies = Effect.fn("WorktreeClone.planCopies")(function* (
  root: string,
  names: ReadonlyArray<string>,
  native: WorktreeCloneNative["Service"],
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
  const directoryNames = [...children.keys()];
  const metadata = yield* native.inspect(root, directoryNames);
  const snapshots = new Map(
    yield* Effect.forEach(
      directoryNames,
      (directory, index) =>
        Effect.gen(function* () {
          const stat = metadata[index]![0];
          if (stat === null || stat.kind !== "directory")
            return yield* new GitCommandError({
              operation: "GitVcsDriver.createWorktree.planCopies",
              command: "t3-worktree-clone",
              cwd: root,
              detail: "The source directory changed while planning the copy.",
            });
          const expected = children.get(directory)!;
          const actual = yield* fs.readDirectory(path.join(root, directory));
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
  for (const directory of [...directoryNames].sort((a, b) => b.length - a.length)) {
    const snapshot = snapshots.get(directory)!;
    snapshots.set(directory, {
      ...snapshot,
      complete:
        snapshot.complete &&
        (directories.get(directory) ?? []).every((name) => snapshots.get(name)!.complete),
    });
  }
  const copies: Array<string> = [];
  const visit = (directory: string): void => {
    if (directory !== "." && snapshots.get(directory)!.complete) {
      copies.push(directory);
      return;
    }
    copies.push(...(files.get(directory) ?? []));
    for (const name of directories.get(directory) ?? []) visit(name);
  };
  visit(".");
  return { copies, snapshots, children };
});

function sameCloneSource(before: CloneStat, after: CloneStat): boolean {
  return (
    before.ino === after.ino &&
    before.dev === after.dev &&
    before.size === after.size &&
    before.mode === after.mode &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

export const seedWorktreeClone = Effect.fn("WorktreeClone.seed")(function* (input: {
  readonly plan: NonNullable<Effect.Success<ReturnType<typeof planWorktreeClone>>>;
  readonly worktreePath: string;
  readonly execute: Execute;
  readonly native: WorktreeCloneNative["Service"];
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const { plan, worktreePath, native } = input;
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
  const target = /^(?<tree>[a-f0-9]{40})\n(?<commit>[a-f0-9]{40})\n(?<index>[\s\S]+)\n$/.exec(
    (yield* execute([
      "rev-parse",
      "HEAD^{tree}",
      "HEAD",
      "--path-format=absolute",
      "--git-path",
      "index",
    ])).stdout,
  )?.groups;
  if (!target || target.tree !== plan.treeId) return false;
  const indexPath = target.index!;
  const commit = target.commit!;
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
  const unusable = new GitCommandError({
    operation: "GitVcsDriver.createWorktree.seedClone",
    command: "t3-worktree-clone",
    cwd: worktreePath,
    detail: "The source checkout cannot be reused safely.",
  });
  const safeFlags = (stat: CloneStat) => (stat.flags & 0xffff0020) === 0;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      // Planning rejected ambient index overrides. A linked worktree's private
      // index lives in its own Git directory, not the common Git directory.
      yield* fs.copyFile(path.join(plan.gitDir, "index"), indexPath);
      if (
        plan.files.some((file) => file.oid.length !== 40) ||
        withCloneIndexStats(yield* fs.readFile(indexPath), new Map()) === null
      )
        return yield* unusable;
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
        const name = attributes[i]!;
        const attribute = attributes[i + 1];
        const value = attributes[i + 2];
        if (attribute === "text" && value === "auto") {
          autoText.add(name);
          continue;
        }
        if (attribute === "eol" && value === "lf") {
          explicitEol.add(name);
          continue;
        }
        if (attribute === "eol" ? value === "crlf" : value !== "unspecified" && value !== "unset")
          excluded.add(name);
      }
      for (const name of explicitEol) if (!autoText.has(name)) excluded.add(name);
      const filesByName = new Map(plan.files.map((file) => [file.name, file]));
      const candidates = plan.files.filter((file) => !excluded.has(file.name));
      const fileNames = candidates.map((file) => file.name);
      const sourceStats = new Map<string, CloneStat>();
      if (fileNames.length === 0) return false;
      if ((yield* sourceExecute(["update-index", "--refresh"], true)).exitCode !== 0)
        return yield* unusable;
      const verifiedIndex = yield* fs.readFile(indexPath);
      const clones = new Map<
        string,
        { readonly oid: string; readonly source: CloneStat; readonly stat: CloneStat }
      >();
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
      const { copies, snapshots } = yield* planCloneCopies(plan.root, fileNames, native);
      for (const { stat } of snapshots.values()) if (!safeFlags(stat)) return yield* unusable;
      yield* native.clone(plan.root, staging, copies);
      const names = [...fileNames, ...snapshots.keys()];
      const copied = yield* native.inspect(plan.root, names, staging);
      const metadataChanges: Array<CloneMetadataChange> = [];
      const umask = process.umask();
      for (let i = 0; i < names.length; i++) {
        const name = names[i]!;
        const [after, target] = copied[i]!;
        if (after === null || target === null || !safeFlags(after) || !safeFlags(target))
          return yield* unusable;
        const source = after;
        const file = filesByName.get(name);
        if (file) {
          if (
            source.kind !== (file.symlink ? "symlink" : "file") ||
            source.dev !== BigInt(sourceDevice) ||
            source.size !== BigInt(file.size) ||
            target.kind !== source.kind ||
            (!file.symlink && target.mtimeNs !== source.mtimeNs) ||
            target.size !== source.size
          )
            return yield* unusable;
          sourceStats.set(name, source);
          clones.set(name, { oid: file.oid, source, stat: target });
        } else if (
          !sameCloneSource(snapshots.get(name)!.stat, source) ||
          target.kind !== "directory"
        )
          return yield* unusable;
        const kind = source.kind === "directory" ? "d" : source.kind === "symlink" ? "l" : "f";
        const mode =
          name === "."
            ? 0o700
            : kind === "d"
              ? 0o777 & ~umask
              : (file?.executable ? 0o777 : 0o666) & ~umask;
        // Clean inherited metadata in the same native pass instead of first
        // querying every source file's extended attributes.
        metadataChanges.push({ name, kind, mode });
      }
      // Match the copied files against Git's verified cache, including exact
      // nanosecond fingerprints. No source bytes are published before this check.
      if (withCloneIndexStats(verifiedIndex, clones) === null) return yield* unusable;
      // The native pass also rejects any unexpected staged paths before cleanup.
      const normalized = yield* native.normalize(staging, metadataChanges, worktreePath);
      const finalStats = new Map(
        metadataChanges.map((entry, index) => [entry.name, normalized[index]!]),
      );
      yield* Effect.forEach(
        yield* fs.readDirectory(staging),
        (name) => fs.rename(path.join(staging, name), path.join(worktreePath, name)),
        { concurrency: 16, discard: true },
      );
      // Moving an ancestor directory leaves its files' stat fingerprints intact.
      // Only root-level files are renamed themselves and need another stat call.
      const renamedFiles = fileNames.filter((name) => !name.includes("/"));
      const published = yield* native.inspect(worktreePath, renamedFiles);
      for (let i = 0; i < renamedFiles.length; i++) {
        const stat = published[i]![0];
        if (stat === null) return yield* unusable;
        finalStats.set(renamedFiles[i]!, stat);
      }
      for (let i = 0; i < fileNames.length; i++) {
        const name = fileNames[i]!;
        const source = sourceStats.get(name)!;
        const target = finalStats.get(name);
        const file = filesByName.get(name)!;
        if (
          target === undefined ||
          target.kind !== source.kind ||
          (!file.symlink && target.mtimeNs !== source.mtimeNs) ||
          target.size !== source.size
        )
          return yield* unusable;
        clones.set(name, { oid: file.oid, source, stat: target });
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const lock = `${indexPath}.lock`;
          yield* Effect.acquireRelease(fs.writeFileString(lock, "", { flag: "wx" }), () =>
            fs.remove(lock, { force: true }).pipe(Effect.ignore),
          );
          const index = yield* fs.readFile(indexPath);
          const checksum = yield* crypto.digest("SHA-1", index.subarray(0, -20));
          if (!checksum.every((byte, i) => byte === index[index.length - 20 + i]))
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
