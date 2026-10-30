#include <sys/clonefile.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/xattr.h>
#include <errno.h>
#include <fcntl.h>
#include <fts.h>
#include <inttypes.h>
#include <limits.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

enum { INSPECT, PAIR, STAT_ONLY, CLONE, NORMALIZE };
enum { MAX_INPUT_BYTES = 64 * 1024 * 1024, MAX_RECORDS = 200000, WORKERS = 8 };

struct info { struct stat stat; ssize_t xattrs; int present; };
static int operation, roots[2] = {-1, -1};
static const char *root_paths[2];
static char **tokens;
static size_t token_count, job_count;
static struct info *results;
static _Atomic size_t next_job;
static _Atomic int failed;
static const char origin_attribute[] = "com.apple.provenance";
static unsigned char default_origin[256];
static ssize_t default_origin_size;

static int valid_path(const char *path) {
    if (!strcmp(path, ".")) return 1;
    if (!path[0] || path[0] == '/') return 0;
    for (const char *start = path; *start;) {
        const char *end = strchr(start, '/');
        size_t size = end ? (size_t)(end - start) : strlen(start);
        if (!size || (size == 1 && start[0] == '.') ||
            (size == 2 && !memcmp(start, "..", 2)) ||
            (size == 4 && !strncasecmp(start, ".git", 4))) return 0;
        if (!end) return 1;
        start = end + 1;
        if (!*start) return 0;
    }
    return 1;
}

static int full_path(char output[PATH_MAX], const char *root, const char *name) {
    if (snprintf(output, PATH_MAX, "%s/%s", root, name) >= PATH_MAX) {
        errno = ENAMETOOLONG;
        return -1;
    }
    return 0;
}

/* Every parent is opened without following symlinks. The final component is
 * handled separately by clonefileat, openat, or a no-follow metadata call. */
static int parent_fd(int root, const char *name, int create) {
    int fd = dup(root);
    char path[PATH_MAX];
    if (fd < 0) return -1;
    if (strlen(name) >= sizeof(path)) { close(fd); errno = ENAMETOOLONG; return -1; }
    strcpy(path, name);
    char *last = strrchr(path, '/');
    if (!last) return fd;
    *last = '\0';
    if (!create) {
        int parent = openat(root, path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC);
        close(fd);
        return parent;
    }
    char *save = NULL;
    for (char *part = strtok_r(path, "/", &save); part; part = strtok_r(NULL, "/", &save)) {
        if (create && mkdirat(fd, part, 0777) != 0 && errno != EEXIST) { close(fd); return -1; }
        int next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        close(fd);
        if (next < 0) return -1;
        fd = next;
    }
    return fd;
}

static int inspect_path(int root, const char *root_path, const char *name, int attributes,
                        struct info *result) {
    if (fstatat(root, name, &result->stat, AT_SYMLINK_NOFOLLOW) != 0) {
        if (errno == ENOENT || errno == ENOTDIR) return 0;
        return -1;
    }
    result->present = 1;
    if (attributes) {
        char path[PATH_MAX];
        if (full_path(path, root_path, name) != 0) return -1;
        result->xattrs = listxattr(path, NULL, 0, XATTR_NOFOLLOW);
        if (result->xattrs < 0) return -1;
    }
    return 0;
}

