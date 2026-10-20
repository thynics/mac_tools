import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 River Club", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "退出 River Club", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        menu.addItem(editItem)
        NSApp.mainMenu = menu
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1400, height: 900), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "River Club · 德州扑克"
        window.minSize = NSSize(width: 920, height: 780)
        window.center()
        window.isReleasedWhenClosed = false
        let config = WKWebViewConfiguration()
        config.websiteDataStore = CommandLine.arguments.contains("--smoke-test") ? .nonPersistent() : .default()
        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        window.contentView!.addSubview(webView)
        guard let resource = Bundle.main.resourceURL else { return }
        webView.loadFileURL(resource.appendingPathComponent("web/index.html"), allowingReadAccessTo: resource)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if CommandLine.arguments.contains("--smoke-test") {
            let script = """
            (() => {
              RiverClub.start(27);
              const h = RiverClub.hand;
              if (RiverClub.groups.length !== 3 || h.players[0].hole.length !== 2 ||
                  h.players.reduce((s,p)=>s+p.stack+p.totalBet,0) !== 9000)
                throw new Error('Native engine integration failed');
              return JSON.stringify({players: RiverClub.tournament.players.length,
                tables: RiverClub.groups.length, cards: h.players[0].hole.length,
                chips: h.players.reduce((s,p)=>s+p.stack+p.totalBet,0),
                localStorage: typeof localStorage.setItem === 'function',
                board: document.querySelectorAll('#board .card').length});
            })();
            """
            webView.evaluateJavaScript(script) { result, error in
                if let error = error { fputs("WK_SMOKE_ERROR: \(error)\n", stderr); exit(1) }
                guard let value = result as? String else { exit(1) }
                print("WK_SMOKE_OK: \(value)")
                fflush(stdout)
                // Smoke testing never replaces a real saved game.
                webView.evaluateJavaScript("localStorage.removeItem('river-club-v1')") { _, _ in NSApp.terminate(nil) }
            }
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let scheme = navigationAction.request.url?.scheme
        decisionHandler(scheme == "file" || scheme == "about" ? .allow : .cancel)
    }
}
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
