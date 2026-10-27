import Foundation
import Security
import TontonCore

/// The account, in a Keychain item the app shares with its extensions through the app group: the Live Activity and the
/// notification service extension need the key to open what the relay pushes. It stays on this phone (no iCloud
/// Keychain, no backup) and can be read once the phone was unlocked after a restart, while it is locked again.
enum SharedAccount {
    static let appGroup = "group.tech.d3l.tontonclaude"
    private static let service = "tech.d3l.tontonclaude.account"

    static func load() -> Account? {
        for group in groups {
            var query = query(group)
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            var result: AnyObject?
            if SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data {
                return try? JSONDecoder().decode(Account.self, from: data)
            }
        }
        return nil
    }

    /// Nil signs out. Returns false when the Keychain refused it.
    @discardableResult
    static func save(_ account: Account?) -> Bool {
        for group in groups { SecItemDelete(query(group) as CFDictionary) }
        guard let account, let data = try? JSONEncoder().encode(account) else { return true }
        for group in groups {
            var item = query(group)
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let status = SecItemAdd(item as CFDictionary, nil)
            // Unsigned development builds have no app group: the app keeps working, without what the extensions show.
            if status != errSecMissingEntitlement { return status == errSecSuccess }
        }
        return false
    }

    /// Opens what the relay and the agents seal. Nil when signed out.
    static func vault() -> SessionVault? {
        (try? load()?.symmetricKey()).map { SessionVault(key: $0) }
    }

    /// The shared group first, then the app's own Keychain.
    private static let groups: [String?] = [appGroup, nil]

    private static func query(_ group: String?) -> [String: Any] {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        if let group { query[kSecAttrAccessGroup as String] = group }
        return query
    }
}
