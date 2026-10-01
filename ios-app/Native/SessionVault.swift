import Foundation
import Security

// Session cookies only, never passwords. Entries are scoped to the full server origin.
enum SessionVault {
    private static func query(_ server: URL) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.novaconnect.native.session",
         kSecAttrAccount as String: server.absoluteString]
    }
    static func save(_ server: URL) throws {
        let properties = (HTTPCookieStorage.shared.cookies(for: server) ?? []).compactMap { cookie -> [String: Any]? in
            guard let properties = cookie.properties else { return nil }
            return Dictionary(uniqueKeysWithValues: properties.map { ($0.key.rawValue, $0.value) })
        }
        let data = try PropertyListSerialization.data(fromPropertyList: properties, format: .binary, options: 0)
        let base = query(server)
        let status = SecItemUpdate(base as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var entry = base
            entry[kSecValueData as String] = data
            entry[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(entry as CFDictionary, nil) == errSecSuccess else { throw APIError(message: "Unable to securely save your session.") }
        } else if status != errSecSuccess { throw APIError(message: "Unable to securely save your session.") }
    }
    static func restore(_ server: URL) {
        var q = query(server)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess, let data = result as? Data,
              let rows = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [[String: Any]] else { return }
        for row in rows {
            let props = Dictionary(uniqueKeysWithValues: row.map { (HTTPCookiePropertyKey($0.key), $0.value) })
            if let cookie = HTTPCookie(properties: props), cookie.expiresDate.map({ $0 > Date() }) ?? true {
                HTTPCookieStorage.shared.setCookie(cookie)
            }
        }
    }
    static func delete(_ server: URL) { SecItemDelete(query(server) as CFDictionary) }
}
