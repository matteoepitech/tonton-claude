import Foundation

/// Follows a transcript as Claude Code appends to it, like agent/src/transcript/tailer.ts: whole lines only, the end of
/// a long file on the first read, and history starts over when the file shrinks.
public final class TranscriptTail {
    /// A long session can weigh hundreds of MB: only its end is read on start.
    static let initialReadBytes: UInt64 = 8 * 1024 * 1024

    public struct Read: Equatable {
        public var lines: [String] = []
        /// The file was truncated or replaced: what was read before no longer counts.
        public var reset = false
    }

    private let url: URL
    private var offset: UInt64 = 0
    private var pending = Data()
    private var started = false

    public init(url: URL) { self.url = url }

    /// The complete lines appended since the last call.
    public func read() -> Read {
        var result = Read()
        let initial = !started
        started = true
        guard let size = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? UInt64 else { return result }

        if size < offset {
            offset = 0
            pending = Data()
            result.reset = true
        }
        var skipPartialLine = false
        if initial && size > Self.initialReadBytes {
            offset = size - Self.initialReadBytes
            skipPartialLine = true
        }
        guard size > offset, let handle = try? FileHandle(forReadingFrom: url) else { return result }
        defer { try? handle.close() }
        guard (try? handle.seek(toOffset: offset)) != nil, let chunk = try? handle.read(upToCount: Int(size - offset)) else {
            return result
        }
        offset += UInt64(chunk.count)

        var data = pending + chunk
        if skipPartialLine, let newline = data.firstIndex(of: 0x0A) { data = data[(newline + 1)...] }
        // Decode only up to the last newline so a multi-byte character is never split.
        guard let end = data.lastIndex(of: 0x0A) else {
            pending = Data(data)
            return result
        }
        pending = Data(data[(end + 1)...])
        result.lines = data[..<end].split(separator: 0x0A).map { String(decoding: $0, as: UTF8.self) }
            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        return result
    }
}
