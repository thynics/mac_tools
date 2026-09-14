import Cocoa
import WebKit
import UniformTypeIdentifiers

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var dataDirectory: URL!
    var imageStore: ImageStore!
    var gitBackup: GitBackup!
    #if UI_TESTS
    var testPasteboard: NSPasteboard?
    #endif
    var saveBlocked = false
    var terminating = false
    var pendingFiles: [URL] = []
    let fm = FileManager.default
    var storeURL: URL { dataDirectory.appendingPathComponent("data.json") }
    var previousURL: URL { dataDirectory.appendingPathComponent("data.previous.json") }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--data-dir"), args.count > i+1 {
            dataDirectory = URL(fileURLWithPath: args[i+1], isDirectory: true)
        } else {
            dataDirectory = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Biweekly", isDirectory: true)
        }
        do { try fm.createDirectory(at: dataDirectory, withIntermediateDirectories: true) }
        catch { fatalAlert("无法创建数据目录：\(error.localizedDescription)"); return }
        imageStore = ImageStore(root: dataDirectory)
        gitBackup = GitBackup(root: dataDirectory, images: imageStore)
        gitBackup.onStatus = { [weak self] info in self?.call("gitStatus", [info]) }
        let content = WKUserContentController()
        content.add(self, name: "bridge")
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = content
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(imageStore, forURLScheme: "biweekly-image")
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "双周 · Biweekly"
        window.minSize = NSSize(width: 960, height: 650)
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(calibratedWhite: 0.977, alpha: 1)
        window.contentView = webView
        window.setFrameAutosaveName("BiweeklyMainWindow")
        window.center()
        setupMenu()
        guard let resources = Bundle.main.resourceURL else { fatalAlert("App 资源缺失。"); return }
        let web = resources.appendingPathComponent("web")
        webView.loadFileURL(web.appendingPathComponent("index.html"), allowingReadAccessTo: web)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        #if UI_TESTS
        runUITests()
        #endif
    }

    func setupMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem(); menu.addItem(appItem)
        let appMenu = NSMenu(); appItem.submenu = appMenu
        appMenu.addItem(withTitle: "关于双周", action: #selector(about), keyEquivalent: "")
        appMenu.addItem(.separator())
        let prefs = appMenu.addItem(withTitle: "偏好与备份…", action: #selector(command(_:)), keyEquivalent: ","); prefs.representedObject = "settings"
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏双周", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "退出双周", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let fileItem = NSMenuItem(); fileItem.title = "文件"; menu.addItem(fileItem)
        let file = NSMenu(title: "文件"); fileItem.submenu = file
        for (title, key, name) in [("新建任务", "n", "new"), ("导入 Markdown…", "i", "import"), ("导出当前双周…", "e", "export")] {
            let item = file.addItem(withTitle: title, action: #selector(command(_:)), keyEquivalent: key); item.representedObject = name
        }
        file.addItem(.separator()); file.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let editItem = NSMenuItem(); editItem.title = "编辑"; menu.addItem(editItem)
        let edit = NSMenu(title: "编辑"); editItem.submenu = edit
        edit.addItem(withTitle: "撤销", action: #selector(undoAction), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "重做文字编辑", action: Selector(("redo:")), keyEquivalent: "z"); redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        for (title, action, key) in [("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] { let item = edit.addItem(withTitle: title, action: action == "paste:" ? #selector(smartPaste) : Selector(action), keyEquivalent: key); if action == "paste:" { item.target = self } }
        let search = edit.addItem(withTitle: "搜索任务", action: #selector(command(_:)), keyEquivalent: "f"); search.representedObject = "search"
        let viewItem = NSMenuItem(); viewItem.title = "视图"; menu.addItem(viewItem)
        let view = NSMenu(title: "视图"); viewItem.submenu = view
        for (title, key, name) in [("专注 Doing", "1", "doing"), ("全部任务", "0", "all")] { let item = view.addItem(withTitle: title, action: #selector(command(_:)), keyEquivalent: key); item.representedObject = name }
        NSApp.mainMenu = menu
    }
    @objc func command(_ sender: NSMenuItem) { call("command", [sender.representedObject as? String ?? ""]) }
    @objc func undoAction() {
        webView.evaluateJavaScript("/INPUT|TEXTAREA/.test(document.activeElement.tagName)") { result, _ in
            if result as? Bool == true { _ = NSApp.sendAction(Selector(("undo:")), to: self.window.firstResponder, from: self) }
            else { self.call("command", ["undo"]) }
        }
    }
    var imagePasteboard: NSPasteboard {
        #if UI_TESTS
        if let board = testPasteboard { return board }
        #endif
        return .general
    }
    @objc func smartPaste() {
        if imageStore.hasClipboardImage(imagePasteboard) {
            webView.evaluateJavaScript("window.BiweeklyNative.pasteImageCommand()") { handled, _ in
                if handled as? Bool != true { _ = NSApp.sendAction(#selector(NSText.paste(_:)), to: nil, from: self) }
            }
        } else { _ = NSApp.sendAction(#selector(NSText.paste(_:)), to: nil, from: self) }
    }
    func restoreFile(_ url: URL) throws -> String {
        let text = try readText(url, limit: 200_000_000)
        guard let bytes = text.data(using: .utf8), var object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw biweeklyError("备份格式无效。") }
        if object["imageAttachments"] == nil {
            var attachments: [String: String] = [:]
            var size = text.utf8.count
            for name in imageStore.names(in: text) {
                let file = url.deletingLastPathComponent().appendingPathComponent("images").appendingPathComponent(name)
                if fm.fileExists(atPath: file.path) {
                    let data = try Data(contentsOf: file); size += data.count * 4 / 3
                    guard size <= 200_000_000 else { throw biweeklyError("包含图片的备份超过 200 MB。") }
                    attachments[name] = data.base64EncodedString()
                }
            }
            if !attachments.isEmpty { object["imageAttachments"] = attachments }
        }
        return String(data: try JSONSerialization.data(withJSONObject: object, options: .withoutEscapingSlashes), encoding: .utf8)!
    }
    @objc func about() {
        NSApp.orderFrontStandardAboutPanel(options: [.applicationName: "双周 · Biweekly", .applicationVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.2.0", .credits: NSAttributedString(string: "每两周，专注正在发生的事。\n本地任务 · Markdown · 双周归档")])
    }
    func call(_ method: String, _ args: [Any] = []) {
        guard let json = try? JSONSerialization.data(withJSONObject: args, options: [.fragmentsAllowed]), let text = String(data: json, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.BiweeklyNative.\(method)(...\(text))", completionHandler: nil)
    }
    func validData(_ data: Data) -> Bool {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any], obj["version"] as? Int == 1, let cycles = obj["cycles"] as? [[String: Any]], !cycles.isEmpty else { return false }
        return true
    }
    func load() {
        var object: Any = NSNull(); var warning = ""
        do {
            if fm.fileExists(atPath: storeURL.path) {
                let data = try Data(contentsOf: storeURL)
                if validData(data) { object = try JSONSerialization.jsonObject(with: data) }
                else if let previous = try? Data(contentsOf: previousURL), validData(previous) {
                    let preserved = dataDirectory.appendingPathComponent("unreadable-\(UUID().uuidString).json")
                    try data.write(to: preserved, options: .atomic)
                    object = try JSONSerialization.jsonObject(with: previous)
                    warning = "主数据无法读取，已从上一份备份恢复；原文件已保留。"
                } else { saveBlocked = true; object = ["version": -1]; warning = "数据无法读取，请恢复备份。" }
            }
        } catch { saveBlocked = true; object = ["version": -1]; warning = error.localizedDescription }
        call("bootstrap", [object, ["path": dataDirectory.path, "warning": warning]])
        for url in pendingFiles { importFile(url, target: "tasks") }; pendingFiles.removeAll()
        gitBackup.start()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.gitBackup.sync() }
    }
    func backupBeforeWrite() throws {
        guard fm.fileExists(atPath: storeURL.path) else { return }
        let existing = try Data(contentsOf: storeURL)
        guard validData(existing) else { return }
        try existing.write(to: previousURL, options: .atomic)
        let backups = dataDirectory.appendingPathComponent("backups", isDirectory: true)
        try fm.createDirectory(at: backups, withIntermediateDirectories: true)
        let formatter = DateFormatter(); formatter.dateFormat = "yyyy-MM-dd"
        let target = backups.appendingPathComponent("\(formatter.string(from: Date())).json")
        if !fm.fileExists(atPath: target.path) { try existing.write(to: target, options: .atomic) }
        let files = try fm.contentsOfDirectory(at: backups, includingPropertiesForKeys: nil).filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent > $1.lastPathComponent }
        for old in files.dropFirst(14) { try fm.removeItem(at: old) }
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
        switch action {
        case "load": load()
        case "save":
            let revision = body["revision"] as? Int ?? 0
            guard !saveBlocked else { call("saved", [revision, "原数据无法读取，已暂停写入。请恢复完整备份。"]); return }
            guard let text = body["data"] as? String, let data = text.data(using: .utf8), data.count <= 50_000_000, validData(data) else { call("saved", [revision, "数据格式无效或超过 50 MB。"]); return }
            do { try backupBeforeWrite(); try data.write(to: storeURL, options: [.atomic]); call("saved", [revision, NSNull()]) }
            catch { call("saved", [revision, "保存失败：\(error.localizedDescription)"]) }
        case "pasteImage":
            guard let request = body["request"] as? String else { return }
            do {
                guard !saveBlocked else { throw biweeklyError("数据暂时无法写入，请先恢复备份。") }
                call("imagePasted", [request, try imageStore.clipboardImage(imagePasteboard), NSNull()])
            } catch { call("imagePasted", [request, NSNull(), error.localizedDescription]) }
        case "gitSync": gitBackup.sync()
        case "configureGit":
            do {
                guard let enabled = body["enabled"] as? Bool, let remote = body["remote"] as? String, let interval = body["intervalMinutes"] as? Int else { throw biweeklyError("Git 备份设置无效。") }
                try gitBackup.configure(enabled: enabled, remote: remote, interval: interval)
                call("error", ["Git 备份设置已保存"])
            } catch { call("error", [error.localizedDescription]) }
        case "importMarkdown":
            let panel = NSOpenPanel(); panel.allowedContentTypes = [UTType(filenameExtension: "md") ?? .plainText, .plainText]; panel.allowsMultipleSelection = false
            panel.beginSheetModal(for: window) { response in if response == .OK, let url = panel.url { self.importFile(url, target: body["target"] as? String ?? "tasks") } }
        case "export":
            guard let content = body["content"] as? String, let name = body["name"] as? String else { return }
            let panel = NSSavePanel(); panel.nameFieldStringValue = name; panel.canCreateDirectories = true
            panel.beginSheetModal(for: window) { response in
                if response == .OK, let url = panel.url { do { let output = name.hasSuffix(".json") ? try self.imageStore.backup(content) : try self.imageStore.portableMarkdown(content); try output.write(to: url, atomically: true, encoding: .utf8); self.call("error", ["已导出 \(url.lastPathComponent)"]) } catch { self.call("error", [error.localizedDescription]) } }
            }
        case "restoreBackup":
            let panel = NSOpenPanel(); panel.allowedContentTypes = [.json]; panel.allowsMultipleSelection = false
            panel.beginSheetModal(for: window) { response in
                if response == .OK, let url = panel.url { do { let data = try self.restoreFile(url); self.call("restore", [data]) } catch { self.call("error", [error.localizedDescription]) } }
            }
        case "beforeRestore":
            do {
                guard let text = body["data"] as? String else { throw biweeklyError("缺少待恢复的数据。") }
                let prepared = try imageStore.prepareRestore(text)
                if fm.fileExists(atPath: storeURL.path) { try fm.copyItem(at: storeURL, to: dataDirectory.appendingPathComponent("before-restore-\(UUID().uuidString).json")) }
                try imageStore.install(prepared.images)
                saveBlocked = false
                call("restorePrepared", [NSNull(), prepared.state])
            } catch { call("restorePrepared", ["恢复前备份失败：\(error.localizedDescription)"]) }
        case "showDataFolder": NSWorkspace.shared.open(dataDirectory)
        case "openURL":
            if let raw = body["url"] as? String, let url = URL(string: raw), ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") { NSWorkspace.shared.open(url) }
        default: break
        }
    }
    func readText(_ url: URL, limit: Int = 50_000_000) throws -> String {
        let attrs = try fm.attributesOfItem(atPath: url.path)
        if (attrs[.size] as? NSNumber)?.intValue ?? 0 > limit { throw NSError(domain: "Biweekly", code: 1, userInfo: [NSLocalizedDescriptionKey: "文件超过 \(limit / 1_000_000) MB，请拆分后导入。"] ) }
        return try String(contentsOf: url, encoding: .utf8)
    }
    func importFile(_ url: URL, target: String) {
        do { call("imported", [try readText(url), url.lastPathComponent, target]) }
        catch { call("error", ["导入失败：\(error.localizedDescription)"]) }
    }
    func application(_ application: NSApplication, open urls: [URL]) {
        if webView == nil || webView.isLoading { pendingFiles += urls } else { urls.forEach { importFile($0, target: "tasks") } }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.navigationType == .linkActivated { if let url = navigationAction.request.url, ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") { NSWorkspace.shared.open(url) }; decisionHandler(.cancel); return }
        decisionHandler(navigationAction.request.url?.isFileURL == true ? .allow : .cancel)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if terminating || webView == nil { return .terminateNow }
        terminating = true
        webView.evaluateJavaScript("window.BiweeklyNative?.flush()") { _, _ in NSApp.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }
    func fatalAlert(_ message: String) { let alert = NSAlert(); alert.messageText = "双周无法启动"; alert.informativeText = message; alert.runModal(); NSApp.terminate(nil) }
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
