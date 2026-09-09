# iTerm 定时回车

`enter.sh` 每次执行会选中 iTerm2 唯一窗口的第一个 tab，向该 tab 当前 pane 发送一次回车。iTerm2 未运行或窗口数不等于 1 时跳过。

本机通过 `~/Library/LaunchAgents/com.longcheng.iterm-enter.plist` 每 600 秒运行一次；登录后自动恢复，电脑休眠时不执行。脚本使用 iTerm 原生 AppleScript 接口。

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