static int remove_attributes(int fd, const char *link_path, int regular_file) {
    ssize_t size = fd >= 0 ? flistxattr(fd, NULL, 0, 0)
                           : listxattr(link_path, NULL, 0, XATTR_NOFOLLOW);
    if (size < 0) return -1;
    if (!size) return 0;
    if (size > MAX_INPUT_BYTES) { errno = EOVERFLOW; return -1; }
    char *names = malloc((size_t)size);
    if (!names) return -1;
    ssize_t actual = fd >= 0 ? flistxattr(fd, names, (size_t)size, 0)
                             : listxattr(link_path, names, (size_t)size, XATTR_NOFOLLOW);
    if (actual < 0) { free(names); return -1; }
    for (char *name = names; name < names + actual;) {
        size_t remaining = (size_t)(names + actual - name);
        size_t length = strnlen(name, remaining);
        if (length == remaining) { free(names); errno = EINVAL; return -1; }
        // Keep only an OS origin tag byte-identical to the one Git just put on
        // the new worktree's .git file. Never preserve other inherited metadata.
        if (regular_file && default_origin_size > 0 && !strcmp(name, origin_attribute)) {
            unsigned char origin[sizeof(default_origin)];
            ssize_t count = fgetxattr(fd, name, origin, sizeof(origin), 0, 0);
            if (count == default_origin_size && !memcmp(origin, default_origin, (size_t)count)) {
                name += length + 1;
                continue;
            }
        }
        int result = fd >= 0 ? fremovexattr(fd, name, 0)
                            : removexattr(link_path, name, XATTR_NOFOLLOW);
        if (result != 0) { free(names); return -1; }
        name += length + 1;
    }
    free(names);
    return 0;
}

static int normalize_path(const char *name, const char *kind, const char *permission, struct info *result) {
    char *end = NULL;
    errno = 0;
    unsigned long mode = strtoul(permission, &end, 10);
    if (errno || !permission[0] || *end || mode > 0777 || strlen(kind) != 1) {
        errno = EINVAL;
        return -1;
    }
    if (kind[0] == 'l') {
        int parent = parent_fd(roots[0], name, 0);
        if (parent < 0) return -1;
        const char *leaf = strrchr(name, '/');
        leaf = leaf ? leaf + 1 : name;
        struct stat stat;
        if (fstatat(parent, leaf, &stat, AT_SYMLINK_NOFOLLOW) != 0 ||
            !S_ISLNK(stat.st_mode) || (stat.st_flags & 0xffff0020u) != 0) { close(parent); return -1; }
        char path[PATH_MAX];
        int ok = full_path(path, root_paths[0], name) == 0 &&
            (!stat.st_flags || lchflags(path, 0) == 0) && remove_attributes(-1, path, 0) == 0 &&
            fstatat(parent, leaf, &result->stat, AT_SYMLINK_NOFOLLOW) == 0;
        close(parent);
        result->present = ok;
        return ok ? 0 : -1;
    }
    if (kind[0] != 'f' && kind[0] != 'd') { errno = EINVAL; return -1; }
    // Pin the file once for metadata cleanup and its final Git stat cache.
    // O_NONBLOCK prevents a concurrently replaced special file from hanging open.
    int fd = openat(roots[0], name, O_RDONLY | O_NOFOLLOW_ANY | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) return -1;
    struct stat stat;
    if (fstat(fd, &stat) != 0 || (stat.st_flags & 0xffff0020u) != 0 ||
        !((kind[0] == 'f' && S_ISREG(stat.st_mode)) || (kind[0] == 'd' && S_ISDIR(stat.st_mode)))) {
        close(fd); return -1;
    }
    int ok = (!stat.st_flags || fchflags(fd, 0) == 0) && remove_attributes(fd, NULL, kind[0] == 'f') == 0 &&
        (((stat.st_mode & 07777) == mode) || fchmod(fd, (mode_t)mode) == 0) &&
        fstat(fd, &result->stat) == 0;
    close(fd);
    result->present = ok;
    return ok ? 0 : -1;
}

static int clone_path(const char *name) {
    if (!strcmp(name, ".")) { errno = EINVAL; return -1; }
    int parent = parent_fd(roots[1], name, 1);
    if (parent < 0) return -1;
    const char *leaf = strrchr(name, '/');
    leaf = leaf ? leaf + 1 : name;
    int result = clonefileat(roots[0], name, parent, leaf,
        CLONE_NOFOLLOW | CLONE_NOOWNERCOPY | CLONE_NOFOLLOW_ANY);
    close(parent);
    return result;
}

