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

// Small files cost more to clone and verify than to check out from Git's object store.
const MIN_FILE_BYTES = 1024 * 1024;
const MIN_TOTAL_BYTES = 16 * MIN_FILE_BYTES;
const MAX_CLONE_FILES = 4096;

export const clearWorktreeCloneFlags = Effect.fn("WorktreeClone.clearFlags")(function* (
  worktreePath: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make("/usr/bin/chflags", ["-R", "-P", "-h", "-x", "0", worktreePath]),
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
  let totalBytes = 0;
  const files = tree.stdout.split("\0").flatMap((record) => {
    const match = /^(100644|100755) blob ([a-f0-9]+) +([0-9]+)\t([\s\S]+)$/.exec(record);
    if (!match) return [];
    totalBytes += Number(match[3]);
    if (Number(match[3]) < MIN_FILE_BYTES) return [];
    const name = match[4]!;
    if (path.basename(name) === ".gitattributes") return [];
    if (name.split("/").some((part) => part === ".." || part.toLowerCase() === ".git")) return [];
    return [{ name, oid: match[2]!, size: Number(match[3]), executable: match[1] === "100755" }];
  });
  const cloneBytes = files.reduce((total, file) => total + file.size, 0);
  // Metadata-heavy checkouts do not amortize the extra index verification.
  return files.length > MAX_CLONE_FILES ||
    cloneBytes < MIN_TOTAL_BYTES ||
    cloneBytes * 2 < totalBytes
    ? null
    : files;
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
        "^(core\\.(sparsecheckout|autocrlf|eol|hookspath|fsmonitor)|extensions\\.(worktreeconfig|partialclone|objectformat)|remote\\..*\\.promisor)$",
      ],
      true,
    );
    if (config.exitCode !== 0 && config.exitCode !== 1) return null;
    for (const record of config.stdout.split("\0").filter(Boolean)) {
      const [key, value] = record.split("\n");
      if (
        key === "core.hookspath" ||
        (key === "core.eol" ? value !== "lf" && value !== "native" : value !== "false")
      )
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
    const hook = (yield* execute([
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "hooks/post-checkout",
    ])).stdout.slice(0, -1);
    // Let worktree add own hook invocation, including its zero old-HEAD argument.
    if (yield* fs.exists(path.resolve(root, hook))) return null;
    if (yield* fs.exists(path.join(path.dirname(hook), "post-index-change"))) return null;
    return { root, files };
  },
  Effect.orElseSucceed(() => null),
);

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
    options: { stdin?: string; allowNonZeroExit?: boolean } = {},
  ) =>
    input.execute({
      operation: "GitVcsDriver.createWorktree.seedClone",
      cwd: worktreePath,
      args,
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
        ...args,
      ],
      env: { GIT_INDEX_FILE: indexPath },
      allowNonZeroExit,
      maxOutputBytes: 16 * 1024 * 1024,
    });
  const stat = (file: string) =>
    Effect.tryPromise(() => NodeFS.promises.stat(file, { bigint: true }));
  const unusable = new GitCommandError({
    operation: "GitVcsDriver.createWorktree.seedClone",
    command: "cp",
    cwd: worktreePath,
    detail: "The source checkout cannot be reused safely.",
  });
  return yield* Effect.gen(function* () {
    const sourceIndex = (yield* input.execute({
      operation: "GitVcsDriver.createWorktree.cloneIndexPath",
      cwd: plan.root,
      args: ["rev-parse", "--path-format=absolute", "--git-path", "index"],
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
      (yield* sourceExecute(["diff-index", "--cached", "--quiet", commit, "--"], true)).exitCode !==
      0
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
    const groups = new Map<string, typeof plan.files>();
    const filesByName = new Map(plan.files.map((file) => [file.name, file]));
    const sourceStats = new Map<string, NodeFS.BigIntStats>();
    for (const file of plan.files) {
      if (excluded.has(file.name)) continue;
      const info = yield* stat(path.join(plan.root, file.name)).pipe(Effect.option);
      if (
        info._tag === "None" ||
        !info.value.isFile() ||
        info.value.dev !== BigInt(sourceDevice) ||
        Number(info.value.size) !== file.size
      )
        continue;
      const directory = path.dirname(file.name);
      const group = groups.get(directory) ?? [];
      group.push(file);
      groups.set(directory, group);
      sourceStats.set(file.name, info.value);
    }
    if (groups.size === 0) return false;
    // The private index proves the source is clean without trusting assume-unchanged or fsmonitor flags.
    if ((yield* sourceExecute(["update-index", "-q", "--refresh"], true)).exitCode !== 0)
      return yield* unusable;
    yield* Effect.forEach(
      groups,
      ([directory, files]) =>
        Effect.gen(function* () {
          const destination = path.join(worktreePath, directory);
          yield* fs.makeDirectory(destination, { recursive: true });
          for (let offset = 0; offset < files.length; offset += 64) {
            const batch = files.slice(offset, offset + 64);
            const copied = yield* Effect.scoped(
              Effect.gen(function* () {
                // Node's COPYFILE_FICLONE_FORCE returns ENOSYS on macOS; cp uses clonefile(2).
                const commands = [
                  ChildProcess.make("/usr/bin/stat", [
                    "-f",
                    "%f",
                    ...batch.map((file) => path.join(plan.root, file.name)),
                  ]),
                  ChildProcess.make("/bin/cp", [
                    "-c",
                    ...batch.map((file) => path.join(plan.root, file.name)),
                    destination,
                  ]),
                  ChildProcess.make("/usr/bin/stat", [
                    "-f",
                    "%f",
                    ...batch.map((file) => path.join(worktreePath, file.name)),
                  ]),
                  ChildProcess.make("/usr/bin/chflags", [
                    "-h",
                    "0",
                    ...batch.map((file) => path.join(worktreePath, file.name)),
                  ]),
                  // Clones inherit xattrs, but a Git checkout must not inherit quarantine or resource forks.
                  ChildProcess.make("/usr/bin/xattr", [
                    "-c",
                    ...batch.map((file) => path.join(worktreePath, file.name)),
                  ]),
                ];
                let ok = true;
                for (const command of commands) {
                  const child = yield* spawner.spawn(command);
                  const [code, output] = yield* Effect.all(
                    [
                      child.exitCode,
                      Stream.runCollect(Stream.decodeText(child.stdout)),
                      Stream.runDrain(child.stderr),
                    ],
                    { concurrency: "unbounded" },
                  );
                  if (code !== 0) ok = false;
                  if (command.command === "/usr/bin/stat" && code === 0) {
                    const flags = output.join("").trim().split("\n").map(Number);
                    // Compression metadata is part of the data representation; system flags need elevated rights.
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
                      return false;
                  }
                }
                return ok;
              }),
            ).pipe(Effect.timeoutOption("30 seconds"));
            if (copied._tag === "None" || !copied.value) {
              return yield* new GitCommandError({
                operation: "GitVcsDriver.createWorktree.seedClone",
                command: "cp",
                cwd: worktreePath,
                detail: "Native worktree clone failed.",
              });
            }
            for (const file of batch) {
              const target = path.join(worktreePath, file.name);
              if (autoText.has(file.name)) {
                // Git's auto-text conversion leaves files with NUL in their first 8000 bytes untouched.
                const binary = yield* Effect.scoped(
                  Effect.gen(function* () {
                    const handle = yield* fs.open(target);
                    const bytes = yield* handle.readAlloc(8000);
                    return bytes._tag === "Some" && bytes.value.includes(0);
                  }),
                );
                if (!binary) {
                  yield* fs.remove(target);
                  continue;
                }
              }
              yield* fs.chmod(target, (file.executable ? 0o777 : 0o666) & ~process.umask());
            }
          }
        }),
      { concurrency: 4, discard: true },
    );
    const clones = new Map<string, { readonly oid: string; readonly stat: NodeFS.BigIntStats }>();
    for (const [name, before] of sourceStats) {
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
      if (
        cloned._tag === "Some" &&
        (cloned.value.mtimeNs !== before.mtimeNs || cloned.value.size !== before.size)
      )
        return yield* unusable;
      const file = filesByName.get(name);
      if (cloned._tag === "Some" && file) clones.set(name, { oid: file.oid, stat: cloned.value });
    }
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
  }).pipe(
    Effect.catch(() =>
      Effect.gen(function* () {
        yield* clearWorktreeCloneFlags(worktreePath);
        yield* Effect.forEach(
          input.plan.files,
          (file) => fs.remove(path.join(input.worktreePath, file.name), { force: true }),
          { concurrency: 4, discard: true },
        );
        yield* fs.remove(indexPath, { force: true });
        return false;
      }),
    ),
  );
});
