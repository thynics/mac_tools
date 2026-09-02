#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static const char *program_name(const char *path) {
    const char *slash = strrchr(path, '/');
    return slash == NULL ? path : slash + 1;
}

static char *connection_target(const char *name) {
    if (strcmp(name, "dlcluster") == 0) {
        return strdup(name);
    }

    if (strcmp(name, "computelab") == 0) {
        static const char suffix[] = {'-', 's', 'c', '-', '0', '1', '\0'};
        size_t length = strlen(name) + sizeof(suffix);
        char *target = malloc(length);
        if (target == NULL) {
            return NULL;
        }
        snprintf(target, length, "%s%s", name, suffix);
        return target;
    }

    return NULL;
}

static void usage(const char *name) {
    fprintf(stderr,
            "usage: %s [remote-command ...]\n"
            "       %s [ssh-options ...] -- [remote-command ...]\n",
            name, name);
}

int main(int argc, char **argv) {
    const char *name = program_name(argv[0]);

    if (argc == 2 && strcmp(argv[1], "--self-test") == 0) {
        char *target = connection_target(name);
        if (target == NULL) {
            fprintf(stderr, "%s: unsupported launcher name\n", name);
            return 1;
        }
        free(target);
        return 0;
    }

    if (argc == 2 && (strcmp(argv[1], "--help") == 0 ||
                      strcmp(argv[1], "-h") == 0)) {
        usage(name);
        return 0;
    }

    char *target = connection_target(name);
    if (target == NULL) {
        fprintf(stderr, "%s: unsupported launcher name\n", name);
        return 64;
    }

    int separator = -1;
    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--") == 0) {
            separator = i;
            break;
        }
    }

    char **ssh_argv = calloc((size_t)argc + 2, sizeof(*ssh_argv));
    if (ssh_argv == NULL) {
        fprintf(stderr, "%s: out of memory\n", name);
        free(target);
        return 1;
    }

    int output = 0;
    ssh_argv[output++] = "ssh";
    if (separator >= 0) {
        for (int i = 1; i < separator; ++i) {
            ssh_argv[output++] = argv[i];
        }
    }
    ssh_argv[output++] = target;
    if (separator >= 0) {
        for (int i = separator + 1; i < argc; ++i) {
            ssh_argv[output++] = argv[i];
        }
    } else {
        for (int i = 1; i < argc; ++i) {
            ssh_argv[output++] = argv[i];
        }
    }
    ssh_argv[output] = NULL;

    execv("/usr/bin/ssh", ssh_argv);
    int saved_errno = errno;
    fprintf(stderr, "%s: unable to start ssh: %s\n", name,
            strerror(saved_errno));
    free(ssh_argv);
    free(target);
    return 126;
}
