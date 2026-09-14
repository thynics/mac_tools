# 双周 · Biweekly

一个本地 macOS 双周任务管理 App。原生 AppKit 窗口搭配系统 WebKit，运行时无需 Node、Electron、服务端或账号。界面使用中文，支持 macOS 13 及以上；构建生成本机架构的 App。

## 安装与运行

```sh
./scripts/build.sh --install
open "$HOME/Applications/Biweekly.app"
```

构建需要 Apple Command Line Tools（`xcode-select --install`）。构建产物位于 `build/Biweekly.app`，本地临时签名；安装不会替换用户数据。

## 使用

- 每个周期固定 14 天。侧栏在当前双周和历史归档之间切换；偏好中可修改当前双周开始日期。
- 点击 **专注 Doing**（⌘1）只显示正在进行的任务及其父级路径。相关子任务会自动展开，⌘0 返回全部。
- 每行右侧状态按 **Todo → Doing → Done → Todo** 切换，左侧复选框快速完成 / 恢复待办。任务和父任务独立记录状态，统计包括父任务。
- 列表底部或 ⌘N 新增任务。行上的 **＋** 新增子任务；小三角展开/收起，可使用列表上的「展开全部 / 收起全部」。
- 拖动行首 **⠿** 手柄调整同级任务顺序，父任务连同全部子任务移动；紫色线标出插入位置，拖到窗口边缘自动滚动。Doing 筛选下也可以排序。行上的 **↑ / ↓** 可直接移动，聚焦手柄后可用 **⌥↑ / ⌥↓**；⌘Z 撤销排序，顺序自动保存。
- 界面采用紧凑布局，任务字号 14 px、常规行高 30 px；统计合并到日期行，侧栏与内容边距缩窄。
- 点击任务打开详情，直接修改标题。**更多** 或右键任务可删除、上下移动；子任务可提升一级。删除父任务同时删除其子任务；⌘Z 或提示中的「撤销」恢复，最多保留本次运行的 40 步更改。
- 详情笔记支持 Markdown 编辑与预览，包括标题、列表、引用、代码块、链接、表格及任务复选框的显示。笔记中的复选框是 Markdown 内容，修改源码来更新；任务状态用列表中的状态控件更新。
- **图片笔记**：打开任务或双周笔记，复制截图/图片后按 **⌘V**，或点「粘贴图片」。编辑模式插入到光标处，预览模式附加到末尾；粘贴后直接预览，点击图片放大。图片作为去重后的本地 PNG 附件保存，最长边最多 4096 px，笔记只保存简短引用；编辑 Markdown 可以删除图片引用，⌘Z 可撤销插入。
- **Git 备份**：偏好中设置 SSH/HTTPS 仓库并启用，默认每 5 分钟检查。App 运行期间定期备份，启动也会检查；无变化不创建提交，失败显示原因并自动重试。侧栏可查看状态并立即备份。
- **导入 Markdown**（⌘I）接受粘贴或 UTF-8 `.md` 文件。列表转成层级任务，`[doing]` 表示进行中，`[x]` 或 `[done]` 表示完成。选中完成的任务优先识别为 Done。
- 导入时也可选择「插入为双周笔记」，保留整份 Markdown 正文。任务详情的 **插入 .md** 将整份文件附加到该任务笔记。
- 导出当前双周为 `.md`，或在偏好中导出/恢复全部数据的 JSON 备份。完整 JSON 备份内嵌所需图片，保留日期、任务层级、状态和笔记；Markdown 导出也会内嵌图片；Markdown 清单导入会将笔记内的列表也识别为任务，完整迁移请使用 JSON。

## 归档规则

App 启动、重新获得焦点以及运行时每分钟检查周期。到开始日期后第 14 天，保留旧周期，创建所属的当前双周；长时间没打开不会生成空白历史周期。默认将未完成任务及其必要父级复制到新双周，重新分配 ID，旧双周保留原样。

「归档并开启下一双周」可提前结束本期，并选择是否延续未完成任务。下一期仍从原开始日期 +14 天开始。归档为只读，仍支持展开、搜索、阅读和导出。当前双周笔记不自动复制；任务自己的笔记随任务延续。

## 本地数据

`~/Library/Application Support/Biweekly/`

- `data.json`：主数据，原子写入；编辑后约 200 ms 保存，失焦与退出时立即保存。
- `images/`：按内容哈希命名的图片附件；保持历史附件以支持撤销、归档和旧备份恢复。
- `git-backup.json`：本机 Git 仓库、周期、设备标识配置，不随任务数据上传或恢复。
- `data.previous.json`：上一次有效写入。
- `backups/YYYY-MM-DD.json`：每天首个写入前的快照，最多 14 份。
- `before-restore-*.json`：恢复完整备份前保留的旧数据。
- 主文件 JSON 损坏时尝试使用上一份备份，保留损坏原件。结构校验失败时暂停写入，可从偏好中恢复完整备份。

Markdown 渲染由本地 bundled Marked + DOMPurify 完成；清除可执行 HTML，并限制 WebView 的导航和脚本来源。普通网页链接使用默认浏览器打开。为保持离线，正文不会自动请求外部图片；支持内嵌 data 图片。Markdown 导入与任务元数据上限 50 MB，带图片的 JSON 备份上限 200 MB。图片无需网络；不支持提醒推送。

源代码中的初始任务为通用示例，用户数据不存入仓库。

## Git 版本备份

规范克隆路径为 `~/host/namespace/repository`；已存在的仓库必须拥有同一 origin，App 不会覆盖冲突目录。每台设备写入 `devices/<device-id>/data.json` 和同目录 `images/`，避免互相覆盖任务文件。

同步使用 fetch、fast-forward merge、仅提交设备备份目录，再按需 push；不会强推、清理用户改动或自动处理冲突。仓库有其他未提交改动、存在不属于备份的待推送提交或分支分叉时，显示错误并保留本机数据。SSH 使用现有系统配置，非交互认证；网络断开或认证失败时按周期重试。

这是按设备保存的版本备份，不会自动把另一台设备的数据合并到当前任务列表。恢复时，在 App 偏好中选择 Git 目录里的 `devices/<device-id>/data.json`，同时保留旁边的 `images/` 目录；恢复前仍会先保留本机旧数据。App 关闭时不执行定时备份，重新打开后会检查。

## 验证

```sh
node --test tests/model.test.cjs
# Requires Playwright and a local Chrome installation; CHROME_PATH can override.
node tests/ui.cjs
# Native WebKit rendering, real disk writes and quit/relaunch; uses a separate temp store.
./scripts/test-native.sh
```

可用 `Biweekly.app/Contents/MacOS/Biweekly --data-dir /absolute/test/directory` 指定独立数据目录。测试构建单独编译 `UI_TESTS`，不会把测试入口放入正式版本。

## 第三方

- [Marked 18.0.13](https://github.com/markedjs/marked)，MIT：`web/vendor/marked.LICENSE`。
- [DOMPurify 3.4.15](https://github.com/cure53/DOMPurify)，Apache-2.0 或 MPL-2.0：`web/vendor/dompurify.LICENSE`。

依赖已随仓库提供，构建和运行无需下载。图标由 AppKit 绘制，生成脚本见 `scripts/icon.swift`。
