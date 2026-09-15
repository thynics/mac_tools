import Foundation

struct GitBackupConfiguration: Codable {
    var enabled = false
    var remote = ""
    var intervalMinutes = 5
    var deviceID = "device-" + UUID().uuidString.lowercased().prefix(12)
}

final class GitBackup {
    let root: URL
    let images: ImageStore
    let fm = FileManager.default
    var configuration: GitBackupConfiguration
    var timer: Timer?
    var running = false
    var status = "未启用 Git 备份"
    var lastSync = ""
    var failure = false
    var onStatus: (([String: Any]) -> Void)?
    private let queue = DispatchQueue(label: "com.thynics.biweekly.git", qos: .utility)
    var configurationURL: URL { root.appendingPathComponent("git-backup.json") }

    init(root: URL, images: ImageStore) {
        self.root = root; self.images = images
        configuration = (try? JSONDecoder().decode(GitBackupConfiguration.self, from: Data(contentsOf: root.appendingPathComponent("git-backup.json")))) ?? GitBackupConfiguration()
    }
    static func repository(_ remote: String) throws -> URL {
        let host: String, path: String
        if remote.hasPrefix("git@"), let colon = remote.firstIndex(of: ":") {
            host = String(remote[remote.index(remote.startIndex, offsetBy: 4)..<colon]); path = String(remote[remote.index(after: colon)...])
        } else if let url = URLComponents(string: remote), ["https", "ssh"].contains(url.scheme ?? ""), let hostname = url.host, url.query == nil, url.fragment == nil, url.password == nil, url.user == nil || url.user == "git" {
            host = hostname; path = String(url.path.drop(while: { $0 == "/" }))
        } else { throw biweeklyError("请输入 Git SSH 或 HTTPS 仓库地址。") }
        let clean = path.hasSuffix(".git") ? String(path.dropLast(4)) : path
        let parts = clean.split(separator: "/", omittingEmptySubsequences: false)
        guard host.range(of: #"^[A-Za-z0-9.-]+$"#, options: .regularExpression) != nil, !host.hasPrefix("-"), host != ".", host != "..", parts.count >= 2,
              parts.allSatisfy({ $0 != "." && $0 != ".." && $0.range(of: #"^[A-Za-z0-9_.-]+$"#, options: .regularExpression) != nil }) else { throw biweeklyError("仓库地址或命名空间无效。") }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(host).appendingPathComponent(clean, isDirectory: true)
    }
    func info() -> [String: Any] {
        ["enabled": configuration.enabled, "remote": configuration.remote, "intervalMinutes": configuration.intervalMinutes,
         "repository": (try? Self.repository(configuration.remote).path) ?? "", "deviceID": configuration.deviceID,
         "running": running, "status": status, "lastSync": lastSync, "failure": failure]
    }
    func publish() { onStatus?(info()) }
    func start() {
        timer?.invalidate(); timer = nil
        guard configuration.enabled else { status = "未启用 Git 备份"; publish(); return }
        let interval = max(1, min(configuration.intervalMinutes, 1440))
        status = "等待 Git 备份"; publish()
        timer = Timer.scheduledTimer(withTimeInterval: Double(interval * 60), repeats: true) { [weak self] _ in self?.sync() }
    }
    func configure(enabled: Bool, remote: String, interval: Int) throws {
        guard !running else { throw biweeklyError("Git 备份正在进行，请完成后再修改设置。") }
        let remote = remote.trimmingCharacters(in: .whitespacesAndNewlines)
        if enabled || !remote.isEmpty { _ = try Self.repository(remote) }
        guard (1...1440).contains(interval) else { throw biweeklyError("备份间隔应为 1—1440 分钟。") }
        var next = configuration; next.enabled = enabled; next.remote = remote; next.intervalMinutes = interval
        try JSONEncoder().encode(next).write(to: configurationURL, options: .atomic)
        configuration = next; failure = false; start()
        if enabled { sync() }
    }
    func sync() {
        guard configuration.enabled, !running else { return }
        let config = configuration
        running = true; failure = false; status = "Git 备份中…"; publish()
        queue.async { [self] in
            let result: Result<String, Error>
            do { result = .success(try perform(config)) } catch { result = .failure(error) }
            DispatchQueue.main.async { [self] in
                running = false
                switch result {
                case .success(let text):
                    let formatter = DateFormatter(); formatter.dateFormat = "HH:mm"
                    lastSync = formatter.string(from: Date()); status = text + " · " + lastSync; failure = false
                case .failure(let error): status = error.localizedDescription; failure = true
                }
                publish()
            }
        }
    }
    struct CommandResult { let code: Int32; let output: String }
    func git(_ args: [String], at directory: URL? = nil, allowFailure: Bool = false) throws -> CommandResult {
        let log = fm.temporaryDirectory.appendingPathComponent("biweekly-git-\(UUID().uuidString).log")
        fm.createFile(atPath: log.path, contents: nil)
        let handle = try FileHandle(forWritingTo: log)
        defer { try? handle.close(); try? fm.removeItem(at: log) }
        let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/git"); process.arguments = args; process.currentDirectoryURL = directory
        process.standardOutput = handle; process.standardError = handle; process.standardInput = FileHandle.nullDevice
        var env = ProcessInfo.processInfo.environment
        if fm.isExecutableFile(atPath: "/Library/Developer/CommandLineTools/usr/bin/git") {
            process.executableURL = URL(fileURLWithPath: "/Library/Developer/CommandLineTools/usr/bin/git")
            env["DEVELOPER_DIR"] = "/Library/Developer/CommandLineTools"
        }
        env["GIT_TERMINAL_PROMPT"] = "0"
        env["GIT_SSH_COMMAND"] = "/usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=2"
        process.environment = env
        let finished = DispatchSemaphore(value: 0); process.terminationHandler = { _ in finished.signal() }
        try process.run()
        if finished.wait(timeout: .now() + 90) == .timedOut {
            process.terminate(); throw biweeklyError("Git 操作超时，将在下次自动重试。")
        }
        let output = (try? String(contentsOf: log, encoding: .utf8)) ?? ""
        if process.terminationStatus != 0 && !allowFailure { throw biweeklyError("Git 备份失败：" + String(output.suffix(1000)).trimmingCharacters(in: .whitespacesAndNewlines)) }
        return CommandResult(code: process.terminationStatus, output: output.trimmingCharacters(in: .newlines))
    }
    func perform(_ config: GitBackupConfiguration) throws -> String {
        let repo = try Self.repository(config.remote)
        guard config.deviceID.range(of: #"^[a-zA-Z0-9_-]{1,80}$"#, options: .regularExpression) != nil else { throw biweeklyError("备份设备标识无效。") }
        if fm.fileExists(atPath: repo.path) {
            let top = try git(["rev-parse", "--show-toplevel"], at: repo).output
            guard URL(fileURLWithPath: top).standardizedFileURL == repo.standardizedFileURL else { throw biweeklyError("规范目录不是独立 Git 仓库，备份已暂停。") }
            let origin = try git(["remote", "get-url", "origin"], at: repo).output
            guard try Self.repository(origin).standardizedFileURL == repo.standardizedFileURL else { throw biweeklyError("规范目录已属于其他仓库，Git 备份已暂停。") }
        } else {
            try fm.createDirectory(at: repo.deletingLastPathComponent(), withIntermediateDirectories: true)
            _ = try git(["clone", "--", config.remote, repo.path])
        }
        let relative = "devices/" + config.deviceID
        let status = try git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], at: repo).output
        for entry in status.split(separator: "\0") {
            guard entry.count >= 3, entry.dropFirst(3).hasPrefix(relative + "/") else { throw biweeklyError("备份仓库有其他未提交改动，请处理后重试；App 不会覆盖这些改动。") }
        }
        let branch = try git(["symbolic-ref", "--short", "HEAD"], at: repo).output
        _ = try git(["fetch", "origin"], at: repo)
        let remoteExists = try git(["rev-parse", "--verify", "refs/remotes/origin/" + branch], at: repo, allowFailure: true).code == 0
        if remoteExists { _ = try git(["merge", "--ff-only", "origin/" + branch], at: repo) }
        let snapshot = try Data(contentsOf: root.appendingPathComponent("data.json"))
        guard let object = try JSONSerialization.jsonObject(with: snapshot) as? [String: Any], object["version"] as? Int == 1 else { throw biweeklyError("任务数据尚未就绪。") }
        let text = String(data: try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]), encoding: .utf8)!
        let destination = repo.appendingPathComponent(relative, isDirectory: true)
        try fm.createDirectory(at: destination.appendingPathComponent("images"), withIntermediateDirectories: true)
        for name in images.names(in: text) {
            let target = destination.appendingPathComponent("images").appendingPathComponent(name)
            if !fm.fileExists(atPath: target.path) { try images.data(name).write(to: target, options: .atomic) }
        }
        try AttachmentStore(root: root).copyReferencedFiles(object, to: destination)
        try (text + "\n").write(to: destination.appendingPathComponent("data.json"), atomically: true, encoding: .utf8)
        let readme = "# Biweekly backup\n\nThis directory contains this device's tasks, fortnight archives and Markdown notes. Images live in `images/`; attached files are copied into `attachments/`.\n\nTo restore in Biweekly, use Preferences → Restore backup and select `data.json`, keeping the sibling `images` and `attachments` folders alongside it. Git history preserves earlier snapshots.\n"
        try readme.write(to: destination.appendingPathComponent("README.md"), atomically: true, encoding: .utf8)
        _ = try git(["add", "--", relative], at: repo)
        let staged = try git(["diff", "--cached", "--quiet", "--", relative], at: repo, allowFailure: true).code
        guard staged == 0 || staged == 1 else { throw biweeklyError("无法检查备份差异。") }
        if staged == 1 {
            _ = try git(["-c", "user.name=Biweekly Backup", "-c", "user.email=biweekly@localhost", "commit", "-m", "Back up Biweekly notes (" + config.deviceID + ")", "--", relative], at: repo)
        }
        let ahead = remoteExists ? (Int(try git(["rev-list", "--count", "origin/" + branch + "..HEAD"], at: repo).output) ?? 0) : 1
        if ahead > 0 {
            let changedPaths = try git(remoteExists ? ["diff", "--name-only", "origin/" + branch + "..HEAD"] : ["ls-tree", "-r", "--name-only", "HEAD"], at: repo).output
            guard changedPaths.split(separator: "\n").allSatisfy({ $0.hasPrefix("devices/") }) else { throw biweeklyError("本地还有其他提交尚未推送，请先处理后再备份。") }
            _ = try git(["push", "-u", "origin", "HEAD:" + branch], at: repo)
        }
        return staged == 1 || ahead > 0 ? "Git 已备份" : "Git 已是最新"
    }
}
