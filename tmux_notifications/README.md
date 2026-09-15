# tmux CLI 回复完成通知

适用：Mac 上的 iTerm2，通过 `ssh -t HOST tmux -CC attach -t workspace`
连接远端 Codex / Claude CLI。通知沿当前 SSH 连接返回，由 iTerm2 交给
macOS 通知中心。连接需要保持在线。

## 安装

把本目录复制到运行 CLI 的主机，运行 `python3 install.py`（Python 3.11+）。
安装器备份原配置、保留其他配置和已有 Claude hooks；重复运行不会重复添加 hook。

- Codex：在用户 `config.toml` 中开启 `agent-turn-complete` 的 OSC 9 通知，
  `notification_condition = "always"` 避免依赖 tmux 的焦点转发。
- Claude：添加 `Stop` hook，以 `terminalSequence` 返回通知；显示
  `workspace:窗口号.面板号 窗口名` 及最多 140 字符的回复摘要。
  只处理 `workspace` 的主会话回复，过滤控制字符，不通知子代理完成。
- 使用 iTerm 的 `tmux -CC` 集成通路；普通 tmux 客户端不在本工具验证范围内。

Mac 上 iTerm Settings → Profiles → Terminal → Notification Center alerts
需开启；系统设置 → 通知 → iTerm 的通知也需允许。专注模式可能抑制横幅。
正在看的会话是否也提醒，由 iTerm 的 Filter Alerts 设置控制。

## 已运行的会话

Claude 的设置通常自动重载，可通过 `/hooks` 查看 Stop hook。
Codex 应在当前任务结束后退出 CLI，再运行 `codex resume` 选择原会话。
无需重启 tmux 或关闭 iTerm。

## 验证记录

2026-09-15：haifa 上 tmux 3.4、Codex 0.154.0、Claude 2.1.271，
Mac 上 iTerm2 3.6.11。用户已确认从远端 workspace 面板发送的
「iTerm 测试：远端回复通知 12345」正常显示，远端到 Mac 的通知通路验证通过。
实际 CLI 完成事件需在配置重载后触发。
已验证配置保留其他设置、重复安装不重复添加 hook，以及 Claude hook
从真实 tmux 面板读取窗口名称并生成经过控制字符过滤的 OSC 9。

## 撤销

从 Codex `[tui]` 删除本工具添加的三个 notification 设置，从 Claude
`hooks.Stop` 删除指向 `claude_notify.py` 的条目。保留其他 hook。
原配置备份放在原文件旁，后缀为 `.before-tmux-notifications-时间戳`。

## 官方接口

- [Codex 通知配置](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications)
- [Claude terminalSequence](https://code.claude.com/docs/en/hooks#emit-terminal-notifications)
- [iTerm OSC 9](https://iterm2.com/documentation-escape-codes.html)
