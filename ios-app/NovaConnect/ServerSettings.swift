import Foundation

/// The NovaConnect server the app points at. A user-chosen address is saved; otherwise the
/// build-time default from Info.plist is used (deliberately not saved, so a newer build's
/// default still takes effect for users who never changed it).
final class ServerSettings: ObservableObject {
    private static let storageKey = "serverURL"

    @Published var serverURL: URL? {
        didSet { UserDefaults.standard.set(serverURL?.absoluteString, forKey: Self.storageKey) }
    }

    init() {
        if let saved = UserDefaults.standard.string(forKey: Self.storageKey), let url = Self.parse(saved) {
            serverURL = url
        } else if let bundled = Bundle.main.object(forInfoDictionaryKey: "NovaConnectDefaultServerURL") as? String {
            serverURL = Self.parse(bundled)
        } else {
            serverURL = nil
        }
    }

    /// Accepts only full http(s) addresses with a host, e.g. "http://10.0.0.102".
    static func parse(_ raw: String) -> URL? {
        guard let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
              url.host?.isEmpty == false
        else { return nil }
        return url
    }
}
