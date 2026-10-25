import Foundation

/// The commands the app gives to set up or update a machine. The scripts come from the releases on GitHub; the account
/// token tells the agent which relay and account to join.
public enum InstallCommand {
    public static let releases = "https://github.com/matteoepitech/tonton-claude/releases/latest/download"

    /// PowerShell. Without a token, a connected machine updates.
    public static func windows(token: String? = nil) -> String {
        let script = "irm \(releases)/install.ps1 | iex"
        return token.map { "$env:TONTON_TOKEN='\($0)'; \(script)" } ?? script
    }

    /// macOS and Linux. Without a token, a connected machine updates.
    public static func unix(token: String? = nil) -> String {
        let script = "curl -fsSL \(releases)/install.sh"
        return token.map { "\(script) | TONTON_TOKEN='\($0)' sh" } ?? "\(script) | sh"
    }
}