static int compare_paths(const void *left, const void *right) {
    return strcmp(*(const char *const *)left, *(const char *const *)right);
}

/* Validate the entire private snapshot before touching its metadata. FTS_PHYSICAL
 * does not visit symlink targets, including links outside the checkout. */
static int verify_snapshot(void) {
    char **expected = malloc((job_count ? job_count : 1) * sizeof(*expected));
    char *root = strdup(root_paths[0]);
    if (!expected || !root) { free(expected); free(root); return -1; }
    for (size_t i = 0; i < job_count; i++) expected[i] = tokens[i * 3];
    qsort(expected, job_count, sizeof(*expected), compare_paths);
    for (size_t i = 1; i < job_count; i++)
        if (!strcmp(expected[i - 1], expected[i])) { free(expected); free(root); return -1; }
    char *paths[] = {root, NULL};
    FTS *tree = fts_open(paths, FTS_PHYSICAL | FTS_NOCHDIR | FTS_NOSTAT | FTS_XDEV, NULL);
    if (!tree) { free(expected); free(root); return -1; }
    size_t root_length = strlen(root), count = 0;
    int result = 0;
    for (;;) {
        errno = 0;
        FTSENT *entry = fts_read(tree);
        if (!entry) { if (errno) result = -1; break; }
        if (entry->fts_info == FTS_DP) continue;
        if (entry->fts_info == FTS_DNR || entry->fts_info == FTS_ERR || entry->fts_info == FTS_NS) { result = -1; break; }
        const char *name = entry->fts_level == 0 ? "." : entry->fts_path + root_length + 1;
        if (!bsearch(&name, expected, job_count, sizeof(*expected), compare_paths)) { result = -1; break; }
        count++;
    }
    if (count != job_count) result = -1;
    if (fts_close(tree) != 0) result = -1;
    free(expected); free(root);
    return result;
}

static void *worker(void *unused) {
    (void)unused;
    for (;;) {
        size_t index = atomic_fetch_add(&next_job, 1);
        if (index >= job_count || atomic_load(&failed)) break;
        int result;
        const char *name = tokens[operation == NORMALIZE ? index * 3 : index];
        if (operation == CLONE) result = clone_path(name);
        else if (operation == NORMALIZE) {
            result = normalize_path(name, tokens[index * 3 + 1], tokens[index * 3 + 2], &results[index * 2]);
        }
        else {
            result = inspect_path(roots[0], root_paths[0], name, operation == INSPECT,
                &results[index * 2]);
            if (!result && operation == PAIR)
                result = inspect_path(roots[1], root_paths[1], name, 0, &results[index * 2 + 1]);
        }
        if (result != 0) { perror(name); atomic_store(&failed, 1); break; }
    }
    return NULL;
}

static void print_info(const struct info *info) {
    if (!info->present) { fputs("null", stdout); return; }
    const struct stat *s = &info->stat;
    printf("[\"%" PRIu32 "\",\"%" PRIu64 "\",\"%u\",\"%u\",\"%u\",\"%" PRId64
           "\",\"%" PRId64 "\",\"%ld\",\"%" PRId64 "\",\"%ld\",\"%u\",\"%zd\"]",
        (uint32_t)s->st_dev, (uint64_t)s->st_ino, (unsigned)s->st_mode,
        (unsigned)s->st_uid, (unsigned)s->st_gid, (int64_t)s->st_size,
        (int64_t)s->st_ctimespec.tv_sec, s->st_ctimespec.tv_nsec,
        (int64_t)s->st_mtimespec.tv_sec, s->st_mtimespec.tv_nsec,
        (unsigned)s->st_flags, info->xattrs);
}

