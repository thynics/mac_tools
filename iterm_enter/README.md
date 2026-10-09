# iTerm 定时回车

`enter.sh [窗口 ID ...]` 每次执行会依次选中每个指定 iTerm2 窗口的第一个 tab，向该 tab 当前 pane 发送一次回车。可传入多个窗口 ID 以同时捕获多个窗口；传入窗口 ID 后允许同时打开其他窗口；某个目标窗口不存在时跳过该窗口，不切换到其他窗口。不传 ID 时要求 iTerm2 只有一个窗口。iTerm2 未运行时跳过。

本机通过 `~/Library/LaunchAgents/com.longcheng.iterm-enter.plist` 常驻运行 `repeat.sh`：立即执行一次，每次执行完成后等待 1 秒再执行；登录后自动恢复，电脑休眠时不执行。常驻循环避免 launchd 的启动限频影响短间隔执行。脚本使用 iTerm 原生 AppleScript 接口。

当前后台任务的 `ProgramArguments` 中 `repeat.sh` 之后的参数固定为选定的窗口 ID（可多个）。`repeat.sh` 会将这些参数原样传给 `enter.sh`。重建窗口或重启 iTerm 后，如果窗口 ID 改变，使用 `iterm-resume 新窗口ID ...` 更新目标并重新加载任务。命令会先确认所有指定窗口存在；不传 ID 则保留原配置，缺失窗口会提示并跳过。

本机在 `~/.local/bin` 安装了 `iterm-pause`、`iterm-resume` 和 `iterm-status`，均指向 `control.sh`。暂停使用 launchd 的 `disable` 和 `bootout`，恢复使用 `enable`、`bootstrap` 或 `kickstart`，配置始终保存在原位置。暂停状态跨登录和重启保留；恢复后自动启动。连续暂停或连续恢复均可安全执行，恢复已运行的任务不会重启进程。

手动执行一次：

```sh
sh "$HOME/github.com/thynics/mac_tools/iterm_enter/enter.sh"
```

停止定时执行，并暂停后续登录时的自动启动：

```sh
iterm-pause
```

重新启动：

```sh
iterm-resume
```

更新目标窗口（示例）：

```sh
iterm-resume 575 3299
```

查看运行状态和目标窗口：

```sh
iterm-status
```

未安装命令时，可直接运行 `sh "$HOME/github.com/thynics/mac_tools/iterm_enter/control.sh" pause`、`resume [窗口 ID ...]` 或 `status`。旧版 shell 别名需要从 shell 配置中移除并重新加载，避免覆盖新命令。
