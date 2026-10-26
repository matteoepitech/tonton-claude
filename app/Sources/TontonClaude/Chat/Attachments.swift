import AppKit
import TontonCore
import UniformTypeIdentifiers

struct Attachment: Identifiable {
    let id = UUID()
    let name: String
    let mediaType: String
    let data: Data
    /// The image itself, or the file's icon.
    let thumbnail: NSImage
    let isImage: Bool

    var outgoing: OutgoingImage {
        OutgoingImage(name: name, mediaType: mediaType, data: data.base64EncodedString())
    }
}

/// Turns files, the clipboard and drops into attachments small enough to send through the relay. Images keep their
/// preview and are recompressed when large; any other file goes as it is, within `AttachmentBudget`.
enum AttachmentReader {
    /// An attachment, or why a file could not be one.
    enum Loaded {
        case attachment(Attachment)
        case refused(String)
    }

    private static let maxImageBytes = 3_000_000

    static func attachment(from data: Data, name: String) -> Attachment? {
        guard let image = NSImage(data: data) else { return nil }
        if data.count > maxImageBytes, let jpeg = jpegData(image) {
            let jpegName = (name as NSString).deletingPathExtension + ".jpg"
            return Attachment(name: jpegName, mediaType: "image/jpeg", data: jpeg, thumbnail: image, isImage: true)
        }
        let mediaType = UTType(filenameExtension: (name as NSString).pathExtension)?.preferredMIMEType ?? "image/png"
        return Attachment(name: name, mediaType: mediaType, data: data, thumbnail: image, isImage: true)
    }

    @MainActor
    static func pickFiles() -> [Loaded] {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.item]
        panel.allowsMultipleSelection = true
        guard panel.runAboveNotch() == .OK else { return [] }
        return panel.urls.map(fromFile)
    }

    static func fromClipboard() -> [Loaded] {
        let pasteboard = NSPasteboard.general
        if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            return urls.map(fromFile)
        }
        guard let image = NSImage(pasteboard: pasteboard), let png = pngData(image),
            let attachment = attachment(from: png, name: "capture.png")
        else { return [] }
        return [.attachment(attachment)]
    }

    /// Loads dropped files and images, then hands them over on the main thread.
    static func fromDrop(_ providers: [NSItemProvider], deliver: @escaping @MainActor (Loaded) -> Void) {
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    guard let url else { return }
                    let loaded = fromFile(url)
                    Task { @MainActor in deliver(loaded) }
                }
            } else if provider.canLoadObject(ofClass: NSImage.self) {
                _ = provider.loadObject(ofClass: NSImage.self) { object, _ in
                    guard let image = object as? NSImage, let png = pngData(image),
                        let attachment = attachment(from: png, name: "image.png")
                    else { return }
                    Task { @MainActor in deliver(.attachment(attachment)) }
                }
            }
        }
    }

    /// The size is checked before reading, so a large video is never loaded into memory.
    private static func fromFile(_ url: URL) -> Loaded {
        let name = url.lastPathComponent
        let values = try? url.resourceValues(forKeys: [.fileSizeKey, .isDirectoryKey])
        if values?.isDirectory == true { return .refused("\(name) is a folder: drop the files inside it.") }
        let size = values?.fileSize ?? 0
        if let problem = AttachmentBudget.problem(adding: name, bytes: size, to: []) { return .refused(problem) }
        guard let data = try? Data(contentsOf: url) else { return .refused("\(name) could not be read.") }
        if let image = attachment(from: data, name: name) { return .attachment(image) }
        let type = UTType(filenameExtension: url.pathExtension)
        return .attachment(
            Attachment(
                name: name, mediaType: type?.preferredMIMEType ?? "application/octet-stream", data: data,
                thumbnail: NSWorkspace.shared.icon(for: type ?? .data), isImage: false))
    }

    private static func pngData(_ image: NSImage) -> Data? {
        image.tiffRepresentation.flatMap(NSBitmapImageRep.init(data:))?.representation(using: .png, properties: [:])
    }

    private static func jpegData(_ image: NSImage) -> Data? {
        image.tiffRepresentation.flatMap(NSBitmapImageRep.init(data:))?.representation(using: .jpeg, properties: [.compressionFactor: 0.8])
    }
}
