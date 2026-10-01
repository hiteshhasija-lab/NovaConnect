import Foundation

struct Person: Codable, Identifiable, Hashable {
    let id: Int
    var username: String
    var full_name: String
    var status: String?
    var role: String?
    var email: String?
    var title: String?
    var initials: String { full_name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined() }
}
struct SessionResponse: Decodable { let user: Person }
struct Conversation: Decodable, Identifiable {
    let id: Int
    let name: String?
    let participants: [Person]
    let last_message: PreviewMessage?
    let is_hidden: Int?
    let is_unread: Int?
    let is_favorite: Int?
    let is_group: Int?
    var displayName: String { name ?? participants.map(\.full_name).joined(separator: ", ") }
}
struct PreviewMessage: Decodable { let body: String?; let created_at: String?; let deleted: Int? }
struct Reaction: Decodable, Identifiable { var id: String { emoji }; let emoji: String; let count: Int; let mine: Bool }
struct Attachment: Decodable, Identifiable { let id: Int; let original_name: String; let mime_type: String?; let size: Int? }
struct Message: Decodable, Identifiable {
    let id: Int
    let body: String
    let author: Person
    let created_at: String
    let edited: Bool
    let deleted: Bool
    let reactions: [Reaction]
    let attachments: [Attachment]
}
struct MessagePage: Decodable { let messages: [Message]; let has_more: Bool }
struct Team: Decodable, Identifiable { let id: Int; let name: String; let description: String?; let is_member: Bool? }
struct Channel: Decodable, Identifiable { let id: Int; let name: String; let description: String? }
struct TeamDetail: Decodable { let channels: [Channel] }
struct IDResponse: Decodable { let id: Int }
struct OKResponse: Decodable { let ok: Bool? }
struct Meeting: Decodable, Identifiable { let id: Int; let title: String; let start_at: String; let end_at: String }
struct Activity: Decodable, Identifiable { let id: Int; let body: String; let actor_name: String?; let is_read: Int? }
struct Activities: Decodable { let notifications: [Activity] }
struct AIMessage: Decodable, Identifiable { let id: Int; let role: String; let body: String }
struct AIMessages: Decodable { let messages: [AIMessage] }

enum Timeline {
    static func date(_ value: String) -> Date? {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(secondsFromGMT: 0)
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return f.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
    static func label(_ value: String) -> String {
        guard let date = date(value) else { return value }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}

struct QuotedBody: Equatable {
    let quote: String?
    let body: String
    init(_ raw: String) {
        var lines = raw.components(separatedBy: "\n")
        var quoted: [String] = []
        while let first = lines.first, first.hasPrefix("> ") {
            quoted.append(String(first.dropFirst(2))); lines.removeFirst()
        }
        quote = quoted.isEmpty ? nil : quoted.joined(separator: "\n")
        body = quoted.isEmpty ? raw : lines.joined(separator: "\n").trimmingCharacters(in: .newlines)
    }
}

struct LiveEvent {
    let name: String
    let payload: [String: Any]
    static func parse(_ frame: String) -> LiveEvent? {
        guard frame.hasPrefix("42"), let array = (try? JSONSerialization.jsonObject(with: Data(frame.dropFirst(2).utf8))) as? [Any],
              let name = array.first as? String else { return nil }
        return LiveEvent(name: name, payload: array.count > 1 ? (array[1] as? [String: Any] ?? [:]) : [:])
    }
}
