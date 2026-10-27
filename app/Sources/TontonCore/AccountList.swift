import Foundation

/// The accounts signed in on this Mac, to switch between a work and a personal one. One is connected at a time; the
/// others wait here with their keys.
public struct AccountList: Equatable, Sendable {
    public struct Entry: Codable, Equatable, Sendable, Identifiable {
        public var account: Account
        public var name: String

        public init(account: Account, name: String) {
            self.account = account
            self.name = name
        }

        public var id: String { AccountList.id(of: account) }
    }

    public private(set) var entries: [Entry]

    /// By name, as Settings lists them.
    public var sorted: [Entry] { entries.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending } }

    public init(_ entries: [Entry] = []) {
        // One entry per account, whatever the files on disk say.
        var seen = Set<String>()
        self.entries = entries.filter { seen.insert($0.id).inserted }
    }

    /// The same account on the same relay, whatever its keys: they change when the account token is regenerated.
    public static func id(of account: Account) -> String { "\(account.relay)|\(account.accountId)" }

    /// `tonton.d3l.tech · 3f9a`: the relay and the start of the account id, until the user names it.
    public static func defaultName(for account: Account) -> String {
        let relay = URL(string: account.relay)?.host ?? account.relay
        return "\(relay) · \(account.accountId.prefix(4))"
    }

    public func entry(for account: Account) -> Entry? {
        entries.first { $0.id == Self.id(of: account) }
    }

    /// Adds an account, or keeps its new keys when it is already there (a regenerated token), with its name.
    public mutating func save(_ account: Account) {
        if let index = entries.firstIndex(where: { $0.id == Self.id(of: account) }) {
            entries[index].account = account
        } else {
            entries.append(Entry(account: account, name: Self.defaultName(for: account)))
        }
    }

    public mutating func remove(_ account: Account) {
        entries.removeAll { $0.id == Self.id(of: account) }
    }

    /// An empty name goes back to the default one.
    public mutating func rename(_ account: Account, to name: String) {
        guard let index = entries.firstIndex(where: { $0.id == Self.id(of: account) }) else { return }
        let trimmed = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(40))
        entries[index].name = trimmed.isEmpty ? Self.defaultName(for: account) : trimmed
    }
}
