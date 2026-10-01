import Foundation

// Refreshes through the earliest retained message, filling gaps after an offline interval.
// Deduplication prevents overlapping pagination/live responses from creating duplicate rows.
enum MessageHistory {
    static func merge(_ existing: [Message], _ incoming: [Message]) -> [Message] {
        var byID = Dictionary(existing.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
        for message in incoming { byID[message.id] = message }
        return byID.values.sorted { $0.id < $1.id }
    }
    @MainActor static func refresh(api: APIClient, path: String, current: [Message]) async throws -> MessagePage {
        var result: [Message] = []
        var before: Int?
        var more = false
        repeat {
            let query = before.map { [URLQueryItem(name: "before", value: String($0))] } ?? []
            let page: MessagePage = try await api.get(path, query: query)
            result = merge(result, page.messages)
            more = page.has_more
            guard let first = page.messages.first?.id else { break }
            if let before, first >= before { throw APIError(message: "Unable to load earlier messages. Try again.") }
            before = first
            if current.isEmpty || first <= (current.first?.id ?? first) { break }
        } while more && !Task.isCancelled
        try Task.checkCancellation()
        return MessagePage(messages: merge(current, result), has_more: more)
    }
}

enum AttachmentCache {
    static var directory: URL { FileManager.default.temporaryDirectory.appendingPathComponent("NovaConnectAttachments", isDirectory: true) }
    static func write(_ data: Data, filename: String) throws -> URL {
        let folder = directory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let name = URL(fileURLWithPath: filename).lastPathComponent
        let file = folder.appendingPathComponent(name.isEmpty || name == "." || name == ".." ? "attachment" : name)
        try data.write(to: file, options: .completeFileProtection)
        return file
    }
    static func remove(_ file: URL?) {
        guard let file, file.path.hasPrefix(directory.path + "/") else { return }
        try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
    }
    static func clear() { try? FileManager.default.removeItem(at: directory) }
}
