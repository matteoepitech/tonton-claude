import Foundation

/// What the user reads when a file they asked to save could not be written: which file, and why.
public enum SaveFailure {
    public static func message(_ url: URL, _ error: Error) -> String {
        "Could not save \(url.lastPathComponent): \(error.localizedDescription)"
    }

    /// Writes `data`, and returns the message to show when it fails.
    public static func write(_ data: Data, to url: URL) -> String? {
        do {
            try data.write(to: url, options: .atomic)
            return nil
        } catch {
            return message(url, error)
        }
    }
}
