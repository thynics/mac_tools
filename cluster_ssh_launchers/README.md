# Cluster entry points

Two compiled local entry points:

```text
dlcluster [remote-command ...]
computelab [remote-command ...]
dlcluster-move <remote-path> <local-path>
computelab-move <remote-path> <local-path>
```

Build and install into `~/.local/bin`:

```text
make test install
```

The installed files are stripped native executables. They do not expose local
help, diagnostics, option parsing, or implementation-specific output.
