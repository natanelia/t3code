# macOS worktree copying

This helper uses APFS directory and file clones to prepare tracked files in a
private staging directory. Git still owns worktree registration, the index, and
the final checkout. It is not a separate worktree backend.

The server checks Git's source cache against exact nanosecond file fingerprints
before publishing any copied files. It also checks source directory identities
and timestamps. The helper checks the entire staged inventory before cleaning
metadata, never follows symlink targets during cleanup, and rejects compressed
or system-flagged files. Unsupported operations fall back to Git.

Directory clones are deliberately restricted to complete tracked-only subtrees.
The source checkout itself, `.git`, dependencies, and ignored files are not
cloned as a whole. This relies on APFS's directory-clone support rather than
`copyfile`'s recursive per-file implementation. Source races still require the
checks above. Provisioning assumes exclusive ownership of the new worktree and
its private staging directory, as ordinary Git checkout does.

## Metadata

Inherited extended attributes are removed. The only exception is a regular
file's `com.apple.provenance` value when it is byte-identical to that on the
fresh `.git` file Git just created in the destination. This keeps an opaque
OS-applied value already present on new Git files, not arbitrary source origin
metadata. Missing, oversized, or different values are not retained. Symlink and
directory attributes receive no exception. File modes come from the target Git
tree and the current umask.

Normalization returns final file stats. Moving an ancestor directory does not
change its files' fingerprints, so only root-level files need another stat after
publication. The driver repairs the target index under its lock and lets Git
finish the checkout.

## Build and fallback

`scripts/lib/worktree-clone-build.ts` builds arm64, x64, or universal helpers on
macOS. The server package, CLI archive, and desktop builders include the binary.
CLI signing includes it. Packaged applications never invoke a compiler.
Source-tree development builds compile it into the ignored `build/` directory
on first use, or after `main.c` changes. A missing compiler or helper uses Git.

The internal protocol takes NUL-delimited paths, or path/kind/mode triples for
normalization. It returns versioned JSON stat records with decimal strings to
preserve 64-bit integers. Input is bounded to 64 MiB and 200,000 records. Paths
must be relative and cannot contain traversal or case-insensitive `.git`
components. Copying `.` is forbidden. Normalization may additionally read the
new target's `.git` origin attribute, without copying or changing that file.

Native behavior tests are in
`apps/server/src/vcs/worktreeCloneNative.test.ts`. Driver tests cover clean
checkout behavior, source edits and races, symlinks, hooks, fallback, and
rollback. Other platforms emulate the metadata protocol for those driver tests;
they do not exercise APFS.
