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
        let bundled = (Bundle.main.object(forInfoDictionaryKey: "NovaConnectDefaultServerURL") as? String).flatMap(Self.parse)
        if let saved = UserDefaults.standard.string(forKey: Self.storageKey), let url = Self.parse(saved) {
            let upgraded = Self.upgradedToHttps(url, bundled: bundled)
            serverURL = upgraded
            // didSet doesn't run during init, so save the upgrade here.
            if upgraded != url { UserDefaults.standard.set(upgraded.absoluteString, forKey: Self.storageKey) }
        } else {
            serverURL = bundled
        }
    }

    /// A saved http:// address for the same server as an https:// built-in default is moved to
    /// https: iOS only allows the camera and microphone on secure pages, so calls need it.
    /// (Same rule as the desktop app's upgradeSavedServerToHttps.)
    private static func upgradedToHttps(_ url: URL, bundled: URL?) -> URL {
        guard let bundled, bundled.scheme?.lowercased() == "https", url.scheme?.lowercased() == "http",
              url.host?.lowercased() == bundled.host?.lowercased(),
              var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return url }
        parts.scheme = "https"
        parts.port = bundled.port
        return parts.url ?? url
    }

    /// Accepts only full http(s) addresses with a host, e.g. "https://10.0.0.102".
    static func parse(_ raw: String) -> URL? {
        guard let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
              url.host?.isEmpty == false
        else { return nil }
        return url
    }
}
