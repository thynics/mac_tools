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
                let readback = CommandLine.arguments.contains("--readback")
                if readback {
                    let found = try await webView.evaluateJavaScript("Array.from(document.querySelectorAll('.task-title')).some(x=>x.textContent==='Native persistence check')")
                    guard found as? Bool == true else { throw NSError(domain: "Test", code: 2, userInfo: [NSLocalizedDescriptionKey: "Task was not persisted across native launches"]) }
                    let stored = try Data(contentsOf: storeURL)
                    guard String(data: stored, encoding: .utf8)!.contains("Native persistence check") else { throw NSError(domain: "Test", code: 3) }
                } else {
                    let count = try await webView.evaluateJavaScript("document.querySelectorAll('.task-row.doing').length")
                    guard count as? Int == 3 else { throw NSError(domain: "Test", code: 4, userInfo: [NSLocalizedDescriptionKey: "Wrong Doing count: \(String(describing: count))"]) }
                    _ = try await webView.evaluateJavaScript("document.querySelector('.task-row.doing .task-title').click(); true")
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
                    _ = try await webView.evaluateJavaScript("window.BiweeklyNative.command('all'); document.querySelector('#new-task').value='Native persistence check'; document.querySelector('#quick-add').requestSubmit(); true")
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
}
