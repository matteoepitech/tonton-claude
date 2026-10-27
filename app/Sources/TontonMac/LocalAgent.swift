import Foundation
import TontonCore

/// The agent installed on this Mac, if any: its sessions are the ones whose files, terminal and folders are right here.
public enum LocalAgent {
    /// The agent's config, written by `tonton install` (agent/src/config.ts).
    public static var configURL: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".tonton/config.json")
    }

    /// The machine id this Mac joined `accountId` with, or nil when its agent is not set up or belongs to another account.
    public static func machineId(for accountId: String) -> String? {
        (try? Data(contentsOf: configURL)).flatMap { machineId(from: $0, for: accountId) }
    }

    /// Only the id and the account are read: the rest of the file holds the machine's credentials.
    static func machineId(from config: Data, for accountId: String) -> String? {
        struct Config: Decodable {
            let machineId: String
            /// Missing in configs written before account tokens.
            let account: String?
        }
        guard let config = try? JSONDecoder().decode(Config.self, from: config), !config.machineId.isEmpty else { return nil }
        if let account = config.account, account != accountId { return nil }
        return config.machineId
    }
}
