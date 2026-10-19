# Claude NVIDIA gateway

Claude Desktop 的第三方推理模式会把 NVIDIA 模型 ID
`aws/anthropic/eccn-claude-opus-5-5` 识别为自定义别名，隐藏原生 effort 控件。
这个本地转接服务向 App 暴露标准 ID `claude-opus-5-5`，并在请求 NVIDIA 时映射回原 ID。
模型目录因此可以提供 Low、Medium、High、Extra（`xhigh`）和 Max 选项。

服务只监听 `127.0.0.1`，校验当前 API key，并只转发 Messages 和 token-count 请求到
`https://inference-api.nvidia.com`。effort、thinking、工具定义和 beta headers 原样传递，
SSE 持续转发，供应商错误状态和内容保持不变。服务不记录提示词或凭据。

## 安装

macOS 需要 `/usr/bin/python3`（本机 Xcode Command Line Tools 提供）。先在 Claude Desktop
配置 NVIDIA Gateway 和 API key，再运行：

```sh
python3 install.py
```

重启 Claude Desktop，在新建对话的模型菜单中选择 effort。旧对话仍保留原模型 ID。
默认遵循 Claude 对 Opus 5.5 推荐的 Medium，用户的选择由 App 记忆。
Claude Desktop 必须足够新，且模型目录包含 Opus 5.5。

安装器保存原设置备份，将服务复制到
`~/Library/Application Support/Claude-NVIDIA-Gateway/`，并安装当前用户的 LaunchAgent
`com.thynics.claude-nvidia-gateway`，登录后自动运行。配置文件仅当前用户可读写。
源代码和 LaunchAgent 不含 API key；原设置备份仍含凭据，放在私有安装目录中。

## 验证与移除

```sh
python3 -m unittest -v
python3 install.py --uninstall
```

移除后重启 Claude，恢复直连 NVIDIA 的模型设置。
