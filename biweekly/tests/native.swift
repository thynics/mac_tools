import Cocoa
import WebKit

extension AppDelegate {
    func runUITests() {
        Task { @MainActor in
            do {
                let output = ProcessInfo.processInfo.environment["NATIVE_TEST_OUTPUT"] ?? NSTemporaryDirectory()
                let directory = URL(fileURLWithPath: output, isDirectory: true)
                try fm.createDirectory(at: directory, withIntermediateDirectories: true)
                var ready = false
                for _ in 0..<80 {
                    if let result = try? await webView.evaluateJavaScript("window.__ready === true"), result as? Bool == true { ready = true; break }
                    try await Task.sleep(nanoseconds: 100_000_000)
                }
                guard ready else { throw NSError(domain: "Test", code: 1, userInfo: [NSLocalizedDescriptionKey: "WebKit did not initialize"]) }
                var saved = false
                for _ in 0..<40 {
                    let label = try await webView.evaluateJavaScript("document.querySelector('#save-label').textContent")
                    if (label as? String)?.contains("已保存") == true { saved = true; break }
                    try await Task.sleep(nanoseconds: 100_000_000)
                }
                guard saved else { throw NSError(domain: "Test", code: 7, userInfo: [NSLocalizedDescriptionKey: "Native save acknowledgement did not arrive"]) }
                let readback = CommandLine.arguments.contains("--readback")
                if readback {
                    let found = try await webView.evaluateJavaScript("Array.from(document.querySelectorAll('.task-title')).some(x=>x.textContent==='Native persistence check')")
                    guard found as? Bool == true else { throw NSError(domain: "Test", code: 2, userInfo: [NSLocalizedDescriptionKey: "Task was not persisted across native launches"]) }
                    let order = try await webView.evaluateJavaScript("current().tasks.at(-2).title === 'Native persistence check'")
                    guard order as? Bool == true else { throw NSError(domain: "Test", code: 9, userInfo: [NSLocalizedDescriptionKey: "Reordered task did not retain its position after restart"]) }
                    _ = try await webView.evaluateJavaScript("document.querySelector('.task-row.doing .task-title').click(); true")
                    var pictureLoaded = false
                    for _ in 0..<30 {
                        if (try await webView.evaluateJavaScript("document.querySelector('#note-rendered img')?.naturalWidth > 0")) as? Bool == true { pictureLoaded = true; break }
                        try await Task.sleep(nanoseconds: 100_000_000)
                    }
                    guard pictureLoaded else { throw biweeklyError("Image was not restored after native restart") }
                    let stored = try Data(contentsOf: storeURL)
                    guard String(data: stored, encoding: .utf8)!.contains("Native persistence check") else { throw NSError(domain: "Test", code: 3) }
                } else {
                    let count = try await webView.evaluateJavaScript("document.querySelectorAll('.task-row.doing').length")
                    guard count as? Int == 3 else { throw NSError(domain: "Test", code: 4, userInfo: [NSLocalizedDescriptionKey: "Wrong Doing count: \(String(describing: count))"]) }
                    let reordered = try await webView.evaluateJavaScript("""
                    (()=>{
                      const roots=[...document.querySelectorAll('.task-row.root')],source=roots[1],target=roots[0];
                      const transfer=new DataTransfer(),box=target.getBoundingClientRect();
                      source.querySelector('[data-drag]').dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:transfer,clientX:box.left+8,clientY:box.top+8}));
                      target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer,clientX:box.left+80,clientY:box.top+2}));
                      target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer,clientX:box.left+80,clientY:box.top+2}));
                      const passed=document.querySelector('.task-row.root').dataset.id===source.dataset.id;
                      window.BiweeklyNative.command('undo');return passed;
                    })()
                    """)
                    guard reordered as? Bool == true else { throw NSError(domain: "Test", code: 8, userInfo: [NSLocalizedDescriptionKey: "WebKit drag handlers failed to reorder the task group"]) }
                    _ = try await webView.evaluateJavaScript("document.querySelector('.task-row.doing .task-title').click(); true")
                    try await verifyImageNotes()
                    let screenshot = try await webView.takeSnapshot(configuration: nil)
                    let png = NSBitmapImageRep(data: screenshot.tiffRepresentation!)!.representation(using: .png, properties: [:])!
                    try png.write(to: directory.appendingPathComponent("native-preview.png"))
                    try await Task.sleep(nanoseconds: 300_000_000)
                    _ = try await webView.evaluateJavaScript("window.BiweeklyNative.restore(JSON.stringify(state)); document.querySelector('#restore-confirm').click(); true")
                    for _ in 0..<30 {
                        let isOpen = try await webView.evaluateJavaScript("document.querySelector('#modal').open")
                        if isOpen as? Bool == false { break }
                        try await Task.sleep(nanoseconds: 100_000_000)
                    }
                    let backups = try fm.contentsOfDirectory(atPath: dataDirectory.path)
                    guard backups.contains(where: { $0.hasPrefix("before-restore-") }) else { throw NSError(domain: "Test", code: 6, userInfo: [NSLocalizedDescriptionKey: "Native restore did not preserve the old data"]) }
                    _ = try await webView.evaluateJavaScript("document.querySelector('#focus-doing').click(); true")
                    let doingRows = try await webView.evaluateJavaScript("document.querySelectorAll('.task-row').length")
                    guard doingRows as? Int == 6 else { throw NSError(domain: "Test", code: 5) }
                    _ = try await webView.evaluateJavaScript("window.BiweeklyNative.command('all'); document.querySelector('#new-task').value='Native persistence check'; document.querySelector('#quick-add').requestSubmit(); moveStep(current().tasks.at(-1).id,-1); true")
                }
                let report = "PASS: native WebKit \(readback ? "restart and disk persistence" : "rendering, Doing focus, restore safety copy, native save and quit flush")\n"
                try report.write(to: directory.appendingPathComponent(readback ? "readback.txt" : "native.txt"), atomically: true, encoding: .utf8)
                print(report)
                NSApp.terminate(nil)
            } catch {
                fputs("FAIL: \(error)\n", stderr)
                exit(1)
            }
        }
    }
    @MainActor func verifyImageNotes() async throws {
        let board = NSPasteboard.withUniqueName(); testPasteboard = board
        defer { board.releaseGlobally(); testPasteboard = nil }
        let fixture = NSImage(size: NSSize(width: 320, height: 120))
        fixture.lockFocus()
        NSColor(calibratedRed: 0.44, green: 0.38, blue: 0.8, alpha: 1).setFill()
        NSBezierPath(rect: NSRect(x: 0, y: 0, width: 320, height: 120)).fill()
        ("Image note · local backup" as NSString).draw(at: NSPoint(x: 24, y: 48), withAttributes: [.foregroundColor: NSColor.white, .font: NSFont.systemFont(ofSize: 18)])
        fixture.unlockFocus()
        let png = NSBitmapImageRep(data: fixture.tiffRepresentation!)!.representation(using: .png, properties: [:])!
        board.setData(png, forType: .png)
        smartPaste()
        var loaded = false
        for _ in 0..<40 {
            if (try await webView.evaluateJavaScript("document.querySelector('#note-rendered img')?.naturalWidth > 0")) as? Bool == true { loaded = true; break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        guard loaded else { throw biweeklyError("Native clipboard image did not load through the local URL handler") }
        let text = try await webView.evaluateJavaScript("JSON.stringify(state)") as! String
        guard text.contains(ImageStore.prefix), !text.contains("base64") else { throw biweeklyError("Image should be a local attachment, not inline data") }
        let names = imageStore.names(in: text)
        guard names.count == 1 else { throw biweeklyError("Missing image attachment") }
        _ = try imageStore.clipboardImage(board)
        guard try fm.contentsOfDirectory(atPath: imageStore.directory.path).count == 1 else { throw biweeklyError("Duplicate image data was not deduplicated") }
        let backup = try imageStore.backup(text)
        let fresh = ImageStore(root: dataDirectory.appendingPathComponent("fresh-restore"))
        let restored = try fresh.prepareRestore(backup); try fresh.install(restored.images)
        guard restored.state["imageAttachments"] == nil, restored.images.count == 1,
              try fresh.data(names.first!) == imageStore.data(names.first!) else { throw biweeklyError("Portable image backup did not restore independently") }
        let md = try await webView.evaluateJavaScript("MarkdownIO.exportMarkdown(current())") as! String
        let portable = try imageStore.portableMarkdown(md)
        guard portable.contains("data:image/png;base64,"), !portable.contains(ImageStore.prefix) else { throw biweeklyError("Markdown export did not carry the image") }
        do { _ = try imageStore.file("../../data.json"); throw biweeklyError("Traversal was not rejected") }
        catch { guard error.localizedDescription.contains("名称无效") else { throw error } }
        guard try GitBackup.repository("git@github.com:example/repo.git").path.hasSuffix("github.com/example/repo") else { throw biweeklyError("Canonical git path is wrong") }
        do { _ = try GitBackup.repository("ext::malicious"); throw biweeklyError("Unsafe remote was not rejected") }
        catch { guard error.localizedDescription.contains("仓库地址") else { throw error } }
    }

}
