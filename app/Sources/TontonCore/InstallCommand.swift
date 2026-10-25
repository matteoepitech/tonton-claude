import Foundation

/// The commands the app gives to set up or update a machine. The scripts come from the releases on GitHub and the
/// connection code carries the relay, so they work with any relay.
public enum InstallCommand {
    public static let releases = "https://github.com/matteoepitech/tonton-claude/releases/latest/download"

    /// `<code>.<key>@<relay>`: the single-use code for the relay, the account key that never reaches it, and the relay.
    public static func connectionCode(code: String, key: String, relay: String) -> String {
        "\(code).\(key)@\(relay)"
    }

    /// PowerShell. Without a connection code, an enrolled machine updates.
    public static func windows(connectionCode: String? = nil) -> String {
        let script = "irm \(releases)/install.ps1 | iex"
        return connectionCode.map { "$env:TONTON_ENROLL='\($0)'; \(script)" } ?? script
    }

    /// macOS and Linux. Without a connection code, an enrolled machine updates.
    public static func unix(connectionCode: String? = nil) -> String {
        let script = "curl -fsSL \(releases)/install.sh"
        return connectionCode.map { "\(script) | TONTON_ENROLL='\($0)' sh" } ?? "\(script) | sh"
    }
}
