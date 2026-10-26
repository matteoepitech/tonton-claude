import Foundation

/// How much one message can carry through the relay. A sealed prompt is capped at 8 MB (`MAX_BLOB_BYTES` in
/// relay/src/limits.ts) and files are base64-encoded twice on the way, in the JSON and then the sealed blob: about 4 MB
/// of files in all.
public enum AttachmentBudget {
    public static let maxTotalBytes = 4_000_000

    public static func fits(_ sizes: [Int]) -> Bool { sizes.reduce(0, +) <= maxTotalBytes }

    /// e.g. "1.2 MB".
    public static func describe(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }

    /// Why a file cannot join the message, or nil when it can.
    public static func problem(adding name: String, bytes: Int, to sizes: [Int]) -> String? {
        if bytes > maxTotalBytes {
            return "\(name) is \(describe(bytes)): a message carries up to \(describe(maxTotalBytes))."
        }
        if !fits(sizes + [bytes]) {
            return "\(name) does not fit: this message already carries \(describe(sizes.reduce(0, +))) of \(describe(maxTotalBytes))."
        }
        return nil
    }
}
