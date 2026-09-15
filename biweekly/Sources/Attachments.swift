import Foundation
import CryptoKit

struct FileAttachment: Codable {
    let name: String
    let path: String
    let size: Int
    let addedAt: String
    var object: [String: Any] { ["name": name, "path": path, "size": size, "addedAt": addedAt] }
}

final class AttachmentStore {
    static let limit = 50_000_000
    static let prefix = "biweekly-file://local/"
    let root: URL
    let fm = FileManager.default
    init(root: URL) { self.root = root }
    var directory: URL { root.appendingPathComponent("attachments", isDirectory: true) }
    func validName(_ name: String) -> Bool {
        !name.isEmpty && name != "." && name != ".." && name.utf8.count <= 255 &&
        name.rangeOfCharacter(from: .controlCharacters) == nil && !name.contains("/") && !name.contains("\\")
    }
    func parts(_ path: String) throws -> (hash: String, name: String) {
        let components = path.split(separator: "/", omittingEmptySubsequences: false)
        guard components.count == 3, components[0] == "attachments",
              components[1].range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil,
              validName(String(components[2])) else { throw biweeklyError("文件附件路径无效。") }
        return (String(components[1]), String(components[2]))
    }
    func file(_ path: String, base: URL? = nil) throws -> URL {
        let value = try parts(path)
        let container = (base ?? root).appendingPathComponent("attachments", isDirectory: true).resolvingSymlinksInPath()
        let url = container.appendingPathComponent(value.hash, isDirectory: true).appendingPathComponent(value.name)
        guard url.resolvingSymlinksInPath().path.hasPrefix(container.path + "/") else { throw biweeklyError("文件附件路径无效。") }
        return url
    }
    func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    func read(_ url: URL) throws -> Data {
        let properties = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard properties.isRegularFile == true else { throw biweeklyError("只能附加文件；文件夹请先压缩。") }
        guard (properties.fileSize ?? 0) <= Self.limit else { throw biweeklyError("单个文件不能超过 50 MB。") }
        let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
        var result = Data()
        while let chunk = try handle.read(upToCount: min(1_048_576, Self.limit + 1 - result.count)), !chunk.isEmpty {
            result.append(chunk)
            guard result.count <= Self.limit else { throw biweeklyError("单个文件不能超过 50 MB。") }
        }
        return result
    }
    func data(_ path: String) throws -> Data {
        do { return try read(file(path)) }
        catch { throw biweeklyError("无法读取附件，请恢复包含文件的完整备份：\(try parts(path).name)") }
    }
    func store(_ source: URL) throws -> FileAttachment {
        let name = source.lastPathComponent
        // Resolve source symlinks before reading: an attachment is always an independent copy.
        return try store(data: read(source.resolvingSymlinksInPath()), name: name)
    }
    func store(data: Data, name: String) throws -> FileAttachment {
        guard validName(name) else { throw biweeklyError("文件名无效或过长。") }
        guard data.count <= Self.limit else { throw biweeklyError("单个文件不能超过 50 MB。") }
        let path = "attachments/" + digest(data) + "/" + name
        try install([path: data])
        return FileAttachment(name: name, path: path, size: data.count, addedAt: ISO8601DateFormatter().string(from: Date()))
    }
    func install(_ files: [String: Data]) throws {
        for (path, bytes) in files {
            guard bytes.count <= Self.limit, try parts(path).hash == digest(bytes) else { throw biweeklyError("文件附件校验失败。") }
            let url = try file(path)
            try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            if (try? Data(contentsOf: url)) != bytes { try bytes.write(to: url, options: .atomic) }
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        }
    }
    func references(_ object: [String: Any]) throws -> [String: FileAttachment] {
        var result: [String: FileAttachment] = [:]
        func visit(_ node: [String: Any], depth: Int = 0) throws {
            guard depth <= 34 else { throw biweeklyError("任务层级无效。") }
            if let raw = node["attachments"] {
                guard let list = raw as? [[String: Any]], list.count <= 500 else { throw biweeklyError("文件附件元数据无效。") }
                for item in list {
                    let record = try JSONDecoder().decode(FileAttachment.self, from: JSONSerialization.data(withJSONObject: item))
                    guard try parts(record.path).name == record.name, (0...Self.limit).contains(record.size), ISO8601DateFormatter().date(from: record.addedAt) != nil else { throw biweeklyError("文件附件元数据无效。") }
                    if let old = result[record.path], old.size != record.size { throw biweeklyError("同一附件的大小不一致。") }
                    result[record.path] = record
                }
            }
            for task in node["tasks"] as? [[String: Any]] ?? [] { try visit(task, depth: depth + 1) }
            for child in node["children"] as? [[String: Any]] ?? [] { try visit(child, depth: depth + 1) }
        }
        for cycle in object["cycles"] as? [[String: Any]] ?? [] { try visit(cycle) }
        return result
    }
    func backup(_ text: String) throws -> String {
        guard let bytes = text.data(using: .utf8), var object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw biweeklyError("备份格式无效。") }
        var payload: [String: String] = [:], size = bytes.count
        for (path, record) in try references(object) {
            let bytes = try data(path)
            guard bytes.count == record.size, digest(bytes) == (try parts(path).hash) else { throw biweeklyError("文件附件已损坏：\(record.name)") }
            size += (bytes.count + 2) / 3 * 4
            guard size <= 200_000_000 else { throw biweeklyError("完整备份超过 200 MB。请备份整个数据目录。") }
            payload[path] = bytes.base64EncodedString()
        }
        if !payload.isEmpty { object["fileAttachments"] = payload }
        return String(data: try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]), encoding: .utf8)!
    }
    func prepareRestore(_ text: String) throws -> (state: [String: Any], files: [String: Data]) {
        guard let raw = text.data(using: .utf8), raw.count <= 200_000_000, var object = try JSONSerialization.jsonObject(with: raw) as? [String: Any] else { throw biweeklyError("备份格式无效或超过 200 MB。") }
        let payload = object.removeValue(forKey: "fileAttachments")
        guard payload == nil || payload is [String: String] else { throw biweeklyError("备份中的文件附件格式无效。") }
        var files: [String: Data] = [:]
        for (path, encoded) in payload as? [String: String] ?? [:] {
            let value = try parts(path)
            guard let bytes = Data(base64Encoded: encoded), bytes.count <= Self.limit, digest(bytes) == value.hash else { throw biweeklyError("备份中的文件附件已损坏。") }
            files[path] = bytes
        }
        for (path, record) in try references(object) {
            let bytes = try files[path] ?? data(path)
            guard bytes.count == record.size, digest(bytes) == (try parts(path).hash) else { throw biweeklyError("备份缺少正确的文件附件：\(record.name)") }
        }
        return (object, files)
    }
    func hydrateBackup(_ text: String, beside source: URL) throws -> String {
        guard var object = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else { throw biweeklyError("备份格式无效。") }
        if object["fileAttachments"] == nil {
            var files: [String: String] = [:], size = text.utf8.count
            for (path, _) in try references(object) {
                let candidate = try file(path, base: source.deletingLastPathComponent())
                if fm.fileExists(atPath: candidate.path) {
                    let bytes = try read(candidate); size += (bytes.count + 2) / 3 * 4
                    guard size <= 200_000_000 else { throw biweeklyError("包含文件的备份超过 200 MB。") }
                    files[path] = bytes.base64EncodedString()
                }
            }
            if !files.isEmpty { object["fileAttachments"] = files }
        }
        return String(data: try JSONSerialization.data(withJSONObject: object, options: .withoutEscapingSlashes), encoding: .utf8)!
    }
    func copyReferencedFiles(_ object: [String: Any], to destination: URL) throws {
        for (path, record) in try references(object) {
            let bytes = try data(path)
            guard bytes.count == record.size, digest(bytes) == (try parts(path).hash) else { throw biweeklyError("文件附件已损坏：\(record.name)") }
            let target = try file(path, base: destination)
            try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            if (try? Data(contentsOf: target)) != bytes { try bytes.write(to: target, options: .atomic) }
        }
    }
    func path(from uri: String) throws -> String {
        guard uri.hasPrefix(Self.prefix) else { throw biweeklyError("附件地址无效。") }
        let tail = String(uri.dropFirst(Self.prefix.count))
        guard let decoded = tail.removingPercentEncoding else { throw biweeklyError("附件地址无效。") }
        let path = "attachments/" + decoded; _ = try parts(path); return path
    }
    func portableMarkdown(_ text: String, at destination: URL) throws -> String {
        let regex = try NSRegularExpression(pattern: #"biweekly-file://local/[a-f0-9]{64}/[A-Za-z0-9._~%\-]+"#)
        let original = text as NSString
        let links = Set(regex.matches(in: text, range: NSRange(location: 0, length: original.length)).map { original.substring(with: $0.range) })
        let folder = destination.deletingPathExtension().lastPathComponent + "-attachments"
        let base = destination.deletingLastPathComponent().appendingPathComponent(folder, isDirectory: true)
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        var result = text
        for uri in links {
            let path = try path(from: uri), value = try parts(path), bytes = try data(path)
            let target = base.appendingPathComponent(value.hash).appendingPathComponent(value.name)
            try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            try bytes.write(to: target, options: .atomic)
            let relative = [folder, value.hash, value.name].map { $0.addingPercentEncoding(withAllowedCharacters: allowed)! }.joined(separator: "/")
            result = result.replacingOccurrences(of: uri, with: relative)
        }
        return result
    }
}
