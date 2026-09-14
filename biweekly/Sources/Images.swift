import Cocoa
import WebKit
import ImageIO
import CryptoKit
import UniformTypeIdentifiers

func biweeklyError(_ text: String) -> NSError {
    NSError(domain: "Biweekly", code: 1, userInfo: [NSLocalizedDescriptionKey: text])
}

final class ImageStore: NSObject, WKURLSchemeHandler {
    static let prefix = "biweekly-image://local/"
    static let pattern = #"biweekly-image://local/([a-f0-9]{64}\.png)"#
    let directory: URL
    let fm = FileManager.default
    init(root: URL) { directory = root.appendingPathComponent("images", isDirectory: true) }
    func validName(_ name: String) -> Bool { name.range(of: #"^[a-f0-9]{64}\.png$"#, options: .regularExpression) != nil }
    func file(_ name: String) throws -> URL {
        guard validName(name) else { throw biweeklyError("图片附件名称无效。") }
        return directory.appendingPathComponent(name)
    }
    func names(in text: String) -> Set<String> {
        let regex = try! NSRegularExpression(pattern: Self.pattern)
        let ns = text as NSString
        return Set(regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { ns.substring(with: $0.range(at: 1)) })
    }
    func hasClipboardImage(_ board: NSPasteboard) -> Bool {
        board.availableType(from: [.png, .tiff, NSPasteboard.PasteboardType("public.jpeg")]) != nil
    }
    func clipboardImage(_ board: NSPasteboard) throws -> String {
        guard let type = board.availableType(from: [.png, .tiff, NSPasteboard.PasteboardType("public.jpeg")]), let data = board.data(forType: type) else { throw biweeklyError("剪贴板中没有图片。先复制图片或截图，再粘贴。") }
        return try store(data)
    }
    func store(_ input: Data) throws -> String {
        guard input.count <= 30_000_000, let source = CGImageSourceCreateWithData(input as CFData, nil), CGImageSourceGetCount(source) > 0 else { throw biweeklyError("无法读取图片，或图片超过 30 MB。") }
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 4096]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { throw biweeklyError("图片格式无法解码。") }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.png.identifier as CFString, 1, nil) else { throw biweeklyError("无法保存图片。") }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination), output.length <= 20_000_000 else { throw biweeklyError("图片过大，请裁剪后重试。") }
        let data = output as Data
        let name = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() + ".png"
        try install([name: data])
        return Self.prefix + name
    }
    func install(_ images: [String: Data]) throws {
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        for (name, data) in images {
            let url = try file(name)
            if (try? Data(contentsOf: url)) != data { try data.write(to: url, options: .atomic) }
        }
    }
    func data(_ name: String) throws -> Data {
        do { return try Data(contentsOf: file(name)) }
        catch { throw biweeklyError("找不到图片附件 \(name.prefix(12))，请恢复包含图片的完整备份。") }
    }
    func backup(_ text: String) throws -> String {
        guard let input = text.data(using: .utf8), var object = try JSONSerialization.jsonObject(with: input) as? [String: Any] else { throw biweeklyError("备份格式无效。") }
        var attachments: [String: String] = [:]
        var size = input.count
        for name in names(in: text) {
            let bytes = try data(name); size += (bytes.count * 4 / 3)
            guard size <= 200_000_000 else { throw biweeklyError("完整备份超过 200 MB。可以直接备份整个数据目录。") }
            attachments[name] = bytes.base64EncodedString()
        }
        if !attachments.isEmpty { object["imageAttachments"] = attachments }
        return String(data: try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]), encoding: .utf8)!
    }
    func prepareRestore(_ text: String) throws -> (state: [String: Any], images: [String: Data]) {
        guard let bytes = text.data(using: .utf8), bytes.count <= 200_000_000, var object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw biweeklyError("备份格式无效或超过 200 MB。") }
        let raw = object.removeValue(forKey: "imageAttachments")
        guard raw == nil || raw is [String: String] else { throw biweeklyError("备份中的图片附件格式无效。") }
        var images: [String: Data] = [:]
        for (name, encoded) in raw as? [String: String] ?? [:] {
            guard validName(name), let data = Data(base64Encoded: encoded), data.count <= 20_000_000,
                  SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() + ".png" == name,
                  let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetType(source) as String? == UTType.png.identifier else { throw biweeklyError("备份中的图片附件损坏。") }
            images[name] = data
        }
        let clean = String(data: try JSONSerialization.data(withJSONObject: object, options: .withoutEscapingSlashes), encoding: .utf8)!
        guard clean.utf8.count <= 50_000_000 else { throw biweeklyError("任务元数据超过 50 MB。") }
        for name in names(in: clean) where images[name] == nil {
            guard fm.fileExists(atPath: try file(name).path) else { throw biweeklyError("备份缺少图片附件，请选择完整备份。") }
        }
        return (object, images)
    }
    func portableMarkdown(_ text: String) throws -> String {
        var result = text
        for name in names(in: text) {
            let replacement = "data:image/png;base64," + (try data(name)).base64EncodedString()
            let count = result.components(separatedBy: Self.prefix + name).count - 1
            guard result.utf8.count + replacement.utf8.count * count <= 200_000_000 else { throw biweeklyError("包含图片的 Markdown 超过 200 MB，请分双周导出。") }
            result = result.replacingOccurrences(of: Self.prefix + name, with: replacement)
        }
        return result
    }
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        do {
            guard let url = urlSchemeTask.request.url, url.host == "local", url.query == nil, url.fragment == nil, url.pathComponents.count == 2 else { throw biweeklyError("图片地址无效。") }
            let bytes = try data(url.lastPathComponent)
            let response = URLResponse(url: url, mimeType: "image/png", expectedContentLength: bytes.count, textEncodingName: nil)
            urlSchemeTask.didReceive(response); urlSchemeTask.didReceive(bytes); urlSchemeTask.didFinish()
        } catch { urlSchemeTask.didFailWithError(error) }
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) { }
}
