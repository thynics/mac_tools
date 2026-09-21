# Paper Studio

本机运行的 LaTeX 论文 PDF 渲染服务，配有简单网页界面：导入 Overleaf 项目 ZIP，选择主文档和编译引擎，编译后预览、下载 PDF，并查看编译日志。源文件保存在独立数据目录中，原始 ZIP 不会被修改。

使用 TeX Live、latexmk 与 BibTeX 等 Overleaf 采用的编译工具链。它不是完整的 Overleaf Community Edition，也没有云端协作编辑功能。与 Overleaf 的结果是否完全一致，取决于 TeX Live 版本、宏包、字体、编译引擎和项目设置。

## 安装

需要 macOS、可运行的 Python 3.9+ 和 TeX Live。Python 不需要安装额外依赖。安装器优先使用 Homebrew 的 Python 3.12，避免调用可能要求接受 Xcode 许可的系统 Python。

TeX Live 的建议用户安装位置是 `~/.local/share/latex-renderer/texlive`。也支持已有的 MacTeX / TeX Live；安装器会寻找包含 `latexmk` 的目录，或者使用明确指定的 `--tex-bin`。下文提供首次安装 TeX 的命令；已有可用工具链时可直接复用。

在本目录运行：

```sh
./install.sh
```

安装器会复制服务代码到 `~/Library/Application Support/Paper Studio/app`，生成用户级 LaunchAgent，自动启动服务并打开 <http://127.0.0.1:8787>。不需要 sudo，不修改全局 TeX PATH。后台服务会在后续登录时自动启动。

可指定端口、数据目录与 TeX 工具目录：

```sh
./install.sh --port 8787 \
  --data-dir "$HOME/Library/Application Support/Paper Studio/data" \
  --tex-bin "$HOME/.local/share/latex-renderer/texlive/bin/universal-darwin" \
  --no-open
```

配置保存在 `~/Library/Application Support/Paper Studio/config.json`。再次运行安装器会更新代码，并保留既有端口与数据目录；明确传入的参数会覆盖相应设置。若端口或同名 CLI / LaunchAgent 已被其他程序占用，会报错，不会覆盖或终止其他程序。

### 首次准备 TeX Live

以下采用 TinyTeX-1 v2026.09（TeX Live 2026，包含 pdfLaTeX、XeLaTeX、LuaLaTeX、latexmk 与 BibTeX），并安装常见 ACM 论文依赖。它使用用户目录，不执行全局 PATH 注册，也不需要 sudo。已有安装目录会保留；不完整的目录会报错。

```sh
(
  set -eu
  paper_tex_root="$HOME/.local/share/latex-renderer/texlive"
  paper_tex_bin="$paper_tex_root/bin/universal-darwin"
  if [ ! -e "$paper_tex_root" ]; then
    paper_tex_tmp=$(mktemp -d)
    trap 'rm -rf "$paper_tex_tmp"' EXIT
    curl -fL --retry 3 \
      https://github.com/rstudio/tinytex-releases/releases/download/v2026.09/TinyTeX-1-darwin-v2026.09.tar.xz \
      -o "$paper_tex_tmp/tinytex.tar.xz"
    printf '%s  %s\n' \
      974bb21f394def11780788eaacf77ae8fc1974a60bc9e75a9a2f9d735db479fe \
      "$paper_tex_tmp/tinytex.tar.xz" | shasum -a 256 -c -
    tar -xJf "$paper_tex_tmp/tinytex.tar.xz" -C "$paper_tex_tmp"
    mkdir -p "$HOME/.local/share/latex-renderer"
    mv "$paper_tex_tmp/TinyTeX" "$paper_tex_root"
  fi
  test -x "$paper_tex_bin/latexmk"
  "$paper_tex_bin/tlmgr" option repository https://mirrors.ctan.org/systems/texlive/tlnet
  "$paper_tex_bin/tlmgr" update --self
  "$paper_tex_bin/tlmgr" install \
    acmart algorithms algorithmicx multirow xstring microtype totpages \
    environ setspace zref hyperxmp draftwatermark ncctools cmap libertine \
    newtx caption comment fancyhdr pbalance preprint trimspaces ifmtarg \
    xpatch everyshi upquote
)
```

该版本需要 TeX Live 2026 的宏包仓库。CTAN 进入下一年度后，应改用对应年度的冻结仓库，或整体安装新版 TeX Live。不同项目可能需要额外宏包；可用上述 `tlmgr install <包名>` 补充，再重新编译。

## 使用

在页面导入 ZIP，确认主文档，再点击编译。PDF 和日志会在页面更新。页面可以开启自动编译：在本地编辑器修改项目源码后，由服务检测修改并重新编译。

每个项目的源目录为：

```text
~/Library/Application Support/Paper Studio/data/projects/<项目 ID>/source
```

可从页面打开该目录，或在 Finder 中使用“前往文件夹”找到它，再用自己的编辑器修改 `.tex`、`.bib` 和图片。编译使用导入后的这份源码，修改原始 ZIP 不会更新项目。数据目录可备份或迁移，升级应用不会删除论文。

CLI 安装在 `~/.local/bin/paper-studio`。若此目录已在 PATH 中，也可直接使用 `paper-studio`：

```sh
~/.local/bin/paper-studio open
~/.local/bin/paper-studio status
~/.local/bin/paper-studio import /path/to/paper.zip --name 'My paper'
~/.local/bin/paper-studio restart
~/.local/bin/paper-studio stop
~/.local/bin/paper-studio start
~/.local/bin/paper-studio doctor
```

`import` 会启动服务、导入项目并触发一次编译，打印项目地址；可以在页面继续查看结果。`stop` 停止当前登录会话的后台服务，保留下次登录自动启动配置。`restart` 会卸载并重新加载自己的 LaunchAgent。`status` 只有在 API 身份、数据目录和后台服务均验证成功后才返回成功。

## 排查问题

先运行 `paper-studio doctor`。它检查 Python、latexmk、pdfLaTeX、BibTeX、数据目录及 HTTP 服务。编译失败时，先查看页面内的项目日志：通常是主文档、缺少宏包、引用文件路径、引擎或字体问题。

后台日志保存在：

```text
~/Library/Application Support/Paper Studio/logs/server.log
~/Library/Application Support/Paper Studio/logs/error.log
```

LaunchAgent 位于 `~/Library/LaunchAgents/com.longcheng.paper-studio.plist`。启动报端口冲突时，可用 `lsof -nP -iTCP:8787 -sTCP:LISTEN` 查看占用，或者重新安装并指定其他端口。LaunchAgent 需要当前用户的 macOS 图形登录会话；`launchctl` 失败会显示实际错误。

## 开发与验证

可在源码目录直接运行服务，使用另一个端口和独立开发数据目录：

```sh
python3.12 server.py --host 127.0.0.1 --port 8788 \
  --data-dir "$HOME/Library/Application Support/Paper Studio/dev-data" \
  --tex-bin "$HOME/.local/share/latex-renderer/texlive/bin/universal-darwin"
python3.12 -m unittest discover -s tests -v
```

服务与 CLI 仅使用 Python 标准库，前端静态文件包含在 `static/` 中。仓库不存储私人论文；数据、ZIP 和编译产物应放在用户数据目录。

## 本地访问范围

服务仅监听 `127.0.0.1`，关闭 LaTeX shell escape，并让 latexmk 忽略项目和用户的 `latexmkrc`。请仅编译可信的个人 LaTeX 项目；编译进程仍以当前 macOS 用户身份运行，不是完整的操作系统沙箱。不支持将端口向公网开放。
