# iTerm 定时回车

`enter.sh [窗口 ID]` 每次执行会选中指定 iTerm2 窗口的第一个 tab，向该 tab 当前 pane 发送一次回车。传入窗口 ID 后允许同时打开其他窗口；目标窗口不存在时跳过，不切换到其他窗口。不传 ID 时要求 iTerm2 只有一个窗口。iTerm2 未运行时跳过。

本机通过 `~/Library/LaunchAgents/com.longcheng.iterm-enter.plist` 常驻运行 `repeat.sh`：立即执行一次，每次执行完成后等待 1 秒再执行；登录后自动恢复，电脑休眠时不执行。常驻循环避免 launchd 的启动限频影响短间隔执行。脚本使用 iTerm 原生 AppleScript 接口。

当前后台任务的 `ProgramArguments` 最后一个参数固定为选定的窗口 ID。`repeat.sh` 会将该参数传给 `enter.sh`。重建窗口或重启 iTerm 后，如果窗口 ID 改变，需要更新此参数并重新加载任务。

手动执行一次：

```sh
sh "$HOME/github.com/thynics/mac_tools/iterm_enter/enter.sh"
```

停止定时执行：

```sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.longcheng.iterm-enter.plist"
```

重新启动：

```sh
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.longcheng.iterm-enter.plist"
```

若要取消后续登录时启动，停止后删除该 plist 文件。
