import Foundation

/// Attachments are written to files for Quick Look under their own name, which comes from a dropped file or from the
/// conversation: never a path, nor a hidden file.
public enum PreviewFile {
    public static func name(_ name: String) -> String {
        let last = name.replacingOccurrences(of: ":", with: "-").split(separator: "/").last.map(String.init) ?? ""
        return last.isEmpty || last.hasPrefix(".") ? "attachment\(last)" : last
    }
}
