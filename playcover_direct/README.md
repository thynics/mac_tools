# PlayCover 金铲铲进程内直连

仅修改 PlayCover 安装的 `com.tencent.jkchess`。在游戏进程内清除 HTTP/HTTPS/ALL_PROXY，覆盖网络会话的代理配置，并将 IPv4/IPv6 连接绑定到 `en0`（本机 Wi-Fi）。不修改 Mihomo、GlobalProtect、DNS、系统代理或路由。

已在 Apple Silicon、macOS 26.7、金铲铲 1.14.35（1188）上验证：版本服务连接由 VPN 地址切换到 Wi-Fi 地址，游戏完成资源更新，用户确认可用。

## 安装

先退出游戏；需要 Xcode Command Line Tools。安装器也会退出正在运行的游戏。

```sh
./build.sh
python3 install-direct.py
```

安装器按游戏 build 备份原始可执行文件和签名权限，增加游戏专用 dylib 加载命令，然后重新签名并验证。备份位于 `~/Library/Application Support/PlayCoverDirect/com.tencent.jkchess/<build>/`。

## 回退

```sh
python3 install-direct.py --remove
```

回退恢复原始可执行文件，移除直连 dylib，并重新签名。回退同样只操作游戏文件。

## 使用范围

- 当前绑定 `en0`；适用于该接口为 Wi-Fi 的 Mac。
- 通过 PlayCover 覆盖安装新的 IPA 后，可能需要重新应用本工具；普通游戏资源更新通常保留它。
- 安装器要求 Mach-O 保留足够的空白头部空间，不适用时会拒绝修改可执行文件。
