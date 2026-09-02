# Cluster SSH launchers

Two compiled local command wrappers:

```text
dlcluster [remote-command ...]
computelab [remote-command ...]
```

For SSH options, put `--` before the optional remote command:

```text
dlcluster -L 8080:localhost:8080 --
computelab -t -- tmux attach
```

Build and install into `~/.local/bin`:

```text
make test install
```

The installed files are stripped native executables rather than readable shell
scripts. They rely on the user's existing OpenSSH configuration and
credentials.