int main(int argc, char **argv) {
    if (argc < 3 || argc > 4) return 64;
    if (!strcmp(argv[1], "inspect")) operation = INSPECT;
    else if (!strcmp(argv[1], "pair")) operation = PAIR;
    else if (!strcmp(argv[1], "stat")) operation = STAT_ONLY;
    else if (!strcmp(argv[1], "clone")) operation = CLONE;
    else if (!strcmp(argv[1], "normalize")) operation = NORMALIZE;
    else return 64;
    int paired = operation == PAIR || operation == CLONE || (operation == NORMALIZE && argc == 4);
    if (argc != (paired ? 4 : 3)) return 64;
    for (int i = 0; i <= paired; i++) {
        root_paths[i] = argv[i + 2];
        roots[i] = open(root_paths[i], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (roots[i] < 0) { perror(root_paths[i]); return 1; }
    }
    if (operation == NORMALIZE && paired) {
        int fd = openat(roots[1], ".git", O_RDONLY | O_NOFOLLOW_ANY | O_CLOEXEC);
        struct stat stat;
        if (fd >= 0) {
            if (fstat(fd, &stat) == 0 && S_ISREG(stat.st_mode)) {
                default_origin_size = fgetxattr(fd, origin_attribute, default_origin, sizeof(default_origin), 0, 0);
                if (default_origin_size < 0) default_origin_size = 0;
            }
            close(fd);
        }
    }
    if (operation == CLONE) {
        struct statfs source, target;
        if (fstatfs(roots[0], &source) != 0 || fstatfs(roots[1], &target) != 0 ||
            strcmp(source.f_fstypename, "apfs") || strcmp(target.f_fstypename, "apfs") ||
            memcmp(&source.f_fsid, &target.f_fsid, sizeof(source.f_fsid))) return 1;
    }
    size_t capacity = 0, total = 0, token_capacity = 0;
    char *token = NULL;
    ssize_t size;
    while ((size = getdelim(&token, &capacity, 0, stdin)) > 0) {
        if (token[size - 1] != 0 || size == 1 || (total += (size_t)size) > MAX_INPUT_BYTES ||
            token_count >= MAX_RECORDS * 3) return 64;
        if (token_count == token_capacity) {
            size_t next = token_capacity ? token_capacity * 2 : 1024;
            char **grown = realloc(tokens, next * sizeof(*tokens));
            if (!grown) return 1;
            tokens = grown;
            token_capacity = next;
        }
        tokens[token_count] = strdup(token);
        if (!tokens[token_count++]) return 1;
    }
    free(token);
    if (ferror(stdin) || (operation == NORMALIZE && token_count % 3)) return 64;
    job_count = operation == NORMALIZE ? token_count / 3 : token_count;
    if (job_count > MAX_RECORDS) return 64;
    for (size_t i = 0; i < job_count; i++)
        if (!valid_path(tokens[operation == NORMALIZE ? i * 3 : i]) ||
            (operation == CLONE && !strcmp(tokens[i], "."))) return 64;
    if (operation == NORMALIZE && verify_snapshot() != 0) return 1;
    if (operation != CLONE) {
        results = calloc(job_count ? job_count * 2 : 1, sizeof(*results));
        if (!results) return 1;
    }
    pthread_t threads[WORKERS];
    size_t started = 0;
    for (; started < WORKERS; started++)
        if (pthread_create(&threads[started], NULL, worker, NULL) != 0) { atomic_store(&failed, 1); break; }
    for (size_t i = 0; i < started; i++) pthread_join(threads[i], NULL);
    if (!atomic_load(&failed) && operation != CLONE) {
        fputs("{\"version\":1,\"stats\":[", stdout);
        for (size_t i = 0; i < job_count; i++) {
            if (i) putchar(',');
            putchar('['); print_info(&results[i * 2]); putchar(',');
            print_info(&results[i * 2 + 1]); putchar(']');
        }
        fputs("]}\n", stdout);
    }
    for (size_t i = 0; i < token_count; i++) free(tokens[i]);
    free(tokens); free(results);
    close(roots[0]); if (roots[1] >= 0) close(roots[1]);
    return atomic_load(&failed) ? 1 : 0;
}
