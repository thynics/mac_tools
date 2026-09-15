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
                    let records = try await webView.evaluateJavaScript("JSON.stringify(selected().attachments)") as! String
                    let files = try JSONDecoder().decode([FileAttachment].self, from: Data(records.utf8))
                    guard files.count == 3 else { throw biweeklyError("Attachment metadata was not persisted across restart") }
                    for file in files { guard try attachmentStore.data(file.path).count == file.size else { throw biweeklyError("Attachment copy is missing after restart") } }
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
                    try await verifyFileAttachments()
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

    @MainActor func verifyFileAttachments() async throws {
        let sources = dataDirectory.appendingPathComponent("source-files")
        try fm.createDirectory(at: sources.appendingPathComponent("a"), withIntermediateDirectories: true)
        try fm.createDirectory(at: sources.appendingPathComponent("b"), withIntermediateDirectories: true)
        let filename = "实验记录 [v1] (final).txt"
        let first = sources.appendingPathComponent("a").appendingPathComponent(filename)
        let second = sources.appendingPathComponent("b").appendingPathComponent(filename)
        let bytesA = Data("first independent snapshot\n".utf8), bytesB = Data("second independent snapshot\n".utf8)
        try bytesA.write(to: first); try bytesB.write(to: second)
        let request = try await webView.evaluateJavaScript("beginAttachmentRequest()") as! String
        importAttachments([first, second], request: request)
        var ready = false
        for _ in 0..<60 {
            if (try await webView.evaluateJavaScript("selected().attachments?.length===2 && pendingFileAttachments.size===0")) as? Bool == true { ready = true; break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        guard ready else { throw biweeklyError("Native attach callback did not create the two attachment cards") }
        var recordsJSON = try await webView.evaluateJavaScript("JSON.stringify(selected().attachments)") as! String
        var records = try JSONDecoder().decode([FileAttachment].self, from: Data(recordsJSON.utf8))
        guard records[0].name == filename, records[1].name == filename, records[0].path != records[1].path else { throw biweeklyError("Same-name files overwrote each other") }
        try Data("changed source".utf8).write(to: first)
        try fm.removeItem(at: sources)
        guard try attachmentStore.data(records[0].path) == bytesA, try attachmentStore.data(records[1].path) == bytesB else { throw biweeklyError("Attachment was linked to its source instead of copied") }
        _ = try await webView.evaluateJavaScript("""
        (()=>{const transfer=new DataTransfer();transfer.items.add(new File(['{"ok":true}'],'dragged.json',{type:'application/json'}));document.querySelector('#attachment-section').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));return true;})()
        """)
        ready = false
        for _ in 0..<60 {
            if (try await webView.evaluateJavaScript("selected().attachments?.length===3 && pendingFileAttachments.size===0")) as? Bool == true { ready = true; break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        guard ready else { throw biweeklyError("WebKit file drop did not copy its bytes into the managed folder") }
        recordsJSON = try await webView.evaluateJavaScript("JSON.stringify(selected().attachments)") as! String
        records = try JSONDecoder().decode([FileAttachment].self, from: Data(recordsJSON.utf8))
        let text = try await webView.evaluateJavaScript("JSON.stringify(state)") as! String
        let payload = try attachmentStore.backup(imageStore.backup(text))
        let freshRoot = dataDirectory.appendingPathComponent("fresh-files-restore")
        let freshFiles = AttachmentStore(root: freshRoot), freshImages = ImageStore(root: freshRoot)
        let fileBackup = try freshFiles.prepareRestore(payload)
        let remaining = String(data: try JSONSerialization.data(withJSONObject: fileBackup.state, options: .withoutEscapingSlashes), encoding: .utf8)!
        let imageBackup = try freshImages.prepareRestore(remaining)
        try freshFiles.install(fileBackup.files); try freshImages.install(imageBackup.images)
        guard imageBackup.state["fileAttachments"] == nil, imageBackup.state["imageAttachments"] == nil else { throw biweeklyError("Binary backup payload leaked into task metadata") }
        for file in records { guard try freshFiles.data(file.path) == attachmentStore.data(file.path) else { throw biweeklyError("Portable backup did not restore attachment bytes") } }
        let repo = dataDirectory.appendingPathComponent("git-snapshot")
        let object = try JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any]
        try attachmentStore.copyReferencedFiles(object, to: repo)
        try text.write(to: repo.appendingPathComponent("data.json"), atomically: true, encoding: .utf8)
        let hydrated = try attachmentStore.hydrateBackup(text, beside: repo.appendingPathComponent("data.json"))
        guard hydrated.contains("fileAttachments") else { throw biweeklyError("Git snapshot could not supply its attachment files on restore") }
        for file in records { guard try Data(contentsOf: attachmentStore.file(file.path, base: repo)) == attachmentStore.data(file.path) else { throw biweeklyError("Git snapshot omitted an attachment") } }
        let markdown = try await webView.evaluateJavaScript("MarkdownIO.exportMarkdown(current())") as! String
        let target = dataDirectory.appendingPathComponent("exported-note.md")
        let portable = try attachmentStore.portableMarkdown(imageStore.portableMarkdown(markdown), at: target)
        guard !portable.contains(AttachmentStore.prefix), portable.contains("exported-note-attachments/") else { throw biweeklyError("Markdown attachment links were not portable") }
        for file in records {
            let value = try attachmentStore.parts(file.path)
            let copied = dataDirectory.appendingPathComponent("exported-note-attachments").appendingPathComponent(value.hash).appendingPathComponent(file.name)
            guard try Data(contentsOf: copied) == attachmentStore.data(file.path) else { throw biweeklyError("Markdown export lost a file") }
        }
        do { _ = try attachmentStore.file("attachments/../../secret"); throw biweeklyError("Unsafe attachment path was not rejected") }
        catch { guard error.localizedDescription.contains("路径无效") else { throw error } }
    }

}
